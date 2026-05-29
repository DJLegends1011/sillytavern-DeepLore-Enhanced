/**
 * Ego-centric focus mode: radial layout, BFS depth, hover distances, search/filter, fit-to-view.
 *
 * @param {object} gs
 * @param {Function} dbg
 * @returns {{ bfsDepth, computeRadialLayout, enterFocusTree, exitFocusTree,
 *             computeHoverDistances, applyFilters, fitToView, findNearest, hitRadius }}
 */
export function initFocus(gs, dbg) {

    /**
     * Nearest-node hit-test in world space within maxDist (already in world units).
     * Radius-aware: bigger nodes get bigger hitboxes. biasY compensates for visual
     * perception that dot centers feel ~2px above geometric center.
     */
    function findNearest(wx, wy, maxDist, debugLabel) {
        const { nodes } = gs;
        const inFocusTree = !!gs.focusTreeRoot;
        let closest = null, closestDist = maxDist;
        let nearestAny = null, nearestAnyDist = Infinity;
        const biasY = 2 / gs.zoom;
        for (const n of nodes) {
            if (n.hidden) continue;
            if (n.filtered && !inFocusTree) continue;
            const d = Math.sqrt((n.x - wx) ** 2 + (n.y + biasY - wy) ** 2);
            // Subtract node radius so clicks near the visible edge still register as hits.
            const r = gs.getNodeRadius ? gs.getNodeRadius(n) : 0;
            const effectiveDist = Math.max(0, d - r);
            if (effectiveDist < closestDist) { closest = n; closestDist = effectiveDist; }
            if (d < nearestAnyDist) { nearestAny = n; nearestAnyDist = d; }
        }
        if (debugLabel && !closest && nearestAny) {
            dbg(`findNearest miss (${debugLabel}): nearest="${nearestAny.title}" at dist=${nearestAnyDist.toFixed(1)}, maxDist=${maxDist.toFixed(1)}`);
        }
        return closest;
    }

    function hitRadius() {
        if (gs.focusTreeRoot) return 16 / gs.zoom;
        // Guard against cachedVisibleCount=0 → Infinity hit radius.
        if (gs.cachedVisibleCount <= 0) return 20 / gs.zoom;
        const baseRadius = Math.max(gs.W, gs.H) / (Math.sqrt(gs.cachedVisibleCount) * 2);
        return Math.max(8, Math.min(40, baseRadius / gs.zoom));
    }

    /**
     * BFS to maxDepth → Map<nodeId, depth>. Uses full edge graph (ignores legend toggles)
     * so focus tree always shows the structural neighborhood, not just visible-edge subgraph.
     */
    function bfsDepth(rootId, maxDepth) {
        const { nodes, edges } = gs;
        const fullAdj = new Map();
        for (const n of nodes) fullAdj.set(n.id, []);
        for (const edge of edges) {
            fullAdj.get(edge.from).push(edge.to);
            fullAdj.get(edge.to).push(edge.from);
        }
        const dist = new Map();
        const treeEdges = new Set();
        dist.set(rootId, 0);
        const queue = [rootId];
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            const d = dist.get(cur);
            if (d >= maxDepth) continue;
            for (const nb of (fullAdj.get(cur) || [])) {
                if (!dist.has(nb)) {
                    dist.set(nb, d + 1);
                    queue.push(nb);
                    treeEdges.add(`${cur}:${nb}`);
                    treeEdges.add(`${nb}:${cur}`);
                }
            }
        }
        dist._treeEdges = treeEdges;
        return dist;
    }

    /**
     * Radial layout for focus mode: root at center, depth-d nodes spread around ring d.
     * G4 density correction: ring radius = max(linear, density-bound) so crowded rings expand
     * to give each node ~minArcPx of arc-space, preventing overlap on dense neighborhoods.
     */
    function computeRadialLayout(rootId, depthMap) {
        const positions = new Map();
        positions.set(rootId, { x: 0, y: 0 });

        const levels = new Map();
        for (const [nid, d] of depthMap) {
            if (nid === rootId) continue;
            if (!levels.has(d)) levels.set(d, []);
            levels.get(d).push(nid);
        }

        const maxDepth = Math.max(0, ...levels.keys());
        const baseRingSpacing = 150;
        const minArcPx = 35;

        for (let d = 1; d <= maxDepth; d++) {
            const nodesAtLevel = levels.get(d) || [];
            if (nodesAtLevel.length === 0) continue;
            // Alphabetical sort → deterministic layout across re-enters.
            nodesAtLevel.sort((a, b) => gs.nodes[a].title.localeCompare(gs.nodes[b].title));
            const linearRadius = d * baseRingSpacing;
            const densityRadius = (nodesAtLevel.length * minArcPx) / (2 * Math.PI);
            const radius = Math.min(Math.max(linearRadius, densityRadius), 1200);
            const angleStep = (2 * Math.PI) / nodesAtLevel.length;
            // Per-ring angle offset breaks visual alignment between rings.
            const angleOffset = d * 0.3;
            for (let i = 0; i < nodesAtLevel.length; i++) {
                const angle = angleOffset + i * angleStep;
                positions.set(nodesAtLevel[i], {
                    x: Math.cos(angle) * radius,
                    y: Math.sin(angle) * radius,
                });
            }
        }

        return positions;
    }

    function enterFocusTree(rootNode) {
        const { nodes, edges, settings, canvas } = gs;
        const depth = settings.graphFocusTreeDepth || 2;
        const depthMap = bfsDepth(rootNode.id, depth);

        dbg(`Ego Focus: root="${rootNode.title}", depth=${depth}, visible=${depthMap.size}/${nodes.length}`);

        // Save pre-focus positions so exit can lerp back to the previous layout.
        if (!gs._preFocusPositions) {
            gs._preFocusPositions = new Map();
            for (const n of nodes) {
                gs._preFocusPositions.set(n.id, { x: n.x, y: n.y });
            }
        }

        for (const n of nodes) {
            n.hidden = !depthMap.has(n.id);
        }

        gs.focusTreeRoot = rootNode;
        rootNode.pinned = true;

        const positions = computeRadialLayout(rootNode.id, depthMap);

        // Stage targets on _targetX/_targetY; lerpEgoPositions() steps each frame in tick().
        for (const [nid, pos] of positions) {
            const n = nodes[nid];
            n._targetX = pos.x;
            n._targetY = pos.y;
            n.vx = 0;
            n.vy = 0;
            n._treePinned = true;
            n.pinned = true;
        }

        gs.focusTreeRoot._depthMap = depthMap;
        const treeEdgeIdx = new Set();
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (depthMap._treeEdges.has(`${e.from}:${e.to}`)) treeEdgeIdx.add(i);
        }
        gs.focusTreeRoot._treeEdgeIdx = treeEdgeIdx;
        gs.cachedVisibleCount = depthMap.size;
        gs.layoutMode = 'focus';
        gs._egoLerpActive = true;
        gs.alpha = 0.001;
        gs.needsDraw = true;
        gs.hasSpringEnergy = true;

        const backBtn = document.getElementById('dle-graph-back');
        if (backBtn) {
            backBtn.textContent = `← ${rootNode.title} (${depthMap.size} nodes, ${depth}-hop)`;
            backBtn.style.display = 'inline-block';
        }
        const hopMinus = document.getElementById('dle-graph-hop-minus');
        const hopPlus = document.getElementById('dle-graph-hop-plus');
        const depthDisplay = document.getElementById('dle-graph-depth-display');
        if (hopMinus) hopMinus.style.display = 'inline-block';
        if (hopPlus) hopPlus.style.display = 'inline-block';
        if (depthDisplay) { depthDisplay.style.display = 'inline-block'; depthDisplay.textContent = depth; }

        fitToView();
        gs.cachedRect = canvas.getBoundingClientRect();
        updateHints(true);
    }

    function updateHints(focusMode) {
        const el = document.getElementById('dle-graph-hints');
        if (!el) return;
        if (focusMode) {
            // BUG-357 / ST quirk: focus exit key is `e`, not Escape/Backspace. See graph-events.js keydown handler.
            el.textContent = 'Double-click node to re-root · +/- to change depth · e to exit focus · Scroll to zoom · 0 to fit';
        } else {
            el.textContent = 'Drag to move · Right-click for menu · Scroll to zoom · Click+drag to pan · Double-click to focus · 0 to fit';
        }
    }

    function exitFocusTree() {
        if (!gs.focusTreeRoot) return;
        const { nodes, W, H } = gs;
        dbg(`Exiting Ego Focus from root="${gs.focusTreeRoot.title}"`);

        for (const n of nodes) {
            if (n._treePinned) {
                n.pinned = false;
                n._treePinned = false;
            }
            n.hidden = n.orphan || (n.revealBatchIdx != null && n.revealBatchIdx >= gs.revealedBatch && n.revealBatchIdx !== -1);
            delete n._targetX;
            delete n._targetY;
        }

        // Restored pre-focus positions are already settled → keep physics cold (alpha=0,
        // hasSpringEnergy=false) so nodes don't drift and hover doesn't bump neighbors.
        // Random fallback re-heats to a moderate alpha so the simulation can settle the new layout.
        let restored = false;
        if (gs._preFocusPositions) {
            for (const n of nodes) {
                const saved = gs._preFocusPositions.get(n.id);
                if (saved && !n.pinned) {
                    n.x = saved.x;
                    n.y = saved.y;
                }
                n.vx = 0; n.vy = 0;
            }
            gs._preFocusPositions = null;
            restored = true;
        } else {
            for (const n of nodes) {
                if (!n.pinned) {
                    n.x = (Math.random() - 0.5) * W * 0.8;
                    n.y = (Math.random() - 0.5) * H * 0.8;
                }
                n.vx = 0; n.vy = 0;
            }
        }

        gs.focusTreeRoot.pinned = false;
        delete gs.focusTreeRoot._treeEdgeIdx;
        delete gs.focusTreeRoot._depthMap;
        gs.focusTreeRoot = null;
        gs.layoutMode = 'force';
        gs._egoLerpActive = false;
        gs.cachedVisibleCount = nodes.length;

        if (restored) {
            gs.alpha = 0;
            gs.maxDelta = 0;
            gs.hasSpringEnergy = false;
        } else {
            gs.alpha = 0.8; gs.simFrame = 0;
            gs.hasSpringEnergy = true;
        }
        gs.needsDraw = true;

        const backBtn = document.getElementById('dle-graph-back');
        if (backBtn) backBtn.style.display = 'none';
        const hopMinus = document.getElementById('dle-graph-hop-minus');
        const hopPlus = document.getElementById('dle-graph-hop-plus');
        const depthDisplay = document.getElementById('dle-graph-depth-display');
        if (hopMinus) hopMinus.style.display = 'none';
        if (hopPlus) hopPlus.style.display = 'none';
        if (depthDisplay) depthDisplay.style.display = 'none';

        fitToView();
        gs.cachedRect = gs.canvas.getBoundingClientRect();
        updateHints(false);
    }

    /** Lerp focus-tree nodes toward _targetX/_targetY. Returns true while animating. */
    function lerpEgoPositions() {
        if (!gs._egoLerpActive) return false;

        // a11y: snap to targets immediately for prefers-reduced-motion users.
        if (gs.reducedMotion) {
            for (const n of gs.nodes) {
                if (n._targetX == null || n.hidden) continue;
                n.x = n._targetX;
                n.y = n._targetY;
            }
            gs._egoLerpActive = false;
            return false;
        }

        let anyMoving = false;
        const speed = 0.12; // ~150ms to settle at 60fps.
        for (const n of gs.nodes) {
            if (n._targetX == null || n.hidden) continue;
            const dx = n._targetX - n.x;
            const dy = n._targetY - n.y;
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                n.x += dx * speed;
                n.y += dy * speed;
                anyMoving = true;
            } else {
                n.x = n._targetX;
                n.y = n._targetY;
            }
        }
        if (!anyMoving) gs._egoLerpActive = false;
        return anyMoving;
    }

    // Per-ring soft caps bound the lit subgraph on hub hover. Ring 1 (immediate neighbors) is uncapped
    // so direct connections are never truncated. Tiebreak: lowest-degree first, biasing toward leafy
    // branches over hub-chasing.
    const HOVER_RING_CAPS = [Infinity, Infinity, 40, 60, 80, 100];

    function computeHoverDistances(startId, maxDepth) {
        const depth = maxDepth ?? (gs.settings.graphHoverDimDistance ?? 3);
        const dist = new Map();
        dist.set(startId, 0);
        let frontier = [startId];
        for (let d = 0; d < depth; d++) {
            const ringCap = HOVER_RING_CAPS[d + 1] ?? HOVER_RING_CAPS[HOVER_RING_CAPS.length - 1];
            // Collect all candidate next-ring neighbors, dedup'd against existing dist.
            const candidates = [];
            const seenInRing = new Set();
            for (const u of frontier) {
                for (const v of (gs.adjacency.get(u) || [])) {
                    if (dist.has(v) || seenInRing.has(v)) continue;
                    seenInRing.add(v);
                    candidates.push(v);
                }
            }
            if (!candidates.length) break;
            let next = candidates;
            if (candidates.length > ringCap) {
                const degOf = (id) => (gs.edgeCountByNode?.get(id) || (gs.adjacency.get(id)?.length || 0));
                next = candidates
                    .map(id => ({ id, deg: degOf(id) }))
                    .sort((a, b) => a.deg - b.deg)
                    .slice(0, ringCap)
                    .map(x => x.id);
            }
            for (const v of next) dist.set(v, d + 1);
            frontier = next;
        }
        return dist;
    }

    function applyFilters() {
        const { nodes } = gs;
        const q = gs.searchQuery.toLowerCase();
        let matchCount = 0;
        const hasFilter = q || gs.typeFilter || gs.tagFilter;

        if (!hasFilter && gs.layoutMode === 'force') {
            let wasIsolated = false;
            for (const n of nodes) {
                if (n.hidden && !n.orphan && (n.revealBatchIdx == null || n.revealBatchIdx < gs.revealedBatch || n.revealBatchIdx === -1)) {
                    wasIsolated = true;
                    n.hidden = false;
                }
            }
            if (wasIsolated) dbg('Filters cleared — reset isolation mode');
        }

        for (const n of nodes) {
            let matches = true;
            if (q && !n.title.toLowerCase().includes(q)) matches = false;
            if (gs.typeFilter && n.type !== gs.typeFilter) matches = false;
            if (gs.tagFilter && !n.tags.includes(gs.tagFilter)) matches = false;
            n.filtered = hasFilter && !matches;
            if (!n.filtered) matchCount++;
        }
        gs.needsDraw = true;
        dbg(`Filters applied: query="${q}", type="${gs.typeFilter}", tag="${gs.tagFilter}" → ${matchCount}/${nodes.length} match`);
        const searchEl = document.getElementById('dle-graph-search');
        if (searchEl && hasFilter) {
            searchEl.title = `${matchCount} of ${nodes.length} entries match`;
        } else if (searchEl) {
            searchEl.title = '';
        }
    }

    function fitToView(animate = false) {
        const { nodes, edgeCountByNode, W, H } = gs;
        const visible = nodes.filter(n => !n.hidden);
        if (visible.length === 0) return;
        // Prefer fitting only connected nodes — orphans drift to corners and would skew the bbox.
        const connected = visible.filter(n => (edgeCountByNode.get(n.id) || 0) > 0);
        const fitSet = connected.length > 0 ? connected : visible;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of fitSet) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
        }
        const dx = maxX - minX || 1;
        const dy = maxY - minY || 1;
        const padX = 40;
        const padTop = 40;
        const padBottom = 60; // extra space for the color-legend overlay anchored at the bottom
        const targetZoom = Math.max(0.2, Math.min((W - padX * 2) / dx, (H - padTop - padBottom) / dy, 3));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const targetPanX = W / 2 - cx * targetZoom;
        const targetPanY = (padTop + (H - padBottom - padTop) / 2) - cy * targetZoom;

        if (animate) {
            gs._fitAnim = { targetPanX, targetPanY, targetZoom, frames: 0 };
        } else {
            gs.zoom = targetZoom;
            gs.panX = targetPanX;
            gs.panY = targetPanY;
        }
        gs.needsDraw = true;
    }

    /** Step one fit-animation frame from tick. Returns true while active. */
    function stepFitAnimation() {
        const a = gs._fitAnim;
        if (!a) return false;
        const t = 0.12;
        gs.panX += (a.targetPanX - gs.panX) * t;
        gs.panY += (a.targetPanY - gs.panY) * t;
        gs.zoom += (a.targetZoom - gs.zoom) * t;
        a.frames++;
        // Settle when sub-pixel close OR max-frame fallback (60f ≈ 1s).
        if (a.frames > 60 || (Math.abs(gs.panX - a.targetPanX) < 0.5 && Math.abs(gs.panY - a.targetPanY) < 0.5 && Math.abs(gs.zoom - a.targetZoom) < 0.001)) {
            gs.panX = a.targetPanX;
            gs.panY = a.targetPanY;
            gs.zoom = a.targetZoom;
            gs._fitAnim = null;
            return false;
        }
        gs.needsDraw = true;
        return true;
    }

    gs.findNearest = findNearest;
    gs.hitRadius = hitRadius;
    gs.computeHoverDistances = computeHoverDistances;
    gs.applyFilters = applyFilters;
    gs.fitToView = fitToView;
    gs.enterFocusTree = enterFocusTree;
    gs.exitFocusTree = exitFocusTree;
    gs.lerpEgoPositions = lerpEgoPositions;

    return { bfsDepth, computeRadialLayout, enterFocusTree, exitFocusTree,
             computeHoverDistances, applyFilters, fitToView, stepFitAnimation,
             findNearest, hitRadius, lerpEgoPositions };
}
