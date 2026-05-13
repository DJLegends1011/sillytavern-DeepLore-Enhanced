/**
 * DeepLore Enhanced — entry point.
 * Wires the generation interceptor, ST event listeners, and UI initialization.
 */
// MUST be the first import — installs console/fetch/XHR/error interceptors at module-eval
// time so we capture cold-start bugs in DLE and other extensions.
import './src/diagnostics/boot.js';
import {
    setExtensionPrompt,
    extension_prompts,
    saveSettingsDebounced,
    chat,
    chat_metadata,
    messageFormatting,
    saveMetadata,
    saveChatConditional,
    updateViewMessageIds,
    saveReply,
    setSendButtonState,
    activateSendButtons,
    deactivateSendButtons,
} from '../../../../script.js';
import { renderExtensionTemplateAsync, saveMetadataDebounced } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { promptManager } from '../../../openai.js';
import { formatAndGroup } from './core/matching.js';
import { classifyError } from './core/utils.js';
import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from './src/stages.js';
import { clearPrompts } from './core/pipeline.js';
import { getSettings, PROMPT_TAG_PREFIX, PROMPT_TAG, invalidateSettingsCache, resolveConnectionConfig, DEFAULT_AI_NOTEPAD_PROMPT } from './settings.js';
import {
    vaultIndex, getWriterVisibleEntries, indexEverLoaded, indexing,
    lastInjectionSources, lastInjectionEpoch, lastScribeChatLength, scribeInProgress,
    cooldownTracker, generationCount, injectionHistory, consecutiveInjections,
    chatInjectionCounts, setChatInjectionCounts, trackerKey,
    lastWarningRatio, decayTracker, chatEpoch,
    perSwipeInjectedKeys, setPerSwipeInjectedKeys,
    lastGenerationTrackerSnapshot, setLastGenerationTrackerSnapshot,
    setCooldownTracker, setDecayTracker, setConsecutiveInjections, setInjectionHistory,
    generationLock, generationLockTimestamp, generationLockEpoch, setGenerationLock, setGenerationLockEpoch,
    setLastInjectionSources, setLastInjectionEpoch, setLastScribeChatLength, setLastScribeSummary,
    setGenerationCount, setLastWarningRatio, setChatEpoch, setLastIndexGenerationCount,
    aiSearchCache, resetAiSearchCache, setAutoSuggestMessageCount, autoSuggestMessageCount, setLastPipelineTrace,
    setPreviousSources, lastPipelineTrace,
    notepadExtractInProgress, setNotepadExtractInProgress,
    notifyPipelineComplete, notifyInjectionSourcesReady, notifyGatingChanged,
    notifyChatInjectionCountsUpdated,
    fieldDefinitions,
    folderList,
    setLoreGaps, setLoreGapSearchCount, setLibrarianChatStats,
    setPipelinePhase,
    skipNextPipeline, setSkipNextPipeline,
    suppressNextAgenticLoop, setSuppressNextAgenticLoop,
    buildPromise,
    onDebugModeChanged,
} from './src/state.js';
import { DEFAULT_FIELD_DEFINITIONS } from './src/fields.js';
import { buildIndex, ensureIndexFresh, hydrateFromCache, buildIndexWithReuse } from './src/vault/vault.js';
import { resetAiThrottle, callAI } from './src/ai/ai.js';
import { runPipeline, matchTextForExternal } from './src/pipeline/pipeline.js';
import { setupSyncPolling } from './src/vault/sync.js';
import { runScribe } from './src/ai/scribe.js';
import { pushEvent, consoleBuffer, networkBuffer, errorBuffer, aiCallBuffer, aiPromptBuffer, eventBuffer, abortWith } from './src/diagnostics/interceptors.js';
import { generationBuffer } from './src/diagnostics/flight-recorder.js';
import { runAutoSuggest, showSuggestionPopup } from './src/ai/auto-suggest.js';
import { injectSourcesButton, showSourcesPopup, resetCartographer } from './src/ui/cartographer.js';
import { loadSettingsUI, bindSettingsEvents, teardownSettingsUI } from './src/ui/settings-ui.js';
import { registerSlashCommands } from './src/ui/commands.js';
import { dedupError, dedupWarning } from './src/toast-dedup.js';
import { createDrawerPanel, resetDrawerState, destroyDrawerPanel } from './src/drawer/drawer.js';
import { createMobileShell, destroyMobileShell } from './src/mobile/mobile-shell.js';
import { ds, pushActivity } from './src/drawer/drawer-state.js';
import { extractAiNotes, normalizeLoreGap } from './src/helpers.js';
import { clearSessionActivityLog, persistGaps } from './src/librarian/librarian-tools.js';
import { injectLibrarianDropdown, removeLibrarianDropdown } from './src/librarian/librarian-ui.js';
import { clearSessionState as clearLibrarianSessionState } from './src/librarian/librarian-session.js';
import { runAgenticLoop } from './src/librarian/agentic-loop.js';
import { isToolCallingSupported, getActiveMaxTokens, isReasoningOnlyModel, getResolvedModel } from './src/librarian/agentic-api.js';
import { buildChatMessages } from './src/librarian/agentic-messages.js';

// ============================================================================
// BUG-063: Lifecycle / teardown infrastructure.
// Tracks every eventSource listener registered during init so teardown
// (beforeunload OR re-init if the module is re-evaluated) can remove them.
// Prevents duplicate handlers on reload and leaked closures on unload.
// _dleInitialized re-init guard tears down before re-registering.
// ============================================================================
const _dleListeners = { eventSource: [] };
let _dleInitialized = false;
let _dleBeforeUnloadHandler = null;
// Stage 8 sets true on each analytics record; the modulo-5 save clears it.
// CHAT_CHANGED + beforeunload flush so in-flight batches aren't lost.
let _analyticsPendingSave = false;

// Stepped Thinking coexistence guard. The ST extension `cierru/st-stepped-thinking`
// fires `Generate('normal', { force_chid })` for each thought-chain step. Without
// this gate, DLE re-runs the full pipeline (vault search, AI scoring, Librarian
// dispatch) for every thinking pass — N× cost, vault traffic, cooldown pollution,
// and Librarian eats the thinking output. Stepped Thinking emits literal-string
// events `'GENERATION_MUTEX_CAPTURED'` with payload `{extension_name: 'stepped-thinking'}`
// (verified upstream `interconnection.js`, 2026-04-24) and `'GENERATION_MUTEX_RELEASED'`
// (no payload). 10s safety timeout clears the flag if RELEASED never fires.
let inSteppedThinking = false;
let _steppedThinkingTimeout = null;

// Unsubscriber for the debugMode observer that installs/uninstalls __DLE_DEBUG.
// Captured at init, released by _teardownDleExtension so re-init doesn't double-register.
let _debugNamespaceUnsub = null;

function _registerEs(event, handler, { once = false } = {}) {
    // Feature-detect guard: events that don't exist in this ST version pass undefined here.
    if (!event) { console.debug('[DLE] _registerEs: skipped undefined event type'); return; }
    _dleListeners.eventSource.push({ event, handler, once });
    if (once) eventSource.once(event, handler);
    else eventSource.on(event, handler);
}

let _dleInitCount = 0;

function _teardownDleExtension() {
    try { pushEvent('teardown', { listenerCount: _dleListeners.eventSource.length }); } catch { /* noop */ }
    for (const { event, handler } of _dleListeners.eventSource) {
        try { eventSource.removeListener?.(event, handler); } catch { /* ignore */ }
    }
    _dleListeners.eventSource = [];
    // Clear any pending Stepped-Thinking safety timeout — would otherwise fire after teardown
    // and flip inSteppedThinking on the next module instance (same closure under re-init guard).
    try { clearTimeout(_steppedThinkingTimeout); } catch { /* ignore */ }
    _steppedThinkingTimeout = null;
    inSteppedThinking = false;
    // Settings-ui registers 4 state observers (onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
    // onClaudeAutoEffortChanged); without this, re-init accumulates duplicates.
    try { teardownSettingsUI(); } catch (err) { console.warn('[DLE] teardownSettingsUI failed:', err?.message); }
    if (_debugNamespaceUnsub) {
        try { _debugNamespaceUnsub(); } catch { /* ignore */ }
        _debugNamespaceUnsub = null;
    }
    try { destroyDrawerPanel(); } catch (err) { console.warn('[DLE] destroyDrawerPanel failed:', err?.message); }
    try { destroyMobileShell(); } catch (err) { console.warn('[DLE] destroyMobileShell failed:', err?.message); }
    // BUG-062: namespaced delegated handler on #chat needs explicit detach.
    try { $('#chat').off('.dle-carto'); } catch { /* ignore */ }
    if (_dleBeforeUnloadHandler) {
        try { window.removeEventListener('beforeunload', _dleBeforeUnloadHandler); } catch { /* ignore */ }
        _dleBeforeUnloadHandler = null;
    }
    // Drop __DLE_DEBUG — its frozen getter closures retain vaultIndex + ring buffers
    // across re-init, GC-pinning the old module's state graph (~1-5 MB) for the page lifetime.
    try { delete globalThis.__DLE_DEBUG; } catch { /* non-configurable in rare envs */ }
    _dleInitialized = false;
}

/** Default extraction prompt for AI Notepad extract-mode. */
const DEFAULT_AI_NOTEPAD_EXTRACT_PROMPT = `You are a session note-taker for a roleplay. Given the AI's latest response and (optionally) its previous session notes, extract anything worth remembering for future context.

Extract: character decisions, relationship shifts, emotional states, revealed information, plot developments, world state changes, unresolved threads, promises made, lies told, or anything else a writer would want to track.

If the response contains visible "notes to self", "OOC" commentary, or meta-commentary by the AI, extract the useful content from those too.

If there is nothing noteworthy, respond with exactly: NOTHING_TO_NOTE

Otherwise, respond with concise bullet points only — no preamble, no headers, no explanation. Just the notes.`;

/** Visible note-taking prose patterns stripped from messages in extract mode. */
const VISIBLE_NOTES_PATTERNS = [
    /\[Note to self:[\s\S]*?\]/gi,
    /\[OOC:[\s\S]*?\]/gi,
    /\(OOC:[\s\S]*?\)/gi,
    /\[Author['']?s? note:[\s\S]*?\]/gi,
    /\[Session note:[\s\S]*?\]/gi,
    /\[Meta:[\s\S]*?\]/gi,
];

// BUG-AUDIT-H08: 64KB soft cap on deeplore_ai_notepad — prevents unbounded growth across
// long sessions. Excess is trimmed from the oldest end at the nearest paragraph boundary.
const AI_NOTEPAD_MAX_CHARS = 65536;
function capNotepad(text) {
    if (!text || text.length <= AI_NOTEPAD_MAX_CHARS) return text;
    const trimmed = text.slice(text.length - AI_NOTEPAD_MAX_CHARS);
    const boundary = trimmed.indexOf('\n\n');
    return boundary !== -1 ? trimmed.slice(boundary + 2) : trimmed;
}

// ============================================================================
// Pipeline Status Helpers
// MUST be module-scope — both onGenerate and init-block handlers call them, and
// `_updatePipelineStatus` running from init() scope crashed every generation
// silently because ST swallows interceptor errors. See bugs_ongenerate_scope memory.
// ============================================================================

/**
 * Show pipeline status toast above the input ("DeepLore: Choosing Lore…", etc.).
 * Slides up from behind #form_sheld on first call; subsequent calls swap text in-place.
 */
function _updatePipelineStatus(text) {
    let el = document.getElementById('dle-pipeline-status');
    if (!el) {
        el = document.createElement('div');
        el.id = 'dle-pipeline-status';
        // Prepended into #form_sheld so it sits above the send form (CSS positioned absolute).
        document.getElementById('form_sheld')?.prepend(el);
    }
    el.classList.remove('dle-toast-out');
    el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> DeepLore: ${text}`;
}

function _removePipelineStatus() {
    const el = document.getElementById('dle-pipeline-status');
    if (!el) return;
    el.classList.add('dle-toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback removal — animationend won't fire on a detached element.
    setTimeout(() => el?.remove(), 500);
}

// ============================================================================
// Generation Interceptor
// ============================================================================

/**
 * ST generation interceptor.
 * @param {object[]} chatMessages  Filtered messages (coreChat — NOT the global chat array)
 * @param {number} contextSize
 * @param {function} abort         abort(true) breaks the interceptor chain immediately
 * @param {string} type            generation type ('normal' | 'continue' | 'append' | 'quiet' | ...)
 */
async function onGenerate(chatMessages, contextSize, abort, type) {
    const settings = getSettings();

    if (type === 'quiet' || !settings.enabled) {
        return;
    }

    // Stepped Thinking coexistence: skip pipeline + Librarian dispatch while a
    // stepped-thinking generation pass is in flight. See `inSteppedThinking`
    // declaration for the rationale (would otherwise re-enter pipeline N× per
    // user turn and corrupt thinking output via Librarian).
    if (inSteppedThinking) {
        if (settings.debugMode) console.debug('[DLE] Pipeline skipped — Stepped Thinking active');
        try { generationBuffer.push({ t: Date.now(), skipped: true, reason: 'stepped_thinking' }); } catch { /* noop */ }
        return;
    }

    // /dle-review and similar bypass the full pipeline by setting skipNextPipeline.
    if (skipNextPipeline) {
        setSkipNextPipeline(false);
        if (settings.debugMode) console.debug('[DLE] Pipeline skipped (skipNextPipeline flag)');
        return;
    }

    // Tool-call continuation: ST re-calls Generate() after each tool invocation, pushing a system
    // message with tool_invocations as the LAST item in chatMessages[]. A backwards walk is wrong
    // here — see gotchas.md #21.
    if (chatMessages.length > 0) {
        const lastMsg = chatMessages[chatMessages.length - 1];
        if (lastMsg?.extra?.tool_invocations || lastMsg?.is_system) {
            if (settings.debugMode) console.debug('[DLE] Skipping pipeline for tool-call continuation');
            try { generationBuffer.push({ t: Date.now(), skipped: true, reason: 'tool_call_continuation' }); } catch { /* noop */ }
            return;
        }
    }

    // BUG-058: tool-call message strip happens past the generationLock guard so a
    // contended-pipeline early return doesn't mutate `chat` and leak the change to other interceptors.

    // Concurrent onGenerate guard — warn rather than silently drop lore.
    if (generationLock) {
        const lockAge = Date.now() - generationLockTimestamp;
        if (lockAge > 30_000) {
            // Auto-recover stale locks past 30s.
            console.warn(`[DLE] Previous lore selection took too long (${Math.round(lockAge / 1000)}s) — releasing lock`);
            dedupWarning('Lore from the last message is taking longer than expected — check your AI timeout setting.', 'pipeline_lock_stale', { hint: 'Pipeline lock held past 30s.' });
            // BUG-274: bump lockEpoch so the stuck pipeline (if it ever unsticks) can't win
            // commit order against this new one. Releasing without the bump would let its
            // late writes pass every `lockEpoch === generationLockEpoch` guard.
            try { generationBuffer.push({ t: Date.now(), forceRelease: true, lockAgeMs: lockAge, oldEpoch: generationLockEpoch, newEpoch: generationLockEpoch + 1 }); } catch { /* noop */ }
            setGenerationLockEpoch(generationLockEpoch + 1);
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Generation lock active — another pipeline is still running. Lore skipped for this generation.');
            dedupWarning('Lore from the last message is still loading — reusing what we had.', 'pipeline_lock');
            try { generationBuffer.push({ t: Date.now(), skipped: true, reason: 'lock_contention', lockAgeMs: lockAge }); } catch { /* noop */ }
            return;
        }
    }
    setGenerationLock(true);
    setPipelinePhase('choosing');
    _updatePipelineStatus('Choosing Lore\u2026');

    // Reset librarian per-generation search counter
    setLoreGapSearchCount(0);

    // Per-message activity: clear gap records at generation start so only the latest
    // generation's gaps survive. New gaps are created by searchLoreAction/flagLoreAction.
    if (settings.librarianPerMessageActivity && settings.librarianEnabled) {
        persistGaps([]);
    }

    // Capture chat epoch to detect stale writes if CHAT_CHANGED fires mid-generation
    const epoch = chatEpoch;
    // Capture lock epoch to detect if this pipeline has been superseded by a force-released lock
    const lockEpoch = generationLockEpoch;

    // Generation correlation ID — threads through trace, flight recorder, and log lines
    const genId = Math.random().toString(36).slice(2, 8);

    // Track whether the pipeline ran far enough to need generation tracking
    let pipelineRan = false;
    let injectedEntries = [];

    // BUG-233: Per-generation AbortController so ST's Stop button can cancel the pipeline.
    // Wired to GENERATION_STOPPED + CHAT_CHANGED; torn down in finally to avoid leaks.
    // BUG-AUDIT (Fix 4): route through abortWith so signal.reason carries attribution.
    // Direct .abort() loses post-mortem attribution that aiCallBuffer.abortReason and
    // diagnostic export depend on. Split into two handlers so each fires its own reason.
    const pipelineAbort = new AbortController();
    const onStop = () => abortWith(pipelineAbort, 'pipeline:generation_stopped');
    const onChatChange = () => abortWith(pipelineAbort, 'pipeline:chat_changed');
    try { eventSource.on(event_types.GENERATION_STOPPED, onStop); } catch { console.warn('[DLE] Could not register GENERATION_STOPPED abort handler'); }
    try { eventSource.on(event_types.CHAT_CHANGED, onChatChange); } catch { console.warn('[DLE] Could not register CHAT_CHANGED abort handler'); }

    // Remove pipeline status on first streaming token (one-shot). Torn down in finally.
    const onFirstToken = () => { _removePipelineStatus(); };
    try { eventSource.once(event_types.STREAM_TOKEN_RECEIVED, onFirstToken); } catch { console.warn('[DLE] Could not register STREAM_TOKEN_RECEIVED handler'); }

    try {
        // Two intentional non-clears at pipeline entry:
        // 1) lastInjectionSources is NOT cleared — CHARACTER_MESSAGE_RENDERED handler clears
        //    after consumption, and the epoch tag prevents stale-source consumption.
        // 2) clearPrompts is deferred to commit phase. Clearing here caused silent lore loss
        //    when early returns fired (vault timeout, empty vault, no matches) — old prompts
        //    were destroyed with nothing replacing them.
        // First gen after hydration: nuke dedup log because cached _contentHash values may not
        // match current Obsidian content.
        if (!indexEverLoaded && vaultIndex.length > 0 && chat_metadata?.deeplore_injection_log?.length > 0) {
            if (settings.debugMode) console.debug('[DLE][DIAG] hydration-clear — wiping injection log (indexEverLoaded=false, vaultSize=%d, logLen=%d)', vaultIndex.length, chat_metadata.deeplore_injection_log.length);
            chat_metadata.deeplore_injection_log = [];
        }

        // 60s timeout on ensureIndexFresh — prevents indefinite hangs if Obsidian goes unresponsive mid-fetch.
        const INDEX_TIMEOUT_MS = 60_000;
        const _indexFreshStart = performance.now();
        try {
            let indexTimer;
            await Promise.race([
                ensureIndexFresh().finally(() => clearTimeout(indexTimer)),
                new Promise((_, reject) => { indexTimer = setTimeout(() => reject(new Error('Index refresh timed out')), INDEX_TIMEOUT_MS); }),
            ]);
        } catch (timeoutErr) {
            console.warn(`[DLE] ${timeoutErr.message} — proceeding with stale data`);
            if (vaultIndex.length === 0) {
                dedupWarning('Couldn\'t reach your vault and no cache to fall back on.', 'obsidian_no_cache_fallback', { hint: 'Obsidian connection timed out; check the Local REST API plugin.' });
                return;
            }
        }
        const _indexFreshMs = Math.round(performance.now() - _indexFreshStart);

        if (settings.debugMode) {
            const _diagLog = chat_metadata.deeplore_injection_log;
            const _diagSnap = lastGenerationTrackerSnapshot;
            console.debug('[DLE][DIAG] pipeline-entry', {
                generationCount, vaultSize: vaultIndex.length, indexEverLoaded,
                chatMsgCount: chatMessages.length, buildPending: !!buildPromise,
                epoch, chatEpoch,
                aiCache: {
                    hashEmpty: !aiSearchCache.hash,
                    manifestHashEmpty: !aiSearchCache.manifestHash,
                    resultCount: aiSearchCache.results?.length ?? 0,
                    resultTitles: aiSearchCache.results?.map(r => r.title) ?? [],
                },
                injectionLog: {
                    exists: !!_diagLog,
                    isArray: Array.isArray(_diagLog),
                    length: _diagLog?.length ?? 0,
                    entries: _diagLog?.map(e => ({ gen: e.gen, count: e.entries?.length, titles: e.entries?.map(x => x.title) })) ?? [],
                },
                snapshot: _diagSnap ? {
                    swipeKey: _diagSnap.swipeKey,
                    generationCount: _diagSnap.generationCount,
                    cooldownSize: _diagSnap.cooldown?.size ?? 0,
                    decaySize: _diagSnap.decay?.size ?? 0,
                    consecutiveSize: _diagSnap.consecutive?.size ?? 0,
                    historySize: _diagSnap.injectionHistory?.size ?? 0,
                } : 'NO_SNAPSHOT',
            });
        }

        // BUG-299: CHAT_CHANGED can fire during the (up to 60s) ensureIndexFresh await.
        // Bail before touching the swipe tracker snapshot — otherwise we'd tag a stale snapshot
        // with the new chat's swipe keys or pollute its cooldown/decay/injection maps.
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            console.debug('[DLE] Chat changed during index refresh — discarding pipeline');
            try { generationBuffer.push({ t: Date.now(), discarded: true, reason: 'chat_changed_during_index' }); } catch { /* noop */ }
            return;
        }

        // Snapshot vaultIndex at pipeline start to avoid races with background rebuilds.
        // getWriterVisibleEntries filters out lorebook-guide — those are Librarian-only and
        // must never reach the writing AI through any path.
        const vaultSnapshot = getWriterVisibleEntries();

        if (vaultSnapshot.length === 0) {
            if (!indexEverLoaded) {
                dedupWarning(
                    'No lorebook entries found. Run /dle-health to check your Obsidian connection and vault settings.',
                    'obsidian_empty_vault', { timeOut: 10000 },
                );
            }
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        // From here on, generation tracking must run even when no entries match.
        pipelineRan = true;

        // BUG-291/292: swipe rollback keys on `${msgIdx}|${swipe_id}` (NOT content hash). Content
        // hashing missed alternate-swipe navigation (content change → new hash → treated as fresh
        // gen → drift) and collided with delete+regen. The slot+swipe key is stable across both.
        // BUG-396c: _snapMatch hoisted so strip-dedup later can clear the injection log on swipe.
        let _snapMatch = false;
        {
            const earlyIdx = chatMessages.length - 1;
            const earlySwipeId = earlyIdx >= 0 ? (chatMessages[earlyIdx]?.swipe_id ?? 0) : 0;
            const earlySwipeKey = `${earlyIdx}|${earlySwipeId}`;
            _snapMatch = !!(lastGenerationTrackerSnapshot && lastGenerationTrackerSnapshot.swipeKey === earlySwipeKey);
            if (settings.debugMode) {
                console.debug('[DLE][DIAG] swipe-check', {
                    earlyIdx, earlySwipeId, earlySwipeKey,
                    snapshotSwipeKey: lastGenerationTrackerSnapshot?.swipeKey ?? 'NO_SNAPSHOT',
                    snapshotGenCount: lastGenerationTrackerSnapshot?.generationCount ?? 'N/A',
                    match: _snapMatch ? 'SWIPE_DETECTED' : 'NO_MATCH',
                    generationCountBefore: generationCount,
                });
            }
            if (_snapMatch) {
                const snap = lastGenerationTrackerSnapshot;
                setCooldownTracker(new Map(snap.cooldown));
                setDecayTracker(new Map(snap.decay));
                setConsecutiveInjections(new Map(snap.consecutive));
                setInjectionHistory(new Map(snap.injectionHistory));
                setGenerationCount(snap.generationCount);
                // BUG-396b: clear injection log on swipe/regen — old injections were for the message
                // being replaced; strip-dedup must not filter them out of the new generation.
                if (chat_metadata.deeplore_injection_log?.length > 0) {
                    if (settings.debugMode) console.debug('[DLE][DIAG] swipe-restore-clear-log — clearing injection log (%d entries) because swipe/regen replaces the prior generation', chat_metadata.deeplore_injection_log.length);
                    chat_metadata.deeplore_injection_log = [];
                    saveMetadataDebounced();
                }
                if (settings.debugMode) console.debug('[DLE][DIAG] swipe-restore', {
                    restoredGenerationCount: snap.generationCount,
                    cooldownKeys: [...snap.cooldown.keys()],
                    historyKeys: [...snap.injectionHistory.keys()],
                });
            }
            // Snapshot tagged with the CURRENT swipe key for next regen's rollback.
            setLastGenerationTrackerSnapshot({
                swipeKey: earlySwipeKey,
                cooldown: new Map(cooldownTracker),
                decay: new Map(decayTracker),
                consecutive: new Map(consecutiveInjections),
                injectionHistory: new Map(injectionHistory),
                generationCount: generationCount,
            });
            if (settings.debugMode) {
                console.debug('[DLE][DIAG] swipe-snapshot-taken', {
                    swipeKey: earlySwipeKey,
                    snapshotGenerationCount: generationCount,
                });
            }
        }

        // ctx is passed to pipeline (pre-filter) AND post-pipeline stages (applyContextualGating).
        const ctx = chat_metadata.deeplore_context || {};

        const pins = chat_metadata.deeplore_pins || [];
        const blocks = chat_metadata.deeplore_blocks || [];
        const folderFilter = chat_metadata.deeplore_folder_filter || null;

        const _pipelineStartMs = performance.now();
        const _pipelineOnStatus = (text) => { _updatePipelineStatus(text); if (text.includes('Consulting')) setPipelinePhase('consulting'); };
        const { finalEntries: pipelineEntries, matchedKeys, trace } = await runPipeline(chatMessages, vaultSnapshot, ctx, { pins, blocks, folderFilter, signal: pipelineAbort.signal, onStatus: _pipelineOnStatus, genId });
        trace.totalMs = Math.round(performance.now() - _pipelineStartMs);
        trace.ensureIndexFreshMs = _indexFreshMs;
        if (pipelineAbort.signal.aborted) {
            if (settings.debugMode) console.debug('[DLE] Pipeline aborted by user before commit');
            return;
        }
        const policy = buildExemptionPolicy(vaultSnapshot, pins, blocks);

        // Stage 1: Pin/Block overrides.
        const _pinBlockStart = performance.now();
        let finalEntries = applyPinBlock(pipelineEntries, vaultSnapshot, policy, matchedKeys);
        trace.pinBlockMs = Math.round(performance.now() - _pinBlockStart);

        // Stage 2: Contextual gating.
        const _gatingStart = performance.now();
        const preContextual = new Set(finalEntries.map(e => e.title));
        const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
        finalEntries = applyContextualGating(finalEntries, ctx, policy, settings.debugMode, settings, fieldDefs);
        trace.contextualGatingMs = Math.round(performance.now() - _gatingStart);
        if (trace) {
            const postContextual = new Set(finalEntries.map(e => e.title));
            trace.contextualGatingRemoved = [...preContextual]
                .filter(t => !postContextual.has(t))
                .map(title => ({ title, reason: 'Filtered by era/location/scene/character' }));
        }

        if (trace?.aiFallback) {
            const aiErr = trace.aiError || '';
            let fallbackMsg = 'AI search failed';
            if (/timeout|timed out|abort/i.test(aiErr)) fallbackMsg += ' (timed out — try increasing the timeout in Settings > AI Search)';
            else if (/401|403|auth/i.test(aiErr)) fallbackMsg += ' (auth error — check your API key or connection profile)';
            else if (/not found|no.*profile/i.test(aiErr)) fallbackMsg += ' (connection profile not found — check Settings > AI Search)';
            else if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch|network/i.test(aiErr)) fallbackMsg += ' (network error — check your AI connection settings)';
            else if (/5\d\d|502|503|server/i.test(aiErr)) fallbackMsg += ' (server error — try again later)';
            else if (aiErr) fallbackMsg += ` (${aiErr.slice(0, 80)})`;
            console.warn('[DLE] AI search error:', aiErr);
            dedupWarning(`${fallbackMsg} — falling back to keywords`, 'ai_search', { timeOut: 6000 });
        }

        if (settings.debugMode && trace) {
            console.log(`[DLE] Pipeline (${trace.mode}): ${trace.keywordMatched.length} keyword matches, ${trace.aiSelected.length} AI selected` + (trace.aiFallback ? ' (AI FALLBACK)' : ''));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries matched');
            }
            // BUG-231: stale-pipeline guard on clearPrompts. A slow pipeline for chat A finishing
            // after CHAT_CHANGED would otherwise wipe chat B's freshly-committed prompts.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Stale pipeline reached no-match branch — skipping clearPrompts');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 3: re-injection cooldown.
        const _cooldownStart = performance.now();
        const preCooldown = new Set(finalEntries.map(e => e.title));
        finalEntries = applyReinjectionCooldown(finalEntries, policy, injectionHistory, generationCount, settings.reinjectionCooldown, settings.debugMode);
        trace.reinjectionCooldownMs = Math.round(performance.now() - _cooldownStart);
        if (trace) {
            const postCooldown = new Set(finalEntries.map(e => e.title));
            trace.cooldownRemoved = [...preCooldown]
                .filter(t => !postCooldown.has(t))
                .map(title => ({ title, reason: 'Cooldown active' }));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by re-injection cooldown');
            // BUG-271: same stale-pipeline guard as BUG-231.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Stale pipeline reached cooldown-empty branch — skipping clearPrompts');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 4: requires/excludes gating (forceInject entries exempt).
        const _reqExclStart = performance.now();
        const { result: gated, removed: gatingRemoved } = applyRequiresExcludesGating(finalEntries, policy, settings.debugMode);
        trace.requiresExcludesMs = Math.round(performance.now() - _reqExclStart);

        if (gated.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by gating rules');
            // BUG-271: same stale-pipeline guard as BUG-231.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Stale pipeline reached gating-empty branch — skipping clearPrompts');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 5: strip duplicate injections.
        // BUG-396c: clear stale injection log BEFORE strip-dedup reads it. Two signals trigger this:
        //   (1) swipe/regen detected — old injections were for the message being replaced
        //   (2) AI cache miss — chat content changed enough that old dedup entries are stale
        // Done here (not at swipe-restore time) because chat_metadata may be reassigned by ST
        // during the async AI search, which would make a swipe-restore-time clear unreliable.
        const _stripDedupStart = performance.now();
        if (settings.stripDuplicateInjections && (_snapMatch || !trace.aiCached)) {
            if (chat_metadata.deeplore_injection_log?.length > 0) {
                if (settings.debugMode) console.debug('[DLE][DIAG] strip-dedup-log-clear — %s, clearing %d stale injection log entries',
                    _snapMatch ? 'swipe/regen detected' : 'AI cache missed (context changed)',
                    chat_metadata.deeplore_injection_log.length);
                chat_metadata.deeplore_injection_log = [];
                saveMetadataDebounced();
            }
        }
        let postDedup = gated;
        if (settings.stripDuplicateInjections) {
            if (settings.debugMode) {
                const _sLog = chat_metadata.deeplore_injection_log;
                console.debug('[DLE][DIAG] strip-dedup-input', {
                    gatedCount: gated.length,
                    gatedTitles: gated.map(e => e.title),
                    lookbackDepth: settings.stripLookbackDepth,
                    injectionLog: {
                        ref: _sLog === null ? 'NULL' : _sLog === undefined ? 'UNDEFINED' : 'OBJECT',
                        isArray: Array.isArray(_sLog),
                        length: _sLog?.length ?? 0,
                        entries: _sLog?.map(e => ({ gen: e.gen, count: e.entries?.length, titles: e.entries?.map(x => x.title) })) ?? [],
                    },
                });
            }
            postDedup = applyStripDedup(gated, policy, chat_metadata.deeplore_injection_log, settings.stripLookbackDepth, settings, settings.debugMode);
            if (settings.debugMode) {
                const _removed = gated.filter(e => !postDedup.some(p => p.title === e.title));
                console.debug('[DLE][DIAG] strip-dedup-result', {
                    keptCount: postDedup.length,
                    keptTitles: postDedup.map(e => e.title),
                    removedCount: _removed.length,
                    removedTitles: _removed.map(e => e.title),
                });
            }
            if (trace) {
                const postDedupTitles = new Set(postDedup.map(e => e.title));
                trace.stripDedupRemoved = gated
                    .filter(e => !postDedupTitles.has(e.title))
                    .map(e => ({ title: e.title, reason: 'Already in recent context' }));
            }
        }
        trace.stripDedupMs = Math.round(performance.now() - _stripDedupStart);

        // Stage 6: format with budget, grouped by injection position.
        // BUG-014: use the captured `settings` object so the whole pipeline sees consistent values.
        const _fmtStart = performance.now();
        const { groups, count: injectedCount, totalTokens, acceptedEntries } = formatAndGroup(postDedup, settings, PROMPT_TAG_PREFIX);
        trace.formatGroupMs = Math.round(performance.now() - _fmtStart);

        injectedEntries = acceptedEntries;

        if (trace) {
            trace.gatedOut = gatingRemoved.map(e => ({
                title: e.title, requires: e.requires, excludes: e.excludes,
            }));
            const acceptedTitles = new Set(acceptedEntries.map(e => e.title));
            trace.budgetCut = postDedup.filter(e => !acceptedTitles.has(e.title))
                .map(e => ({ title: e.title, tokens: e.tokenEstimate, priority: e.priority }));
            trace.injected = acceptedEntries.map(e => ({
                title: e.title,
                tokens: e.tokenEstimate,
                truncated: !!e._truncated,
                originalTokens: e._originalTokens || e.tokenEstimate,
            }));
            trace.totalTokens = totalTokens;
            trace.budgetLimit = settings.maxTokensBudget;
            // BUG-278/279: stale-pipeline guard on trace publish + activity feed. Both write to
            // session-global state read by the drawer — a stale pipeline landing here would
            // overwrite the new chat's trace / push a stale activity row.
            if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
                setLastPipelineTrace(trace);

                const aiUsed = trace.aiSelected?.length > 0;
                const modeLabel = trace.mode === 'keywords-only' ? 'Keywords'
                    : aiUsed ? (trace.aiFallback ? 'Fallback' : 'AI')
                    : 'Keywords';
                pushActivity({
                    ts: Date.now(),
                    injected: trace.injected?.length || 0,
                    mode: modeLabel,
                    tokens: trace.totalTokens || 0,
                    folderFilter: trace.folderFilter?.folders || null,
                });
            }
        }

        // BUG-AUDIT-5: epoch guard on commit — stale force-released pipelines must not wipe
        // prompts the new pipeline just set.
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            console.warn('[DLE] Stale pipeline reached commit phase — discarding');
            return;
        }

        if (groups.length > 0) {
            // Final epoch check immediately before commit. clearPrompts is inside this branch
            // so we never wipe prompts without verified replacement content.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Chat changed or pipeline superseded during commit — discarding results');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
            const usePromptList = settings.injectionMode === 'prompt_list';
            for (const group of groups) {
                // BUG-146: outlet groups (position === -1) bypass PM and inject via
                // extension_prompts so the {{outlet::name}} macro resolves. Forward allowWIScan
                // and group.role so per-entry frontmatter `role:` survives (would otherwise be
                // silently coerced to SYSTEM) and so outlet content honors the global WI-scan toggle.
                if (group.position === -1) {
                    setExtensionPrompt(group.tag, group.text, -1, 0, settings.allowWIScan, group.role);
                    continue;
                }
                if (usePromptList && promptManager) {
                    // Prompt-List mode writes directly to the PM entry. PM collection order
                    // (user's drag position) controls placement; setExtensionPrompt would override it.
                    const pmEntry = promptManager.getPromptById(group.tag);
                    if (pmEntry) {
                        pmEntry.content = group.text;
                        continue;
                    }
                    // PM entry missing → fall through to setExtensionPrompt.
                }
                setExtensionPrompt(
                    group.tag,
                    group.text,
                    group.position,
                    group.depth,
                    settings.allowWIScan,
                    group.role,
                );
            }

            // Capture injection sources for Context Cartographer; epoch-tagged so
            // CHARACTER_MESSAGE_RENDERED only consumes sources from the matching generation.
            setLastInjectionSources(injectedEntries.map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
                vaultSource: e.vaultSource || '',
            })));
            setLastInjectionEpoch(epoch);
            // Notify drawer early so Why? tab populates BEFORE agentic loop / ST generation starts.
            notifyInjectionSourcesReady();
        } else {
            // No lore groups → still clear stale prompts from the previous generation.
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
            // Clear stale sources so the Why? tab doesn't show prior-generation data.
            setLastInjectionSources(null);
            setLastInjectionEpoch(epoch);
            notifyInjectionSourcesReady();
        }

        // BUG-147: shared PM-or-extension_prompts ladder for aux prompts (notebook, notepad —
        // the lore/constants pair is handled above). Each call site previously duplicated this
        // ladder and drifted (different fallback args, missing allowWIScan, etc.).
        const _injectAuxPrompt = (id, content, position, depth, role, allowWIScan = false) => {
            const usePromptList = settings.injectionMode === 'prompt_list';
            if (usePromptList && promptManager) {
                const pmEntry = promptManager.getPromptById(id);
                if (pmEntry) {
                    pmEntry.content = content;
                    return;
                }
                // PM entry not registered for this id — fall through to extension_prompts.
            }
            setExtensionPrompt(id, content, position, depth, allowWIScan, role);
        };

        // Author's Notebook — independent of entry pipeline.
        if (settings.notebookEnabled && chat_metadata?.deeplore_notebook?.trim()) {
            const notebookContent = chat_metadata.deeplore_notebook.trim();
            _injectAuxPrompt(
                'deeplore_notebook',
                notebookContent,
                settings.notebookPosition,
                settings.notebookDepth,
                settings.notebookRole,
            );
        }

        // AI Notepad injection.
        // Tag mode: previous notes + instruction prompt (AI writes <dle-notes> tags).
        // Extract mode: previous notes only — extraction runs post-generation, no instruction needed.
        if (settings.aiNotepadEnabled) {
            const notepadMode = settings.aiNotepadMode || 'tag';
            const parts = [];
            const storedNotes = chat_metadata?.deeplore_ai_notepad?.trim();
            if (storedNotes) {
                parts.push(`[Your previous session notes]\n${storedNotes}\n[End of session notes]`);
            }
            if (notepadMode === 'tag') {
                const instructionPrompt = settings.aiNotepadPrompt?.trim() || DEFAULT_AI_NOTEPAD_PROMPT;
                parts.push(instructionPrompt);
            }
            // Skip injection in extract mode with no prior notes — nothing useful to send.
            if (parts.length > 0) {
                const notepadContent = parts.join('\n\n');
                _injectAuxPrompt(
                    'deeplore_ai_notepad',
                    notepadContent,
                    settings.aiNotepadPosition,
                    settings.aiNotepadDepth,
                    settings.aiNotepadRole,
                );
            }
        }

        // Stage 7: track cooldowns + injection history. Both epoch+lockEpoch guards required —
        // a force-released stale pipeline must not corrupt these Maps concurrently with its successor.
        const _trackStart = performance.now();
        if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings);
        }
        trace.trackGenerationMs = Math.round(performance.now() - _trackStart);

        // Dedup-toggled-off: nuke the now-meaningless injection log (epoch-guarded).
        if (!settings.stripDuplicateInjections && epoch === chatEpoch && chat_metadata.deeplore_injection_log?.length > 0) {
            chat_metadata.deeplore_injection_log = [];
            saveMetadataDebounced();
        }

        // Record this generation's injections for future dedup. Epoch guard prevents writing to the wrong chat.
        if (settings.stripDuplicateInjections && epoch === chatEpoch) {
            if (!chat_metadata.deeplore_injection_log) {
                chat_metadata.deeplore_injection_log = [];
            }
            const _logLenBefore = chat_metadata.deeplore_injection_log.length;
            chat_metadata.deeplore_injection_log.push({
                gen: generationCount + 1,
                entries: injectedEntries.map(e => ({
                    title: e.title,
                    pos: e.injectionPosition ?? settings.injectionPosition,
                    depth: e.injectionDepth ?? settings.injectionDepth,
                    role: e.injectionRole ?? settings.injectionRole,
                    contentHash: e._contentHash || '',
                })),
            });
            const maxHistory = settings.stripLookbackDepth + 1;
            const _trimmed = chat_metadata.deeplore_injection_log.length > maxHistory;
            if (_trimmed) {
                chat_metadata.deeplore_injection_log = chat_metadata.deeplore_injection_log.slice(-maxHistory);
            }
            if (settings.debugMode) {
                console.debug('[DLE][DIAG] injection-log-write', {
                    genRecorded: generationCount + 1,
                    injectedTitles: injectedEntries.map(e => e.title),
                    injectedCount: injectedEntries.length,
                    logLenBefore: _logLenBefore,
                    logLenAfter: chat_metadata.deeplore_injection_log.length,
                    trimmed: _trimmed,
                    maxHistory,
                });
            }
            saveMetadataDebounced();
        } else if (settings.debugMode) {
            console.debug('[DLE][DIAG] injection-log-write-SKIPPED', {
                stripDuplicateInjections: settings.stripDuplicateInjections,
                epochMatch: epoch === chatEpoch,
                epoch, chatEpoch,
            });
        }

        // Stage 8: analytics — postDedup is the "matched" set (passed all gating).
        // Epoch+lock guards mirror Stages 7 and 9 to prevent cross-chat pollution.
        const _analyticsStart = performance.now();
        if (postDedup.length > 0 && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            recordAnalytics(postDedup, injectedEntries, settings.analyticsData);
            // generationCount > 0 skips the gen-0 case (first gen after CHAT_CHANGED) — that
            // would save before any mutation accumulates. _analyticsPendingSave lets
            // CHAT_CHANGED / beforeunload flush any unpersisted batch.
            _analyticsPendingSave = true;
            if (generationCount > 0 && generationCount % 5 === 0) {
                invalidateSettingsCache();
                saveSettingsDebounced();
                _analyticsPendingSave = false;
            }
        }
        trace.recordAnalyticsMs = Math.round(performance.now() - _analyticsStart);

        // Stage 9: per-chat injection counts. Epoch + lock guards + swipe-aware rollback.
        // BUG-291/292/293: keyed by `${msgIdx}|${swipe_id}` with per-swipe trackerKey map. Handles:
        //   - regen of current swipe (key matches → decrement the prior keys exactly)
        //   - alternate-swipe nav (different swipe_id → different key → no false decrement)
        //   - reload between generations (perSwipeInjectedKeys is persisted to chat_metadata)
        const _countsStart = performance.now();
        if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            const lastIdx = chatMessages.length - 1;
            const swipeId = lastIdx >= 0 ? (chatMessages[lastIdx]?.swipe_id ?? 0) : 0;
            const swipeKey = `${lastIdx}|${swipeId}`;

            const priorKeys = perSwipeInjectedKeys.get(swipeKey);
            if (priorKeys && priorKeys.size > 0) {
                for (const key of priorKeys) {
                    const cur = chatInjectionCounts.get(key) || 0;
                    if (cur > 0) chatInjectionCounts.set(key, cur - 1);
                }
            }

            const thisRoundKeys = new Set();
            for (const entry of injectedEntries) {
                const key = trackerKey(entry);
                chatInjectionCounts.set(key, (chatInjectionCounts.get(key) || 0) + 1);
                thisRoundKeys.add(key);
            }
            perSwipeInjectedKeys.set(swipeKey, thisRoundKeys);

            // Prune to last 10 message slots — bounds memory + persisted metadata size.
            const keepFromIdx = Math.max(0, chatMessages.length - 10);
            for (const k of [...perSwipeInjectedKeys.keys()]) {
                const mi = parseInt(k.split('|')[0], 10);
                if (!Number.isFinite(mi) || mi < keepFromIdx) perSwipeInjectedKeys.delete(k);
            }

            // Persist every generation — counts are lost on chat switch otherwise.
            chat_metadata.deeplore_chat_counts = Object.fromEntries(chatInjectionCounts);
            chat_metadata.deeplore_swipe_injected_keys = Object.fromEntries(
                [...perSwipeInjectedKeys.entries()].map(([k, v]) => [k, [...v]])
            );
            // BUG-306: immediate save (not debounced) — debounce can lose the race with
            // CHAT_CHANGED and never flush. Belt-and-braces fallback if saveMetadata throws sync.
            try { saveMetadata(); } catch { saveMetadataDebounced(); }
            notifyChatInjectionCountsUpdated();
        }
        trace.perChatCountsMs = Math.round(performance.now() - _countsStart);

        if (groups.length > 0) {
            // Context-usage warning with hysteresis: warn at 20% (with +5% gap from last warn),
            // reset baseline at 15% so a re-climb can re-warn instead of spamming.
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `Your lore uses ${pct}% of your context window (~${totalTokens} tokens, ${injectedCount} entries). You can set a token budget in Settings to manage this.`,
                        'DeepLore Enhanced',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    setLastWarningRatio(ratio);
                } else if (ratio <= 0.15) {
                    setLastWarningRatio(0);
                }
            }

            if (settings.debugMode) {
                console.log(`[DLE] ${finalEntries.length} selected, ${postDedup.length} after gating+dedup, ${injectedCount} injected (~${totalTokens} tokens) in ${groups.length} group(s)` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(injectedEntries.map(e => ({
                    title: e.title,
                    matchedBy: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
                if (groups.length > 1) {
                    console.log('[DLE] Injection groups:', groups.map(g =>
                        `${g.tag}: pos=${g.position} depth=${g.depth} role=${g.role}`));
                }
            }
        }

        // Pipeline complete — show "Generating..." until first streaming token arrives.
        setPipelinePhase('generating');
        _updatePipelineStatus('Generating\u2026');

        // === Agentic Loop Dispatch ===
        // When Librarian is enabled and the active API supports tool calling, DLE runs its
        // own agentic loop instead of letting ST generate. This produces a single clean message
        // with no intermediate tool_invocation system messages.
        // Agentic loop produces complete responses — fall through to ST for continue/append.
        // One-shot suppression: reset flag regardless of whether we enter the agentic branch
        if (suppressNextAgenticLoop) {
            setSuppressNextAgenticLoop(false);
            if (settings.debugMode) console.debug('[DLE] Agentic loop suppressed for this generation (one-shot)');
        } else if (settings.librarianEnabled && isToolCallingSupported()
            && type !== 'continue' && type !== 'append' && type !== 'appendFinal') {
            // BUG-AUDIT (Fix 30): pass `true` so ST's runGenerationInterceptors breaks
            // the chain immediately. Plain abort() flags aborted=true but lets every
            // later interceptor run against the chat DLE has already replaced.
            abort(true); // Prevent ST from generating; stop further interceptors

            // C1: Re-entrancy guard — abort() re-enables send via unblockGeneration(), lock it again
            setSendButtonState(true);
            deactivateSendButtons();

            // C6: Reset search counter for this generation (searchLoreAction reads it internally)
            setLoreGapSearchCount(0);

            // H6: Clear extension prompts — lore is embedded in the agentic system prompt,
            // so extension_prompts would duplicate it when CMRS.sendRequest builds the payload.
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`]) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
            // Also clear aux prompts (notebook, notepad) — they're in the agentic system prompt too
            for (const auxId of ['deeplore_notebook', 'deeplore_ai_notepad']) {
                if (extension_prompts[auxId]) delete extension_prompts[auxId];
                if (promptManager) {
                    const pmEntry = promptManager.getPromptById(auxId);
                    if (pmEntry) pmEntry.content = '';
                }
            }

            // H7: Declared outside try so catch can access it for save-on-error
            let proseMsg = null;

            try {
                const pipelineContext = groups.map(g => g.text).join('\n\n');
                const injTitles = new Set((acceptedEntries || []).map(e => (e.title || '').toLowerCase()));

                const agenticMessages = buildChatMessages(chatMessages, pipelineContext, injTitles, settings);

                const onProse = async (proseText) => {
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;

                    // saveReply operates on the global chat[] (NOT the shadowed chatMessages
                    // parameter). It does: message creation, chat.push, swipe_info setup,
                    // awaited MESSAGE_RECEIVED, addOneMessage, awaited CHARACTER_MESSAGE_RENDERED.
                    //
                    // The CHARACTER_MESSAGE_RENDERED handler (L1315) then:
                    //   - attaches deeplore_sources from lastInjectionSources
                    //   - injects the sources button
                    //   - extracts AI notes (mutates message.mes → cleaned text)
                    //
                    // Net result: swipes[0] = cleaned mes; swipe_info[0].extra holds
                    // deeplore_sources + deeplore_ai_notes.
                    await saveReply({ type, getMessage: proseText });

                    // Re-check after every await — chat switch during MESSAGE_RECEIVED /
                    // CHARACTER_MESSAGE_RENDERED handlers would attach proseMsg to the wrong
                    // chat and saveChatConditional would persist into the new active chat.
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;

                    // Captured for post-loop tool_calls attachment.
                    proseMsg = chat[chat.length - 1];

                    _removePipelineStatus();
                    updateViewMessageIds();

                    // saveReply does NOT persist to disk. ST's Generate() normally does that,
                    // but we called abort() so it returned early. Save now.
                    await saveChatConditional();
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                        proseMsg = null;
                        return;
                    }
                };

                setPipelinePhase('writing');
                _updatePipelineStatus('Writing\u2026');
                const onAgenticStatus = (text) => {
                    _updatePipelineStatus(text);
                    // Drawer phase tracks status-text prefix.
                    if (text.startsWith('Searching')) setPipelinePhase('searching');
                    else if (text.startsWith('Writing') || text.startsWith('Generating')) setPipelinePhase('writing');
                };
                const result = await runAgenticLoop({
                    messages: agenticMessages,
                    maxSearches: settings.librarianMaxSearches || 2,
                    searchEnabled: settings.librarianSearchEnabled !== false,
                    flagEnabled: settings.librarianFlagEnabled !== false,
                    maxTokens: getActiveMaxTokens(),
                    signal: pipelineAbort.signal,
                    epoch,
                    lockEpoch,
                    onStatus: onAgenticStatus,
                    onProse,
                    injectedTitles: injTitles,
                    settings,
                });

                // Re-check after the loop completes — chat may have changed during it.
                if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;

                if (proseMsg) {
                    // Lifecycle events already fired in onProse — just attach tool data and re-save.
                    proseMsg.extra.deeplore_tool_calls = result.toolActivity;
                    await saveChatConditional();

                    if (settings.librarianShowToolCalls && result.toolActivity.length > 0) {
                        injectLibrarianDropdown(chat.length - 1, result.toolActivity);
                    }
                } else if (result.prose) {
                    // Fallback path: onProse never fired (text-only response, no write() tool call).
                    // saveReply gives us the proper message lifecycle (global chat, events, swipe_info).
                    await saveReply({ type, getMessage: result.prose });
                    const msg = chat[chat.length - 1];
                    msg.extra.deeplore_tool_calls = result.toolActivity;
                    updateViewMessageIds();
                    await saveChatConditional();

                    if (settings.librarianShowToolCalls && result.toolActivity.length > 0) {
                        injectLibrarianDropdown(chat.length - 1, result.toolActivity);
                    }
                } else {
                    dedupError('AI did not produce a response. Try again.', 'agentic_no_prose');
                }
            } catch (err) {
                if (err?.name !== 'AbortError' && !pipelineAbort.signal.aborted) {
                    console.error('[DLE] Agentic loop error:', err);
                    pushEvent('librarian', { action: 'error', error: err?.message?.slice(0, 200) });
                    // proseMsg already set → error is from FLAG phase, save what we have.
                    if (proseMsg) {
                        await saveChatConditional();
                    } else if (err?.name === 'SafetyBlockError') {
                        // Gemini safety block / RECITATION / empty candidate \u2014 distinct user guidance
                        // so the user can act (relax safety in preset, rephrase, or change model)
                        // instead of seeing the generic "Generation failed" toast.
                        dedupError('Gemini blocked or returned an empty response. Try rephrasing, relaxing safety in your profile preset, or using a different model.', 'agentic_safety_block', { hint: err.message?.slice(0, 200) });
                    } else {
                        dedupError('Generation failed \u2014 try again or disable Librarian.', 'agentic_error');
                    }
                }
            } finally {
                // C1: restore send-button state captured at dispatch.
                setSendButtonState(false);
                activateSendButtons();
                _removePipelineStatus();
                // Errors here must not propagate to the outer catch — that would show a misleading
                // "Couldn't load your lore" toast on a successful generation.
                try { await eventSource.emit(event_types.GENERATION_ENDED, chat.length); } catch { /* noop */ }
            }
            return; // Don't fall through to ST's generation.
        }

        // Librarian-on but no tool support: surface a distinct warning. Reasoning-only models
        // (deepseek-reasoner, o-series, *-r1) physically cannot tool-call — that's a model-class
        // problem, distinct from "provider/source doesn't support tools".
        if (settings.librarianEnabled && !isToolCallingSupported() && !suppressNextAgenticLoop) {
            const modelForWarning = getResolvedModel();
            if (modelForWarning && isReasoningOnlyModel(modelForWarning)) {
                dedupWarning(`Librarian skipped: ${modelForWarning} is a reasoning-only model and can't use function calling. Pick a tool-capable model.`, 'librarian_no_tools_reasoner');
                try { generationBuffer.push({ t: Date.now(), event: 'librarian-skip', reason: 'no_tools_model', model: modelForWarning }); } catch { /* noop */ }
            } else {
                dedupWarning('Librarian is on but your connection doesn\'t support function calling — falling back to normal generation. Check DLE Settings → Connection.', 'librarian_no_tools');
            }
        }

    } catch (err) {
        _removePipelineStatus();
        // BUG-233: user aborts are not errors — no toast, no log spam.
        if (err?.userAborted || err?.name === 'AbortError' || pipelineAbort.signal.aborted) {
            if (settings.debugMode) console.debug('[DLE] Pipeline aborted:', err?.message || 'user stop');
            try { const { recordAbort } = await import('./src/diagnostics/flight-recorder.js'); recordAbort(err?.message || 'user stop'); } catch { /* noop */ }
        } else {
            console.error('[DLE] Error during generation:', err);
            dedupError('Couldn\'t load your lore. Try /dle-refresh, or /dle-health for diagnostics.', 'pipeline', { hint: classifyError(err) });
        }
    } finally {
        // BUG-233 + BUG-AUDIT (Fix 4): tear down abort listeners every time. onStop and
        // onChatChange are split so each fires its own abort reason — both must be removed.
        try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ }
        try { eventSource.removeListener(event_types.CHAT_CHANGED, onChatChange); } catch { /* noop */ }
        try { eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, onFirstToken); } catch { /* noop */ }
        // BUG-FIX-4/12: covers all early-return paths.
        _removePipelineStatus();
        // Generation tracking MUST run when pipelineRan even if no entries matched —
        // otherwise cooldown timers freeze permanently. Wrapped to prevent tracking errors
        // from propagating into ST generation.
        try {
            if (pipelineRan && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
                setGenerationCount(generationCount + 1);
                decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections);
            } else if (pipelineRan) {
                // Stale pipeline; cooldowns intentionally freeze for it (the active pipeline owns them).
                console.debug('[DLE] Stale pipeline — generation tracking skipped');
                try { generationBuffer.push({ t: Date.now(), discarded: true, reason: 'stale_pipeline_tracking_skipped' }); } catch { /* noop */ }
            }
        } catch (trackingErr) {
            console.error('[DLE] Error in generation tracking:', trackingErr);
        }
        // Release lock and phase BEFORE notify so pipeline-complete renders see correct state.
        // Lock-epoch guard: a force-released stale pipeline must NOT release the new pipeline's lock.
        if (lockEpoch === generationLockEpoch) {
            setPipelinePhase('idle');
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Stale pipeline did not release lock (epoch mismatch)');
            try { generationBuffer.push({ t: Date.now(), lockReleaseBlocked: true, reason: 'epoch_mismatch', staleEpoch: lockEpoch, currentEpoch: generationLockEpoch }); } catch { /* noop */ }
        }
        // BUG-277: only notify drawer when WE are still the active pipeline — a stale
        // pipeline finishing here would fire complete-notifications at the new chat's drawer.
        if (lockEpoch === generationLockEpoch && epoch === chatEpoch) {
            notifyPipelineComplete();
        }
    }
}

// ST discovers the interceptor via globalThis.<extension_id>_onGenerate.
globalThis.deepLoreEnhanced_onGenerate = onGenerate;

// External API for other extensions / scripts to match vault entries against arbitrary text.
globalThis.deepLoreEnhanced_matchText = matchTextForExternal;

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        // BUG-063: re-init guard. Hot reload / duplicate load → tear down prior listeners
        // and DOM before re-registering, otherwise every handler doubles.
        if (_dleInitialized) {
            console.warn('[DLE] init() called twice — tearing down prior instance before re-initializing');
            _teardownDleExtension();
        }
        _dleInitialized = true;

        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore-Enhanced',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        await createDrawerPanel();
        createMobileShell({
            buildIndex,
            getSettings,
            getDrawerState: () => ds,
            getChatMetadata: () => chat_metadata,
        });

        loadSettingsUI();
        bindSettingsEvents(buildIndex);
        registerSlashCommands();
        setupSyncPolling(buildIndex, buildIndexWithReuse);

        // Always-on flight recorder; runs independent of debugMode.
        try {
            const { startFlightRecorder } = await import('./src/diagnostics/flight-recorder.js');
            startFlightRecorder();
        } catch (err) {
            console.warn('[DLE] Flight recorder failed to start:', err?.message);
        }

        try {
            const { applyLibrarianVisibility } = await import('./src/librarian/visibility.js');
            applyLibrarianVisibility(!!getSettings().librarianEnabled);
        } catch (err) {
            console.warn('[DLE] Librarian visibility init failed:', err.message);
        }

        // Pre-flight Claude adaptive-thinking misconfiguration sweep across all 3 AI features.
        // Surfaces warning at startup rather than on first generation.
        try {
            const {
                detectClaudeAdaptiveIssue,
                buildClaudeAdaptiveMessage,
                shouldCheckClaudeAdaptiveForFeature,
                claimClaudeAdaptiveToastSlot,
            } = await import('./src/ai/claude-adaptive-check.js');
            const { setClaudeAutoEffortState } = await import('./src/state.js');
            const { dedupWarning } = await import('./src/toast-dedup.js');
            const s = getSettings();
            // Only check features in `profile` mode. Proxy mode routes through a local proxy
            // that handles thinking itself, so the native-preset check is a false positive.
            const checks = [
                { id: s.aiSearchProfileId, model: s.aiSearchModel, label: 'AI Search', feature: 'aiSearch' },
                { id: s.scribeProfileId, model: s.scribeModel, label: 'Session Scribe', feature: 'scribe' },
                { id: s.autoSuggestProfileId, model: s.autoSuggestModel, label: 'Auto Lorebook', feature: 'autoSuggest' },
            ].filter(c => shouldCheckClaudeAdaptiveForFeature(s, c.feature));
            let firstBad = null;
            for (const c of checks) {
                const d = detectClaudeAdaptiveIssue(c.id, c.model);
                if (d.bad) { firstBad = { ...d, feature: c.label }; break; }
            }
            if (firstBad) {
                // The persistent surfaces (drawer chip + settings banner) are driven
                // by this state; the toast is a one-shot heads-up only.
                setClaudeAutoEffortState(true, firstBad);
                if (claimClaudeAdaptiveToastSlot(firstBad)) {
                    dedupWarning(buildClaudeAdaptiveMessage(firstBad, 'toast'), 'claude_auto_effort', { timeOut: 12000 });
                }
            } else {
                setClaudeAutoEffortState(false, null);
            }
        } catch (err) {
            console.debug('[DLE] Claude adaptive-thinking pre-flight check skipped:', err?.message);
        }

        // First-run wizard. MUST wait for APP_READY (fires after ST's onboarding popup is dismissed),
        // otherwise our wizard lands on top of ST's persona-name popup on brand-new installs.
        const firstRunSettings = getSettings();
        const hasEnabledVaults = (firstRunSettings.vaults || []).some(v => v.enabled);
        // BUG-125: localStorage sentinel as a backup in case settings save crashed.
        const _lsSentinel = typeof localStorage !== 'undefined' && localStorage.getItem('dle-wizard-completed') === '1';
        const _settingsFlag = !!firstRunSettings._wizardCompleted;
        const wizardCompleted = _settingsFlag || _lsSentinel;
        // The two sources can diverge if a write path fails (settings save crash, localStorage quota).
        // Reconcile so drawer status / wizard re-launch / diagnostics all read the same truth next load.
        if (wizardCompleted && _settingsFlag !== _lsSentinel) {
            try {
                if (!_settingsFlag) {
                    firstRunSettings._wizardCompleted = true;
                    try { saveSettingsDebounced(); } catch { /* noop */ }
                }
                if (!_lsSentinel && typeof localStorage !== 'undefined') {
                    try { localStorage.setItem('dle-wizard-completed', '1'); } catch { /* quota/denied — settings flag is authoritative */ }
                }
            } catch { /* noop */ }
        }
        if (!hasEnabledVaults && !wizardCompleted) {
            const launchWizard = async () => {
                try {
                    // Wait for ST onboarding to be gone — covers cases where APP_READY fires early
                    // or a future ST version moves onboarding to a non-blocking flow.
                    const onboardingVisible = () => {
                        const el = document.querySelector('#onboarding_template .onboarding')
                            || document.querySelector('dialog[open] .onboarding');
                        return el && el.offsetParent !== null;
                    };
                    let waited = 0;
                    while (onboardingVisible() && waited < 30000) {
                        await new Promise(r => setTimeout(r, 250));
                        waited += 250;
                    }
                    // Re-check — user may have configured a vault during the onboarding wait.
                    const s = getSettings();
                    if ((s.vaults || []).some(v => v.enabled) || s._wizardCompleted) return;
                    const { showSetupWizard } = await import('./src/ui/setup-wizard.js');
                    showSetupWizard();
                } catch (err) {
                    console.warn('[DLE] Setup wizard auto-open failed:', err?.message);
                }
            };
            // BUG-118: this `once` registration sits after several awaits in init(); on fast
            // machines APP_READY may have already fired and the listener never runs. Fire-once
            // latch + 3s fallback timer covers both ordering cases without double-launching.
            let _wizardLatched = false;
            const _wizardOnce = () => { if (_wizardLatched) return; _wizardLatched = true; setTimeout(launchWizard, 500); };
            _registerEs(event_types.APP_READY, _wizardOnce, { once: true });
            setTimeout(_wizardOnce, 3000);
        }

        // PM-mode: register prompts at init so they appear in Prompt Manager before the
        // first generation. Content is written directly to PM entries at gen time (not via
        // setExtensionPrompt) so the user's drag position in PM controls placement.
        const initSettings = getSettings();
        if (initSettings.injectionMode === 'prompt_list') {
            // promptManager may not be ready yet — poll briefly with a 10s ceiling.
            const PM_DISPLAY_NAMES = {
                [`${PROMPT_TAG_PREFIX}constants`]: 'DLE Constants',
                [`${PROMPT_TAG_PREFIX}lore`]: 'DLE Lore Entries',
                'deeplore_notebook': 'DLE Author\'s Notebook',
                'deeplore_ai_notepad': 'DLE AI Notepad',
            };
            const registerPmEntries = () => {
                if (!promptManager) return false;
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad'];
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: PM_DISPLAY_NAMES[id] || id,
                            content: '',
                            system_prompt: true,
                            role: 'system',
                            marker: false,
                            enabled: true,
                            extension: true,
                        }, id);
                    } else {
                        // Patch legacy entries (missing role / old display name).
                        if (!existing.role) existing.role = 'system';
                        if (!existing.extension) existing.extension = true;
                        const friendlyName = PM_DISPLAY_NAMES[id];
                        if (friendlyName && existing.name !== friendlyName) existing.name = friendlyName;
                    }
                    // Insert after 'main' or 'chatHistory' rather than appending — appending
                    // would land entries after jailbreak, which is the wrong default placement.
                    if (promptManager.activeCharacter) {
                        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                        if (!order.find(e => e.identifier === id)) {
                            const anchorIdx = order.findIndex(e => e.identifier === 'main' || e.identifier === 'chatHistory');
                            if (anchorIdx >= 0) {
                                order.splice(anchorIdx + 1, 0, { identifier: id, enabled: true });
                            } else {
                                order.push({ identifier: id, enabled: true });
                            }
                        }
                    }
                }
                promptManager.render(false);
                return true;
            };
            if (!registerPmEntries()) {
                const interval = setInterval(() => {
                    if (registerPmEntries()) clearInterval(interval);
                }, 1000);
                setTimeout(() => clearInterval(interval), 10000);
            }
        }
        if (initSettings.enabled) {
            // Hydrate from IndexedDB first; full Obsidian rebuild runs in background.
            // BUG-118: same fast-machine APP_READY race as the wizard above. Latch + 3s fallback.
            let _autoConnectLatched = false;
            const _autoConnectOnce = async () => {
                if (_autoConnectLatched) return; _autoConnectLatched = true;
                // Skip if a build was already triggered by early user generation.
                if (indexEverLoaded || indexing) return;
                try {
                    const hydrated = await hydrateFromCache();
                    if (!hydrated) {
                        await buildIndex();
                    }
                    // hydrateFromCache (when it succeeds) triggers a background buildIndex itself.
                } catch (err) {
                    console.warn('[DLE] Auto-connect:', err.message);
                }
            };
            _registerEs(event_types.APP_READY, _autoConnectOnce, { once: true });
            setTimeout(_autoConnectOnce, 3000);
        }

        // BUG-062: Cartographer click/keydown delegation namespaced `.dle-carto` so teardown
        // can detach via `$('#chat').off('.dle-carto')`. Without the namespace, extension
        // reload double-bound the handler and toggling showLoreSources off had no detach path.
        $('#chat').off('.dle-carto');
        $('#chat').on('click.dle-carto keydown.dle-carto', '.mes_deeplore_sources', function (e) {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const messageId = $(this).closest('.mes').attr('mesid');
            const message = chat[messageId];
            const sources = message?.extra?.deeplore_sources;
            if (!sources || sources.length === 0) return;
            showSourcesPopup(sources, { aiNotes: message?.extra?.deeplore_ai_notes });
        });

        // Stepped-Thinking coexistence — see `inSteppedThinking` declaration above for the full rationale.
        // Custom string events (not in `event_types`): Stepped Thinking emits via
        // `eventSource.emit('GENERATION_MUTEX_CAPTURED', {extension_name: 'stepped-thinking'})`.
        // eventSource accepts any string key, so literal-string subscription works.
        _registerEs('GENERATION_MUTEX_CAPTURED', (payload) => {
            if (payload?.extension_name === 'stepped-thinking') {
                inSteppedThinking = true;
                clearTimeout(_steppedThinkingTimeout);
                // 10s safety so a missed RELEASED (ST update, error path) doesn't lock pipelines indefinitely.
                _steppedThinkingTimeout = setTimeout(() => { inSteppedThinking = false; }, 10_000);
            }
        });
        _registerEs('GENERATION_MUTEX_RELEASED', () => {
            // No payload on RELEASED. Unconditional clear is safe: DLE only sets the flag for
            // stepped-thinking, so other extensions using the same mutex pattern can't false-clear.
            inSteppedThinking = false;
            clearTimeout(_steppedThinkingTimeout);
        });

        _registerEs(event_types.GENERATION_STOPPED, () => {
            try {
                _removePipelineStatus();
                // Bump lockEpoch so any in-flight pipeline's late writes lose all guards.
                setGenerationLockEpoch(generationLockEpoch + 1);
                if (generationLock) setGenerationLock(false);
                // BUG-FIX-6: prompts left from the stopped generation must not bleed into the next.
                clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
                const _settings = getSettings();
                if (_settings.injectionMode === 'prompt_list' && promptManager) {
                    for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                        const pmEntry = promptManager.getPromptById(id);
                        if (pmEntry) pmEntry.content = '';
                    }
                }
                // Drawer mascot would otherwise stick on 'writing'/'searching'/'generating' post-Stop.
                // Epoch bump above guarantees no active pipeline can race this write.
                setPipelinePhase('idle');
            } catch (err) { console.warn('[DLE] GENERATION_STOPPED cleanup failed:', err?.message); }
        });

        _registerEs(event_types.GENERATION_ENDED, () => {
            const settings = getSettings();
            if (!settings.aiNotepadEnabled) return;
            const mode = settings.aiNotepadMode || 'tag';
            const lastMessage = chat[chat.length - 1];
            if (!lastMessage || lastMessage.is_user || !lastMessage.mes) return;

            if (mode === 'tag') {
                // BUG-AUDIT-C01: capture epoch before any writes — fast chat switch between
                // extractAiNotes() and the metadata write would land notes in the wrong chat.
                const tagEpoch = chatEpoch;
                const { notes, cleanedMessage } = extractAiNotes(lastMessage.mes);
                if (notes && tagEpoch === chatEpoch) {
                    lastMessage.mes = cleanedMessage;
                    lastMessage.extra = lastMessage.extra || {};
                    lastMessage.extra.deeplore_ai_notes = notes;
                    const existing = chat_metadata.deeplore_ai_notepad || '';
                    chat_metadata.deeplore_ai_notepad = capNotepad((existing + '\n' + notes).trim());
                    saveMetadataDebounced();
                    pushEvent('ai_notepad', { action: 'tag_extracted', noteLength: notes.length });
                    if (settings.debugMode) console.debug('[DLE] Notepad: extracted %d chars from tags', notes.length);
                }
            } else if (mode === 'extract') {
                // Strip visible note-taking prose first, then fire async API extraction.
                let cleaned = lastMessage.mes;
                for (const pattern of VISIBLE_NOTES_PATTERNS) {
                    cleaned = cleaned.replace(pattern, '');
                }
                cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trimEnd();
                if (cleaned !== lastMessage.mes) {
                    lastMessage.mes = cleaned;
                    saveMetadataDebounced();
                }

                // BUG-AUDIT-7 + C04: fire-and-forget async extraction. Epoch guard prevents
                // writing notes to the wrong chat after a chat switch; flag is set INSIDE the
                // try block so a sync throw (e.g. resolveConnectionConfig) can't leak it forever.
                if (notepadExtractInProgress) return;
                const extractEpoch = chatEpoch;
                const msgIndex = chat.length - 1;
                const swipeIdAtStart = lastMessage.swipe_id;
                if (settings.debugMode) console.debug('[DLE] Notepad: starting AI extraction');
                (async () => {
                    setNotepadExtractInProgress(true);
                    pushEvent('ai_notepad', { action: 'extract_start' });
                    try {
                        const extractPrompt = settings.aiNotepadExtractPrompt?.trim() || DEFAULT_AI_NOTEPAD_EXTRACT_PROMPT;
                        const existingNotes = chat_metadata?.deeplore_ai_notepad?.trim();
                        let userMsg = `[Latest AI response]\n${lastMessage.mes}`;
                        if (existingNotes) {
                            userMsg = `[Previous session notes]\n${existingNotes}\n\n${userMsg}`;
                        }

                        const connectionConfig = { ...resolveConnectionConfig('aiNotepad'), skipThrottle: true };

                        const result = await callAI(extractPrompt, userMsg, connectionConfig);
                        const responseText = (result?.text || result || '').trim();

                        // BUG-AUDIT-7: chat-changed guard.
                        if (extractEpoch !== chatEpoch) {
                            if (getSettings().debugMode) console.debug('[DLE] Notepad: extraction skipped (epoch changed)');
                            return;
                        }
                        // BUG-AUDIT-CNEW01: swipe/delete guard for the same message slot.
                        const currentMsg = chat[msgIndex];
                        if (!currentMsg || currentMsg.swipe_id !== swipeIdAtStart) {
                            if (getSettings().debugMode) console.debug('[DLE] Notepad: extraction skipped (epoch changed)');
                            return;
                        }
                        if (responseText && responseText !== 'NOTHING_TO_NOTE') {
                            currentMsg.extra = currentMsg.extra || {};
                            currentMsg.extra.deeplore_ai_notes = responseText;
                            const existing = chat_metadata.deeplore_ai_notepad || '';
                            chat_metadata.deeplore_ai_notepad = capNotepad((existing + '\n' + responseText).trim());
                            saveMetadataDebounced();
                            pushEvent('ai_notepad', { action: 'extract_completed', noteLength: responseText?.length || 0 });
                            if (getSettings().debugMode) console.debug('[DLE] Notepad: AI extracted %d chars', responseText.length);
                        } else if (responseText === 'NOTHING_TO_NOTE') {
                            pushEvent('ai_notepad', { action: 'extract_empty' });
                        }
                    } catch (err) {
                        console.warn('[DLE] AI Notebook extract error:', err.message);
                        pushEvent('ai_notepad', { action: 'extract_error', error: err?.message?.slice(0, 200) });
                    } finally {
                        setNotepadExtractInProgress(false);
                    }
                })();
            }
        });

        // CHARACTER_MESSAGE_RENDERED is the central post-render handler — Cartographer button
        // injection, AI Notepad fallback extraction, Session Scribe trigger, Auto Lorebook trigger.
        _registerEs(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();
            const message = chat[messageId];

            // BUG-142: each job is wrapped so one failure doesn't abort the others.

            // --- Cartographer: attach sources, inject button ---
            try {
                if (settings.showLoreSources && lastInjectionSources && lastInjectionSources.length > 0) {
                    if (lastInjectionEpoch === chatEpoch && lastInjectionSources._consumedByMesId !== messageId) {
                        if (message && !message.is_user) {
                            message.extra = message.extra || {};
                            message.extra.deeplore_sources = lastInjectionSources;
                            lastInjectionSources._consumedByMesId = messageId;
                            saveMetadataDebounced();
                        }
                    }
                }
                if (settings.showLoreSources) {
                    injectSourcesButton(messageId);
                }
            } catch (err) { console.warn('[DLE] Cartographer render-handler failed:', err?.message); }

            // --- AI Notepad fallback extraction (catches cases GENERATION_ENDED missed, e.g. swipe) ---
            try {
                if (settings.aiNotepadEnabled) {
                    // BUG-AUDIT-C02: same race as C01 — capture epoch before extractAiNotes
                    // so CHAT_CHANGED between extract and metadata append can't write to wrong chat.
                    const renderEpoch = chatEpoch;
                    if (message && !message.is_user && message.mes) {
                        const { notes, cleanedMessage } = extractAiNotes(message.mes);
                        if (notes && renderEpoch === chatEpoch) {
                            message.mes = cleanedMessage;
                            message.extra = message.extra || {};
                            if (!message.extra.deeplore_ai_notes) {
                                message.extra.deeplore_ai_notes = notes;
                                const existing = chat_metadata.deeplore_ai_notepad || '';
                                chat_metadata.deeplore_ai_notepad = capNotepad((existing + '\n' + notes).trim());
                            }
                            saveMetadataDebounced();
                            const mesBlock = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
                            if (mesBlock) mesBlock.innerHTML = messageFormatting(cleanedMessage, message.name, message.is_system, message.is_user, messageId);
                        }
                    }
                }
            } catch (err) { console.warn('[DLE] AI Notebook render-handler failed:', err?.message); }


            // --- Session Scribe auto-trigger ---
            try {
                if (settings.enabled && settings.scribeEnabled && settings.scribeInterval > 0) {
                    const newMessages = chat.length - lastScribeChatLength;
                    if (newMessages >= settings.scribeInterval && !scribeInProgress) {
                        // Surface failures via dedup'd toast — silent fire-and-forget would
                        // hide background-scribe breakage from users until they noticed missing notes.
                        runScribe().catch(err => {
                            console.warn('[DLE] Scribe auto-trigger failed:', err?.message);
                            dedupWarning(
                                `Session Scribe auto-run failed: ${err?.message || 'unknown error'}.`,
                                'scribe_auto_trigger_fail',
                                { hint: 'Background scribe failure — manual /dle-scribe still works.' },
                            );
                        });
                    }
                }
            } catch (err) { console.warn('[DLE] Scribe render-handler failed:', err?.message); }

            // --- Auto Lorebook every N messages ---
            try {
                if (settings.enabled && settings.autoSuggestEnabled && settings.autoSuggestInterval > 0) {
                    setAutoSuggestMessageCount(autoSuggestMessageCount + 1);
                    if (autoSuggestMessageCount >= settings.autoSuggestInterval) {
                        setAutoSuggestMessageCount(0);
                        (async () => {
                            try {
                                const suggestions = await runAutoSuggest();
                                if (suggestions && suggestions.length > 0) await showSuggestionPopup(suggestions);
                            } catch (err) {
                                console.warn('[DLE] Auto-suggest auto-trigger failed:', err?.message);
                                // Same rationale as Scribe above: dedup'd toast so failures don't stack.
                                dedupWarning(
                                    `Auto Lorebook run failed: ${err?.message || 'unknown error'}.`,
                                    'autosuggest_auto_trigger_fail',
                                    { hint: 'Background auto-lorebook failure — manual /dle-newlore still works.' },
                                );
                            }
                        })();
                    }
                }
            } catch (err) { console.warn('[DLE] Auto-suggest render-handler failed:', err?.message); }
        });

        _registerEs(event_types.MESSAGE_SWIPED, (messageId) => {
            // BUG-296: bounds-check the messageId — ST can fire MESSAGE_SWIPED with a stale
            // index after a delete that coincided with a swipe navigation.
            const idx = Number(messageId);
            if (!Number.isInteger(idx) || idx < 0 || idx >= (chat?.length || 0)) return;
            const message = chat[idx];
            if (!message || message.is_user) return;

            // BUG-FIX-2: defensive — pipeline status from a prior in-flight generation must not linger.
            _removePipelineStatus();

            // perMessageActivity ON: keep dropdown data (replaced on next gen). OFF: clear it.
            if (!getSettings().librarianPerMessageActivity) {
                if (message.extra?.deeplore_tool_calls) {
                    delete message.extra.deeplore_tool_calls;
                    saveMetadataDebounced();
                }
            }
            // Dropdown DOM always cleared on swipe — the new swipe may not have tool calls.
            // (Data preservation, when applicable, is handled by the perMessageActivity branch above.)
            removeLibrarianDropdown(messageId);

            // BUG-290: anchored last-occurrence removal. Anchor `'\n' + notes` matches the
            // CHARACTER_MESSAGE_RENDERED append pattern; falling back to bare-string lastIndexOf
            // handles edge cases. Old String.replace() took the FIRST match and broke on
            // duplicate-note collisions across messages.
            if (message.extra?.deeplore_ai_notes) {
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata.deeplore_ai_notepad || '';
                const anchored = '\n' + notes;
                let updated = acc;
                const aIdx = acc.lastIndexOf(anchored);
                if (aIdx !== -1) {
                    updated = acc.slice(0, aIdx) + acc.slice(aIdx + anchored.length);
                } else {
                    const nIdx = acc.lastIndexOf(notes);
                    if (nIdx !== -1) updated = acc.slice(0, nIdx) + acc.slice(nIdx + notes.length);
                }
                chat_metadata.deeplore_ai_notepad = updated.replace(/\n{3,}/g, '\n\n').trim();
                delete message.extra.deeplore_ai_notes;
            }

            if (message.extra?.deeplore_sources) {
                delete message.extra.deeplore_sources;
                saveMetadataDebounced();
            }

            // BUG-294/300: rebuild chatInjectionCounts from the authoritative per-swipe map.
            // Prior-swipe injected keys are still tracked in perSwipeInjectedKeys; swiping to
            // a new (possibly un-generated) alternate must not leave those counts elevated.
            // Summing across each slot's CURRENT swipe_id yields the correct live state
            // regardless of swipe direction, regen, or in-flight pipeline interleaving.
            try {
                const rebuilt = new Map();
                for (let i = 0; i < chat.length; i++) {
                    const m = chat[i];
                    if (!m || m.is_user) continue;
                    const sKey = `${i}|${m.swipe_id ?? 0}`;
                    const keys = perSwipeInjectedKeys.get(sKey);
                    if (keys) {
                        for (const k of keys) rebuilt.set(k, (rebuilt.get(k) || 0) + 1);
                    }
                }
                setChatInjectionCounts(rebuilt);
                chat_metadata.deeplore_chat_counts = Object.fromEntries(rebuilt);
                saveMetadataDebounced();
            } catch (err) { console.warn('[DLE] MESSAGE_SWIPED count rebuild failed:', err?.message); }
        });

        // BUG-037: message-lifecycle events were previously ignored. Without these handlers,
        // per-message extras (deeplore_sources, deeplore_ai_notes, deeplore_tool_calls) and
        // the AI Notepad accumulator drift permanently on delete/edit/swipe-dismiss.
        const _cleanupMessageExtras = (messageId, { alsoAiNotes = true } = {}) => {
            const message = chat?.[messageId];
            if (!message) return;
            let dirty = false;
            if (message.extra?.deeplore_tool_calls) {
                delete message.extra.deeplore_tool_calls;
                dirty = true;
            }
            removeLibrarianDropdown(messageId);
            if (alsoAiNotes && message.extra?.deeplore_ai_notes) {
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata?.deeplore_ai_notepad || '';
                // BUG-290 anchored last-occurrence pattern; see MESSAGE_SWIPED handler.
                const anchored = '\n' + notes;
                let updated = acc;
                const aIdx = acc.lastIndexOf(anchored);
                if (aIdx !== -1) {
                    updated = acc.slice(0, aIdx) + acc.slice(aIdx + anchored.length);
                } else {
                    const nIdx = acc.lastIndexOf(notes);
                    if (nIdx !== -1) updated = acc.slice(0, nIdx) + acc.slice(nIdx + notes.length);
                }
                if (updated !== acc && chat_metadata) {
                    chat_metadata.deeplore_ai_notepad = updated.replace(/\n{3,}/g, '\n\n').trim();
                    dirty = true;
                }
                delete message.extra.deeplore_ai_notes;
                dirty = true;
            }
            if (message.extra?.deeplore_sources) {
                delete message.extra.deeplore_sources;
                dirty = true;
            }
            if (dirty) saveMetadataDebounced();
        };

        _registerEs(event_types.MESSAGE_SWIPE_DELETED, (payload) => {
            // ST emits `{ messageId, swipeId, newSwipeId }` (script.js: eventSource.emit).
            // Earlier code took `(messageId)` as a scalar — cleanup + reindex silently no-op'd.
            const messageId = (payload && typeof payload === 'object') ? Number(payload.messageId) : Number(payload);
            if (!Number.isInteger(messageId)) return;
            try { _cleanupMessageExtras(messageId); } catch (err) { console.warn('[DLE] MESSAGE_SWIPE_DELETED cleanup failed:', err.message); }
            // Reindex perSwipeInjectedKeys — `${messageId}|${swipeId}` keys pointing at
            // no-longer-existing swipe slots leak memory + persisted metadata bytes.
            // ST does NOT shift swipe_id on delete, so we only drop keys past the new swipes.length.
            try {
                const msg = chat?.[messageId];
                if (msg && Array.isArray(msg.swipes)) {
                    const prefix = `${messageId}|`;
                    let dirty = false;
                    for (const k of [...perSwipeInjectedKeys.keys()]) {
                        if (!k.startsWith(prefix)) continue;
                        const swipeId = parseInt(k.slice(prefix.length), 10);
                        if (!Number.isFinite(swipeId)) continue;
                        if (swipeId >= msg.swipes.length) {
                            perSwipeInjectedKeys.delete(k);
                            dirty = true;
                        }
                    }
                    if (dirty) {
                        chat_metadata.deeplore_swipe_injected_keys = Object.fromEntries(
                            [...perSwipeInjectedKeys.entries()].map(([k, v]) => [k, [...v]]),
                        );
                        saveMetadataDebounced();
                    }
                }
            } catch (err) { console.warn('[DLE] MESSAGE_SWIPE_DELETED reindex failed:', err?.message); }
        });

        // BUG-038: ST wipes chat_metadata itself on delete, but the Librarian session draft
        // lives in localStorage (librarian-session.js SESSION_STORAGE_KEY) and would otherwise
        // linger as an orphan pointing at a now-deleted chat.
        const _onChatDeleted = () => {
            try { clearLibrarianSessionState(); } catch (err) { console.warn('[DLE] CHAT_DELETED cleanup failed:', err.message); }
        };
        _registerEs(event_types.CHAT_DELETED, _onChatDeleted);
        _registerEs(event_types.GROUP_CHAT_DELETED, _onChatDeleted);

        // BUG-039: profile lifecycle. If a profile wired into one of DLE's six profile fields
        // (aiSearch / scribe / autoSuggest / aiNotepad / librarian / optimizeKeys) is deleted
        // or renamed, the stored profileId becomes a dangling reference. On delete: null any
        // profileId that no longer resolves and toast the user so they know to rebind.
        const _profileIdFields = [
            'aiSearchProfileId', 'scribeProfileId', 'autoSuggestProfileId',
            'aiNotepadProfileId', 'librarianProfileId', 'optimizeKeysProfileId',
        ];
        const _onProfileDeleted = async (deleted) => {
            try {
                const s = getSettings();
                const deletedId = deleted?.id || deleted?.profileId || deleted;
                if (!deletedId) return;
                let cleared = 0;
                for (const field of _profileIdFields) {
                    if (s[field] === deletedId) {
                        s[field] = '';
                        cleared++;
                    }
                }
                if (cleared > 0) {
                    invalidateSettingsCache();
                    try { saveSettingsDebounced(); } catch { /* no-op */ }
                    dedupWarning(
                        `A connection profile used by ${cleared} DLE feature${cleared === 1 ? '' : 's'} was deleted. Re-bind in DLE settings.`,
                        'profile_deleted',
                    );
                }
            } catch (err) { console.warn('[DLE] CONNECTION_PROFILE_DELETED cleanup failed:', err.message); }
        };
        const _onProfileUpdated = () => {
            try { invalidateSettingsCache(); } catch { /* no-op */ }
        };
        _registerEs(event_types.CONNECTION_PROFILE_DELETED, _onProfileDeleted);
        _registerEs(event_types.CONNECTION_PROFILE_UPDATED, _onProfileUpdated);

        // BUG-084: external mutations of extension_settings + saveSettingsDebounced() are
        // invisible to DLE. Invalidate on SETTINGS_UPDATED so the next getSettings() re-validates.
        _registerEs(event_types.SETTINGS_UPDATED, () => {
            try { invalidateSettingsCache(); } catch { /* no-op */ }
        });

        _registerEs(event_types.MESSAGE_EDITED, (messageId) => {
            // Edit preserves structural extras (sources, tool_calls) — the edit is about visible
            // prose, not what was consulted. Only AI Notepad extraction is invalidated since the
            // visible prose is what it was extracted from.
            try {
                const message = chat?.[messageId];
                if (!message) return;
                // Streaming-thrash guard: ST fires MESSAGE_EDITED per keystroke on some providers.
                // length + first/last char fingerprint is enough to detect real content change without
                // a full hash on every keystroke.
                const _mes = message.mes || '';
                const _newHash = `${_mes.length}:${_mes.charCodeAt(0) || 0}:${_mes.charCodeAt(_mes.length - 1) || 0}`;
                if (message.extra?.deeplore_last_edit_hash === _newHash) return;
                if (!message.extra) message.extra = {};
                message.extra.deeplore_last_edit_hash = _newHash;
                // Real content change — invalidate ai-search cache so next pipeline doesn't reuse
                // a match computed against the pre-edit chat line set.
                resetAiSearchCache();
                if (!message.extra?.deeplore_ai_notes) return;
                // BUG-AUDIT-H07: anchored last-occurrence removal (same pattern as BUG-290).
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata?.deeplore_ai_notepad || '';
                if (acc.includes(notes)) {
                    const anchored = '\n' + notes;
                    let updated = acc;
                    const aIdx = acc.lastIndexOf(anchored);
                    if (aIdx !== -1) {
                        updated = acc.slice(0, aIdx) + acc.slice(aIdx + anchored.length);
                    } else {
                        const nIdx = acc.lastIndexOf(notes);
                        if (nIdx !== -1) updated = acc.slice(0, nIdx) + acc.slice(nIdx + notes.length);
                    }
                    chat_metadata.deeplore_ai_notepad = updated.replace(/\n{3,}/g, '\n\n').trim();
                }
                delete message.extra.deeplore_ai_notes;
                saveMetadataDebounced();
            } catch (err) { console.warn('[DLE] MESSAGE_EDITED cleanup failed:', err.message); }
        });

        _registerEs(event_types.CHAT_CHANGED, () => {
            // Flush pending analytics BEFORE the chatEpoch bump invalidates the in-flight
            // pipeline's save path. Without this, the 1-4 generations since the last modulo-5
            // flush would vanish on chat switch.
            if (_analyticsPendingSave) {
                try {
                    invalidateSettingsCache();
                    saveSettingsDebounced();
                } catch { /* ignore */ }
                _analyticsPendingSave = false;
            }
            // Bump chatEpoch FIRST so any in-flight onGenerate sees the mismatch on its next epoch check.
            setChatEpoch(chatEpoch + 1);
            // Mark chat boundary in ring buffers so diagnostic exports are parseable.
            pushEvent('chat_changed', { chatEpoch: chatEpoch });
            try {
                consoleBuffer.push({ t: Date.now(), level: 'info', msg: `--- CHAT_CHANGED (epoch ${chatEpoch}) ---`, dle: true });
                networkBuffer.push({ t: Date.now(), kind: 'marker', url: 'CHAT_CHANGED', chatEpoch: chatEpoch });
            } catch { /* never block chat switch */ }
            _removePipelineStatus();

            // Release the lock + bump lockEpoch so the old pipeline's commit phase loses its guard.
            if (generationLock) {
                setGenerationLockEpoch(generationLockEpoch + 1);
                setPipelinePhase('idle');
                setGenerationLock(false);
            }

            // BUG-308: hydrate from chat_metadata so the "already scribed at N" guard
            // survives chat switches. Fall back to current chat.length on first visit.
            {
                const persistedLen = chat_metadata?.deeplore_lastScribeChatLength;
                setLastScribeChatLength(
                    Number.isFinite(persistedLen) ? persistedLen : (chat ? chat.length : 0),
                );
            }
            setLastScribeSummary(chat_metadata?.deeplore_lastScribeSummary || '');
            // BUG-275: do NOT reset scribeInProgress. The in-flight scribe owns its flag and
            // releases it in its own finally (scribe.js). Resetting here races with scribe A
            // mid-await and lets scribe B start concurrently on re-entry to chat A → two
            // writeNotes + two reindexes racing.
            // BUG-061: notepad extract lock IS reset here so the new chat isn't blocked by a
            // stale in-flight extract. The in-flight extract's post-await epoch guard still
            // prevents it from writing to the new chat's metadata.
            setNotepadExtractInProgress(false);
            // aiSearchStats is intentionally NOT reset — it's session-cumulative.
            injectionHistory.clear();
            cooldownTracker.clear();
            decayTracker.clear();
            consecutiveInjections.clear();
            // BUG-072: hydrate per-chat injection counts and prune orphaned keys (entries
            // deleted/renamed in the vault). Only prune when vaultIndex is populated — during
            // cold start CHAT_CHANGED can fire before the index is built, and pruning against
            // an empty index would wipe all legitimate counts.
            const savedCounts = chat_metadata?.deeplore_chat_counts;
            let nextCounts;
            if (savedCounts && vaultIndex.length > 0) {
                const validKeys = new Set(vaultIndex.map(e => trackerKey(e)));
                nextCounts = new Map();
                for (const [k, v] of Object.entries(savedCounts)) {
                    if (validKeys.has(k)) nextCounts.set(k, v);
                }
                // Persist pruned map so orphans don't re-hydrate next reload.
                if (nextCounts.size !== Object.keys(savedCounts).length) {
                    chat_metadata.deeplore_chat_counts = Object.fromEntries(nextCounts);
                    saveMetadataDebounced();
                }
            } else {
                nextCounts = savedCounts ? new Map(Object.entries(savedCounts)) : new Map();
            }
            setChatInjectionCounts(nextCounts);

            // BUG-074: validate deeplore_folder_filter against folderList. Stale folder names
            // (post-rename/delete) would otherwise silently filter out every entry. Only prune
            // when folderList is populated — same cold-start guard as BUG-072 above.
            if (Array.isArray(chat_metadata?.deeplore_folder_filter) && folderList.length > 0) {
                const validFolders = new Set(folderList.map(f => f.path));
                const pruned = chat_metadata.deeplore_folder_filter.filter(f => validFolders.has(f));
                if (pruned.length !== chat_metadata.deeplore_folder_filter.length) {
                    chat_metadata.deeplore_folder_filter = pruned.length > 0 ? pruned : null;
                    saveMetadataDebounced();
                }
            }
            // BUG-293: hydrate per-swipe injected-keys map from metadata so swipe rollback works
            // across reloads. On-disk shape: { [swipeKey]: trackerKey[] }.
            const savedSwipeKeys = chat_metadata?.deeplore_swipe_injected_keys;
            if (savedSwipeKeys && typeof savedSwipeKeys === 'object') {
                const m = new Map();
                for (const [k, arr] of Object.entries(savedSwipeKeys)) {
                    if (Array.isArray(arr)) m.set(k, new Set(arr));
                }
                setPerSwipeInjectedKeys(m);
            } else {
                setPerSwipeInjectedKeys(new Map());
            }
            setLastGenerationTrackerSnapshot(null);
            setGenerationCount(0);
            setLastIndexGenerationCount(0);
            setLastInjectionEpoch(-1);
            setLastWarningRatio(0);
            resetAiSearchCache();
            resetAiThrottle();
            setAutoSuggestMessageCount(0);
            setLastPipelineTrace(null);
            setLastInjectionSources(null);
            setPreviousSources(null);
            resetCartographer();

            // Librarian: hydrate gaps + reset counters. normalizeLoreGap collapses legacy v1
            // statuses (acknowledged / in_progress / rejected) → v2 set (pending ↔ written).
            const savedGaps = chat_metadata?.deeplore_lore_gaps;
            setLoreGaps(savedGaps ? savedGaps.map(normalizeLoreGap) : []);
            setLoreGapSearchCount(0);
            setLibrarianChatStats({ searchCalls: 0, flagCalls: 0, estimatedExtraTokens: 0 });
            clearSessionActivityLog();

            resetDrawerState();
            notifyPipelineComplete();
            notifyGatingChanged();

            // Re-register PM entries for the new active character (prompt_list mode).
            if (getSettings().injectionMode === 'prompt_list' && promptManager?.activeCharacter) {
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad'];
                const pmNames = { [`${PROMPT_TAG_PREFIX}constants`]: 'DLE Constants', [`${PROMPT_TAG_PREFIX}lore`]: 'DLE Lore Entries', 'deeplore_notebook': 'DLE Author\'s Notebook', 'deeplore_ai_notepad': 'DLE AI Notepad' };
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: pmNames[id] || id, content: '', system_prompt: true,
                            role: 'system', marker: false, enabled: true, extension: true,
                        }, id);
                    } else {
                        if (!existing.role) existing.role = 'system';
                        if (!existing.extension) existing.extension = true;
                        const friendlyName = pmNames[id];
                        if (friendlyName && existing.name !== friendlyName) existing.name = friendlyName;
                    }
                    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                    if (order && !order.find(e => e.identifier === id)) {
                        const anchorIdx = order.findIndex(e => e.identifier === 'main' || e.identifier === 'chatHistory');
                        if (anchorIdx >= 0) {
                            order.splice(anchorIdx + 1, 0, { identifier: id, enabled: true });
                        } else {
                            order.push({ identifier: id, enabled: true });
                        }
                    }
                }
            }

            // Chat load: migrate stale data → inject UI, in that order.
            // Migration MUST precede Cartographer button injection — old chats may have
            // deeplore_sources stuck on empty intermediate messages (predates the guard).
            // tool_invocations also need migrating to deeplore_tool_calls on the correct reply.
            // BUG-287: tag the retry chain with current chatEpoch so a second CHAT_CHANGED
            // (rapid switching) cancels a pending retry instead of injecting into the wrong chat.
            const injectEpoch = chatEpoch;
            const injectAllChatLoadUI = (attempt = 0) => {
                if (injectEpoch !== chatEpoch) return;
                const chatEl = document.getElementById('chat');
                if (!chatEl?.children.length && attempt < 5) {
                    setTimeout(() => injectAllChatLoadUI(attempt + 1), 200 * (attempt + 1));
                    return;
                }
                requestAnimationFrame(async () => { if (injectEpoch !== chatEpoch) return; try {
                    const settings = getSettings();
                    const start = Math.max(0, chat.length - 50);
                    let needsSave = false;

                    // BUG-126: deeplore_migration_v2 sentinel skips re-running migrations on every chat load.
                    const migrationDone = chat_metadata?.deeplore_migration_v2;

                    // ── Pass 1: tool_invocations → deeplore_tool_calls ──
                    if (settings.librarianEnabled && !migrationDone) {
                        const pendingMigration = [];
                        for (let i = start; i < chat.length; i++) {
                            const m = chat[i];
                            if (m?.extra?.tool_invocations) {
                                for (const inv of m.extra.tool_invocations) {
                                    if (inv.name === 'dle_search_lore' || inv.name === 'dle_flag_lore') {
                                        try {
                                            const params = JSON.parse(inv.parameters || '{}');
                                            const isSearch = inv.name === 'dle_search_lore';
                                            let resultTitles = [];
                                            let resultCount = 0;
                                            if (isSearch && inv.result && !inv.result.startsWith('No entries')) {
                                                const titleMatches = inv.result.match(/^## (.+)$/gm);
                                                resultTitles = titleMatches ? titleMatches.map(t => t.replace('## ', '')) : [];
                                                resultCount = resultTitles.length;
                                            }
                                            pendingMigration.push({
                                                type: isSearch ? 'search' : 'flag',
                                                query: isSearch ? params.query : params.title,
                                                resultCount,
                                                resultTitles,
                                                urgency: params.urgency || 'medium',
                                                tokens: 0,
                                                timestamp: 0,
                                            });
                                        } catch { /* skip malformed */ }
                                    }
                                }
                                continue;
                            }
                            if (pendingMigration.length > 0 && !m.is_user && !m.is_system && m.mes?.trim()) {
                                if (!m.extra?.deeplore_tool_calls?.length) {
                                    m.extra = m.extra || {};
                                    m.extra.deeplore_tool_calls = [...pendingMigration];
                                    needsSave = true;
                                }
                                pendingMigration.length = 0;
                            }
                        }
                    }

                    // ── Pass 2: move deeplore_sources from empty intermediate messages → correct reply ──
                    for (let i = migrationDone ? chat.length : start; i < chat.length; i++) {
                        const m = chat[i];
                        if (!m.is_user && !m.is_system && !m.mes?.trim() && m.extra?.deeplore_sources) {
                            for (let j = i + 1; j < chat.length; j++) {
                                const target = chat[j];
                                if (target && !target.is_user && !target.is_system && target.mes?.trim()) {
                                    if (!target.extra?.deeplore_sources) {
                                        target.extra = target.extra || {};
                                        target.extra.deeplore_sources = m.extra.deeplore_sources;
                                    }
                                    break;
                                }
                            }
                            delete m.extra.deeplore_sources;
                            needsSave = true;
                        }
                    }

                    if (settings.showLoreSources) {
                        for (let i = start; i < chat.length; i++) {
                            if (chat[i]?.extra?.deeplore_sources) {
                                injectSourcesButton(i);
                            }
                        }
                    }

                    if (settings.librarianEnabled && settings.librarianShowToolCalls) {
                        for (let i = start; i < chat.length; i++) {
                            if (chat[i]?.extra?.deeplore_tool_calls?.length) {
                                injectLibrarianDropdown(i, chat[i].extra.deeplore_tool_calls);
                            }
                        }
                    }

                    // BUG-126: stamp completion sentinel so future CHAT_CHANGED skips both passes.
                    if (needsSave && !migrationDone) {
                        chat_metadata.deeplore_migration_v2 = true;
                    }
                    if (needsSave) {
                        // Persist message extras + sentinel atomically. saveMetadataDebounced
                        // is debounced (~1s) — a chat switch before the timer fires drops the
                        // save AND the sentinel, so we'd lose tool_calls migration on every
                        // reload until a non-debounced save happens. saveChatConditional is
                        // immediate; a re-check of injectEpoch guards against stale writes.
                        if (injectEpoch !== chatEpoch) return;
                        try { await saveChatConditional(); }
                        catch (saveErr) { console.warn('[DLE] Chat load migration save failed:', saveErr?.message); }
                    }
                } catch (err) { console.error('[DLE] Chat load UI injection error:', err); }
                });
            };
            setTimeout(() => { if (injectEpoch === chatEpoch) injectAllChatLoadUI(); }, 100);
        });

        // BUG-063: page-unload teardown releases tracked listeners + drawer DOM on reload.
        _dleBeforeUnloadHandler = () => {
            // Flush pending analytics so the 1-4 generations since the last modulo-5 save
            // are persisted on tab close / reload.
            if (_analyticsPendingSave) {
                try {
                    invalidateSettingsCache();
                    saveSettingsDebounced();
                } catch { /* ignore */ }
                _analyticsPendingSave = false;
            }
            try { _teardownDleExtension(); } catch { /* ignore */ }
        };
        window.addEventListener('beforeunload', _dleBeforeUnloadHandler);

        // Developer debug namespace: __DLE_DEBUG.state / .trace / .buffers in the browser console.
        // Gated on debugMode — same-page scripts (extensions, devtools snippets) shouldn't get a
        // live vault reference unless the user opted in. State getters return clones so external
        // mutation through the shallow Object.freeze can't reach back into module state.
        // PII safety: turning debugMode off drops captured prompts so re-enabling doesn't expose them.
        function installDebugNamespace() {
            if (!getSettings().debugMode) {
                try { delete globalThis.__DLE_DEBUG; } catch { /* ignore */ }
                try { aiPromptBuffer.clear(); } catch { /* ignore */ }
                return;
            }
            globalThis.__DLE_DEBUG = Object.freeze({
                get state() {
                    return {
                        vaultIndex: vaultIndex.slice(),
                        generationCount, chatEpoch, generationLock,
                        generationLockEpoch, indexing, indexEverLoaded,
                        cooldownTracker: Object.fromEntries(cooldownTracker),
                        injectionHistory: Object.fromEntries(injectionHistory),
                        decayTracker: Object.fromEntries(decayTracker),
                        fieldDefinitions: fieldDefinitions.slice(),
                    };
                },
                get trace() { return lastPipelineTrace; },
                get buffers() {
                    return {
                        console: consoleBuffer.drain(),
                        network: networkBuffer.drain(),
                        errors: errorBuffer.drain(),
                        aiCalls: aiCallBuffer.drain(),
                        // PII-sensitive — only populated when debugMode=true. Local inspection only.
                        aiPrompts: aiPromptBuffer.drain(),
                        events: eventBuffer.drain(),
                        generations: generationBuffer.drain(),
                    };
                },
            });
        }
        _debugNamespaceUnsub = onDebugModeChanged(installDebugNamespace);
        installDebugNamespace();

        _dleInitCount++;
        pushEvent('init', { initCount: _dleInitCount, vaultCount: (getSettings().vaults || []).filter(v => v.enabled).length });
        console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
        toastr.error('DeepLore Enhanced failed to initialize. Check the browser console (F12) for details.', 'DLE Error', { timeOut: 0 });
    }
});
