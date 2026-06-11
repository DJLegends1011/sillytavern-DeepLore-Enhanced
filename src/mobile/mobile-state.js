/**
 * DeepLore Enhanced — Mobile UI state.
 * Pure module: no DOM access. The shell owns the singleton instance;
 * tab modules read shape and constants from here.
 */

import { normalizeMobileBrowseState } from './mobile-browse.js';

export const MOBILE_OVERLAY_TABS = ['injection', 'browse', 'filters', 'librarian', 'tools'];
export const MOBILE_DEFAULT_TAB = 'injection';

export function normalizeMobileTab(tab) {
    return MOBILE_OVERLAY_TABS.includes(tab) ? tab : MOBILE_DEFAULT_TAB;
}

export function createMobileUiState(overrides = {}) {
    const state = {
        open: false,
        tab: MOBILE_DEFAULT_TAB,
        active: false,
        mode: 'auto',
        errorMessage: '',
        statsExpanded: false,
        browse: normalizeMobileBrowseState(),
        browseSearchHelpOpen: false,
        browseExpandedKey: '',
        injectionFilter: 'injected',
        injectionExpandedKey: '',
        scrollPositions: {},
        ...overrides,
    };
    state.tab = normalizeMobileTab(state.tab);
    state.browse = normalizeMobileBrowseState(state.browse ?? {});
    return state;
}
