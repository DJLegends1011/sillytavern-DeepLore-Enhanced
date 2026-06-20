import { escapeHtml } from '../../../../../utils.js';
import { parseMatchReason } from '../helpers.js';
import { chatInjectionCounts, consecutiveInjections, vaultIndex, trackerKey } from '../state.js';

// ─── Constants ───

export const DRAWER_ID = 'deeplore-drawer';
export const MODULE_NAME = 'deeplore-enhanced';

// Last-resort fallback ONLY — switchTab mirrors the active tab's localized .dle-tab-text into the
// .dle-tab-label, so these English strings are reached only if that text node is missing. Kept in
// sync with the canonical visible names (injection → "Injection", not the old "Why?").
export const TAB_LABELS = {
    injection: 'Injection',
    browse: 'Browse',
    gating: 'Filters',
    librarian: 'Librarian',
    tools: 'Tools',
};

export const TOOL_ACTIONS = {
    'health': '/dle-health',
    'inspect': '/dle-inspect',
    'status': '/dle-status',
    'simulate': '/dle-simulate',
    'ai-review': '/dle-review',
    'notebook': '/dle-notebook',
    'ai-notebook': '/dle-ai-notepad',
    'summarize': '/dle-summarize',
    'import-wi': '/dle-import',
    'optimize-keys': '/dle-optimize-keys',
    'graph': '/dle-graph',
    'scribe-history': '/dle-scribe-history',
    'setup': '/dle-setup',
    'pins-blocks': '/dle-pins',
    'refresh': '/dle-refresh',
};

export const EXPAND_ACTIONS = {
    'injection': '/dle-why',
    'browse': '/dle-browse',
    'gating': '/dle-context-state',
};

export const MODE_LABELS = {
    'two-stage': 'Two-Stage',
    'ai-only': 'AI Only',
    'keywords-only': 'Keywords',
};

export const MODE_DESCRIPTIONS = {
    'two-stage': 'keywords narrow the field, then AI picks the best matches',
    'ai-only': 'AI evaluates the full vault directly (slower, more thorough)',
    'keywords-only': 'matching by keywords only (AI disabled)',
};

export const STATUS_DESCRIPTIONS = {
    'ok': 'all vaults connected and responding',
    'degraded': 'some vaults unreachable or slow',
    'limited': 'running with limited functionality',
    'offline': 'unable to reach Obsidian',
};

export const STATUS_CLASSES = {
    'ok': 'dle-status-ok',
    'degraded': 'dle-status-degraded',
    'limited': 'dle-status-limited',
    'offline': 'dle-status-offline',
};

/** BROWSE_ROW_HEIGHT must match CSS .dle-browse-entry height. */
export const BROWSE_ROW_HEIGHT = 32;
export const BROWSE_OVERSCAN = 8;

/** chat_width percentage; above this threshold the drawer switches to fixed-overlay mode. */
export const OVERLAY_CHAT_WIDTH_THRESHOLD = 60;

// ─── Mutable State (shared object — avoids circular imports) ───

/**
 * Single object pattern: render and event modules mutate this directly.
 * Avoids setter functions and circular export/import that splitting per-tab would require.
 */
export const ds = {
    /** jQuery reference to the drawer root, set once in createDrawerPanel(). */
    $drawer: null,

    /** True between GENERATION_STARTED and GENERATION_ENDED. */
    stGenerating: false,

    // Browse tab filters
    browseSearchTimeout: null,
    browseQuery: '',
    browseStatusFilter: 'all',
    browseTagFilter: '',
    browseFolderFilter: '',
    browseSort: 'priority_asc',
    /** @type {Object<string, string>} { fieldName: selectedValue } */
    browseCustomFieldFilters: {},

    cachedTagSet: null,
    cachedTagOptions: '',
    cachedFolderSet: null,
    cachedFolderOptions: '',

    // Virtual scroll state
    browseFilteredEntries: [],
    /** Row models built from browseFilteredEntries: header + entry slots (drawer-browse-pure). */
    browseRowModel: [],
    browseLastRangeStart: -1,
    browseLastRangeEnd: -1,
    browseScrollRAF: null,
    browseExpandedEntry: null,
    /** Index in browseRowModel of the expanded entry (drives virtual-scroll offset math). */
    browseExpandedIdx: null,
    browseExpandedExtraHeight: 0,
    /** Set by navigateToBrowseEntry(), consumed and cleared by renderBrowseTab(). */
    browseNavigateTarget: null,

    // #13 — folder grouping (session-only state; BUG-042 may migrate to accountStorage later)
    browseFolderGrouping: false,
    /** Top-folder names currently expanded (null/empty Set means all-expanded fallback in pure helper). */
    browseExpandedFolders: new Set(),
    // #26 — batch selection
    browseSelectMode: false,
    /** trackerKey-keyed entry selection set (vaultSource:title). */
    browseSelected: new Set(),

    contextTokens: 0,
    promptManagerRef: null,

    /** 'both' | 'injected' | 'filtered' */
    whyTabFilter: 'injected',

    /** 'flag' | 'activity' */
    librarianFilter: 'flag',
    /** 'newest' | 'frequency' | 'urgency' */
    librarianSort: 'newest',
    /** Selected gap IDs for bulk operations. */
    librarianSelected: new Set(),
    /** Anchor for shift+click range selection. */
    librarianLastClicked: null,
    /** Per-sub-tab last-viewed timestamps drive the "new since last view" badge. */
    librarianLastViewed: { flag: 0, activity: 0 },

    /** P13: session-local — cleared on reload. */
    reasoningWarningDismissed: false,
};

// ─── Activity Feed (last N pipeline trace summaries) ───

export const activityLog = [];
const MAX_ACTIVITY = 5;

/** Push a pipeline activity entry; most recent first, capped at MAX_ACTIVITY. */
export function pushActivity(entry) {
    activityLog.unshift(entry);
    if (activityLog.length > MAX_ACTIVITY) activityLog.pop();
}

// ─── Entry Temperature ───

/** Cached temperature map — invalidated on pipeline complete. */
let _tempCache = null;

/**
 * Injection-frequency tint per entry: hot (above-average) → warm; cold (below) → blue; neutral untinted.
 * Constants and contextually-gated entries are excluded from both the average and the display, since
 * they're not freely chosen by the AI and would skew the baseline.
 *
 * @returns {Map<string, {ratio: number, consecutive: number, tempScore: number, hue: string}>}
 */
export function computeEntryTemperatures() {
    if (_tempCache) return _tempCache;

    const temps = new Map();
    if (!vaultIndex.length || !chatInjectionCounts.size) return temps;

    const eligible = vaultIndex.filter(e => {
        if (e.constant) return false;
        const cf = e.customFields || {};
        return !Object.values(cf).some(v => v != null && v !== '' && (!Array.isArray(v) || v.length > 0));
    });
    if (!eligible.length) return temps;

    let totalCount = 0;
    for (const entry of eligible) {
        const key = trackerKey(entry);
        totalCount += chatInjectionCounts.get(key) || 0;
    }
    const avg = totalCount / eligible.length;
    if (avg === 0) return temps;

    for (const entry of eligible) {
        const key = trackerKey(entry);
        const count = chatInjectionCounts.get(key) || 0;
        const ratio = count / avg;
        const consec = consecutiveInjections.get(key) || 0;
        const tempScore = Math.min(3, Math.max(0, ratio + consec * 0.15));
        const hue = tempScore > 1.2 ? 'hot' : tempScore < 0.8 ? 'cold' : 'neutral';
        temps.set(key, { ratio, consecutive: consec, tempScore, hue });
    }

    _tempCache = temps;
    return temps;
}

export function invalidateTemperatureCache() {
    _tempCache = null;
}

// ─── Render Gating (Wave F) ───

/**
 * Is the drawer panel currently shown to the user?
 *
 * The signal is the `openDrawer` class — ST's `doNavbarIconClick` adds it on open
 * and removes it on close (drawer.js's toggle handler reads the same class to set
 * aria-expanded). `pinnedOpen` is *pin state*, NOT visibility: a pinned-but-closed
 * drawer is `closedDrawer pinnedOpen` with offsetHeight 0, so it must NOT count as
 * visible. A pinned-AND-open drawer carries `openDrawer pinnedOpen`, so checking
 * `openDrawer` alone is correct for both pinned and unpinned cases. Class-based
 * (NOT offsetParent/offsetHeight) so it never forces a reflow on the hot paths.
 *
 * The heavy tab/footer painters gate on this so generation-time observer churn
 * (verdict / counts / prompt-ready ticks) doesn't filter+sort the whole vault or
 * repaint the footer into a hidden drawer. Renders deferred while closed are
 * replayed on open (see drawer.js toggle handler + flushDrawerRenders). Gating is
 * **drawer-visible only, NOT active-tab** — the tab-bar badges (`.dle-librarian-badge`
 * in renderLibrarianTab, the browse count via `ds.browseFilteredEntries`) stay live
 * for every tab whenever the drawer is open. See docs/gotchas.md (Wave F).
 *
 * @returns {boolean}
 */
export function isDrawerVisible() {
    const el = ds.$drawer ? ds.$drawer.find('#deeplore-panel')[0] : null;
    if (!el) return false;
    return el.classList.contains('openDrawer');
}

// ─── Render Scheduling ───

let renderPending = false;
let pendingRenders = new Set();

/**
 * Schedule a render on the next animation frame. Same fn within a frame deduplicates.
 * @param {Function} renderFn
 */
export function scheduleRender(renderFn) {
    pendingRenders.add(renderFn);
    if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            const fns = [...pendingRenders];
            pendingRenders.clear();
            for (const fn of fns) {
                try { fn(); } catch (err) { console.warn('[DLE] Drawer render error:', err.message); }
            }
        });
    }
}

// ─── Shared Utility Functions ───

/**
 * Convert matchedBy reason → short badge label (e.g. 'KEY', 'AI', 'CONST').
 * @param {string|null} matchedBy
 * @returns {string}
 */
export function getMatchLabel(matchedBy) {
    if (!matchedBy) return '?';
    const { type } = parseMatchReason(matchedBy);
    const labels = {
        constant: 'CONST', pinned: 'PIN', bootstrap: 'INIT',
        seed: 'SEED', keyword: 'KEY', keyword_ai: 'KEY+AI', ai: 'AI',
    };
    return labels[type] || (matchedBy.length > 8 ? 'AI' : escapeHtml(matchedBy));
}

/** Announce via the aria-live region. */
export function announceToScreenReader(message) {
    const $live = $('#dle-drawer-live');
    if (!$live || !$live.length) return;
    $live.text('');
    requestAnimationFrame(() => $live.text(message));
}

/** 1234 → "1.2k", 12345 → "12.3k", 123 → "123". */
export function formatTokensCompact(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// ─── Lazy-loaded ST internals ───

export let dragElement, isMobile, power_user;

export async function loadSTInternals() {
    try {
        const ross = await import('../../../../../../scripts/RossAscends-mods.js');
        dragElement = ross.dragElement;
        isMobile = ross.isMobile;
        const pu = await import('../../../../../../scripts/power-user.js');
        power_user = pu.power_user;
    } catch (err) {
        console.warn('[DLE] Could not load ST internals for drawer (Moving UI/mobile detection unavailable):', err.message);
    }
}
