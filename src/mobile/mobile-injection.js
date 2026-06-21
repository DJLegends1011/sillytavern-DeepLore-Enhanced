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

function normalizedEntryKey(item) {
    const normalized = typeof item === 'string' ? { title: item } : (item || {});
    const title = normalized.title || normalized.id || 'Untitled';
    return `${normalized.vaultSource || ''}:${String(title).toLowerCase()}`;
}


function collectFilteredEntries(trace, injectedKeys) {
    if (!trace) return [];
    const seen = new Set();
    const entries = [];

    function add(items, reason) {
        for (const item of items || []) {
            const title = item.title || item.id || 'Untitled';
            const key = normalizedEntryKey({ ...item, title });
            if (injectedKeys.has(key) || seen.has(key)) continue;
            seen.add(key);
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
    const injectedKeys = new Set(safeSourcesList.map(normalizedEntryKey));

    if (filterMode === 'injected') {
        const entries = safeSourcesList.map(s => ({ ...s, isFiltered: false }));
        return {
            entries,
            summary: entries.length ? `${entries.length} injected` : '',
            isFiltered: false,
        };
    }

    const filteredEntries = collectFilteredEntries(trace, injectedKeys);

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

function nameFromTrackerKey(key) {
    if (!key) return 'Unknown';
    return key.includes(':') ? key.split(':').slice(1).join(':') : key;
}

export function extractTimerData(cooldownTracker, decayTracker, settings = {}) {
    const timers = [];
    const cooldowns = cooldownTracker instanceof Map ? cooldownTracker : new Map();
    const decays = decayTracker instanceof Map ? decayTracker : new Map();

    for (const [key, remaining] of cooldowns) {
        timers.push({
            title: nameFromTrackerKey(key),
            timerType: 'cooldown',
            remaining,
            detail: `${remaining} message${remaining !== 1 ? 's' : ''} cooldown`,
        });
    }

    if (settings.decayEnabled) {
        const boostThreshold = settings.decayBoostThreshold || 5;
        for (const [key, staleness] of decays) {
            if (staleness >= boostThreshold) {
                timers.push({
                    title: nameFromTrackerKey(key),
                    timerType: 'decay',
                    remaining: staleness,
                    detail: `stale ${staleness} message${staleness !== 1 ? 's' : ''}`,
                });
            }
        }
    }

    return timers;
}

export function buildMobileInjectionRows(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map(entry => {
        const { type } = parseMatchReason(entry.matchedBy);
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
