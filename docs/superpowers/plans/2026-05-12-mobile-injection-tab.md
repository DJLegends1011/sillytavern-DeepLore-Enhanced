# Mobile Injection Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the proof-of-concept "Why?" mobile view with a fully functional Injection tab matching the desktop drawer's Injection panel.

**Architecture:** New pure helper module `src/mobile/mobile-injection.js` (mirrors `mobile-browse.js` pattern), rewritten `renderInjection()` in `mobile-shell.js` using expandable list cards, new CSS selectors in `style.css`. All data sourced from existing `buildMobileShellSnapshot()`.

**Tech Stack:** Vanilla JS (ES modules), no build step, SillyTavern extension runtime, custom test harness (`test/helpers.mjs`)

**Spec:** `docs/superpowers/specs/2026-05-12-mobile-injection-tab-design.md`

---

### Task 1: Create `mobile-injection.js` — normalizeMobileInjectionState

**Files:**
- Create: `src/mobile/mobile-injection.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `test/mobile-ui.test.mjs`, after the existing Browse helper imports (line ~39), add the import:

```js
import {
    normalizeMobileInjectionState,
    MOBILE_INJECTION_DEFAULT_STATE,
} from '../src/mobile/mobile-injection.js';
```

Then add test cases before the `summary()` call at the end of the file:

```js
test('normalizeMobileInjectionState: returns defaults for empty input', () => {
    const state = normalizeMobileInjectionState();
    assertEqual(state.filter, 'injected', 'default filter should be injected');
    assertEqual(state.expandedKey, '', 'default expandedKey should be empty string');
});

test('normalizeMobileInjectionState: preserves valid filter values', () => {
    assertEqual(normalizeMobileInjectionState({ filter: 'filtered' }).filter, 'filtered', 'should accept filtered');
    assertEqual(normalizeMobileInjectionState({ filter: 'both' }).filter, 'both', 'should accept both');
    assertEqual(normalizeMobileInjectionState({ filter: 'injected' }).filter, 'injected', 'should accept injected');
});

test('normalizeMobileInjectionState: rejects invalid filter values', () => {
    assertEqual(normalizeMobileInjectionState({ filter: 'garbage' }).filter, 'injected', 'invalid filter should fall back to injected');
    assertEqual(normalizeMobileInjectionState({ filter: null }).filter, 'injected', 'null filter should fall back to injected');
    assertEqual(normalizeMobileInjectionState({ filter: 123 }).filter, 'injected', 'numeric filter should fall back to injected');
});

test('normalizeMobileInjectionState: coerces expandedKey to string', () => {
    assertEqual(normalizeMobileInjectionState({ expandedKey: 42 }).expandedKey, '42', 'numeric key should be stringified');
    assertEqual(normalizeMobileInjectionState({ expandedKey: null }).expandedKey, '', 'null key should become empty string');
});

test('MOBILE_INJECTION_DEFAULT_STATE: is frozen', () => {
    assert(Object.isFrozen(MOBILE_INJECTION_DEFAULT_STATE), 'default state should be frozen');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:mobile`
Expected: FAIL — `Cannot find module '../src/mobile/mobile-injection.js'`

- [ ] **Step 3: Write the implementation**

Create `src/mobile/mobile-injection.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: All new normalization tests PASS, existing tests still PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-injection.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): add normalizeMobileInjectionState helper"
```

---

### Task 2: Add `splitInjectionEntries` to `mobile-injection.js`

**Files:**
- Modify: `src/mobile/mobile-injection.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add the import for `splitInjectionEntries` at the top of the test file (extend the existing import block):

```js
import {
    normalizeMobileInjectionState,
    splitInjectionEntries,
    MOBILE_INJECTION_DEFAULT_STATE,
} from '../src/mobile/mobile-injection.js';
```

Add tests before `summary()`:

```js
test('splitInjectionEntries: injected mode returns only injected sources', () => {
    const sources = [
        { title: 'Keisha', tokens: 217, matchedBy: 'keyword' },
        { title: 'Study Room', tokens: 185, matchedBy: 'AI selection' },
    ];
    const trace = {
        gatedOut: [{ title: 'Blocked Entry', requires: ['era:modern'] }],
        contextualGatingRemoved: [{ title: 'Gated Entry', reason: 'wrong era' }],
    };
    const result = splitInjectionEntries(sources, trace, 'injected');

    assertEqual(result.entries.length, 2, 'should return 2 injected entries');
    assertEqual(result.entries[0].title, 'Keisha', 'first entry title');
    assertEqual(result.entries[0].isFiltered, false, 'injected entries should not be marked filtered');
    assertMatch(result.summary, /2 injected/, 'summary should mention injected count');
});

test('splitInjectionEntries: filtered mode returns only rejected entries', () => {
    const sources = [{ title: 'Keisha', tokens: 217, matchedBy: 'keyword' }];
    const trace = {
        gatedOut: [{ title: 'Blocked', requires: ['era'] }],
        contextualGatingRemoved: [{ title: 'Gated', reason: 'wrong era' }],
        cooldownRemoved: [{ title: 'OnCooldown' }],
        budgetCut: [{ title: 'OverBudget', tokens: 500 }],
    };
    const result = splitInjectionEntries(sources, trace, 'filtered');

    assertEqual(result.entries.length, 4, 'should return all rejected entries');
    assert(result.entries.every(e => e.isFiltered === true), 'all should be marked filtered');
    assertMatch(result.summary, /4 filtered/, 'summary should mention filtered count');
});

test('splitInjectionEntries: both mode merges injected and filtered', () => {
    const sources = [{ title: 'Keisha', tokens: 217, matchedBy: 'keyword' }];
    const trace = {
        budgetCut: [{ title: 'OverBudget', tokens: 500 }],
    };
    const result = splitInjectionEntries(sources, trace, 'both');

    assertEqual(result.entries.length, 2, 'should return both injected and filtered');
    const injected = result.entries.filter(e => !e.isFiltered);
    const filtered = result.entries.filter(e => e.isFiltered);
    assertEqual(injected.length, 1, 'one injected');
    assertEqual(filtered.length, 1, 'one filtered');
    assertMatch(result.summary, /1 injected/, 'summary mentions injected');
    assertMatch(result.summary, /1 filtered/, 'summary mentions filtered');
});

test('splitInjectionEntries: handles empty sources and missing trace gracefully', () => {
    const result1 = splitInjectionEntries([], null, 'injected');
    assertEqual(result1.entries.length, 0, 'empty sources gives empty list');
    assertEqual(result1.summary, '', 'empty sources gives empty summary');

    const result2 = splitInjectionEntries(null, null, 'filtered');
    assertEqual(result2.entries.length, 0, 'null sources gives empty list');

    const result3 = splitInjectionEntries([], {}, 'both');
    assertEqual(result3.entries.length, 0, 'empty trace gives empty list');
});

test('splitInjectionEntries: does not duplicate injected entries in filtered list', () => {
    const sources = [{ title: 'Keisha', tokens: 217, matchedBy: 'keyword' }];
    const trace = {
        budgetCut: [{ title: 'Keisha', tokens: 217 }, { title: 'Other', tokens: 100 }],
    };
    const result = splitInjectionEntries(sources, trace, 'filtered');
    const keishaEntries = result.entries.filter(e => e.title === 'Keisha');
    assertEqual(keishaEntries.length, 0, 'injected entries should be excluded from filtered list');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:mobile`
Expected: FAIL — `splitInjectionEntries is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/mobile/mobile-injection.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: All splitInjectionEntries tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-injection.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): add splitInjectionEntries helper"
```

---

### Task 3: Add `buildMobileInjectionRows` to `mobile-injection.js`

**Files:**
- Modify: `src/mobile/mobile-injection.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing tests**

Extend the import to include `buildMobileInjectionRows`:

```js
import {
    normalizeMobileInjectionState,
    splitInjectionEntries,
    buildMobileInjectionRows,
    MOBILE_INJECTION_DEFAULT_STATE,
} from '../src/mobile/mobile-injection.js';
```

Add tests before `summary()`:

```js
test('buildMobileInjectionRows: maps injected source to display row', () => {
    const entries = [
        { title: 'Keisha', tokens: 217, matchedBy: 'keyword: Keisha', vaultSource: 'TestVault', filename: 'Keisha.md', isFiltered: false },
    ];
    const rows = buildMobileInjectionRows(entries);

    assertEqual(rows.length, 1, 'should produce one row');
    assertEqual(rows[0].title, 'Keisha', 'title should match');
    assertEqual(rows[0].tokenCount, 217, 'tokenCount should be numeric');
    assertEqual(rows[0].tokenLabel, '217 tok', 'tokenLabel should be formatted');
    assertEqual(rows[0].isKeyword, true, 'keyword match should set isKeyword');
    assertEqual(rows[0].matchLabel, 'KEY', 'keyword match should produce KEY label');
    assertEqual(rows[0].filename, 'Keisha.md', 'filename should pass through');
    assertEqual(rows[0].vaultSource, 'TestVault', 'vaultSource should pass through');
    assertEqual(rows[0].isFiltered, false, 'injected entry should not be filtered');
    assert(rows[0].key, 'should produce a key for expand/collapse');
});

test('buildMobileInjectionRows: detects AI match type', () => {
    const entries = [
        { title: 'Room', tokens: 100, matchedBy: 'AI selection', isFiltered: false },
    ];
    const rows = buildMobileInjectionRows(entries);

    assertEqual(rows[0].isKeyword, false, 'AI match should not set isKeyword');
    assertEqual(rows[0].matchLabel, 'AI', 'AI match should produce AI label');
});

test('buildMobileInjectionRows: detects keyword+AI match type', () => {
    const entries = [
        { title: 'Blade', tokens: 150, matchedBy: 'blade → AI: relevant', isFiltered: false },
    ];
    const rows = buildMobileInjectionRows(entries);

    assertEqual(rows[0].isKeyword, true, 'keyword+AI should set isKeyword');
    assertEqual(rows[0].matchLabel, 'KEY+AI', 'keyword+AI should produce KEY+AI label');
});

test('buildMobileInjectionRows: handles constant and pinned entries', () => {
    const constant = buildMobileInjectionRows([{ title: 'Rules', matchedBy: 'constant', isFiltered: false }]);
    assertEqual(constant[0].matchLabel, 'CONST', 'constant should produce CONST label');

    const pinned = buildMobileInjectionRows([{ title: 'Fav', matchedBy: 'pinned', isFiltered: false }]);
    assertEqual(pinned[0].matchLabel, 'PIN', 'pinned should produce PIN label');
});

test('buildMobileInjectionRows: passes through isFiltered flag', () => {
    const entries = [
        { title: 'Blocked', tokens: 50, matchedBy: 'keyword', reason: 'over budget', isFiltered: true },
    ];
    const rows = buildMobileInjectionRows(entries);

    assertEqual(rows[0].isFiltered, true, 'filtered flag should pass through');
    assertEqual(rows[0].reason, 'over budget', 'reason should pass through for filtered entries');
});

test('buildMobileInjectionRows: handles missing tokens gracefully', () => {
    const rows = buildMobileInjectionRows([{ title: 'NoTokens', matchedBy: 'keyword', isFiltered: false }]);
    assertEqual(rows[0].tokenCount, 0, 'missing tokens should default to 0');
    assertEqual(rows[0].tokenLabel, '', 'missing tokens should produce empty label');
});

test('buildMobileInjectionRows: handles empty input', () => {
    assertEqual(buildMobileInjectionRows([]).length, 0, 'empty array produces no rows');
    assertEqual(buildMobileInjectionRows(null).length, 0, 'null input produces no rows');
    assertEqual(buildMobileInjectionRows(undefined).length, 0, 'undefined input produces no rows');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:mobile`
Expected: FAIL — `buildMobileInjectionRows is not a function`

- [ ] **Step 3: Write the implementation**

Add import at the top of `src/mobile/mobile-injection.js`:

```js
import { parseMatchReason } from '../helpers.js';
```

Add the function:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: All buildMobileInjectionRows tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-injection.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): add buildMobileInjectionRows helper"
```

---

### Task 4: Add `extractTimerData` to `mobile-injection.js`

**Files:**
- Modify: `src/mobile/mobile-injection.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing tests**

Extend the import:

```js
import {
    normalizeMobileInjectionState,
    splitInjectionEntries,
    buildMobileInjectionRows,
    extractTimerData,
    MOBILE_INJECTION_DEFAULT_STATE,
} from '../src/mobile/mobile-injection.js';
```

Add tests before `summary()`:

```js
test('extractTimerData: extracts cooldown entries', () => {
    const cooldowns = new Map([['vault:Keisha', 3], ['vault:Room', 1]]);
    const timers = extractTimerData(cooldowns, new Map());

    assertEqual(timers.length, 2, 'should return 2 timer entries');
    assertEqual(timers[0].title, 'Keisha', 'should extract title from tracker key');
    assertEqual(timers[0].timerType, 'cooldown', 'should label as cooldown');
    assertEqual(timers[0].remaining, 3, 'should pass remaining count');
    assertMatch(timers[0].detail, /3 messages? cooldown/, 'detail should describe cooldown');
});

test('extractTimerData: extracts decay entries past boost threshold', () => {
    const decays = new Map([['vault:Stale', 8], ['vault:Fresh', 2]]);
    const timers = extractTimerData(new Map(), decays, { decayEnabled: true, decayBoostThreshold: 5 });

    assertEqual(timers.length, 1, 'should only return entries past boost threshold');
    assertEqual(timers[0].title, 'Stale', 'should extract stale entry');
    assertEqual(timers[0].timerType, 'decay', 'should label as decay');
    assertMatch(timers[0].detail, /stale 8 messages/, 'detail should describe staleness');
});

test('extractTimerData: handles empty trackers', () => {
    assertEqual(extractTimerData(new Map(), new Map()).length, 0, 'empty trackers return empty array');
    assertEqual(extractTimerData(null, null).length, 0, 'null trackers return empty array');
    assertEqual(extractTimerData(undefined, undefined).length, 0, 'undefined trackers return empty array');
});

test('extractTimerData: skips decay when decayEnabled is false', () => {
    const decays = new Map([['vault:Stale', 10]]);
    const timers = extractTimerData(new Map(), decays, { decayEnabled: false });
    assertEqual(timers.length, 0, 'should skip decay entries when disabled');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:mobile`
Expected: FAIL — `extractTimerData is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/mobile/mobile-injection.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: All extractTimerData tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-injection.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): add extractTimerData helper"
```

---

### Task 5: Rename "Why?" to "Injection" in `mobile-shell.js`

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing test**

Add test before `summary()`:

```js
test('mobile shell: no "Why?" label remains in mobile output', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        lastInjectionSources: [],
        lastPipelineTrace: null,
        loreGaps: [],
        indexEverLoaded: true,
    });

    const homeHtml = renderMobileShell(snapshot, { open: true, view: 'home', mode: 'auto', errorMessage: '' });
    assert(!homeHtml.includes('>Why?<'), 'Home view should not contain "Why?" label');
    assert(!homeHtml.includes('>Why?</strong>'), 'Home view should not contain "Why?" in strong tag');
    assertMatch(homeHtml, /Injection/, 'Home view should contain "Injection" label');
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm run test:mobile`
Expected: FAIL — Home view still contains "Why?"

- [ ] **Step 3: Apply the rename**

In `src/mobile/mobile-shell.js`, make these changes:

1. In `commandForView()` (~line 165): rename the `why` key to `injection`:
```js
function commandForView(view) {
    const commands = {
        injection: '/dle-why',
        browse: '/dle-browse',
        filters: '/dle-context-state',
        health: '/dle-health',
        graph: '/dle-graph',
        setup: '/dle-setup',
    };
    return commands[view] || '';
}
```

2. In `renderHome()` (~line 311): change the action button label:
```js
${renderActionButton('Injection', 'injection', 'fa-circle-question')}
```

3. In `renderBody()` (~line 504): rename the case:
```js
case 'injection': return renderWhy(snapshot);
```
(This will be replaced with `renderInjection` in Task 6, but keep `renderWhy` for now so existing tests pass.)

4. In `handleMobileClick()` (~line 771): update the local views set:
```js
const localViews = new Set(['home', 'injection', 'browse', 'librarian', 'tools']);
```

5. In `destroyMobileShell()` (~line 879): update the default state:
```js
view: 'home',
```
(This is already `'home'`, no change needed.)

6. In `mobileState` initialization (~line 48): keep `view: 'home'` (already correct).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: The new "no Why? label" test PASSES, all existing tests still PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "refactor(mobile): rename Why? to Injection in mobile shell"
```

---

### Task 6: Replace `renderWhy` with `renderInjection` in `mobile-shell.js`

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add tests before `summary()`:

```js
test('renderInjection: renders header with Injection title and badge', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        lastInjectionSources: [
            { title: 'Keisha', tokens: 217, matchedBy: 'keyword' },
        ],
        lastPipelineTrace: { injected: [{ title: 'Keisha' }] },
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, { open: true, view: 'injection', mode: 'auto', errorMessage: '', injectionFilter: 'injected', injectionExpandedKey: '' });

    assertMatch(html, /Injection/, 'should contain Injection title');
    assertMatch(html, /data-dle-mobile-injection-filter/, 'should contain filter toggle buttons');
    assertMatch(html, /Injected/, 'should contain Injected filter option');
    assertMatch(html, /Filtered/, 'should contain Filtered filter option');
    assertMatch(html, /Both/, 'should contain Both filter option');
});

test('renderInjection: renders entry cards with title, tokens, and badges', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [{ title: 'Keisha', tokens: 217, keys: ['keisha'], vaultSource: 'TV', filename: 'Keisha.md' }],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        lastInjectionSources: [
            { title: 'Keisha', tokens: 217, matchedBy: 'keyword: keisha', vaultSource: 'TV', filename: 'Keisha.md' },
        ],
        lastPipelineTrace: { injected: [{ title: 'Keisha' }] },
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, { open: true, view: 'injection', mode: 'auto', errorMessage: '', injectionFilter: 'injected', injectionExpandedKey: '' });

    assertMatch(html, /Keisha/, 'should render entry title');
    assertMatch(html, /217 tok/, 'should render token count');
    assertMatch(html, /KEY/, 'should render KEY badge for keyword match');
    assertMatch(html, /data-dle-mobile-injection-expand/, 'should have expand button');
});

test('renderInjection: renders empty state when no sources', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        lastInjectionSources: [],
        lastPipelineTrace: null,
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, { open: true, view: 'injection', mode: 'auto', errorMessage: '', injectionFilter: 'injected', injectionExpandedKey: '' });

    assertMatch(html, /No entries injected yet/, 'should show empty state message');
});

test('renderInjection: renders Entry Timers section', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        lastInjectionSources: [{ title: 'A', tokens: 100, matchedBy: 'keyword' }],
        lastPipelineTrace: { injected: [{ title: 'A' }] },
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, { open: true, view: 'injection', mode: 'auto', errorMessage: '', injectionFilter: 'injected', injectionExpandedKey: '' });

    assertMatch(html, /Entry Timers/, 'should contain Entry Timers collapsible');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:mobile`
Expected: FAIL — output still contains old Why? format, missing new elements

- [ ] **Step 3: Write the implementation**

In `src/mobile/mobile-shell.js`:

1. Add imports at the top (after the existing mobile-browse import):

```js
import {
    normalizeMobileInjectionState,
    splitInjectionEntries,
    buildMobileInjectionRows,
    extractTimerData,
} from './mobile-injection.js';
```

Also add imports from state.js (extend the existing import):

```js
import {
    // ... existing imports ...
    cooldownTracker,
    decayTracker,
} from '../state.js';
```

2. Add injection state fields to `mobileState` initialization (~line 46):

```js
let mobileState = {
    open: false,
    view: 'home',
    active: false,
    mode: 'auto',
    errorMessage: '',
    statsExpanded: false,
    browse: normalizeMobileBrowseState(),
    browseSearchHelpOpen: false,
    browseExpandedKey: '',
    injectionFilter: 'injected',
    injectionExpandedKey: '',
};
```

3. Delete the entire `renderWhy()` function (~lines 319-336) and replace with:

```js
function renderInjectionCard(row, state) {
    const expanded = state.injectionExpandedKey === row.key;
    const filteredClass = row.isFiltered ? ' dle-mobile-injection-filtered' : '';
    const expandedClass = expanded ? ' dle-mobile-injection-expanded' : '';
    const badges = [];
    if (row.injectionCount > 0) badges.push(`<span class="dle-mobile-injection-badge">${row.injectionCount}×</span>`);
    if (row.isKeyword) badges.push(`<span class="dle-mobile-injection-badge dle-mobile-injection-badge-key">KEY</span>`);
    if (row.matchLabel && !row.isKeyword && row.matchLabel !== 'KEY') badges.push(`<span class="dle-mobile-injection-badge">${escapeHtml(row.matchLabel)}</span>`);

    return `
        <article class="dle-mobile-injection-card${filteredClass}${expandedClass}" data-dle-mobile-injection-key="${escapeHtml(row.key)}">
            <div class="dle-mobile-injection-title-row">
                <button type="button" data-dle-mobile-injection-expand="${escapeHtml(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                    <i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}" aria-hidden="true"></i>
                    <strong>${escapeHtml(row.title)}</strong>
                </button>
                <div class="dle-mobile-injection-meta">
                    ${badges.join('')}
                    ${row.tokenLabel ? `<span class="dle-mobile-injection-tokens">${escapeHtml(row.tokenLabel)}</span>` : ''}
                </div>
            </div>
            ${expanded ? `<div class="dle-mobile-injection-detail">
                <div>Matched by: <strong>${escapeHtml(row.matchedBy || row.matchLabel)}</strong></div>
                ${row.reason ? `<div>Reason: ${escapeHtml(row.reason)}</div>` : ''}
                <div class="dle-mobile-injection-links">
                    ${row.filename ? `<button type="button" data-dle-mobile-injection-action="obsidian" data-filename="${escapeHtml(row.filename)}" data-vault="${escapeHtml(row.vaultSource)}">Open in Obsidian</button>` : ''}
                    <button type="button" data-dle-mobile-injection-action="browse" data-title="${escapeHtml(row.title)}">Go to Browse →</button>
                </div>
            </div>` : ''}
        </article>
    `;
}

function renderInjection(snapshot, state = mobileState) {
    const injectedSources = Array.isArray(snapshot.injectedSources) ? snapshot.injectedSources : [];
    const filter = state.injectionFilter || 'injected';
    const trace = lastPipelineTrace;
    const split = splitInjectionEntries(injectedSources, trace, filter);
    const rows = buildMobileInjectionRows(split.entries);
    const settings = mobileShellOptions.getSettings?.() ?? {};
    const timers = extractTimerData(cooldownTracker, decayTracker, settings);

    const filterButtons = ['injected', 'filtered', 'both'].map(f =>
        `<button type="button" class="dle-mobile-injection-filter-btn${filter === f ? ' active' : ''}" data-dle-mobile-injection-filter="${f}" aria-pressed="${filter === f ? 'true' : 'false'}">${f.charAt(0).toUpperCase() + f.slice(1)}</button>`
    ).join('');

    const entryCards = rows.length
        ? rows.map(row => renderInjectionCard(row, state)).join('')
        : `<div class="dle-mobile-injection-empty">
            <strong>No entries injected yet</strong>
            <span>Send a message mentioning entry keywords, or check Obsidian connection.</span>
           </div>`;

    const timerRows = timers.length
        ? timers.map(t => `<div class="dle-mobile-injection-timer"><span>${escapeHtml(t.title)}</span><span class="dle-mobile-injection-timer-badge dle-mobile-injection-timer-${t.timerType}">${escapeHtml(t.detail)}</span></div>`).join('')
        : '<div class="dle-mobile-injection-timer-empty">No active timers</div>';

    return `
        <div class="dle-mobile-drill-header">
            <button type="button" data-dle-mobile-view="home"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <strong>Injection</strong>
            <span class="dle-mobile-injection-count">${snapshot.injectedCount}</span>
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-command="${commandForView('injection')}">Full View <i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i></button>
        </div>
        <div class="dle-mobile-injection-filters" role="radiogroup" aria-label="Filter entries">
            ${filterButtons}
        </div>
        ${split.summary ? `<div class="dle-mobile-injection-summary">${escapeHtml(split.summary)}</div>` : ''}
        <div class="dle-mobile-injection-list">
            ${entryCards}
        </div>
        <details class="dle-mobile-injection-timers">
            <summary><i class="fa-solid fa-clock" aria-hidden="true"></i> Entry Timers</summary>
            <div class="dle-mobile-injection-timer-list">${timerRows}</div>
        </details>
    `;
}
```

4. Update `renderBody()` switch case:

```js
case 'injection': return renderInjection(snapshot, state);
```

5. Also reset injection state in `destroyMobileShell()`:

```js
injectionFilter: 'injected',
injectionExpandedKey: '',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: All renderInjection tests PASS, all existing tests still PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): replace renderWhy with full renderInjection"
```

---

### Task 7: Add Injection click handlers to `mobile-shell.js`

**Files:**
- Modify: `src/mobile/mobile-shell.js`
- Test: `test/mobile-ui.test.mjs`

- [ ] **Step 1: Write the failing test**

Add test before `summary()`:

```js
test('mobile shell: injection filter clicks update state', () => {
    const dom = installMobileDom();
    try {
        const root = createMobileShell({ getSettings: () => ({}), getDrawerState: () => ({}) });
        assert(root, 'mobile shell should be created');

        const filterTarget = new MockElement('button');
        filterTarget.ownerDocument = root.ownerDocument;
        filterTarget.parentElement = root;
        filterTarget.setAttribute('data-dle-mobile-injection-filter', 'filtered');
        clickMobileRoot(root, filterTarget);

        assertMatch(root.innerHTML, /dle-mobile-injection-filter-btn/, 'should re-render with injection filter buttons');

        destroyMobileShell();
    } finally {
        dom.restore();
    }
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm run test:mobile`
Expected: FAIL — clicking injection filter does nothing

- [ ] **Step 3: Write the implementation**

In `src/mobile/mobile-shell.js`, add to `handleMobileClick()` — insert after the `browseActionEl` handler block (~line 738) and before the `modeEl` handler:

```js
    const injectionFilterEl = target.closest('[data-dle-mobile-injection-filter]');
    if (injectionFilterEl) {
        mobileState.injectionFilter = injectionFilterEl.getAttribute('data-dle-mobile-injection-filter') || 'injected';
        mobileState.injectionExpandedKey = '';
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const injectionExpandEl = target.closest('[data-dle-mobile-injection-expand]');
    if (injectionExpandEl) {
        const key = injectionExpandEl.getAttribute('data-dle-mobile-injection-expand') || '';
        mobileState.injectionExpandedKey = mobileState.injectionExpandedKey === key ? '' : key;
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const injectionActionEl = target.closest('[data-dle-mobile-injection-action]');
    if (injectionActionEl) {
        const action = injectionActionEl.getAttribute('data-dle-mobile-injection-action');
        if (action === 'obsidian') {
            const filename = injectionActionEl.getAttribute('data-filename') || '';
            const vaultSource = injectionActionEl.getAttribute('data-vault') || '';
            openMobileBrowseObsidian(filename, vaultSource || null);
        } else if (action === 'browse') {
            mobileState.view = 'browse';
            mobileState.errorMessage = '';
        }
        renderCurrentState();
        return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "feat(mobile): add Injection tab click handlers"
```

---

### Task 8: Add Injection CSS to `style.css`

**Files:**
- Modify: `style.css`

- [ ] **Step 1: Write the failing test (CSS contract)**

Add test before `summary()` in `test/mobile-ui.test.mjs`:

```js
test('style.css: contains mobile injection card and filter styles', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

    assertMatch(css, /\.dle-mobile-injection-filters/, 'should define injection filter toggle styles');
    assertMatch(css, /\.dle-mobile-injection-card/, 'should define injection card styles');
    assertMatch(css, /\.dle-mobile-injection-filtered/, 'should define filtered entry muted styles');
    assertMatch(css, /\.dle-mobile-injection-badge/, 'should define injection badge styles');
    assertMatch(css, /\.dle-mobile-injection-timers/, 'should define injection timers styles');
    assertMatch(css, /\.dle-mobile-injection-expanded/, 'should define expanded card styles');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:mobile`
Expected: FAIL — CSS doesn't contain injection selectors yet

- [ ] **Step 3: Add the CSS**

Append to `style.css` (after the existing mobile browse styles):

```css
/* ── Mobile Injection Tab ── */

.dle-mobile-injection-filters {
    display: flex;
    gap: 4px;
    padding: 0 12px 8px;
}

.dle-mobile-injection-filter-btn {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--SmartThemeBorderColor, #555);
    border-radius: 4px;
    background: transparent;
    color: var(--SmartThemeBodyColor, #ccc);
    font-size: 0.8em;
    cursor: pointer;
}

.dle-mobile-injection-filter-btn.active {
    border-color: var(--SmartThemeQuoteColor, #f5a623);
    color: var(--SmartThemeQuoteColor, #f5a623);
    background: rgba(245, 166, 35, 0.1);
}

.dle-mobile-injection-summary {
    padding: 0 12px 6px;
    font-size: 0.75em;
    color: var(--SmartThemeBodyColor, #999);
}

.dle-mobile-injection-count {
    background: var(--SmartThemeQuoteColor, #f5a623);
    color: #000;
    border-radius: 10px;
    padding: 1px 7px;
    font-size: 0.75em;
    margin-left: 4px;
}

.dle-mobile-injection-list {
    padding: 0 12px;
}

.dle-mobile-injection-card {
    background: var(--SmartThemeBlurTintColor, #252540);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 4px;
    border-left: 3px solid var(--SmartThemeQuoteColor, #f5a623);
}

.dle-mobile-injection-card.dle-mobile-injection-filtered {
    opacity: 0.6;
    border-left-color: var(--SmartThemeBorderColor, #555);
}

.dle-mobile-injection-card.dle-mobile-injection-expanded {
    border: 1px solid var(--SmartThemeQuoteColor, #f5a623);
    border-left-width: 3px;
}

.dle-mobile-injection-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}

.dle-mobile-injection-title-row button {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    color: var(--SmartThemeQuoteColor, #f5a623);
    font-weight: bold;
    font-size: 0.85em;
    cursor: pointer;
    padding: 0;
    text-align: left;
}

.dle-mobile-injection-title-row button i {
    font-size: 0.7em;
    color: var(--SmartThemeBodyColor, #888);
}

.dle-mobile-injection-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

.dle-mobile-injection-tokens {
    color: hsl(120, 60%, 50%);
    font-size: 0.75em;
}

.dle-mobile-injection-badge {
    background: var(--SmartThemeBorderColor, #555);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.7em;
    color: var(--SmartThemeBodyColor, #ccc);
}

.dle-mobile-injection-badge-key {
    background: var(--SmartThemeQuoteColor, #f5a623);
    color: #000;
}

.dle-mobile-injection-detail {
    padding: 6px 0 2px 18px;
    font-size: 0.75em;
    color: var(--SmartThemeBodyColor, #aaa);
}

.dle-mobile-injection-links {
    display: flex;
    gap: 8px;
    margin-top: 4px;
}

.dle-mobile-injection-links button {
    background: none;
    border: none;
    color: var(--SmartThemeHyperlinkColor, #4dabf7);
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
    font-size: 1em;
}

.dle-mobile-injection-empty {
    padding: 16px 0;
    text-align: center;
    color: var(--SmartThemeBodyColor, #888);
}

.dle-mobile-injection-empty strong {
    display: block;
    margin-bottom: 4px;
}

.dle-mobile-injection-timers {
    margin: 8px 12px 0;
    border-top: 1px solid var(--SmartThemeBorderColor, #333);
}

.dle-mobile-injection-timers summary {
    padding: 6px 0;
    font-size: 0.8em;
    color: var(--SmartThemeBodyColor, #888);
    cursor: pointer;
}

.dle-mobile-injection-timer {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
    font-size: 0.75em;
}

.dle-mobile-injection-timer-badge {
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 0.9em;
}

.dle-mobile-injection-timer-cooldown {
    background: rgba(245, 166, 35, 0.2);
    color: var(--SmartThemeQuoteColor, #f5a623);
}

.dle-mobile-injection-timer-decay {
    background: rgba(255, 100, 100, 0.2);
    color: #ff6464;
}

.dle-mobile-injection-timer-empty {
    font-size: 0.75em;
    color: var(--SmartThemeBodyColor, #666);
    padding: 4px 0;
    opacity: 0.5;
}

.dle-mobile-wide-action-sm {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--SmartThemeBodyColor, #888);
    font-size: 0.7em;
    cursor: pointer;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:mobile`
Expected: CSS contract test PASSES, all other tests PASS

- [ ] **Step 5: Commit**

```bash
git add style.css test/mobile-ui.test.mjs
git commit -m "feat(mobile): add Injection tab CSS styles"
```

---

### Task 9: Run full test suite and lint

**Files:**
- No new files — verification only

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm run test:all`
Expected: All tests PASS, including all new injection tests

- [ ] **Step 3: Verify import checker**

Run: `npm run test:imports`
Expected: `Broken: 0`

- [ ] **Step 4: Final commit if any lint fixes were needed**

```bash
git add -A
git commit -m "fix: lint cleanup for mobile injection tab"
```
(Only if lint required changes.)
