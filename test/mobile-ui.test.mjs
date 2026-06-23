/**
 * DeepLore Enhanced mobile UI foundation tests.
 * Run with: node test/mobile-ui.test.mjs
 */

import {
    assert,
    assertEqual,
    assertMatch,
    test,
    testAsync,
    summary,
} from './helpers.mjs';

import {
    shouldUseMobileUi,
    normalizeMobilePreference,
    buildMobileShellSnapshot,
    renderMobileShell,
    createMobileShell,
    destroyMobileShell,
    runMobileReroll,
    MOBILE_VIEWPORT_WIDTH,
    TOUCH_TABLET_WIDTH,
    MOBILE_FORCE_STORAGE_KEY,
    MOBILE_DISABLE_STORAGE_KEY,
} from '../src/mobile/mobile-shell.js';

import {
    createMobileUiState,
} from '../src/mobile/mobile-state.js';

import {
    buildMobileStatusStats,
    formatMobileStatNumber,
} from '../src/mobile/mobile-stats.js';

import {
    MOBILE_BROWSE_DEFAULT_STATE,
    buildMobileBrowseOptions,
    buildMobileBrowseRows,
    filterMobileBrowseEntries,
    normalizeMobileBrowseState,
} from '../src/mobile/mobile-browse.js';

import {
    normalizeMobileInjectionState,
    splitInjectionEntries,
    buildMobileInjectionRows,
    extractTimerData,
    MOBILE_INJECTION_DEFAULT_STATE,
} from '../src/mobile/mobile-injection.js';

import { readFileSync } from 'node:fs';

import {
    suppressNextAgenticLoop,
    setSuppressNextAgenticLoop,
    vaultIndex,
    setVaultIndex,
} from '../src/state.js';

class MockClassList {
    constructor() {
        this.values = new Set();
    }

    toggle(name, force) {
        const enabled = force ?? !this.values.has(name);
        if (enabled) this.values.add(name);
        else this.values.delete(name);
    }

    remove(name) {
        this.values.delete(name);
    }

    contains(name) {
        return this.values.has(name);
    }
}

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.listeners = {};
        this.classList = new MockClassList();
        this.hidden = false;
        this.style = {};
        this._innerHTML = '';
    }

    set id(value) {
        this.setAttribute('id', value);
    }

    get id() {
        return this.getAttribute('id') || '';
    }

    set className(value) {
        this.setAttribute('class', value);
    }

    get className() {
        return this.getAttribute('class') || '';
    }

    set innerHTML(value) {
        this._innerHTML = String(value ?? '');
    }

    get innerHTML() {
        return this._innerHTML;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(child) {
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
        if (child.id) child.ownerDocument?.elementsById?.set(child.id, child);
        return child;
    }

    contains(node) {
        for (let current = node; current; current = current.parentElement) {
            if (current === this) return true;
        }
        return false;
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener;
    }

    removeEventListener(type, listener) {
        if (!listener || this.listeners[type] === listener) delete this.listeners[type];
    }

    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        }
        this.ownerDocument?.elementsById?.delete(this.id);
        this.parentElement = null;
    }

    closest(selector) {
        if (/^\[data-[^\]]+\]$/.test(selector)) {
            const attr = selector.slice(1, -1);
            if (this.attributes.has(attr)) return this;
        }
        return this.parentElement?.closest?.(selector) || null;
    }
}

function installMobileDom({ viewportWidth = 390 } = {}) {
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        Element: globalThis.Element,
        localStorage: globalThis.localStorage,
        SillyTavern: globalThis.SillyTavern,
    };
    const body = new MockElement('body');
    const documentMock = {
        elementsById: new Map(),
        body,
        documentElement: { clientWidth: viewportWidth },
        createElement(tagName) {
            const element = new MockElement(tagName);
            element.ownerDocument = this;
            return element;
        },
        getElementById(id) {
            return this.elementsById.get(id) || null;
        },
    };
    body.ownerDocument = documentMock;

    const storage = {
        failWrites: false,
        data: new Map(),
        getItem(key) {
            return this.data.has(key) ? this.data.get(key) : null;
        },
        setItem(key, value) {
            if (this.failWrites) throw new Error('storage blocked');
            this.data.set(key, String(value));
        },
        removeItem(key) {
            if (this.failWrites) throw new Error('storage blocked');
            this.data.delete(key);
        },
    };
    const mediaQuery = { matches: false, addEventListener() {}, removeEventListener() {} };
    const windowMock = {
        innerWidth: viewportWidth,
        matchMedia: () => mediaQuery,
        requestAnimationFrame: callback => callback(),
        addEventListener() {},
        removeEventListener() {},
    };

    globalThis.document = documentMock;
    globalThis.window = windowMock;
    globalThis.Element = MockElement;
    globalThis.localStorage = storage;

    return {
        storage,
        restore() {
            if (previous.document === undefined) delete globalThis.document;
            else globalThis.document = previous.document;
            if (previous.window === undefined) delete globalThis.window;
            else globalThis.window = previous.window;
            if (previous.Element === undefined) delete globalThis.Element;
            else globalThis.Element = previous.Element;
            if (previous.localStorage === undefined) delete globalThis.localStorage;
            else globalThis.localStorage = previous.localStorage;
            if (previous.SillyTavern === undefined) delete globalThis.SillyTavern;
            else globalThis.SillyTavern = previous.SillyTavern;
        },
    };
}

function modeClickTarget(root, mode) {
    const target = new MockElement('button');
    target.ownerDocument = root.ownerDocument;
    target.parentElement = root;
    target.setAttribute('data-dle-mobile-mode', mode);
    return target;
}

function commandClickTarget(root, command = '') {
    const target = new MockElement('button');
    target.ownerDocument = root.ownerDocument;
    target.parentElement = root;
    target.setAttribute('data-dle-mobile-command', command);
    return target;
}

function refreshClickTarget(root) {
    const target = new MockElement('button');
    target.ownerDocument = root.ownerDocument;
    target.parentElement = root;
    target.setAttribute('data-dle-mobile-refresh', '');
    return target;
}

function clickMobileRoot(root, target) {
    root.listeners.click?.({ target });
}

async function settleMobilePromises() {
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

test('shouldUseMobileUi: ST mobile flag enables mobile shell', () => {
    const result = shouldUseMobileUi({
        stMobile: true,
        viewportWidth: 1440,
        coarsePointer: false,
    });

    assertEqual(result, true, 'ST mobile devices should use the mobile shell');
});

test('shouldUseMobileUi: narrow viewport enables mobile shell for responsive ST layouts', () => {
    const result = shouldUseMobileUi({
        stMobile: false,
        viewportWidth: 640,
        coarsePointer: false,
    });

    assertEqual(result, true, 'narrow ST viewports should use the mobile shell');
});

test('shouldUseMobileUi: coarse pointer tablet enables mobile shell below tablet cap', () => {
    const result = shouldUseMobileUi({
        stMobile: false,
        viewportWidth: 900,
        coarsePointer: true,
    });

    assertEqual(result, true, 'coarse pointer tablets should use the mobile shell');
});

test('shouldUseMobileUi: desktop defaults to drawer UI', () => {
    const result = shouldUseMobileUi({
        stMobile: false,
        viewportWidth: 1280,
        coarsePointer: false,
    });

    assertEqual(result, false, 'desktop should keep the existing drawer UI');
});

test('normalizeMobilePreference: force and disable override automatic detection', () => {
    assertEqual(
        normalizeMobilePreference({ force: true, disabled: true }),
        'disabled',
        'disable should win over force when both are set',
    );
    assertEqual(
        normalizeMobilePreference({ force: true, disabled: false }),
        'forced',
        'force should mark the shell as forced',
    );
    assertEqual(
        normalizeMobilePreference({ force: false, disabled: false }),
        'auto',
        'no override should stay automatic',
    );
});

test('mobile detector constants: match CharacterLibrary-width shell contract', () => {
    assertEqual(MOBILE_VIEWPORT_WIDTH, 768, 'mobile shell should key off the 768px CharacterLibrary-style breakpoint');
    assertEqual(TOUCH_TABLET_WIDTH, 1024, 'coarse pointer tablet support should stop at 1024px');
    assertEqual(MOBILE_FORCE_STORAGE_KEY, 'dleMobileUiForce', 'force key should stay stable for browser overrides');
    assertEqual(MOBILE_DISABLE_STORAGE_KEY, 'dleMobileUiDisabled', 'disable key should stay stable for browser overrides');
});

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
        trace: {
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
    assertEqual(stats.ai.detail, '1 cached \u00b7 1.5k tokens', 'AI detail should include cache and token total');
    assertEqual(stats.health.value, 'Degraded', 'overall status should format as a label');
});

test('buildMobileStatusStats: ignores legacy pipeline-trace option name', () => {
    const legacyTraceKey = ['last', 'Pipeline', 'Trace'].join('');
    const stats = buildMobileStatusStats({
        injectedCount: 2,
        settings: {
            maxTokensBudget: 1000,
            unlimitedBudget: false,
            maxEntries: 10,
            unlimitedEntries: false,
        },
        [legacyTraceKey]: {
            totalTokens: 999,
            injected: Array.from({ length: 9 }, (_, idx) => ({ title: `Legacy ${idx}` })),
        },
    });

    assertEqual(stats.budget.value, '0 / 1.0k', 'legacy trace should not feed budget stats');
    assertEqual(stats.entries.value, '2 / 10', 'legacy trace should not override injected count');
});

test('buildMobileShellSnapshot: derives Injection state from current Verdict', () => {
    const trace = { gatedOut: [{ title: 'Filtered', reason: 'on cooldown' }] };
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [{ title: 'A' }, { title: 'B' }],
        indexing: false,
        generationLock: true,
        pipelinePhase: 'matching',
        verdict: {
            chatId: 'chat-a',
            msgIdx: 4,
            injectedSources: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
            trace,
        },
        loreGaps: [{ id: 'gap-1' }],
        indexEverLoaded: true,
    });

    assertEqual(snapshot.statusLabel, 'Working', 'active generation should show working status');
    assertEqual(snapshot.entriesLabel, '2 entries', 'vault count should be pluralized');
    assertEqual(snapshot.injectedCount, 3);
    assert(snapshot.trace === trace, 'snapshot should expose current Verdict trace');
    assertEqual(snapshot.gapCount, 1, 'lore gap count should be included');
});

test('buildMobileShellSnapshot: missing Verdict never reuses stale sources', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        verdict: null,
        loreGaps: [],
        indexEverLoaded: true,
    });

    assertEqual(snapshot.injectedSources.length, 0);
    assertEqual(snapshot.trace, null);
});

test('buildMobileShellSnapshot: reads chat metadata provider for Browse pin/block state', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [{ title: 'Cosplay Mode', vaultSource: 'First Vault' }],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        verdict: null,
        loreGaps: [],
        indexEverLoaded: true,
        chatMetadata: {
            deeplore_pins: [{ title: 'Cosplay Mode', vaultSource: 'First Vault' }],
            deeplore_blocks: [{ title: 'Keisha', vaultSource: 'First Vault' }],
        },
    });

    assertEqual(snapshot.browseContext.pins[0]?.title, 'Cosplay Mode', 'mobile Browse should use live ST metadata pins');
    assertEqual(snapshot.browseContext.blocks[0]?.title, 'Keisha', 'mobile Browse should use live ST metadata blocks');
});

test('renderMobileShell: renders glass overlay with tab bar and quick actions', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '12 entries',
        injectedCount: 2,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, createMobileUiState({ open: true, tab: 'injection' }));

    assertMatch(html, /id="dle-mobile-root"/, 'shell root should be rendered');
    assertMatch(html, /id="dle-mobile-overlay"/, 'glass overlay should be rendered');
    assertMatch(html, /class="dle-mobile-overlay-panel"/, 'overlay panel should be rendered');
    assertMatch(html, /data-dle-mobile-tab="injection"[^>]*aria-selected="true"/, 'injection tab should be selected');
    assertMatch(html, /data-dle-mobile-tab="browse"/, 'browse tab should be rendered');
    assertMatch(html, /data-dle-mobile-tab="filters"/, 'filters tab should be rendered');
    assertMatch(html, /data-dle-mobile-tab="librarian"/, 'librarian tab should be rendered');
    assertMatch(html, /data-dle-mobile-tab="tools"/, 'tools tab should be rendered');
    assertMatch(html, /data-dle-mobile-action="quick-reroll"/, 'quick-reroll action should be rendered');
    assertMatch(html, /data-dle-mobile-command="\/dle-scribe"/, 'scribe command button should be rendered');
});

test('renderMobileShell: labels the mobile injected-sources drill-in as Injection', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '12 entries',
        injectedCount: 1,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [{ title: 'Keisha', filename: 'Characters/Keisha.md', vaultSource: 'First Vault', matchedBy: 'keyword: keisha', tokens: 217 }],
        loreGaps: [],
    }, createMobileUiState({ open: true, tab: 'injection' }));

    assertMatch(html, />Injection</, 'tab bar should render Injection label');
    assertMatch(html, /data-dle-mobile-injection-action="copy-titles"/, 'injection toolbar should render copy-titles button');
    assertMatch(html, /aria-label="Open full Injection view"/, 'full-view button should use the desktop tab name');
    assert(!/<strong>Why\?<\/strong>/.test(html), 'mobile UI should not expose the old proof-of-concept Why label');
});

test('renderMobileShell: Injection rows expose Obsidian title and Browse navigation actions', () => {
    const key = 'First Vault:Keisha';
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '12 entries',
        injectedCount: 1,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [{
            title: 'Keisha',
            filename: 'Characters/Keisha.md',
            vaultSource: 'First Vault',
            matchedBy: 'keyword: keisha',
            tokens: 217,
        }],
        loreGaps: [],
    }, createMobileUiState({ open: true, tab: 'injection', injectionFilter: 'injected', injectionExpandedKey: key }));

    assertMatch(html, /data-dle-mobile-injection-action="obsidian"/, 'injected entry title should open Obsidian when a filename exists');
    assertMatch(html, /data-dle-mobile-injection-action="browse"/, 'injected entry row should expose a Browse navigation action');
    assertMatch(html, /217 tok/, 'injected entry row should show token metadata');
    assertMatch(html, /keyword: keisha/, 'injected entry row should show match metadata');
});

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
            ai: { label: 'AI', value: '2 calls', detail: '1 cached \u00b7 1.5k tokens', tone: 'ok' },
            health: { label: 'Health', value: 'Degraded', detail: 'Ready', tone: 'warn' },
        },
    };

    const collapsed = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection', statsExpanded: false }));
    assertMatch(collapsed, /data-dle-mobile-action="toggle-stats"[^>]*aria-expanded="false"/, 'tray toggle should be present and collapsed');
    assert(!/dle-mobile-status-grid/.test(collapsed), 'status grid should be hidden while collapsed');
    assert(!/2\.9k \/ 3\.1k/.test(collapsed), 'expanded budget value should be hidden while collapsed');

    const expanded = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection', statsExpanded: true }));
    assertMatch(expanded, /class="dle-mobile-status-grid"/, 'expanded status grid should render');
    assertMatch(expanded, /2\.9k \/ 3\.1k/, 'expanded budget value should render');
    assertMatch(expanded, /13\.5k \/ 200\.0k/, 'expanded context value should render');
    assertMatch(expanded, /1 cached \u00b7 1\.5k tokens/, 'expanded AI detail should render');
});

test('renderMobileShell: closed shell keeps overlay mounted and inert', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '0 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, createMobileUiState({ open: false }));

    assertMatch(html, /id="dle-mobile-overlay"/, 'overlay should remain mounted for animation and accessibility');
    assertMatch(html, /id="dle-mobile-overlay"[^>]*aria-hidden="true"/, 'closed overlay should be hidden from assistive tech');
    assertMatch(html, /id="dle-mobile-overlay"[^>]*inert/, 'closed overlay should not expose focusable controls');
    assert(!/dle-mobile-overlay dle-mobile-open/.test(html), 'overlay should not have open class while closed');
});

test('renderMobileShell: renders escaped error slot above active body', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '0 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, createMobileUiState({ open: true, tab: 'tools', errorMessage: '<Load failed>' }));

    assertMatch(html, /class="dle-mobile-error" role="alert"/, 'visible errors should render in an alert slot');
    assert(html.includes('&lt;Load failed&gt;'), 'error message should be escaped');
});

test('renderMobileShell: shows mobile error alert when command or refresh fails', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '0 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, createMobileUiState({ open: true, errorMessage: 'Command unavailable' }));

    assertMatch(html, /class="dle-mobile-error"/, 'error banner should render');
    assertMatch(html, /role="alert"/, 'error banner should announce itself');
    assertMatch(html, /Command unavailable/, 'error message should be visible');
});

test('renderMobileShell: tools view exposes mobile mode controls', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '3 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, createMobileUiState({ open: true, tab: 'tools', mode: 'forced' }));

    assertMatch(html, /data-dle-mobile-mode="auto"/, 'tools should offer auto mode');
    assertMatch(html, /data-dle-mobile-mode="forced"/, 'tools should offer force mobile mode');
    assertMatch(html, /data-dle-mobile-mode="disabled"/, 'tools should offer disable mobile mode');
    assertMatch(html, /class="dle-mobile-mode-group"[^>]*role="group"[^>]*aria-label="Mobile UI mode"/, 'mode controls should be exposed as a named group');
    assertMatch(html, /aria-pressed="true"[^>]*data-dle-mobile-mode="forced"|data-dle-mobile-mode="forced"[^>]*aria-pressed="true"/, 'current mode should be marked pressed');
    assertMatch(html, /aria-pressed="false"[^>]*data-dle-mobile-mode="auto"|data-dle-mobile-mode="auto"[^>]*aria-pressed="false"/, 'inactive auto mode should not be pressed');
    assertMatch(html, /aria-pressed="false"[^>]*data-dle-mobile-mode="disabled"|data-dle-mobile-mode="disabled"[^>]*aria-pressed="false"/, 'inactive disabled mode should not be pressed');
});

test('mobile mode handling: writes force and disable storage keys', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /function setMobileMode\(mode\)/, 'mobile shell should have a setMobileMode helper');
    assertMatch(source, /localStorage\.setItem\(MOBILE_FORCE_STORAGE_KEY,\s*'1'\)/, 'forced mode should set force key');
    assertMatch(source, /localStorage\.setItem\(MOBILE_DISABLE_STORAGE_KEY,\s*'1'\)/, 'disabled mode should set disable key');
    assertMatch(source, /localStorage\.removeItem\(MOBILE_FORCE_STORAGE_KEY\)/, 'auto mode should clear force key');
    assertMatch(source, /localStorage\.removeItem\(MOBILE_DISABLE_STORAGE_KEY\)/, 'auto mode should clear disable key');
    assertMatch(source, /target\.closest\('\[data-dle-mobile-mode\]'\)/, 'click handler should route mode buttons');
});

test('mobile shell commands: set visible errors when command execution is unavailable', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /function setMobileError\(message\)/, 'mobile shell should centralize visible errors');
    assertMatch(source, /setMobileError\(`Cannot execute \$\{command\}`\)/, 'missing command context should set a visible error');
    assertMatch(source, /Promise\.resolve\(\)[\s\S]*mobileShellOptions\.buildIndex\?\.\(\)[\s\S]*catch/m, 'refresh should catch sync and async buildIndex failures');
});


test('mobile mode handling: mode clicks update storage and shell state', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell();

        assert(root, 'mobile shell should create a root in a browser-like environment');
        assertEqual(root.hidden, false, 'narrow viewport should show the mobile shell');
        assert(document.body.classList.contains('dle-mobile-ui-active'), 'active mobile shell should set the body class');

        dom.storage.failWrites = true;
        clickMobileRoot(root, modeClickTarget(root, 'forced'));
        assertMatch(root.innerHTML, /Could not save mobile mode: storage blocked/, 'storage failures should surface a visible error');

        dom.storage.failWrites = false;
        clickMobileRoot(root, modeClickTarget(root, 'forced'));
        assertEqual(dom.storage.getItem(MOBILE_FORCE_STORAGE_KEY), '1', 'forced click should persist the force flag');
        assertEqual(dom.storage.getItem(MOBILE_DISABLE_STORAGE_KEY), null, 'forced click should clear the disable flag');
        assert(!/Could not save mobile mode/.test(root.innerHTML), 'successful mode save should clear a stale storage error');
        assertEqual(root.hidden, false, 'forced mode should keep the shell visible');

        clickMobileRoot(root, modeClickTarget(root, 'auto'));
        assertEqual(dom.storage.getItem(MOBILE_FORCE_STORAGE_KEY), null, 'auto click should clear the force flag');
        assertEqual(dom.storage.getItem(MOBILE_DISABLE_STORAGE_KEY), null, 'auto click should clear the disable flag');
        assertEqual(root.hidden, false, 'auto mode should remain visible on a narrow viewport');

        clickMobileRoot(root, modeClickTarget(root, 'disabled'));
        assertEqual(dom.storage.getItem(MOBILE_FORCE_STORAGE_KEY), null, 'disabled click should clear the force flag');
        assertEqual(dom.storage.getItem(MOBILE_DISABLE_STORAGE_KEY), '1', 'disabled click should persist the disable flag');
        assertEqual(root.hidden, true, 'disabled mode should hide the mobile shell');
        assert(!document.body.classList.contains('dle-mobile-ui-active'), 'disabled mode should clear the body active class');
    } finally {
        destroyMobileShell();
        dom.restore();
    }
});

test('mobile status tray: toggle click flips expanded state', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell();
        const target = new MockElement('button');
        target.ownerDocument = root.ownerDocument;
        target.parentElement = root;
        target.setAttribute('data-dle-mobile-action', 'toggle-stats');

        clickMobileRoot(root, target);
        assertMatch(root.innerHTML, /dle-mobile-status-grid/, 'first toggle should expand the status grid');

        clickMobileRoot(root, target);
        assert(!/dle-mobile-status-grid/.test(root.innerHTML), 'second toggle should collapse the status grid');
    } finally {
        destroyMobileShell();
        dom.restore();
    }
});

await testAsync('mobile shell commands: render runtime errors for missing command context and refresh rejection', async () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    const unhandledRejections = [];
    const captureUnhandled = error => unhandledRejections.push(error);
    const previousWarn = console.warn;
    const previousError = console.error;
    process.on('unhandledRejection', captureUnhandled);
    console.warn = () => {};
    console.error = (...args) => {
        if (String(args[0] || '').startsWith('[DLE]')) return;
        previousError(...args);
    };

    try {
        const root = createMobileShell({
            buildIndex: () => Promise.reject(new Error('vault offline')),
        });

        assert(root, 'mobile shell should create a root in a browser-like environment');

        clickMobileRoot(root, commandClickTarget(root, '/dle-health'));
        assertMatch(root.innerHTML, /class="dle-mobile-error" role="alert"/, 'missing command context should render an alert');
        assertMatch(root.innerHTML, /Cannot execute \/dle-health/, 'missing command context should show the failed command');

        clickMobileRoot(root, refreshClickTarget(root));
        await settleMobilePromises();

        assertMatch(root.innerHTML, /Refresh failed: vault offline/, 'refresh rejection should remain visible in the mobile shell');
        assertEqual(unhandledRejections.length, 0, 'refresh rejection should be handled');

        destroyMobileShell();
        const syncRoot = createMobileShell({
            buildIndex: () => {
                throw new Error('sync vault offline');
            },
        });
        let syncErrorEscaped = false;
        try {
            clickMobileRoot(syncRoot, refreshClickTarget(syncRoot));
        } catch {
            syncErrorEscaped = true;
        }
        await settleMobilePromises();

        assertEqual(syncErrorEscaped, false, 'synchronous refresh errors should not escape the click handler');
        assertMatch(syncRoot.innerHTML, /Refresh failed: sync vault offline/, 'synchronous refresh errors should remain visible in the mobile shell');
    } finally {
        console.warn = previousWarn;
        console.error = previousError;
        process.removeListener('unhandledRejection', captureUnhandled);
        destroyMobileShell();
        dom.restore();
    }
});

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
    const context = {
        chatInjectionCounts: new Map([['First Vault:Cosplay Mode', 2]]),
        injectedSources: [{ title: 'Cosplay Mode', vaultSource: 'First Vault' }],
        pins: [{ title: 'Mimic Mode', vaultSource: 'First Vault' }],
        blocks: [],
    };
    const result = filterMobileBrowseEntries(browseFixtureEntries, state, context);
    const rows = buildMobileBrowseRows(result.entries, context);

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

test('renderMobileShell: Browse view renders search, filters, quick filters, and cards', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '3 entries',
        injectedCount: 1,
        gapCount: 0,
        phaseLabel: 'idle',
        injectedSources: [{ title: 'Cosplay Mode', vaultSource: 'First Vault' }],
        entries: browseFixtureEntries,
        loreGaps: [],
        browseContext: {
            pins: [{ title: 'Mimic Mode', vaultSource: 'First Vault' }],
            blocks: [{ title: 'Keisha', vaultSource: 'First Vault' }],
            chatInjectionCounts: new Map([['First Vault:Cosplay Mode', 2]]),
        },
    }, createMobileUiState({
        open: true,
        tab: 'browse',
        statsExpanded: false,
        browse: normalizeMobileBrowseState({ query: 'mode', tag: 'mode' }),
        browseSearchHelpOpen: true,
        browseExpandedKey: 'First Vault:Cosplay Mode',
    }));

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

test('renderMobileShell: Browse cards expose visible pin and block states', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '3 entries',
        injectedCount: 1,
        gapCount: 0,
        phaseLabel: 'idle',
        injectedSources: [{ title: 'Cosplay Mode', vaultSource: 'First Vault' }],
        entries: browseFixtureEntries,
        loreGaps: [],
        browseContext: {
            pins: [{ title: 'Cosplay Mode', vaultSource: 'First Vault' }],
            blocks: [{ title: 'Keisha', vaultSource: 'First Vault' }],
            chatInjectionCounts: new Map(),
        },
    }, createMobileUiState({
        open: true,
        tab: 'browse',
        statsExpanded: false,
        browse: normalizeMobileBrowseState(),
        browseSearchHelpOpen: false,
        browseExpandedKey: '',
    }));

    assertMatch(html, /class="dle-mobile-browse-state-pill dle-mobile-browse-state-pin"[^>]*>Pinned</, 'pinned entries should show a visible state pill');
    assertMatch(html, /class="dle-mobile-browse-state-pill dle-mobile-browse-state-block"[^>]*>Blocked</, 'blocked entries should show a visible state pill');
    assertMatch(html, /aria-pressed="true"[^>]*>Pinned</, 'active pin button should use a visible active label');
    assertMatch(html, /aria-pressed="true"[^>]*>Blocked</, 'active block button should use a visible active label');
});

await testAsync('mobile Browse actions: Obsidian uses row vaultSource when settings are stale', async () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell({
            getSettings: () => ({ vaults: [{ name: 'Default Vault' }] }),
            getDrawerState: () => ({}),
        });
        const target = new MockElement('button');
        target.ownerDocument = root.ownerDocument;
        target.parentElement = root;
        target.setAttribute('data-dle-mobile-browse-action', 'obsidian');
        target.setAttribute('data-vault', 'Unlisted Vault');
        target.setAttribute('data-filename', 'Notes/Hidden.md');
        clickMobileRoot(root, target);
        await settleMobilePromises();
        const frame = globalThis.document.body.children.find(child => child.tagName === 'IFRAME');
        assert(frame, 'Obsidian open should append hidden iframe');
        assertEqual(frame.src, 'obsidian://open?vault=Unlisted%20Vault&file=Notes/Hidden');
    } finally {
        destroyMobileShell();
        dom.restore();
    }
});

test('mobile Browse actions: shell keeps ST metadata imports dynamic', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /async function toggleMobileBrowsePin/, 'pin action helper should exist');
    assertMatch(source, /async function toggleMobileBrowseBlock/, 'block action helper should exist');
    assertMatch(source, /await import\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/script\.js'\)/, 'ST script import should stay dynamic so Node mobile tests can import the shell');
    assertMatch(source, /notifyPinBlockChanged\(\)/, 'pin and block actions should notify DeepLore state observers');
    assertMatch(source, /navigator\.clipboard\.writeText/, 'copy action should use the clipboard when available');
    assertMatch(source, /openObsidianUri/, 'Obsidian action should use the shared Obsidian URI helper');
});

test('mobile Injection actions: Browse arrow reveals the selected Browse card', () => {
    const previous = [...vaultIndex];
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        setVaultIndex([{ title: 'Keisha', keys: ['keisha'], vaultSource: 'First Vault', summary: 'Selected character preview.', filename: 'Characters/Keisha.md' }]);
        const root = createMobileShell({
            getCurrentVerdict: () => ({ injectedSources: [{ title: 'Keisha', vaultSource: 'First Vault', filename: 'Characters/Keisha.md' }], trace: {} }),
            getSettings: () => ({}),
            getDrawerState: () => ({}),
        });
        const target = new MockElement('button');
        target.ownerDocument = root.ownerDocument;
        target.parentElement = root;
        target.setAttribute('data-dle-mobile-injection-action', 'browse');
        target.setAttribute('data-title', 'Keisha');
        target.setAttribute('data-vault', 'First Vault');
        clickMobileRoot(root, target);
        assertMatch(root.innerHTML, /data-dle-mobile-tab="browse" aria-selected="true"/, 'Browse tab should activate');
        assertMatch(root.innerHTML, /value="Keisha"/, 'Browse query should focus the selected title');
        assertMatch(root.innerHTML, /Selected character preview\./, 'selected Browse card should be expanded');
    } finally {
        setVaultIndex(previous);
        destroyMobileShell();
        dom.restore();
    }
});

test('mobile Injection actions: copy titles handles missing clipboard API', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
        const root = createMobileShell({
            getCurrentVerdict: () => ({
                injectedSources: [{ title: 'Keisha' }],
                trace: {},
            }),
            getSettings: () => ({}),
            getDrawerState: () => ({}),
        });
        const target = new MockElement('button');
        target.ownerDocument = root.ownerDocument;
        target.parentElement = root;
        target.setAttribute('data-dle-mobile-injection-action', 'copy-titles');
        clickMobileRoot(root, target);
        assertMatch(root.innerHTML, /Clipboard access denied\./, 'missing clipboard should render mobile error instead of throwing');
    } finally {
        destroyMobileShell();
        if (previousNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', previousNavigatorDescriptor);
        else delete globalThis.navigator;
        dom.restore();
    }
});

test('mobile Injection actions: shell routes entry titles and Browse arrows', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /data-dle-mobile-injection-action="obsidian"/, 'Injection title action should be rendered');
    assertMatch(source, /data-dle-mobile-injection-action="browse"/, 'Injection Browse arrow action should be rendered');
    assertMatch(source, /browseExpandedKey/, 'Injection Browse arrow should expand the selected Browse card');
});

test('renderMobileShell: drill-in views tolerate missing array fields', () => {
    for (const tab of ['injection', 'browse', 'filters', 'librarian', 'tools']) {
        try {
            const html = renderMobileShell({
                statusLabel: 'Ready',
                entriesLabel: '0 entries',
                injectedCount: 0,
                gapCount: 0,
                phaseLabel: 'idle',
            }, createMobileUiState({ open: true, tab }));

            assert(html.length > 0, `${tab} view should render without throwing`);
        } catch (error) {
            assert(false, `${tab} view should not throw with missing arrays: ${error.message}`);
        }
    }
});






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

test('mobile shell: no "Why?" label remains in mobile output', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        verdict: null,
        loreGaps: [],
        indexEverLoaded: true,
    });

    const overlayHtml = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection' }));
    assert(!overlayHtml.includes('>Why?<'), 'Overlay should not contain "Why?" label');
    assert(!overlayHtml.includes('>Why?</strong>'), 'Overlay should not contain "Why?" in strong tag');
    assertMatch(overlayHtml, /Injection/, 'Overlay should contain "Injection" label');
});

test('renderInjection: renders header with Injection title and badge', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        verdict: {
            injectedSources: [{ title: 'Keisha', tokens: 217, matchedBy: 'keyword' }],
            trace: { injected: [{ title: 'Keisha' }] },
        },
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection', injectionFilter: 'injected', injectionExpandedKey: '' }));

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
        verdict: {
            injectedSources: [{ title: 'Keisha', tokens: 217, matchedBy: 'keyword: keisha', vaultSource: 'TV', filename: 'Keisha.md' }],
            trace: { injected: [{ title: 'Keisha' }] },
        },
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection', injectionFilter: 'injected', injectionExpandedKey: '' }));

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
        verdict: null,
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection', injectionFilter: 'injected', injectionExpandedKey: '' }));

    assertMatch(html, /No entries injected yet/, 'should show empty state message');
});

test('renderInjection: renders Entry Timers section', () => {
    const snapshot = buildMobileShellSnapshot({
        vaultIndex: [],
        indexing: false,
        generationLock: false,
        pipelinePhase: 'idle',
        verdict: {
            injectedSources: [{ title: 'A', tokens: 100, matchedBy: 'keyword' }],
            trace: { injected: [{ title: 'A' }] },
        },
        loreGaps: [],
        indexEverLoaded: true,
    });

    const html = renderMobileShell(snapshot, createMobileUiState({ open: true, tab: 'injection', injectionFilter: 'injected', injectionExpandedKey: '' }));

    assertMatch(html, /Entry Timers/, 'should contain Entry Timers collapsible');
});

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




// ── Task 5: Tab switching behavior ──────────────────────────────────────────

test('destroyMobileShell: clears current Verdict provider references', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        createMobileShell({
            getCurrentVerdict: () => ({ injectedSources: [{ title: 'Stale provider' }], trace: {} }),
            getSettings: () => ({}),
            getDrawerState: () => ({}),
        });
        assertEqual(buildMobileShellSnapshot().injectedSources[0]?.title, 'Stale provider');
        destroyMobileShell();
        assertEqual(buildMobileShellSnapshot().injectedSources.length, 0, 'destroy should drop current Verdict provider');
    } finally {
        destroyMobileShell();
        dom.restore();
    }
});

test('mobile shell: tab clicks switch the active tab and keep overlay open', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell({ buildIndex: async () => {} });

        // Open the overlay first via the FAB onTap path (toggle action element)
        const openTarget = new MockElement('button');
        openTarget.ownerDocument = root.ownerDocument;
        openTarget.parentElement = root;
        openTarget.setAttribute('data-dle-mobile-action', 'toggle');
        clickMobileRoot(root, openTarget);

        // Now click the browse tab
        const browseTarget = new MockElement('button');
        browseTarget.ownerDocument = root.ownerDocument;
        browseTarget.parentElement = root;
        browseTarget.setAttribute('data-dle-mobile-tab', 'browse');
        clickMobileRoot(root, browseTarget);

        assertMatch(root.innerHTML, /data-dle-mobile-tab="browse" aria-selected="true"/, 'browse tab should activate on click');
        assertMatch(root.innerHTML, /dle-mobile-open/, 'overlay should stay open after tab switch');

        // Click the filters tab
        const filtersTarget = new MockElement('button');
        filtersTarget.ownerDocument = root.ownerDocument;
        filtersTarget.parentElement = root;
        filtersTarget.setAttribute('data-dle-mobile-tab', 'filters');
        clickMobileRoot(root, filtersTarget);

        assertMatch(root.innerHTML, /dle-mobile-filters-stub/, 'filters tab should render the stub');

        destroyMobileShell();
    } finally {
        dom.restore();
    }
});

test('mobile shell: open animation plays once, not on tab-switch re-renders', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        const root = createMobileShell({ buildIndex: async () => {} });

        const openTarget = new MockElement('button');
        openTarget.ownerDocument = root.ownerDocument;
        openTarget.parentElement = root;
        openTarget.setAttribute('data-dle-mobile-action', 'toggle');
        clickMobileRoot(root, openTarget);
        assertMatch(root.innerHTML, /dle-mobile-overlay-opening/, 'closed-to-open render should carry the open animation class');

        const browseTarget = new MockElement('button');
        browseTarget.ownerDocument = root.ownerDocument;
        browseTarget.parentElement = root;
        browseTarget.setAttribute('data-dle-mobile-tab', 'browse');
        clickMobileRoot(root, browseTarget);
        assert(!root.innerHTML.includes('dle-mobile-overlay-opening'), 'tab-switch re-render must not replay the open animation');
        assertMatch(root.innerHTML, /dle-mobile-tab-enter/, 'tab switch should animate only the content area');

        destroyMobileShell();
    } finally {
        dom.restore();
    }
});

// ── Task 6: Quick actions ────────────────────────────────────────────────────

test('mobile quick actions: skip librarian toggles suppression and pressed state', () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        setSuppressNextAgenticLoop(false);
        const root = createMobileShell({ buildIndex: async () => {} });

        const skipTarget = new MockElement('button');
        skipTarget.ownerDocument = root.ownerDocument;
        skipTarget.parentElement = root;
        skipTarget.setAttribute('data-dle-mobile-action', 'quick-skip-librarian');
        clickMobileRoot(root, skipTarget);

        assert(suppressNextAgenticLoop === true, 'skip click should suppress the next agentic loop');
        assertMatch(root.innerHTML, /data-dle-mobile-action="quick-skip-librarian" aria-pressed="true"/, 'button should show pressed state');

        clickMobileRoot(root, skipTarget);
        assert(suppressNextAgenticLoop === false, 'second click should re-enable');

        destroyMobileShell();
    } finally {
        setSuppressNextAgenticLoop(false);
        dom.restore();
    }
});

await testAsync('runMobileReroll: clears cache and injection log without clearing Verdict', async () => {
    const dom = installMobileDom({ viewportWidth: 390 });
    try {
        let cacheCleared = false;
        let metadataSaved = false;
        const trace = { injected: [{ title: 'Keep visible' }] };
        const verdict = { injectedSources: [{ title: 'Keep visible' }], trace };
        const chatMetadata = { deeplore_injection_log: [{ title: 'Old' }] };

        createMobileShell({
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
    } finally {
        destroyMobileShell();
        dom.restore();
    }
});

summary('Mobile UI foundation tests');
