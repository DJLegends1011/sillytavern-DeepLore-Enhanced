/**
 * Layered DAG layout (Sugiyama-lite, hand-rolled — no external library).
 *
 * Uses ONLY directed edge types (`requires` + `cascade`). Pure helpers
 * (breakCycles / assignLayers / computeDagPositions) are exported for headless
 * unit testing. enterDagLayout/exitDagLayout integrate with the live graph by
 * reusing the focus-tree freeze/stage/lerp rig (gs.layoutMode, _targetX/_targetY,
 * _egoLerpActive, lerpEgoPositions) — see graph-focus.js for the template.
 *
 * Map keys are node ids (collision-safe), never bare titles — gotcha #50.
 */
import { isRehidden } from './graph-util.js';

/**
 * Break cycles in a directed edge list via iterative DFS back-edge removal.
 * @param {number[]} ids node ids in the subgraph
 * @param {{from:number,to:number}[]} edges directed edges
 * @returns {{ acyclic: {from:number,to:number}[], removed: Set<string> }} removed keyed "from\0to"
 */
export function breakCycles(ids, edges) {
    const idSet = new Set(ids);
    const adj = new Map();
    for (const id of ids) adj.set(id, []);
    for (const e of edges) {
        if (idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to) adj.get(e.from).push(e.to);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of ids) color.set(id, WHITE);
    const removed = new Set();

    for (const start of ids) {
        if (color.get(start) !== WHITE) continue;
        color.set(start, GRAY);
        const stack = [{ node: start, i: 0 }];
        while (stack.length) {
            const top = stack[stack.length - 1];
            const neighbors = adj.get(top.node);
            if (top.i < neighbors.length) {
                const nb = neighbors[top.i++];
                const c = color.get(nb);
                if (c === WHITE) {
                    color.set(nb, GRAY);
                    stack.push({ node: nb, i: 0 });
                } else if (c === GRAY) {
                    // Back-edge → cycle. Drop it from the acyclic projection.
                    removed.add(`${top.node}\0${nb}`);
                }
                // BLACK neighbor = forward/cross edge, keep.
            } else {
                color.set(top.node, BLACK);
                stack.pop();
            }
        }
    }

    const acyclic = edges.filter(e =>
        idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to && !removed.has(`${e.from}\0${e.to}`));
    return { acyclic, removed };
}

/**
 * Longest-path layering on an acyclic directed edge list.
 * layer(v) = 1 + max(layer(u)) over edges u→v. Roots land on layer 0.
 * @returns {Map<number,number>} id → layer
 */
export function assignLayers(ids, acyclicEdges) {
    const layer = new Map();
    for (const id of ids) layer.set(id, 0);
    // Relax to fixpoint; bounded by ids.length passes (DAG longest path).
    for (let pass = 0; pass < ids.length; pass++) {
        let changed = false;
        for (const e of acyclicEdges) {
            // Exported-helper contract: skip edges whose endpoints aren't in `ids` (would
            // otherwise compare against undefined and silently no-op / propagate NaN).
            if (!layer.has(e.from) || !layer.has(e.to)) continue;
            if (layer.get(e.to) < layer.get(e.from) + 1) {
                layer.set(e.to, layer.get(e.from) + 1);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return layer;
}

/**
 * Group ids by layer; order within each layer deterministically (by title then id)
 * so re-entering DAG mode yields a stable layout.
 * @returns {Map<number, number[]>} layer → ordered ids
 */
export function groupByLayer(ids, layer, titleOf) {
    const byL = new Map();
    for (const id of ids) {
        const l = layer.get(id) || 0;
        if (!byL.has(l)) byL.set(l, []);
        byL.get(l).push(id);
    }
    for (const [, arr] of byL) {
        arr.sort((a, b) => (titleOf(a) || '').localeCompare(titleOf(b) || '') || a - b);
    }
    return byL;
}

/**
 * Full layered layout. Top→down by dependency depth, centered on origin.
 * @returns {{ positions: Map<number,{x:number,y:number}>, layer: Map<number,number>, removed: Set<string>, maxLayer: number }}
 */
export function computeDagPositions(ids, edges, opts = {}) {
    const { titleOf = (id) => String(id), rowSpacing = 150, colSpacing = 130 } = opts;
    const { acyclic, removed } = breakCycles(ids, edges);
    const layer = assignLayers(ids, acyclic);
    const byL = groupByLayer(ids, layer, titleOf);
    const maxLayer = Math.max(0, ...layer.values());
    const positions = new Map();
    for (const [l, arr] of byL) {
        const total = arr.length;
        arr.forEach((id, k) => {
            positions.set(id, {
                x: (k - (total - 1) / 2) * colSpacing,
                y: (l - maxLayer / 2) * rowSpacing,
            });
        });
    }
    return { positions, layer, removed, maxLayer };
}

// ─── Live-graph integration ───

/** Node ids touching at least one requires/cascade edge. */
function dagParticipants(gs) {
    const set = new Set();
    for (const e of gs.edges) {
        if (e.type === 'requires' || e.type === 'cascade') { set.add(e.from); set.add(e.to); }
    }
    return set;
}

/**
 * Wire enter/exit onto gs. Mirrors enterFocusTree/exitFocusTree restore discipline:
 * snapshot positions + edgeVisibility on enter, restore exactly on exit, manage
 * cachedVisibleCount and the hidden/reveal formula so hit-testing and filters stay sane.
 */
export function initDagLayout(gs, dbg) {
    function enter() {
        const idSet = dagParticipants(gs);
        const ids = [...idSet];
        if (ids.length === 0) {
            if (typeof toastr !== 'undefined') {
                toastr.info('No requires/cascade dependencies to lay out. Add requires:/cascade_links: to entries.', 'DeepLore Enhanced');
            }
            if (dbg) dbg('DAG: no requires/cascade participants — staying in force mode');
            return false;
        }

        // Snapshot for restore (positions + which edge types were visible).
        if (!gs._preLayoutPositions) {
            gs._preLayoutPositions = new Map();
            for (const n of gs.nodes) gs._preLayoutPositions.set(n.id, { x: n.x, y: n.y });
        }
        // Guarded like _preLayoutPositions: a second enter() before exit() must not overwrite the
        // saved (pre-DAG) visibility with the already-DAG-restricted one and corrupt restore.
        if (!gs._preLayoutEdgeVis) gs._preLayoutEdgeVis = { ...gs.edgeVisibility };

        // Restrict to directed edges; rebuild degree-derived state under the new visibility.
        gs.edgeVisibility.link = false;
        gs.edgeVisibility.excludes = false;
        gs.edgeVisibility.requires = true;
        gs.edgeVisibility.cascade = true;
        gs.buildAdjacency();

        // Hide everything outside the dependency subgraph (focus-tree pattern).
        for (const n of gs.nodes) n.hidden = !idSet.has(n.id);

        const dirEdges = gs.edges
            .filter(e => e.type === 'requires' || e.type === 'cascade')
            .map(e => ({ from: e.from, to: e.to }));
        const { positions, removed, maxLayer } = computeDagPositions(ids, dirEdges, {
            titleOf: (id) => gs.nodes[id].title,
        });

        for (const [id, p] of positions) {
            const n = gs.nodes[id];
            n._targetX = p.x;
            n._targetY = p.y;
            n.vx = 0; n.vy = 0;
            n.pinned = true;
            n._layoutPinned = true;
            // Un-hidden participants that were orphan-/batch-hidden keep _revealScale=0 and would
            // render invisible until the tick reveal-lerp ramps them — force them visible now.
            n._revealScale = 1;
        }
        gs.cachedVisibleCount = ids.length;
        gs.layoutMode = 'dag';
        gs._egoLerpActive = true;
        gs.alpha = 0.001;
        gs.hasSpringEnergy = true;
        gs.needsDraw = true;

        if (dbg) dbg(`DAG: ${ids.length} nodes, ${maxLayer + 1} layers, ${removed.size} back-edge(s) broken`);
        // Fit AFTER the lerp settles, not now — node x/y are still the pre-DAG force positions,
        // so fitting here would frame the old scatter (wrong zoom for a tall layered tree). Defer
        // past the ~150ms lerp; tracked in _fitTimers so popup-close cancels it. (Mirrors replayReveal.)
        if (gs.fitToView) {
            const tid = setTimeout(() => {
                if (gs.isRunning && gs.layoutMode === 'dag') gs.fitToView(true);
            }, 260);
            (gs._fitTimers = gs._fitTimers || []).push(tid);
        }
        return true;
    }

    function exit() {
        for (const n of gs.nodes) {
            if (n._layoutPinned) { n.pinned = false; n._layoutPinned = false; }
            // Shared re-hide rule with exitFocusTree — keeps reveal/orphan state consistent.
            n.hidden = isRehidden(n, gs.revealedBatch);
            delete n._targetX;
            delete n._targetY;
        }
        if (gs._preLayoutPositions) {
            for (const n of gs.nodes) {
                const saved = gs._preLayoutPositions.get(n.id);
                if (saved && !n.pinned) { n.x = saved.x; n.y = saved.y; }
                n.vx = 0; n.vy = 0;
            }
            gs._preLayoutPositions = null;
        }
        if (gs._preLayoutEdgeVis) {
            Object.assign(gs.edgeVisibility, gs._preLayoutEdgeVis);
            gs._preLayoutEdgeVis = null;
            gs.buildAdjacency();
        }
        gs.cachedVisibleCount = gs.nodes.length;
        gs.layoutMode = 'force';
        gs._egoLerpActive = false;
        // Restored positions are settled → keep physics cold (mirrors exitFocusTree).
        gs.alpha = 0;
        gs.hasSpringEnergy = false;
        gs.maxDelta = 0;
        gs.needsDraw = true;
        if (gs.fitToView) gs.fitToView();
    }

    gs.enterDagLayout = enter;
    gs.exitDagLayout = exit;
    return { enter, exit };
}
