/**
 * DeepLore Enhanced — Entry Matching Engine
 * Extracted from pipeline.js for testability (no SillyTavern imports).
 *
 * Performs keyword matching with: constants, bootstrap, warmup/probability/cooldown
 * gates, cascade links, recursive scanning, BM25 fuzzy search, occurrence-weighted
 * tiebreakers, and active-character boost.
 */

import { buildScanText } from '../../core/utils.js';
import { comparePriority } from '../helpers.js';
import { testEntryMatch, testPrimaryMatchOnly, countKeywordOccurrences } from '../../core/matching.js';
import { vaultIndex, cooldownTracker, trackerKey, fuzzySearchIndex } from '../state.js';
import { queryBM25 } from '../vault/bm25.js';

const MAX_RECURSION_TEXT = 50000;

/**
 * @param {object[]|null} [snapshot] - Defaults to vaultIndex.
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string>, probabilitySkipped: Array, warmupFailed: Array, fuzzyStats: object, refineKeyBlocked: Array }}
 */
export function matchEntries(chat, snapshot = null, { settings, characterName } = {}) {
    if (!settings) throw new Error('matchEntries: settings parameter is required when called from match.js');
    const entries = snapshot || vaultIndex;
    const activeCharName = characterName !== undefined ? characterName : null;
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();
    /** @type {Array<{title: string, probability: number, roll: number}>} */
    const probabilitySkipped = [];
    /** @type {Array<{title: string, needed: number, found: number}>} */
    const warmupFailed = [];
    /** @type {Array<{title: string, primaryKey: string, refineKeys: string[]}>} */
    const refineKeyBlocked = [];

    // Constants always, regardless of scan depth.
    for (const entry of entries) {
        if (entry.constant) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, '(constant)');
        }
    }

    // Bootstrap (cold-start) when chat is short.
    if (chat.length <= settings.newChatThreshold) {
        for (const entry of entries) {
            if (entry.bootstrap && !matchedSet.has(entry)) {
                matchedSet.add(entry);
                matchedKeys.set(entry.title, '(bootstrap)');
            }
        }
    }

    // Memoize buildScanText by depth — shared across keyword + BM25 paths.
    const scanTextMemo = new Map();
    function getScanText(depth) {
        if (!scanTextMemo.has(depth)) scanTextMemo.set(depth, buildScanText(chat, depth));
        return scanTextMemo.get(depth);
    }

    // scanDepth=0 → AI-only mode, skip keyword matching entirely.
    if (settings.scanDepth > 0) {
        const globalScanText = getScanText(settings.scanDepth);

        for (const entry of entries) {
            if (entry.constant) continue;

            const scanText = entry.scanDepth !== null
                ? getScanText(entry.scanDepth)
                : globalScanText;

            const key = testEntryMatch(entry, scanText, settings);
            if (!key && entry.refineKeys?.length > 0) {
                // Primary hit but refine keys blocked.
                const primaryHit = testPrimaryMatchOnly(entry, scanText, settings);
                if (primaryHit) {
                    refineKeyBlocked.push({ title: entry.title, vaultSource: entry.vaultSource || '', primaryKey: primaryHit, refineKeys: [...entry.refineKeys] });
                }
            }
            if (key) {
                if (entry.warmup !== null) {
                    const occurrences = countKeywordOccurrences(entry, scanText, settings);
                    if (occurrences < entry.warmup) {
                        warmupFailed.push({ title: entry.title, vaultSource: entry.vaultSource || '', needed: entry.warmup, found: occurrences });
                        continue;
                    }
                }

                // probability=0 = never fires (distinct from null = always).
                if (entry.probability === 0) {
                    probabilitySkipped.push({ title: entry.title, vaultSource: entry.vaultSource || '', probability: 0, roll: 0 });
                    continue;
                }
                if (entry.probability !== null && entry.probability < 1.0) {
                    const roll = Math.random();
                    if (roll > entry.probability) {
                        probabilitySkipped.push({ title: entry.title, vaultSource: entry.vaultSource || '', probability: entry.probability, roll });
                        continue;
                    }
                }

                const remaining = cooldownTracker.get(trackerKey(entry));
                if (remaining !== undefined && remaining > 0) {
                    continue;
                }

                matchedSet.add(entry);
                matchedKeys.set(entry.title, key);
            }
        }

        const titleMap = new Map(entries.map(e => [e.title.toLowerCase(), e]));

        if (settings.characterContextScan && activeCharName) {
            const nameLower = activeCharName.toLowerCase();
            const charEntry = titleMap.get(nameLower) || entries.find(e =>
                e.keys.some(k => k.toLowerCase() === nameLower)
            );
            if (charEntry && !matchedSet.has(charEntry)) {
                matchedSet.add(charEntry);
                matchedKeys.set(charEntry.title, '(active character)');
            }
        }

        // Cascade links: same gates as direct matches except warmup.
        const cascadeSource = [...matchedSet];
        for (const entry of cascadeSource) {
            if (!entry.cascadeLinks || entry.cascadeLinks.length === 0) continue;
            for (const linkTitle of entry.cascadeLinks) {
                const linked = titleMap.get(linkTitle.toLowerCase());
                if (linked && !matchedSet.has(linked)) {
                    if (linked.cooldown !== null) {
                        const remaining = cooldownTracker.get(trackerKey(linked));
                        if (remaining !== undefined && remaining > 0) continue;
                    }
                    if (linked.probability === 0) continue;
                    if (linked.probability !== null && linked.probability < 1.0 && Math.random() > linked.probability) continue;
                    // BUG-035: cascade is an explicit author relationship, not a keyword
                    // trigger — warmup doesn't apply.
                    matchedSet.add(linked);
                    matchedKeys.set(linked.title, `(cascade from: ${entry.title})`);
                }
            }
        }

        if (settings.recursiveScan && settings.maxRecursionSteps > 0) {
            let step = 0;
            let newlyMatched = new Set(matchedSet);

            while (newlyMatched.size > 0 && step < settings.maxRecursionSteps) {
                step++;

                let recursionText = [...newlyMatched]
                    .filter(e => !e.excludeRecursion)
                    .map(e => e.content)
                    .join('\n');
                if (recursionText.length > MAX_RECURSION_TEXT) {
                    recursionText = recursionText.substring(0, MAX_RECURSION_TEXT);
                }

                if (!recursionText.trim()) break;

                newlyMatched = new Set();

                for (const entry of entries) {
                    if (matchedSet.has(entry)) continue;
                    if (entry.constant) continue;

                    const key = testEntryMatch(entry, recursionText, settings);
                    if (key) {
                        if (entry.cooldown !== null) {
                            const remaining = cooldownTracker.get(trackerKey(entry));
                            if (remaining !== undefined && remaining > 0) continue;
                        }
                        if (entry.probability === 0) continue;
                        if (entry.probability !== null && entry.probability < 1.0 && Math.random() > entry.probability) continue;
                        if (entry.warmup !== null) {
                            const occurrences = countKeywordOccurrences(entry, recursionText, settings);
                            if (occurrences < entry.warmup) continue;
                        }
                        matchedSet.add(entry);
                        newlyMatched.add(entry);
                        matchedKeys.set(entry.title, `${key} (recursion step ${step})`);
                    }
                }
            }
        }
    }

    // BM25 fuzzy search supplements keyword matches with TF-IDF scored results.
    const fuzzyStats = { active: false, candidates: 0, matched: 0, threshold: settings.fuzzySearchMinScore || 0.5 };
    if (settings.fuzzySearchEnabled && fuzzySearchIndex && settings.scanDepth > 0) {
        fuzzyStats.active = true;
        const fuzzyText = getScanText(settings.scanDepth);
        const bm25Results = queryBM25(fuzzySearchIndex, fuzzyText, 20, fuzzyStats.threshold);
        fuzzyStats.candidates = bm25Results.length;
        for (const result of bm25Results) {
            const entry = result.entry;
            if (matchedSet.has(entry)) continue;
            if (entry.constant) continue;

            const remaining = cooldownTracker.get(trackerKey(entry));
            if (remaining !== undefined && remaining > 0) continue;

            // BUG-AUDIT-8: BM25 fuzzy matches must also honor warmup.
            if (entry.warmup && entry.warmup >= 1) {
                const scanText = getScanText(entry.scanDepth ?? settings.scanDepth);
                const occurrences = countKeywordOccurrences(entry, scanText, settings);
                if (occurrences < entry.warmup) continue;
            }

            if (entry.probability === 0) continue;
            if (entry.probability !== null && entry.probability < 1.0 && Math.random() > entry.probability) continue;

            matchedSet.add(entry);
            matchedKeys.set(entry.title, `(fuzzy, score: ${result.score.toFixed(1)})`);
            fuzzyStats.matched++;
        }
    }

    // Default: priority ascending = higher priority. #16: settings.priorityReversed flips.
    const matched = [...matchedSet].sort((a, b) => comparePriority(a, b, settings.priorityReversed) || a.title.localeCompare(b.title));

    // Tiebreak within priority group using hit count.
    if (settings.keywordOccurrenceWeighting) {
        // BUG-AUDIT-H13: use the memo, not a fresh buildScanText.
        const scanText = getScanText(settings.scanDepth);
        const occurrenceCache = new Map();
        const getCachedCount = (entry) => {
            let count = occurrenceCache.get(entry.title);
            if (count === undefined) {
                count = countKeywordOccurrences(entry, scanText, settings);
                occurrenceCache.set(entry.title, count);
            }
            return count;
        };
        matched.sort((a, b) => {
            const pri = comparePriority(a, b, settings.priorityReversed);
            if (pri !== 0) return pri;
            return getCachedCount(b) - getCachedCount(a) || a.title.localeCompare(b.title);
        });
    }

    return { matched, matchedKeys, probabilitySkipped, warmupFailed, fuzzyStats, refineKeyBlocked };
}
