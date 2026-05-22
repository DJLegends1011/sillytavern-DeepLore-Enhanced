/**
 * DeepLore Enhanced — Agentic Loop API Layer
 * Wraps CMRS for tool-calling. 4 provider formats: Claude, Google
 * (Gemini/Vertex), OpenAI-compatible, Cohere. Proxy mode hits the Anthropic
 * Messages API directly via the ST CORS bridge.
 */
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { oai_settings } from '../../../../../openai.js';
import { main_api } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { resolveConnectionConfig } from '../../settings.js';
import { validateProxyUrl } from '../ai/proxy-api.js';
import { abortWith } from '../diagnostics/interceptors.js';
import { isUnderlyingClaudeModel } from './agentic-api-pure.js';

// ════════════════════════════════════════════════════════════════════════════
// Provider Detection
// ════════════════════════════════════════════════════════════════════════════

/** Sources that don't support tool calling. */
const NO_TOOLS_SOURCES = new Set([
    'ai21', 'perplexity', 'nanogpt', 'pollinations', 'moonshot',
]);

/**
 * Reasoning-only models that silently fail when sent `tools` — no tool_calls,
 * and reasoning narrative leaks as prose. ST has no per-model gate (verified
 * against ST staging tool-calling.js, 2026-04-24); DLE must maintain this list.
 * Source-prefixed entries cover OpenRouter relays.
 *
 * BUG-AUDIT (Fix 29): narrowed from `^o[1-9]` to `^o1`. o3, o3-mini, o4-mini
 * all support function calling per current docs — the broad pattern was
 * over-blocking. o1 alone is the genuine reasoning-only model.
 */
const NO_TOOLS_MODELS = [
    /^deepseek-reasoner/i,
    /^deepseek\/.*r1/i,
    /-r1(-|$|:)/i,
    /^o1(-|$)/i,
    /^openai\/o1/i,
    /^anthropic\/.*-thinking/i,
];

export function isReasoningOnlyModel(model) {
    if (!model || typeof model !== 'string') return false;
    return NO_TOOLS_MODELS.some(re => re.test(model));
}

/**
 * Resolve the active model id for the Librarian connection.
 * Proxy: configured model. Profile: CMRS profile model first (most accurate),
 * then `oai_settings.{source}_model` fallback.
 *
 * Reads `resolveConnectionConfig('librarian').profileId` — Librarian's *configured*
 * profile, not ST's globally-active profile. Using getActiveProfileId() here would
 * silently mis-resolve the model whenever the user's active profile differs from
 * the one wired into Librarian (the same root cause as #27 sym 2).
 */
export function getResolvedModel() {
    const connConfig = resolveConnectionConfig('librarian');
    if (connConfig.mode === 'proxy') {
        return connConfig.model || '';
    }
    try {
        const profileId = connConfig.profileId;
        if (profileId) {
            const profile = ConnectionManagerRequestService.getProfile?.(profileId);
            if (profile?.model) return profile.model;
        }
    } catch { /* noop */ }
    const source = oai_settings?.chat_completion_source;
    if (source) return oai_settings[`${source}_model`] || '';
    return '';
}

/** @returns {'proxy'|'profile'|'inherit'} */
function getLibrarianMode() {
    return resolveConnectionConfig('librarian').mode;
}

/**
 * Proxy: Anthropic Messages API, always supports tools. Profile: gates on ST
 * source AND resolved model — reasoner-only models silently fail tool calls
 * and leak reasoning as prose.
 */
export function isToolCallingSupported(model) {
    // BUG-AUDIT (Fix 1): resolved mode gates inherit→profile too. Reach into
    // context directly rather than calling getActiveProfileId, which throws
    // when no profile is selected — this gate must return false, not raise.
    const resolved = resolveConnectionConfig('librarian');
    if (resolved.mode === 'proxy') {
        if (!resolved.proxyUrl || !resolved.model) return false;
        if (isReasoningOnlyModel(resolved.model)) return false;
        return true;
    }
    if (main_api !== 'openai') return false;
    const source = oai_settings?.chat_completion_source;
    if (!source) return false;
    if (NO_TOOLS_SOURCES.has(source)) return false;
    if (resolved.mode === 'profile') {
        const ctx = getContext();
        if (!ctx?.extensionSettings?.connectionManager?.selectedProfile) return false;
    }
    const resolvedModel = model || getResolvedModel();
    if (resolvedModel && isReasoningOnlyModel(resolvedModel)) return false;
    return true;
}

/** Proxy mode is always Claude format. */
export function getProviderFormat() {
    if (getLibrarianMode() === 'proxy') return 'claude';
    const source = oai_settings?.chat_completion_source;
    if (source === 'claude') return 'claude';
    if (source === 'makersuite' || source === 'vertexai') return 'google';
    return 'openai';
}

/**
 * Detect Claude regardless of source — covers OpenRouter relays
 * (`anthropic/claude-*`) that source-only `getProviderFormat()` misses. Gates
 * Claude-specific mitigations (thinking-vs-tool_choice 400) without changing
 * the message parser, which must stay OpenAI-shape for OR responses.
 */
export function isUnderlyingClaude(model) {
    // Delegate the regex contract to the pure helper; only the ST-context
    // fallback (getResolvedModel) lives here.
    return isUnderlyingClaudeModel(model || getResolvedModel());
}

/**
 * BUG-AUDIT (Fix 33): always honor librarianSessionMaxTokens (default 4096).
 * Profile mode previously read oai_settings.openai_max_tokens — the user's main
 * chat preset, often a low fallback like 300 — making the dedicated Librarian
 * budget dead. CMRS accepts the third argument as a real override.
 */
export function getActiveMaxTokens() {
    return resolveConnectionConfig('librarian').maxTokens || 4096;
}

/**
 * Profile mode only — proxy mode bypasses CMRS.
 * @throws {Error} If no profile is selected
 */
export function getActiveProfileId() {
    const ctx = getContext();
    const profileId = ctx.extensionSettings?.connectionManager?.selectedProfile;
    if (!profileId) {
        throw new Error('No active connection profile selected in SillyTavern. Select one in the Connection Manager.');
    }
    return profileId;
}

// ════════════════════════════════════════════════════════════════════════════
// API Call
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Array<object>} tools - [{type:'function', function:{...}}]
 * @returns {Array<object>} [{name, description, input_schema}]
 */
function toAnthropicTools(tools) {
    return tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}

function toAnthropicToolChoice(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') {
        const map = { auto: 'auto', required: 'any', none: 'none' };
        return { type: map[toolChoice] || 'auto' };
    }
    return toolChoice;
}

/**
 * Direct Anthropic Messages API call via CORS bridge. Used in proxy mode.
 * Tools arrive in OpenAI function-calling format; converted on the way out.
 * @returns {Promise<object>} Raw Anthropic API response
 */
async function callWithToolsViaProxy(connConfig, messages, tools, toolChoice, maxTokens, signal) {
    const { proxyUrl, model, timeout = 120000 } = connConfig;
    validateProxyUrl(proxyUrl);

    if (!model) throw new Error('Librarian proxy mode requires a model name. Set it in DLE Librarian settings.');

    let systemContent = [];
    const apiMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemContent.push({ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } });
        } else {
            apiMessages.push(msg);
        }
    }

    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => abortWith(controller, 'agentic-api:timeout'), timeout);
    let onExternalAbort = null;

    if (signal) {
        if (signal.aborted) {
            const reason = signal.reason?.message || 'agentic-api:external_pre_aborted';
            abortWith(controller, reason);
        } else {
            onExternalAbort = () => {
                const reason = signal.reason?.message || 'agentic-api:external';
                abortWith(controller, reason);
            };
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    const body = {
        model,
        max_tokens: maxTokens,
        ...(systemContent.length > 0 && { system: systemContent }),
        messages: apiMessages,
        tools: toAnthropicTools(tools),
    };
    const anthropicToolChoice = toAnthropicToolChoice(toolChoice);
    if (anthropicToolChoice) body.tool_choice = anthropicToolChoice;

    try {
        const response = await fetch(corsProxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            if (response.status === 404 && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern CORS proxy is not enabled. Set enableCorsProxy: true in config.yaml, or use a Connection Profile instead of Custom Proxy mode.');
            }
            const safeText = text.substring(0, 200)
                .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
                .replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***');
            throw new Error(`Proxy returned HTTP ${response.status}: ${safeText}`);
        }

        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse proxy response as JSON: ${e.message}`);
        }
        if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        }

        // Return raw Anthropic response — parseToolCalls/getTextContent/getUsage handle Claude format
        return parsed;
    } catch (err) {
        const controllerReason = controller.signal.reason?.message || null;
        const externalReason = signal?.reason?.message || null;
        const abortReason = controllerReason || externalReason || null;
        if (err.name === 'AbortError') {
            if (signal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                abortErr.abortReason = abortReason;
                throw abortErr;
            }
            const timeoutErr = new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`, { cause: err });
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            timeoutErr.abortReason = abortReason;
            throw timeoutErr;
        }
        if (abortReason) err.abortReason = abortReason;
        throw err;
    } finally {
        if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
        clearTimeout(timer);
    }
}

/**
 * Routes to proxy or CMRS based on Librarian config.
 * @returns {Promise<object>} Raw API response (extractData: false)
 */
export async function callWithTools(messages, tools, toolChoice, maxTokens, signal) {
    const connConfig = resolveConnectionConfig('librarian');
    if (connConfig.mode === 'proxy') {
        return callWithToolsViaProxy(connConfig, messages, tools, toolChoice, maxTokens, signal);
    }

    // #27 sym 2: Librarian must use its own configured profile, not ST's globally-active one.
    // No silent fallback — if Librarian's profile (or inherited aiSearch profile) is unset,
    // the user should be told to set it rather than silently inheriting whichever profile
    // happens to be active when Librarian runs.
    if (!connConfig.profileId) {
        throw new Error('Librarian needs a profile in AI Connections settings.');
    }

    const format = getProviderFormat();

    // Normalize tool_choice per provider — ST wraps differently per backend:
    //   Claude backend: `{ type: request.body.tool_choice }` — needs Claude type strings.
    //   Google backend (Fix 32): ST's chat-completions.js translates string
    //     'auto'/'required'/'none' to body.toolConfig.functionCallingConfig with the
    //     correct Gemini AUTO/ANY/NONE mapping. The adapter's `typeof === 'string'`
    //     check rejects object form — pre-translating to {mode:'AUTO'} bypasses the
    //     adapter and makes required/none silently degrade to AUTO. Pass raw string.
    //   OpenAI/Cohere: pass through.
    let normalizedToolChoice = toolChoice;
    if (typeof toolChoice === 'string') {
        if (format === 'claude') {
            const claudeModeMap = { auto: 'auto', required: 'any', none: 'none' };
            normalizedToolChoice = claudeModeMap[toolChoice] || 'auto';
        }
    }

    const overridePayload = {
        tools,
        ...(normalizedToolChoice != null && { tool_choice: normalizedToolChoice }),
    };

    // Anthropic rejects forced tool_choice when extended thinking is on
    // ("Thinking may not be enabled when tool_choice forces tool use." — 400).
    // Even with tool_choice='auto', ST may translate json_schema from the active
    // preset into a forced choice on Claude. reasoning_effort='auto' makes
    // calculateClaudeBudgetTokens (prompt-converters.js) return null, so ST does
    // NOT add requestBody.thinking — sidesteps the conflict. Per-request only.
    //
    // OR-Claude path: source is openrouter (format='openai'), but the underlying
    // model is Claude and OR forwards reasoning.effort to Anthropic. Without the
    // second arm, OR users on anthropic/claude-* hit the same 400. Parser stays
    // OpenAI-shape because OR returns OpenAI-shape regardless of upstream.
    if (format === 'claude' || isUnderlyingClaude()) {
        overridePayload.reasoning_effort = 'auto';
    }

    let result;
    try {
        result = await ConnectionManagerRequestService.sendRequest(
            connConfig.profileId,
            messages,
            maxTokens,
            {
                stream: false,
                signal,
                extractData: false,
                includePreset: true,
                includeInstruct: true,
            },
            overridePayload,
        );
    } catch (err) {
        // Tag Gemini safety blocks distinctly. Without typed throw, callers
        // show a generic toast that hides the actionable cause (relax safety,
        // rephrase). Also catches "Candidate text empty" — Gemini returning
        // only thought parts deserves distinct guidance.
        //
        // BUG-AUDIT (Fix 31): walk the cause chain. CMRS wraps backend failures
        // as `new Error('API request failed', { cause: realError })`, so reading
        // err.message alone always gets "API request failed" and the regex never
        // matches. Provider detail lives in err.cause. Bounded depth guards cycles.
        const messages = [];
        let cur = err;
        let depth = 0;
        while (cur && depth++ < 10) {
            if (cur.message) messages.push(String(cur.message));
            cur = cur.cause;
        }
        const combined = messages.join(' | ');
        if (/blocked|SAFETY|RECITATION|promptFeedback|Candidate text empty/i.test(combined)) {
            const tagged = new Error(messages[0] || 'Safety block');
            tagged.name = 'SafetyBlockError';
            tagged.cause = err;
            throw tagged;
        }
        throw err;
    }

    return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Response Parsing (replicates ST's private ToolManager.#getToolCallsFromData)
// ════════════════════════════════════════════════════════════════════════════

/** Falls back on malformed JSON. */
function safeParseArgs(args, fallbackInput) {
    if (typeof args === 'string') {
        try { return JSON.parse(args); }
        catch { console.warn('[DLE] Malformed tool call arguments, skipping:', args.slice(0, 200)); }
    }
    return args || fallbackInput || {};
}

/**
 * Normalizes 4 provider formats to [{id, name, input}].
 */
export function parseToolCalls(data) {
    if (!data) return [];

    // 1. Claude: content[].type === 'tool_use'
    if (Array.isArray(data.content)) {
        const toolUses = data.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
            return toolUses.map(t => ({
                id: t.id,
                name: t.name,
                input: t.input || {},
            }));
        }
    }

    // 2. Google Gemini/Vertex: responseContent.parts[].functionCall
    // Stamp synthetic ID onto the raw part so buildAssistantMessage can reuse it
    // for OpenAI-shape `tool_calls[].id`. Closes the round-trip: buildToolResults
    // emits tool_call_id matching that id, and ST's convertGooglePrompt.toolNameMap
    // resolves the function name from the id on the next turn.
    if (data.responseContent?.parts) {
        const functionCalls = data.responseContent.parts.filter(p => p.functionCall);
        if (functionCalls.length > 0) {
            return functionCalls.map(p => {
                const id = p._dleSyntheticId || `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                p._dleSyntheticId = id;
                return { id, name: p.functionCall.name, input: p.functionCall.args || {} };
            });
        }
    }

    // 3. OpenAI-compatible
    if (data.choices?.[0]?.message?.tool_calls) {
        return data.choices[0].message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseArgs(tc.function?.arguments, tc.input),
        }));
    }

    // 4. Cohere
    if (data.message?.tool_calls) {
        return data.message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseArgs(tc.function?.arguments, tc.input),
        }));
    }

    return [];
}

/**
 * Defensive second pass for partial-reasoning models that still emit
 * <think>...</think> alongside tool use (Claude 3.7+, deepseek-chat with
 * thinking on, GLM-4.6). Pure reasoning-only models are gated upstream.
 */
function stripReasoningTags(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
}

/**
 * Filters Gemini `p.thought=true` parts (2.5/3 reasoning blocks) and strips
 * <think> tags from prose.
 */
export function getTextContent(data) {
    if (!data) return '';

    let text = '';

    if (Array.isArray(data.content)) {
        // Claude
        const textBlocks = data.content.filter(b => b.type === 'text');
        if (textBlocks.length > 0) text = textBlocks.map(b => b.text).join('');
    }
    else if (data.responseContent?.parts) {
        // Google — drop thought parts so reasoning doesn't leak.
        const textParts = data.responseContent.parts.filter(p => p.text != null && p.thought !== true);
        if (textParts.length > 0) text = textParts.map(p => p.text).join('');
    }
    else if (data.choices?.[0]?.message?.content != null) {
        text = data.choices[0].message.content;
    }
    else if (data.message?.content?.[0]?.text != null) {
        text = data.message.content[0].text;
    }

    return stripReasoningTags(text);
}

export function getUsage(data) {
    if (!data) return { input_tokens: 0, output_tokens: 0 };

    const u = data.usage || data.usageMetadata || {};
    return {
        input_tokens: u.input_tokens || u.prompt_tokens || u.promptTokenCount || 0,
        output_tokens: u.output_tokens || u.completion_tokens || u.candidatesTokenCount || 0,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Message Building (provider-native formats for multi-turn tool conversations)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Preserves provider-native format so the API sees its own output shape on
 * the next turn.
 */
export function buildAssistantMessage(data) {
    const format = getProviderFormat();

    if (format === 'claude') {
        return { role: 'assistant', content: data.content };
    }

    if (format === 'google') {
        // Emit OpenAI shape — convertGooglePrompt only reads message.content
        // and silently drops native {role:'model', parts:[]} (verified ST
        // staging prompt-converters.js, 2026-04-24). Without this, every
        // assistant turn after the first becomes parts:[{text:''}], breaking
        // multi-turn tool loops on Gemini entirely.
        const parts = data.responseContent?.parts || [];
        const textParts = parts.filter(p => typeof p.text === 'string' && p.thought !== true);
        const fnParts = parts.filter(p => p.functionCall);
        const result = { role: 'assistant' };
        if (textParts.length > 0) result.content = textParts.map(p => p.text).join('\n\n');
        if (fnParts.length > 0) {
            result.tool_calls = fnParts.map((p, i) => {
                // Reuse parseToolCalls's synthetic id so buildToolResults's
                // tool_call_id matches on the next turn.
                const id = p._dleSyntheticId || `gemini-${Date.now()}-${i}`;
                return {
                    id,
                    type: 'function',
                    function: {
                        name: p.functionCall.name,
                        arguments: JSON.stringify(p.functionCall.args || {}),
                    },
                };
            });
        }
        return result;
    }

    // OpenAI / Cohere
    const msg = data.choices?.[0]?.message || data.message;
    const result = { role: 'assistant' };
    if (msg?.content) result.content = msg.content;
    if (msg?.tool_calls) result.tool_calls = msg.tool_calls;
    return result;
}

/**
 * C4: Claude requires all tool_result blocks in ONE user message.
 * @returns {object|Array<object>} Message(s) to append
 */
export function buildToolResults(results) {
    const format = getProviderFormat();

    if (format === 'claude') {
        return {
            role: 'user',
            content: results.map(r => ({
                type: 'tool_result',
                tool_use_id: r.id,
                content: r.result,
            })),
        };
    }

    if (format === 'google') {
        // OpenAI shape — matches the google branch of buildAssistantMessage.
        // ST's convertGooglePrompt resolves tool_call_id → function name via
        // its toolNameMap built from the prior assistant turn's tool_calls.
        return results.map(r => ({
            role: 'tool',
            tool_call_id: r.id,
            content: r.result,
        }));
    }

    return results.map(r => ({
        role: 'tool',
        tool_call_id: r.id,
        content: r.result,
    }));
}
