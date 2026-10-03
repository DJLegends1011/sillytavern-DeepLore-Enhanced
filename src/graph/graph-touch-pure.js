/**
 * Pure helpers for the graph canvas touch layer (issue #4).
 *
 * No imports from ST / DOM. The live handlers in graph-events.js and the unit tests
 * exercise the same math. Coordinates are canvas-local CSS pixels.
 */

/** Zoom limits shared with the wheel handler. */
export const GRAPH_MIN_ZOOM = 0.2;
export const GRAPH_MAX_ZOOM = 5;

/** A touch that moves less than this (px) still counts as a tap / long-press. */
export const TAP_SLOP_PX = 10;
/** Hold this long without moving to open the context menu (right-click equivalent). */
export const LONG_PRESS_MS = 500;
/** Two taps within this window and distance count as a double-tap (dblclick equivalent). */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP_PX = 24;

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
export function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
export function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Two-finger pinch/pan. Keeps the world point under the previous finger midpoint
 * pinned under the new midpoint while scaling by the change in finger distance —
 * the touch analogue of the wheel handler's zoom-to-cursor.
 *
 * @param {{panX:number,panY:number,zoom:number}} view
 * @param {{x:number,y:number}} prevMid  @param {number} prevDist
 * @param {{x:number,y:number}} mid      @param {number} dist
 * @returns {{panX:number,panY:number,zoom:number}}
 */
export function pinchView(view, prevMid, prevDist, mid, dist) {
    const raw = prevDist > 0 ? dist / prevDist : 1;
    const zoom = Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, view.zoom * raw));
    const k = zoom / view.zoom;
    return {
        zoom,
        panX: mid.x - (prevMid.x - view.panX) * k,
        panY: mid.y - (prevMid.y - view.panY) * k,
    };
}

/**
 * @param {{x:number,y:number,t:number}|null} prev  last tap
 * @param {{x:number,y:number,t:number}} now
 */
export function isDoubleTap(prev, now) {
    return !!prev && now.t - prev.t <= DOUBLE_TAP_MS && distance(prev, now) <= DOUBLE_TAP_SLOP_PX;
}
