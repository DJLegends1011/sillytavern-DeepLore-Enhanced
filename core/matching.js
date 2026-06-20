/**
 * DeepLore Enhanced Core — Matching, Gating & Formatting
 */

import { escapeRegex, truncateToSentence, escapeXml } from './utils.js';
// BUG-092/093: Use ST's enums and MAX_INJECTION_DEPTH constant rather than magic numbers.
// Resolved lazily off the global so node-side unit tests (which never load script.js) still work.
const _PT_FALLBACK = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const _PR_FALLBACK = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
const _g = (typeof window !== 'undefined' ? window : globalThis);
const _PT = (_g && _g.extension_prompt_types) || _PT_FALLBACK;
const _PR = (_g && _g.extension_prompt_roles) || _PR_FALLBACK;
const _MAX_DEPTH = (_g && Number.isFinite(_g.MAX_INJECTION_DEPTH)) ? _g.MAX_INJECTION_DEPTH : 10000;

/**
 * Clamp an injection depth to ST's MAX_INJECTION_DEPTH range, warning on out-of-range values.
 * BUG-092: Typo'd `depth: 50000` previously caused entries to vanish silently.
 * @param {number} depth
 * @param {string} [label]
 * @returns {number}
 */
function clampDepth(depth, label) {
    const n = Number(depth);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) {
        console.warn(`[DLE] injection depth ${n} < 0${label ? ` (${label})` : ''} — clamping to 0`);
        return 0;
    }
    if (n > _MAX_DEPTH) {
        console.warn(`[DLE] injection depth ${n} > MAX_INJECTION_DEPTH (${_MAX_DEPTH})${label ? ` (${label})` : ''} — clamping`);
        return _MAX_DEPTH;
    }
    return n;
}

// C4: regex cache keyed by entry object, invalidated when settings change.
const _regexCache = new WeakMap();

// H9: cache lowercased scanText to avoid ~25MB transient allocations per-entry.
//
// Audit fix-up (round 2): single-slot cache thrashed when entries use distinct
// scanDepth overrides — same generation re-normalized the haystack ~10× when
// the per-entry depth interleaved away from the global scanText. Switched to a
// bounded LRU map keyed on raw string identity; matches the scanTextMemo over
// in src/pipeline/match.js so each depth bucket lowers exactly once per gen.
// Cap at 16 distinct strings — typical workloads see 1-3, mixed scanDepths up
// to ~10. Beyond 16, oldest entry evicted (best-effort, not correctness-critical).
const SCAN_TEXT_CACHE_CAP = 16;
const _scanTextLowerCache = new Map();

function _getLoweredScanText(scanText) {
    const cached = _scanTextLowerCache.get(scanText);
    if (cached !== undefined) {
        // LRU touch — move to end so it's eviction-last.
        _scanTextLowerCache.delete(scanText);
        _scanTextLowerCache.set(scanText, cached);
        return cached;
    }
    const lower = scanText.normalize('NFC').toLowerCase();
    _scanTextLowerCache.set(scanText, lower);
    if (_scanTextLowerCache.size > SCAN_TEXT_CACHE_CAP) {
        const oldest = _scanTextLowerCache.keys().next().value;
        _scanTextLowerCache.delete(oldest);
    }
    return lower;
}

/** Release the cached scan text strings after the matching phase completes. */
export function clearScanTextCache() {
    _scanTextLowerCache.clear();
}

/**
 * Get or build cached compiled regexes for an entry's keys and refine keys.
 * Cache is keyed by entry object reference and invalidated when relevant settings change.
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {{ _key: string, primary: Array<{rawKey: string, key: string, regex: RegExp|null, regexG: RegExp|null}>, refine: Array<{rKey: string, regex: RegExp|null}> }}
 */
function getCachedRegexes(entry, settings) {
    let cache = _regexCache.get(entry);
    const cacheKey = `${settings.caseSensitive}|${settings.matchWholeWords}`;
    if (cache && cache._key === cacheKey) return cache;

    const MAX_KEYWORD_LENGTH = 200;
    cache = { _key: cacheKey, primary: [], refine: [] };
    for (const rawKey of entry.keys) {
        if (!rawKey || !rawKey.trim()) continue;
        // BUG-148: warn (once per build) on overflow so silent truncation doesn't eat
        // the tail of long phrasal triggers.
        if (rawKey.length > MAX_KEYWORD_LENGTH) {
            console.warn(`[DLE] keyword "${rawKey.slice(0, 40)}..." exceeds MAX_KEYWORD_LENGTH (${MAX_KEYWORD_LENGTH}) on entry "${entry.title}" — truncated`);
        }
        const truncatedKey = rawKey.length > MAX_KEYWORD_LENGTH ? rawKey.substring(0, MAX_KEYWORD_LENGTH) : rawKey;
        const key = settings.caseSensitive ? truncatedKey : truncatedKey.normalize('NFC').toLowerCase();
        if (settings.matchWholeWords) {
            // BUG-044: ST's world-info.js matchKeys() falls back to substring match when
            // a key contains whitespace. We previously wrapped multi-word keys in `\b…\b`,
            // which silently diverged from imported WI books.
            if (/\s/.test(key)) {
                cache.primary.push({ rawKey, key, regex: null, regexG: null, isMultiWord: true });
            } else {
                const escaped = escapeRegex(key);
                const prefix = /^\w/.test(key) ? '\\b' : '(?<!\\w)';
                const suffix = /\w$/.test(key) ? '\\b' : '(?!\\w)';
                cache.primary.push({
                    rawKey,
                    key,
                    regex: new RegExp(`${prefix}${escaped}${suffix}`, settings.caseSensitive ? '' : 'i'),
                    regexG: new RegExp(`${prefix}${escaped}${suffix}`, settings.caseSensitive ? 'g' : 'gi'),
                });
            }
        } else {
            cache.primary.push({ rawKey, key, regex: null, regexG: null });
        }
    }
    if (entry.refineKeys) {
        for (const rk of entry.refineKeys) {
            const rKey = settings.caseSensitive ? rk : rk.normalize('NFC').toLowerCase();
            if (settings.matchWholeWords) {
                // BUG-044: same multi-word substring fallback as primary keys.
                if (/\s/.test(rKey)) {
                    cache.refine.push({ rKey, regex: null, isMultiWord: true });
                } else {
                    // M13: same smart word-boundary logic as primary keys.
                    const escaped = escapeRegex(rKey);
                    const prefix = /^\w/.test(rKey) ? '\\b' : '(?<!\\w)';
                    const suffix = /\w$/.test(rKey) ? '\\b' : '(?!\\w)';
                    cache.refine.push({
                        rKey,
                        regex: new RegExp(`${prefix}${escaped}${suffix}`, settings.caseSensitive ? '' : 'i'),
                    });
                }
            } else {
                cache.refine.push({ rKey, regex: null });
            }
        }
    }
    _regexCache.set(entry, cache);
    return cache;
}

/**
 * Test if an entry's keys match against the given text.
 * Uses cached compiled regexes for performance (C4).
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @param {Array<object>} [trace] - Optional diagnostic collector. If provided, a record
 *   `{ title, vaultSource, result, primaryMatched, refineKeys, reason }` is pushed
 *   on any outcome where the entry had keys (match, no-primary, blocked-by-refine).
 *   Callers opt in — pipeline passes one only when debugMode is on.
 * @returns {string|null} The matched key, or null if no match
 */
export function testEntryMatch(entry, scanText, settings, trace = null) {
    if (entry.keys.length === 0) return null;

    const cached = getCachedRegexes(entry, settings);
    const haystack = settings.caseSensitive ? scanText : _getLoweredScanText(scanText);

    let primaryMatch = null;
    for (const item of cached.primary) {
        if (settings.matchWholeWords) {
            // BUG-044: multi-word keys fall through with regex===null and substring-match (ST parity).
            if (item.isMultiWord) {
                if (haystack.includes(item.key)) { primaryMatch = item.rawKey; break; }
            } else if (item.regex.test(haystack)) { primaryMatch = item.rawKey; break; }
        } else {
            if (haystack.includes(item.key)) { primaryMatch = item.rawKey; break; }
        }
    }
    if (!primaryMatch) {
        if (trace) trace.push({ title: entry.title, vaultSource: entry.vaultSource, result: 'no-primary', primaryMatched: null, refineKeys: cached.refine.map(r => r.rKey), reason: 'no primary key in scan text' });
        return null;
    }

    // Refine keys: gate is parameterized by entry.selectiveLogic (Wave 3 WI parity).
    // Legacy entries without selectiveLogic default to 'and_any' — the pre-Wave-3
    // behavior. All four ST selectiveLogic modes are honored:
    //   and_any (default) — ≥1 refine key must match
    //   and_all           — all refine keys must match
    //   not_any           — zero refine keys may match (any hit blocks the entry)
    //   not_all           — at least one refine key must miss (full match blocks)
    // Empty refine_keys = no gate regardless of mode (vacuously satisfied for all
    // four). The match path is shared across primary, recursion, and BM25 keyword
    // pre-validation sites via testEntryMatch; future refine-gate sites MUST route
    // through applySelectiveLogic (matches the M-6 hasWarmup invariant — pin the
    // predicate so the 4 modes can't diverge across paths).
    if (cached.refine.length > 0) {
        // Audit fix-up: short-circuit by mode instead of always counting all
        // refine hits. Hot loop — pre-fix the .filter(...).length always
        // evaluated every refine regex against the (large) haystack even for
        // the default and_any case where the legacy .some() bailed at hit 1.
        const total = cached.refine.length;
        const logic = entry.selectiveLogic || 'and_any';
        const test = (item) => {
            if (settings.matchWholeWords) {
                if (item.isMultiWord) return haystack.includes(item.rKey);
                return item.regex.test(haystack);
            }
            return haystack.includes(item.rKey);
        };
        let passes;
        let matchedForTrace; // computed only if a trace collector is present
        switch (logic) {
            case 'and_all':
                passes = cached.refine.every(test);
                break;
            case 'not_all':
                passes = !cached.refine.every(test);
                break;
            case 'not_any':
                passes = !cached.refine.some(test);
                break;
            case 'and_any':
            default:
                passes = cached.refine.some(test);
        }
        if (!passes) {
            if (trace) {
                matchedForTrace = cached.refine.filter(test).length;
                trace.push({ title: entry.title, vaultSource: entry.vaultSource, result: 'refine-blocked', primaryMatched: primaryMatch, refineKeys: cached.refine.map(r => r.rKey), reason: `selective_logic=${logic} blocked (${matchedForTrace}/${total} refine keys matched)` });
            }
            // applySelectiveLogic is still the pinned predicate for any
            // future refine-gate site — exercised in tests, used by
            // diagnostics.js / commands-pipeline.js for user-facing copy.
            void applySelectiveLogic;
            return null;
        }
    }
    if (trace) trace.push({ title: entry.title, vaultSource: entry.vaultSource, result: 'match', primaryMatched: primaryMatch, refineKeys: cached.refine.map(r => r.rKey), reason: null });
    return primaryMatch;
}

/**
 * Pure predicate for the selective_logic gate. Single source of truth so all
 * refine-key gate sites (today: testEntryMatch only) cannot diverge across
 * the 4 modes. Mirrors ST's selectiveLogic enum:
 *   0 AND_ANY → 'and_any' (primary AND any refine)
 *   1 NOT_ALL → 'not_all' (primary AND NOT all refines)
 *   2 NOT_ANY → 'not_any' (primary AND no refine)
 *   3 AND_ALL → 'and_all' (primary AND all refines)
 *
 * @param {number} matchedCount - how many refine keys hit the scan text
 * @param {number} total - total refine keys on the entry
 * @param {'and_any'|'and_all'|'not_all'|'not_any'} logic
 * @returns {boolean} true = entry passes the refine gate (still match)
 */
export function applySelectiveLogic(matchedCount, total, logic) {
    if (total === 0) return true; // vacuously satisfied for all 4 modes
    switch (logic) {
        case 'and_all': return matchedCount === total;
        case 'not_all': return matchedCount < total;
        case 'not_any': return matchedCount === 0;
        case 'and_any':
        default:        return matchedCount > 0;
    }
}

/**
 * Test if an entry's primary keys match (ignoring refine keys).
 * Used to detect entries blocked specifically by refine key filtering.
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {string|null} The matched primary key, or null if no primary match
 */
export function testPrimaryMatchOnly(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;

    const cached = getCachedRegexes(entry, settings);
    const haystack = settings.caseSensitive ? scanText : _getLoweredScanText(scanText);

    for (const item of cached.primary) {
        if (settings.matchWholeWords) {
            if (item.isMultiWord) {
                if (haystack.includes(item.key)) return item.rawKey;
            } else if (item.regex.test(haystack)) return item.rawKey;
        } else {
            if (haystack.includes(item.key)) return item.rawKey;
        }
    }
    return null;
}

/**
 * Count how many times an entry's keywords appear in the scan text.
 * Respects case sensitivity and whole-word matching settings.
 * Uses cached compiled regexes for performance (C4).
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {number} Total keyword occurrence count
 */
export function countKeywordOccurrences(entry, scanText, settings) {
    let count = 0;
    const cached = getCachedRegexes(entry, settings);
    const text = settings.caseSensitive ? scanText : _getLoweredScanText(scanText);
    for (const item of cached.primary) {
        if (settings.matchWholeWords) {
            // BUG-044: multi-word has regexG===null; substring-count occurrences.
            if (item.isMultiWord) {
                let idx = 0;
                while ((idx = text.indexOf(item.key, idx)) !== -1) {
                    count++;
                    idx += item.key.length;
                }
            } else {
                const matches = text.match(item.regexG);
                if (matches) count += matches.length;
            }
        } else {
            let idx = 0;
            while ((idx = text.indexOf(item.key, idx)) !== -1) {
                count++;
                idx += item.key.length;
            }
        }
    }
    return count;
}

/**
 * Apply conditional gating rules (requires/excludes) to matched entries.
 * Iterates until stable since removing a gated entry may affect another's requires.
 * @param {import('./pipeline.js').VaultEntry[]} entries - Matched entries (already merged)
 * @returns {import('./pipeline.js').VaultEntry[]}
 */
export function applyGating(entries) {
    // BUG-029: descending by priority for deterministic mutual-excludes resolution.
    // Legacy — live pipeline uses applyRequiresExcludesGating in stages.js.
    // M-1: nullish so `priority: 0` isn't demoted to 50 (falsy-coalesce class).
    let result = [...entries].sort((a, b) => ((b.priority ?? 50) - (a.priority ?? 50)) || a.title.localeCompare(b.title));
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    // L13: refcount titles instead of a plain Set (mirrors applyRequiresExcludesGating in
    // src/stages.js). Two same-titled entries from DIFFERENT vaults: dropping one must NOT
    // purge the title while its twin survives, or a third entry's `requires:[Title]` wrongly
    // fails. A title is "active" while its count > 0. Preserves gotcha #50 item 7 (permissive
    // cross-vault bare-title lookup); only fixes the destructive-delete-while-twin-survives bug.
    const activeTitles = new Map();
    const isActive = (t) => (activeTitles.get(t) || 0) > 0;
    const dropTitle = (t) => {
        const n = (activeTitles.get(t) || 0) - 1;
        if (n <= 0) activeTitles.delete(t); else activeTitles.set(t, n);
    };
    for (const e of result) {
        const t = e.title.toLowerCase();
        activeTitles.set(t, (activeTitles.get(t) || 0) + 1);
    }

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        iterations++;

        const nextResult = [];
        for (const entry of result) {
            if (entry.requires && entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => isActive(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    dropTitle(entry.title.toLowerCase());
                    continue;
                }
            }
            if (entry.excludes && entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => isActive(r.toLowerCase()));
                if (anyPresent) {
                    changed = true;
                    dropTitle(entry.title.toLowerCase());
                    continue;
                }
            }
            nextResult.push(entry);
        }
        result = nextResult;
    }

    // Detect contradictory gating (A requires B, B excludes A) for debugging.
    const removedEntries = entries.filter(e => !result.includes(e));
    if (removedEntries.length > 0) {
        for (const removed of removedEntries) {
            if (removed.requires && removed.requires.length > 0) {
                for (const req of removed.requires) {
                    const reqEntry = entries.find(e => e.title.toLowerCase() === req.toLowerCase());
                    if (reqEntry && reqEntry.excludes && reqEntry.excludes.some(exc => exc.toLowerCase() === removed.title.toLowerCase())) {
                        console.warn(`[DLE] Contradictory gating: "${removed.title}" requires "${reqEntry.title}" but "${reqEntry.title}" excludes "${removed.title}" — both dropped`);
                    }
                }
            }
        }
    }

    if (iterations >= MAX_ITERATIONS && changed) {
        console.warn('[DLE] Gating did not stabilize after', MAX_ITERATIONS, 'iterations — results may be incomplete. Check for circular requires/excludes.');
    }

    return result;
}

/**
 * Resolve raw wiki-link targets to confirmed entry titles in the vault index.
 * Must be called after vaultIndex is fully populated.
 * @param {import('./pipeline.js').VaultEntry[]} vaultIndex
 */
export function resolveLinks(vaultIndex) {
    const titleMap = new Map(vaultIndex.map(e => [e.title.toLowerCase(), e.title]));
    for (const entry of vaultIndex) {
        entry.resolvedLinks = entry.links
            .map(l => titleMap.get(l.toLowerCase()))
            .filter(Boolean);
    }
}

/**
 * Format matched entries for injection, respecting budget limits, grouped by injection position.
 * Entries can override the global injection position/depth/role via frontmatter.
 *
 * Two grouping modes:
 * - 'extension' (default): Groups by (position, depth, role) with auto-generated keys.
 * - 'prompt_list': Groups into stable named keys (constants vs lore) with IN_PROMPT position.
 *   ST's Prompt Manager automatically surfaces these as draggable entries.
 *   Per-entry overrides with custom position/depth get their own IN_CHAT group.
 *
 * @param {import('./pipeline.js').VaultEntry[]} entries - Matched entries sorted by priority
 * @param {{ injectionMode?: string, injectionTemplate: string, injectionPosition: number, injectionDepth: number, injectionRole: number, maxEntries: number, unlimitedEntries: boolean, maxTokensBudget: number, unlimitedBudget: boolean }} settings
 * @param {string} promptTagPrefix - Prefix for prompt tags (e.g. 'deeplore_')
 * @returns {{ groups: Array<{ tag: string, text: string, position: number, depth: number, role: number }>, count: number, totalTokens: number, acceptedEntries: import('./pipeline.js').VaultEntry[] }}
 */
export function formatAndGroup(entries, settings, promptTagPrefix) {
    // BUG-158: the `</{{title}}>` close tag is load-bearing — without it, multi-line
    // entries concatenated with `\n` bleed into each other and the model can't tell
    // where one ends and the next begins.
    const DEFAULT_TEMPLATE = '<{{title}}>\n{{content}}\n</{{title}}>';
    // A custom template missing {{content}} renders title-only lore — budget spent, model gets
    // no body. Fall back to the default rather than silently inject useless context.
    let template = settings.injectionTemplate || DEFAULT_TEMPLATE;
    if (!template.includes('{{content}}')) template = DEFAULT_TEMPLATE;
    let totalTokens = 0;
    let count = 0;

    // Outlet entries bypass positional injection.
    const outletEntries = entries.filter(e => e.outlet);
    const positionalEntries = entries.filter(e => !e.outlet);

    const accepted = [];
    let truncatedCount = 0;

    const MIN_TRUNCATION_TOKENS = 50;

    for (const entry of positionalEntries) {
        if (!settings.unlimitedEntries && count >= settings.maxEntries) break;
        if (!settings.unlimitedBudget && totalTokens + entry.tokenEstimate > settings.maxTokensBudget) {
            const remainingTokens = settings.maxTokensBudget - totalTokens;

            if (remainingTokens >= MIN_TRUNCATION_TOKENS) {
                // 50 tokens ≈ 200 chars at 4 chars/token — below this, the fragment is
                // too short to be useful context, so skip rather than truncate.
                // Shallow copy (never mutate original).
                // BUG-053: per-entry chars/token derived from the real index-time
                // tokenEstimate (getTokenCountAsync in vault.js). Falls back to 4.0
                // only when content/tokenEstimate are missing — keeps core/ pure.
                const charsPerToken = (entry.tokenEstimate > 0 && entry.content && entry.content.length > 0)
                    ? (entry.content.length / entry.tokenEstimate)
                    : 4.0;
                const maxChars = Math.floor(remainingTokens * charsPerToken);
                const truncatedContent = truncateToSentence(entry.content, maxChars);
                const truncatedEntry = {
                    ...entry,
                    content: truncatedContent,
                    tokenEstimate: Math.ceil(truncatedContent.length / charsPerToken),
                    _truncated: true,
                    _originalTokens: entry.tokenEstimate,
                    // M-8 (2026-05-22): keep the PRE-truncation hash so strip-dedup
                    // matches by canonical content identity, not by truncated-vs-full
                    // shape. The old `_trunc` suffix produced asymmetric dedup —
                    // gen 1 injects "Castle" at 500 tokens (hash X), gen 2's smaller
                    // budget truncates "Castle" to 200 tokens (hash X_trunc), the
                    // dedup key mismatches X, and the same entry gets re-injected
                    // back-to-back even though it carries identical canonical
                    // content from the author's perspective. Truncation is a
                    // presentation-layer concession to the budget; it must not
                    // change the entry's dedup identity. `_truncated` and
                    // `_originalTokens` still record that this version was cut
                    // for any UI/analytics that need to display the fact.
                    _contentHash: typeof entry._contentHash === 'string' ? entry._contentHash : '',
                };
                accepted.push({
                    entry: truncatedEntry,
                    position: truncatedEntry.injectionPosition ?? settings.injectionPosition,
                    depth: clampDepth(truncatedEntry.injectionDepth ?? settings.injectionDepth, truncatedEntry.title),
                    role: truncatedEntry.injectionRole ?? settings.injectionRole,
                });
                totalTokens += truncatedEntry.tokenEstimate;
                count++;
                truncatedCount++;
                break; // budget fully consumed
            }

            if (count > 0) break;
            // First entry exceeds entire budget and remaining is too small to truncate.
            console.warn(`[DLE] Entry "${entry.title}" (${entry.tokenEstimate} tokens) exceeds entire budget (${settings.maxTokensBudget}) — skipping`);
            continue;
        }

        accepted.push({
            entry,
            position: entry.injectionPosition ?? settings.injectionPosition,
            depth: clampDepth(entry.injectionDepth ?? settings.injectionDepth, entry.title),
            role: entry.injectionRole ?? settings.injectionRole,
        });
        totalTokens += entry.tokenEstimate;
        count++;
    }

    // Title is interpolated as the wrapper tag name (`<{{title}}>`), so it MUST be
    // XML-escaped or a title like `Test<Entry>` produces an unparseable wrapper.
    // Content passes through raw — vault authors deliberately use XML/markup inside
    // entries (nested tags, examples, `<3`, code samples) and downstream consumers
    // (ST, LLMs) treat injected text as freeform. Escaping content broke entries that
    // intentionally contained `<tag>` markup (issue #16). Earlier BUG-090 expanded the
    // escape on the assumption of "downstream XML tooling" — no such tooling exists in
    // the injection path.
    const formatEntry = (entry) => {
        let text = template.replace(/\{\{title\}\}/g, escapeXml(entry.title));
        text = text.replace(/\{\{content\}\}/g, entry.content);
        return text;
    };

    // Outlet entries: group by outlet name, written to extension_prompts under
    // `customWIOutlet_<name>` and read by ST's `{{outlet::name}}` macro. Position is
    // NONE — they're user-placed via macros, so budget/maxEntries don't apply.
    // BUG-146: carry per-entry role through the group; first non-null wins. Mixed-role
    // outlets are an authoring error (one tag = one role), not something we can split.
    const outletGroupMap = new Map();
    let outletTokens = 0;
    for (const entry of outletEntries) {
        const key = `customWIOutlet_${entry.outlet}`;
        if (!outletGroupMap.has(key)) {
            outletGroupMap.set(key, { tag: key, texts: [], tokens: 0, role: null });
        }
        const g = outletGroupMap.get(key);
        g.texts.push(formatEntry(entry));
        g.tokens += entry.tokenEstimate;
        if (g.role === null && entry.injectionRole !== null && entry.injectionRole !== undefined) {
            g.role = entry.injectionRole;
        }
        outletTokens += entry.tokenEstimate;
    }
    const outletGroups = [...outletGroupMap.values()].map(g => ({
        tag: g.tag,
        text: g.texts.join('\n\n'),
        position: _PT.NONE,
        depth: 0,
        role: g.role ?? _PR.SYSTEM,
    }));

    const mode = settings.injectionMode || 'extension';

    if (mode === 'prompt_list') {
        // Group by type (constants vs lore) with stable keys. Per-entry overrides
        // get their own IN_CHAT group (bypassing the Prompt Manager).
        const groupMap = new Map();
        // BUG-093: use imported enum, not a magic number that drifts on ST refactor.
        const IN_PROMPT = _PT.IN_PROMPT;
        const SYSTEM_ROLE = _PR.SYSTEM;

        for (const item of accepted) {
            const hasOverride = item.entry.injectionPosition !== null || item.entry.injectionDepth !== null || item.entry.injectionRole !== null;

            let key, position, depth, role;
            if (hasOverride) {
                key = `${promptTagPrefix}override_p${item.position}_d${item.depth}_r${item.role}`;
                position = item.position;
                depth = item.depth;
                role = item.role;
            } else if (item.entry.constant) {
                key = `${promptTagPrefix}constants`;
                position = IN_PROMPT;
                depth = 0;
                role = SYSTEM_ROLE;
            } else {
                key = `${promptTagPrefix}lore`;
                position = IN_PROMPT;
                depth = 0;
                role = SYSTEM_ROLE;
            }

            if (!groupMap.has(key)) {
                groupMap.set(key, { tag: key, position, depth, role, texts: [] });
            }
            groupMap.get(key).texts.push(formatEntry(item.entry));
        }

        const groups = [...groupMap.values()].map(g => ({
            tag: g.tag,
            text: g.texts.join('\n\n'),
            position: g.position,
            depth: g.depth,
            role: g.role,
        }));

        groups.push(...outletGroups);
        console.log('[DLE] Format: %d/%d entries, %d/%d tokens%s, %d groups, %d outlet',
            count, positionalEntries.length, totalTokens, settings.unlimitedBudget ? totalTokens : settings.maxTokensBudget,
            truncatedCount > 0 ? `, ${truncatedCount} truncated` : '', groups.length, outletEntries.length);
        return { groups, count: count + outletEntries.length, totalTokens: totalTokens + outletTokens, acceptedEntries: [...accepted.map(a => a.entry), ...outletEntries] };
    }

    // Extension mode (default): group by (position, depth, role).
    const groupMap = new Map();
    for (const item of accepted) {
        const key = `${promptTagPrefix}p${item.position}_d${item.depth}_r${item.role}`;
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                tag: key,
                position: item.position,
                depth: item.depth,
                role: item.role,
                texts: [],
            });
        }
        groupMap.get(key).texts.push(formatEntry(item.entry));
    }

    const groups = [...groupMap.values()].map(g => ({
        tag: g.tag,
        text: g.texts.join('\n\n'),
        position: g.position,
        depth: g.depth,
        role: g.role,
    }));

    groups.push(...outletGroups);
    console.log('[DLE] Format: %d/%d entries, %d/%d tokens%s, %d groups, %d outlet',
        count, positionalEntries.length, totalTokens, settings.unlimitedBudget ? totalTokens : settings.maxTokensBudget,
        truncatedCount > 0 ? `, ${truncatedCount} truncated` : '', groups.length, outletEntries.length);
    return { groups, count: count + outletEntries.length, totalTokens: totalTokens + outletTokens, acceptedEntries: [...accepted.map(a => a.entry), ...outletEntries] };
}
