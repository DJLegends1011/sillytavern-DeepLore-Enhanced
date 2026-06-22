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
    parseSafeAreaInsets,
    clampPosition,
    isDrag,
    loadPosition,
    savePosition,
    defaultPosition,
    resolveInitialPosition,
    resolveVisiblePosition,
    selectBottomObstructionTop,
    effectiveViewportHeight,
    renderFabHtml,
    shouldHideForStSurface,
    createFab,
    destroyFab,
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

section('FAB — Effective Viewport Height');

test('effectiveViewportHeight: no visualViewport falls back to innerHeight', () => {
    assertEqual(effectiveViewportHeight(915, null), 915);
    assertEqual(effectiveViewportHeight(915, undefined), 915);
    assertEqual(effectiveViewportHeight(915, { height: NaN }), 915);
});

test('effectiveViewportHeight: keyboard shrinks the visual viewport', () => {
    assertEqual(effectiveViewportHeight(915, { height: 460, offsetTop: 0 }), 460);
});

test('effectiveViewportHeight: panned visual viewport accounts for offsetTop', () => {
    assertEqual(effectiveViewportHeight(915, { height: 460, offsetTop: 100 }), 560);
});

test('effectiveViewportHeight: never exceeds the layout viewport', () => {
    assertEqual(effectiveViewportHeight(915, { height: 1000, offsetTop: 50 }), 915);
});

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

test('parseSafeAreaInsets: parses computed inset properties as non-negative pixels', () => {

    assertEqual(parseSafeAreaInsets({
        top: '10px',
        left: '20.5px',
        right: 'auto',
        bottom: '-3px',
    }), {
        top: 10,
        left: 20.5,
        right: 0,
        bottom: 0,
    });
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

test('defaultPosition: returns bottom-right desired viewport coordinates', () => {
    const pos = defaultPosition(390, 844, 700);
    assertEqual(pos.left, 390 - FAB_SIZE - EDGE_MARGIN);
    assertEqual(pos.top, 844 - FAB_SIZE - EDGE_MARGIN);
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
    assertLessThan(result.y + FAB_SIZE, 700, 'visible default should still stay above input bar');
});

test('resolveInitialPosition: clamps a saved position above a grown input bar', () => {
    mockStorage.clear();
    savePosition(300, 680);
    const result = resolveInitialPosition(390, 844, 620, {});
    assertLessThan(result.y + FAB_SIZE, 620, 'saved position should reclamp above input bar');
});

test('resolveVisiblePosition: restores bottom desired position after input shrinks', () => {
    const desired = { x: 330, y: 720 };
    const grownInput = resolveVisiblePosition(desired, 390, 844, 620, {});
    assertLessThan(grownInput.y + FAB_SIZE, 620, 'visible position should move above grown input');

    const collapsedInput = resolveVisiblePosition(desired, 390, 844, 780, {});
    assertEqual(collapsedInput.y, 720);
});

test('selectBottomObstructionTop: detects custom fixed bottom navigation bars', () => {
    const top = selectBottomObstructionTop([
        { top: 760, bottom: 844, width: 390, height: 84, position: 'fixed', display: 'flex', visibility: 'visible' },
    ], 390, 844);
    assertEqual(top, 760);
});

test('selectBottomObstructionTop: detects absolute bottom navigation inside custom shells', () => {
    const top = selectBottomObstructionTop([
        { top: 760, bottom: 844, width: 390, height: 84, position: 'absolute', display: 'flex', visibility: 'visible' },
    ], 390, 844);
    assertEqual(top, 760);
});

test('selectBottomObstructionTop: ignores small floating action buttons', () => {
    const top = selectBottomObstructionTop([
        { top: 705, bottom: 777, width: 72, height: 72, position: 'fixed', display: 'flex', visibility: 'visible' },
    ], 390, 844);
    assertEqual(top, null);
});

test('resolveVisiblePosition: clamps above detected custom bottom navigation', () => {
    const navTop = selectBottomObstructionTop([
        { top: 760, bottom: 844, width: 390, height: 84, position: 'fixed', display: 'flex', visibility: 'visible' },
    ], 390, 844);
    const result = resolveVisiblePosition({ x: 334, y: 788 }, 390, 844, navTop, {});
    assertLessThan(result.y + FAB_SIZE, 760, 'visible position should stay above custom bottom nav');
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

test('shouldHideForStSurface: hides when chat input bar is missing', () => {
    assert(shouldHideForStSurface({
        inputBarVisible: false,
        openDrawers: 0,
        openPopups: 0,
        shadowPopupVisible: false,
        extensionMenuVisible: false,
        optionMenusVisible: 0,
        customModalsVisible: 0,
    }), 'FAB should disappear on custom screens without the ST chat input bar');
});

test('shouldHideForStSurface: hides for CharacterLibrary embedded UX', () => {
    assert(shouldHideForStSurface({
        inputBarVisible: true,
        openDrawers: 0,
        openPopups: 0,
        shadowPopupVisible: false,
        extensionMenuVisible: false,
        optionMenusVisible: 0,
        customModalsVisible: 0,
        characterLibraryEmbeddedVisible: true,
    }), 'CharacterLibrary embedded panel should hide the DeepLore FAB even when ST input still exists');
});

test('shouldHideForStSurface: remains visible when chat input bar is present', () => {
    assert(!shouldHideForStSurface({
        inputBarVisible: true,
        openDrawers: 0,
        openPopups: 0,
        shadowPopupVisible: false,
        extensionMenuVisible: false,
        optionMenusVisible: 0,
        customModalsVisible: 0,
    }), 'visible ST chat input bar should allow the FAB when no overlays are open');
});

function makeVisibleElement(rect = {}) {
    const listeners = new Map();
    return {
        hidden: false,
        open: false,
        style: {},
        children: [],
        attributes: new Map(),
        className: '',
        innerHTML: '',
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        remove() {
            if (!this.parentNode) return;
            this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
            this.parentNode = null;
        },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event) {
            for (const listener of listeners.get(event.type) || []) listener(event);
        },
        setPointerCapture() {},
        releasePointerCapture() {},
        closest() { return null; },
        getBoundingClientRect() {
            return {
                top: 700,
                bottom: 744,
                width: 390,
                height: 44,
                ...rect,
            };
        },
    };
}

function withCharacterLibraryDom({
    launcherVisible = false,
    embeddedVisible = false,
    safeInsets = {},
    queueAnimationFrames = false,
}, callback) {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const formSheld = makeVisibleElement({ top: 700, bottom: 744, width: 390, height: 44 });
    const launcher = makeVisibleElement({ top: 80, bottom: 160, width: 220, height: 80 });
    const embedded = makeVisibleElement({ top: 0, bottom: 844, width: 390, height: 844 });
    const body = makeVisibleElement({ top: 0, bottom: 844, width: 390, height: 844 });
    const documentElement = makeVisibleElement({ top: 0, bottom: 844, width: 390, height: 844 });
    const windowListeners = new Map();
    const rafCallbacks = new Map();
    const cancelledRafIds = new Set();
    let nextRafId = 1;

    globalThis.window = {
        innerWidth: 390,
        innerHeight: 844,
        addEventListener(type, listener) {
            if (!windowListeners.has(type)) windowListeners.set(type, new Set());
            windowListeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            windowListeners.get(type)?.delete(listener);
        },
        dispatchEvent(event) {
            for (const listener of windowListeners.get(event.type) || []) listener(event);
        },
    };
    globalThis.requestAnimationFrame = (callback) => {
        const id = nextRafId++;
        if (queueAnimationFrames) rafCallbacks.set(id, callback);
        else callback();
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
        cancelledRafIds.add(id);
        rafCallbacks.delete(id);
    };
    globalThis.getComputedStyle = (el) => {
        const isSafeAreaProbe = String(el?.style?.cssText || '').includes('safe-area-inset');
        return {
            display: el?.style?.display || 'block',
            visibility: el?.style?.visibility || 'visible',
            position: el?.style?.position || 'fixed',
            opacity: el?.style?.opacity || '1',
            paddingTop: isSafeAreaProbe ? `${safeInsets.top || 0}px` : '0px',
            paddingLeft: isSafeAreaProbe ? `${safeInsets.left || 0}px` : '0px',
            paddingRight: isSafeAreaProbe ? `${safeInsets.right || 0}px` : '0px',
            paddingBottom: isSafeAreaProbe ? `${safeInsets.bottom || 0}px` : '0px',
            top: isSafeAreaProbe ? `${safeInsets.top || 0}px` : (el?.style?.top || 'auto'),
            left: isSafeAreaProbe ? `${safeInsets.left || 0}px` : (el?.style?.left || 'auto'),
            right: isSafeAreaProbe ? `${safeInsets.right || 0}px` : (el?.style?.right || 'auto'),
            bottom: isSafeAreaProbe ? `${safeInsets.bottom || 0}px` : (el?.style?.bottom || 'auto'),
            getPropertyValue(property) { return this[property] || ''; },
        };
    };
    globalThis.document = {
        body,
        documentElement,
        createElement: () => makeVisibleElement({ top: 0, bottom: 44, width: FAB_SIZE, height: FAB_SIZE }),
        getElementById(id) {
            if (id === 'form_sheld') return formSheld;
            return null;
        },
        querySelector(selector) {
            if (selector === '#charlib-launcher-dropdown.visible' && launcherVisible) return launcher;
            if (selector === '#charlib-embedded-container' && embeddedVisible) return embedded;
            return null;
        },
        querySelectorAll() {
            return [];
        },
    };

    try {
        return callback({
            window: globalThis.window,
            document: globalThis.document,
            raf: {
                pendingIds: () => [...rafCallbacks.keys()],
                wasCancelled: (id) => cancelledRafIds.has(id),
            },
        });
    } finally {
        destroyFab();
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.getComputedStyle = previousGetComputedStyle;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
}

test('createFab: drag settling snaps to the nearest safe edge and preserves clamped Y', () => {
    mockStorage.clear();
    withCharacterLibraryDom({ safeInsets: { top: 10, left: 20, right: 8, bottom: 4 } }, ({ window }) => {
        const wrapper = createFab();
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });
        window.dispatchEvent({
            type: 'pointermove',
            pointerId: 1,
            clientX: 120,
            clientY: 300,
            preventDefault() {},
        });
        window.dispatchEvent({ type: 'pointerup', pointerId: 1 });

        assertEqual(loadPosition(), { left: EDGE_MARGIN + 20, top: 284 },
            'settled drag should persist the snapped X and unchanged clamped Y');
    });
});

test('createFab: release before queued drag frame settles from the latest pointer position', () => {
    mockStorage.clear();
    withCharacterLibraryDom({
        safeInsets: { top: 10, left: 20, right: 8, bottom: 4 },
        queueAnimationFrames: true,
    }, ({ window, raf }) => {
        const wrapper = createFab();
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });
        window.dispatchEvent({
            type: 'pointermove',
            pointerId: 1,
            clientX: 120,
            clientY: 300,
            preventDefault() {},
        });
        const [queuedDragFrame] = raf.pendingIds();
        window.dispatchEvent({ type: 'pointerup', pointerId: 1 });

        assert(raf.wasCancelled(queuedDragFrame), 'release should cancel the queued drag frame');
        assertEqual(loadPosition(), { left: EDGE_MARGIN + 20, top: 284 },
            'settling should persist the edge and Y from the latest pointer position');
    });
});

test('destroyFab: cancels an active drag animation frame', () => {
    withCharacterLibraryDom({ queueAnimationFrames: true }, ({ window, raf }) => {
        const wrapper = createFab();
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });
        window.dispatchEvent({
            type: 'pointermove',
            pointerId: 1,
            clientX: 120,
            clientY: 300,
            preventDefault() {},
        });
        const [queuedDragFrame] = raf.pendingIds();

        destroyFab();

        assert(raf.wasCancelled(queuedDragFrame), 'destroy should cancel the active drag frame');
        assertEqual(raf.pendingIds(), [], 'destroy should leave no queued drag frame');
    });
});

test('createFab: pointer cancellation never invokes the tap callback', () => {
    let tapCount = 0;
    withCharacterLibraryDom({}, ({ window }) => {
        const wrapper = createFab({ onTap: () => { tapCount += 1; } });
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });
        window.dispatchEvent({ type: 'pointercancel', pointerId: 1 });

        assertEqual(tapCount, 0, 'pointercancel should clean up without acting as a tap');
    });
});

test('createFab: mismatched pointer end events do not settle or end the active drag', () => {
    mockStorage.clear();
    withCharacterLibraryDom({ queueAnimationFrames: true }, ({ window, raf }) => {
        const wrapper = createFab();
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });
        window.dispatchEvent({
            type: 'pointermove',
            pointerId: 1,
            clientX: 120,
            clientY: 300,
            preventDefault() {},
        });
        const [queuedDragFrame] = raf.pendingIds();

        window.dispatchEvent({ type: 'pointerup', pointerId: 2 });
        window.dispatchEvent({ type: 'pointercancel', pointerId: 2 });

        assert(!raf.wasCancelled(queuedDragFrame), 'another pointer should not cancel the active drag frame');
        assertEqual(loadPosition(), null, 'another pointer should not settle the active drag');

        window.dispatchEvent({ type: 'pointerup', pointerId: 1 });

        assert(raf.wasCancelled(queuedDragFrame), 'the owning pointer should still end the active drag');
        assertEqual(loadPosition(), { left: EDGE_MARGIN, top: 284 },
            'the owning pointer should settle the original drag');
    });
});

test('createFab: mismatched pointer end events do not tap or end the active press', () => {
    let tapCount = 0;
    withCharacterLibraryDom({}, ({ window }) => {
        const wrapper = createFab({ onTap: () => { tapCount += 1; } });
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });

        window.dispatchEvent({ type: 'pointerup', pointerId: 2 });
        window.dispatchEvent({ type: 'pointercancel', pointerId: 2 });

        assertEqual(tapCount, 0, 'another pointer should not invoke the tap callback');

        window.dispatchEvent({ type: 'pointerup', pointerId: 1 });

        assertEqual(tapCount, 1, 'the owning pointer should still complete the active tap');
    });
});

test('createFab: ignores a second pointerdown while a gesture is active', () => {
    mockStorage.clear();
    let tapCount = 0;
    withCharacterLibraryDom({}, ({ window }) => {
        const wrapper = createFab({ onTap: () => { tapCount += 1; } });
        const button = wrapper.children[0];

        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 1,
            pointerType: 'touch',
            clientX: 342,
            clientY: 660,
        });
        button.dispatchEvent({
            type: 'pointerdown',
            pointerId: 2,
            pointerType: 'touch',
            clientX: 40,
            clientY: 80,
        });
        window.dispatchEvent({
            type: 'pointermove',
            pointerId: 1,
            clientX: 120,
            clientY: 300,
            preventDefault() {},
        });
        window.dispatchEvent({ type: 'pointerup', pointerId: 1 });

        assertEqual(tapCount, 0, 'the second pointer should not replace the active drag with a tap');
        assertEqual(loadPosition(), { left: EDGE_MARGIN, top: 284 },
            'the first pointer should retain ownership of the gesture');
    });
});

test('createFab: remains visible for CharacterLibrary launcher picker', () => {
    withCharacterLibraryDom({ launcherVisible: true }, () => {
        const wrapper = createFab();
        const button = wrapper.children[0];
        assertEqual(wrapper.style.opacity, '1');
        assertEqual(wrapper.style.pointerEvents, 'auto');
        assertEqual(button.style.pointerEvents, 'auto');
        assertEqual(button.disabled, false);
        assertEqual(button.getAttribute('aria-hidden'), 'false');
    });
});

test('createFab: hides for CharacterLibrary embedded panel', () => {
    withCharacterLibraryDom({ embeddedVisible: true }, () => {
        const wrapper = createFab();
        const button = wrapper.children[0];
        assertEqual(wrapper.style.opacity, '0');
        assertEqual(wrapper.style.pointerEvents, 'none');
        assertEqual(button.style.pointerEvents, 'none');
        assertEqual(button.disabled, true);
        assertEqual(button.getAttribute('aria-hidden'), 'true');
    });
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
