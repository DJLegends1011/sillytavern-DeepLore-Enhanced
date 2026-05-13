import { parseMatchReason } from '../helpers.js';

const VALID_FILTERS = new Set(['injected', 'filtered', 'both']);

export const MOBILE_INJECTION_DEFAULT_STATE = Object.freeze({
    filter: 'injected',
    expandedKey: '',
});

export function normalizeMobileInjectionState(input = {}) {
    const filter = VALID_FILTERS.has(input?.filter) ? input.filter : 'injected';
    const expandedKey = input?.expandedKey == null ? '' : String(input.expandedKey);
    return { filter, expandedKey };
}

function collectFilteredEntries(trace, injectedTitles) {
    if (!trace) return [];
    const seen = new Set();
    const entries = [];

    function add(items, reason) {
        for (const item of items || []) {
            const title = item.title || item.id || 'Untitled';
            if (injectedTitles.has(title) || seen.has(title)) continue;
            seen.add(title);
            const entryReason = item.reason || reason;
            entries.push({ ...item, title, reason: entryReason, isFiltered: true });
        }
    }

    add(trace.gatedOut, 'blocked by dependencies');
    add(trace.contextualGatingRemoved, 'filtered by context');
    add(trace.cooldownRemoved, 'on cooldown');
    add(trace.budgetCut, 'over budget');

    return entries;
}

export function splitInjectionEntries(sources, trace, filterMode) {
    const safeSourcesList = Array.isArray(sources) ? sources : [];
    const injectedTitles = new Set(safeSourcesList.map(s => s.title));

    if (filterMode === 'injected') {
        const entries = safeSourcesList.map(s => ({ ...s, isFiltered: false }));
        return {
            entries,
            summary: entries.length ? `${entries.length} injected` : '',
            isFiltered: false,
        };
    }

    const filteredEntries = collectFilteredEntries(trace, injectedTitles);

    if (filterMode === 'filtered') {
        return {
            entries: filteredEntries,
            summary: filteredEntries.length ? `${filteredEntries.length} filtered out` : '',
            isFiltered: true,
        };
    }

    const injected = safeSourcesList.map(s => ({ ...s, isFiltered: false }));
    const all = [...injected, ...filteredEntries];
    const parts = [];
    if (injected.length) parts.push(`${injected.length} injected`);
    if (filteredEntries.length) parts.push(`${filteredEntries.length} filtered`);

    return {
        entries: all,
        summary: parts.join(', '),
        isFiltered: false,
    };
}

const MATCH_LABELS = {
    constant: 'CONST', pinned: 'PIN', bootstrap: 'INIT',
    seed: 'SEED', keyword: 'KEY', keyword_ai: 'KEY+AI', ai: 'AI',
};

export function buildMobileInjectionRows(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map(entry => {
        const { type, keyword } = parseMatchReason(entry.matchedBy);
        const tokenCount = Number(entry.tokens) || 0;
        return {
            key: `${entry.vaultSource || ''}:${entry.title || 'untitled'}`,
            title: entry.title || 'Untitled',
            tokenCount,
            tokenLabel: tokenCount ? `${tokenCount} tok` : '',
            injectionCount: Number(entry.injectionCount) || 0,
            matchedBy: entry.matchedBy || '',
            matchLabel: MATCH_LABELS[type] || (entry.matchedBy?.length > 8 ? 'AI' : entry.matchedBy || '?'),
            isKeyword: type === 'keyword' || type === 'keyword_ai',
            filename: entry.filename || '',
            vaultSource: entry.vaultSource || '',
            isFiltered: !!entry.isFiltered,
            reason: entry.reason || '',
        };
    });
}
