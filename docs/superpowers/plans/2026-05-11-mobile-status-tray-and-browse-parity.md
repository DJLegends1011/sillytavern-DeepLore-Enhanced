# Mobile Status Tray And Browse Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next DeepLore mobile phase: an expandable status tray plus a phone-native Browse tab with search, filters, quick filters, entry cards, previews, and actions.

**Architecture:** Keep `src/mobile/mobile-shell.js` as the mounted shell/controller, but move derived stats and Browse filtering into small pure helper modules. The shell renders mobile-specific HTML, handles local session state, and delegates mature full-page tools to existing slash commands.

**Tech Stack:** SillyTavern extension ES modules, vanilla DOM event handling, existing DeepLore state/settings modules, Node test runner via `npm run test:mobile`, Playwright/browser smoke against the clean SillyTavern clone at `http://127.0.0.1:8002/`.

---

## File Structure

- Create `src/mobile/mobile-stats.js`: pure formatting and status-tray stat derivation.
- Create `src/mobile/mobile-browse.js`: pure mobile Browse state, filtering, option derivation, sort, and row metadata helpers.
- Modify `src/mobile/mobile-shell.js`: import helpers, extend mobile state, render status tray and full mobile Browse controls/cards, handle mobile Browse events/actions.
- Modify `test/mobile-ui.test.mjs`: add test-first coverage for stats helpers, status tray rendering/toggle, Browse filtering/rendering/actions, and CSS contracts.
- Modify `style.css`: mobile status tray, mobile Browse controls, quick filters, entry cards, expanded previews, action buttons, and no-overflow safeguards.
- Update `progress.md` at the end of implementation so the next resume point is clear. This file is intentionally ignored and should not be committed.

---

### Task 1: Add Pure Mobile Status Helpers

**Files:**
- Create: `src/mobile/mobile-stats.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write failing tests for status stat formatting**

Add this import near the other mobile imports in `test/mobile-ui.test.mjs`:

```js
import {
    buildMobileStatusStats,
    formatMobileStatNumber,
} from '../src/mobile/mobile-stats.js';
```

Add these tests before the existing `buildMobileShellSnapshot` test:

```js
test('formatMobileStatNumber: compacts thousands for tray labels', () => {
    assertEqual(formatMobileStatNumber(0), '0', 'zero should stay readable');
    assertEqual(formatMobileStatNumber(999), '999', 'sub-thousand values should stay exact');
    assertEqual(formatMobileStatNumber(13500), '13.5k', 'thousands should compact with one decimal');
    assertEqual(formatMobileStatNumber(null), '0', 'missing numeric data should render as zero');
});

test('buildMobileStatusStats: derives collapsed warning and expanded metrics', () => {
    const stats = buildMobileStatusStats({
        statusLabel: 'Ready',
        entryCount: 42,
        injectedCount: 8,
        indexEverLoaded: true,
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        settings: {
            maxTokensBudget: 3072,
            unlimitedBudget: false,
            maxEntries: 10,
            unlimitedEntries: false,
        },
        lastPipelineTrace: {
            totalTokens: 2900,
            injected: Array.from({ length: 8 }, (_, idx) => ({ title: `Entry ${idx}` })),
        },
        contextTokens: 13500,
        contextLimit: 200000,
        librarianExtraTokens: 0,
        aiSearchStats: {
            calls: 2,
            cachedHits: 1,
            totalInputTokens: 1200,
            totalOutputTokens: 300,
        },
        overallStatus: 'degraded',
    });

    assertEqual(stats.collapsed.label, 'Budget high', 'high budget use should be the strongest collapsed warning');
    assertEqual(stats.budget.value, '2.9k / 3.1k', 'budget stat should use compact values');
    assertEqual(stats.budget.tone, 'warn', 'budget above 80% should warn');
    assertEqual(stats.entries.value, '8 / 10', 'entry stat should include injected count and max');
    assertEqual(stats.context.value, '13.5k / 200.0k', 'context stat should include max context when available');
    assertEqual(stats.ai.detail, '1 cached · 1.5k tokens', 'AI detail should include cache and token total');
    assertEqual(stats.health.value, 'Degraded', 'overall status should format as a label');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm run test:mobile
```

Expected: FAIL because `../src/mobile/mobile-stats.js` does not exist.

- [ ] **Step 3: Create the pure helper module**

Create `src/mobile/mobile-stats.js` with this module body:

```js
export function formatMobileStatNumber(value) {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
}

function percent(used, limit) {
    if (!limit || limit <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function toneForRatio(ratio) {
    if (ratio >= 95) return 'critical';
    if (ratio >= 80) return 'warn';
    return 'ok';
}

function titleCaseStatus(status) {
    const raw = String(status || 'unknown').replace(/[-_]+/g, ' ');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function buildMobileStatusStats({
    statusLabel = 'Ready',
    entryCount = 0,
    injectedCount = 0,
    indexEverLoaded = false,
    indexing = false,
    generationLock = false,
    pipelinePhase = 'idle',
    settings = {},
    lastPipelineTrace = null,
    contextTokens = 0,
    contextLimit = 0,
    librarianExtraTokens = 0,
    aiSearchStats = {},
    overallStatus = 'ok',
} = {}) {
    const budgetLimit = settings.unlimitedBudget ? 0 : Number(settings.maxTokensBudget || 0);
    const budgetUsed = Number(lastPipelineTrace?.totalTokens || 0);
    const budgetRatio = percent(budgetUsed, budgetLimit);
    const entriesLimit = settings.unlimitedEntries ? 0 : Number(settings.maxEntries || 0);
    const usedEntries = Array.isArray(lastPipelineTrace?.injected)
        ? lastPipelineTrace.injected.length
        : Number(injectedCount || 0);
    const entriesRatio = percent(usedEntries, entriesLimit);
    const contextUsed = Number(contextTokens || 0) + Number(librarianExtraTokens || 0);
    const contextRatio = percent(contextUsed, contextLimit);
    const aiTotalTokens = Number(aiSearchStats.totalInputTokens || 0) + Number(aiSearchStats.totalOutputTokens || 0);

    let collapsed = { label: statusLabel, tone: overallStatus === 'ok' ? 'ok' : 'warn' };
    if (!indexEverLoaded && entryCount === 0) collapsed = { label: 'No index', tone: 'warn' };
    if (indexing) collapsed = { label: 'Indexing', tone: 'warn' };
    if (generationLock || pipelinePhase !== 'idle') collapsed = { label: 'Working', tone: 'warn' };
    if (overallStatus === 'offline' || overallStatus === 'limited') collapsed = { label: titleCaseStatus(overallStatus), tone: 'critical' };
    if (budgetRatio >= 80) collapsed = { label: budgetRatio >= 95 ? 'Budget full' : 'Budget high', tone: toneForRatio(budgetRatio) };

    return {
        collapsed,
        budget: {
            label: 'Budget',
            value: budgetLimit ? `${formatMobileStatNumber(budgetUsed)} / ${formatMobileStatNumber(budgetLimit)}` : `${formatMobileStatNumber(budgetUsed)} used`,
            ratio: budgetRatio,
            tone: toneForRatio(budgetRatio),
        },
        entries: {
            label: 'Entries',
            value: entriesLimit ? `${usedEntries} / ${entriesLimit}` : `${usedEntries} used`,
            ratio: entriesRatio,
            tone: toneForRatio(entriesRatio),
        },
        context: {
            label: 'Context',
            value: contextLimit ? `${formatMobileStatNumber(contextUsed)} / ${formatMobileStatNumber(contextLimit)}` : `${formatMobileStatNumber(contextUsed)} used`,
            ratio: contextRatio,
            tone: toneForRatio(contextRatio),
        },
        ai: {
            label: 'AI',
            value: `${Number(aiSearchStats.calls || 0)} calls`,
            detail: `${Number(aiSearchStats.cachedHits || 0)} cached · ${formatMobileStatNumber(aiTotalTokens)} tokens`,
            tone: 'ok',
        },
        health: {
            label: 'Health',
            value: titleCaseStatus(overallStatus),
            detail: statusLabel,
            tone: overallStatus === 'ok' ? 'ok' : overallStatus === 'degraded' ? 'warn' : 'critical',
        },
    };
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```powershell
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add src/mobile/mobile-stats.js test/mobile-ui.test.mjs
git commit -m "Add mobile status stat helpers"
```

---

### Task 2: Render And Toggle The Mobile Status Tray

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Test: `test/mobile-ui.test.mjs`
- Style in Task 6: `style.css`

- [ ] **Step 1: Write failing render and toggle tests**

Add this test after `renderMobileShell: renders hybrid dock, home sheet, and quick actions`:

```js
test('renderMobileShell: renders collapsed and expanded status tray', () => {
    const snapshot = {
        statusLabel: 'Ready',
        entriesLabel: '12 entries',
        injectedCount: 2,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
        stats: {
            collapsed: { label: 'Budget high', tone: 'warn' },
            budget: { label: 'Budget', value: '2.9k / 3.1k', ratio: 94, tone: 'warn' },
            entries: { label: 'Entries', value: '8 / 10', ratio: 80, tone: 'ok' },
            context: { label: 'Context', value: '13.5k / 200.0k', ratio: 7, tone: 'ok' },
            ai: { label: 'AI', value: '2 calls', detail: '1 cached · 1.5k tokens', tone: 'ok' },
            health: { label: 'Health', value: 'Degraded', detail: 'Ready', tone: 'warn' },
        },
    };

    const collapsed = renderMobileShell(snapshot, { open: true, view: 'home', mode: 'auto', errorMessage: '', statsExpanded: false });
    assertMatch(collapsed, /class="dle-mobile-status-tray[^"]*"/, 'status tray should render on home');
    assertMatch(collapsed, /data-dle-mobile-action="toggle-stats"/, 'tray toggle should be present');
    assertMatch(collapsed, /Budget high/, 'collapsed warning should be visible');
    assert(!/2\.9k \/ 3\.1k/.test(collapsed), 'expanded budget value should be hidden while collapsed');

    const expanded = renderMobileShell(snapshot, { open: true, view: 'home', mode: 'auto', errorMessage: '', statsExpanded: true });
    assertMatch(expanded, /class="dle-mobile-status-tray[^"]*dle-mobile-status-expanded"/, 'expanded class should render');
    assertMatch(expanded, /2\.9k \/ 3\.1k/, 'expanded budget value should render');
    assertMatch(expanded, /13\.5k \/ 200\.0k/, 'expanded context value should render');
    assertMatch(expanded, /1 cached · 1\.5k tokens/, 'expanded AI detail should render');
});
```

Add this test after the existing mode-click test:

```js
test('mobile status tray: toggle click flips expanded state', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell();
        const target = new MockElement('button');
        target.ownerDocument = root.ownerDocument;
        target.parentElement = root;
        target.setAttribute('data-dle-mobile-action', 'toggle-stats');

        clickMobileRoot(root, target);
        assertMatch(root.innerHTML, /dle-mobile-status-expanded/, 'first toggle should expand the status tray');

        clickMobileRoot(root, target);
        assert(!/dle-mobile-status-expanded/.test(root.innerHTML), 'second toggle should collapse the status tray');
    } finally {
        destroyMobileShell();
        dom.restore();
    }
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm run test:mobile
```

Expected: FAIL because the shell does not render `dle-mobile-status-tray` or handle `toggle-stats`.

- [ ] **Step 3: Extend mobile shell state and snapshot stats**

Modify the imports at the top of `src/mobile/mobile-shell.js`:

```js
import { getSettings } from '../../settings.js';
import { ds } from '../drawer/drawer-state.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import { buildMobileStatusStats } from './mobile-stats.js';
import {
    vaultIndex,
    indexing,
    indexEverLoaded,
    generationLock,
    lastInjectionSources,
    loreGaps,
    pipelinePhase,
    lastPipelineTrace,
    aiSearchStats,
    lastHealthResult,
    librarianChatStats,
    computeOverallStatus,
    onIndexUpdated,
    onIndexingChanged,
    onInjectionSourcesReady,
    onPipelineComplete,
    onGenerationLockChanged,
    onLoreGapsChanged,
    onPipelinePhaseChanged,
    onAiStatsUpdated,
    onCircuitStateChanged,
    onPipelineTraceUpdated,
} from '../state.js';
```

Update `mobileState`:

```js
let mobileState = {
    open: false,
    view: 'home',
    active: false,
    mode: 'auto',
    errorMessage: '',
    statsExpanded: false,
};
```

Inside `buildMobileShellSnapshot`, add state reads and `stats`:

```js
const context = getContext();
const settings = source.settings ?? getSettings();
const circuitState = source.circuitState ?? getCircuitState();
const overallStatus = source.overallStatus ?? computeOverallStatus(circuitState);
const stats = buildMobileStatusStats({
    statusLabel: statusForState(state),
    entryCount,
    injectedCount: countInjected(state.lastInjectionSources),
    indexEverLoaded: state.indexEverLoaded,
    indexing: state.indexing,
    generationLock: state.generationLock,
    pipelinePhase: state.pipelinePhase,
    settings,
    lastPipelineTrace: source.lastPipelineTrace ?? lastPipelineTrace,
    contextTokens: source.contextTokens ?? ds.contextTokens ?? 0,
    contextLimit: source.contextLimit ?? context?.chatCompletionSettings?.openai_max_context ?? context?.maxContext ?? 0,
    librarianExtraTokens: source.librarianExtraTokens ?? librarianChatStats?.estimatedExtraTokens ?? 0,
    aiSearchStats: source.aiSearchStats ?? aiSearchStats,
    overallStatus,
});
```

Add `stats` to the returned snapshot.

- [ ] **Step 4: Render the status tray**

Add these render helpers in `src/mobile/mobile-shell.js` before `renderHome`:

```js
function renderStatusMetric(metric) {
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

function renderStatusTray(snapshot, state) {
    const stats = snapshot.stats;
    if (!stats) return '';
    const expandedClass = state.statsExpanded ? ' dle-mobile-status-expanded' : '';
    return `
        <section class="dle-mobile-status-tray${expandedClass}" aria-label="DeepLore status">
            <button type="button" class="dle-mobile-status-toggle" data-dle-mobile-action="toggle-stats" aria-expanded="${state.statsExpanded ? 'true' : 'false'}">
                <span>${escapeHtml(stats.collapsed.label)}</span>
                <strong>${escapeHtml(snapshot.injectedCount)} injected</strong>
                <i class="fa-solid fa-chevron-${state.statsExpanded ? 'down' : 'up'}" aria-hidden="true"></i>
            </button>
            ${state.statsExpanded ? `<div class="dle-mobile-status-grid">
                ${renderStatusMetric(stats.budget)}
                ${renderStatusMetric(stats.entries)}
                ${renderStatusMetric(stats.context)}
                ${renderStatusMetric(stats.ai)}
                ${renderStatusMetric(stats.health)}
            </div>` : ''}
        </section>
    `;
}
```

In `renderHome(snapshot)`, render the status tray before `.dle-mobile-summary`:

```js
function renderHome(snapshot, state = mobileState) {
    return `
        ${renderStatusTray(snapshot, state)}
        <div class="dle-mobile-summary">
```

Change `renderBody` so the default path calls `renderHome(snapshot, mobileState)` or accepts `state` and passes it through.

- [ ] **Step 5: Handle the toggle and new subscriptions**

In `handleMobileClick`, add the action branch:

```js
if (action === 'toggle-stats') mobileState.statsExpanded = !mobileState.statsExpanded;
```

Add these subscriptions to `mobileUnsubscribers` in `createMobileShell`:

```js
onAiStatsUpdated(renderCurrentState),
onCircuitStateChanged(renderCurrentState),
onPipelineTraceUpdated(renderCurrentState),
```

Update `destroyMobileShell` reset state:

```js
mobileState = { open: false, view: 'home', active: false, mode: 'auto', errorMessage: '', statsExpanded: false };
```

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```powershell
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "Add mobile status tray rendering"
```

---

### Task 3: Add Pure Mobile Browse Helpers

**Files:**
- Create: `src/mobile/mobile-browse.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write failing tests for mobile Browse behavior**

Add this import to `test/mobile-ui.test.mjs`:

```js
import {
    MOBILE_BROWSE_DEFAULT_STATE,
    buildMobileBrowseOptions,
    buildMobileBrowseRows,
    filterMobileBrowseEntries,
    normalizeMobileBrowseState,
} from '../src/mobile/mobile-browse.js';
```

Add these tests before `renderMobileShell: drill-in views tolerate missing array fields`:

```js
const browseFixtureEntries = [
    {
        title: 'Cosplay Mode',
        keys: ['costume', 'disguise'],
        tags: ['mode'],
        folderPath: 'Modes',
        vaultSource: 'First Vault',
        priority: 50,
        tokenEstimate: 186,
        constant: true,
        summary: 'Imported from SillyTavern World Info',
        filename: 'Modes/Cosplay Mode.md',
    },
    {
        title: 'Keisha',
        keys: ['keisha', 'demetri'],
        tags: ['character'],
        folderPath: 'Characters',
        vaultSource: 'First Vault',
        priority: 100,
        tokenEstimate: 520,
        summary: "Keisha, Demetri's girlfriend.",
        filename: 'Characters/Keisha.md',
    },
    {
        title: 'Mimic Mode',
        keys: ['mimic', 'illusion'],
        tags: ['mode'],
        folderPath: 'Modes',
        vaultSource: 'First Vault',
        priority: 50,
        tokenEstimate: 240,
        summary: 'Copies current social role.',
        filename: 'Modes/Mimic Mode.md',
    },
];

test('mobile Browse helpers: search supports bare tokens and field prefixes', () => {
    const bare = filterMobileBrowseEntries(browseFixtureEntries, normalizeMobileBrowseState({ query: 'mimic illusion' }), {});
    assertEqual(bare.entries.map(e => e.title).join(','), 'Mimic Mode', 'bare query tokens should AND-match title/keys');

    const prefixed = filterMobileBrowseEntries(browseFixtureEntries, normalizeMobileBrowseState({ query: 'tag:character folder:Characters key:demetri' }), {});
    assertEqual(prefixed.entries.map(e => e.title).join(','), 'Keisha', 'prefixed query filters should match desktop Browse syntax');
});

test('mobile Browse helpers: filters, quick filters, and sort produce card rows', () => {
    const state = normalizeMobileBrowseState({
        tag: 'mode',
        folder: 'Modes',
        sort: 'alpha_desc',
        quick: 'never-injected',
    });
    const result = filterMobileBrowseEntries(browseFixtureEntries, state, {
        chatInjectionCounts: new Map([['First Vault:Cosplay Mode', 2]]),
        injectedSources: [{ title: 'Cosplay Mode' }],
        pins: [{ title: 'Mimic Mode', vaultSource: 'First Vault' }],
        blocks: [],
    });
    const rows = buildMobileBrowseRows(result.entries, {
        chatInjectionCounts: new Map([['First Vault:Cosplay Mode', 2]]),
        injectedSources: [{ title: 'Cosplay Mode' }],
        pins: [{ title: 'Mimic Mode', vaultSource: 'First Vault' }],
        blocks: [],
    });

    assertEqual(result.entries.map(e => e.title).join(','), 'Mimic Mode', 'never-injected quick filter should remove injected entries');
    assertEqual(result.summary, 'Showing 1 of 3 entries', 'filtered summary should include result count');
    assertEqual(rows[0].priorityLabel, 'P50', 'normal entries should show priority');
    assertEqual(rows[0].isPinned, true, 'pin state should be resolved using vault-aware keys');
    assertEqual(rows[0].keysLabel, 'mimic, illusion', 'keys should be rendered as a compact label');
});

test('mobile Browse helpers: derive tag and folder options with counts', () => {
    const options = buildMobileBrowseOptions(browseFixtureEntries);

    assertEqual(options.tags.find(t => t.value === 'mode').label, 'mode (2)', 'tag options should include counts');
    assertEqual(options.folders.find(f => f.value === 'Modes').label, 'Modes (2)', 'folder options should include counts');
    assertEqual(MOBILE_BROWSE_DEFAULT_STATE.sort, 'priority_asc', 'default mobile Browse sort should match desktop');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm run test:mobile
```

Expected: FAIL because `src/mobile/mobile-browse.js` does not exist.

- [ ] **Step 3: Create `src/mobile/mobile-browse.js`**

Create the module with these exported helpers:

```js
import { normalizePinBlock } from '../helpers.js';
import { trackerKey } from '../state.js';

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

function pinBlockKey(item) {
    const normalized = normalizePinBlock(item);
    return `${normalized.vaultSource || ''}:${lower(normalized.title)}`;
}

function entryKey(entry) {
    return `${entry.vaultSource || ''}:${lower(entry.title)}`;
}

function makeTitleSet(items = []) {
    return new Set((items || []).map(item => lower(item?.title || item)).filter(Boolean));
}

function makePinBlockSet(items = []) {
    return new Set((items || []).map(pinBlockKey));
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
        tags: [...tagCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, label: `${value} (${count})` })),
        folders: [...folderCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, label: `${value} (${count})` })),
    };
}

export function filterMobileBrowseEntries(entries = [], rawState = {}, context = {}) {
    const state = normalizeMobileBrowseState(rawState);
    const injectedTitles = makeTitleSet(context.injectedSources);
    const pinSet = makePinBlockSet(context.pins);
    const blockSet = makePinBlockSet(context.blocks);
    const counts = context.chatInjectionCounts instanceof Map ? context.chatInjectionCounts : new Map();

    let filtered = entries.filter(entry => {
        const title = lower(entry.title);
        if (state.query && !matchesQuery(entry, state.query)) return false;
        if (state.status === 'injected' && !injectedTitles.has(title)) return false;
        if (state.status === 'pinned' && !pinSet.has(entryKey(entry))) return false;
        if (state.status === 'blocked' && !blockSet.has(entryKey(entry))) return false;
        if (state.status === 'constant' && !entry.constant) return false;
        if (state.status === 'regular' && entry.constant) return false;
        if (state.tag && !(entry.tags || []).includes(state.tag)) return false;
        if (state.folder && (!entry.folderPath || (entry.folderPath !== state.folder && !entry.folderPath.startsWith(`${state.folder}/`)))) return false;
        if (state.quick === 'never-injected' && (counts.get(trackerKey(entry)) || 0) > 0) return false;
        if (state.quick === 'since-gen' && !injectedTitles.has(title)) return false;
        return true;
    });

    filtered = [...filtered];
    switch (state.sort) {
        case 'alpha_asc': filtered.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'alpha_desc': filtered.sort((a, b) => b.title.localeCompare(a.title)); break;
        case 'tokens_desc': filtered.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
        case 'tokens_asc': filtered.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
        case 'priority_desc': filtered.sort((a, b) => (b.priority || 50) - (a.priority || 50)); break;
        default: filtered.sort((a, b) => (a.priority || 50) - (b.priority || 50));
    }

    const isFiltered = state.query || state.status !== 'all' || state.tag || state.folder || state.quick;
    return {
        state,
        entries: filtered,
        isFiltered: !!isFiltered,
        summary: isFiltered ? `Showing ${filtered.length} of ${entries.length} entries` : '',
    };
}

export function buildMobileBrowseRows(entries = [], context = {}) {
    const injectedTitles = makeTitleSet(context.injectedSources);
    const pinSet = makePinBlockSet(context.pins);
    const blockSet = makePinBlockSet(context.blocks);
    const counts = context.chatInjectionCounts instanceof Map ? context.chatInjectionCounts : new Map();

    return entries.map(entry => {
        const count = counts.get(trackerKey(entry)) || 0;
        const key = trackerKey(entry);
        return {
            key,
            entry,
            title: entry.title || 'Untitled',
            keysLabel: entry.constant ? '(constant)' : (entry.keys || []).slice(0, 4).join(', '),
            folderLabel: entry.folderPath || entry.vaultSource || 'Vault entry',
            priorityLabel: entry.constant ? 'CONST' : `P${entry.priority || 50}`,
            tokenLabel: entry.tokenEstimate ? `${entry.tokenEstimate} tokens` : '',
            injectedCount: count,
            isInjected: injectedTitles.has(lower(entry.title)),
            isPinned: pinSet.has(entryKey(entry)),
            isBlocked: blockSet.has(entryKey(entry)),
            preview: entry.summary || (entry.content ? `${entry.content.slice(0, 220)}${entry.content.length > 220 ? '...' : ''}` : 'No content preview.'),
        };
    });
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add src/mobile/mobile-browse.js test/mobile-ui.test.mjs
git commit -m "Add mobile Browse filtering helpers"
```

---

### Task 4: Render Mobile Browse Controls And Cards

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write failing render tests for Browse parity**

Replace or extend the existing Browse render assertion with this test:

```js
test('renderMobileShell: Browse view renders search, filters, quick filters, and cards', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '3 entries',
        injectedCount: 1,
        gapCount: 0,
        phaseLabel: 'idle',
        injectedSources: [{ title: 'Cosplay Mode' }],
        entries: browseFixtureEntries,
        loreGaps: [],
        browseContext: {
            pins: [{ title: 'Mimic Mode', vaultSource: 'First Vault' }],
            blocks: [{ title: 'Keisha', vaultSource: 'First Vault' }],
            chatInjectionCounts: new Map([['First Vault:Cosplay Mode', 2]]),
        },
    }, {
        open: true,
        view: 'browse',
        mode: 'auto',
        errorMessage: '',
        statsExpanded: false,
        browse: normalizeMobileBrowseState({ query: 'mode', tag: 'mode' }),
        browseSearchHelpOpen: true,
        browseExpandedKey: 'First Vault:Cosplay Mode',
    });

    assertMatch(html, /class="dle-mobile-browse-controls"/, 'Browse controls should render');
    assertMatch(html, /data-dle-mobile-browse-field="query"/, 'search input should update mobile Browse query');
    assertMatch(html, /data-dle-mobile-browse-field="tag"/, 'tag filter should render');
    assertMatch(html, /data-dle-mobile-browse-quick="never-injected"/, 'quick filter should render');
    assertMatch(html, /Search syntax/, 'help popover should render when open');
    assertMatch(html, /class="dle-mobile-browse-card[^"]*dle-mobile-browse-injected"/, 'injected card state should render');
    assertMatch(html, /data-dle-mobile-browse-action="pin"/, 'pin action should render');
    assertMatch(html, /data-dle-mobile-browse-action="block"/, 'block action should render');
    assertMatch(html, /data-dle-mobile-browse-action="copy"/, 'copy action should render');
    assertMatch(html, /Imported from SillyTavern World Info/, 'expanded preview should render');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm run test:mobile
```

Expected: FAIL because `renderBrowse` still renders only a simple list.

- [ ] **Step 3: Import Browse helpers and extend mobile state**

In `src/mobile/mobile-shell.js`, import helpers:

```js
import {
    buildMobileBrowseOptions,
    buildMobileBrowseRows,
    filterMobileBrowseEntries,
    normalizeMobileBrowseState,
} from './mobile-browse.js';
```

Extend `mobileState`:

```js
browse: normalizeMobileBrowseState(),
browseSearchHelpOpen: false,
browseExpandedKey: '',
```

Add matching fields to the reset state in `destroyMobileShell`.

- [ ] **Step 4: Build Browse context in the snapshot**

Inside `buildMobileShellSnapshot`, add:

```js
const browseContext = source.browseContext || {
    pins: globalThis.chat_metadata?.deeplore_pins || [],
    blocks: globalThis.chat_metadata?.deeplore_blocks || [],
    chatInjectionCounts: source.chatInjectionCounts,
};
```

If `source.chatInjectionCounts` is missing, import `chatInjectionCounts` from `../state.js` and use it in the context object.

- [ ] **Step 5: Replace `renderBrowse` with controls and cards**

Replace the current `renderBrowse(snapshot)` function with a version that:

```js
function renderBrowse(snapshot, state = mobileState) {
    const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    const browseState = normalizeMobileBrowseState(state.browse);
    const options = buildMobileBrowseOptions(entries);
    const filtered = filterMobileBrowseEntries(entries, browseState, {
        ...snapshot.browseContext,
        injectedSources: snapshot.injectedSources,
    });
    const rows = buildMobileBrowseRows(filtered.entries, {
        ...snapshot.browseContext,
        injectedSources: snapshot.injectedSources,
    });

    const tagOptions = options.tags.map(option => `<option value="${escapeHtml(option.value)}"${browseState.tag === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
    const folderOptions = options.folders.map(option => `<option value="${escapeHtml(option.value)}"${browseState.folder === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('');

    return `
        <div class="dle-mobile-drill-header">
            <button type="button" data-dle-mobile-view="home"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <strong>Browse</strong>
        </div>
        <div class="dle-mobile-browse-controls">
            <label class="dle-mobile-search">
                <span class="sr-only">Search entries</span>
                <input type="search" value="${escapeHtml(browseState.query)}" placeholder="Search entries..." data-dle-mobile-browse-field="query">
                <button type="button" data-dle-mobile-action="toggle-browse-help" aria-expanded="${state.browseSearchHelpOpen ? 'true' : 'false'}" aria-label="Search syntax help">
                    <i class="fa-solid fa-circle-question" aria-hidden="true"></i>
                </button>
            </label>
            ${state.browseSearchHelpOpen ? '<div class="dle-mobile-browse-help"><strong>Search syntax</strong><span>tag:character folder:Places key:name summary:rumor field:era=Modern</span></div>' : ''}
            <div class="dle-mobile-browse-filter-grid">
                <select data-dle-mobile-browse-field="status" aria-label="Status filter">
                    <option value="all"${browseState.status === 'all' ? ' selected' : ''}>Status</option>
                    <option value="injected"${browseState.status === 'injected' ? ' selected' : ''}>Injected</option>
                    <option value="pinned"${browseState.status === 'pinned' ? ' selected' : ''}>Pinned</option>
                    <option value="blocked"${browseState.status === 'blocked' ? ' selected' : ''}>Blocked</option>
                    <option value="constant"${browseState.status === 'constant' ? ' selected' : ''}>Constant</option>
                    <option value="regular"${browseState.status === 'regular' ? ' selected' : ''}>Regular</option>
                </select>
                <select data-dle-mobile-browse-field="tag" aria-label="Tag filter"><option value="">Tags</option>${tagOptions}</select>
                <select data-dle-mobile-browse-field="folder" aria-label="Folder filter"><option value="">Folder</option>${folderOptions}</select>
                <select data-dle-mobile-browse-field="sort" aria-label="Sort entries">
                    <option value="priority_asc"${browseState.sort === 'priority_asc' ? ' selected' : ''}>Priority</option>
                    <option value="priority_desc"${browseState.sort === 'priority_desc' ? ' selected' : ''}>Priority desc</option>
                    <option value="alpha_asc"${browseState.sort === 'alpha_asc' ? ' selected' : ''}>A-Z</option>
                    <option value="alpha_desc"${browseState.sort === 'alpha_desc' ? ' selected' : ''}>Z-A</option>
                    <option value="tokens_desc"${browseState.sort === 'tokens_desc' ? ' selected' : ''}>Tokens high</option>
                    <option value="tokens_asc"${browseState.sort === 'tokens_asc' ? ' selected' : ''}>Tokens low</option>
                </select>
            </div>
            <div class="dle-mobile-browse-quick" role="group" aria-label="Quick filters">
                <button type="button" data-dle-mobile-browse-quick="since-gen" aria-pressed="${browseState.quick === 'since-gen' ? 'true' : 'false'}">Since last gen</button>
                <button type="button" data-dle-mobile-browse-quick="never-injected" aria-pressed="${browseState.quick === 'never-injected' ? 'true' : 'false'}">Never injected</button>
            </div>
            ${filtered.summary ? `<div class="dle-mobile-browse-summary">${escapeHtml(filtered.summary)} <button type="button" data-dle-mobile-browse-clear>Clear</button></div>` : ''}
        </div>
        <div class="dle-mobile-browse-list">
            ${rows.length ? rows.slice(0, 40).map(row => renderBrowseCard(row, state)).join('') : renderBrowseEmpty(entries, filtered)}
        </div>
        <button class="dle-mobile-wide-action" type="button" data-dle-mobile-command="${commandForView('browse')}">Open full Browse view</button>
    `;
}
```

Add `renderBrowseCard(row, state)` and `renderBrowseEmpty(entries, filtered)` helpers immediately below `renderBrowse`.

- [ ] **Step 6: Handle Browse field events**

In `handleMobileClick`, add branches for:

```js
if (action === 'toggle-browse-help') {
    mobileState.browseSearchHelpOpen = !mobileState.browseSearchHelpOpen;
    mobileState.open = true;
    renderCurrentState();
    return;
}
```

Add handling for `data-dle-mobile-browse-quick`, `data-dle-mobile-browse-clear`, and `data-dle-mobile-browse-expand`.

Add a `handleMobileInput(event)` function that handles `input` and `change` from `[data-dle-mobile-browse-field]`, updates `mobileState.browse`, clears `browseExpandedKey`, and re-renders.

Register it in `createMobileShell`:

```js
root.removeEventListener('input', handleMobileInput);
root.removeEventListener('change', handleMobileInput);
root.addEventListener('input', handleMobileInput);
root.addEventListener('change', handleMobileInput);
```

Remove those listeners in `destroyMobileShell`.

- [ ] **Step 7: Run tests and verify GREEN**

Run:

```powershell
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

Run:

```powershell
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "Render mobile Browse controls and cards"
```

---

### Task 5: Add Mobile Browse Card Actions

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write failing action contract tests**

Add this source-level contract test:

```js
test('mobile Browse actions: shell keeps ST metadata imports dynamic', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /async function toggleMobileBrowsePin/, 'pin action helper should exist');
    assertMatch(source, /async function toggleMobileBrowseBlock/, 'block action helper should exist');
    assertMatch(source, /await import\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/script\.js'\)/, 'ST script import should stay dynamic so Node mobile tests can import the shell');
    assertMatch(source, /notifyPinBlockChanged\(\)/, 'pin and block actions should notify DeepLore state observers');
    assertMatch(source, /navigator\.clipboard\.writeText/, 'copy action should use the clipboard when available');
    assertMatch(source, /openExternalProtocol/, 'Obsidian action should use the shared external protocol helper');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm run test:mobile
```

Expected: FAIL because action helpers are not implemented.

- [ ] **Step 3: Add action helpers**

In `src/mobile/mobile-shell.js`, import:

```js
import { buildObsidianURI, normalizePinBlock, openExternalProtocol } from '../helpers.js';
import { getSettings } from '../../settings.js';
```

Keep the ST metadata imports dynamic inside helpers:

```js
async function readMetadataApi() {
    const script = await import('../../../../../../script.js');
    const extensions = await import('../../../../../extensions.js');
    return {
        chatMetadata: script.chat_metadata,
        saveMetadataDebounced: extensions.saveMetadataDebounced,
    };
}

function samePinBlock(item, title, vaultSource) {
    const normalized = normalizePinBlock(item);
    return normalized.title.toLowerCase() === String(title || '').toLowerCase()
        && (normalized.vaultSource || null) === (vaultSource || null);
}

async function toggleMobileBrowsePin(title, vaultSource) {
    const { chatMetadata, saveMetadataDebounced } = await readMetadataApi();
    if (!chatMetadata || !title) return;
    if (!chatMetadata.deeplore_pins) chatMetadata.deeplore_pins = [];
    const idx = chatMetadata.deeplore_pins.findIndex(item => samePinBlock(item, title, vaultSource));
    if (idx >= 0) chatMetadata.deeplore_pins.splice(idx, 1);
    else {
        chatMetadata.deeplore_pins.push({ title, vaultSource: vaultSource || null });
        if (chatMetadata.deeplore_blocks) {
            chatMetadata.deeplore_blocks = chatMetadata.deeplore_blocks.filter(item => !samePinBlock(item, title, vaultSource));
        }
    }
    saveMetadataDebounced();
    notifyPinBlockChanged();
}

async function toggleMobileBrowseBlock(title, vaultSource) {
    const { chatMetadata, saveMetadataDebounced } = await readMetadataApi();
    if (!chatMetadata || !title) return;
    if (!chatMetadata.deeplore_blocks) chatMetadata.deeplore_blocks = [];
    const idx = chatMetadata.deeplore_blocks.findIndex(item => samePinBlock(item, title, vaultSource));
    if (idx >= 0) chatMetadata.deeplore_blocks.splice(idx, 1);
    else {
        chatMetadata.deeplore_blocks.push({ title, vaultSource: vaultSource || null });
        if (chatMetadata.deeplore_pins) {
            chatMetadata.deeplore_pins = chatMetadata.deeplore_pins.filter(item => !samePinBlock(item, title, vaultSource));
        }
    }
    saveMetadataDebounced();
    notifyPinBlockChanged();
}

async function copyMobileBrowseTitle(title) {
    if (!title) return;
    try {
        await navigator.clipboard?.writeText?.(title);
        mobileState.errorMessage = '';
    } catch {
        setMobileError('Clipboard access denied.');
    }
}

function openMobileBrowseObsidian(filename, vaultSource) {
    const settings = getSettings();
    const vault = vaultSource && settings.vaults ? settings.vaults.find(v => v.name === vaultSource) : null;
    const vaultName = vault?.name || settings.vaults?.[0]?.name || '';
    const uri = filename ? buildObsidianURI(vaultName, filename) : null;
    if (!openExternalProtocol(uri)) setMobileError('Could not open Obsidian link from this browser context.');
}
```

- [ ] **Step 4: Route action clicks**

In `handleMobileClick`, add:

```js
const browseActionEl = target.closest('[data-dle-mobile-browse-action]');
if (browseActionEl) {
    const action = browseActionEl.getAttribute('data-dle-mobile-browse-action');
    const title = browseActionEl.getAttribute('data-title') || '';
    const vaultSource = browseActionEl.getAttribute('data-vault') || '';
    const filename = browseActionEl.getAttribute('data-filename') || '';
    Promise.resolve()
        .then(() => {
            if (action === 'pin') return toggleMobileBrowsePin(title, vaultSource || null);
            if (action === 'block') return toggleMobileBrowseBlock(title, vaultSource || null);
            if (action === 'copy') return copyMobileBrowseTitle(title);
            if (action === 'obsidian') return openMobileBrowseObsidian(filename, vaultSource || null);
        })
        .catch(err => {
            console.error('[DLE] Mobile Browse action failed:', action, err);
            setMobileError(`Browse action failed: ${action}`);
        })
        .finally(renderCurrentState);
    return;
}
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```powershell
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```powershell
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "Add mobile Browse card actions"
```

---

### Task 6: Add Mobile Status And Browse CSS

**Files:**
- Modify: `style.css`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write failing CSS contract tests**

Add assertions to `mobile shell CSS: positions dock and sheet safely over chat`:

```js
assertMatch(css, /\.dle-mobile-status-tray[\s\S]*border/m, 'status tray should have a bounded visual container');
assertMatch(css, /\.dle-mobile-status-grid[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/m, 'expanded status tray should use compact two-column metrics');
assertMatch(css, /\.dle-mobile-browse-controls[\s\S]*display:\s*grid/m, 'mobile Browse controls should stack without overflow');
assertMatch(css, /\.dle-mobile-browse-card[\s\S]*overflow:\s*hidden/m, 'Browse cards should prevent horizontal text overflow');
assertMatch(css, /\.dle-mobile-browse-actions[\s\S]*min-height:\s*40px/m, 'Browse action buttons should stay touch-friendly');
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm run test:mobile
```

Expected: FAIL because the CSS classes are not present.

- [ ] **Step 3: Add CSS at the end of the mobile shell block**

Append the CSS near the existing `.dle-mobile-*` rules:

```css
.dle-mobile-status-tray {
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #444) 60%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--SmartThemeBlurTintColor, #111) 86%, transparent);
    padding: 8px;
    display: grid;
    gap: 8px;
}

.dle-mobile-status-toggle {
    min-height: 44px;
    width: 100%;
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    align-items: center;
    border: 0;
    background: transparent;
    color: var(--SmartThemeBodyColor, #eee);
    text-align: left;
}

.dle-mobile-status-toggle strong {
    font-size: 0.85em;
    opacity: 0.78;
}

.dle-mobile-status-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.dle-mobile-status-metric {
    min-width: 0;
    border-radius: 10px;
    background: color-mix(in srgb, var(--SmartThemeBotMesBlurTintColor, #222) 78%, transparent);
    padding: 8px;
    display: grid;
    gap: 3px;
}

.dle-mobile-status-metric strong,
.dle-mobile-status-metric small {
    overflow-wrap: anywhere;
}

.dle-mobile-status-bar {
    height: 5px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.45);
    overflow: hidden;
}

.dle-mobile-status-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--SmartThemeQuoteColor, #d69a00);
}

.dle-mobile-browse-controls {
    display: grid;
    gap: 8px;
}

.dle-mobile-search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    gap: 8px;
}

.dle-mobile-search input,
.dle-mobile-browse-filter-grid select {
    min-width: 0;
    min-height: 40px;
}

.dle-mobile-browse-filter-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.dle-mobile-browse-quick {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.dle-mobile-browse-quick button,
.dle-mobile-browse-summary button {
    min-height: 36px;
}

.dle-mobile-browse-list {
    display: grid;
    gap: 10px;
}

.dle-mobile-browse-card {
    overflow: hidden;
    border-radius: 12px;
    background: color-mix(in srgb, var(--SmartThemeBotMesBlurTintColor, #222) 82%, transparent);
    border: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #444) 55%, transparent);
    padding: 10px;
    display: grid;
    gap: 8px;
}

.dle-mobile-browse-title-row,
.dle-mobile-browse-meta,
.dle-mobile-browse-actions {
    min-width: 0;
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
}

.dle-mobile-browse-title-row strong {
    min-width: 0;
    overflow-wrap: anywhere;
}

.dle-mobile-browse-actions button {
    min-height: 40px;
    min-width: 40px;
}

.dle-mobile-browse-preview {
    border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor, #444) 50%, transparent);
    padding-top: 8px;
    overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npm run test:mobile
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add style.css test/mobile-ui.test.mjs
git commit -m "Style mobile status tray and Browse view"
```

---

### Task 7: Browser QA In The Clean SillyTavern Clone

**Files:**
- Temporary only: `C:\tmp\dle-mobile-parity-smoke.cjs`
- Update after QA: `progress.md`

- [ ] **Step 1: Sync the extension into the clean clone**

Use the same clean clone target from `progress.md`:

```powershell
$source = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced'
$target = 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced'
robocopy $source $target /MIR /XD .git .superpowers node_modules /XF progress.md
```

Expected: target extension mirrors the working tree without `.git`, `.superpowers`, `node_modules`, or `progress.md`.

- [ ] **Step 2: Confirm or start the clean server**

Open or verify:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8002/ -TimeoutSec 5
```

Expected: HTTP 200. If it is not running, start it from:

```powershell
cd 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern'
npm start
```

- [ ] **Step 3: Create the smoke script outside the repo**

Create `C:\tmp\dle-mobile-parity-smoke.cjs` with a Playwright script that:

```js
const { chromium, webkit } = require('@playwright/test');
const fs = require('node:fs/promises');

const outDir = 'C:/tmp/dle-mobile-parity';
const url = 'http://127.0.0.1:8002/';

async function run(project, browserType, viewport) {
  const browser = await browserType.launch();
  const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) errors.push(`${msg.type()}: ${msg.text()}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('dleMobileUiForce', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dle-mobile-root:not([hidden])', { timeout: 15000 });
  await page.screenshot({ path: `${outDir}/${project}-dock.png` });
  await page.locator('.dle-mobile-dock').click();
  await page.waitForSelector('.dle-mobile-sheet.dle-mobile-open', { timeout: 5000 });
  await page.screenshot({ path: `${outDir}/${project}-home-collapsed.png` });
  await page.locator('[data-dle-mobile-action="toggle-stats"]').click();
  await page.screenshot({ path: `${outDir}/${project}-home-expanded.png` });
  await page.locator('[data-dle-mobile-view="browse"]').click();
  await page.waitForSelector('.dle-mobile-browse-controls', { timeout: 5000 });
  await page.screenshot({ path: `${outDir}/${project}-browse.png` });
  const report = {
    project,
    rootVisible: await page.locator('#dle-mobile-root:not([hidden])').count(),
    statusTrayVisible: await page.locator('.dle-mobile-status-tray').count(),
    browseControlsVisible: await page.locator('.dle-mobile-browse-controls').count(),
    browseCards: await page.locator('.dle-mobile-browse-card').count(),
    errors,
  };
  await browser.close();
  return report;
}

(async () => {
  await fs.mkdir(outDir, { recursive: true });
  const reports = [];
  reports.push(await run('chromium-pixel5', chromium, { width: 393, height: 851 }));
  reports.push(await run('webkit-iphone14', webkit, { width: 390, height: 844 }));
  await fs.writeFile(`${outDir}/report.json`, JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
})();
```

- [ ] **Step 4: Run browser smoke**

Run from the clean clone because Playwright is installed there:

```powershell
cd 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern'
node C:\tmp\dle-mobile-parity-smoke.cjs
```

Expected: report shows `rootVisible: 1`, `statusTrayVisible: 1`, `browseControlsVisible: 1`, and no relevant console errors. `browseCards` may be `0` on an empty vault, but the Browse controls and empty state must still render.

- [ ] **Step 5: Inspect screenshots**

Open these screenshots:

```text
C:\tmp\dle-mobile-parity\chromium-pixel5-home-collapsed.png
C:\tmp\dle-mobile-parity\chromium-pixel5-home-expanded.png
C:\tmp\dle-mobile-parity\chromium-pixel5-browse.png
C:\tmp\dle-mobile-parity\webkit-iphone14-home-expanded.png
C:\tmp\dle-mobile-parity\webkit-iphone14-browse.png
```

Expected visual checks:

- Status tray does not overlap the close button or the sheet header.
- Expanded stats fit without horizontal clipping.
- Browse search/filter controls wrap cleanly.
- Browse cards or empty state do not cover the SillyTavern input bar.
- The full Browse fallback button remains reachable.

- [ ] **Step 6: Update local progress**

Edit `progress.md`:

```markdown
- [x] Expand mobile Home with an option-B status tray.
- [x] Expand mobile Browse into a phone-native work surface with search, filters, quick filters, entry cards, previews, and actions.
- [x] Browser smoke mobile status tray and Browse on Chromium Pixel 5 and WebKit iPhone 14.
```

Also update the latest verification section with the exact `npm run test:mobile` count and `C:\tmp\dle-mobile-parity\report.json`.

- [ ] **Step 7: Commit Task 7**

Run:

```powershell
git add progress.md
```

Expected: Git will likely ignore `progress.md`. If ignored, do not force-add it.

Commit only tracked code/test/style changes if any browser fixes were made:

```powershell
git status --short
git add src/mobile/mobile-shell.js src/mobile/mobile-stats.js src/mobile/mobile-browse.js style.css test/mobile-ui.test.mjs
git commit -m "Verify mobile status tray and Browse parity"
```

If there are no tracked changes after QA, skip the commit and record the QA evidence in the final response.

---

## Final Verification

- [ ] Run:

```powershell
npm run test:mobile
```

Expected: PASS with all mobile tests green.

- [ ] Run:

```powershell
npm run test:all
```

Expected: PASS. If a non-mobile suite fails, investigate whether the failure is related before continuing.

- [ ] Review:

```powershell
git status --short --branch
git log --oneline --decorate -6
```

Expected: only intentional commits are present; ignored `progress.md` may remain untracked/modified locally.

---

## Plan Self-Review

- Spec coverage: status tray, Browse search/filter/quick filters/cards/actions, CSS bounds, browser QA, and progress handoff are all mapped to tasks.
- Marker scan: no unresolved planning markers are present.
- Type consistency: `statsExpanded`, `browse`, `browseSearchHelpOpen`, and `browseExpandedKey` are introduced in Task 2 or Task 4 before subsequent tasks reference them.
- Scope check: Why, Librarian, Tools, and Filters parity remain documented future drill-in passes; this plan finishes status tray plus Browse-first parity as a working slice.
