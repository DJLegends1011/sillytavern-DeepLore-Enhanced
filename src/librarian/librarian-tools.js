/**
 * DeepLore — Librarian tool action implementations.
 * search_lore and flag_lore — called by the agentic loop during generation.
 */
import { getCurrentChatId } from '../../../../../../script.js';
import { getContext, saveMetadataDebounced } from '../../../../../extensions.js';
import { truncateToSentence, escapeXml } from '../../core/utils.js';
import { neutralizeClosingTag } from '../helpers.js';
import { queryBM25, tokenize } from '../vault/bm25.js';
import { getSettings } from '../../settings.js';
import {
    loreGaps, setLoreGaps,
    loreGapSearchCount, setLoreGapSearchCount,
    fuzzySearchIndex, vaultIndex,
    buildPromise,
    generationCount,
    chatEpoch,
    librarianSessionStats, setLibrarianSessionStats,
    librarianChatStats, setLibrarianChatStats,
    notifyLoreGapsChanged,
    notifyAiStatsUpdated,
} from '../state.js';
import { getCurrentForChat as getCurrentVerdictForChat } from '../verdict/verdict-store.js';

// Local helper — must read the CURRENT CHAT's verdict, not the ring-global
// newest. The agentic loop always runs against the active chat. See
// docs/gotchas.md #46 ("UI consumer rule").
function _currentVerdictForChat() {
    let cid = null;
    try { cid = getCurrentChatId() ?? null; } catch { cid = null; }
    return getCurrentVerdictForChat(cid);
}

// ════════════════════════════════════════════════════════════════════════════
// Session Activity Log
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-session activity log. Reset on CHAT_CHANGED via clearSessionActivityLog.
 * @type {Array<{type: string, query: string, resultCount: number, resultTitles: string[], tokens: number, timestamp: number, generation: number}>}
 */
let sessionActivityLog = [];

/** Immutable copy. */
export function getSessionActivityLog() {
    return [...sessionActivityLog];
}

/** Call on CHAT_CHANGED. */
export function clearSessionActivityLog() {
    sessionActivityLog = [];
}

/** FIFO cap — mirrors loreGaps (200); bounds growth within one long chat. */
const SESSION_ACTIVITY_CAP = 200;

/** Push an activity record, trimming oldest beyond the FIFO cap. */
function recordSessionActivity(logEntry) {
    sessionActivityLog.push(logEntry);
    if (sessionActivityLog.length > SESSION_ACTIVITY_CAP) {
        sessionActivityLog.splice(0, sessionActivityLog.length - SESSION_ACTIVITY_CAP);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

export function gapId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Returns matching gap if >60% token overlap with newQuery, else null. */
function findSimilarGap(gaps, newQuery, type, subtype = null) {
    const newTokens = tokenize(newQuery);
    if (newTokens.length === 0) return null;
    const newSet = new Set(newTokens);

    for (const gap of gaps) {
        if (gap.type !== type) continue;
        if (subtype && gap.subtype !== subtype) continue;
        const existingTokens = tokenize(gap.query);
        if (existingTokens.length === 0) continue;

        const existingSet = new Set(existingTokens);
        let overlap = 0;
        for (const t of newSet) {
            if (existingSet.has(t)) overlap++;
        }
        const overlapRatio = overlap / Math.max(newSet.size, existingSet.size);
        if (overlapRatio > 0.6) return gap;
    }
    return null;
}

/**
 * @returns {boolean} true if persisted, false if chatMetadata unavailable
 */
export function persistGaps(updatedGaps) {
    // BUG-304: check metadata BEFORE mutating in-memory state. Cold start /
    // between-chat states would otherwise commit setLoreGaps but never persist,
    // and the drawer-visible gap silently disappears on reload.
    const ctx = getContext();
    const meta = ctx?.chatMetadata;
    if (!meta) return false;
    // BUG-AUDIT-C03: cap unbounded growth in long chats. Evict oldest by createdAt.
    // M-7: keep CHRONOLOGICAL order (oldest→newest). Every other path treats loreGaps
    // as append-at-end chronological ([...loreGaps, newGap]; findSimilarGap returns the
    // first match = order-dependent). A descending sort + slice(0, MAX) flipped the array
    // to newest→oldest after the first eviction, scrambling ordering + merge targets.
    // Ascending sort + slice(-MAX) keeps the newest MAX in chronological order.
    const MAX_GAPS = 200;
    let capped = updatedGaps;
    if (capped.length > MAX_GAPS) {
        capped = [...capped].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-MAX_GAPS);
    }
    setLoreGaps(capped);
    meta.deeplore_lore_gaps = capped;
    // BUG-AUDIT-H09: prune orphaned ids from hidden/dismissed arrays — they
    // would otherwise accumulate forever as gaps are evicted/dismissed.
    const activeIds = new Set(capped.map(g => g.id));
    const hidden = meta.deeplore_lore_gaps_hidden;
    if (Array.isArray(hidden) && hidden.length > 0) {
        const pruned = hidden.filter(id => activeIds.has(id));
        if (pruned.length !== hidden.length) meta.deeplore_lore_gaps_hidden = pruned;
    }
    const dismissed = meta.deeplore_lore_gaps_dismissed;
    if (Array.isArray(dismissed) && dismissed.length > 0) {
        const pruned = dismissed.filter(id => activeIds.has(id));
        if (pruned.length !== dismissed.length) meta.deeplore_lore_gaps_dismissed = pruned;
    }
    saveMetadataDebounced();
    return true;
}

// ── Soft-remove sibling-array helpers (mirrors deeplore_pins/blocks pattern) ──

function readGapIdArray(key) {
    const meta = getContext()?.chatMetadata;
    const raw = meta?.[key];
    return Array.isArray(raw) ? raw : [];
}

function writeGapIdArray(key, ids) {
    const meta = getContext()?.chatMetadata;
    if (!meta) return;
    meta[key] = ids;
    saveMetadataDebounced();
}

export function getHiddenGapIds() {
    return new Set(readGapIdArray('deeplore_lore_gaps_hidden'));
}

export function getDismissedGapIds() {
    return new Set(readGapIdArray('deeplore_lore_gaps_dismissed'));
}

/** First-tier: re-flag will resurface. */
export function hideGap(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_hidden');
    if (!arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', [...arr, id]);
    setLoreGaps([...loreGaps]); // trigger render
}

/** Second-tier: re-flag will NOT resurface. */
export function dismissGap(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_dismissed');
    if (!arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_dismissed', [...arr, id]);
    const hidden = readGapIdArray('deeplore_lore_gaps_hidden');
    if (hidden.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', hidden.filter(x => x !== id));
    setLoreGaps([...loreGaps]);
}

/** Used during re-flag merge — clear hidden without notifying. */
function clearHiddenSilently(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_hidden');
    if (arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', arr.filter(x => x !== id));
}

/**
 * Combined feed: persistent search gaps + session tool calls. Newest first.
 * Consumed by both the drawer and the Emma popup.
 */
export function buildLibrarianActivityFeed() {
    const feed = [];
    // Dedup live session entries against persistent gaps (same type+query within 2s).
    const sessionKeys = new Set();
    for (const e of sessionActivityLog) {
        sessionKeys.add(`${e.type}:${e.query}:${Math.floor((e.timestamp || 0) / 2000)}`);
        feed.push({
            kind: e.type === 'search' ? 'tool-search' : 'tool-flag',
            ts: e.timestamp || 0,
            query: e.query || '',
            type: e.type,
            resultCount: e.resultCount || 0,
            resultTitles: Array.isArray(e.resultTitles) ? e.resultTitles : [],
            tokens: e.tokens || 0,
            generation: e.generation || 0,
            urgency: e.urgency,
        });
    }
    for (const g of loreGaps) {
        const dedupKey = `${g.type}:${g.query}:${Math.floor((g.timestamp || 0) / 2000)}`;
        if (sessionKeys.has(dedupKey)) continue;
        if (g.type === 'search') {
            // Only live session searches are shown in the feed.
            continue;
        } else if (g.type === 'flag') {
            feed.push({
                kind: 'gap-flag',
                ts: g.createdAt || g.timestamp || 0,
                query: g.query || '',
                type: 'flag',
                subtype: g.subtype,
                entryTitle: g.entryTitle,
                resultCount: 0,
                resultTitles: [],
                urgency: g.urgency,
                frequency: g.frequency || 1,
                reason: g.reason,
            });
        }
    }
    feed.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return feed;
}

function updateAnalytics(field) {
    const s = getSettings();
    if (!s.analyticsData) s.analyticsData = {};
    if (!s.analyticsData._librarian) {
        s.analyticsData._librarian = {
            totalGapSearches: 0,
            totalGapFlags: 0,
            totalEntriesWritten: 0,
            totalEntriesUpdated: 0,
            topUnmetQueries: [],
        };
    }
    s.analyticsData._librarian[field] = (s.analyticsData._librarian[field] || 0) + 1;
}

function trackUnmetQuery(query) {
    const s = getSettings();
    if (!s.analyticsData._librarian) return;
    const unmet = s.analyticsData._librarian.topUnmetQueries || [];
    const existing = unmet.find(u => u.query.toLowerCase() === query.toLowerCase());
    if (existing) {
        existing.count++;
        existing.lastSearched = Date.now();
    } else {
        unmet.push({ query, count: 1, lastSearched: Date.now() });
    }
    unmet.sort((a, b) => b.count - a.count);
    s.analyticsData._librarian.topUnmetQueries = unmet.slice(0, 20);
}

function incrementStats(field, extraTokens = 0) {
    setLibrarianSessionStats({
        ...librarianSessionStats,
        [field]: (librarianSessionStats[field] || 0) + 1,
        estimatedExtraTokens: (librarianSessionStats.estimatedExtraTokens || 0) + extraTokens,
    });
    setLibrarianChatStats({
        ...librarianChatStats,
        [field]: (librarianChatStats[field] || 0) + 1,
        estimatedExtraTokens: (librarianChatStats.estimatedExtraTokens || 0) + extraTokens,
    });
    notifyAiStatsUpdated();
}

// ════════════════════════════════════════════════════════════════════════════
// Tool Actions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the structured `searchLoreAction` return value. Object carries `text`
 * (Markdown for the LLM) + `titles` (authoritative matched-entry list) and
 * coerces to `text` under string operations so legacy string-consuming call
 * sites don't break.
 *
 * Defined here (not inline) so every return path in `searchLoreAction` uses
 * the same shape — no chance of a no-result branch returning a bare string.
 */
function _searchResult(text, titles = [], opts = {}) {
    const t = typeof text === 'string' ? text : '';
    return {
        text: t,
        titles: Array.isArray(titles) ? titles : [],
        // #23: true when searchLoreAction refunded loreGapSearchCount (search
        // delivered no value). The agentic loop mirrors the refund on its OWN
        // searchCount so the two budgets can't diverge — otherwise the loop
        // withdraws TOOL_SEARCH early while the model was told the search was free.
        refunded: !!opts.refunded,
        toString() { return t; },
        [Symbol.toPrimitive]() { return t; },
    };
}

/**
 * XML <entry>-block manifest. Simpler than the sidecar manifest — no decay
 * hints, no budget headers.
 */
function formatLinkedManifest(entries, summaryLen = 400) {
    if (!entries.length) return '';
    return entries.map(entry => {
        const summary = entry.summary
            || truncateToSentence((entry.content || '').substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen);
        const links = entry.resolvedLinks?.length > 0
            ? ` → ${entry.resolvedLinks.join(', ')}` : '';
        const safeName = escapeXml(entry.title);
        // #20: same fence hole as buildCandidateManifest — a literal </entry> in an
        // author summary broke out of the fence. Shared sanitizer from helpers.js.
        const fenceSafeBody = neutralizeClosingTag(`${entry.title} (${entry.tokenEstimate}tok)${links}\n${summary}`, 'entry');
        return `<entry name="${safeName}">\n${fenceSafeBody}\n</entry>`;
    }).join('\n');
}

/**
 * @param {object} entry
 * @param {Set<string>} excludeTitles - already-injected/shown (trackerKey-shaped `${vaultSource}:${titleLower}`)
 * @param {number} [max=10]
 * @param {Map<string, object[]>} [titleMap] BUG-AUDIT-P1: pre-built map for O(1) lookup.
 *   Keyed by lowercased title → ALL entries with that title (gotcha #50: cross-vault
 *   same-title entries must NOT collapse — a bare-title `resolvedLink` resolves to every
 *   matching vault's entry, deduped/excluded by trackerKey).
 */
function resolveLinkedEntries(entry, excludeTitles, max = 10, titleMap = null) {
    if (!entry.resolvedLinks?.length) return [];
    const linked = [];
    const seen = new Set(); // dedup by trackerKey across multiple link titles
    for (const linkTitle of entry.resolvedLinks) {
        if (linked.length >= max) break;
        const lk = linkTitle.toLowerCase();
        const matches = titleMap
            ? (titleMap.get(lk) || [])
            : vaultIndex.filter(e => e.title.toLowerCase() === lk);
        for (const found of matches) {
            if (linked.length >= max) break;
            const key = `${found.vaultSource || ''}:${found.title.toLowerCase()}`;
            if (seen.has(key)) continue;
            // trackerKey-shaped exclude check (gotcha #50): excludeTitles holds composite
            // `${vaultSource}:${title}` keys, so honor the already-injected/shown set here too.
            if (excludeTitles.has(key)) continue;
            seen.add(key);
            linked.push(found);
        }
    }
    return linked;
}

/**
 * search_lore: search the vault index for entries the pipeline missed.
 * Returns full content for the top BM25 hit per query + linked-entries manifest.
 *
 * **Return contract:** `{ text: string, titles: string[] }`.
 * - `text` is the rendered Markdown the LLM consumes (best hit `### Title\n…`,
 *   linked-entry manifest, other-match counts, or no-result lines).
 * - `titles` is the authoritative list of matched entry titles (best hit +
 *   linked entries). Consumers (agentic-loop activity dropdown, callers that
 *   need to know "which entries did this search surface") MUST read `titles`
 *   directly — NEVER regex-parse `text` for `### ...` headings. Vault content
 *   is freeform Markdown and entries routinely have their own `### Section`
 *   headings; regex-extraction inflates counts and pollutes the Activity feed
 *   with section names (CRIT-LIB-2 fix).
 *
 * Error/empty-result paths return `{ text: '<message>', titles: [] }`.
 *
 * For LLM-side consumers that historically treated this as a plain string,
 * the object overrides `toString()` (and `Symbol.toPrimitive`) to yield `text`
 * — keeps string-coercion call sites working without breaking the structured
 * contract.
 */
export async function searchLoreAction(args) {
    const settings = getSettings();
    const epoch = chatEpoch;
    const debug = settings.debugMode;

    // Accept legacy { query: "..." } in addition to { queries: [...] }.
    let queries = args?.queries;
    if (!queries && args?.query) queries = [args.query];
    if (!Array.isArray(queries)) return _searchResult('No queries provided.');
    queries = queries.map(q => (q || '').trim()).filter(Boolean).slice(0, 4);
    if (queries.length === 0) return _searchResult('No queries provided.');

    if (debug) console.debug('[DLE] searchLore: %d queries received', queries.length);

    if (loreGapSearchCount >= settings.librarianMaxSearches) {
        return _searchResult(`Search limit reached (${settings.librarianMaxSearches} per generation). Work with the lore already provided.`);
    }
    // Increment IMMEDIATELY after guard, before any await: if the AI emits two
    // search_lore calls in one response they start concurrently and both would
    // pass the guard before either increments otherwise.
    setLoreGapSearchCount(loreGapSearchCount + 1);

    if (!fuzzySearchIndex && buildPromise) {
        try { await buildPromise; } catch { /* fall through */ }
    }

    // BUG-AUDIT-P1: O(1) lookups for resolveLinkedEntries.
    // gotcha #50 (P3-7): Map<titleLower, Entry[]> — push ALL same-titled entries so a
    // cross-vault related link surfaces every matching vault's entry, not just the first.
    const titleMap = new Map();
    for (const e of vaultIndex) {
        const lk = e.title.toLowerCase();
        const bucket = titleMap.get(lk);
        if (bucket) bucket.push(e);
        else titleMap.set(lk, [e]);
    }

    // Index never built — record gaps and bail.
    if (!fuzzySearchIndex) {
        console.warn('[DLE] searchLore: vault index not ready — recording %d gap(s)', queries.length);
        for (const query of queries) {
            const failGap = {
                id: gapId(), type: 'search', query,
                reason: `AI searched for "${query}" but vault index was not ready`,
                failureReason: 'index_not_ready',
                createdAt: Date.now(), timestamp: Date.now(), generation: generationCount,
                status: 'pending', frequency: 1, urgency: 'medium',
                hadResults: false, resultTitles: [],
                retryCount: 0, lastAttemptMs: Date.now(),
            };
            const existing = findSimilarGap(loreGaps, query, 'search');
            // Re-flag resurfaces hidden, leaves dismissed alone.
            if (existing) clearHiddenSilently(existing.id);
            const updated = existing
                ? loreGaps.map(g => g === existing ? { ...existing, frequency: existing.frequency + 1, timestamp: Date.now(), retryCount: (existing.retryCount || 0) + 1, lastAttemptMs: Date.now(), failureReason: existing.failureReason || 'index_not_ready' } : g)
                : [...loreGaps, failGap];
            if (debug) console.debug('[DLE] searchLore: gap %s query="%s" reason=index_not_ready retry=%d', existing ? 'merged' : 'created', query, existing ? (existing.retryCount || 0) + 1 : 0);
            if (epoch === chatEpoch) {
                persistGaps(updated);
            } else if (debug) {
                console.debug('[DLE] searchLore: epoch guard — skipped gap persist (index not ready)');
            }
        }
        // Audit Q13 (S5-1): refund counter when nothing was delivered. Increment-first
        // is still the race guard for concurrent search_lore calls; decrement-on-fail
        // keeps the counter aligned with searches that actually returned value.
        setLoreGapSearchCount(Math.max(0, loreGapSearchCount - 1));
        return _searchResult('Lore vault index is still loading. This search did not count against your limit; vault should be ready on next message.', [], { refunded: true });
    }

    // BUG-AUDIT v2.5: dedup keyed by trackerKey (vaultSource:title.toLowerCase()) so
    // a "Alice" injected from vault-a doesn't suppress an unrelated "Alice" from vault-b
    // (or vice versa). The Librarian must still be able to surface the other vault's hit.
    const injectedTitles = new Set();
    const _libVerdictSources = _currentVerdictForChat()?.injectedSources;
    if (_libVerdictSources && Array.isArray(_libVerdictSources)) {
        for (const src of _libVerdictSources) {
            if (src.title) injectedTitles.add(`${src.vaultSource || ''}:${src.title.toLowerCase()}`);
        }
    }

    // BUG-FIX-1: One winner across all queries (full content) + up to 3 graph
    // edges (manifest only). Max 4 entries returned regardless of query count.
    const shownTitles = new Set(injectedTitles);
    const allResultTitles = [];
    let totalTokens = 0;

    let bestHit = null;
    let bestScore = -Infinity;
    let bestQuery = null;
    const perQueryCounts = new Map();
    const allMatchedKeys = new Set(); // distinct trackerKeys across all queries — for accurate "other matches"
    const noResultQueries = [];

    for (const query of queries) {
        const hits = queryBM25(
            fuzzySearchIndex, query,
            settings.librarianMaxResults,
            settings.fuzzySearchMinScore || 0.5,
        );
        const filtered = hits.filter(h => !shownTitles.has(`${h.entry.vaultSource || ''}:${h.entry.title.toLowerCase()}`) && !h.entry.guide);

        if (debug) console.debug('[DLE] searchLore: query="%s" — %d BM25 hits after filter', query, filtered.length);

        if (filtered.length === 0) {
            noResultQueries.push(query);
            trackUnmetQuery(query);
            const existing = findSimilarGap(loreGaps, query, 'search');
            if (existing) clearHiddenSilently(existing.id);
            const gapUpdate = existing
                ? loreGaps.map(g => g === existing ? { ...existing, frequency: existing.frequency + 1, timestamp: Date.now(), hadResults: false, retryCount: (existing.retryCount || 0) + 1, lastAttemptMs: Date.now(), failureReason: existing.failureReason || 'no_results' } : g)
                : [...loreGaps, { id: gapId(), type: 'search', query, reason: `AI searched for "${query}" during generation`, failureReason: 'no_results', createdAt: Date.now(), timestamp: Date.now(), generation: generationCount, status: 'pending', frequency: 1, urgency: 'medium', hadResults: false, resultTitles: [], retryCount: 0, lastAttemptMs: Date.now() }];
            if (debug) console.debug('[DLE] searchLore: no-result gap %s for "%s" retry=%d', existing ? 'merged' : 'created', query, existing ? (existing.retryCount || 0) + 1 : 0);
            if (epoch === chatEpoch) {
                persistGaps(gapUpdate);
            } else if (debug) {
                console.debug('[DLE] searchLore: epoch guard — skipped gap persist');
            }
            continue;
        }

        perQueryCounts.set(query, filtered.length);
        for (const h of filtered) allMatchedKeys.add(`${h.entry.vaultSource || ''}:${h.entry.title.toLowerCase()}`);

        if (filtered[0].score > bestScore) {
            bestScore = filtered[0].score;
            bestHit = filtered[0].entry;
            bestQuery = query;
        }

        // Lore now exists — clear any prior no-result gap for this query.
        const existingGap = findSimilarGap(loreGaps, query, 'search');
        if (existingGap) {
            const cleaned = loreGaps.filter(g => g !== existingGap);
            if (debug) console.debug('[DLE] searchLore: gap cleared (results found) query="%s" priorReason=%s priorRetries=%d gapsBefore=%d after=%d', query, existingGap.failureReason || 'unknown', existingGap.retryCount || 0, loreGaps.length, cleaned.length);
            if (epoch === chatEpoch) persistGaps(cleaned);
        }
    }

    const resultParts = [];

    if (bestHit) {
        if (debug) console.debug('[DLE] searchLore: best hit="%s" (score=%.2f)', bestHit.title, bestScore);
        shownTitles.add(`${bestHit.vaultSource || ''}:${bestHit.title.toLowerCase()}`);
        allResultTitles.push(bestHit.title);
        totalTokens += bestHit.tokenEstimate || 0;

        resultParts.push(`### ${bestHit.title}\n${bestHit.content || ''}`);

        // Up to 3 direct graph edges, manifest format only.
        const linked = resolveLinkedEntries(bestHit, shownTitles, 3, titleMap);
        if (linked.length > 0) {
            for (const le of linked) shownTitles.add(`${le.vaultSource || ''}:${le.title.toLowerCase()}`);
            allResultTitles.push(...linked.map(le => le.title));
            totalTokens += linked.reduce((s, e) => s + Math.min(e.tokenEstimate || 0, 100), 0);
            resultParts.push(`### Related entries:\n${formatLinkedManifest(linked)}`);
        }

        // Count DISTINCT matched entries not already surfaced (best hit + linked), keyed by
        // trackerKey. The old `sum(perQueryCounts) - 1` double-counted entries matching
        // multiple queries and never subtracted shown linked entries.
        const totalOtherMatches = [...allMatchedKeys].filter(k => !shownTitles.has(k)).length;
        if (totalOtherMatches > 0) {
            const otherQueries = [...perQueryCounts.keys()].filter(q => q !== bestQuery || perQueryCounts.get(q) > 1);
            if (otherQueries.length > 0) {
                resultParts.push(`*${totalOtherMatches} other match${totalOtherMatches !== 1 ? 'es' : ''} found across queries: ${otherQueries.map(q => `"${q}"`).join(', ')}. Refine your query for specifics.*`);
            }
        }
    }

    for (const query of noResultQueries) {
        resultParts.push(`No matching entries found for "${query}".`);
    }

    const resultText = resultParts.join('\n\n---\n\n');
    // BUG-AUDIT-H19: prefer real tokenEstimate sum; length/4 is fallback only.
    const estimatedTokens = totalTokens > 0 ? totalTokens : Math.ceil(resultText.length / 4);

    if (debug) console.debug('[DLE] searchLore: ~%d tokens, %d results', estimatedTokens, allResultTitles.length);

    const logEntry = {
        type: 'search',
        query: queries.join('; '),
        resultCount: allResultTitles.length,
        resultTitles: allResultTitles,
        tokens: estimatedTokens,
        timestamp: Date.now(),
        generation: generationCount,
    };
    // Epoch guard (mirrors the persistGaps guards above): if the chat switched during
    // the multi-second agentic await, don't pollute the now-current chat's Activity feed
    // or per-chat Librarian stats with this stale search (CRIT-LIB-1 class, SEARCH path).
    if (epoch === chatEpoch) {
        recordSessionActivity(logEntry);
        notifyLoreGapsChanged(); // re-render Activity sub-tab even when persistGaps didn't fire
        updateAnalytics('totalGapSearches');
        incrementStats('searchCalls', estimatedTokens);
    }

    if (allResultTitles.length === 0) {
        // Audit Q13 (S5-1): all queries returned zero hits — search delivered no value,
        // refund the counter so the AI can keep working without the no-result hit
        // eating its budget. Race guard preserved by the increment-first pattern above.
        setLoreGapSearchCount(Math.max(0, loreGapSearchCount - 1));
        return _searchResult(`No entries found for ${queries.map(q => `"${q}"`).join(', ')}. This search did not count against your limit. If this information is important to the scene, use flag_lore to record the gap.`, [], { refunded: true });
    }
    // CRIT-LIB-2: caller (agentic-loop) consumes `titles` directly. NEVER regex
    // `text` for `### ...` headings — vault content has its own subheadings.
    return _searchResult(resultText, allResultTitles);
}

/**
 * flag_lore: flag a lore gap for later review.
 * @param {{ title: string, reason: string, urgency?: string }} args
 * @param {number} [callerEpoch] The agentic loop's captured epoch. When the
 *   chat switched during the multi-second await before this call, the loop
 *   passes its start-of-loop epoch so the activity/analytics side-effects below
 *   self-guard against polluting the now-current chat (mirrors
 *   searchLoreAction's internal epoch guard). Defaults to this call's own
 *   `chatEpoch` capture for direct/test callers — same semantics as searchLore.
 */
export async function flagLoreAction(args, callerEpoch) {
    const epoch = callerEpoch !== undefined ? callerEpoch : chatEpoch;
    const debug = getSettings().debugMode;
    const title = args?.title?.trim();
    const reason = args?.reason?.trim();
    if (!title) return 'No title provided.';
    if (!reason) return 'No reason provided.';

    const urgency = ['low', 'medium', 'high'].includes(args?.urgency) ? args.urgency : 'medium';
    const flagType = ['gap', 'update'].includes(args?.flag_type) ? args.flag_type : 'gap';
    const entryTitle = args?.entry_title?.trim() || null;

    if (debug) console.debug('[DLE] flagLore: title="%s" flagType=%s urgency=%s', title, flagType, urgency);

    // Merge with existing flag of same topic + subtype.
    const existingGap = findSimilarGap(loreGaps, title, 'flag', flagType);
    // Re-flag resurfaces hidden (cleared); dismissed is left alone but still
    // gets silent urgency escalation so post-undismiss state reflects reality.
    if (existingGap) clearHiddenSilently(existingGap.id);
    let updatedGaps;
    if (existingGap) {
        if (debug) console.debug('[DLE] flagLore: merging with existing gap (freq %d→%d)', existingGap.frequency, existingGap.frequency + 1);
        const urgencyOrder = { low: 0, medium: 1, high: 2 };
        const escalatedUrgency = urgencyOrder[urgency] > urgencyOrder[existingGap.urgency]
            ? urgency : existingGap.urgency;
        const mergedReason = existingGap.reason.includes(reason)
            ? existingGap.reason : `${existingGap.reason}; ${reason}`;
        const updated = {
            ...existingGap,
            frequency: existingGap.frequency + 1,
            timestamp: Date.now(),
            urgency: escalatedUrgency,
            reason: mergedReason,
        };
        updatedGaps = loreGaps.map(g => g === existingGap ? updated : g);
    } else {
        if (debug) console.debug('[DLE] flagLore: creating new gap record');
        const newGap = {
            id: gapId(),
            type: 'flag',
            subtype: flagType,
            entryTitle,
            query: title,
            reason,
            createdAt: Date.now(),
            timestamp: Date.now(),
            generation: generationCount,
            status: 'pending',
            frequency: 1,
            urgency,
            hadResults: false,
            resultTitles: null,
        };
        updatedGaps = [...loreGaps, newGap];
    }
    if (epoch === chatEpoch) {
        const ok = persistGaps(updatedGaps);
        if (!ok) console.warn('[DLE] flagLore: persist failed (no chat metadata) for "%s"', title);
        else if (debug) console.debug('[DLE] flagLore: persisted — %s', existingGap ? 'merged' : 'new');
    } else {
        if (debug) console.debug('[DLE] flagLore: epoch guard — skipped persist for "%s"', title);
    }

    const logEntry = {
        type: 'flag',
        subtype: flagType,
        entryTitle,
        query: title,
        resultCount: 0,
        resultTitles: [],
        tokens: 10,
        timestamp: Date.now(),
        generation: generationCount,
        urgency,
    };
    // Epoch guard (mirrors searchLoreAction's SEARCH-path guard and the persist
    // guard above): if the chat switched during the multi-second agentic await,
    // don't pollute the now-current chat's Activity feed, session/chat stats, or
    // all-time analytics with this stale flag. Self-defending so the action is
    // symmetric with searchLoreAction rather than load-bearing on every caller.
    if (epoch === chatEpoch) {
        recordSessionActivity(logEntry);
        notifyLoreGapsChanged();
        updateAnalytics('totalGapFlags');
        incrementStats('flagCalls', 10); // ~10 tokens for the confirmation string
    } else if (debug) {
        console.debug('[DLE] flagLore: epoch guard — skipped activity/analytics for "%s"', title);
    }

    if (flagType === 'update' && entryTitle) {
        return `Flagged update: "${title}" (entry: ${entryTitle}). Do not acknowledge this flag — continue seamlessly.`;
    }
    return `Flagged gap: "${title}". Do not acknowledge this flag — continue seamlessly.`;
}
