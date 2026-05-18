const FAB_SIZE = 44;
const DRAG_THRESHOLD = 8;
const SNAP_DURATION = 200;
const EDGE_MARGIN = 12;
const STORAGE_KEY = 'dleMobileFabPosition';

export { FAB_SIZE, DRAG_THRESHOLD, EDGE_MARGIN, STORAGE_KEY };

// ─── Pure helpers (testable without DOM) ────────────────────────────────────

export function computeEdgeSnap(x, viewportWidth) {
    const midpoint = viewportWidth / 2;
    return x + FAB_SIZE / 2 < midpoint ? 'left' : 'right';
}

export function computeSnapX(edge, viewportWidth, safeLeft = 0, safeRight = 0) {
    if (edge === 'left') return EDGE_MARGIN + safeLeft;
    return viewportWidth - FAB_SIZE - EDGE_MARGIN - safeRight;
}

export function clampPosition(x, y, viewportWidth, viewportHeight, inputBarTop, safeInsets = {}) {
    const safeTop = safeInsets.top || 0;
    const safeLeft = safeInsets.left || 0;
    const safeRight = safeInsets.right || 0;

    const minX = EDGE_MARGIN + safeLeft;
    const maxX = viewportWidth - FAB_SIZE - EDGE_MARGIN - safeRight;
    const minY = EDGE_MARGIN + safeTop;
    const maxY = Math.min(viewportHeight - FAB_SIZE - EDGE_MARGIN, inputBarTop - FAB_SIZE - EDGE_MARGIN);

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
        if (parsed && (parsed.edge === 'left' || parsed.edge === 'right') && typeof parsed.y === 'number') {
            return parsed;
        }
    } catch { /* corrupted data */ }
    return null;
}

export function savePosition(edge, y) {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ edge, y }));
    } catch { /* storage full or unavailable */ }
}

export function defaultPosition() {
    return { edge: 'right', y: 0.6 };
}

export function resolveInitialPosition(viewportWidth, viewportHeight, inputBarTop, safeInsets = {}) {
    const saved = loadPosition();
    const pos = saved || defaultPosition();
    const snapX = computeSnapX(pos.edge, viewportWidth, safeInsets.left || 0, safeInsets.right || 0);
    const absoluteY = typeof pos.y === 'number' && pos.y <= 1
        ? pos.y * (inputBarTop - FAB_SIZE - EDGE_MARGIN * 2 - (safeInsets.top || 0)) + EDGE_MARGIN + (safeInsets.top || 0)
        : pos.y;
    const clamped = clampPosition(snapX, absoluteY, viewportWidth, viewportHeight, inputBarTop, safeInsets);
    return { x: clamped.x, y: clamped.y, edge: pos.edge };
}

// ─── DOM-coupled FAB (browser only) ────────────────────────────────────────

let fabEl = null;
let fabWrapper = null;
let badgeEl = null;
let dragState = null;
let onTapCallback = null;
let currentPosition = { x: 0, y: 0, edge: 'right' };
let reclampRafId = null;
let viewportResizeHandler = null;

function getInputBarTop() {
    try {
        const formSheld = document.getElementById('form_sheld');
        if (formSheld?.getBoundingClientRect) return formSheld.getBoundingClientRect().top;
    } catch { /* test environment */ }
    return (typeof window !== 'undefined' ? window.innerHeight : 844) - 76;
}

function getSafeInsets() {
    try {
        if (typeof getComputedStyle === 'function') {
            const style = getComputedStyle(document.documentElement);
            return {
                top: parseInt(style.getPropertyValue('env(safe-area-inset-top)'), 10) || 0,
                left: parseInt(style.getPropertyValue('env(safe-area-inset-left)'), 10) || 0,
                right: parseInt(style.getPropertyValue('env(safe-area-inset-right)'), 10) || 0,
            };
        }
    } catch { /* test environment */ }
    return { top: 0, left: 0, right: 0 };
}

function applyPosition(x, y, animate = false) {
    if (!fabEl?.style) return;
    if (animate) {
        fabEl.style.transition = `transform ${SNAP_DURATION}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
    } else {
        fabEl.style.transition = 'none';
    }
    fabEl.style.transform = `translate(${x}px, ${y}px)`;
    currentPosition.x = x;
    currentPosition.y = y;
}

function reclampPosition() {
    if (!fabEl?.style || dragState) return; // don't fight an active drag
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const inputTop = getInputBarTop();
    const insets = getSafeInsets();
    const snapX = computeSnapX(currentPosition.edge, vw, insets.left, insets.right);
    const clamped = clampPosition(snapX, currentPosition.y, vw, vh, inputTop, insets);
    applyPosition(clamped.x, clamped.y, true);
}

function snapToEdge(x, y) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inputTop = getInputBarTop();
    const insets = getSafeInsets();

    const edge = computeEdgeSnap(x, vw);
    const snapX = computeSnapX(edge, vw, insets.left, insets.right);
    const clamped = clampPosition(snapX, y, vw, vh, inputTop, insets);

    currentPosition.edge = edge;
    applyPosition(clamped.x, clamped.y, true);

    const relativeY = (clamped.y - EDGE_MARGIN - (insets.top || 0)) /
        (inputTop - FAB_SIZE - EDGE_MARGIN * 2 - (insets.top || 0));
    savePosition(edge, Math.max(0, Math.min(1, relativeY)));
}

function onTouchStart(e) {
    if (!fabEl) return;
    const touch = e.touches[0];
    dragState = {
        startX: touch.clientX,
        startY: touch.clientY,
        offsetX: touch.clientX - currentPosition.x,
        offsetY: touch.clientY - currentPosition.y,
        isDragging: false,
        rafId: null,
        lastX: currentPosition.x,
        lastY: currentPosition.y,
    };
}

function onTouchMove(e) {
    if (!dragState) return;
    const touch = e.touches[0];

    if (!dragState.isDragging) {
        if (isDrag(dragState.startX, dragState.startY, touch.clientX, touch.clientY)) {
            dragState.isDragging = true;
            fabEl?.classList?.add('dle-mobile-fab--dragging');
        } else {
            return;
        }
    }

    e.preventDefault();
    const newX = touch.clientX - dragState.offsetX;
    const newY = touch.clientY - dragState.offsetY;

    if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
    dragState.rafId = requestAnimationFrame(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const inputTop = getInputBarTop();
        const insets = getSafeInsets();
        const clamped = clampPosition(newX, newY, vw, vh, inputTop, insets);
        applyPosition(clamped.x, clamped.y, false);
        dragState.lastX = clamped.x;
        dragState.lastY = clamped.y;
    });
}

function onTouchEnd() {
    if (!dragState) return;
    const wasDragging = dragState.isDragging;
    const lastX = dragState.lastX;
    const lastY = dragState.lastY;

    if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
    fabEl?.classList?.remove('dle-mobile-fab--dragging');
    dragState = null;

    if (wasDragging) {
        snapToEdge(lastX, lastY);
    } else {
        onTapCallback?.();
    }
}

export function renderFabHtml(injectionCount = 0) {
    const badgeHtml = injectionCount > 0
        ? `<span class="dle-mobile-fab__badge">${injectionCount > 99 ? '99+' : injectionCount}</span>`
        : '';
    return `<button class="dle-mobile-fab" type="button" aria-label="Open DeepLore panel" touch-action="none">
    <i class="fa-solid fa-book-open" aria-hidden="true"></i>${badgeHtml}
</button>`;
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

    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const inputTop = getInputBarTop();
    const insets = getSafeInsets();
    const initial = resolveInitialPosition(vw, vh, inputTop, insets);
    currentPosition = { x: initial.x, y: initial.y, edge: initial.edge };
    applyPosition(initial.x, initial.y, false);

    if (fabEl.addEventListener) {
        fabEl.addEventListener('touchstart', onTouchStart, { passive: true });
        fabEl.addEventListener('touchmove', onTouchMove, { passive: false });
        fabEl.addEventListener('touchend', onTouchEnd, { passive: true });
    }

    viewportResizeHandler = () => {
        if (reclampRafId) cancelAnimationFrame(reclampRafId);
        reclampRafId = requestAnimationFrame(reclampPosition);
    };
    window.addEventListener('resize', viewportResizeHandler);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', viewportResizeHandler);
    }

    return wrapper;
}

export function destroyFab() {
    if (fabEl) {
        fabEl.removeEventListener('touchstart', onTouchStart);
        fabEl.removeEventListener('touchmove', onTouchMove);
        fabEl.removeEventListener('touchend', onTouchEnd);
    }
    if (viewportResizeHandler && typeof window !== 'undefined') {
        window.removeEventListener('resize', viewportResizeHandler);
        window.visualViewport?.removeEventListener('resize', viewportResizeHandler);
    }
    viewportResizeHandler = null;
    if (reclampRafId) cancelAnimationFrame(reclampRafId);
    reclampRafId = null;
    fabWrapper?.remove();
    fabWrapper = null;
    fabEl = null;
    badgeEl = null;
    dragState = null;
    onTapCallback = null;
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
    if (!fabWrapper?.style) return;
    fabWrapper.style.opacity = visible ? '1' : '0';
    fabWrapper.style.pointerEvents = visible ? 'auto' : 'none';
}
