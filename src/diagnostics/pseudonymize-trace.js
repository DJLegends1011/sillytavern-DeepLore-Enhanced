/**
 * pseudonymize-trace.js — Pure helpers for pseudonymizing pipeline trace
 * data inside diagnostic state snapshots.
 *
 * Extracted from state-snapshot.js so the scrubbing contract is unit-testable
 * without dragging in ST (`script.js` / `settings.js`) at import time.
 *
 * Contract (regression guard for gotchas.md #19 + #20):
 *   - Per-entry `title` is pseudonymized to `<title-N>`.
 *   - Per-entry `filename` is pseudonymized using the SAME title map (so
 *     "foo.md" and a title "foo" don't accidentally share a slot; in practice
 *     filenames are distinct strings so they get their own slot).
 *   - Per-entry `vaultSource` is pseudonymized to `<vault-N>` — leaks the
 *     user's project/vault name otherwise. See CLAUDE.md trackerKey invariant.
 *   - Per-entry `matchedBy` is pseudonymized via the title map — keyword
 *     triggers often ARE character/location names.
 *   - AI `reason` strings have any KNOWN title and KNOWN vault source
 *     substring-replaced with its pseudonym (so a sentence "Selected because
 *     Alice appears" → "Selected because <title-3> appears").
 *   - Cardinality is preserved within a single pseudonym context — calling
 *     the function twice on the same trace with the same context yields the
 *     same pseudonyms (debug export correlation).
 *   - Schema is preserved — pseudonymized output has the same keys / types
 *     as the input; only string values are replaced.
 *   - Functional — input trace is NOT mutated; output is a shallow copy with
 *     fresh per-entry copies for the scrubbed fields.
 */

const ENTRY_ARRAY_KEYS = [
    'keywordMatched', 'aiSelected', 'gatedOut', 'contextualGatingRemoved',
    'cooldownRemoved', 'warmupFailed', 'refineKeyBlocked', 'stripDedupRemoved',
    'budgetCut', 'injected',
];

/**
 * Per-snapshot pseudonym tables. Cardinality is preserved within one context;
 * fresh contexts give fresh aliases (no cross-export correlation).
 *
 * @returns {{
 *   titleMap: Map<string, string>,
 *   titleCounter: number,
 *   vaultSourceMap: Map<string, string>,
 *   vaultSourceCounter: number,
 * }}
 */
export function createPseudonymContext() {
    return {
        titleMap: new Map(),
        titleCounter: 0,
        vaultSourceMap: new Map(),
        vaultSourceCounter: 0,
    };
}

function pseudonymizeTitle(ctx, title) {
    // Matches original state-snapshot.js semantics: falsy → null (lossy but
    // legacy; shape is "title is a string-or-null" so empty-string callers
    // collapsed to null).
    if (!title) return null;
    let p = ctx.titleMap.get(title);
    if (!p) {
        p = `<title-${++ctx.titleCounter}>`;
        ctx.titleMap.set(title, p);
    }
    return p;
}

function pseudonymizeVaultSource(ctx, vs) {
    // Empty / single-vault case passes through unchanged (preserves shape).
    if (!vs) return vs;
    let p = ctx.vaultSourceMap.get(vs);
    if (!p) {
        p = `<vault-${++ctx.vaultSourceCounter}>`;
        ctx.vaultSourceMap.set(vs, p);
    }
    return p;
}

/**
 * Pseudonymize a pipeline trace using the supplied context. Returns a new
 * trace object — input is not mutated. Non-trace inputs are returned as-is.
 *
 * @param {object|null|undefined} trace
 * @param {ReturnType<typeof createPseudonymContext>} ctx
 * @returns {object|null|undefined}
 */
export function pseudonymizeTrace(trace, ctx) {
    if (!trace || typeof trace !== 'object') return trace;
    if (!ctx) ctx = createPseudonymContext();
    const copy = { ...trace };
    for (const key of ENTRY_ARRAY_KEYS) {
        if (!Array.isArray(copy[key])) continue;
        copy[key] = copy[key].map(e => {
            if (!e || typeof e !== 'object') return e;
            const out = {
                ...e,
                title: pseudonymizeTitle(ctx, e.title),
                filename: pseudonymizeTitle(ctx, e.filename),
            };
            // vaultSource leaks the user's project/vault name — pseudonymize alongside title.
            if (e.vaultSource !== undefined) out.vaultSource = pseudonymizeVaultSource(ctx, e.vaultSource);
            // Keyword triggers are often character/location names.
            if (out.matchedBy) out.matchedBy = pseudonymizeTitle(ctx, out.matchedBy);
            // AI reasons may embed character names or vault names — replace any KNOWN alias.
            if (typeof out.reason === 'string') {
                for (const [real, pseudo] of ctx.titleMap.entries()) {
                    if (out.reason.includes(real)) {
                        out.reason = out.reason.replaceAll(real, pseudo);
                    }
                }
                for (const [real, pseudo] of ctx.vaultSourceMap.entries()) {
                    if (out.reason.includes(real)) {
                        out.reason = out.reason.replaceAll(real, pseudo);
                    }
                }
            }
            return out;
        });
    }
    return copy;
}
