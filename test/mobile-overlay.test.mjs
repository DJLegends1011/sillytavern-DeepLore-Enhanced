/**
 * DeepLore Enhanced — Mobile overlay + mobile state unit tests.
 * Run with: node test/mobile-overlay.test.mjs
 */

import {
    assert,
    assertEqual,
    assertMatch,
    test,
    section,
    summary,
} from './helpers.mjs';

import {
    MOBILE_OVERLAY_TABS,
    MOBILE_DEFAULT_TAB,
    normalizeMobileTab,
    createMobileUiState,
} from '../src/mobile/mobile-state.js';

section('Mobile State — Tabs');

test('MOBILE_OVERLAY_TABS: lists the five spec tabs in order', () => {
    assertEqual(
        MOBILE_OVERLAY_TABS.join(','),
        'injection,browse,filters,librarian,tools',
    );
});

test('normalizeMobileTab: passes valid tabs through', () => {
    for (const tab of MOBILE_OVERLAY_TABS) {
        assertEqual(normalizeMobileTab(tab), tab);
    }
});

test('normalizeMobileTab: maps unknown values to the default tab', () => {
    assertEqual(normalizeMobileTab('home'), MOBILE_DEFAULT_TAB);
    assertEqual(normalizeMobileTab(''), MOBILE_DEFAULT_TAB);
    assertEqual(normalizeMobileTab(undefined), MOBILE_DEFAULT_TAB);
    assertEqual(normalizeMobileTab(42), MOBILE_DEFAULT_TAB);
});

test('MOBILE_DEFAULT_TAB: is injection (no home screen)', () => {
    assertEqual(MOBILE_DEFAULT_TAB, 'injection');
});

section('Mobile State — Factory');

test('createMobileUiState: returns closed overlay on the default tab', () => {
    const state = createMobileUiState();
    assertEqual(state.open, false);
    assertEqual(state.tab, 'injection');
    assertEqual(state.errorMessage, '');
    assertEqual(state.statsExpanded, false);
    assertEqual(state.injectionFilter, 'injected');
    assertEqual(typeof state.browse, 'object');
    assertEqual(typeof state.scrollPositions, 'object');
});

test('createMobileUiState: accepts overrides and normalizes the tab', () => {
    const state = createMobileUiState({ open: true, tab: 'browse' });
    assertEqual(state.open, true);
    assertEqual(state.tab, 'browse');
    const fixed = createMobileUiState({ tab: 'home' });
    assertEqual(fixed.tab, 'injection');
});

test('createMobileUiState: instances do not share scrollPositions', () => {
    const a = createMobileUiState();
    const b = createMobileUiState();
    a.scrollPositions.browse = 120;
    assertEqual(b.scrollPositions.browse, undefined);
});

import {
    OVERLAY_ID,
    OVERLAY_TAB_DEFS,
    QUICK_ACTION_DEFS,
    renderOverlay,
    renderOverlayHeader,
    renderOverlayTabBar,
    renderQuickActions,
    renderOverlayError,
    renderStatusMetric,
    shouldDismissSwipe,
    SWIPE_DISMISS_VELOCITY,
    SWIPE_DISMISS_FRACTION,
} from '../src/mobile/mobile-overlay.js';

section('Overlay — Tab Bar');

test('OVERLAY_TAB_DEFS: ids match MOBILE_OVERLAY_TABS order', () => {
    assertEqual(OVERLAY_TAB_DEFS.map(t => t.id).join(','), MOBILE_OVERLAY_TABS.join(','));
});

test('renderOverlayTabBar: renders five tabs with active aria-selected', () => {
    const html = renderOverlayTabBar('browse');
    for (const tab of MOBILE_OVERLAY_TABS) {
        assert(html.includes(`data-dle-mobile-tab="${tab}"`), `tab bar should render ${tab}`);
    }
    assert(html.includes('data-dle-mobile-tab="browse" aria-selected="true"'), 'browse should be selected');
    assert(html.includes('data-dle-mobile-tab="injection" aria-selected="false"'), 'injection should not be selected');
    assert(html.includes('role="tablist"'), 'should expose tablist role');
});

test('renderOverlayTabBar: normalizes unknown active tab to default', () => {
    const html = renderOverlayTabBar('home');
    assert(html.includes('data-dle-mobile-tab="injection" aria-selected="true"'), 'unknown tab should fall back to injection');
});

test('renderOverlayTabBar: shows badge dot for flagged tabs only', () => {
    const html = renderOverlayTabBar('injection', { librarian: true });
    const librarianChunk = html.split('data-dle-mobile-tab="librarian"')[1].split('</button>')[0];
    const browseChunk = html.split('data-dle-mobile-tab="browse"')[1].split('</button>')[0];
    assert(librarianChunk.includes('dle-mobile-overlay-tab-dot'), 'librarian should show badge dot');
    assert(!browseChunk.includes('dle-mobile-overlay-tab-dot'), 'browse should not show badge dot');
});

section('Overlay — Header');

test('renderOverlayHeader: shows status subtitle, settings gear, and close', () => {
    const html = renderOverlayHeader({ statusLabel: 'Ready', injectedCount: 3 }, { statsExpanded: false });
    assert(html.includes('Ready · 3 injected'), 'subtitle should combine status and injected count');
    assert(html.includes('data-dle-mobile-action="settings"'), 'should render settings gear');
    assert(html.includes('data-dle-mobile-action="close"'), 'should render close button');
    assert(html.includes('data-dle-mobile-action="toggle-stats"'), 'status block should toggle stats');
    assert(html.includes('data-dle-mobile-swipe-handle'), 'header should be the swipe handle');
    assert(!html.includes('dle-mobile-status-grid'), 'collapsed header should not render stats grid');
});

test('renderOverlayHeader: expanded state renders the five-metric stats grid', () => {
    const stats = {
        budget: { label: 'Budget', value: '1k', tone: 'ok', ratio: 40 },
        entries: { label: 'Entries', value: '12', tone: 'ok', ratio: 10 },
        context: { label: 'Context', value: '50%', tone: 'warn', ratio: 50 },
        ai: { label: 'AI', value: '2 calls', tone: 'ok', ratio: 20 },
        health: { label: 'Health', value: 'OK', tone: 'ok', ratio: 100 },
    };
    const html = renderOverlayHeader({ statusLabel: 'Ready', injectedCount: 0, stats }, { statsExpanded: true });
    assert(html.includes('dle-mobile-status-grid'), 'expanded header should render stats grid');
    assert(html.includes('aria-expanded="true"'), 'toggle should report expanded');
    assert(html.includes('Budget'), 'grid should include budget metric');
    assert(html.includes('Health'), 'grid should include health metric');
});

test('renderOverlayHeader: escapes status label', () => {
    const html = renderOverlayHeader({ statusLabel: '<img onerror=x>', injectedCount: 0 }, {});
    assert(!html.includes('<img onerror'), 'status label must be escaped');
});

section('Overlay — Quick Actions');

test('QUICK_ACTION_DEFS: covers the seven spec actions', () => {
    assertEqual(
        QUICK_ACTION_DEFS.map(a => a.id).join(','),
        'refresh,reroll,skip-librarian,scribe,new-entry,librarian-chat,graph',
    );
});

test('renderQuickActions: command actions carry slash commands', () => {
    const html = renderQuickActions();
    assert(html.includes('data-dle-mobile-command="/dle-scribe"'), 'scribe should run /dle-scribe');
    assert(html.includes('data-dle-mobile-command="/dle-newlore"'), 'new entry should run /dle-newlore');
    assert(html.includes('data-dle-mobile-command="/dle-librarian"'), 'librarian chat should run /dle-librarian');
    assert(html.includes('data-dle-mobile-command="/dle-graph"'), 'graph should run /dle-graph');
});

test('renderQuickActions: refresh reuses the shared refresh handler attribute', () => {
    const html = renderQuickActions();
    assert(html.includes('data-dle-mobile-refresh'), 'refresh should use existing refresh delegation');
});

test('renderQuickActions: reroll and skip use local quick actions', () => {
    const html = renderQuickActions();
    assert(html.includes('data-dle-mobile-action="quick-reroll"'), 'reroll should be a local action');
    assert(html.includes('data-dle-mobile-action="quick-skip-librarian"'), 'skip should be a local action');
});

test('renderQuickActions: skip librarian reflects pressed state', () => {
    const off = renderQuickActions({ skipLibrarianActive: false });
    const on = renderQuickActions({ skipLibrarianActive: true });
    assert(off.includes('data-dle-mobile-action="quick-skip-librarian" aria-pressed="false"'), 'skip should start unpressed');
    assert(on.includes('data-dle-mobile-action="quick-skip-librarian" aria-pressed="true"'), 'skip should press when active');
});

section('Overlay — Shell and Error Card');

test('renderOverlay: composes scrim, panel, header, tabs, quick row, content', () => {
    const html = renderOverlay({
        snapshot: { statusLabel: 'Ready', injectedCount: 1, gapCount: 0 },
        uiState: createMobileUiState({ open: true, tab: 'browse' }),
        contentHtml: '<p data-test-marker>tab body</p>',
    });
    assert(html.includes(`id="${OVERLAY_ID}"`), 'should render overlay root id');
    assert(html.includes('dle-mobile-open'), 'open overlay should carry open class');
    assert(html.includes('dle-mobile-overlay-scrim'), 'should render scrim');
    assert(html.includes('dle-mobile-overlay-panel'), 'should render glass panel');
    assert(html.includes('dle-mobile-overlay-tabs'), 'should render tab bar');
    assert(html.includes('dle-mobile-overlay-quick'), 'should render quick actions');
    assert(html.includes('data-test-marker'), 'should embed tab content');
    assert(html.includes('aria-hidden="false"'), 'open overlay should be visible to a11y tree');
});

test('renderOverlay: closed overlay stays mounted, hidden, and inert', () => {
    const html = renderOverlay({
        snapshot: { statusLabel: 'Ready', injectedCount: 0, gapCount: 0 },
        uiState: createMobileUiState({ open: false }),
        contentHtml: '',
    });
    assert(!html.includes('dle-mobile-open'), 'closed overlay should not have open class');
    assert(html.includes('aria-hidden="true"'), 'closed overlay should be aria-hidden');
    assert(html.includes('inert'), 'closed overlay should be inert');
});

test('renderOverlay: lore gaps put a badge dot on the librarian tab', () => {
    const html = renderOverlay({
        snapshot: { statusLabel: 'Ready', injectedCount: 0, gapCount: 4 },
        uiState: createMobileUiState({ open: true }),
        contentHtml: '',
    });
    const librarianChunk = html.split('data-dle-mobile-tab="librarian"')[1].split('</button>')[0];
    assert(librarianChunk.includes('dle-mobile-overlay-tab-dot'), 'gaps should flag the librarian tab');
});

test('renderOverlay: error message renders above content', () => {
    const html = renderOverlay({
        snapshot: { statusLabel: 'Ready', injectedCount: 0, gapCount: 0 },
        uiState: createMobileUiState({ open: true, errorMessage: 'boom & <bust>' }),
        contentHtml: '<p data-test-marker></p>',
    });
    const errorIndex = html.indexOf('dle-mobile-error');
    const contentIndex = html.indexOf('data-test-marker');
    assert(errorIndex >= 0, 'should render error card');
    assert(errorIndex < contentIndex, 'error should precede tab content');
    assert(html.includes('boom &amp; &lt;bust&gt;'), 'error text must be escaped');
});

test('renderOverlayError: renders an alert card with escaped text', () => {
    const html = renderOverlayError('<script>alert(1)</script>');
    assert(html.includes('role="alert"'), 'error card should be an alert');
    assert(!html.includes('<script>'), 'error text must be escaped');
});

test('renderStatusMetric: clamps ratio and renders tone class', () => {
    const html = renderStatusMetric({ label: 'Budget', value: '90%', tone: 'warn', ratio: 250 });
    assert(html.includes('dle-mobile-status-warn'), 'should carry tone class');
    assert(html.includes('width:100%'), 'ratio should clamp to 100');
});

section('Overlay — Swipe Dismiss');

test('shouldDismissSwipe: upward or zero movement never dismisses', () => {
    assert(!shouldDismissSwipe({ dy: 0, durationMs: 100, viewportHeight: 800 }), 'zero dy should not dismiss');
    assert(!shouldDismissSwipe({ dy: -200, durationMs: 50, viewportHeight: 800 }), 'upward swipe should not dismiss');
});

test('shouldDismissSwipe: slow short drag does not dismiss', () => {
    // 100px over 1s on an 800px viewport: 12.5% of height, 100px/s
    assert(!shouldDismissSwipe({ dy: 100, durationMs: 1000, viewportHeight: 800 }), 'slow short drag should not dismiss');
});

test('shouldDismissSwipe: dragging past 40% of viewport dismisses regardless of speed', () => {
    assert(shouldDismissSwipe({ dy: 320, durationMs: 5000, viewportHeight: 800 }), '40% drag should dismiss');
    assert(!shouldDismissSwipe({ dy: 319, durationMs: 5000, viewportHeight: 800 }), 'just under 40% slow drag should not dismiss');
});

test('shouldDismissSwipe: fast flick dismisses even when short', () => {
    // 60px in 100ms = 600px/s
    assert(shouldDismissSwipe({ dy: 60, durationMs: 100, viewportHeight: 800 }), 'fast flick should dismiss');
});

test('shouldDismissSwipe: velocity threshold is 300px/s and fraction is 0.4', () => {
    assertEqual(SWIPE_DISMISS_VELOCITY, 300);
    assertEqual(SWIPE_DISMISS_FRACTION, 0.4);
});

summary('Mobile Overlay Tests');
