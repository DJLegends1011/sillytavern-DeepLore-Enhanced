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
