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

/**
 * Trace entry-array keys — SINGLE SOURCE OF TRUTH (#13b).
 *
 * Every pipeline-trace key whose value is an array of per-entry objects
 * (`{ title, vaultSource, ... }`). The canonical shape is the trace factory in
 * `src/pipeline/pipeline.js` (`const trace = { ... }`); this list MUST cover
 * every entry-array key there, or raw titles/vaultSources pass through
 * pseudonymization straight into the shareable diagnostic export — which is
 * exactly how `probabilitySkipped` leaked when three hand-rolled copies of
 * this list drifted apart.
 *
 * Maintainers (all import THIS constant — never re-enumerate):
 *   - `pseudonymizeTrace()` below (the scrub surface)
 *   - `src/diagnostics/flight-recorder.js` `summarizeTrace()` (per-stage counts)
 *   - `src/diagnostics/export.js` AI_INSTRUCTIONS (schema doc handed to LLMs)
 *
 * Drift guard: `test/diagnostics.test.mjs` section H scans the pipeline.js
 * trace factory and asserts every `key: []` there is covered by this list.
 */
export const TRACE_ENTRY_ARRAY_KEYS = [
    'keywordMatched', 'aiSelected', 'gatedOut', 'contextualGatingRemoved',
    'cooldownRemoved', 'warmupFailed', 'probabilitySkipped', 'refineKeyBlocked',
    'stripDedupRemoved', 'budgetCut', 'injected',
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

/**
 * SINGLE SOURCE OF TRUTH for `<title-N>` aliasing. All title/vault
 * pseudonymization across the diagnostics subsystem flows through these two
 * exports so the `<title-N>` / `<vault-N>` namespaces don't collide (gotcha:
 * three separate aliasers historically minted overlapping `<title-N>` spaces).
 * `state-snapshot.js` imports these and threads its per-snapshot context.
 *
 * @param {ReturnType<typeof createPseudonymContext>} ctx
 * @param {string} title
 */
export function pseudonymizeTitle(ctx, title) {
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

/**
 * @param {ReturnType<typeof createPseudonymContext>} ctx
 * @param {string} vs
 */
export function pseudonymizeVaultSource(ctx, vs) {
    // Empty / single-vault case passes through unchanged (preserves shape).
    if (!vs) return vs;
    let p = ctx.vaultSourceMap.get(vs);
    if (!p) {
        p = `<vault-${++ctx.vaultSourceCounter}>`;
        ctx.vaultSourceMap.set(vs, p);
    }
    return p;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every KNOWN real title / vault-source substring in `str` with its
 * pseudonym. Longest-first across BOTH maps: replacing "Al" before "Alice"
 * would turn "Alice" into "<title-1>ice", leaking "ice" and corrupting
 * pseudonym cardinality — and a short title inside a longer vault name (or
 * vice versa) must not clobber the longer real first.
 *
 * Reals shorter than 3 chars (short keywords minted from quoted health lints,
 * or genuinely short titles) are only replaced at word boundaries: blind
 * substring replacement of a minted keyword "a" rewrote every later detail
 * containing the letter ("vault" → "v<title-2>ault"). Standalone occurrences
 * of a short real still alias; occurrences embedded inside a longer word stay
 * raw — a 1–2 char fragment inside another word isn't identifying, and the
 * alternative garbles the whole report.
 *
 * @param {ReturnType<typeof createPseudonymContext>} ctx
 * @param {string} str
 * @returns {string}
 */
export function replaceKnownAliases(ctx, str) {
    if (typeof str !== 'string' || !str) return str;
    let out = str;
    const pairs = [...ctx.titleMap.entries(), ...ctx.vaultSourceMap.entries()]
        .sort((a, b) => b[0].length - a[0].length);
    for (const [real, pseudo] of pairs) {
        if (!out.includes(real)) continue;
        if (real.length >= 3) {
            out = out.replaceAll(real, pseudo);
        } else {
            const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(real)}(?![\\p{L}\\p{N}])`, 'gu');
            out = out.replace(re, pseudo);
        }
    }
    return out;
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
    for (const key of TRACE_ENTRY_ARRAY_KEYS) {
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
                out.reason = replaceKnownAliases(ctx, out.reason);
            }
            return out;
        });
    }
    return copy;
}

// ── Health-check pseudonymization (#13a) ────────────────────────────────────

// Aliases minted by this module — quoted content that's already a pseudonym
// must not be re-minted as a fresh <title-N>.
const ALIAS_SHAPE_RE = /^<(?:title|vault)-\d+>$/;

// Static UI strings that runHealthCheck() quotes inside detail messages.
// These are DLE's own literals — not user data — so aliasing them would only
// make the report unreadable. Anything NOT on this list gets aliased: the safe
// failure direction is over-scrubbing, never leaking.
const HEALTH_STATIC_QUOTED = new Set(['Add Vault']);

// The one runHealthCheck() detail that lists user values UNQUOTED
// (`Unresolved wiki-links: A, B` in src/ui/diagnostics.js).
const WIKI_LINKS_PREFIX = 'Unresolved wiki-links: ';

/**
 * Format-anchored rules — one per runHealthCheck() detail format that quotes
 * a user value (src/ui/diagnostics.js). Head/tail groups are the literal
 * format strings; the greedy `(.*)` capture spans EMBEDDED quotes, so a
 * keyword like `dra"gon` mints as one alias. The generic `"([^"]*)"` pair
 * regex used to split it at the embedded quote and leak the trailing fragment
 * raw into the shareable export.
 *
 * `vault: true` mints via the vaultSource map (the quoted value IS a vault
 * name — same alias it carries in settings.vaults / trace, #13c).
 *
 * A NEW detail format that quotes a user value MUST get a rule here — the
 * section I drift guard in test/diagnostics.test.mjs source-scans
 * runHealthCheck() and fails on any `"${...}"` detail without a matching rule.
 */
export const HEALTH_QUOTED_DETAIL_RULES = [
    { re: /^(Vault ")(.*)(" has no API key)$/, vault: true },
    { re: /^(Requires ")(.*)(" which doesn't exist in the vault)$/ },
    { re: /^(Excludes ")(.*)(" which doesn't exist in the vault)$/ },
    { re: /^(Cascade link ")(.*)(" doesn't exist in the vault)$/ },
    { re: /^(Requires and excludes ")(.*)(" simultaneously)$/ },
    { re: /^(Excludes ")(.*)(" which is a \w+ \(always injected\) — this entry will always be blocked)$/ },
    { re: /^(Keyword ")(.*)(" is \d+ char\(s\) — may cause false matches)$/ },
    { re: /^(Title ")(.*)(" appears in \d+ vaults — disambiguated by vault source\.)$/ },
    { re: /^(Keyword ")(.*)(" shared by \d+ entries)$/ },
    { re: /^(AI searched for ")(.*)(" \d+ times with no results — consider creating an entry)$/ },
];

/** Mint a quoted user value; aliases / whitelisted statics pass through. */
function mintQuoted(ctx, inner, useVaultMap) {
    if (!inner || ALIAS_SHAPE_RE.test(inner) || HEALTH_STATIC_QUOTED.has(inner)) return inner;
    if (useVaultMap) return pseudonymizeVaultSource(ctx, inner) ?? inner;
    return pseudonymizeTitle(ctx, inner) ?? inner;
}

/** Alias one component of a multi-title string; empty / already-alias parts pass through. */
function aliasPart(ctx, part) {
    if (!part || ALIAS_SHAPE_RE.test(part)) return part;
    return pseudonymizeTitle(ctx, part) ?? part;
}

/**
 * Health issue `entry` field: a single title, the '—' placeholder,
 * "A, B" (shared-keyword issue), or "A ↔ B" (circular-requires issue).
 * Each component is minted through the shared title map so it matches the
 * alias the same entry has in the pipeline trace.
 */
function pseudonymizeHealthEntry(ctx, entry) {
    if (typeof entry !== 'string' || !entry || entry === '—') return entry;
    return entry
        .split(' ↔ ')
        .map(side => side.split(', ').map(part => aliasPart(ctx, part)).join(', '))
        .join(' ↔ ');
}

/**
 * Health issue `detail` field: free text that quotes titles, keywords, vault
 * names, and librarian queries — all private lore.
 *
 * Parsing contract (gotchas.md #96 point 2): format-anchored rules first
 * (greedy capture through embedded quotes), then known-alias replacement,
 * then a generic quoted-pair pass for unknown balanced formats, with an
 * over-scrub-the-whole-remainder fallback when quotes are unbalanced.
 */
function pseudonymizeHealthDetail(ctx, detail) {
    if (typeof detail !== 'string' || !detail) return detail;
    // 1. Format-anchored rules — every known runHealthCheck() format that
    //    quotes a user value. Runs on the RAW detail, so the static format
    //    text is reconstructed verbatim and never passes through substring
    //    replacement. Values mint via the SAME title map, so a keyword that is
    //    also an entry title shares that entry's alias (mirrors `matchedBy`).
    for (const rule of HEALTH_QUOTED_DETAIL_RULES) {
        const m = rule.re.exec(detail);
        if (m) return m[1] + mintQuoted(ctx, m[2], rule.vault) + m[3];
    }
    // 2. Known reals — titles and vault names already aliased elsewhere in this
    //    snapshot (trace, entry summaries, settings.vaults) keep the same alias.
    let out = replaceKnownAliases(ctx, detail);
    // 3. Unknown formats. Balanced quotes → per-pair minting. An ODD quote
    //    count means the pair regex would misparse and strand a raw fragment
    //    between pairs, so mint the WHOLE remainder from the first quote as one
    //    alias instead — over-scrub beats leak. New quoting formats belong in
    //    HEALTH_QUOTED_DETAIL_RULES, not here.
    const quoteCount = (out.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) {
        const first = out.indexOf('"');
        const rest = out.slice(first + 1).replace(/"$/, '');
        if (rest) out = `${out.slice(0, first)}"${mintQuoted(ctx, rest)}"`;
    } else if (quoteCount > 0) {
        out = out.replace(/"([^"]*)"/g, (m, inner) => {
            if (!inner || ALIAS_SHAPE_RE.test(inner) || HEALTH_STATIC_QUOTED.has(inner)) return m;
            return `"${pseudonymizeTitle(ctx, inner)}"`;
        });
    }
    // 4. Unquoted unresolved wiki-link list.
    const idx = out.indexOf(WIKI_LINKS_PREFIX);
    if (idx !== -1) {
        const head = out.slice(0, idx + WIKI_LINKS_PREFIX.length);
        const tail = out.slice(idx + WIKI_LINKS_PREFIX.length);
        out = head + tail.split(', ').map(part => aliasPart(ctx, part)).join(', ');
    }
    return out;
}

/**
 * Pseudonymize a `runHealthCheck()` result for the shareable diagnostic
 * export (#13a). Issues carry raw entry titles (`entry`) and free-text
 * `detail` strings quoting titles, keywords, vault names, and librarian
 * queries. Uses the SAME per-snapshot context as `pseudonymizeTrace()`, so an
 * entry flagged by the health check maps to the same `<title-N>` it has in
 * the trace section. Functional — input is not mutated; counts and shape are
 * preserved.
 *
 * @param {object|null|undefined} health
 * @param {ReturnType<typeof createPseudonymContext>} ctx
 * @returns {object|null|undefined}
 */
export function pseudonymizeHealth(health, ctx) {
    if (!health || typeof health !== 'object') return health;
    if (!ctx) ctx = createPseudonymContext();
    const copy = { ...health };
    if (Array.isArray(copy.issues)) {
        copy.issues = copy.issues.map(issue => {
            if (!issue || typeof issue !== 'object') return issue;
            return {
                ...issue,
                entry: pseudonymizeHealthEntry(ctx, issue.entry),
                detail: pseudonymizeHealthDetail(ctx, issue.detail),
            };
        });
    }
    return copy;
}
