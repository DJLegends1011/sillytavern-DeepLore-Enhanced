import { matchesPinBlock } from '../helpers.js';
import { trackerKey } from '../state.js';
import { mt, mtf } from './mobile-i18n.js';

export const MOBILE_BROWSE_DEFAULT_STATE = Object.freeze({
    query: '',
    status: 'all',
    tag: '',
    folder: '',
    sort: 'priority_asc',
    quick: '',
    expandedKey: '',
});

export function normalizeMobileBrowseState(input = {}) {
    return {
        ...MOBILE_BROWSE_DEFAULT_STATE,
        ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value == null ? '' : String(value)])),
    };
}

function lower(value) {
    return String(value || '').toLowerCase();
}


function entryKey(entry) {
    const normalized = typeof entry === 'string' ? { title: entry } : (entry || {});
    return `${normalized.vaultSource || ''}:${lower(normalized.title)}`;
}

function makeEntryKeySet(items = []) {
    return new Set((items || []).map(entryKey).filter(key => key !== ':'));
}

function makePinBlockMatcher(items = []) {
    const pinBlocks = items || [];
    return entry => pinBlocks.some(item => matchesPinBlock(item, entry));
}

function parseQuery(query) {
    const tokens = lower(query).split(/\s+/).filter(Boolean);
    const bare = [];
    const prefixed = [];
    for (const token of tokens) {
        const colon = token.indexOf(':');
        if (colon > 0) prefixed.push({ prefix: token.slice(0, colon), value: token.slice(colon + 1) });
        else bare.push(token);
    }
    return { bare, prefixed };
}

function fieldValueMatches(entry, fieldName, expectedValue) {
    const customFields = entry.customFields || {};
    const actualKey = Object.keys(customFields).find(key => lower(key) === lower(fieldName));
    if (!actualKey) return false;
    const actual = customFields[actualKey];
    const values = Array.isArray(actual) ? actual : [actual];
    return values.some(value => lower(value) === lower(expectedValue));
}

function matchesQuery(entry, query) {
    const { bare, prefixed } = parseQuery(query);
    for (const token of bare) {
        const titleMatch = lower(entry.title).includes(token);
        const keyMatch = (entry.keys || []).some(key => lower(key).includes(token));
        if (!titleMatch && !keyMatch) return false;
    }
    for (const { prefix, value } of prefixed) {
        if (!value) continue;
        if (prefix === 'tag' && !(entry.tags || []).some(tag => lower(tag).includes(value))) return false;
        if (prefix === 'folder' && !lower(entry.folderPath).includes(value)) return false;
        if (prefix === 'key' && !(entry.keys || []).some(key => lower(key).includes(value))) return false;
        if (prefix === 'summary' && !lower(entry.summary).includes(value)) return false;
        if (prefix === 'field') {
            const eq = value.indexOf('=');
            if (eq < 0) return false;
            if (!fieldValueMatches(entry, value.slice(0, eq), value.slice(eq + 1))) return false;
        }
    }
    return true;
}

export function buildMobileBrowseOptions(entries = []) {
    const tagCounts = new Map();
    const folderCounts = new Map();
    for (const entry of entries) {
        for (const tag of entry.tags || []) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        if (entry.folderPath) {
            const parts = entry.folderPath.split('/');
            for (let i = 1; i <= parts.length; i++) {
                const folder = parts.slice(0, i).join('/');
                folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
            }
        }
    }
    return {
        tags: [...tagCounts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, count]) => ({ value, label: `${value} (${count})` })),
        folders: [...folderCounts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, count]) => ({ value, label: `${value} (${count})` })),
    };
}

export function filterMobileBrowseEntries(entries = [], rawState = {}, context = {}) {
    const state = normalizeMobileBrowseState(rawState);
    const injectedKeys = makeEntryKeySet(context.injectedSources);
    const matchesPin = makePinBlockMatcher(context.pins);
    const matchesBlock = makePinBlockMatcher(context.blocks);
    const counts = context.chatInjectionCounts instanceof Map ? context.chatInjectionCounts : new Map();

    let filtered = entries.filter(entry => {
        if (state.query && !matchesQuery(entry, state.query)) return false;
        if (state.status === 'injected' && !injectedKeys.has(entryKey(entry))) return false;
        if (state.status === 'pinned' && !matchesPin(entry)) return false;
        if (state.status === 'blocked' && !matchesBlock(entry)) return false;
        if (state.status === 'constant' && !entry.constant) return false;
        if (state.status === 'regular' && entry.constant) return false;
        if (state.tag && !(entry.tags || []).includes(state.tag)) return false;
        if (state.folder && (!entry.folderPath || (entry.folderPath !== state.folder && !entry.folderPath.startsWith(`${state.folder}/`)))) return false;
        if (state.quick === 'never-injected' && (counts.get(trackerKey(entry)) || 0) > 0) return false;
        if (state.quick === 'since-gen' && !injectedKeys.has(entryKey(entry))) return false;
        return true;
    });

    filtered = [...filtered];
    switch (state.sort) {
        case 'alpha_asc': filtered.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'alpha_desc': filtered.sort((a, b) => b.title.localeCompare(a.title)); break;
        case 'tokens_desc': filtered.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
        case 'tokens_asc': filtered.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
        case 'priority_desc': filtered.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50)); break;
        default: filtered.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    }

    const isFiltered = state.query || state.status !== 'all' || state.tag || state.folder || state.quick;
    return {
        state,
        entries: filtered,
        isFiltered: !!isFiltered,
        summary: isFiltered ? mtf('dle_mobile_browse_summary', 'Showing ${0} of ${1} entries', filtered.length, entries.length) : '',
    };
}

export function buildMobileBrowseRows(entries = [], context = {}) {
    const injectedKeys = makeEntryKeySet(context.injectedSources);
    const matchesPin = makePinBlockMatcher(context.pins);
    const matchesBlock = makePinBlockMatcher(context.blocks);
    const counts = context.chatInjectionCounts instanceof Map ? context.chatInjectionCounts : new Map();

    return entries.map(entry => {
        const count = counts.get(trackerKey(entry)) || 0;
        const key = trackerKey(entry);
        return {
            key,
            entry,
            title: entry.title || mt('dle_mobile_browse_untitled', 'Untitled'),
            keysLabel: entry.constant ? mt('dle_mobile_browse_constant', 'Constant') : (entry.keys || []).slice(0, 4).join(', '),
            folderLabel: entry.folderPath || entry.vaultSource || mt('dle_mobile_browse_vault_entry', 'Vault entry'),
            priorityLabel: entry.constant ? 'CONST' : `P${entry.priority ?? 50}`,
            tokenLabel: entry.tokenEstimate ? mtf('dle_mobile_browse_token_label', '${0} tokens', entry.tokenEstimate) : '',
            injectedCount: count,
            isInjected: injectedKeys.has(entryKey(entry)),
            isPinned: matchesPin(entry),
            isBlocked: matchesBlock(entry),
            preview: entry.summary || (entry.content ? `${entry.content.slice(0, 220)}${entry.content.length > 220 ? '...' : ''}` : mt('dle_mobile_browse_no_preview', 'No content preview.')),
        };
    });
}
