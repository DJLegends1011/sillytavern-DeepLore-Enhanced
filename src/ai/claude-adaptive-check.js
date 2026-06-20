/**
 * DeepLore — Claude Adaptive-Thinking Misconfiguration Detector
 *
 * Claude opus-4-6 / sonnet-4-6 use adaptive thinking. ST's chat-completions path
 * requires `reasoning_effort` set to low/medium/high on the OpenAI completion
 * preset bound to a CM profile — "auto" / undefined → 400 at request time.
 *
 * Single shape consumed by all UI surfaces (toast, banner, drawer chip, wizard
 * inline error, error rewriter). We warn, never override the user's setting.
 */

export const CLAUDE_ADAPTIVE_REGEX = /^claude-(opus-4-6|sonnet-4-6)/i;

const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * @param {object} [opts.freshPreset] - BUG-397: pre-read preset to skip the JIT
 *   lookup on hot paths. Omit and we re-read JIT from getPresetManager('openai').
 * @returns {{bad: boolean, reason?: string, profileName?: string, modelName?: string, presetName?: string}}
 */
export function detectClaudeAdaptiveIssue(profileId, modelOverride, opts = {}) {
    try {
        if (!profileId) return { bad: false };

        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        if (!ctx) return { bad: false };

        const cmrs = ctx.ConnectionManagerRequestService;
        const profile = cmrs?.getProfile?.(profileId);
        if (!profile) return { bad: false };

        // Native Anthropic only — OpenRouter / custom wrappers take different paths.
        if (profile.api !== 'claude') return { bad: false };

        const model = (modelOverride && modelOverride.trim()) || profile.model || '';
        if (!CLAUDE_ADAPTIVE_REGEX.test(model)) return { bad: false };

        const presetName = profile.preset;
        if (!presetName) {
            return {
                bad: true,
                reason: 'no_preset',
                profileName: profile.name || profileId,
                modelName: model,
                presetName: '(none)',
            };
        }

        // BUG-397: always re-read JIT, never memoize across calls.
        const preset = opts.freshPreset
            || ctx.getPresetManager?.('openai')?.getCompletionPresetByName?.(presetName);
        const effort = preset?.reasoning_effort;

        if (!effort || !VALID_EFFORTS.has(String(effort).toLowerCase())) {
            return {
                bad: true,
                reason: effort ? 'auto' : 'unset',
                profileName: profile.name || profileId,
                modelName: model,
                presetName,
            };
        }

        return { bad: false };
    } catch (err) {
        // Must never throw — runs from many surfaces.
        if (typeof console !== 'undefined') console.debug('[DLE] claude-adaptive-check error:', err);
        return { bad: false };
    }
}

/**
 * @param {object} detail - detectClaudeAdaptiveIssue result with bad===true.
 * @param {'toast'|'banner'|'wizard'|'error'|'chip'} surface
 */
export function buildClaudeAdaptiveMessage(detail, surface = 'toast') {
    const { profileName = '?', modelName = '?', presetName = '?' } = detail || {};
    const path = `Connection Manager → edit preset "${presetName}" → Reasoning Effort → Low / Medium / High`;

    if (surface === 'chip') return `${modelName} needs Reasoning Effort set`;
    if (surface === 'error') {
        return `Claude ${modelName} requires reasoning_effort=low|medium|high (auto/unset is rejected). Open ${path}.`;
    }
    if (surface === 'wizard') {
        return `Heads up: profile "${profileName}" uses ${modelName}, which is an adaptive-thinking model. Its bound completion preset "${presetName}" has reasoning_effort unset or "auto" — SillyTavern will reject every request with a 400 error. Fix it in ${path}, or pick a different model. If you're using a proxy that handles this differently, ignore this warning.`;
    }
    if (surface === 'banner') {
        return `Profile "${profileName}" + ${modelName}: completion preset "${presetName}" needs reasoning_effort set to Low, Medium, or High. ${path}.`;
    }
    return `DeepLore: ${modelName} on profile "${profileName}" will fail — set reasoning_effort on preset "${presetName}" (Low/Medium/High).`;
}

/**
 * Resolve a feature's effective AI connection mode, following `inherit` back
 * to AI Search.
 * @param {'aiSearch'|'scribe'|'autoSuggest'|'aiNotepad'|'librarian'|'optimizeKeys'} feature
 */
export function resolveFeatureConnectionMode(settings, feature) {
    if (!settings) return 'profile';
    const map = {
        aiSearch: 'aiSearchConnectionMode',
        scribe: 'scribeConnectionMode',
        autoSuggest: 'autoSuggestConnectionMode',
        aiNotepad: 'aiNotepadConnectionMode',
        librarian: 'librarianConnectionMode',
        optimizeKeys: 'optimizeKeysConnectionMode',
    };
    const key = map[feature];
    if (!key) return 'profile';
    let mode = settings[key];
    if (mode === 'inherit') mode = settings.aiSearchConnectionMode || 'profile';
    return mode || 'profile';
}

/**
 * Proxy mode routes through a local proxy (e.g. claude-code-proxy) which
 * handles thinking itself — the native-Anthropic preset check is a
 * false positive there. Only `profile` mode warrants the warning.
 */
export function shouldCheckClaudeAdaptiveForFeature(settings, feature) {
    return resolveFeatureConnectionMode(settings, feature) === 'profile';
}

// Session-scoped one-shot toast tracking. Drawer chip + banner are persistent;
// the toast is a first-detection heads-up per (profile, model, preset) per session.
const _sessionToastShown = new Set();

/** Returns true if the toast slot for this combo was free; claims it. */
export function claimClaudeAdaptiveToastSlot(detail) {
    if (!detail) return false;
    const key = `${detail.profileName || '?'}|${detail.modelName || '?'}|${detail.presetName || '?'}`;
    if (_sessionToastShown.has(key)) return false;
    _sessionToastShown.add(key);
    return true;
}
