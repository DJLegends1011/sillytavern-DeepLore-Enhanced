const FAB_SIZE = 44;
const DRAG_THRESHOLD = 8;
const SNAP_DURATION = 200;
const EDGE_MARGIN = 12;
const STORAGE_KEY = 'dleMobileFabPosition';

export { FAB_SIZE, DRAG_THRESHOLD, EDGE_MARGIN, STORAGE_KEY };

// Pure helpers (testable without DOM)

export function computeEdgeSnap(x, viewportWidth) {
    const midpoint = viewportWidth / 2;
    return x + FAB_SIZE / 2 < midpoint ? 'left' : 'right';
}

export function computeSnapX(edge, viewportWidth, safeLeft = 0, safeRight = 0) {
    if (edge === 'left') return EDGE_MARGIN + safeLeft;
    return viewportWidth - FAB_SIZE - EDGE_MARGIN - safeRight;
}

function parseCssPixels(value) {
    const parsed = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function parseSafeAreaInsets(insets = {}) {
    return {
        top: parseCssPixels(insets.top),
        left: parseCssPixels(insets.left),
        right: parseCssPixels(insets.right),
        bottom: parseCssPixels(insets.bottom),
    };
}

export function clampPosition(x, y, viewportWidth, viewportHeight, inputBarTop = viewportHeight, safeInsets = {}) {
    const safeTop = safeInsets.top || 0;
    const safeLeft = safeInsets.left || 0;
    const safeRight = safeInsets.right || 0;
    const safeBottom = safeInsets.bottom || 0;

    const minX = EDGE_MARGIN + safeLeft;
    const maxX = viewportWidth - FAB_SIZE - EDGE_MARGIN - safeRight;
    const minY = EDGE_MARGIN + safeTop;
    const viewportMaxY = viewportHeight - FAB_SIZE - EDGE_MARGIN - safeBottom;
    const inputMaxY = Number.isFinite(inputBarTop) ? inputBarTop - FAB_SIZE - EDGE_MARGIN : viewportMaxY;
    const maxY = Math.max(minY, Math.min(viewportMaxY, inputMaxY));

    return {
        x: Math.max(minX, Math.min(maxX, x)),
        y: Math.max(minY, Math.min(maxY, y)),
    };
}

export function isDrag(startX, startY, currentX, currentY) {
    const dx = currentX - startX;
    const dy = currentY - startY;
    return Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD;
}

export function loadPosition() {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
            return parsed;
        }
    } catch { /* corrupted data */ }
    return null;
}

export function savePosition(left, top) {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ left, top }));
    } catch { /* storage full or unavailable */ }
}

export function defaultPosition(viewportWidth = 390, viewportHeight = 844, _inputBarTop = viewportHeight, safeInsets = {}) {
    const x = viewportWidth - FAB_SIZE - EDGE_MARGIN - (safeInsets.right || 0);
    const y = viewportHeight - FAB_SIZE - EDGE_MARGIN - (safeInsets.bottom || 0);
    const clamped = clampPosition(x, y, viewportWidth, viewportHeight, viewportHeight, safeInsets);
    return { left: clamped.x, top: clamped.y };
}

export function resolveVisiblePosition(desiredPosition, viewportWidth, viewportHeight, inputBarTop, safeInsets = {}) {
    const desiredX = Number.isFinite(desiredPosition?.x) ? desiredPosition.x : desiredPosition?.left;
    const desiredY = Number.isFinite(desiredPosition?.y) ? desiredPosition.y : desiredPosition?.top;
    const pos = Number.isFinite(desiredX) && Number.isFinite(desiredY)
        ? { left: desiredX, top: desiredY }
        : defaultPosition(viewportWidth, viewportHeight, inputBarTop, safeInsets);
    const clamped = clampPosition(pos.left, pos.top, viewportWidth, viewportHeight, inputBarTop, safeInsets);
    return { x: clamped.x, y: clamped.y };
}

export function resolveInitialPosition(viewportWidth, viewportHeight, inputBarTop, safeInsets = {}) {
    const saved = loadPosition();
    const pos = saved || defaultPosition(viewportWidth, viewportHeight, inputBarTop, safeInsets);
    return resolveVisiblePosition(pos, viewportWidth, viewportHeight, inputBarTop, safeInsets);
}

export function effectiveViewportHeight(innerHeight, visualViewport) {
    // Android's on-screen keyboard in resizes-visual mode shrinks only the
    // visual viewport — window.innerHeight stays full, so clamping against it
    // leaves the FAB buried under the keyboard.
    if (!visualViewport || !Number.isFinite(visualViewport.height)) return innerHeight;
    const visibleBottom = Math.round((visualViewport.offsetTop || 0) + visualViewport.height);
    return Math.min(innerHeight, visibleBottom);
}

function getViewportSize() {
    const innerH = window.innerHeight || 844;
    return {
        vw: window.innerWidth || 390,
        vh: effectiveViewportHeight(innerH, window.visualViewport),
    };
}

export function selectBottomObstructionTop(candidates = [], viewportWidth = 390, viewportHeight = 844) {
    const minWidth = Math.max(160, viewportWidth * 0.45);
    const minTop = viewportHeight * 0.55;
    const maxHeight = Math.max(140, viewportHeight * 0.35);
    const bottomTolerance = 24;
    let top = null;

    for (const candidate of candidates) {
        if (candidate?.excluded) continue;

        const rectTop = Number(candidate?.top);
        const rectBottom = Number(candidate?.bottom);
        const width = Number(candidate?.width);
        const height = Number(candidate?.height);
        const position = String(candidate?.position || '').toLowerCase();
        const display = String(candidate?.display || '').toLowerCase();
        const visibility = String(candidate?.visibility || '').toLowerCase();
        const opacity = String(candidate?.opacity ?? '1');

        if (!['absolute', 'fixed', 'sticky'].includes(position)) continue;
        if (display === 'none' || visibility === 'hidden' || Number(opacity) === 0) continue;
        if (![rectTop, rectBottom, width, height].every(Number.isFinite)) continue;
        if (width < minWidth || height < 32 || height > maxHeight) continue;
        if (rectTop < minTop) continue;
        if (rectBottom < viewportHeight - bottomTolerance || rectBottom > viewportHeight + bottomTolerance) continue;

        top = top == null ? rectTop : Math.min(top, rectTop);
    }

    return top;
}

export function shouldHideForStSurface(surfaceState = {}) {
    return Boolean(
        surfaceState.inputBarVisible === false
        || surfaceState.openDrawers > 0
        || surfaceState.openPopups > 0
        || surfaceState.shadowPopupVisible
        || surfaceState.extensionMenuVisible
        || surfaceState.characterLibraryEmbeddedVisible
        || surfaceState.optionMenusVisible > 0
        || surfaceState.customModalsVisible > 0
    );
}

export function renderFabHtml(injectionCount = 0) {
    const badgeHtml = injectionCount > 0
        ? `<span class="dle-mobile-fab__badge">${injectionCount > 99 ? '99+' : injectionCount}</span>`
        : '';
    return `<button class="dle-mobile-fab" type="button" aria-label="Open DeepLore panel" touch-action="none">
    <i class="fa-solid fa-book-open" aria-hidden="true"></i>${badgeHtml}
</button>`;
}

// DOM-coupled FAB (browser only)

let fabEl = null;
let fabWrapper = null;
let badgeEl = null;
let dragState = null;
let onTapCallback = null;
let currentPosition = { x: 0, y: 0 };
let desiredPosition = { x: 0, y: 0 };
let reclampRafId = null;
let viewportResizeHandler = null;
let inputResizeObserver = null;
let overlayObserver = null;
let overlayRafId = null;
let safeAreaProbe = null;
let inputBarEl = null;
let inputTextEl = null;
let desiredVisible = true;

const BOTTOM_OBSTRUCTION_SELECTOR = [
    'nav',
    'footer',
    '[role="navigation"]',
    '[class*="nav"]',
    '[class*="Nav"]',
    '[class*="tab"]',
    '[class*="Tab"]',
    '[class*="dock"]',
    '[class*="Dock"]',
    '[class*="bar"]',
    '[class*="Bar"]',
    '[class*="bottom"]',
    '[class*="Bottom"]',
    '[id*="nav"]',
    '[id*="Nav"]',
    '[id*="tab"]',
    '[id*="Tab"]',
    '[id*="dock"]',
    '[id*="Dock"]',
    '[id*="bar"]',
    '[id*="Bar"]',
    '[id*="bottom"]',
    '[id*="Bottom"]',
].join(',');

function isOwnUiElement(el) {
    return Boolean(el?.closest?.('#dle-mobile-root, .dle-mobile-fab-anchor, .dle-mobile-fab, .stwii--trigger'));
}

function readBottomObstructionCandidates(viewportWidth, viewportHeight) {
    try {
        if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return [];
        return Array.from(document.querySelectorAll(BOTTOM_OBSTRUCTION_SELECTOR)).map((el) => {
            const rect = el.getBoundingClientRect?.();
            const style = getComputedStyle(el);
            return {
                top: rect?.top,
                bottom: rect?.bottom,
                width: rect?.width,
                height: rect?.height,
                position: style.position,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                excluded: isOwnUiElement(el)
                    || rect?.bottom < viewportHeight * 0.55
                    || rect?.width > viewportWidth * 1.2,
            };
        });
    } catch {
        return [];
    }
}

function getInputBarTop() {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 390 : 390;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight || 844 : 844;
    const tops = [];

    try {
        const formSheld = document.getElementById('form_sheld');
        if (formSheld?.getBoundingClientRect && isElementVisible(formSheld)) {
            const rect = formSheld.getBoundingClientRect();
            if (Number.isFinite(rect.top) && rect.top >= 0 && rect.top < viewportHeight) {
                tops.push(rect.top);
            }
        }
    } catch { /* test environment */ }

    const customBottomTop = selectBottomObstructionTop(
        readBottomObstructionCandidates(viewportWidth, viewportHeight),
        viewportWidth,
        viewportHeight,
    );
    if (Number.isFinite(customBottomTop)) tops.push(customBottomTop);

    return tops.length ? Math.min(...tops) : viewportHeight;
}

function getSafeAreaProbe() {
    if (safeAreaProbe) return safeAreaProbe;
    if (typeof document === 'undefined') return null;

    const parent = document.documentElement || document.body;
    if (!parent?.appendChild || !document.createElement) return null;

    const probe = document.createElement('div');
    probe.setAttribute?.('aria-hidden', 'true');
    probe.style.cssText = [
        'position:fixed',
        'visibility:hidden',
        'pointer-events:none',
        'width:0',
        'height:0',
        'padding-top:env(safe-area-inset-top, 0px)',
        'padding-left:env(safe-area-inset-left, 0px)',
        'padding-right:env(safe-area-inset-right, 0px)',
        'padding-bottom:env(safe-area-inset-bottom, 0px)',
    ].join(';');
    parent.appendChild(probe);
    safeAreaProbe = probe;
    return safeAreaProbe;
}

function getSafeInsets() {
    try {
        if (typeof getComputedStyle !== 'function') throw new Error('computed style unavailable');
        const probe = getSafeAreaProbe();
        if (!probe) throw new Error('safe-area probe unavailable');
        const style = getComputedStyle(probe);
        return parseSafeAreaInsets({
            top: style.paddingTop || style.getPropertyValue?.('padding-top'),
            left: style.paddingLeft || style.getPropertyValue?.('padding-left'),
            right: style.paddingRight || style.getPropertyValue?.('padding-right'),
            bottom: style.paddingBottom || style.getPropertyValue?.('padding-bottom'),
        });
    } catch { /* test environment */ }
    return { top: 0, left: 0, right: 0, bottom: 0 };
}

function applyPosition(x, y, animate = false) {
    if (!fabEl?.style) return;
    fabEl.style.transition = animate
        ? `transform ${SNAP_DURATION}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`
        : 'none';
    fabEl.style.transform = `translate(${x}px, ${y}px)`;
    currentPosition.x = x;
    currentPosition.y = y;
}

function reclampPosition() {
    if (!fabEl?.style || dragState) return;
    const { vw, vh } = getViewportSize();
    const inputTop = getInputBarTop();
    const insets = getSafeInsets();
    const clamped = resolveVisiblePosition(desiredPosition, vw, vh, inputTop, insets);
    applyPosition(clamped.x, clamped.y, true);
}

function scheduleReclamp() {
    if (typeof requestAnimationFrame !== 'function') {
        reclampPosition();
        return;
    }
    if (reclampRafId) return; // already scheduled — coalesce
    reclampRafId = requestAnimationFrame(() => {
        reclampRafId = null;
        reclampPosition();
    });
}

function settlePosition(x, y, animate = true) {
    const { vw, vh } = getViewportSize();
    const inputTop = getInputBarTop();
    const insets = getSafeInsets();
    const clamped = clampPosition(x, y, vw, vh, inputTop, insets);
    const edge = computeEdgeSnap(clamped.x, vw);
    const snappedX = computeSnapX(edge, vw, insets.left, insets.right);
    const settled = clampPosition(snappedX, clamped.y, vw, vh, inputTop, insets);
    desiredPosition = { x: settled.x, y: settled.y };
    applyPosition(settled.x, settled.y, animate);
    savePosition(desiredPosition.x, desiredPosition.y);
}

function isElementVisible(el) {
    if (!el) return false;
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
    if (el.open) return true;
    try {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    } catch {
        return false;
    }
}

function isInputBarVisible() {
    try {
        return isElementVisible(document.getElementById('form_sheld'));
    } catch {
        return false;
    }
}

function isCharacterLibraryEmbeddedVisible() {
    try {
        return isElementVisible(document.querySelector('#charlib-embedded-container'));
    } catch {
        return false;
    }
}

function countVisible(selector) {
    try {
        return Array.from(document.querySelectorAll(selector)).filter(isElementVisible).length;
    } catch {
        return 0;
    }
}

function readStSurfaceState() {
    if (typeof document === 'undefined') return {};
    return {
        inputBarVisible: isInputBarVisible(),
        openDrawers: countVisible('.openDrawer'),
        openPopups: countVisible('dialog.popup[open], .popup[open]'),
        shadowPopupVisible: isElementVisible(document.getElementById('shadow_popup'))
            || isElementVisible(document.getElementById('bulk_tag_shadow_popup')),
        extensionMenuVisible: isElementVisible(document.getElementById('extensionsMenu')),
        characterLibraryEmbeddedVisible: isCharacterLibraryEmbeddedVisible(),
        optionMenusVisible: countVisible('.options-content, .popper-modal'),
        customModalsVisible: countVisible('[role="dialog"]:not(#dle-mobile-overlay), [aria-modal="true"]:not(#dle-mobile-overlay)'),
    };
}

function applyVisibility() {
    if (!fabWrapper?.style) return;
    const show = desiredVisible && !shouldHideForStSurface(readStSurfaceState());
    // Write only on change: unconditional style writes re-trigger the body
    // MutationObserver and keep the surface-update loop spinning forever.
    const opacity = show ? '1' : '0';
    if (fabWrapper.style.opacity !== opacity) {
        fabWrapper.style.opacity = opacity;
        fabWrapper.style.pointerEvents = show ? 'auto' : 'none';
    }
    if (fabEl && fabEl.disabled !== !show) {
        fabEl.style.pointerEvents = show ? 'auto' : 'none';
        fabEl.disabled = !show;
        fabEl.setAttribute('aria-hidden', show ? 'false' : 'true');
        if (show) {
            fabEl.removeAttribute('tabindex');
        } else {
            fabEl.setAttribute('tabindex', '-1');
        }
    }
}

function scheduleVisibilityCheck() {
    if (typeof requestAnimationFrame !== 'function') {
        applyVisibility();
        return;
    }
    // Coalesce instead of cancel-and-reschedule: surface observers can fire
    // every frame, and perpetually cancelling the pending callback starves it.
    if (overlayRafId) return;
    overlayRafId = requestAnimationFrame(() => {
        overlayRafId = null;
        applyVisibility();
    });
}

function scheduleSurfaceUpdate() {
    observeInputBar();
    scheduleVisibilityCheck();
    scheduleReclamp();
}

function onPointerDown(e) {
    if (!fabEl) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - currentPosition.x,
        offsetY: e.clientY - currentPosition.y,
        isDragging: false,
        rafId: null,
        pendingX: currentPosition.x,
        pendingY: currentPosition.y,
    };
    fabEl.setPointerCapture?.(e.pointerId);
}

function onPointerMove(e) {
    if (!dragState) return;
    if (dragState.pointerId != null && e.pointerId != null && e.pointerId !== dragState.pointerId) return;

    if (!dragState.isDragging) {
        if (isDrag(dragState.startX, dragState.startY, e.clientX, e.clientY)) {
            dragState.isDragging = true;
            fabEl?.classList?.add('dle-mobile-fab--dragging');
        } else {
            return;
        }
    }

    e.preventDefault?.();
    const state = dragState;
    const newX = e.clientX - state.offsetX;
    const newY = e.clientY - state.offsetY;
    state.pendingX = newX;
    state.pendingY = newY;

    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(() => {
        if (dragState !== state) return;
        state.rafId = null;
        const { vw, vh } = getViewportSize();
        const inputTop = getInputBarTop();
        const insets = getSafeInsets();
        const clamped = clampPosition(state.pendingX, state.pendingY, vw, vh, inputTop, insets);
        applyPosition(clamped.x, clamped.y, false);
    });
}

function onPointerEnd(e) {
    if (!dragState) return;
    const state = dragState;
    const wasDragging = state.isDragging;
    const pendingX = state.pendingX;
    const pendingY = state.pendingY;
    const pointerId = state.pointerId ?? e?.pointerId;

    if (state.rafId) cancelAnimationFrame(state.rafId);
    fabEl?.classList?.remove('dle-mobile-fab--dragging');
    fabEl?.releasePointerCapture?.(pointerId);
    dragState = null;

    if (wasDragging) {
        settlePosition(pendingX, pendingY);
    } else if (e?.type !== 'pointercancel') {
        onTapCallback?.();
    }
}

function observeInputBar() {
    const nextInputBarEl = document.getElementById('form_sheld');
    const nextInputTextEl = document.getElementById('send_textarea');

    if (inputTextEl !== nextInputTextEl) {
        inputTextEl?.removeEventListener?.('input', scheduleSurfaceUpdate);
        inputTextEl = nextInputTextEl;
        inputTextEl?.addEventListener?.('input', scheduleSurfaceUpdate);
    }

    if (inputBarEl !== nextInputBarEl) {
        inputResizeObserver?.disconnect();
        inputResizeObserver = null;
        inputBarEl = nextInputBarEl;
    }

    if (typeof ResizeObserver !== 'undefined' && inputBarEl && !inputResizeObserver) {
        inputResizeObserver = new ResizeObserver(scheduleSurfaceUpdate);
        inputResizeObserver.observe(inputBarEl);
    }
}

function observeStSurfaces() {
    if (typeof MutationObserver === 'undefined' || !document.body) return;
    overlayObserver = new MutationObserver((records) => {
        // Ignore batches caused purely by our own style/attribute writes,
        // otherwise every visibility/position update re-queues another pass.
        const external = records.some(r => !fabWrapper?.contains?.(r.target));
        if (external) scheduleSurfaceUpdate();
    });
    overlayObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-hidden'],
    });
}

export function createFab({ onTap, container } = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;

    onTapCallback = onTap || null;
    const parent = container || document.body;

    const wrapper = document.createElement('div');
    wrapper.className = 'dle-mobile-fab-anchor';

    fabEl = document.createElement('button');
    fabEl.className = 'dle-mobile-fab';
    fabEl.setAttribute('type', 'button');
    fabEl.setAttribute('aria-label', 'Open DeepLore panel');
    fabEl.setAttribute('touch-action', 'none');
    fabEl.innerHTML = '<i class="fa-solid fa-book-open" aria-hidden="true"></i>';

    wrapper.appendChild(fabEl);
    parent.appendChild(wrapper);
    fabWrapper = wrapper;

    const { vw, vh } = getViewportSize();
    const inputTop = getInputBarTop();
    const insets = getSafeInsets();
    const saved = loadPosition();
    const desired = saved || defaultPosition(vw, vh, inputTop, insets);
    desiredPosition = { x: desired.left, y: desired.top };
    const initial = resolveVisiblePosition(desiredPosition, vw, vh, inputTop, insets);
    currentPosition = { x: initial.x, y: initial.y };
    applyPosition(initial.x, initial.y, false);

    if (fabEl.addEventListener) {
        fabEl.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerEnd);
        window.addEventListener('pointercancel', onPointerEnd);
    }

    viewportResizeHandler = scheduleReclamp;
    window.addEventListener('resize', viewportResizeHandler);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', viewportResizeHandler);
    }

    observeInputBar();
    observeStSurfaces();
    applyVisibility();

    return wrapper;
}

export function destroyFab() {
    if (fabEl) {
        fabEl.removeEventListener('pointerdown', onPointerDown);
    }
    if (viewportResizeHandler && typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerEnd);
        window.removeEventListener('pointercancel', onPointerEnd);
        window.removeEventListener('resize', viewportResizeHandler);
        window.visualViewport?.removeEventListener('resize', viewportResizeHandler);
    }
    inputTextEl?.removeEventListener?.('input', scheduleSurfaceUpdate);
    inputResizeObserver?.disconnect();
    inputResizeObserver = null;
    overlayObserver?.disconnect();
    overlayObserver = null;
    if (overlayRafId) cancelAnimationFrame(overlayRafId);
    overlayRafId = null;
    safeAreaProbe?.remove?.();
    safeAreaProbe = null;
    viewportResizeHandler = null;
    if (reclampRafId) cancelAnimationFrame(reclampRafId);
    reclampRafId = null;
    fabWrapper?.remove();
    fabWrapper = null;
    fabEl = null;
    badgeEl = null;
    if (dragState?.rafId) cancelAnimationFrame(dragState.rafId);
    dragState = null;
    onTapCallback = null;
    currentPosition = { x: 0, y: 0 };
    desiredPosition = { x: 0, y: 0 };
    inputBarEl = null;
    inputTextEl = null;
    desiredVisible = true;
}

export function updateBadge(count) {
    if (!fabEl) return;
    if (count <= 0) {
        badgeEl?.remove();
        badgeEl = null;
        return;
    }
    const text = count > 99 ? '99+' : String(count);
    if (badgeEl) {
        badgeEl.textContent = text;
    } else {
        badgeEl = document.createElement('span');
        badgeEl.className = 'dle-mobile-fab__badge';
        badgeEl.textContent = text;
        fabEl.appendChild(badgeEl);
    }
}

export function setFabVisible(visible) {
    desiredVisible = !!visible;
    applyVisibility();
}
