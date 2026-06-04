/**
 * DeepLore Enhanced — Mobile FAB unit tests.
 * Run with: node test/mobile-fab.test.mjs
 */

import {
    assert,
    assertEqual,
    assertLessThan,
    test,
    section,
    summary,
} from './helpers.mjs';

import {
    computeEdgeSnap,
    computeSnapX,
    clampPosition,
    isDrag,
    loadPosition,
    savePosition,
    defaultPosition,
    resolveInitialPosition,
    renderFabHtml,
    shouldHideForStSurface,
    FAB_SIZE,
    DRAG_THRESHOLD,
    EDGE_MARGIN,
    STORAGE_KEY,
} from '../src/mobile/mobile-fab.js';

// Mock localStorage
const mockStorage = new Map();
globalThis.localStorage = {
    getItem(key) { return mockStorage.get(key) ?? null; },
    setItem(key, value) { mockStorage.set(key, String(value)); },
    removeItem(key) { mockStorage.delete(key); },
    clear() { mockStorage.clear(); },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

section('FAB — Edge Snap Calculation');

test('computeEdgeSnap: left side of viewport → left', () => {
    assertEqual(computeEdgeSnap(50, 390), 'left');
});

test('computeEdgeSnap: right side of viewport → right', () => {
    assertEqual(computeEdgeSnap(300, 390), 'right');
});

test('computeEdgeSnap: exact midpoint → right (>= midpoint)', () => {
    const vw = 400;
    const x = vw / 2 - FAB_SIZE / 2;
    assertEqual(computeEdgeSnap(x, vw), 'right');
});

test('computeSnapX: left edge returns margin', () => {
    assertEqual(computeSnapX('left', 390, 0, 0), EDGE_MARGIN);
});

test('computeSnapX: right edge returns viewport - size - margin', () => {
    assertEqual(computeSnapX('right', 390, 0, 0), 390 - FAB_SIZE - EDGE_MARGIN);
});

test('computeSnapX: respects safe area insets', () => {
    assertEqual(computeSnapX('left', 390, 20, 0), EDGE_MARGIN + 20);
    assertEqual(computeSnapX('right', 390, 0, 15), 390 - FAB_SIZE - EDGE_MARGIN - 15);
});

section('FAB — Tap vs Drag Threshold');

test('isDrag: zero movement is not a drag', () => {
    assert(!isDrag(100, 200, 100, 200), 'zero movement should not be drag');
});

test('isDrag: movement under threshold is not a drag', () => {
    assert(!isDrag(100, 200, 105, 203), '~6px movement should not be drag');
});

test('isDrag: movement at threshold IS a drag', () => {
    assert(isDrag(100, 200, 108, 200), '8px horizontal should be drag');
});

test('isDrag: movement over threshold is a drag', () => {
    assert(isDrag(100, 200, 120, 215), 'large movement should be drag');
});

test('isDrag: diagonal movement under threshold is not a drag', () => {
    assert(!isDrag(0, 0, 5, 5), '~7px diagonal should not be drag');
});

test('isDrag: diagonal movement at threshold IS a drag', () => {
    assert(isDrag(0, 0, 6, 6), '~8.5px diagonal should be drag');
});

section('FAB — Position Clamping (Input Area Exclusion)');

test('clampPosition: y below input bar is clamped up', () => {
    const inputBarTop = 700;
    const result = clampPosition(50, 680, 390, 844, inputBarTop);
    assertLessThan(result.y + FAB_SIZE, inputBarTop,
        'FAB bottom edge must stay above input bar');
});

test('clampPosition: x is clamped within viewport', () => {
    const result = clampPosition(-10, 200, 390, 844, 700);
    assertEqual(result.x, EDGE_MARGIN);
});

test('clampPosition: x above max is clamped', () => {
    const result = clampPosition(400, 200, 390, 844, 700);
    assertEqual(result.x, 390 - FAB_SIZE - EDGE_MARGIN);
});

test('clampPosition: y above top is clamped', () => {
    const result = clampPosition(50, -5, 390, 844, 700);
    assertEqual(result.y, EDGE_MARGIN);
});

test('clampPosition: safe area insets reduce bounds', () => {
    const result = clampPosition(5, 5, 390, 844, 700, { top: 44, left: 10, right: 10 });
    assertEqual(result.x, EDGE_MARGIN + 10);
    assertEqual(result.y, EDGE_MARGIN + 44);
});

test('clampPosition: normal position is unchanged', () => {
    const result = clampPosition(100, 300, 390, 844, 700);
    assertEqual(result.x, 100);
    assertEqual(result.y, 300);
});

section('FAB — Position Persistence');

test('savePosition + loadPosition round-trip with absolute viewport coordinates', () => {
    mockStorage.clear();
    savePosition(123, 456);
    const loaded = loadPosition();
    assertEqual(loaded, { left: 123, top: 456 });
});

test('loadPosition: empty storage returns null', () => {
    mockStorage.clear();
    assertEqual(loadPosition(), null);
});

test('loadPosition: corrupted JSON returns null', () => {
    mockStorage.clear();
    mockStorage.set(STORAGE_KEY, '{not valid json');
    assertEqual(loadPosition(), null);
});

test('loadPosition: legacy edge-snap storage returns null', () => {
    mockStorage.clear();
    mockStorage.set(STORAGE_KEY, JSON.stringify({ edge: 'right', y: 0.5 }));
    assertEqual(loadPosition(), null);
});

test('loadPosition: missing absolute coordinate returns null', () => {
    mockStorage.clear();
    mockStorage.set(STORAGE_KEY, JSON.stringify({ left: 120 }));
    assertEqual(loadPosition(), null);
});

test('defaultPosition: returns absolute viewport coordinates above the input bar', () => {
    const pos = defaultPosition(390, 844, 700);
    assertEqual(pos.left, 390 - FAB_SIZE - EDGE_MARGIN);
    assertLessThan(pos.top + FAB_SIZE, 700, 'default bottom edge should stay above input bar');
});

section('FAB — resolveInitialPosition');

test('resolveInitialPosition: uses saved position', () => {
    mockStorage.clear();
    savePosition(80, 300);
    const result = resolveInitialPosition(390, 844, 700, {});
    assertEqual(result.x, 80);
    assertEqual(result.y, 300);
});

test('resolveInitialPosition: falls back to default when no saved', () => {
    mockStorage.clear();
    const result = resolveInitialPosition(390, 844, 700, {});
    assertEqual(result.x, 390 - FAB_SIZE - EDGE_MARGIN);
});

test('resolveInitialPosition: clamps a saved position above a grown input bar', () => {
    mockStorage.clear();
    savePosition(300, 680);
    const result = resolveInitialPosition(390, 844, 620, {});
    assertLessThan(result.y + FAB_SIZE, 620, 'saved position should reclamp above input bar');
});

section('FAB — ST Surface Visibility');

test('shouldHideForStSurface: hides for open drawers', () => {
    assert(shouldHideForStSurface({
        openDrawers: 1,
        openPopups: 0,
        shadowPopupVisible: false,
        extensionMenuVisible: false,
        optionMenusVisible: 0,
    }), 'open ST drawer should hide FAB');
});

test('shouldHideForStSurface: hides for extension menus and custom option menus', () => {
    assert(shouldHideForStSurface({
        openDrawers: 0,
        openPopups: 0,
        shadowPopupVisible: false,
        extensionMenuVisible: true,
        optionMenusVisible: 0,
    }), 'visible extension menu should hide FAB');
    assert(shouldHideForStSurface({
        openDrawers: 0,
        openPopups: 0,
        shadowPopupVisible: false,
        extensionMenuVisible: false,
        optionMenusVisible: 2,
    }), 'visible custom option menu should hide FAB');
});

section('FAB — Badge Rendering');

test('renderFabHtml: no badge when count is 0', () => {
    const html = renderFabHtml(0);
    assert(!html.includes('dle-mobile-fab__badge'), 'should not have badge');
});

test('renderFabHtml: shows count when > 0', () => {
    const html = renderFabHtml(5);
    assert(html.includes('dle-mobile-fab__badge'), 'should have badge');
    assert(html.includes('>5<'), 'should show count 5');
});

test('renderFabHtml: caps at 99+', () => {
    const html = renderFabHtml(150);
    assert(html.includes('>99+<'), 'should show 99+');
});

test('renderFabHtml: shows 99 for exactly 99', () => {
    const html = renderFabHtml(99);
    assert(html.includes('>99<'), 'should show 99');
});

test('renderFabHtml: shows 1 for count of 1', () => {
    const html = renderFabHtml(1);
    assert(html.includes('>1<'), 'should show 1');
});

// ─── Summary ────────────────────────────────────────────────────────────────

summary('Mobile FAB Tests');
