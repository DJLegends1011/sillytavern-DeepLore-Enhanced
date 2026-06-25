import { parseMatchReason } from '../helpers.js';
import { mt, mtf } from './mobile-i18n.js';

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
    const title = normalized.title || normalized.id || mt('dle_mobile_injection_untitled', 'Untitled');
    return `${normalized.vaultSource || ''}:${String(title).toLowerCase()}`;
}


function collectFilteredEntries(trace, injectedKeys) {
    if (!trace) return [];
    const seen = new Set();
    const entries = [];

    function add(items, reason) {
        for (const item of items || []) {
            const title = item.title || item.id || mt('dle_mobile_injection_untitled', 'Untitled');
            const key = normalizedEntryKey({ ...item, title });
            if (injectedKeys.has(key) || seen.has(key)) continue;
            seen.add(key);
            const entryReason = item.reason || reason;
            entries.push({ ...item, title, reason: entryReason, isFiltered: true });
        }
    }

    add(trace.gatedOut, mt('dle_mobile_injection_reason_blocked_dependencies', 'blocked by dependencies'));
    add(trace.contextualGatingRemoved, mt('dle_mobile_injection_reason_filtered_context', 'filtered by context'));
    add(trace.cooldownRemoved, mt('dle_mobile_injection_reason_cooldown', 'on cooldown'));
    add(trace.budgetCut, mt('dle_mobile_injection_reason_over_budget', 'over budget'));

    return entries;
}

export function splitInjectionEntries(sources, trace, filterMode) {
    const safeSourcesList = Array.isArray(sources) ? sources : [];
    const injectedKeys = new Set(safeSourcesList.map(normalizedEntryKey));

    if (filterMode === 'injected') {
        const entries = safeSourcesList.map(s => ({ ...s, isFiltered: false }));
        return {
            entries,
            summary: entries.length ? mtf('dle_mobile_injection_summary_injected', '${0} injected', entries.length) : '',
            isFiltered: false,
        };
    }

    const filteredEntries = collectFilteredEntries(trace, injectedKeys);

    if (filterMode === 'filtered') {
        return {
            entries: filteredEntries,
            summary: filteredEntries.length ? mtf('dle_mobile_injection_summary_filtered', '${0} filtered out', filteredEntries.length) : '',
            isFiltered: true,
        };
    }

    const injected = safeSourcesList.map(s => ({ ...s, isFiltered: false }));
    const all = [...injected, ...filteredEntries];
    let summary = '';
    if (injected.length && filteredEntries.length) {
        summary = mtf('dle_mobile_injection_summary_both', '${0} injected, ${1} filtered', injected.length, filteredEntries.length);
    } else if (injected.length) {
        summary = mtf('dle_mobile_injection_summary_injected', '${0} injected', injected.length);
    } else if (filteredEntries.length) {
        summary = mtf('dle_mobile_injection_summary_filtered', '${0} filtered out', filteredEntries.length);
    }

    return {
        entries: all,
        summary,
        isFiltered: false,
    };
}

const MATCH_LABELS = {
    constant: 'CONST', pinned: 'PIN', bootstrap: 'INIT',
    seed: 'SEED', keyword: 'KEY', keyword_ai: 'KEY+AI', ai: 'AI',
};

function nameFromTrackerKey(key) {
    if (!key) return mt('dle_mobile_status_unknown', 'Unknown');
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
            detail: remaining === 1 ? mtf('dle_mobile_timer_cooldown', '${0} message cooldown', remaining) : mtf('dle_mobile_timer_cooldown_other', '${0} messages cooldown', remaining),
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
                    detail: staleness === 1 ? mtf('dle_mobile_timer_stale', 'stale ${0} message', staleness) : mtf('dle_mobile_timer_stale_other', 'stale ${0} messages', staleness),
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
            title: entry.title || mt('dle_mobile_injection_untitled', 'Untitled'),
            tokenCount,
            tokenLabel: tokenCount ? mtf('dle_mobile_injection_token_label', '${0} tok', tokenCount) : '',
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
