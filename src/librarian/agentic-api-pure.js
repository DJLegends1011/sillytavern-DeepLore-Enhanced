/**
 * Pure model-classification helpers extracted from agentic-api.js so the
 * regex contracts are unit-testable without standing up ST mocks.
 *
 * No imports from ST modules. Keep it that way.
 */

/**
 * Detect Claude regardless of provider source — covers OpenRouter relays
 * (`anthropic/claude-*`) that source-only checks miss. Gates Claude-specific
 * request mitigations (thinking-vs-tool_choice 400 sidestep, `json_schema`
 * skip on Claude routes).
 *
 * Pure form: takes an explicit model string, returns boolean. The wrapper in
 * agentic-api.js falls back to `getResolvedModel()` when the caller passes
 * nothing; that fallback is the only part that needs ST context.
 *
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isUnderlyingClaudeModel(model) {
    if (!model || typeof model !== 'string') return false;
    return /^claude-/i.test(model) || /^anthropic\/claude/i.test(model);
}
