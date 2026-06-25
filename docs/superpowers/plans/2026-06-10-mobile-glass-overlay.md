# Mobile Glass Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile bottom sheet + home drill-in with the spec'd full-screen glassmorphic overlay: persistent top tab bar (Injection | Browse | Filters | Librarian | Tools), quick-action row, glass header with status dropdown, swipe-to-dismiss.

**Architecture:** Two new pure modules — `mobile-state.js` (UI state factory + tab normalization) and `mobile-overlay.js` (overlay chrome renderers + swipe math). `mobile-shell.js` keeps its snapshot builder, subscriptions, and event delegation, but renders the overlay instead of the sheet and loses the home view (default tab = Injection). Tab content renderers (`renderInjection`, `renderBrowse`, etc.) stay in the shell for now — moving them out is the job of the later per-tab module plans.

**Tech Stack:** Vanilla ES modules, no build step, innerHTML rendering, `color-mix()` + `backdrop-filter` glass CSS chained on `--SmartTheme*` variables, node test files under `test/`.

**Spec:** `docs/superpowers/specs/2026-05-14-mobile-glassmorphic-redesign.md`

**v2.5 migration reconciliation (2026-06-24):** This 2026-06-10 plan remains historical, but current implementation guidance is DeepLore on v2.5 `origin/staging` baseline `e63679f306276809f03f3935d51a2de57bbc19dd`. Runtime data comes from current-chat `VerdictStore` reads/snapshot fields, Obsidian launches through `openObsidianUri`, and new mobile copy belongs in canonical English locale keys only; the maintainer owns other locale translations.

---

## Decisions Locked In This Plan

These resolve gaps or conflicts between the spec and the actual codebase. Do not re-litigate them mid-task:

1. **No `/dle-settings` command exists.** The header gear calls `openSettingsPopup()` from `src/ui/settings-ui.js` via dynamic import — same pattern as `src/drawer/drawer.js:300`.
2. **Reroll Lore** mirrors the v2.5 desktop Clear Picks semantics: `resetAiSearchCache()`, preserve the current-chat `VerdictStore` record, clear `chat_metadata.deeplore_injection_log` when metadata is available, and save metadata.
3. **Skip Librarian** mirrors desktop `skip-tools`: toggle `setSuppressNextAgenticLoop(...)`; pressed state reads `suppressNextAgenticLoop` (`src/state.js:313–314`).
4. **Quick-action commands:** Scribe = `/dle-scribe`, New Entry = `/dle-newlore`, Librarian Chat = `/dle-librarian`, Graph = `/dle-graph`. Refresh reuses the existing `data-dle-mobile-refresh` handler (calls `buildIndex`).
5. **State key rename:** `mobileState.view` becomes `mobileState.tab`. The `'home'` view is deleted; default tab is `'injection'`. Tab buttons use a new `data-dle-mobile-tab` attribute; the old `data-dle-mobile-view` attribute is removed entirely from mobile code.
6. **Filters tab is a stub** in this plan (full-view button running `/dle-context-state`). The real Filters tab is the separate `mobile-filters.js` plan.
7. **Status tray survives** as a header dropdown: tapping the header status block (`data-dle-mobile-action="toggle-stats"`, same action name as today) toggles the existing `dle-mobile-status-grid` metrics under the header.
8. **`mobile-state.js` is slim**: state factory + tab constants + normalization. The spec's event bus is deferred — `src/state.js` emitters already drive re-renders and a second bus is YAGNI until a tab module needs one.
9. **Swipe-to-dismiss handlers live in the shell** as delegated `touchstart/touchmove/touchend` listeners on the mobile root (innerHTML replacement destroys per-element listeners). The dismiss *decision* is a pure helper in `mobile-overlay.js`. The DOM wiring is covered by browser smoke, not unit tests (the test DOM mock has no touch synthesis).
10. **Recent Activity feed is out of scope** for this plan — its data source needs separate investigation.
11. **escapeHtml is defined locally** in `mobile-overlay.js`, matching the existing convention (`mobile-shell.js` and `mobile-fab.js` each carry their own).

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/mobile/mobile-state.js` | Create | UI state factory, `MOBILE_OVERLAY_TABS`, `normalizeMobileTab` |
| `src/mobile/mobile-overlay.js` | Create | Overlay chrome renderers (header, tab bar, quick actions, error card, full overlay), status metric renderer, swipe-dismiss math |
| `src/mobile/mobile-shell.js` | Modify | Render overlay instead of sheet; tab switching, scroll preservation, quick-action + settings + swipe handlers; delete home view, status tray renderer, drill headers |
| `style.css` | Modify | Glass overlay CSS (replaces `.dle-mobile-sheet` block), tab bar, quick row, safe-area padding, `@supports` fallback |
| `test/mobile-overlay.test.mjs` | Create | Unit tests for mobile-state + mobile-overlay |
| `test/mobile-ui.test.mjs` | Modify | Update render-contract tests from sheet/home to overlay/tabs |
| `package.json` | Modify | Add `test/mobile-overlay.test.mjs` to `test:mobile` and `test:all` |

---

### Task 1: `mobile-state.js` — state factory and tab normalization

**Files:**
- Create: `src/mobile/mobile-state.js`
- Create: `test/mobile-overlay.test.mjs`
- Modify: `package.json` (scripts)

- [x] **Step 1: Write the failing tests**

Create `test/mobile-overlay.test.mjs`:

```js
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

summary('Mobile Overlay Tests');
```

> Note: check `test/helpers.mjs` for the exact `summary` signature — `test/mobile-fab.test.mjs` calls it the same way; mirror that file's import list exactly if `assertMatch` is not exported (in that case use `assert(re.test(html), msg)` instead and drop the import).

- [x] **Step 2: Run tests to verify they fail**

Run: `node test/mobile-overlay.test.mjs`
Expected: FAIL — `Cannot find module '../src/mobile/mobile-state.js'`

- [x] **Step 3: Write the implementation**

Create `src/mobile/mobile-state.js`:

```js
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
    return state;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node test/mobile-overlay.test.mjs`
Expected: PASS, 0 failed

- [x] **Step 5: Wire the new test file into npm scripts**

In `package.json`, change:

```json
"test:mobile": "node test/mobile-ui.test.mjs && node test/mobile-fab.test.mjs && node test/mobile-overlay.test.mjs",
```

and append `&& node test/mobile-overlay.test.mjs` to `test:all` immediately after `node test/mobile-fab.test.mjs` (keep `verify-imports.mjs` last).

Run: `npm run test:mobile`
Expected: all three suites pass

- [x] **Step 6: Commit**

```bash
git add src/mobile/mobile-state.js test/mobile-overlay.test.mjs package.json
git commit -m "feat(mobile): add mobile-state module with overlay tab model"
```

---

### Task 2: `mobile-overlay.js` — overlay chrome renderers

**Files:**
- Create: `src/mobile/mobile-overlay.js`
- Modify: `test/mobile-overlay.test.mjs` (append tests)

- [x] **Step 1: Write the failing tests**

Append to `test/mobile-overlay.test.mjs` (above the final `summary(...)` call — keep `summary` last in the file for every task that appends tests):

```js
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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node test/mobile-overlay.test.mjs`
Expected: FAIL — `Cannot find module '../src/mobile/mobile-overlay.js'`

- [x] **Step 3: Write the implementation**

Create `src/mobile/mobile-overlay.js`:

```js
/**
 * DeepLore Enhanced — Mobile glass overlay chrome.
 * Pure renderers: take snapshots/UI state, return HTML strings. No DOM access.
 * The shell composes these and owns all event handling.
 */

import { MOBILE_DEFAULT_TAB, normalizeMobileTab } from './mobile-state.js';

export const OVERLAY_ID = 'dle-mobile-overlay';

export const OVERLAY_TAB_DEFS = [
    { id: 'injection', label: 'Injection', icon: 'fa-circle-question' },
    { id: 'browse', label: 'Browse', icon: 'fa-book-open' },
    { id: 'filters', label: 'Filters', icon: 'fa-filter' },
    { id: 'librarian', label: 'Librarian', icon: 'fa-book-bookmark' },
    { id: 'tools', label: 'Tools', icon: 'fa-toolbox' },
];

export const QUICK_ACTION_DEFS = [
    { id: 'refresh', label: 'Refresh index', icon: 'fa-rotate', kind: 'refresh' },
    { id: 'reroll', label: 'Reroll Lore', icon: 'fa-shuffle', kind: 'action' },
    { id: 'skip-librarian', label: 'Skip Librarian', icon: 'fa-ban', kind: 'toggle' },
    { id: 'scribe', label: 'Scribe', icon: 'fa-feather-pointed', kind: 'command', command: '/dle-scribe' },
    { id: 'new-entry', label: 'New Entry', icon: 'fa-plus', kind: 'command', command: '/dle-newlore' },
    { id: 'librarian-chat', label: 'Librarian Chat', icon: 'fa-book-bookmark', kind: 'command', command: '/dle-librarian' },
    { id: 'graph', label: 'Graph', icon: 'fa-diagram-project', kind: 'command', command: '/dle-graph' },
];

export const SWIPE_DISMISS_VELOCITY = 300; // px/s downward
export const SWIPE_DISMISS_FRACTION = 0.4; // of viewport height

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderStatusMetric(metric) {
    const ratio = Math.max(0, Math.min(100, Number(metric?.ratio || 0)));
    return `
        <div class="dle-mobile-status-metric dle-mobile-status-${escapeHtml(metric?.tone || 'ok')}">
            <span>${escapeHtml(metric?.label || '')}</span>
            <strong>${escapeHtml(metric?.value || '')}</strong>
            ${metric?.detail ? `<small>${escapeHtml(metric.detail)}</small>` : ''}
            <div class="dle-mobile-status-bar" aria-hidden="true"><span style="width:${ratio}%"></span></div>
        </div>
    `;
}

export function renderOverlayHeader(snapshot = {}, uiState = {}) {
    const expanded = !!uiState.statsExpanded;
    const subtitle = `${snapshot.statusLabel || 'Unknown'} · ${snapshot.injectedCount ?? 0} injected`;
    const stats = snapshot.stats;
    return `
        <header class="dle-mobile-overlay-header" data-dle-mobile-swipe-handle>
            <button type="button" class="dle-mobile-overlay-status" data-dle-mobile-action="toggle-stats" aria-expanded="${expanded ? 'true' : 'false'}">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                <span class="dle-mobile-overlay-status-text">
                    <strong>DeepLore</strong>
                    <small>${escapeHtml(subtitle)}</small>
                </span>
                <i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i>
            </button>
            <button type="button" class="dle-mobile-overlay-icon-btn" data-dle-mobile-action="settings" aria-label="Open DeepLore settings">
                <i class="fa-solid fa-gear" aria-hidden="true"></i>
            </button>
            <button type="button" class="dle-mobile-overlay-icon-btn" data-dle-mobile-action="close" aria-label="Close DeepLore overlay">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        </header>
        ${expanded && stats ? `<div class="dle-mobile-status-grid">
            ${renderStatusMetric(stats.budget)}
            ${renderStatusMetric(stats.entries)}
            ${renderStatusMetric(stats.context)}
            ${renderStatusMetric(stats.ai)}
            ${renderStatusMetric(stats.health)}
        </div>` : ''}
    `;
}

export function renderOverlayTabBar(activeTab = MOBILE_DEFAULT_TAB, badges = {}) {
    const current = normalizeMobileTab(activeTab);
    const buttons = OVERLAY_TAB_DEFS.map(tab => `
        <button type="button" role="tab" class="dle-mobile-overlay-tab" data-dle-mobile-tab="${tab.id}" aria-selected="${tab.id === current ? 'true' : 'false'}">
            <i class="fa-solid ${tab.icon}" aria-hidden="true"></i>
            <span>${escapeHtml(tab.label)}</span>
            ${badges[tab.id] ? '<span class="dle-mobile-overlay-tab-dot" aria-hidden="true"></span>' : ''}
        </button>
    `).join('');
    return `<nav class="dle-mobile-overlay-tabs" role="tablist" aria-label="DeepLore sections">${buttons}</nav>`;
}

export function renderQuickActions({ skipLibrarianActive = false } = {}) {
    const buttons = QUICK_ACTION_DEFS.map(action => {
        const icon = `<i class="fa-solid ${action.icon}" aria-hidden="true"></i>`;
        const label = escapeHtml(action.label);
        if (action.kind === 'command') {
            return `<button type="button" class="dle-mobile-overlay-quick-btn" data-dle-mobile-command="${action.command}" aria-label="${label}" title="${label}">${icon}</button>`;
        }
        if (action.kind === 'refresh') {
            return `<button type="button" class="dle-mobile-overlay-quick-btn" data-dle-mobile-refresh aria-label="${label}" title="${label}">${icon}</button>`;
        }
        const pressed = action.kind === 'toggle' ? ` aria-pressed="${skipLibrarianActive ? 'true' : 'false'}"` : '';
        const activeClass = action.kind === 'toggle' && skipLibrarianActive ? ' dle-mobile-overlay-quick-active' : '';
        return `<button type="button" class="dle-mobile-overlay-quick-btn${activeClass}" data-dle-mobile-action="quick-${action.id}"${pressed} aria-label="${label}" title="${label}">${icon}</button>`;
    }).join('');
    return `<div class="dle-mobile-overlay-quick" role="toolbar" aria-label="Quick actions">${buttons}</div>`;
}

export function renderOverlayError(message) {
    return `<div class="dle-mobile-error" role="alert">${escapeHtml(message)}</div>`;
}

export function renderOverlay({ snapshot = {}, uiState = {}, contentHtml = '', skipLibrarianActive = false } = {}) {
    const open = !!uiState.open;
    return `
        <section id="${OVERLAY_ID}" class="dle-mobile-overlay${open ? ' dle-mobile-open' : ''}" role="dialog" aria-modal="false" aria-hidden="${open ? 'false' : 'true'}" aria-label="DeepLore mobile overlay"${open ? '' : ' inert'}>
            <div class="dle-mobile-overlay-scrim" data-dle-mobile-action="close"></div>
            <div class="dle-mobile-overlay-panel">
                ${renderOverlayHeader(snapshot, uiState)}
                ${renderOverlayTabBar(uiState.tab, { librarian: (snapshot.gapCount || 0) > 0 })}
                ${renderQuickActions({ skipLibrarianActive })}
                <div class="dle-mobile-overlay-content">
                    ${uiState.errorMessage ? renderOverlayError(uiState.errorMessage) : ''}
                    ${contentHtml}
                </div>
            </div>
        </section>
    `;
}

export function shouldDismissSwipe({ dy = 0, durationMs = 0, viewportHeight = 0 } = {}) {
    if (dy <= 0) return false;
    const velocity = durationMs > 0 ? (dy / durationMs) * 1000 : 0;
    if (viewportHeight > 0 && dy >= viewportHeight * SWIPE_DISMISS_FRACTION) return true;
    return velocity >= SWIPE_DISMISS_VELOCITY;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node test/mobile-overlay.test.mjs`
Expected: PASS, 0 failed

- [x] **Step 5: Commit**

```bash
git add src/mobile/mobile-overlay.js test/mobile-overlay.test.mjs
git commit -m "feat(mobile): add glass overlay chrome renderers"
```

---

### Task 3: Swipe-dismiss math tests

**Files:**
- Modify: `test/mobile-overlay.test.mjs` (append tests; implementation already landed in Task 2)

- [x] **Step 1: Write the tests**

Append to `test/mobile-overlay.test.mjs` (import `shouldDismissSwipe`, `SWIPE_DISMISS_VELOCITY`, `SWIPE_DISMISS_FRACTION` from `../src/mobile/mobile-overlay.js` by extending the existing import):

```js
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
```

- [x] **Step 2: Run tests to verify they pass**

Run: `node test/mobile-overlay.test.mjs`
Expected: PASS (implementation exists from Task 2; if any fail, fix `shouldDismissSwipe`, not the tests)

- [x] **Step 3: Commit**

```bash
git add test/mobile-overlay.test.mjs
git commit -m "test(mobile): cover swipe-dismiss thresholds"
```

---

### Task 4: Shell renders the overlay (render-side migration)

This is the core migration. `mobile-shell.js` stops rendering the sheet and home view; existing render-contract tests in `test/mobile-ui.test.mjs` are updated in the same task so the suite stays green at commit time.

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Modify: `test/mobile-ui.test.mjs`

- [x] **Step 1: Update imports and state initialization in `mobile-shell.js`**

Add to the import block:

```js
import {
    createMobileUiState,
    normalizeMobileTab,
} from './mobile-state.js';
import {
    renderOverlay,
    renderOverlayError,
    shouldDismissSwipe,
} from './mobile-overlay.js';
```

Replace the `mobileState` initializer (lines 59–71) with:

```js
let mobileState = createMobileUiState();
```

In `destroyMobileShell`, replace the trailing state-reset object literal with:

```js
    mobileState = createMobileUiState();
```

In `setMobileMode`, no change. Everywhere else in the file, replace `mobileState.view` with `mobileState.tab` (occurrences: injection filter handler sets `mobileState.view = 'injection'`; injection `browse` action sets `mobileState.view = 'browse'`).

- [x] **Step 2: Delete the sheet/home renderers and render the overlay**

Delete these functions from `mobile-shell.js` outright: `renderPill`, `renderStatusMetric`, `renderStatusTray`, `renderHome`. (`renderStatusMetric` now lives in `mobile-overlay.js`.)

Replace `renderActionButton` with a command-only version (it is now used only by Tools):

```js
function renderCommandButton(label, icon, command) {
    return `
        <button class="dle-mobile-action" type="button" data-dle-mobile-command="${escapeHtml(command)}">
            <i class="fa-solid ${escapeHtml(icon)}" aria-hidden="true"></i>
            <span>${escapeHtml(label)}</span>
        </button>
    `;
}
```

Replace `renderBody` with:

```js
function renderFiltersStub() {
    return `
        <div class="dle-mobile-filters-stub">
            <strong>Filters are coming to mobile</strong>
            <span>Folder and gating filters will land here. Until then, use the full desktop view.</span>
            <button class="dle-mobile-wide-action" type="button" data-dle-mobile-command="${commandForView('filters')}">Open full Filters view</button>
        </div>
    `;
}

function renderBody(snapshot, tab, mode = 'auto', state = mobileState) {
    switch (normalizeMobileTab(tab)) {
        case 'browse': return renderBrowse(snapshot, state);
        case 'filters': return renderFiltersStub();
        case 'librarian': return renderLibrarian(snapshot);
        case 'tools': return renderTools(mode);
        default: return renderInjection(snapshot, state);
    }
}

function renderTabContent(snapshot, state) {
    try {
        return renderBody(snapshot, state.tab, state.mode, state);
    } catch (err) {
        console.error('[DLE] Mobile tab render failed:', state.tab, err);
        return renderOverlayError(`Could not render ${state.tab}: ${err?.message || err}`);
    }
}
```

Replace `renderMobileShellContents` (the whole sheet template) with:

```js
function renderMobileShellContents(snapshot, state = mobileState) {
    return renderOverlay({
        snapshot,
        uiState: state,
        contentHtml: renderTabContent(snapshot, state),
        skipLibrarianActive: suppressNextAgenticLoop,
    });
}
```

Add `suppressNextAgenticLoop` to the `../state.js` import list (the rest of the reroll/skip imports come in Task 6; adding them all now is also fine: `resetAiSearchCache` and `setSuppressNextAgenticLoop`). Keep runtime injected-source and trace reads on the current-chat `VerdictStore` snapshot; do not add pre-v2.5 module globals.

Update the exported `renderMobileShell` default state:

```js
export function renderMobileShell(snapshot, state = createMobileUiState()) {
    return `<div id="${ROOT_ID}" class="dle-mobile-shell">${renderMobileShellContents(snapshot, state)}</div>`;
}
```

- [x] **Step 3: Strip the drill headers from tab renderers**

In `renderInjection`, replace the `dle-mobile-drill-header` div with:

```js
        <div class="dle-mobile-tab-toolbar">
            <span class="dle-mobile-injection-count">${snapshot.injectedCount}</span>
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-injection-action="copy-titles" aria-label="Copy injected titles"${copyDisabled ? ' disabled' : ''}><i class="fa-solid fa-clipboard" aria-hidden="true"></i></button>
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-command="${commandForView('injection')}" aria-label="Open full Injection view"><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i></button>
        </div>
```

In `renderBrowse`, replace its `dle-mobile-drill-header` div with:

```js
        <div class="dle-mobile-tab-toolbar">
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-command="${commandForView('browse')}" aria-label="Open full Browse view"><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i></button>
        </div>
```

In `renderLibrarian` and `renderTools`, delete the `dle-mobile-drill-header` div entirely (keep the rest of each template unchanged — Tools keeps its four command buttons via `renderCommandButton('Health', 'fa-heart-pulse', commandForView('health'))` etc., the wide Refresh button, and the mode group).

- [x] **Step 4: Update `renderCurrentState` and the click handler for tabs**

In `renderCurrentState`, after `root.innerHTML = ...`, add scroll restore:

```js
    restoreScrollPosition();
```

Add these helpers near `renderCurrentState`:

```js
function captureScrollPosition() {
    const content = mobileRoot?.querySelector?.('.dle-mobile-overlay-content');
    if (content) mobileState.scrollPositions[mobileState.tab] = content.scrollTop || 0;
}

function restoreScrollPosition() {
    const content = mobileRoot?.querySelector?.('.dle-mobile-overlay-content');
    if (content) content.scrollTop = mobileState.scrollPositions[mobileState.tab] || 0;
}
```

In `handleMobileClick`, replace the entire `viewEl` branch (`const viewEl = target.closest('[data-dle-mobile-view]'); ...`) with:

```js
    const tabEl = target.closest('[data-dle-mobile-tab]');
    if (tabEl) {
        captureScrollPosition();
        mobileState.errorMessage = '';
        mobileState.tab = normalizeMobileTab(tabEl.getAttribute('data-dle-mobile-tab'));
        mobileState.open = true;
        renderCurrentState();
        return;
    }
```

In the injection-action branch, change `mobileState.view = 'browse'` to `mobileState.tab = 'browse'`; in the injection-filter branch change `mobileState.view = 'injection'` to `mobileState.tab = 'injection'`.

Add the settings action inside the existing `actionEl` branch (alongside `toggle`/`close`/`toggle-stats`):

```js
        if (action === 'settings') {
            import('../ui/settings-ui.js')
                .then(m => m.openSettingsPopup?.())
                .catch(err => {
                    console.error('[DLE] Mobile settings open failed:', err);
                    setMobileError('Could not open DeepLore settings.');
                    renderCurrentState();
                });
            return;
        }
```

- [x] **Step 5: Update render-contract tests in `test/mobile-ui.test.mjs`**

Update these existing tests (search by name). Any assertion in the file that references `.dle-mobile-sheet`, `#dle-mobile-sheet`, `data-dle-mobile-view`, the home view, dock markup, or `view: 'home'` state must change in this step. The specific rewrites:

**`renderMobileShell: renders hybrid dock, home sheet, and quick actions`** → rename to `renderMobileShell: renders glass overlay with tab bar and quick actions`, body:

```js
    const snapshot = buildMobileShellSnapshot({ /* keep this test's existing snapshot inputs */ });
    const html = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection' }));
    assertMatch(html, /id="dle-mobile-overlay"/, 'should render overlay root');
    assertMatch(html, /dle-mobile-overlay-panel/, 'should render glass panel');
    assertMatch(html, /data-dle-mobile-tab="injection" aria-selected="true"/, 'injection tab should be active by default');
    for (const tab of ['injection', 'browse', 'filters', 'librarian', 'tools']) {
        assertMatch(html, new RegExp(`data-dle-mobile-tab="${tab}"`), `should render ${tab} tab`);
    }
    assertMatch(html, /data-dle-mobile-action="quick-reroll"/, 'should render quick actions');
    assertMatch(html, /data-dle-mobile-command="\/dle-scribe"/, 'quick actions should include scribe');
```

Import `createMobileUiState` from `../src/mobile/mobile-state.js` at the top of the test file.

**`renderMobileShell: renders collapsed and expanded status tray`** → keep the name, change assertions to the header dropdown: collapsed render (`statsExpanded: false`) must include `data-dle-mobile-action="toggle-stats"` with `aria-expanded="false"` and must NOT include `dle-mobile-status-grid`; expanded render (`statsExpanded: true`) must include `dle-mobile-status-grid` and the five metric labels it already asserts.

**`renderMobileShell: closed shell keeps sheet mounted and collapsed`** → rename to `renderMobileShell: closed shell keeps overlay mounted and inert`, assert: html includes `id="dle-mobile-overlay"`, includes `aria-hidden="true"`, includes `inert`, and does NOT include `dle-mobile-open`.

**`renderMobileShell: labels the mobile injected-sources drill-in as Injection`** → assert the tab bar renders `>Injection<` inside the injection tab button and the injection toolbar renders `data-dle-mobile-injection-action="copy-titles"` (the old back-button/drill-title assertions are removed).

**`renderMobileShell: tools view exposes mobile mode controls`** → state argument becomes `createMobileUiState({ open: true, tab: 'tools' })`; mode-button assertions unchanged; remove any drill-header assertion.

**`renderMobileShell: drill-in views tolerate missing array fields`** → iterate `['injection', 'browse', 'filters', 'librarian', 'tools']` as tabs via `createMobileUiState({ open: true, tab })`.

**Browse/Injection render tests** (`renders search, filters, quick filters, and cards`, `Browse cards expose visible pin and block states`, `renderInjection: renders header with Injection title and badge`, etc.) → state arguments switch from `{ open: true, view: 'browse' }` shapes to `createMobileUiState({ open: true, tab: 'browse' })`; assertions on a back button or `data-dle-mobile-view="home"` are deleted; the `renderInjection` header test now asserts the toolbar (`dle-mobile-tab-toolbar`, copy button, full-view command button) instead of an `Injection` heading.

**`renderMobileShell: renders escaped error slot above active body`** and **`shows mobile error alert when command or refresh fails`** → unchanged assertions on `.dle-mobile-error`; just update any state-shape arguments to `createMobileUiState(...)`.

**`mobile shell: injection filter clicks update state`** and **mode/storage click tests** → update any `view:` expectations to `tab:`; attribute names they click are unchanged.

**`mobile shell: no "Why?" label remains in mobile output`** → unchanged.

- [x] **Step 6: Run the mobile suites**

Run: `npm run test:mobile`
Expected: PASS, 0 failed. Iterate on the shell/tests until green — do not delete unrelated tests to get there.

- [x] **Step 7: Commit**

```bash
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): replace bottom sheet with full-screen glass overlay"
```

---

### Task 5: Tab switching behavior tests

**Files:**
- Modify: `test/mobile-ui.test.mjs` (append)

- [x] **Step 1: Write the failing test**

Append to `test/mobile-ui.test.mjs`, following the exact pattern of the existing `mobile mode handling: mode clicks update storage and shell state` test (which uses `installMobileDom`, `createMobileShell`, and synthesized clicks through the root listener):

```js
test('mobile shell: tab clicks switch the active tab and keep overlay open', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell({ buildIndex: async () => {} });
        // Open the overlay first — the FAB is the only toggle, so reuse however the
        // existing open-state click tests get there (FAB onTap callback or equivalent).
        openMobileOverlay(root);
        clickMobileElement(root, '[data-dle-mobile-tab="browse"]');
        assertMatch(root.innerHTML, /data-dle-mobile-tab="browse" aria-selected="true"/, 'browse tab should activate on click');
        assertMatch(root.innerHTML, /dle-mobile-open/, 'overlay should stay open after tab switch');
        clickMobileElement(root, '[data-dle-mobile-tab="filters"]');
        assertMatch(root.innerHTML, /dle-mobile-filters-stub/, 'filters tab should render the stub');
        destroyMobileShell();
    } finally {
        dom.restore();
    }
});
```

> `clickMobileElement` and `openMobileOverlay` stand for however the existing click tests in this file dispatch clicks and reach an open shell (e.g. invoking the root click listener with a mock event whose `target.closest` resolves the attribute, and triggering the FAB `onTap` callback). Copy the pattern used by `mobile mode handling: mode clicks update storage and shell state` verbatim — do not invent a new harness. The assertion that matters is the tab switch.

- [x] **Step 2: Run test to verify it fails**

Run: `node test/mobile-ui.test.mjs`
Expected: FAIL on the new test only (tab handler may already work from Task 4 — if it passes immediately, that is acceptable; verify the assertions are actually exercising clicks by temporarily breaking the handler, then restore)

- [x] **Step 3: Make it pass (if not already)**

The handler landed in Task 4 Step 4. Fix any gaps the test exposes (e.g. `target.closest` mock quirks).

- [x] **Step 4: Run the mobile suites**

Run: `npm run test:mobile`
Expected: PASS, 0 failed

- [x] **Step 5: Commit**

```bash
git add test/mobile-ui.test.mjs src/mobile/mobile-shell.js
git commit -m "test(mobile): cover overlay tab switching"
```

---

### Task 6: Quick actions — Reroll Lore and Skip Librarian

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Modify: `test/mobile-ui.test.mjs` (append)

- [x] **Step 1: Write the failing tests**

Append to `test/mobile-ui.test.mjs` (same click-test pattern as Task 5; `state.js` is already imported by the test file's module graph, so import the live bindings):

```js
import {
    suppressNextAgenticLoop,
    setSuppressNextAgenticLoop,
} from '../src/state.js';
import {
    buildMobileShellSnapshot,
    createMobileShell,
    destroyMobileShell,
    runMobileReroll,
} from '../src/mobile/mobile-shell.js';

test('mobile quick actions: skip librarian toggles suppression and pressed state', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        setSuppressNextAgenticLoop(false);
        const root = createMobileShell({ buildIndex: async () => {} });
        clickMobileElement(root, '[data-dle-mobile-action="quick-skip-librarian"]');
        assert(suppressNextAgenticLoop === true, 'skip click should suppress the next agentic loop');
        assertMatch(root.innerHTML, /data-dle-mobile-action="quick-skip-librarian" aria-pressed="true"/, 'button should show pressed state');
        clickMobileElement(root, '[data-dle-mobile-action="quick-skip-librarian"]');
        assert(suppressNextAgenticLoop === false, 'second click should re-enable');
        destroyMobileShell();
    } finally {
        setSuppressNextAgenticLoop(false);
        dom.restore();
    }
});

test('mobile quick actions: reroll clears the AI search cache and injection log without clearing Verdict', async () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        let cacheCleared = false;
        let metadataSaved = false;
        const trace = { injected: [{ title: 'Keep visible' }] };
        const verdict = { injectedSources: [{ title: 'Keep visible' }], trace };
        const chatMetadata = { deeplore_injection_log: [{ title: 'Old' }] };

        createMobileShell({
            buildIndex: async () => {},
            getCurrentVerdict: () => verdict,
            getSettings: () => ({}),
            getDrawerState: () => ({}),
        });

        assertEqual(buildMobileShellSnapshot().injectedSources[0]?.title, 'Keep visible');
        assert(buildMobileShellSnapshot().trace === trace, 'shell should read current Verdict trace before reroll');

        const result = await runMobileReroll({
            resetSearchCache: () => { cacheCleared = true; },
            readMetadata: async () => ({
                chatMetadata,
                saveMetadataDebounced: () => { metadataSaved = true; },
            }),
            notify: () => {},
        });
        const after = buildMobileShellSnapshot();

        assertEqual(after.injectedSources[0]?.title, 'Keep visible');
        assert(after.trace === trace, 'reroll should not clear current Verdict trace');
        assert(cacheCleared, 'AI cache should clear');
        assertEqual(chatMetadata.deeplore_injection_log.length, 0);
        assert(metadataSaved, 'metadata should save');
        assertEqual(result.metadataCleared, true);
        destroyMobileShell();
    } finally {
        dom.restore();
    }
});
```

> The reroll handler also clears `chat_metadata.deeplore_injection_log` via the dynamic `readMetadataApi()` import. That import reaches into SillyTavern's real `script.js`, which does not exist under node — the handler must swallow that rejection so cache/log clearing still happens. Order matters: reset the AI search cache before the metadata import, and do not delete or clear current-chat `VerdictStore` data.

- [x] **Step 2: Run tests to verify they fail**

Run: `node test/mobile-ui.test.mjs`
Expected: FAIL — quick action clicks do nothing yet

- [x] **Step 3: Write the implementation**

In `mobile-shell.js`, keep the `../state.js` import limited to `resetAiSearchCache`, `suppressNextAgenticLoop`, and `setSuppressNextAgenticLoop` for these actions. Runtime injected-source and trace reads belong to the current-chat `VerdictStore` snapshot. Add/export `runMobileReroll`, then call it from `handleMobileClick`:

```js
export async function runMobileReroll({
    resetSearchCache = resetAiSearchCache,
    readMetadata = readMetadataApi,
    notify = message => globalThis.toastr?.info?.(message, 'DeepLore'),
} = {}) {
    resetSearchCache?.();
    try {
        const { chatMetadata, saveMetadataDebounced } = await readMetadata();
        if (Array.isArray(chatMetadata?.deeplore_injection_log)) {
            chatMetadata.deeplore_injection_log = [];
            saveMetadataDebounced?.();
        }
        notify?.('Search cache cleared — next generation will re-select lore.');
        return { metadataCleared: true };
    } catch (error) {
        console.warn('[DeepLore] Mobile reroll: injection log not cleared:', error?.message || error);
        return { metadataCleared: false, error };
    }
}

        if (action === 'quick-skip-librarian') {
            const next = !suppressNextAgenticLoop;
            setSuppressNextAgenticLoop(next);
            globalThis.toastr?.info?.(
                next ? 'Librarian tools will be skipped for the next generation.' : 'Librarian tools re-enabled.',
                'DeepLore',
            );
            renderCurrentState();
            return;
        }
        if (action === 'quick-reroll') {
            void runMobileReroll().finally(renderCurrentState);
            return;
        }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: PASS, 0 failed

- [x] **Step 5: Commit**

```bash
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): wire reroll and skip-librarian quick actions"
```

---

### Task 7: Swipe-to-dismiss wiring

**Files:**
- Modify: `src/mobile/mobile-shell.js`

No new unit tests: the decision math was tested in Task 3, and the test DOM mock cannot synthesize touch sequences. Browser smoke in Task 9 verifies the gesture.

- [x] **Step 1: Add delegated touch handlers**

In `mobile-shell.js`, add module-level tracking and handlers:

```js
let swipeTracking = null;

function handleMobileTouchStart(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('[data-dle-mobile-swipe-handle]')) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    swipeTracking = { startY: touch.clientY, startTime: Date.now(), dy: 0 };
}

function handleMobileTouchMove(event) {
    if (!swipeTracking) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    swipeTracking.dy = touch.clientY - swipeTracking.startY;
    const panel = mobileRoot?.querySelector?.('.dle-mobile-overlay-panel');
    if (panel && swipeTracking.dy > 0) {
        panel.style.transform = `translateY(${swipeTracking.dy}px)`;
    }
}

function handleMobileTouchEnd() {
    if (!swipeTracking) return;
    const { dy, startTime } = swipeTracking;
    swipeTracking = null;
    const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800;
    if (shouldDismissSwipe({ dy, durationMs: Date.now() - startTime, viewportHeight })) {
        mobileState.open = false;
    }
    renderCurrentState(); // re-render drops any inline transform
}
```

- [x] **Step 2: Register and unregister the listeners**

In `createMobileShell`, alongside the existing click/input listener wiring (remove-then-add, same order), add:

```js
    root.removeEventListener('touchstart', handleMobileTouchStart);
    root.removeEventListener('touchmove', handleMobileTouchMove);
    root.removeEventListener('touchend', handleMobileTouchEnd);
    root.addEventListener('touchstart', handleMobileTouchStart, { passive: true });
    root.addEventListener('touchmove', handleMobileTouchMove, { passive: true });
    root.addEventListener('touchend', handleMobileTouchEnd);
```

In `destroyMobileShell`, add the three matching `removeEventListener` calls next to the click/input removals, and reset `swipeTracking = null;`.

> The test DOM's `MockElement.addEventListener` may be a stub or absent for extra event names — if `npm run test:mobile` throws on these registrations, guard each with `root.addEventListener &&` the same way the resize/mediaQuery wiring already null-guards.

- [x] **Step 3: Run the mobile suites**

Run: `npm run test:mobile`
Expected: PASS, 0 failed

- [x] **Step 4: Commit**

```bash
git add src/mobile/mobile-shell.js
git commit -m "feat(mobile): swipe-to-dismiss on overlay header"
```

---

### Task 8: Glass CSS and contract tests

**Files:**
- Modify: `style.css`
- Modify: `test/mobile-ui.test.mjs`

- [x] **Step 1: Write the failing CSS contract tests**

In `test/mobile-ui.test.mjs`, replace the body of `mobile shell CSS: positions FAB and sheet safely over chat` (rename to `mobile shell CSS: layers FAB and glass overlay safely over chat`) with:

```js
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

    assertMatch(css, /#dle-mobile-root[\s\S]*?pointer-events:\s*none/m, 'mobile root should not intercept chat taps when closed');
    assertMatch(css, /body\.dle-mobile-ui-active #deeplore-drawer[\s\S]*?display:\s*none !important/m, 'desktop drawer should hide while mobile shell is active');
    assertMatch(css, /\.dle-mobile-fab-anchor[\s\S]*?z-index:\s*5001/m, 'FAB anchor should layer above ST UI');
    assertMatch(css, /\.dle-mobile-overlay\b[\s\S]*?z-index:\s*5002/m, 'overlay should layer above the FAB');
    assertMatch(css, /\.dle-mobile-overlay\.dle-mobile-open[\s\S]*?pointer-events:\s*auto/m, 'open overlay should accept taps');
```

Add a new test after it:

```js
test('mobile overlay CSS: glassmorphic panel with theme variables and fallback', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

    assertMatch(css, /\.dle-mobile-overlay-panel[\s\S]*?color-mix\(in srgb, var\(--SmartThemeBlurTintColor\) 88%, transparent\)/m, 'panel should use 88% theme tint glass');
    assertMatch(css, /\.dle-mobile-overlay-panel[\s\S]*?backdrop-filter:\s*blur\(16px\)/m, 'panel should blur the backdrop');
    assertMatch(css, /@supports not \(backdrop-filter: blur\(1px\)\)[\s\S]*?\.dle-mobile-overlay-panel/m, 'panel should have a no-blur fallback');
    assertMatch(css, /\.dle-mobile-overlay-tab\[aria-selected="true"\][\s\S]*?--SmartThemeUnderlineColor/m, 'active tab should use the accent color');
    assertMatch(css, /\.dle-mobile-overlay-content[\s\S]*?env\(safe-area-inset-bottom\)/m, 'content should pad for the home indicator');
    assertMatch(css, /\.dle-mobile-overlay-quick[\s\S]*?overflow-x:\s*auto/m, 'quick actions should scroll horizontally when cramped');
    assert(!/\.dle-mobile-sheet\b/.test(css), 'old bottom-sheet styles should be removed');
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node test/mobile-ui.test.mjs`
Expected: FAIL on the two CSS tests

- [x] **Step 3: Write the CSS**

In `style.css`, find the mobile shell block (search `.dle-mobile-sheet`). Delete every rule whose selector mentions `.dle-mobile-sheet`, `.dle-mobile-header` (the old sheet header — keep `.dle-mobile-overlay-header`), `.dle-mobile-summary`, `.dle-mobile-pill`, or the old dock (`.dle-mobile-dock` if any remain). Keep the rules for `.dle-mobile-status-tray` children that the overlay reuses: `.dle-mobile-status-grid`, `.dle-mobile-status-metric`, `.dle-mobile-status-bar`, `.dle-mobile-status-ok/-warn/-bad` (delete `.dle-mobile-status-tray` and `.dle-mobile-status-toggle` themselves). Keep `.dle-mobile-error`, all `.dle-mobile-browse-*`, `.dle-mobile-injection-*`, `.dle-mobile-action`, `.dle-mobile-wide-action*`, `.dle-mobile-mode-*`, and all FAB rules.

Update the root rule to:

```css
#dle-mobile-root {
    position: fixed;
    inset: 0;
    z-index: 5002;
    pointer-events: none;
}
```

Then add the overlay block in its place:

```css
/* ── Mobile glass overlay ─────────────────────────────────────────── */
.dle-mobile-overlay {
    position: fixed;
    inset: 0;
    z-index: 5002;
    display: none;
}
.dle-mobile-overlay.dle-mobile-open {
    display: flex;
    flex-direction: column;
    pointer-events: auto;
}
.dle-mobile-overlay-scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
}
.dle-mobile-overlay-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 88%, transparent);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
    box-shadow: 0 8px 32px var(--SmartThemeShadowColor);
    color: var(--SmartThemeBodyColor);
    animation: dle-mobile-overlay-in 200ms ease-out;
    will-change: transform;
}
@supports not (backdrop-filter: blur(1px)) {
    .dle-mobile-overlay-panel {
        background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 92%, transparent);
    }
}
@keyframes dle-mobile-overlay-in {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
}
.dle-mobile-overlay-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: calc(8px + env(safe-area-inset-top)) 12px 8px;
    touch-action: pan-y;
}
.dle-mobile-overlay-status {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    padding: 4px;
}
.dle-mobile-overlay-status-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
}
.dle-mobile-overlay-status-text small {
    color: var(--SmartThemeEmColor);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.dle-mobile-overlay-icon-btn {
    background: color-mix(in srgb, var(--SmartThemeBodyColor) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
    border-radius: 10px;
    color: inherit;
    min-width: 40px;
    min-height: 40px;
}
.dle-mobile-overlay-tabs {
    display: flex;
    gap: 4px;
    padding: 0 8px 8px;
    overflow-x: auto;
    scrollbar-width: none;
}
.dle-mobile-overlay-tab {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-height: 48px;
    padding: 6px 4px;
    font-size: 0.72em;
    background: none;
    border: 1px solid transparent;
    border-radius: 10px;
    color: var(--SmartThemeEmColor);
}
.dle-mobile-overlay-tab[aria-selected="true"] {
    background: color-mix(in srgb, var(--SmartThemeUnderlineColor) 15%, transparent);
    border-color: color-mix(in srgb, var(--SmartThemeUnderlineColor) 30%, transparent);
    color: var(--SmartThemeBodyColor);
}
.dle-mobile-overlay-tab-dot {
    position: absolute;
    top: 4px;
    right: 10px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--SmartThemeQuoteColor);
}
.dle-mobile-overlay-quick {
    display: flex;
    gap: 6px;
    padding: 0 12px 8px;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
}
.dle-mobile-overlay-quick-btn {
    flex: 0 0 auto;
    min-width: 42px;
    min-height: 42px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--SmartThemeBodyColor) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent);
    color: inherit;
}
.dle-mobile-overlay-quick-active {
    background: color-mix(in srgb, var(--SmartThemeUnderlineColor) 15%, transparent);
    border-color: color-mix(in srgb, var(--SmartThemeUnderlineColor) 30%, transparent);
}
.dle-mobile-overlay-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px calc(12px + env(safe-area-inset-bottom));
    -webkit-overflow-scrolling: touch;
}
.dle-mobile-tab-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-bottom: 8px;
}
.dle-mobile-filters-stub {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    text-align: center;
    border: 1px dashed color-mix(in srgb, var(--SmartThemeBodyColor) 15%, transparent);
    border-radius: 12px;
    color: var(--SmartThemeEmColor);
}
```

> Some old sheet rules may share blocks with kept selectors — split rather than delete wholesale, and re-run the contract tests after each pruning pass. If the old `.dle-mobile-status-grid` rules referenced `.dle-mobile-status-tray` as an ancestor selector (e.g. `.dle-mobile-status-tray .dle-mobile-status-grid`), rewrite them as bare `.dle-mobile-status-grid` so the header dropdown picks them up.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: PASS, 0 failed (the wizard CSS tests must still pass — they read the same file)

- [x] **Step 5: Commit**

```bash
git add style.css test/mobile-ui.test.mjs
git commit -m "feat(mobile): glassmorphic overlay CSS with @supports fallback"
```

---

### Task 9: Full verification, sync, and browser smoke

**Files:** none (verification only, plus any fixes it forces)

- [x] **Step 1: Lint**

Run: `npm run lint`
Expected: 0 errors (fix any; unused-import errors are likely in `mobile-shell.js` after the deletions)

- [x] **Step 2: Full suite**

Run: `npm run test:all`
Expected: every suite passes and the import verifier reports `Broken: 0`

- [x] **Step 3: Sync into the clean SillyTavern clone**

```powershell
$source = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced'
$target = 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced'
robocopy $source $target /MIR /XD .git .superpowers node_modules /XF progress.md
```

- [x] **Step 4: Browser smoke at `http://127.0.0.1:8002/`**

Playwright lives in the clean clone (Chromium Pixel 5 + WebKit iPhone 14). Verify and screenshot:

- FAB tap opens the full-screen overlay (no bottom sheet) on the Injection tab
- All 5 tabs switch instantly; Filters shows the stub with a working full-view button
- Quick-action row renders 7 buttons; Skip Librarian shows pressed state after tap
- Header status tap expands the metrics grid; gear opens DeepLore settings; X closes
- Scrim tap closes; swipe down on the header dismisses
- Desktop drawer still hidden while mobile is active; FAB hidden while overlay is open
- Desktop viewport (1280px): drawer unchanged, no overlay, no mobile CSS bleed

- [x] **Step 5: Real-device check (spec requirement)**

Pull the branch on the phone's SillyTavern instance, refresh, and confirm touch responsiveness, safe-area padding, blur performance during scroll, and theme blending. Note results in `progress.md`.

- [x] **Step 6: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix(mobile): overlay polish from browser and device verification"
```

---

## Self-Review Notes

- **Spec coverage:** FAB (done previously); overlay open/close + animations (Task 4/8), header bar (Task 2/4), tab bar with badges (Task 2), quick-action row (Task 2/6), content area + safe area (Task 8), swipe-to-dismiss (Tasks 3/7), error handling for tab render failures (Task 4 `renderTabContent`), `@supports` fallback (Task 8), state preservation for active tab/scroll within session (Task 4). Graph layer, per-tab modules (filters/librarian/tools), and Recent Activity are explicitly separate plans.
- **Known intentional deviations from spec:** gear uses `openSettingsPopup()` not `/dle-settings` (command doesn't exist); `mobile-state.js` ships without an event bus; tab content renderers remain in the shell; browser back-gesture close is deferred (no history integration in this plan — close = X, scrim, swipe).
- **Type/name consistency:** `mobileState.tab` everywhere post-Task 4; `data-dle-mobile-tab` for tab buttons; `data-dle-mobile-action="quick-reroll" / "quick-skip-librarian"`; `data-dle-mobile-refresh` reused for both refresh buttons; `data-dle-mobile-swipe-handle` on the overlay header.
