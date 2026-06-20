/**
 * DeepLore — Pipeline runner
 */
import { getSettings, PROMPT_TAG_PREFIX } from '../../settings.js';
import { formatAndGroup, clearScanTextCache } from '../../core/matching.js';
import { buildExemptionPolicy, applyRequiresExcludesGating, applyContextualGating, applyFolderFilter } from '../stages.js';
import {
    vaultIndex, generationCount,
    fieldDefinitions,
    getWriterVisibleEntries,
    trackerKey,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { buildCandidateManifest, aiSearch, hierarchicalPreFilter } from '../ai/ai.js';
import { isForceInjected, comparePriority } from '../helpers.js';
import { ensureIndexFresh } from '../vault/vault.js';
import { name2 } from '../../../../../../script.js';
import { dedupWarning } from '../toast-dedup.js';
import { matchEntries as _matchEntriesPure } from './match.js';

/** Inject settings + name2 into the extracted pure matcher. */
export function matchEntries(chat, snapshot = null, opts = {}) {
    return _matchEntriesPure(chat, snapshot, {
        settings: opts.settings || getSettings(),
        characterName: opts.characterName !== undefined ? opts.characterName : name2,
    });
}

/**
 * Full entry-selection pipeline. 3-mode branching: keywords-only, two-stage, ai-only.
 * Records a trace for the Pipeline Inspector (/dle-inspect).
 * @returns {Promise<{ finalEntries: VaultEntry[], matchedKeys: Map<string, string>, trace: object }>}
 */
export async function runPipeline(chat, externalSnapshot, contextualGatingContext, { pins = [], blocks = [], folderFilter = null, signal = null, onStatus = null, genId = null } = {}) {
    // Snapshot settings and vault so async stages (AI search) see a consistent view.
    const rawSettings = getSettings();
    const settings = { ...rawSettings, analyticsData: { ...rawSettings.analyticsData } };
    // External snapshots are assumed already-filtered (caller used getWriterVisibleEntries()).
    // Otherwise filter out lorebook-guide here — Librarian-only, must never reach the writing AI.
    const vaultSnapshot = externalSnapshot || getWriterVisibleEntries();
    const bootstrapActive = chat.length <= settings.newChatThreshold;

    // BUG-AUDIT-P2 (Wave C): build the exemption policy ONCE per pipeline run.
    // Previously, six inner sites rebuilt it with identical pins/blocks — only the
    // first arg (candidate set) differed. forceInject is a Set keyed by trackerKey
    // checked via `.has(trackerKey(e))` from each stage's iterated entries, so a
    // policy built from the full vaultSnapshot is a strict superset and behaves
    // identically inside every downstream filter. vaultSnapshot/pins/blocks are
    // immutable for the run — that invariant is what makes this cache valid.
    // Stages H-3 / gotcha #60: bootstrapActive is gen-scoped and must be threaded
    // here so post-keyword stages match the pre-pipeline `alwaysInject` filter
    // (mirrors `helpers.js:isForceInjected`).
    const exemptionPolicy = buildExemptionPolicy(vaultSnapshot, pins, blocks, bootstrapActive);

    const trace = {
        genId,
        mode: settings.aiSearchEnabled
            ? settings.aiSearchMode
            : 'keywords-only',
        indexed: vaultSnapshot.length,
        keywordMatched: [],
        aiSelected: [],
        gatedOut: [],
        budgetCut: [],
        injected: [],
        probabilitySkipped: [],
        warmupFailed: [],
        cooldownRemoved: [],
        contextualGatingRemoved: [],
        stripDedupRemoved: [],
        bootstrapActive,
        chatMessageCount: chat.length,
        vaultSnapshotSize: vaultSnapshot.length,
        generationNumber: generationCount,
        aiFallback: false,
        aiError: '', // BUG-004: surface to toast.
        fuzzyStats: null,
        refineKeyBlocked: [],
        // Per-stage timings populated by onGenerate.
        ensureIndexFreshMs: null,
        pinBlockMs: null,
        contextualGatingMs: null,
        reinjectionCooldownMs: null,
        requiresExcludesMs: null,
        stripDedupMs: null,
        formatGroupMs: null,
        trackGenerationMs: null,
        recordAnalyticsMs: null,
        perChatCountsMs: null,
    };

    if (settings.debugMode) {
        console.debug('[DLE][DIAG] pipeline-run', {
            mode: trace.mode,
            vaultSnapshotSize: vaultSnapshot.length,
            chatLength: chat.length,
            bootstrapActive,
            generationCount,
            aiSearchEnabled: settings.aiSearchEnabled,
            aiSearchMode: settings.aiSearchMode,
            pinCount: pins.length,
            blockCount: blocks.length,
            folderFilter: folderFilter?.length ?? 'none',
        });
    }

    let finalEntries;
    let matchedKeys = new Map();

    if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only') {
        let aiOnlyCandidates = vaultSnapshot;
        // C3: surface the 'prefilter' phase only when the hierarchical pre-filter actually
        // runs an AI category pass (otherwise hierarchicalPreFilter no-ops and this label
        // would flicker). Phase key, not display text — index.js maps it canonically.
        if (settings.hierarchicalPreFilter) onStatus?.('prefilter');
        const preFiltered = await hierarchicalPreFilter(vaultSnapshot, chat, signal);
        if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
        // `if (preFiltered)` would discard valid empty-array results — null is the skip sentinel.
        if (preFiltered != null) {
            aiOnlyCandidates = preFiltered;
            if (settings.debugMode) {
                console.log(`[DLE] Hierarchical clustering: ${vaultSnapshot.length} → ${aiOnlyCandidates.length} candidates`);
            }
        }

        // Pre-filter by contextual gating so AI doesn't waste selections on gated entries.
        // P2: reuse the run-scoped exemptionPolicy (built at top of runPipeline) instead of rebuilding.
        if (contextualGatingContext) {
            const beforeGating = aiOnlyCandidates.length;
            const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            aiOnlyCandidates = applyContextualGating(aiOnlyCandidates, contextualGatingContext, exemptionPolicy, settings.debugMode, settings, fieldDefs);
            trace.aiPreFilter = { before: beforeGating, after: aiOnlyCandidates.length, removed: beforeGating - aiOnlyCandidates.length };
        }

        // Pre-filter by folder so AI doesn't see entries from excluded folders.
        if (folderFilter && folderFilter.length > 0) {
            aiOnlyCandidates = applyFolderFilter(aiOnlyCandidates, folderFilter, exemptionPolicy, settings.debugMode);
        }

        const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(aiOnlyCandidates, bootstrapActive);
        const alwaysInject = vaultSnapshot.filter(e => e.constant || (bootstrapActive && e.bootstrap));

        // BUG-AUDIT v2.5: matchedKeys keyed by trackerKey(entry) (vaultSource:title)
        // so same-titled cross-vault entries don't collide.
        if (bootstrapActive) {
            for (const e of alwaysInject) {
                if (e.bootstrap && !e.constant) matchedKeys.set(trackerKey(e), '(bootstrap)');
            }
        }
        for (const e of alwaysInject) {
            if (e.constant && !matchedKeys.has(trackerKey(e))) matchedKeys.set(trackerKey(e), '(constant)');
        }

        if (candidateManifest) {
            onStatus?.('consulting');
            const _aiStart = performance.now();
            const aiResult = await aiSearch(chat, candidateManifest, candidateHeader, vaultSnapshot, aiOnlyCandidates, signal);
            trace.aiSearchMs = Math.round(performance.now() - _aiStart);
            trace.aiCached = aiResult.cached ?? false; // BUG-396c: feeds injection-log staleness detection.
            if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
            if (aiResult.error) {
                trace.aiFallback = true;
                trace.aiError = aiResult.errorMessage || ''; // BUG-004
                const fallback = settings.aiErrorFallback || 'keyword';
                if (fallback === 'keyword') {
                    const kwResult = matchEntries(chat, vaultSnapshot);
                    finalEntries = kwResult.matched;
                    matchedKeys = kwResult.matchedKeys;
                    trace.keywordMatched = kwResult.matched.map(e => ({ title: e.title, vaultSource: e.vaultSource || '', matchedBy: kwResult.matchedKeys.get(trackerKey(e)) || '?' }));
                    trace.probabilitySkipped = kwResult.probabilitySkipped;
                    trace.warmupFailed = kwResult.warmupFailed;
                    trace.fuzzyStats = kwResult.fuzzyStats;
                    trace.refineKeyBlocked = kwResult.refineKeyBlocked;
                    // Warn when ai-only fallback collapsed to constants-only.
                    const nonConstant = finalEntries.filter(e => !e.constant && !e.bootstrap);
                    if (nonConstant.length === 0 && finalEntries.length > 0) {
                        console.warn('[DLE] AI-only mode failed and keyword fallback found only constants/bootstraps — lore coverage is minimal');
                        dedupWarning('AI search hit a snag — only your always-send lore is active.', 'ai_fallback', { hint: 'Check AI connection in DeepLore settings.' });
                    }
                } else if (fallback === 'constants_only') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (fallback === 'bootstrap_only') {
                    finalEntries = vaultSnapshot.filter(e => bootstrapActive && e.bootstrap);
                } else {
                    finalEntries = [];
                }
            } else if (aiResult.results.length === 0) {
                const emptyFallback = settings.aiEmptyFallback || 'constants';
                dedupWarning('AI didn\'t pick any lore for this scene — using your fallback.', 'ai_empty_fallback', { hint: `Empty fallback mode: ${emptyFallback}` });
                if (emptyFallback === 'constants') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (emptyFallback === 'constants_bootstrap') {
                    finalEntries = alwaysInject;
                } else if (emptyFallback === 'keyword') {
                    finalEntries = matchEntries(chat, vaultSnapshot).matched;
                } else {
                    finalEntries = [];
                }
            } else {
                finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e, { bootstrapActive }))];
                for (const r of aiResult.results) {
                    matchedKeys.set(trackerKey(r.entry), `AI: ${r.reason} (${r.confidence})`);
                    trace.aiSelected.push({ title: r.entry.title, vaultSource: r.entry.vaultSource || '', reason: r.reason, confidence: r.confidence });
                }
            }
        } else {
            finalEntries = alwaysInject;
        }

    } else if (settings.aiSearchEnabled && settings.aiSearchMode === 'two-stage') {
        const _kwStart = performance.now();
        const keywordResult = matchEntries(chat, vaultSnapshot);
        trace.keywordMatchMs = Math.round(performance.now() - _kwStart);
        matchedKeys = keywordResult.matchedKeys;
        trace.keywordMatched = keywordResult.matched.map(e => ({ title: e.title, vaultSource: e.vaultSource || '', matchedBy: matchedKeys.get(trackerKey(e)) || '?' }));
        trace.probabilitySkipped = keywordResult.probabilitySkipped;
        trace.warmupFailed = keywordResult.warmupFailed;
        trace.fuzzyStats = keywordResult.fuzzyStats;
        trace.refineKeyBlocked = keywordResult.refineKeyBlocked;

        // Wiki-link expansion: add entries referenced by matched entries as AI candidates.
        // P2-5 (gotcha #50): resolvedLinks is a bare-title array from frontmatter, so a
        // bare-title last-wins Map silently collapsed same-title cross-vault entries —
        // only ONE vault's "Castle" could be wiki-linked even when both should be. Mirror
        // the cascade-link pattern in match.js: key the lookup by title → array of all
        // same-titled entries (union across vaults), expand EVERY match for a linked
        // title, and dedupe by trackerKey (vaultSource:title), not bare title.
        const matchedKeySet = new Set(keywordResult.matched.map(e => trackerKey(e)));
        const titleLookup = new Map();
        for (const e of vaultSnapshot) {
            if (!titleLookup.has(e.title)) titleLookup.set(e.title, []);
            titleLookup.get(e.title).push(e);
        }
        const linkedCandidates = [];
        for (const entry of keywordResult.matched) {
            for (const linkTitle of (entry.resolvedLinks || [])) {
                const candidates = titleLookup.get(linkTitle) || [];
                for (const linked of candidates) {
                    const tk = trackerKey(linked);
                    if (matchedKeySet.has(tk)) continue;
                    if (linked.constant) continue;
                    matchedKeySet.add(tk);
                    linkedCandidates.push(linked);
                    matchedKeys.set(tk, `(wiki-linked from: ${entry.title})`);
                }
            }
        }
        const expandedMatched = [...keywordResult.matched, ...linkedCandidates];
        if (linkedCandidates.length > 0) {
            trace.keywordMatched.push(...linkedCandidates.map(e => ({ title: e.title, vaultSource: e.vaultSource || '', matchedBy: matchedKeys.get(trackerKey(e)) || '?' })));
            if (settings.debugMode) {
                console.log(`[DLE] Wiki-link expansion: +${linkedCandidates.length} candidates (${linkedCandidates.map(e => e.title).join(', ')})`);
            }
        }

        // BUG-022: pass expandedMatched (includes wiki-linked), not keywordResult.matched.
        // null = skip, use all; [] = AI picked zero categories (valid filter result).
        let twoStageCandidates = expandedMatched;
        // C3: 'prefilter' phase only when the hierarchical pre-filter actually runs (see ai-only path).
        if (settings.hierarchicalPreFilter) onStatus?.('prefilter');
        const preFiltered = await hierarchicalPreFilter(expandedMatched, chat, signal);
        if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
        if (preFiltered != null) {
            twoStageCandidates = preFiltered;
            if (settings.debugMode) {
                console.log(`[DLE] Two-stage hierarchical: ${keywordResult.matched.length} → ${twoStageCandidates.length} candidates`);
            }
        }

        // P2: reuse run-scoped exemptionPolicy.
        if (contextualGatingContext) {
            const beforeGating = twoStageCandidates.length;
            const fieldDefs2 = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            twoStageCandidates = applyContextualGating(twoStageCandidates, contextualGatingContext, exemptionPolicy, settings.debugMode, settings, fieldDefs2);
            trace.aiPreFilter = { before: beforeGating, after: twoStageCandidates.length, removed: beforeGating - twoStageCandidates.length };
        }

        if (folderFilter && folderFilter.length > 0) {
            twoStageCandidates = applyFolderFilter(twoStageCandidates, folderFilter, exemptionPolicy, settings.debugMode);
        }

        const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(twoStageCandidates, bootstrapActive);

        if (!candidateManifest) {
            finalEntries = keywordResult.matched;
        } else {
            onStatus?.('consulting');
            const _aiStart2 = performance.now();
            const aiResult = await aiSearch(chat, candidateManifest, candidateHeader, vaultSnapshot, twoStageCandidates, signal);
            trace.aiSearchMs = Math.round(performance.now() - _aiStart2);
            trace.aiCached = aiResult.cached ?? false; // BUG-396c
            if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
            if (aiResult.error) {
                trace.aiFallback = true;
                trace.aiError = aiResult.errorMessage || ''; // BUG-004
                const fallback = settings.aiErrorFallback || 'keyword';
                if (fallback === 'keyword') {
                    finalEntries = keywordResult.matched;
                } else if (fallback === 'constants_only') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (fallback === 'bootstrap_only') {
                    finalEntries = vaultSnapshot.filter(e => bootstrapActive && e.bootstrap);
                } else {
                    finalEntries = [];
                }
            } else if (aiResult.results.length === 0) {
                const emptyFallback = settings.aiEmptyFallback || 'constants';
                dedupWarning('AI didn\'t pick any lore for this scene — using your fallback.', 'ai_empty_fallback', { hint: `Empty fallback mode: ${emptyFallback}` });
                if (emptyFallback === 'constants') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (emptyFallback === 'constants_bootstrap') {
                    finalEntries = vaultSnapshot.filter(e => e.constant || (bootstrapActive && e.bootstrap));
                } else if (emptyFallback === 'keyword') {
                    finalEntries = keywordResult.matched;
                } else {
                    finalEntries = [];
                }
            } else {
                const ctx = { bootstrapActive };
                const alwaysInject = keywordResult.matched.filter(e => isForceInjected(e, ctx));
                finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e, ctx))];
                for (const r of aiResult.results) {
                    const tk = trackerKey(r.entry);
                    const existing = matchedKeys.get(tk);
                    matchedKeys.set(tk, existing
                        ? `${existing} → AI: ${r.reason} (${r.confidence})`
                        : `AI: ${r.reason} (${r.confidence})`);
                    trace.aiSelected.push({ title: r.entry.title, vaultSource: r.entry.vaultSource || '', reason: r.reason, confidence: r.confidence });
                }
            }
        }

    } else {
        const _kwStart2 = performance.now();
        const keywordResult = matchEntries(chat, vaultSnapshot);
        trace.keywordMatchMs = Math.round(performance.now() - _kwStart2);
        finalEntries = keywordResult.matched;
        matchedKeys = keywordResult.matchedKeys;
        trace.keywordMatched = keywordResult.matched.map(e => ({ title: e.title, vaultSource: e.vaultSource || '', matchedBy: matchedKeys.get(trackerKey(e)) || '?' }));
        trace.probabilitySkipped = keywordResult.probabilitySkipped;
        trace.warmupFailed = keywordResult.warmupFailed;
        trace.fuzzyStats = keywordResult.fuzzyStats;
        trace.refineKeyBlocked = keywordResult.refineKeyBlocked;

        // BUG-F1: contextual gating must run in keywords-only mode (previously skipped).
        // P2: reuse run-scoped exemptionPolicy.
        if (contextualGatingContext) {
            const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            finalEntries = applyContextualGating(finalEntries, contextualGatingContext, exemptionPolicy, settings.debugMode, settings, fieldDefs);
        }
    }

    if (folderFilter && folderFilter.length > 0) {
        const beforeFolder = finalEntries.length;
        finalEntries = applyFolderFilter(finalEntries, folderFilter, exemptionPolicy, settings.debugMode);
        trace.folderFilter = { folders: folderFilter, before: beforeFolder, after: finalEntries.length, removed: beforeFolder - finalEntries.length };
    }

    // Restore user priority after AI modes — confidence sort may have overridden it,
    // and budget trimming must respect the explicit priority field. #16: reverse via setting.
    finalEntries.sort((a, b) => comparePriority(a, b, settings.priorityReversed) || a.title.localeCompare(b.title) || (a.vaultSource || '').localeCompare(b.vaultSource || ''));

    clearScanTextCache();

    // trace is finalized by onGenerate after enrichment — don't set here to avoid double-write.
    return { finalEntries, matchedKeys, trace };
}

/**
 * External API: match vault entries against arbitrary text.
 * Used by other extensions (e.g. BurnerPhone) to get lore without going through the interceptor.
 * @param {string|object[]} scanInput - Text string or array of {name, mes, is_user} chat objects.
 * @returns {Promise<{text: string, count: number, tokens: number}>}
 */
export async function matchTextForExternal(scanInput) {
    const settings = getSettings();
    if (!settings.enabled) return { text: '', count: 0, tokens: 0 };

    await ensureIndexFresh();
    if (vaultIndex.length === 0) return { text: '', count: 0, tokens: 0 };

    const fakeChat = typeof scanInput === 'string'
        ? [{ name: 'context', mes: scanInput, is_user: true }]
        : scanInput;

    // BUG-AUDIT (Fix 6): pass the writer-visible snapshot. Without this, matchEntries
    // falls back to raw vaultIndex and leaks lorebook-guide entries to external
    // consumers (e.g. globalThis.deepLoreEnhanced_matchText), violating the
    // "guides never reach the writing AI" contract in CLAUDE.md.
    const { matched } = matchEntries(fakeChat, getWriterVisibleEntries());
    clearScanTextCache();
    const policy = buildExemptionPolicy(matched, [], []);
    const { result: gated } = applyRequiresExcludesGating(matched, policy, false, getSettings().priorityReversed);
    const { groups, count, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

    const combinedText = groups.map(g => g.text).join('\n\n');
    return { text: combinedText, count, tokens: totalTokens };
}
