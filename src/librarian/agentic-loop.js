/**
 * DeepLore — Agentic Loop
 * State machine: SEARCH → FLAG → DONE. DLE-owned generation loop, replaces
 * ST ToolManager-based tool calling for Librarian.
 */
import {
    callWithTools, parseToolCalls, getTextContent, getUsage,
    buildAssistantMessage, buildToolResults,
} from './agentic-api.js';
// Namespace import for `getProviderFormat`: accessed off the namespace object
// (not a named binding) so the test stub for `agentic-api.js` — which replaces
// the module and does NOT export getProviderFormat — doesn't fail module
// instantiation. `_resolveProviderFormat` reads it defensively at runtime.
import * as agenticApi from './agentic-api.js';
import { searchLoreAction, flagLoreAction } from './librarian-tools.js';
import {
    chatEpoch, generationLockEpoch,
    setGenerationLockTimestamp,
} from '../state.js';
import { pushEvent } from '../diagnostics/interceptors.js';

/**
 * Resolve the Librarian provider format once per loop, tolerating the
 * test stub for `agentic-api.js` (which replaces the module and may not export
 * `getProviderFormat`). Returns `undefined` in that case — the message builders
 * then fall back to their own default-param resolution (a no-op in the stub,
 * where the builders are replaced wholesale and ignore the format argument).
 *
 * P1-6: `connConfig` (the resolved Librarian connection) is forwarded so the
 * format is derived from the profile ACTUALLY used this round-trip, not ST's
 * globally-active connection. Without it `getProviderFormat()` would re-resolve
 * the Librarian config (harmless but redundant); passing it freezes the format
 * to the same profile the call dispatches on. Both access via the namespace
 * (not named bindings) so the stub — which omits these exports — still links.
 */
function _resolveProviderFormat(connConfig) {
    const fn = agenticApi.getProviderFormat;
    return typeof fn === 'function' ? fn(connConfig) : undefined;
}

/**
 * Resolve the Librarian connection config once per loop, tolerating the test
 * stub (which omits this export). Returns `undefined` under the stub — callers
 * then pass `undefined` to `getProviderFormat`, which the stub ignores anyway.
 */
function _resolveLibrarianConnConfig() {
    const fn = agenticApi.resolveLibrarianConnConfig;
    return typeof fn === 'function' ? fn() : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// Tool Definitions (OpenAI function calling format)
// ════════════════════════════════════════════════════════════════════════════

const TOOL_SEARCH = {
    type: 'function',
    function: {
        name: 'search',
        description: 'Search the lore vault for entries not already in your context. Use when the conversation references characters, places, or concepts not covered by pre-selected lore.',
        parameters: {
            type: 'object',
            properties: {
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Topics, names, or concepts to search for (up to 4)',
                },
            },
            required: ['queries'],
        },
    },
};

const TOOL_WRITE = {
    type: 'function',
    function: {
        name: 'write',
        description: 'Submit your final prose/story response. The content argument IS your story text. Put ALL prose here, not in your text response.',
        parameters: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'Your complete prose/story response',
                },
            },
            required: ['content'],
        },
    },
};

const TOOL_FLAG = {
    type: 'function',
    function: {
        name: 'flag',
        description: 'Flag a lore gap or entry needing updates. Only flag genuine gaps where you had to invent or guess details that should exist in the vault.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Topic or concept name' },
                reason: { type: 'string', description: 'Why this gap matters' },
                urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
                flag_type: { type: 'string', enum: ['gap', 'update'] },
                entry_title: { type: 'string', description: 'Existing entry title (for update type)' },
            },
            required: ['title', 'reason'],
        },
    },
};

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const MAX_ITERATIONS = 15;
const MAX_FLAG_CALLS = 5;
const PHASE_SEARCH = 'SEARCH';
const PHASE_FLAG = 'FLAG';

// ════════════════════════════════════════════════════════════════════════════
// Main Loop
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} options
 * @param {Array} options.messages - From buildChatMessages()
 * @param {number} options.maxSearches
 * @param {boolean} options.searchEnabled
 * @param {boolean} options.flagEnabled
 * @param {number} options.maxTokens
 * @param {AbortSignal} options.signal
 * @param {number} options.epoch - chatEpoch snapshot
 * @param {number} options.lockEpoch - generationLockEpoch snapshot
 * @param {function} options.onStatus - Called with a structured `{ phase, progress }`
 *   object (phase = canonical PIPELINE_PHASE key; progress = `{ current, total }` or
 *   null). The consumer sets the phase deterministically and composes the localized
 *   label — it must NOT string-match display text (gotcha #74). See f025.
 * @param {function} options.onProse - Called when write() fires; awaited so saveReply
 *   completes before the loop returns. The FLAG turn is now backgrounded (see the
 *   `pendingFlag` thunk in the return value) — onProse no longer gates a synchronous
 *   flag round-trip, so prose delivery + lock release don't wait on gap-flagging.
 * @param {Set<string>} options.injectedTitles - lowercased
 * @param {object} options.settings
 */
export async function runAgenticLoop(options) {
    const {
        messages, maxSearches, searchEnabled, flagEnabled,
        maxTokens, signal, epoch, lockEpoch,
        onStatus, onProse, settings,
    } = options;

    pushEvent('librarian', { action: 'start', maxSearches: maxSearches });

    let phase = PHASE_SEARCH;
    let searchCount = 0;
    let flagCount = 0;
    let prose = null;
    let writeDone = false; // H4: double-write guard
    const toolActivity = [];
    const usage = { totalInput: 0, totalOutput: 0 };
    const debug = settings.debugMode;
    let exitReason = 'max_iterations';
    let iterations = 0;

    // Resolve the Librarian connection ONCE for the whole loop, then derive the
    // provider format from THAT profile (P1-6). Threaded into the message
    // builders so each buildAssistantMessage/buildToolResults call doesn't
    // re-resolve (→ resolveConnectionConfig('librarian') → getSettings()) and so
    // the format reflects the Librarian profile actually dispatched on, not ST's
    // globally-active connection. The Librarian connection is fixed for the
    // duration of one generation.
    const connConfig = _resolveLibrarianConnConfig();
    const providerFormat = _resolveProviderFormat(connConfig);

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        iterations = iteration + 1;
        // Bail on chat switch or force-released lock.
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            if (debug) console.debug('[DLE] Agentic loop: epoch mismatch, aborting');
            exitReason = 'epoch_mismatch';
            break;
        }
        if (signal.aborted) {
            exitReason = 'aborted';
            const externalReason = signal.reason?.message || null;
            try {
                pushEvent('librarian', {
                    surface: 'loop', action: 'abort',
                    iteration, phase, searchCount, flagCount,
                    controllerReason: null, externalReason,
                    visibilityState: typeof document !== 'undefined' ? document.visibilityState : null,
                    onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
                });
            } catch { /* never throw from diag */ }
            const err = new Error('Agentic loop aborted');
            err.name = 'AbortError';
            err.abortReason = externalReason;
            throw err;
        }

        const tools = [];
        if (phase === PHASE_SEARCH) {
            tools.push(TOOL_WRITE); // always available in SEARCH
            if (searchEnabled && searchCount < maxSearches) {
                tools.push(TOOL_SEARCH);
            }
        }
        // Issue-1: the FLAG phase no longer runs an in-loop iteration. Once write
        // delivers prose we break and hand the caller a detached `pendingFlag` thunk
        // (built after the loop) so the flag API round-trip runs AFTER lock release.
        // Inline flags (a write+flag in ONE response) are still processed in the
        // per-toolCall switch below — `phase === PHASE_FLAG`, set by the write case,
        // gates them. So phase=PHASE_FLAG is now only an in-response sentinel.

        if (tools.length === 0) { exitReason = 'no_tools'; break; }

        // H1: 'auto' only. 'required'/'any' conflicts with extended thinking on
        // Claude (and possibly Gemini); the system prompt already instructs the
        // model to call write when it's the only tool, so forcing is unnecessary.
        const toolChoice = 'auto';

        // C9: keepalive before API call.
        setGenerationLockTimestamp(Date.now());

        try {
            pushEvent('librarian', {
                surface: 'loop', action: 'iteration',
                iteration, phase, searchCount, flagCount,
                toolsAvailable: tools.map(t => t.function.name),
            });
        } catch { /* never throw from diag */ }

        if (debug) console.debug(`[DLE] Agentic loop: iteration ${iteration}, phase=${phase}, tools=[${tools.map(t => t.function.name)}]`);

        // SEARCH phase — errors fatal here (no prose yet). The FLAG turn is no
        // longer run in-loop (Issue-1 backgrounding): once write delivers prose we
        // break out below and the caller fires the detached `pendingFlag` thunk
        // after releasing the generation lock.
        const response = await callWithTools(messages, tools, toolChoice, maxTokens, signal);

        const responseUsage = getUsage(response);
        usage.totalInput += responseUsage.input_tokens;
        usage.totalOutput += responseUsage.output_tokens;

        const toolCalls = parseToolCalls(response);

        if (toolCalls.length === 0) {
            // AI ended its turn — capture text as fallback prose.
            if (!prose) {
                const text = getTextContent(response);
                if (text?.trim()) prose = text;
            }
            exitReason = 'no_tools';
            break;
        }

        // Provider-native format preserved.
        const assistantMsg = buildAssistantMessage(response, providerFormat);
        messages.push(assistantMsg);

        // C9: keepalive before tool processing.
        setGenerationLockTimestamp(Date.now());

        const results = [];
        for (const tc of toolCalls) {
            switch (tc.name) {
                case 'search': {
                    if (phase !== PHASE_SEARCH || !searchEnabled) {
                        results.push({ id: tc.id, name: tc.name, result: 'Search is not available in this phase.' });
                        break;
                    }
                    if (searchCount >= maxSearches) {
                        results.push({ id: tc.id, name: tc.name, result: `Search limit reached (${maxSearches}). Use write to submit your response.` });
                        break;
                    }
                    searchCount++;
                    // C3 (gotcha #74): never make the consumer infer the phase from display text.
                    // Pass the canonical phase KEY plus the dynamic (n/m) progress as structured
                    // data; index.js sets the phase deterministically and composes the localized
                    // label + progress for the toast. See f025.
                    onStatus?.({ phase: 'searching', progress: { current: searchCount, total: maxSearches } });

                    // CRIT-LIB-2: searchLoreAction returns `{ text, titles }` (see its
                    // doc comment). `titles` is the authoritative matched-entry list;
                    // `text` is the Markdown payload for the LLM. Older code regex-parsed
                    // `### ...` headings out of the text \u2014 vault content has its own
                    // `### Section` subheadings, which inflated counts and polluted the
                    // Activity dropdown with section names that aren't entries. Also kills
                    // MED-LIB-1 (`!== 'Related entries:'` string filter that broke under
                    // localization \u2014 structured return makes it unnecessary).
                    // Reuses BM25, gap tracking, analytics from the legacy action.
                    // Pre-call epoch/lock guard: if the chat switched during the callWithTools
                    // await above, bail BEFORE searchLoreAction so a stale loop never mutates the
                    // (now chat-B) loreGapSearchCount budget, Activity feed, or per-chat stats.
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                        if (debug) console.debug('[DLE] agentic SEARCH: epoch mismatch before searchLoreAction, stop loop');
                        // M-5: push a tool-result before breaking (mirror the :266/:270 siblings).
                        // searchCount++ already fired and the assistant message carries this
                        // tool_call; if we break the switch with no result, buildToolResults
                        // emits no matching tool-result and the next round-trip 400s on an
                        // orphaned tool_call. The loop bails on the same guard at iteration top
                        // anyway, but the result keeps any in-flight message array well-formed.
                        results.push({ id: tc.id, name: tc.name, result: '<aborted>' });
                        break;
                    }
                    const searchResult = await searchLoreAction({ queries: tc.input.queries || [] });
                    // #23: searchLoreAction refunds its own loreGapSearchCount when a
                    // search delivered no value (index not ready / zero hits) and tells
                    // the model the search was free. Mirror that on the loop's searchCount
                    // so the two budgets stay aligned — otherwise the loop keeps counting
                    // the "free" search and withdraws TOOL_SEARCH early, burning paid
                    // iterations on lore-sparse vaults.
                    if (searchResult && searchResult.refunded) {
                        searchCount = Math.max(0, searchCount - 1);
                    }
                    const resultText = typeof searchResult === 'string'
                        ? searchResult
                        : (searchResult?.text ?? '');
                    const titleMatches = Array.isArray(searchResult?.titles)
                        ? searchResult.titles
                        : [];
                    results.push({ id: tc.id, name: tc.name, result: resultText });

                    // Post-await epoch/lock guard (mirror _runFlagIteration at the FLAG path):
                    // if the chat switched or the lock rolled during the search await, stop the
                    // loop and don't leak this stale search into the new chat's Activity dropdown.
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                        if (debug) console.debug('[DLE] agentic SEARCH: epoch mismatch after searchLoreAction, stop loop');
                        break;
                    }

                    // Contract (per CLAUDE.md): only successful-search results create dropdown
                    // records; no-result searches create gap records only (handled by
                    // searchLoreAction). An empty resultTitles dropdown is misleading UI.
                    if (titleMatches.length > 0) {
                        toolActivity.push({
                            type: 'search',
                            query: (tc.input.queries || []).join(', '),
                            resultCount: titleMatches.length,
                            resultTitles: titleMatches,
                            timestamp: Date.now(),
                        });
                    }
                    break;
                }

                case 'write': {
                    // H4: double-write guard.
                    if (writeDone) {
                        results.push({ id: tc.id, name: tc.name, result: 'Error: Response already submitted. Use flag to record any issues, then end your turn.' });
                        break;
                    }
                    // H10: empty-content guard. AI sometimes emits write() with empty
                    // or missing content (truncation, refusal, confusion). Returning
                    // an error gives it a retry slot rather than committing an empty bubble.
                    const writeContent = typeof tc.input?.content === 'string' ? tc.input.content : '';
                    if (!writeContent.trim()) {
                        results.push({
                            id: tc.id,
                            name: tc.name,
                            result: 'Error: The `content` argument was empty or missing. You MUST put your complete prose/story response in the `content` argument. Call write again with your actual response text.',
                        });
                        break;
                    }
                    prose = writeContent;
                    writeDone = true;
                    phase = PHASE_FLAG;

                    // H7: prose shown immediately — flagging is a silent wrap-up.
                    // onProse clears status (calls _removePipelineStatus) and is awaited
                    // so saveReply + saveChatConditional finish before FLAG phase.
                    //
                    // CRIT-LIB-3: wrap in try/catch. Without this, a throw from
                    // `await saveReply` or `await saveChatConditional` inside onProse
                    // propagates all the way to index.js's outer catch — the LLM
                    // produced valid prose, the user paid the tokens, and the message
                    // is silently lost behind a generic "Generation failed" toast.
                    //
                    // On failure: keep `prose` set + `writeDone = true` so we return
                    // it from the loop. The caller in index.js takes one of two paths:
                    //  - if onProse partially succeeded (saveReply ran, proseMsg was
                    //    captured, only saveChatConditional threw) → index.js's
                    //    `if (proseMsg)` branch runs and re-tries saveChatConditional
                    //    (its post-await epoch guard from F6 still applies).
                    //  - if onProse fully failed (saveReply threw, proseMsg still
                    //    null) → index.js's `else if (result.prose)` fallback branch
                    //    runs (F3-hardened) and does the full saveReply pipeline.
                    // Either way the prose is preserved instead of silently lost.
                    //
                    // Also short-circuits FLAG: a broken persistence path means the
                    // chat is already in a degraded state, no point asking the model
                    // for flag tool calls that will also try to persist.
                    if (onProse) {
                        try {
                            await onProse(prose);
                        } catch (onProseErr) {
                            console.warn('[DLE] onProse threw — preserving prose for caller-side fallback:', onProseErr?.message || onProseErr);
                            try {
                                pushEvent('librarian', {
                                    surface: 'loop', action: 'onProse_error',
                                    iteration, phase,
                                    error: (onProseErr?.message || String(onProseErr)).slice(0, 200),
                                    proseLen: (prose || '').length,
                                });
                            } catch { /* never throw from diag */ }
                            exitReason = 'onProse_error';
                            // Bail out of the per-iteration tool processing + the main
                            // loop. `prose` and `writeDone` already set above, so the
                            // outer `return { prose, ... }` carries the LLM's output
                            // back to index.js for the fallback save path.
                            return { prose: prose || '', toolActivity, usage };
                        }
                    }

                    const flagInstructions = buildFlaggingInstructions(settings);
                    results.push({ id: tc.id, name: tc.name, result: flagInstructions });
                    break;
                }

                case 'flag': {
                    // AI may emit write+flag in one response — phase is already FLAG
                    // (set by the write case above), so handle inline.
                    if (phase !== PHASE_FLAG || !flagEnabled) {
                        results.push({ id: tc.id, name: tc.name, result: 'Flag is not available yet. Call write first.' });
                        break;
                    }
                    // Cap enforced per call. Without this, a write+flag×N response could
                    // commit more than MAX_FLAG_CALLS flags in a single iteration since
                    // the per-iteration tools-array gate only fires at iteration boundary.
                    if (flagCount >= MAX_FLAG_CALLS) {
                        results.push({ id: tc.id, name: tc.name, result: `Flag limit reached (${MAX_FLAG_CALLS}). End your turn.` });
                        break;
                    }
                    flagCount++;
                    // Thread the loop's captured epoch so flagLoreAction's internal
                    // guard skips activity/analytics if the chat switched mid-loop.
                    const flagResult = await flagLoreAction(tc.input || {}, epoch);
                    results.push({ id: tc.id, name: tc.name, result: flagResult || 'Flag recorded.' });
                    // Symmetric post-await epoch/lock guard (mirrors _runFlagIteration
                    // and the SEARCH path): if the chat switched or the lock rolled
                    // during the flag await, don't leak this stale flag into the new
                    // chat's drawer-dropdown toolActivity.
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                        if (debug) console.debug('[DLE] agentic inline-flag: epoch mismatch after flagLoreAction, skip toolActivity push');
                        break;
                    }
                    toolActivity.push({
                        type: 'flag',
                        query: tc.input?.title || '',
                        subtype: tc.input?.flag_type || 'gap',
                        urgency: tc.input?.urgency || 'medium',
                        timestamp: Date.now(),
                    });
                    break;
                }

                default:
                    results.push({ id: tc.id, name: tc.name, result: `Unknown tool: ${tc.name}` });
            }
        }

        // C4: batch all tool results into one message (or array for OpenAI).
        const toolResultMsg = buildToolResults(results, providerFormat);
        if (Array.isArray(toolResultMsg)) {
            messages.push(...toolResultMsg);
        } else {
            messages.push(toolResultMsg);
        }

        // Issue-1: prose delivered this iteration → stop the synchronous loop.
        // `messages` now carries the assistant write (+ any inline flag) call and
        // its tool-result (the flagging instructions), i.e. exactly the state
        // _runFlagIteration needs. The detached `pendingFlag` thunk (built after
        // the loop) resumes from here AFTER the caller releases the generation lock.
        if (writeDone) {
            exitReason = 'completed';
            break;
        }
    }

    // prose='' is legitimate (every write rejected by H10 empty-content guard).
    // Distinct from "write was never called" — both fall through here, log the state.
    if (!prose) {
        if (debug) console.debug('[DLE] Agentic loop: exited without prose (writeDone=%s, iterations=%d, exit=%s)', writeDone, iterations, exitReason);
    }

    // Issue-1: build the detached FLAG turn. Only when prose was delivered AND
    // flagging is on AND the per-loop flag cap isn't already spent by inline
    // flags (write+flag in one response). The caller fires this AFTER releasing
    // the generation lock, so it self-guards on chatEpoch + lockEpoch (threaded
    // into _runFlagIteration): lockEpoch SURVIVES a plain lock release (state.js
    // bumps the epoch only on ACQUIRE) but flips when a NEW generation supersedes
    // this one — auto-cancelling the now-stale background flag. `flagActivity` is
    // a FRESH array so the caller appends ONLY the new flag entries to the prose
    // message's already-saved tool_calls (search + inline flags).
    let pendingFlag = null;
    if (writeDone && flagEnabled && flagCount < MAX_FLAG_CALLS) {
        const capturedFlagCount = flagCount;
        pendingFlag = async () => {
            const flagActivity = [];
            let flagged = 0;
            try {
                flagged = await _runFlagIteration(
                    messages, [TOOL_FLAG], 'auto', maxTokens, signal,
                    flagActivity, settings, debug, capturedFlagCount, epoch, lockEpoch,
                );
            } catch (flagErr) {
                // Best-effort: prose already delivered, so a backgrounded flag
                // failure is invisible. Swallow everything incl. AbortError.
                if (flagErr?.name !== 'AbortError') {
                    console.warn('[DLE] Background flag turn error (prose already delivered):', flagErr?.message || flagErr);
                }
            }
            return { flagCount: flagged, flagActivity };
        };
    }

    if (debug) console.log('[DLE] Librarian: %d iterations, %d searches, %d flags, prose=%d chars, exit=%s, bgFlag=%s',
        iterations, searchCount, flagCount, (prose || '').length, exitReason, !!pendingFlag);

    pushEvent('librarian', { action: 'completed', iterations, searches: searchCount, flags: flagCount, hadProse: !!prose, backgroundFlag: !!pendingFlag });

    return { prose: prose || '', toolActivity, usage, pendingFlag };
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Single FLAG-phase iteration. Best-effort — caller catches errors.
 * Handles multiple flag calls from one response, but does not loop.
 * Mutates `messages` and `toolActivity`.
 *
 * Epoch/abort guards mirror the main loop's iteration-top guard (gotcha #21).
 * Without them, `flagLoreAction` would still skip the chat_metadata persist
 * (its own epoch check at L544), but `sessionActivityLog.push` and
 * `incrementStats` fire unconditionally — old-chat flags would pollute the
 * NEW chat's Activity feed and double-count session/chat stats. AbortError
 * is re-thrown so the main loop can surface it.
 */
async function _runFlagIteration(messages, tools, toolChoice, maxTokens, signal, toolActivity, settings, debug, outerFlagCount = 0, epoch, lockEpoch) {
    // Pre-call guard. The main loop checked at iteration top, but we await
    // here before any flag-side mutation — re-check before the API call too.
    if (signal?.aborted) {
        const err = new Error('Agentic loop aborted');
        err.name = 'AbortError';
        throw err;
    }
    if (epoch !== undefined && (epoch !== chatEpoch || lockEpoch !== generationLockEpoch)) {
        if (debug) console.debug('[DLE] _runFlagIteration: epoch mismatch before API call, bail');
        return 0;
    }

    const response = await callWithTools(messages, tools, toolChoice, maxTokens, signal);

    // Post-API guard. callWithTools can take many seconds; CHAT_CHANGED during
    // the wait must NOT lead to flagLoreAction writes against the new chat.
    if (signal?.aborted) {
        const err = new Error('Agentic loop aborted');
        err.name = 'AbortError';
        throw err;
    }
    if (epoch !== undefined && (epoch !== chatEpoch || lockEpoch !== generationLockEpoch)) {
        if (debug) console.debug('[DLE] _runFlagIteration: epoch mismatch after API call, bail');
        return 0;
    }

    const toolCalls = parseToolCalls(response);
    if (toolCalls.length === 0) return 0;

    // Resolve provider format ONCE for this flag iteration's message builders
    // from the Librarian profile (same rationale + P1-6 profile-awareness as
    // runAgenticLoop — avoid per-call resolveConnectionConfig, freeze to the
    // dispatched profile rather than ST's global connection).
    const providerFormat = _resolveProviderFormat(_resolveLibrarianConnConfig());

    const assistantMsg = buildAssistantMessage(response, providerFormat);
    messages.push(assistantMsg);

    const results = [];
    let flagCount = 0;
    for (const tc of toolCalls) {
        // Cap is global across the whole loop, not per-iteration. Inline flags
        // (write+flag×N responses) already incremented outerFlagCount; respect that here.
        if (tc.name !== 'flag' || (flagCount + outerFlagCount) >= MAX_FLAG_CALLS) {
            results.push({ id: tc.id, name: tc.name, result: 'End your turn now.' });
            continue;
        }
        // Re-check before each await — a CHAT_CHANGED between flag calls must
        // stop the remaining flags from polluting the new chat's activity log.
        if (signal?.aborted) {
            const err = new Error('Agentic loop aborted');
            err.name = 'AbortError';
            throw err;
        }
        if (epoch !== undefined && (epoch !== chatEpoch || lockEpoch !== generationLockEpoch)) {
            if (debug) console.debug('[DLE] _runFlagIteration: epoch mismatch mid-loop, bail');
            break;
        }
        flagCount++;
        // Thread the loop's captured epoch into flagLoreAction so its OWN internal
        // guard skips the persist + activity/analytics side-effects when the chat
        // switched mid-loop (mirrors searchLoreAction). It mutates loreGaps,
        // sessionActivityLog + librarianSessionStats + librarianChatStats.
        const flagResult = await flagLoreAction(tc.input || {}, epoch);
        // Post-call guard. flagLoreAction has NO internal await — it runs
        // synchronously (it's `async` only by signature). The epoch-sensitive
        // side-effects now self-guard INSIDE flagLoreAction via the threaded
        // epoch; this remaining guard only prevents the toolActivity (drawer
        // dropdown) push below from leaking a stale flag into the new chat.
        if (epoch !== undefined && (epoch !== chatEpoch || lockEpoch !== generationLockEpoch)) {
            if (debug) console.debug('[DLE] _runFlagIteration: epoch mismatch after flagLoreAction, skip toolActivity push');
            results.push({ id: tc.id, name: tc.name, result: flagResult || 'Flag recorded.' });
            break;
        }
        results.push({ id: tc.id, name: tc.name, result: flagResult || 'Flag recorded.' });
        toolActivity.push({
            type: 'flag',
            query: tc.input?.title || '',
            subtype: tc.input?.flag_type || 'gap',
            urgency: tc.input?.urgency || 'medium',
            timestamp: Date.now(),
        });
    }
    const toolResultMsg = buildToolResults(results, providerFormat);
    if (Array.isArray(toolResultMsg)) {
        messages.push(...toolResultMsg);
    } else {
        messages.push(toolResultMsg);
    }
    if (debug) console.debug(`[DLE] Flag phase: processed ${flagCount} flag(s)`);
    return flagCount;
}

function buildFlaggingInstructions(settings) {
    const flagEnabled = settings.librarianFlagEnabled !== false;

    if (!flagEnabled) {
        return 'Response recorded. Your turn is complete \u2014 end now.';
    }

    return [
        'Response recorded successfully.',
        '',
        'If you noticed any lore gaps or entries that need updating, use the flag tool now.',
        'Flag types:',
        '- **gap**: Missing lore \u2014 you had to invent or guess a detail that should exist in the vault.',
        '- **update**: Existing entry is outdated, incomplete, or contradicts what happened in the story.',
        '',
        'Urgency levels: low (minor), medium (noticeable gap), high (major inconsistency).',
        '',
        'If nothing to flag, end your turn now.',
    ].join('\n');
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Test-only exports
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//
// `_runFlagIteration` is internal to the FLAG-phase state machine. It is exported
// here SOLELY so the regression suite can drive the REAL function (not a copy)
// against the epoch/lock concurrency guard (CRIT-LIB-1, gotcha #21). No behavior
// change \u2014 the binding is identical to the function used by runAgenticLoop above.
// Do not import this in production code.
export { _runFlagIteration as _runFlagIterationForTests };
