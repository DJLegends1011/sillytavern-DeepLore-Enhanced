/**
 * DeepLore Enhanced — AI Candidate Manifest Builder
 * Extracted from ai.js for testability (no SillyTavern imports).
 */

import { truncateToSentence, escapeXml } from '../../core/utils.js';
import { fieldDefinitions, decayTracker, consecutiveInjections, trackerKey } from '../state.js';
import { isForceInjected } from '../helpers.js';

/**
 * XML manifest of candidate entries for the AI search prompt. Filters out
 * force-injected entries (constants/bootstraps), annotates each with token
 * count, links, decay hints, custom fields, and emits a pool-summary header.
 * @returns {{ manifest: string, header: string }}
 */
export function buildCandidateManifest(candidates, excludeBootstrap = false, settings = null) {
    const s = settings || {};
    const summaryLen = s.aiSearchManifestSummaryLength || 600;

    const summaryMode = s.manifestSummaryMode || 'prefer_summary';
    let selectable = candidates.filter(e => !isForceInjected(e, { bootstrapActive: excludeBootstrap }));

    // E8: summary_only excludes entries without a summary field.
    if (summaryMode === 'summary_only') {
        selectable = selectable.filter(e => e.summary && e.summary.trim());
    }

    if (selectable.length === 0) return { manifest: '', header: '' };

    const fieldLabelMap = new Map(fieldDefinitions.map(f => [f.name, f.label]));
    const manifest = selectable
        .map(entry => {
            const summaryText = summaryMode === 'content_only'
                ? truncateToSentence(entry.content.substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen)
                : (entry.summary || truncateToSentence(entry.content.substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen));
            const safeSummary = summaryText;
            const links = entry.resolvedLinks && entry.resolvedLinks.length > 0
                ? ` → ${entry.resolvedLinks.join(', ')}`
                : '';
            let decayHint = '';
            if (s.decayEnabled && decayTracker.size > 0) {
                const staleness = decayTracker.get(trackerKey(entry));
                if (staleness !== undefined && staleness >= s.decayBoostThreshold) {
                    decayHint = ' [STALE — consider refreshing]';
                }
                if (!decayHint && s.decayPenaltyThreshold > 0) {
                    const streak = consecutiveInjections.get(trackerKey(entry));
                    if (streak !== undefined && streak >= s.decayPenaltyThreshold) {
                        decayHint = ' [FREQUENT — consider diversifying]';
                    }
                }
            }
            let fieldsHint = '';
            if (entry.customFields) {
                // Custom Fields in AI Manifest: respect aiManifestIncludeFields whitelist
                // when populated (empty array = include all). Lets the user prune the
                // manifest for token control without dropping custom-field support entirely.
                const includeList = Array.isArray(s.aiManifestIncludeFields) ? s.aiManifestIncludeFields : [];
                const includeSet = includeList.length > 0 ? new Set(includeList) : null;
                const pairs = Object.entries(entry.customFields)
                    .filter(([k, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0))
                    .filter(([k]) => !includeSet || includeSet.has(k))
                    .map(([k, v]) => `${fieldLabelMap.get(k) || k}: ${Array.isArray(v) ? v.join(', ') : v}`);
                if (pairs.length > 0) fieldsHint = `\n[${pairs.join(' | ')}]`;
            }
            const attrSafeTitle = escapeXml(entry.title);
            const header = `${entry.title} (${entry.tokenEstimate}tok)${links}${decayHint}${fieldsHint}`;

            // Structural delimiters so summary content can't be read as manifest-level instructions.
            return `<entry name="${attrSafeTitle}">\n${header}\n${safeSummary}\n</entry>`;
        })
        .join('\n');

    // BUG-047: use candidates.length, not selectable.length (would be tautological).
    const forcedCount = candidates.length - selectable.length;
    let forcedTokens = 0;
    // BUG-395: pass bootstrapActive so bootstraps are counted in the tally.
    for (const e of candidates) { if (isForceInjected(e, { bootstrapActive: excludeBootstrap })) forcedTokens += e.tokenEstimate; }
    const budgetInfo = s.unlimitedBudget
        ? ''
        : `\nToken budget: ~${s.maxTokensBudget} tokens total.`;

    const header = `Candidate entries: ${selectable.length} (from ${candidates.length} total).`
        + (forcedCount > 0 ? `\n${forcedCount} entries are always included (~${forcedTokens} tokens).` : '')
        + budgetInfo;

    return { manifest, header };
}
