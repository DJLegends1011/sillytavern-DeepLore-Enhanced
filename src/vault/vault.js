/**
 * DeepLore — Vault index building and cache management
 */
import { getTokenCountAsync } from '../../../../../tokenizers.js';
import { oai_settings } from '../../../../../openai.js';
import { main_api, amount_gen } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import { simpleHash } from '../../core/utils.js';
import { fetchAllMdFiles, fetchFieldDefinitions, diagnoseFetchFailure } from './obsidian-api.js';
import {
    vaultIndex, indexTimestamp, indexing, buildPromise,
    aiSearchCache, previousIndexSnapshot, trackerKey,
    setVaultIndex, setIndexTimestamp, setIndexing, setBuildPromise,
    setIndexEverLoaded, resetAiSearchCache, setPreviousIndexSnapshot,
    setVaultAvgTokens,
    setFuzzySearchIndex, fuzzySearchIndex,
    setMentionWeights, mentionWeights,
    setFolderList,
    setEntityNameSet, setEntityShortNameRegexes, entityShortNameRegexes,
    setLastVaultFailureCount, setLastVaultAttemptCount,
    notifyIndexUpdated,
    generationCount, lastIndexGenerationCount, setLastIndexGenerationCount,
    chatEpoch, buildEpoch,
    fieldDefinitions, setFieldDefinitions,
    setIndexBuildReport,
    entityRegexVersion,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS, parseFieldDefinitionYaml } from '../fields.js';
import { resolveLinks } from '../../core/matching.js';
import { parseVaultFile } from '../../core/pipeline.js';
import { takeIndexSnapshot, detectChanges, snapshotKey } from '../../core/sync.js';
import { showChangesToast } from './sync.js';
import { saveIndexToCache, loadIndexFromCache, pruneOrphanedCacheKeys } from './cache.js';
import { dedupError, dedupWarning } from '../toast-dedup.js';
import { pushEvent } from '../diagnostics/interceptors.js';
import { buildBM25Index, setDebugMode as setBm25DebugMode } from './bm25.js';

import { computeEntityDerivedState, deduplicateMultiVault, detectCrossVaultDuplicates, PARTIAL_FETCH_FAILURE_THRESHOLD, conflictModeMessage } from './vault-pure.js';
export { computeEntityDerivedState, deduplicateMultiVault, detectCrossVaultDuplicates };

// P3 (2026-05-22): incremental derived-state updates for reuse-sync.
// finalizeIndex's full-rebuild path is O(N²) for mentionWeights and O(N) for
// BM25 tokenization. Reuse-sync ticks typically touch <5% of entries — see
// vault-incremental.js for the algorithms and shouldUseIncremental threshold.
import {
    diffEntries, shouldUseIncremental,
    incrementalMentionWeights, incrementalBM25Update, incrementalEntityRegexes,
    buildFullMentionWeights,
} from './vault-incremental.js';

// BUG-381: this is a toastr display duration, not a fetch/abort timeout.
const OBSIDIAN_TOAST_TIMEOUT = 15000;
const CACHE_FALLBACK_TOAST_TIMEOUT = 10000;

// V-C1: PARTIAL_FETCH_FAILURE_THRESHOLD lives in vault-pure.js so the warning
// toast (here), the cache-skip flag (here), and the classifyReuseFetch helper
// (used by tests) all share one source — drift used to re-introduce the bug
// where a partial vault got cached as a deletion.
function isPartialFetchFailure(failed, total) {
    const rate = total > 0 ? failed / total : 0;
    return failed >= PARTIAL_FETCH_FAILURE_THRESHOLD.absolute || rate >= PARTIAL_FETCH_FAILURE_THRESHOLD.rate;
}

/**
 * L11b: decide whether a hash-matched reuse candidate is safe to reuse verbatim
 * under merge-mode conflict resolution.
 *
 * In merge mode (`multiVaultConflictResolution='merge'`) the committed index holds
 * ONE entry per title whose `content` is the concatenation of every member
 * (m1 + sep + m2 + …) but — by BUG-378 — whose `_contentHash` is preserved as the
 * hash of the FIRST member's on-disk file. So when the reuse-sync loop re-fetches
 * that first member's file, `existing._contentHash === fileHash` is TRUE and the
 * naive fast-path would push the already-merged blob. The dedup pass then re-merges
 * it with the freshly-parsed remaining members → m1+m2+m2, growing unbounded on
 * every tick (reuse ≠ full build).
 *
 * Persisted markers don't help — `cache.js` strips `_`-prefixed fields (except a
 * small whitelist) on save, so any `_mergedFrom` flag dies on hydrate. Instead we
 * verify structurally: a genuine single-file entry parses back to byte-identical
 * content, while a merged blob does not. Mismatch ⇒ refuse reuse so the entry is
 * re-parsed fresh and the dedup pass rebuilds the merge cleanly from members
 * (== full build).
 *
 * Pure + exported so the reproduce-test drives the REAL predicate, not a copy.
 * Non-merge modes never call this (the loop only invokes it when `mergeMode`), so
 * the non-merge reuse decision is unaffected.
 *
 * @param {object|null} existing - the reuse candidate from the committed index
 * @param {object|null} freshParsed - a fresh `parseVaultFile` of the candidate's own file
 * @returns {boolean} true if `existing` is a genuine single-file entry safe to reuse
 */
export function canReuseMergedCandidate(existing, freshParsed) {
    if (!existing || !freshParsed) return false;
    // A merged blob's content (m1+sep+m2…) never matches a fresh parse of the
    // single member file (m1). Only identical content is a genuine single entry.
    return freshParsed.content === existing.content;
}

// Module-scoped: resets only on page refresh, so periodic rebuilds stay silent.
let _parserLedgerToastShown = false;

/**
 * BUG-370: Compute derived fields (mentionWeights, folderList, vaultAvgTokens).
 * Shared with hydrateFromCache so cold-start sessions don't run with degraded
 * scoring until a full rebuild completes.
 *
 * P3 (2026-05-22): When `previousEntries` is supplied AND the changed-fraction
 * stays below the threshold, mentionWeights is updated incrementally via
 * `incrementalMentionWeights()`. Output is byte-equivalent to the full path —
 * pinned by test/vault.test.mjs section L (L1).
 */
function computeDerivedIndexFields(entries, settings, previousEntries) {
    setBm25DebugMode(settings?.debugMode);

    const totalTokens = entries.reduce((sum, e) => sum + (e.tokenEstimate || 0), 0);
    setVaultAvgTokens(entries.length > 0 ? totalTokens / entries.length : 0);

    // mentionWeights — try incremental path when prev entries available.
    let weights = null;
    if (previousEntries && previousEntries.length > 0 && entries.length > 0) {
        const diff = diffEntries(previousEntries, entries);
        const changed = diff.added.length + diff.removed.length + diff.modified.length;
        if (shouldUseIncremental(changed, entries.length)) {
            weights = incrementalMentionWeights(mentionWeights, previousEntries, entries, diff);
            if (settings?.debugMode) {
                console.debug(`[DLE] mentionWeights incremental: ${diff.added.length}+, ${diff.removed.length}-, ${diff.modified.length}~ → ${weights.size} pairs`);
            }
        }
    }
    if (weights === null) {
        // Full rebuild — delegates to the single shared builder in
        // vault-incremental.js (R6, 2026-05-29). The builder IS the reference
        // copy the section-L equivalence + T-L6a tests run, so production and the
        // reference can no longer drift (collapses gotcha #55's "hand-sync 3
        // copies" mandate to two: this builder + the separate incremental delta).
        // Its keyOf (vaultSource:title) == trackerKey, so cross-vault same-title
        // identity is preserved (gotcha #50); the BUG-374 algorithm (one combined
        // regex per target + pre-lowered content, O(N × total_content)) is intact.
        weights = buildFullMentionWeights(entries);
        if (settings?.debugMode) {
            console.debug(`[DLE] Built mention weights: ${weights.size} pairs (full)`);
        }
    }
    setMentionWeights(weights);

    {
        const folderCounts = new Map();
        for (const entry of entries) {
            if (entry.folderPath) {
                const parts = entry.folderPath.split('/');
                for (let i = 1; i <= parts.length; i++) {
                    const ancestor = parts.slice(0, i).join('/');
                    folderCounts.set(ancestor, (folderCounts.get(ancestor) || 0) + 1);
                }
            }
        }
        const list = [...folderCounts.entries()]
            .map(([path, entryCount]) => ({ path, entryCount }))
            .sort((a, b) => b.entryCount - a.entryCount);
        setFolderList(list);
    }
}

async function finalizeIndex({ entries, settings, skipCacheSave = false, previousEntries = null }) {
    resolveLinks(vaultIndex);

    // Strip dangling requires/excludes/cascade_links so the pipeline doesn't trip on them
    // every generation. Originals preserved on `_original*` fields so the health check
    // can still surface broken refs.
    {
        const validTitles = new Set(entries.map(e => e.title.toLowerCase()));
        const filterValid = (arr) => arr.filter(ref => validTitles.has(String(ref).toLowerCase()));
        for (const entry of entries) {
            if (Array.isArray(entry.requires) && entry.requires.length) {
                const cleaned = filterValid(entry.requires);
                if (cleaned.length !== entry.requires.length) {
                    entry._originalRequires = entry.requires.slice();
                    entry.requires = cleaned;
                }
            }
            if (Array.isArray(entry.excludes) && entry.excludes.length) {
                const cleaned = filterValid(entry.excludes);
                if (cleaned.length !== entry.excludes.length) {
                    entry._originalExcludes = entry.excludes.slice();
                    entry.excludes = cleaned;
                }
            }
            if (Array.isArray(entry.cascadeLinks) && entry.cascadeLinks.length) {
                const cleaned = filterValid(entry.cascadeLinks);
                if (cleaned.length !== entry.cascadeLinks.length) {
                    entry._originalCascadeLinks = entry.cascadeLinks.slice();
                    entry.cascadeLinks = cleaned;
                }
            }
        }
    }

    computeDerivedIndexFields(entries, settings, previousEntries);

    // Capture pre-rebuild state for cache-invalidation diagnostic.
    const _preRegexVersion = entityRegexVersion;
    const _preCacheResultCount = aiSearchCache?.results?.length ?? 0;
    const _preCacheHadHash = !!aiSearchCache?.hash;

    // P3: Try incremental entity-regex update when prev entries available + diff small.
    // Otherwise fall back to the full path in vault-pure.js.
    //
    // Correctness: incrementalEntityRegexes still calls setEntityShortNameRegexes,
    // which bumps entityRegexVersion. BUG-394 / AI cache invalidation invariant
    // preserved — pinned by test L7.
    let entityIncremental = false;
    if (previousEntries && previousEntries.length > 0 && entries.length > 0) {
        const diff = diffEntries(previousEntries, entries);
        const changed = diff.added.length + diff.removed.length + diff.modified.length;
        if (shouldUseIncremental(changed, entries.length)) {
            const { names, regexes } = incrementalEntityRegexes(entries, entityShortNameRegexes);
            setEntityNameSet(names);
            setEntityShortNameRegexes(regexes);
            entityIncremental = true;
            if (settings?.debugMode) {
                console.debug(`[DLE] entity regexes incremental: ${names.size} names, ${regexes.size} regexes`);
            }
        }
    }
    if (!entityIncremental) {
        computeEntityDerivedState(entries);
    }

    // P3: BM25 incremental update when fuzzy/librarian search is on AND prev
    // entries available AND diff is small. The math is delicate — see
    // vault-incremental.js. Equivalence is pinned by test L4.
    if (settings.fuzzySearchEnabled || settings.librarianSearchEnabled) {
        let newBm25 = null;
        if (previousEntries && previousEntries.length > 0 && entries.length > 0 && fuzzySearchIndex) {
            const diff = diffEntries(previousEntries, entries);
            const changed = diff.added.length + diff.removed.length + diff.modified.length;
            if (shouldUseIncremental(changed, entries.length)) {
                newBm25 = incrementalBM25Update(fuzzySearchIndex, diff);
                if (newBm25 && settings?.debugMode) {
                    console.debug(`[DLE] BM25 incremental: ${diff.added.length}+, ${diff.removed.length}-, ${diff.modified.length}~ → ${newBm25.docs.size} docs`);
                }
            }
        }
        // Fall back to full build when incremental path declined (no prev index,
        // too many changes, or pre-H-12 index without invertedIndex).
        if (!newBm25) newBm25 = buildBM25Index(entries);
        setFuzzySearchIndex(newBm25);
    } else {
        setFuzzySearchIndex(null);
    }

    // Log the invalidation reason so "why did my cache go stale mid-session" is
    // diagnosable post-facto without repro.
    if (_preCacheHadHash || _preCacheResultCount > 0) {
        pushEvent('cache_invalidate', {
            trigger: 'index_rebuild',
            regexVersionBefore: _preRegexVersion,
            regexVersionAfter: entityRegexVersion,
            cachedResultsCleared: _preCacheResultCount,
            entriesAfter: entries.length,
        });
        console.debug('[DLE][DIAG] aiSearchCache cleared: trigger=index_rebuild regex v%d→v%d cachedResults=%d entriesAfter=%d',
            _preRegexVersion, entityRegexVersion, _preCacheResultCount, entries.length);
    }
    resetAiSearchCache();

    const newSnapshot = takeIndexSnapshot(vaultIndex);
    if (previousIndexSnapshot) {
        const changes = detectChanges(previousIndexSnapshot, newSnapshot);
        if (changes.hasChanges) {
            if (settings.showSyncToasts) {
                showChangesToast(changes);
            }
            if (settings.debugMode) {
                console.log('[DLE] Vault changes detected:', changes);
            }
        }
    }
    setPreviousIndexSnapshot(newSnapshot);

    setIndexEverLoaded(true);

    if (entries.length >= 500 && !finalizeIndex._largeVaultWarned) {
        finalizeIndex._largeVaultWarned = true;
        toastr.info(
            `Large vault detected (${entries.length} entries). Consider using folder filtering or reducing scan depth for better performance.`,
            'DeepLore',
            { timeOut: 8000 },
        );
    }

    // BUG-026: Mutates the live settings.analyticsData; persisted later by
    // saveSettingsDebounced(). Without this, renamed/deleted entries grow unboundedly.
    const analytics = settings.analyticsData;
    if (analytics) {
        const activeKeys = new Set(vaultIndex.map(e => trackerKey(e)));
        for (const key of Object.keys(analytics)) {
            // BUG-AUDIT-DP01: `_`-prefixed keys (e.g. `_librarian`) are sub-objects, not
            // tracker keys — were being silently wiped on every rebuild.
            if (key.startsWith('_')) continue;
            if (!activeKeys.has(key)) delete analytics[key];
        }
    }

    // Prune sequenced AFTER save success: a failed save racing concurrent prune used to
    // delete the prior good cache key and leave nothing for the next hydration.
    if (!skipCacheSave) {
        saveIndexToCache(entries)
            .then(() => pruneOrphanedCacheKeys())
            .catch(err => console.warn('[DLE] Cache save/prune failed:', err?.message));
    }

    pushEvent('index_build', { entryCount: entries.length, skipCacheSave });

    notifyIndexUpdated();
}

/**
 * Build the vault index by fetching all files directly from Obsidian.
 */
export async function buildIndex() {
    if (indexing) {
        if (getSettings().debugMode) console.debug('[DLE] Index build already in progress, awaiting existing build');
        return buildPromise;
    }

    // BUG-010: Install buildPromise BEFORE setIndexing(true) so any sync observer
    // that sees indexing===true always finds a populated promise. Deferred-promise
    // pattern: install outer promise synchronously, IIFE settles it.
    // L-43: the deferred only ever RESOLVES — the IIFE's try/catch swallows every
    // build error (catch calls dedupError, never re-throws) and the finally always
    // calls _buildResolve(). So a reject capture was dead plumbing: even if the
    // catch/finally itself threw, _buildResolve() in the finally settles first and a
    // promise can't un-resolve. Dropped the reject; the IIFE's trailing .catch now just
    // swallows-and-logs any post-resolve throw to avoid an unhandled rejection.
    let _buildResolve;
    const promise = new Promise((res) => { _buildResolve = res; });
    setBuildPromise(promise);
    setIndexing(true);
    let capturedEpoch = buildEpoch;
    (async () => {
    const _buildStart = performance.now();
    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    try {
        capturedEpoch = buildEpoch;
        const isZombie = () => buildEpoch !== capturedEpoch;
        if (enabledVaults.length === 0) {
            throw new Error('No enabled vaults configured');
        }

        // BUG-F4: Resolve to local first; commit to state once before parsing so
        // entries can't be parsed under inconsistent defs if fallback logic triggers.
        const primaryVault = enabledVaults[0];
        const fieldDefPath = settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
        let loadedFieldDefs = [...DEFAULT_FIELD_DEFINITIONS];
        try {
            const fdResult = await fetchFieldDefinitions(primaryVault.host, primaryVault.port, primaryVault.apiKey, fieldDefPath, !!primaryVault.https);
            if (fdResult.ok && fdResult.content) {
                const { definitions, errors } = parseFieldDefinitionYaml(fdResult.content);
                if (definitions.length > 0) {
                    loadedFieldDefs = definitions;
                    if (settings.debugMode) console.log(`[DLE] Loaded ${definitions.length} custom field definitions from ${fieldDefPath}`);
                    if (errors.length > 0) console.warn('[DLE] Field definition warnings:', errors);
                } else {
                    if (settings.debugMode) console.log('[DLE] Field definitions file empty, using defaults');
                }
            } else {
                if (fdResult.error === 'not_found') {
                    if (settings.debugMode) console.log('[DLE] Field definitions file not found — using defaults');
                } else if (settings.debugMode) {
                    console.warn('[DLE] Could not load field definitions:', fdResult.error, '— using defaults');
                }
            }
        } catch (err) {
            console.warn('[DLE] Error loading field definitions:', err.message, '— using defaults');
        }
        // BUG-305: Don't publish loadedFieldDefs to state until we commit a new
        // vaultIndex. If all vaults fail in multi-vault mode (early-return below),
        // publishing here would leave new defs running against the OLD preserved
        // index — gating runs under defs the entries weren't parsed with.
        if (isZombie()) return;

        let entries = [];
        const tagConfig = {
            lorebookTag: settings.lorebookTag,
            constantTag: settings.constantTag,
            neverInsertTag: settings.neverInsertTag,
            seedTag: settings.seedTag,
            bootstrapTag: settings.bootstrapTag,
            guideTag: settings.librarianGuideTag,
        };

        // Per-build parser ledger. Populated by parseVaultFile's onSkip + per-entry
        // `_parserWarnings`. Published before finalizeIndex so observers see it.
        const buildReport = {
            okCount: 0,
            warnCount: 0,
            skipCount: 0,
            skipped: [],
            entriesWithWarnings: [],
        };
        const lenientAuthoring = settings.lenientAuthoring !== false;

        let totalFiles = 0;
        let vaultFetchFailed = false;
        let vaultFailCount = 0;
        // BUG-366/367: Snapshot live index BEFORE fetching so we can carry forward
        // per-vault slices if a vault comes back partial or successful-but-empty.
        const priorIndexSnapshot = [...vaultIndex];
        setLastVaultAttemptCount(enabledVaults.length);
        for (const vault of enabledVaults) {
            try {
                const data = await fetchAllMdFiles(vault.host, vault.port, vault.apiKey, !!vault.https);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Vault "${vault.name}" returned invalid data`);
                    continue;
                }

                // BUG-366: Partial listing — don't commit a truncated view over a
                // known-good index. Carry forward this vault's previous entries.
                if (data.partial) {
                    console.warn(`[DLE] Vault "${vault.name}" returned a partial directory listing — preserving previous entries for this vault`);
                    vaultFetchFailed = true;
                    vaultFailCount++;
                    dedupWarning(
                        `Some folders in "${vault.name}" couldn't be listed — keeping the previously indexed entries for this vault.`,
                        'vault_fetch_partial',
                    );
                    for (const entry of priorIndexSnapshot) {
                        if (entry.vaultSource === vault.name) entries.push(entry);
                    }
                    continue;
                }

                // BUG-367: Successful-but-empty preserve guard. Treat zero-files-but-
                // we-had-entries as transient instead of silently wiping a valid index.
                if (data.files.length === 0) {
                    const priorForThisVault = priorIndexSnapshot.filter(e => e.vaultSource === vault.name);
                    if (priorForThisVault.length > 0) {
                        console.warn(`[DLE] Vault "${vault.name}" returned 0 files but prior index had ${priorForThisVault.length} entries — preserving`);
                        vaultFetchFailed = true;
                        vaultFailCount++;
                        dedupWarning(
                            `"${vault.name}" returned no files — keeping the ${priorForThisVault.length} previously indexed entries.`,
                            'vault_empty_preserve',
                        );
                        for (const entry of priorForThisVault) entries.push(entry);
                        continue;
                    }
                }

                totalFiles += data.total || data.files.length;

                // Skip cache (not just warn) when many files failed. Otherwise the
                // cache writes the truncated vault, missing entries look like deletions
                // on next hydration, and trackers/dedup-logs/lore evaporate.
                if (data.failed > 0 && isPartialFetchFailure(data.failed, data.total)) {
                    vaultFetchFailed = true;
                    dedupWarning(
                        `Some entries in "${vault.name}" couldn't be loaded (${data.failed} of ${data.total}). They'll be included on the next refresh — cache not updated.`,
                        'vault_fetch_partial',
                    );
                }

                for (const file of data.files) {
                    // BUG-305: parse with locally-loaded defs, not the (possibly stale) global.
                    const entry = parseVaultFile(file, tagConfig, loadedFieldDefs, {
                        lenientAuthoring,
                        onSkip: (reason) => {
                            buildReport.skipped.push({ filename: file.filename, reason });
                            buildReport.skipCount++;
                        },
                    });
                    if (entry) {
                        entry.vaultSource = vault.name;
                        entry._contentHash = simpleHash(file.content);
                        if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                            buildReport.warnCount++;
                            buildReport.entriesWithWarnings.push({
                                filename: file.filename,
                                title: entry.title,
                                warnings: entry._parserWarnings,
                            });
                            // Audit fix-up (round 2): compact the per-entry copy
                            // to release ~50MB at 5k WI-imported entries × 22
                            // W_WI_ROUND_TRIP objects. /dle-lint renderer
                            // (src/ui/commands-lint.js) reconstructs message +
                            // suggestedFix from CODE_LABELS at display time, so
                            // only {code, field} need to round-trip into reused
                            // entries on incremental rebuilds.
                            entry._parserWarnings = entry._parserWarnings.map(w => ({ code: w.code, severity: w.severity, field: w.field }));
                        } else {
                            buildReport.okCount++;
                        }
                        entries.push(entry);
                    }
                }
            } catch (vaultErr) {
                console.warn(`[DLE] Failed to index vault "${vault.name}":`, vaultErr.message);
                vaultFetchFailed = true;
                vaultFailCount++;
                // Surface auth errors as toasts even in multi-vault mode — otherwise a
                // misconfigured API key silently produces zero entries.
                if (/401|403/.test(String(vaultErr.message))) {
                    dedupWarning(`Vault "${vault.name}" rejected the API key.`, 'vault_auth', { hint: 'Check the API key in Connection → Obsidian.' });
                }
                if (enabledVaults.length === 1) throw vaultErr;
                // P1-1: multi-vault fresh-rebuild — carry forward this vault's prior
                // entries instead of dropping them. The partial/empty branches above
                // already do this and the reuse path (buildIndexWithReuse catch) mirrors
                // it; the fresh catch was the lone hole that silently nuked a failed
                // vault's lore from the live index. Cache save is already skipped via
                // skipCacheSave (vaultFetchFailed). Merge mode can't split provenance
                // per-vault, so the merge branch below commits the whole prior snapshot.
                for (const entry of priorIndexSnapshot) {
                    if (entry.vaultSource === vault.name) entries.push(entry);
                }
            }
        }
        setLastVaultFailureCount(vaultFailCount);

        // BUG-001: If ALL enabled vaults failed in multi-vault mode, preserve existing
        // index — replacing with [] would destroy valid cached data.
        if (vaultFailCount > 0 && vaultFailCount === enabledVaults.length && enabledVaults.length > 1) {
            if (isZombie()) return;
            dedupError(
                'Couldn\'t reach any of your vaults — keeping the lore you already had.',
                'obsidian_connect',
                { hint: `${enabledVaults.length} vaults failed; existing ${vaultIndex.length} entries preserved.` },
            );
            const ttl = settings.cacheTTL * 1000;
            setIndexTimestamp(Date.now() - ttl + 30_000); // retry in ~30s
            setIndexing(false);
            setBuildPromise(null);
            return;
        }

        // P2-7: merge mode + a vault failed → the per-vault P1-1 carry-forward can't
        // recover the failed vault's contribution, because merge collapses every
        // member into ONE blob keeping only the FIRST member's vaultSource
        // (vault-pure.js deduplicateMultiVault). Filtering priorIndexSnapshot by
        // `vaultSource === failedVault.name` finds nothing for a failed non-first
        // member. Merged provenance is unsplittable, so commit the WHOLE prior
        // snapshot unchanged rather than a rebuilt-partial that silently drops the
        // failed vault's merged content. Cache save stays skipped (vaultFetchFailed).
        if (vaultFetchFailed && (settings.multiVaultConflictResolution === 'merge') && priorIndexSnapshot.length > 0) {
            if (isZombie()) return;
            entries = [...priorIndexSnapshot];
            setFieldDefinitions(loadedFieldDefs);
            setVaultIndex(entries);
            setIndexTimestamp(Date.now() - (settings.cacheTTL * 1000) + 30_000); // retry in ~30s
            console.warn('[DLE] Merge mode + vault fetch failure — preserving the whole prior index (merged provenance can\'t be split per-vault).');
            if (isZombie()) return;
            setIndexBuildReport(buildReport);
            await finalizeIndex({ entries, settings, skipCacheSave: true });
            return;
        }

        let _tokenizerFailCount = 0;
        await Promise.all(entries.map(async (entry) => {
            try {
                entry.tokenEstimate = await getTokenCountAsync(entry.content);
            } catch {
                entry.tokenEstimate = Math.ceil(entry.content.length / 4.0);
                _tokenizerFailCount++;
            }
        }));
        if (_tokenizerFailCount > 0) {
            console.warn(`[DLE] Tokenizer failed for ${_tokenizerFailCount}/${entries.length} entries — using character-based estimates (budget accuracy degraded)`);
        }

        // Cross-vault title duplicates cause Map key collisions.
        if (enabledVaults.length > 1) {
            const dupes = detectCrossVaultDuplicates(entries);
            if (dupes.length > 0) {
                const listing = dupes.slice(0, 5).map(d => `"${d.title}" (${d.vaults.join(', ')})`).join('; ');
                const more = dupes.length > 5 ? ` …and ${dupes.length - 5} more` : '';
                const mode = settings.multiVaultConflictResolution || 'all';
                const modeMsg = conflictModeMessage(mode);
                dedupWarning(
                    `Duplicate entry titles across vaults: ${listing}${more}. ${modeMsg}`,
                    'cross_vault_dupes',
                    { timeOut: OBSIDIAN_TOAST_TIMEOUT },
                );
            }
        }

        // BUG-007: dedup pass shared with buildIndexWithReuse.
        entries = deduplicateMultiVault(entries, settings.multiVaultConflictResolution);

        if (isZombie()) return;
        // BUG-305: publish fieldDefinitions and vaultIndex together so no observer
        // sees new defs against old entries (or vice versa).
        setFieldDefinitions(loadedFieldDefs);
        setVaultIndex(entries);
        setIndexTimestamp(Date.now());

        if (settings.debugMode) console.log(`[DLE] Indexed ${entries.length} entries from ${totalFiles} vault files across ${enabledVaults.length} vault(s)`);
        console.log('[DLE] Index built: %d entries in %dms (mode: fresh)', entries.length, Math.round(performance.now() - _buildStart));

        if (isZombie()) return;
        // Publish ledger BEFORE finalizeIndex so observers (stats, health) see it.
        setIndexBuildReport(buildReport);
        await finalizeIndex({ entries, settings, skipCacheSave: vaultFetchFailed });

        // Once-per-page-load: subsequent rebuilds stay silent.
        if (!_parserLedgerToastShown && (buildReport.warnCount > 0 || buildReport.skipCount > 0)) {
            const parts = [`DLE indexed ${entries.length} entries.`];
            if (buildReport.warnCount > 0) parts.push(`${buildReport.warnCount} warning${buildReport.warnCount === 1 ? '' : 's'}`);
            if (buildReport.skipCount > 0) parts.push(`${buildReport.skipCount} skipped`);
            dedupWarning(
                `${parts.join(', ').replace(/,([^,]*)$/, ';$1')}. Run /dle-lint for details.`,
                'parser_ledger_summary',
                { timeOut: OBSIDIAN_TOAST_TIMEOUT },
            );
            _parserLedgerToastShown = true;
        }

        if (entries.length === 0 && !vaultFetchFailed) {
            const tag = settings.lorebookTag || 'lorebook';
            dedupWarning(
                `Connected to Obsidian but found 0 entries with the '${tag}' tag. Add \`tags: [${tag}]\` to your note frontmatter to make entries visible to DeepLore.`,
                'zero_entries',
                { timeOut: OBSIDIAN_TOAST_TIMEOUT },
            );
        }
    } catch (err) {
        console.error('[DLE] Failed to build index:', err);
        const raw = String(err.message || err);
        let userMsg = raw;

        const httpsVaults = enabledVaults.filter(v => v.https);
        if (httpsVaults.length > 0 && /Failed to fetch|TypeError|NetworkError/i.test(raw)) {
            try {
                const v = httpsVaults[0];
                const probe = await diagnoseFetchFailure(v.host, v.port, v.apiKey);
                if (probe.diagnosis === 'cert') {
                    userMsg = `HTTPS certificate not trusted. Switch to HTTP in vault settings (uncheck HTTPS, port ${probe.httpPort}), or trust the certificate. Run /dle-health for help.`;
                } else if (probe.diagnosis === 'auth') {
                    userMsg = `Connected via HTTP but authentication failed. Check your vault API key. Run /dle-health for help.`;
                } else {
                    userMsg = `Cannot reach Obsidian on either HTTPS or HTTP. Check that Obsidian is running with the Local REST API plugin enabled. Run /dle-health for diagnostics.`;
                }
            } catch { /* probe failed, fall through to generic classification */ }
        }

        if (userMsg === raw) {
            if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch/i.test(raw)) {
                userMsg = `Connection failed. Check: (1) Obsidian is running, (2) Local REST API plugin is enabled, (3) port is correct. Run /dle-health for diagnostics. (${raw})`;
            } else if (/No enabled vaults/i.test(raw)) {
                userMsg = 'No enabled vaults configured. Go to DeepLore settings → Vault Connections and add a vault.';
            } else if (/401|403|auth/i.test(raw)) {
                userMsg = `Authentication failed. Check your vault API key in settings. Run /dle-health for diagnostics. (${raw})`;
            } else if (/timeout|timed out/i.test(raw)) {
                userMsg = `Obsidian connection timed out. Check that the REST API plugin is running. Run /dle-health for diagnostics. (${raw})`;
            }
        }
        dedupError(userMsg, 'obsidian_build_fail');
    } finally {
        if (buildEpoch === capturedEpoch) {
            setIndexing(false);
            setBuildPromise(null); // BUG-044: clear stale buildPromise
        }
        _buildResolve();
    }
    // L-43: deferred already resolved in the finally above; this only catches a throw
    // from the catch/finally themselves. Swallow-and-log so it can't surface as an
    // unhandled rejection (the deferred `promise` is already settled either way).
    })().catch(err => { console.warn('[DLE] buildIndex post-settle error (ignored):', err?.message || err); });
    return promise;
}

/**
 * Get the max response token length from the current connection profile.
 * @returns {number}
 */
export function getMaxResponseTokens() {
    return main_api === 'openai' ? oai_settings.openai_max_tokens : amount_gen;
}

/**
 * Hydrate the vault index from IndexedDB cache for instant startup.
 * After hydration, triggers a background rebuild to validate against Obsidian.
 * @returns {Promise<boolean>} True if cache was loaded
 */
export async function hydrateFromCache() {
    try {
        const cached = await loadIndexFromCache();
        if (!cached || cached.entries.length === 0) return false;

        setVaultIndex(cached.entries);
        // Timestamp 0 → ensureIndexFresh() always rebuilds. Cache is a fast
        // approximation; Obsidian is source of truth.
        setIndexTimestamp(0);
        resolveLinks(vaultIndex);
        computeEntityDerivedState(cached.entries);
        // BUG-370: cold-start generations would otherwise run with degraded scoring
        // until a full rebuild completes.
        const hydrateSettings = getSettings();
        computeDerivedIndexFields(cached.entries, hydrateSettings);
        if (hydrateSettings.fuzzySearchEnabled || hydrateSettings.librarianSearchEnabled) {
            setFuzzySearchIndex(buildBM25Index(cached.entries));
        }
        // indexEverLoaded is set by buildIndex() after a successful Obsidian fetch
        // confirms the vault is reachable — not here.
        notifyIndexUpdated();

        if (getSettings().debugMode) console.log(`[DLE] Hydrated ${cached.entries.length} entries from IndexedDB cache`);

        // H3: Capture epoch so a stale background rebuild can't apply to a different chat.
        const hydrateEpoch = chatEpoch;
        buildIndex().then(() => {
            // BUG-377: same chat-epoch guard as the catch branch — if chat changed
            // mid-flight, skip any post-rebuild continuation for the stale chat.
            if (chatEpoch !== hydrateEpoch) return;
        }).catch(err => {
            console.warn('[DLE] Background rebuild after cache hydration failed:', err.message);
            if (chatEpoch !== hydrateEpoch) return;
            if (vaultIndex.length > 0) {
                // Short-lived timestamp so retries happen on cooldown, not after TTL.
                const s = getSettings();
                setIndexTimestamp(Date.now() - (s.cacheTTL * 1000) + 30_000); // retry in ~30s
                dedupWarning('Couldn\'t reach your vault — using your saved cache for now.', 'obsidian_cache_fallback', { timeOut: CACHE_FALLBACK_TOAST_TIMEOUT, hint: 'Check that Obsidian is running, then /dle-refresh.' });
            }
        });

        return true;
    } catch (err) {
        console.warn('[DLE] Failed to load cached vault data:', err.message);
        return false;
    }
}

/**
 * Rebuild vault index with reuse: fetches ALL file contents from every vault,
 * but skips re-parsing/tokenizing entries whose content hash is unchanged.
 * Despite fetching everything, this is faster than buildIndex() because
 * parse + tokenize is the expensive part — not the Obsidian fetch.
 * Falls back to full buildIndex if detection fails.
 * @returns {Promise<boolean>} True if rebuild-with-reuse was sufficient (no full rebuild needed)
 */
export async function buildIndexWithReuse() {
    if (indexing || vaultIndex.length === 0) {
        // BUG-AUDIT-CNEW03: Previously returned false → callers triggered redundant
        // full rebuilds. Awaiting the in-flight build is sufficient.
        if (buildPromise) { await buildPromise; return true; }
        return false;
    }

    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    if (enabledVaults.length === 0) return false;

    // BUG-010: install buildPromise before setIndexing(true) so sync observers always
    // find a populated promise.
    let _reuseResolve, _reuseReject;
    const promise = new Promise((res, rej) => { _reuseResolve = res; _reuseReject = rej; });
    setBuildPromise(promise);
    setIndexing(true);

    // BUG-AUDIT-C05: capture buildEpoch so force-release can signal this build to bail
    // before committing stale results. Same pattern as buildIndex().
    const capturedBuildEpoch = buildEpoch;
    const isZombie = () => buildEpoch !== capturedBuildEpoch;

    const tagConfig = {
        lorebookTag: settings.lorebookTag,
        constantTag: settings.constantTag,
        neverInsertTag: settings.neverInsertTag,
        seedTag: settings.seedTag,
        bootstrapTag: settings.bootstrapTag,
        guideTag: settings.librarianGuideTag,
    };

    const indexSnapshot = [...vaultIndex];

    (async () => {
    const _buildStart = performance.now();
    let _reuseResult = false;
    try {
        // BUG-F3: also reload field definitions on incremental sync (was full-build only).
        // BUG-008: resolve to local first; don't mutate shared `fieldDefinitions` mid-parse
        // — that creates a half-stale window where reused entries carry customFields parsed
        // under the old schema while newly-parsed entries use the new schema, and concurrent
        // readers see inconsistent definitions. Commit once after parsing.
        //
        // BUG-375: capture `oldFieldDefsHash` HERE before any setter call — the setter lives
        // below the parse loop, so this is unambiguously the pre-sync hash. Moving it below
        // the setter would make `fieldDefsChanged` always false.
        const oldFieldDefsHash = simpleHash(JSON.stringify(fieldDefinitions.map(f => f.name + f.type + (f.multi || ''))));
        // BUG-368: capture prior snapshot so we can restore per-vault slices for failed
        // vaults below — finalizeIndex overwrites previousIndexSnapshot wholesale, which
        // would permanently mask edits made while a vault was unreachable.
        const priorPrevSnapshot = previousIndexSnapshot;
        const failedVaultNames = new Set();
        let newFieldDefs = fieldDefinitions; // default: keep existing (for non-404 fetch errors)
        const primaryVault = enabledVaults[0];
        const fieldDefPath = settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
        try {
            const fdResult = await fetchFieldDefinitions(primaryVault.host, primaryVault.port, primaryVault.apiKey, fieldDefPath, !!primaryVault.https);
            if (fdResult.ok && fdResult.content) {
                const { definitions } = parseFieldDefinitionYaml(fdResult.content);
                if (definitions.length > 0) {
                    newFieldDefs = definitions;
                } else {
                    newFieldDefs = [...DEFAULT_FIELD_DEFINITIONS];
                }
            } else if (fdResult.error === 'not_found') {
                newFieldDefs = [...DEFAULT_FIELD_DEFINITIONS];
            }
            // Other errors (5xx, network): keep existing defs — don't clobber user schema.
        } catch (err) {
            if (settings.debugMode) console.warn('[DLE] Failed to load field definitions during reuse-sync:', err?.message);
        }

        const existingMap = new Map();
        for (const entry of indexSnapshot) {
            existingMap.set(`${entry.vaultSource}\0${entry.filename}`, entry);
        }

        // Field defs changed → force all entries to re-parse so customFields update.
        const newFieldDefsHash = simpleHash(JSON.stringify(newFieldDefs.map(f => f.name + f.type + (f.multi || ''))));
        const fieldDefsChanged = oldFieldDefsHash !== newFieldDefsHash;

        // V-H4 (2026-05-22): when field defs change, EVERY entry has to re-parse
        // (the `!fieldDefsChanged` cache check at L883 fails for every file), so
        // reuse-sync provides no benefit — it just serializes per-file
        // `await getTokenCountAsync` inside the for-loop, blocking the UI for
        // seconds on a 500-entry vault. `buildIndex()` does the same work but
        // tokenizes in parallel via `Promise.all`. Bail early so the caller's
        // standard `buildIndexWithReuse → false → buildIndex` fallback (see
        // `ensureIndexFresh` and `setupSyncPolling`) takes over.
        //
        // The finally block clears `indexing` + `buildPromise` so `buildIndex`
        // can acquire the lock cleanly. Caller fall-through is bounded —
        // `ensureIndexFresh` and `setupSyncPolling` both check the reuse result
        // and invoke `buildIndex` only when it's false.
        if (fieldDefsChanged) {
            if (settings.debugMode) {
                console.debug('[DLE] Reuse sync: field definitions changed — delegating to buildIndex for parallel tokenization');
            }
            _reuseResult = false;
            return;
        }

        // After the V-H4 early-return above, fieldDefsChanged is always false here.
        let hasChanges = false;
        let anyVaultFailed = false;
        let vaultFailCount = 0;
        let newCount = 0, modifiedCount = 0, removedCount = 0;
        let _reuseTokenizerFailCount = 0;
        const allEntries = [];
        // Reuse-path parser ledger. Only re-parsed files contribute new warnings/skips;
        // unchanged reused entries roll forward their existing `_parserWarnings`.
        const buildReport = {
            okCount: 0,
            warnCount: 0,
            skipCount: 0,
            skipped: [],
            entriesWithWarnings: [],
        };
        const lenientAuthoring = settings.lenientAuthoring !== false;
        // L11b: under merge mode the committed index holds already-merged blobs whose
        // `_contentHash` matches the first member's file — the reuse fast-path must
        // verify reuse candidates against a fresh parse (see the loop below) so a
        // merged blob is never reused and re-merged (unbounded content growth).
        const mergeMode = settings.multiVaultConflictResolution === 'merge';
        setLastVaultAttemptCount(enabledVaults.length);

        for (const vault of enabledVaults) {
            // BUG-AUDIT-C05: bail if force-release bumped epoch mid-loop.
            if (isZombie()) { _reuseResult = false; return; }
            try {
                // Fetch all contents — savings come from skipping re-parse/tokenize for
                // unchanged files (detected via hash), not from skipping the network call.
                const data = await fetchAllMdFiles(vault.host, vault.port, vault.apiKey, !!vault.https);
                if (isZombie()) { _reuseResult = false; return; }
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Reuse sync: vault "${vault.name}" returned invalid data — carrying forward existing entries`);
                    anyVaultFailed = true;
                    vaultFailCount++;
                    failedVaultNames.add(vault.name);
                    for (const entry of indexSnapshot) {
                        if (entry.vaultSource === vault.name) {
                            allEntries.push(entry);
                            if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                                buildReport.warnCount++;
                                buildReport.entriesWithWarnings.push({
                                    filename: entry.filename,
                                    title: entry.title,
                                    warnings: entry._parserWarnings,
                                });
                            } else {
                                buildReport.okCount++;
                            }
                        }
                    }
                    continue;
                }

                // V-C1: Partial directory listing — mirror buildIndex's BUG-366 carry-forward.
                // Without this, files missing from data.files get counted as "removed" below
                // (hasChanges + removedCount++), then setVaultIndex(deduped) commits the
                // truncated index AND finalizeIndex saves it to IDB (no skipCacheSave). On
                // next hydrate, analytics-prune strips trackers for the "deleted" entries.
                if (data.partial) {
                    console.warn(`[DLE] Reuse sync: vault "${vault.name}" returned a partial directory listing — preserving previous entries for this vault`);
                    anyVaultFailed = true;
                    vaultFailCount++;
                    failedVaultNames.add(vault.name);
                    dedupWarning(
                        `Some folders in "${vault.name}" couldn't be listed — keeping the previously indexed entries for this vault.`,
                        'vault_fetch_partial',
                    );
                    for (const entry of indexSnapshot) {
                        if (entry.vaultSource === vault.name) {
                            allEntries.push(entry);
                            if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                                buildReport.warnCount++;
                                buildReport.entriesWithWarnings.push({
                                    filename: entry.filename,
                                    title: entry.title,
                                    warnings: entry._parserWarnings,
                                });
                            } else {
                                buildReport.okCount++;
                            }
                        }
                    }
                    continue;
                }

                // V-C1: Many-file fetch failures — mirror buildIndex's skipCacheSave gate.
                // We still process the partial result (it's the freshest view we have),
                // but flag anyVaultFailed so finalizeIndex skips persisting to IDB. Without
                // this, the cache gets the truncated vault, missing entries look like
                // deletions on next hydration, and trackers/dedup-logs evaporate.
                if (data.failed > 0 && isPartialFetchFailure(data.failed, data.total)) {
                    anyVaultFailed = true;
                    dedupWarning(
                        `Some entries in "${vault.name}" couldn't be loaded (${data.failed} of ${data.total}). They'll be included on the next refresh — cache not updated.`,
                        'vault_fetch_partial',
                    );
                }

                const fetchedFilenames = new Set(data.files.map(f => f.filename));

                for (const entry of indexSnapshot) {
                    if (entry.vaultSource === vault.name && !fetchedFilenames.has(entry.filename)) {
                        hasChanges = true;
                        removedCount++;
                    }
                }

                for (const file of data.files) {
                    const key = `${vault.name}\0${file.filename}`;
                    const existing = existingMap.get(key);
                    const fileHash = simpleHash(file.content);

                    // L11b: merge-mode reuse must NOT reuse an already-merged entry.
                    // Under `multiVaultConflictResolution='merge'`, the committed index
                    // holds ONE entry per title whose `content` is the concatenation of
                    // all members (m1 + sep + m2) but whose `_contentHash` is BUG-378-
                    // preserved as the hash of the FIRST member's on-disk file (m1). So
                    // for that first member's file the hash matches here and the naive
                    // fast-path would push the m1+m2 blob, which the dedup pass below
                    // then re-merges with the freshly-parsed second member → m1+m2+m2,
                    // growing unbounded every tick (reuse ≠ full build). We can't rely
                    // on a persisted marker (cache.js strips `_`-fields except a small
                    // whitelist, so a `_mergedFrom` flag dies on hydrate). Instead, when
                    // merge mode is active, verify the reuse candidate against a CHEAP
                    // sync re-parse of its own file (no tokenize) via the shared
                    // `canReuseMergedCandidate` predicate: a genuine single-file entry
                    // parses back to identical content, while a merged blob does not —
                    // forcing it down the re-parse path so the dedup pass rebuilds the
                    // merge cleanly from fresh members (== full build). The re-parse is
                    // hoisted into `freshParsed` so the else-branch reuses it rather than
                    // parsing twice. Non-merge modes never enter this branch, so their
                    // reuse decision stays byte-identical.
                    let freshParsed;
                    let freshParseDone = false;
                    let canReuse = existing && existing._contentHash === fileHash && !fieldDefsChanged;
                    if (canReuse && mergeMode) {
                        freshParsed = parseVaultFile(file, tagConfig, newFieldDefs, {
                            lenientAuthoring,
                            onSkip: (reason) => {
                                buildReport.skipped.push({ filename: file.filename, reason });
                                buildReport.skipCount++;
                            },
                        });
                        freshParseDone = true;
                        canReuse = canReuseMergedCandidate(existing, freshParsed);
                    }

                    if (canReuse) {
                        // Unchanged — reuse existing entry. Roll forward its
                        // `_parserWarnings` so /dle-lint still surfaces them.
                        allEntries.push(existing);
                        if (existing._parserWarnings && existing._parserWarnings.length > 0) {
                            buildReport.warnCount++;
                            buildReport.entriesWithWarnings.push({
                                filename: existing.filename,
                                title: existing.title,
                                warnings: existing._parserWarnings,
                            });
                        } else {
                            buildReport.okCount++;
                        }
                    } else {
                        hasChanges = true;
                        const entry = freshParseDone ? freshParsed : parseVaultFile(file, tagConfig, newFieldDefs, {
                            lenientAuthoring,
                            onSkip: (reason) => {
                                buildReport.skipped.push({ filename: file.filename, reason });
                                buildReport.skipCount++;
                            },
                        });
                        if (entry) {
                            entry.vaultSource = vault.name;
                            entry._contentHash = fileHash;
                            try {
                                entry.tokenEstimate = await getTokenCountAsync(entry.content);
                            } catch {
                                entry.tokenEstimate = Math.ceil(entry.content.length / 4.0);
                                _reuseTokenizerFailCount++;
                            }
                            if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                                buildReport.warnCount++;
                                buildReport.entriesWithWarnings.push({
                                    filename: file.filename,
                                    title: entry.title,
                                    warnings: entry._parserWarnings,
                                });
                            } else {
                                buildReport.okCount++;
                            }
                            allEntries.push(entry);
                            if (existing) modifiedCount++;
                            else newCount++;
                        }
                    }
                }
            } catch (vaultErr) {
                console.warn(`[DLE] Reuse sync failed for vault "${vault.name}":`, vaultErr.message);
                anyVaultFailed = true;
                vaultFailCount++;
                failedVaultNames.add(vault.name);
                // Carry forward existing entries — silent data loss otherwise.
                for (const entry of indexSnapshot) {
                    if (entry.vaultSource === vault.name) {
                        allEntries.push(entry);
                        if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                            buildReport.warnCount++;
                            buildReport.entriesWithWarnings.push({
                                filename: entry.filename,
                                title: entry.title,
                                warnings: entry._parserWarnings,
                            });
                        } else {
                            buildReport.okCount++;
                        }
                    }
                }
                continue;
            }
        }

        setLastVaultFailureCount(vaultFailCount);
        if (_reuseTokenizerFailCount > 0) {
            console.warn(`[DLE] Tokenizer failed for ${_reuseTokenizerFailCount} re-parsed entries — using character-based estimates (budget accuracy degraded)`);
        }

        // M-12: merge mode + a vault failed → mirror buildIndex's P2-7 fix. The
        // per-vault carry-forward branches above filter indexSnapshot by
        // `vaultSource === vault.name`, but merge mode collapses every member into
        // ONE blob keeping only the FIRST member's vaultSource
        // (vault-pure.js deduplicateMultiVault). For a failed NON-first member that
        // filter finds nothing, so the dedup pass below re-merges from surviving
        // members only and the live merged entry SHRINKS until every vault recovers.
        // Merged provenance is unsplittable per-vault, so commit the WHOLE prior
        // snapshot unchanged rather than a rebuilt-partial. indexSnapshot === the
        // live committed (merged) index, so this preserves all members' content.
        // Cache save stays skipped (anyVaultFailed). Pass previousEntries:
        // indexSnapshot so finalizeIndex's incremental path no-ops (prev === current).
        if (anyVaultFailed && mergeMode && indexSnapshot.length > 0) {
            if (isZombie()) { _reuseResult = false; return; }
            // fieldDefsChanged is always false here (it forces an early return above the
            // loop, V-H4), so no setFieldDefinitions needed — the live defs are current.
            const carried = [...indexSnapshot];
            setVaultIndex(carried);
            setIndexTimestamp(Date.now() - (settings.cacheTTL * 1000) + 30_000); // retry in ~30s
            setIndexBuildReport(buildReport);
            console.warn('[DLE] Reuse sync: merge mode + vault fetch failure — preserving the whole prior index (merged provenance can\'t be split per-vault).');
            if (isZombie()) { _reuseResult = false; return; }
            await finalizeIndex({
                entries: carried,
                settings,
                skipCacheSave: true,
                previousEntries: indexSnapshot,
            });
            _reuseResult = true;
            return;
        }

        if (!hasChanges) {
            if (anyVaultFailed) {
                setIndexTimestamp(Date.now() - (settings.cacheTTL * 1000) + 30_000); // retry in ~30s
            } else {
                setIndexTimestamp(Date.now());
                // Only mark ever-loaded when all vaults confirmed reachable.
                setIndexEverLoaded(true);
            }
            // Publish ledger even on no-change early-return so /dle-lint reflects
            // the live index's warning state after a reuse-sync tick.
            setIndexBuildReport(buildReport);
            if (settings.debugMode) {
                console.debug(`[DLE] Reuse sync: no changes detected${anyVaultFailed ? ' (some vaults failed)' : ''}`);
            }
            _reuseResult = true;
            return;
        }

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: +${newCount} new, ~${modifiedCount} modified, -${removedCount} removed`);
        }

        // Cross-vault title duplicates cause Map key collisions.
        {
            const enabledCount = (getSettings().vaults || []).filter(v => v.enabled).length;
            if (enabledCount > 1) {
                const dupes = detectCrossVaultDuplicates(allEntries);
                if (dupes.length > 0) {
                    const listing = dupes.slice(0, 5).map(d => `"${d.title}" (${d.vaults.join(', ')})`).join('; ');
                    const more = dupes.length > 5 ? ` …and ${dupes.length - 5} more` : '';
                    const modeMsg = conflictModeMessage(getSettings().multiVaultConflictResolution || 'all');
                    dedupWarning(
                        `Duplicate entry titles across vaults: ${listing}${more}. ${modeMsg}`,
                        'cross_vault_dupes',
                        { timeOut: 15000 },
                    );
                }
            }
        }

        // BUG-007: dedup was missing from this path.
        const dedupedEntries = deduplicateMultiVault(allEntries, settings.multiVaultConflictResolution);

        // BUG-008: commit new defs ONCE, after parsing — closes the half-stale window.
        if (fieldDefsChanged) {
            setFieldDefinitions(newFieldDefs);
        }

        // BUG-AUDIT-C05: final zombie check before committing.
        if (isZombie()) { _reuseResult = false; return; }

        setVaultIndex(dedupedEntries);
        setIndexTimestamp(Date.now());

        setIndexBuildReport(buildReport);
        // V-C1: skipCacheSave when ANY vault returned partial data this cycle.
        //
        // The carry-forward branches above ensure dedupedEntries contains the best
        // *in-memory* state (prior snapshot for fully-failed vaults, partial-data
        // entries for the rest). But persisting that to IDB is dangerous: a vault
        // that returned `data.partial: true` or hit isPartialFetchFailure has a
        // truncated view, and if we cache the carried-forward + partial mix, the
        // next hydrate analytics-prune (finalizeIndex L218-227) strips trackers
        // for any entry that didn't make it back into the cached set. Mirror the
        // buildIndex behavior: when in doubt, keep the prior cache.
        //
        // P3: pass `previousEntries: indexSnapshot` so finalizeIndex can apply
        // incremental updates to mentionWeights / BM25 / entityShortNameRegexes
        // instead of unconditionally rebuilding them O(N²)+O(N) on every poll.
        // See vault-incremental.js for the algorithms.
        await finalizeIndex({
            entries: dedupedEntries,
            settings,
            skipCacheSave: anyVaultFailed,
            previousEntries: indexSnapshot,
        });

        if (!_parserLedgerToastShown && (buildReport.warnCount > 0 || buildReport.skipCount > 0)) {
            const parts = [`DLE indexed ${dedupedEntries.length} entries.`];
            if (buildReport.warnCount > 0) parts.push(`${buildReport.warnCount} warning${buildReport.warnCount === 1 ? '' : 's'}`);
            if (buildReport.skipCount > 0) parts.push(`${buildReport.skipCount} skipped`);
            dedupWarning(
                `${parts.join(', ').replace(/,([^,]*)$/, ';$1')}. Run /dle-lint for details.`,
                'parser_ledger_summary',
                { timeOut: OBSIDIAN_TOAST_TIMEOUT },
            );
            _parserLedgerToastShown = true;
        }

        // BUG-368: For vaults that FAILED this cycle we must NOT advance the snapshot —
        // when the vault recovers, edits made during the outage would be permanently
        // masked because the comparison baseline already contains the carried-forward
        // (post-edit) state. Patch failed vaults' entries back from priorPrevSnapshot.
        if (failedVaultNames.size > 0 && priorPrevSnapshot) {
            const newSnap = previousIndexSnapshot;
            if (newSnap) {
                // Keys are `vaultSource:filename` (core/sync.js snapshotKey). Filename-only
                // keys would silently no-op against multi-vault snapshots.
                const failedKeys = new Set(
                    dedupedEntries
                        .filter(e => failedVaultNames.has(e.vaultSource))
                        .map(e => snapshotKey(e)),
                );
                for (const key of failedKeys) {
                    if (priorPrevSnapshot.contentHashes.has(key)) {
                        newSnap.contentHashes.set(key, priorPrevSnapshot.contentHashes.get(key));
                    } else {
                        newSnap.contentHashes.delete(key);
                    }
                    if (priorPrevSnapshot.titleMap.has(key)) {
                        newSnap.titleMap.set(key, priorPrevSnapshot.titleMap.get(key));
                    } else {
                        newSnap.titleMap.delete(key);
                    }
                    if (priorPrevSnapshot.keyMap.has(key)) {
                        newSnap.keyMap.set(key, priorPrevSnapshot.keyMap.get(key));
                    } else {
                        newSnap.keyMap.delete(key);
                    }
                }
            }
        }

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: ${allEntries.length} entries after reuse rebuild`);
        }
        console.log('[DLE] Index built: %d entries in %dms (mode: reuse)', dedupedEntries.length, Math.round(performance.now() - _buildStart));

        _reuseResult = true;
    } catch (err) {
        console.warn('[DLE] Reuse sync error:', err.message);
        _reuseResult = false;
    } finally {
        // Epoch-gated cleanup: if force-release bumped buildEpoch mid-coroutine and
        // a fresh build started, this zombie's finally must NOT clear the new build's
        // lock/promise. Rule (gotchas.md): every finally touching indexing/buildPromise
        // must epoch-gate.
        if (!isZombie()) {
            setIndexing(false);
            setBuildPromise(null); // BUG-044: clear stale buildPromise
        }
        _reuseResolve(_reuseResult);
    }
    })().catch(err => { _reuseReject(err); });
    return promise;
}

/**
 * Ensure the vault index is fresh, rebuilding if cache has expired.
 */
export async function ensureIndexFresh() {
    const settings = getSettings();
    const now = Date.now();
    const rebuildTrigger = settings.indexRebuildTrigger || 'ttl';

    if (rebuildTrigger === 'manual') {
        // Only rebuild if index is empty — never auto-rebuild
        if (vaultIndex.length === 0) {
            await buildIndex();
            setLastIndexGenerationCount(generationCount);
        }
        return;
    }

    if (rebuildTrigger === 'generation') {
        const interval = settings.indexRebuildGenerationInterval || 10;
        const shouldRebuild = vaultIndex.length === 0 || (generationCount - lastIndexGenerationCount >= interval);
        if (shouldRebuild) {
            if (vaultIndex.length > 0) {
                const usedReuse = await buildIndexWithReuse();
                if (usedReuse) { setLastIndexGenerationCount(generationCount); return; }
            }
            await buildIndex();
            setLastIndexGenerationCount(generationCount);
        }
        return;
    }

    const ttlMs = settings.cacheTTL * 1000;

    // TTL=0: always fetch fresh.
    if (vaultIndex.length === 0 || ttlMs === 0 || (ttlMs > 0 && now - indexTimestamp > ttlMs)) {
        if (vaultIndex.length > 0) {
            const usedReuse = await buildIndexWithReuse();
            if (usedReuse) { setLastIndexGenerationCount(generationCount); return; }
            // BUG-003: re-check TTL after reuse — buildIndexWithReuse may have set
            // indexTimestamp = Date.now() on the no-changes path, making a full rebuild
            // redundant.
            if (ttlMs > 0 && Date.now() - indexTimestamp <= ttlMs) {
                setLastIndexGenerationCount(generationCount);
                return;
            }
        }
        await buildIndex();
        setLastIndexGenerationCount(generationCount);
    }
}
