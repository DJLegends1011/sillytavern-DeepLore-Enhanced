/**
 * DeepLore Enhanced — Deprecated prompt keys allowlist.
 *
 * Layer 2 of the delete cage (see `prompt-validators.js`) refuses to delete
 * any vault prompt file whose stem is not a recognized key. This breaks
 * forward compat for one case: a prompt key that USED to exist but was
 * removed in a later version. Those orphan files would be undeletable.
 *
 * Solution: keys removed from the canonical EN dict get added here.
 * The cage accepts: { current canonical EN keys } ∪ DEPRECATED_PROMPT_KEYS.
 *
 * Add keys here ONLY when removing them from `src/i18n/prompts/en.js`.
 * Never speculative additions — that would weaken the whitelist.
 *
 * The set is intentionally empty at v2.5 ship (no removals yet).
 *
 * @type {Set<string>}
 */
export const DEPRECATED_PROMPT_KEYS = new Set([
    // Example future entry:
    // 'LEGACY_EMMA_OPENING', // removed v2.6 — replaced by EMMA_FIRSTRUN_GREETING
]);
