/**
 * Force-directed layout: repulsion + LinLog link attraction + tag clustering + shared-neighbor
 * springs + community clustering + gravity + collision + progressive reveal. Two-phase decay
 * (G7) keeps clusters hot before cooling to a stable layout.
 */
import { updateCommunityCentroids } from './graph-analysis.js';
import { invalidateSettingsCache } from '../../settings.js';
import { saveSettingsDebounced } from '../../../../../../script.js';

/**
 * @param {object} gs
 * @returns {{ simulate: Function }}
 */
export function initPhysics(gs) {

    const MAX_SIMULATION_MS = 90_000; // hard clamp: force-settle after 90s no matter what.

    // Spatial grid → O(n) repulsion + collision instead of O(n²).
    let _gridCells = null;
    let _gridCellSize = 0;
    let _gridMinX = 0;
    let _gridMinY = 0;
    let _gridCols = 0;
    let _gridRows = 0;

    function buildSpatialGrid(nodes, cellSize) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].orphan) continue;
            const n = nodes[i];
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
        }
        if (minX > maxX) return;
        // Pad bbox by one cell so boundary nodes still fall inside the grid.
        minX -= cellSize; minY -= cellSize;
        maxX += cellSize; maxY += cellSize;
        _gridCellSize = cellSize;
        _gridMinX = minX;
        _gridMinY = minY;
        _gridCols = Math.ceil((maxX - minX) / cellSize) + 1;
        _gridRows = Math.ceil((maxY - minY) / cellSize) + 1;
        const totalCells = _gridCols * _gridRows;
        if (!_gridCells || _gridCells.length < totalCells) {
            _gridCells = new Array(totalCells);
        }
        for (let c = 0; c < totalCells; c++) _gridCells[c] = null;
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].orphan) continue;
            const col = ((nodes[i].x - minX) / cellSize) | 0;
            const row = ((nodes[i].y - minY) / cellSize) | 0;
            const idx = row * _gridCols + col;
            if (!_gridCells[idx]) _gridCells[idx] = [i];
            else _gridCells[idx].push(i);
        }
    }

    function simulate() {
        if (gs.layoutMode !== 'force') return;

        if (gs.simulationStartTime && Date.now() - gs.simulationStartTime > MAX_SIMULATION_MS) {
            forceSettle();
            return;
        }

        // Drag/hover node is frozen — physics integrates around it but doesn't move it.
        const frozenNode = gs.dragNode || gs.hoverNode;
        if (frozenNode) { gs.hasSpringEnergy = true; }

        // === Progressive reveal — cascade nodes in by BFS order, batched ===
        if (gs.revealedBatch < gs.revealBatches.length) {
            if (gs.reducedMotion) {
                // a11y: snap all batches in immediately.
                while (gs.revealedBatch < gs.revealBatches.length) {
                    const batch = gs.revealBatches[gs.revealedBatch];
                    for (const id of batch) {
                        gs.nodes[id].hidden = false;
                        gs.nodes[id]._revealScale = 1;
                        gs.nodes[id].vx = 0;
                        gs.nodes[id].vy = 0;
                    }
                    gs.revealedBatch++;
                }
                for (const e of gs.edges) e._revealAlpha = 1;
                gs.alpha = Math.max(gs.alpha, 0.5);
                gs.hasSpringEnergy = true;
                gs.needsDraw = true;
            } else {
                gs.revealFrameCounter++;
                if (gs.revealFrameCounter >= gs.REVEAL_INTERVAL) {
                    gs.revealFrameCounter = 0;
                    const batch = gs.revealBatches[gs.revealedBatch];
                    for (const id of batch) {
                        gs.nodes[id].hidden = false;
                        gs.nodes[id].vx = 0;
                        gs.nodes[id].vy = 0;
                    }
                    gs.revealedBatch++;
                    gs.alpha = Math.max(gs.alpha, 0.5); // reheat so newly revealed nodes integrate.
                    gs.hasSpringEnergy = true;
                    gs.needsDraw = true;
                }
                gs.hasSpringEnergy = true;
            }
        }

        if (gs.alpha < 0.001 && !frozenNode && !gs.hasSpringEnergy && gs.maxDelta < 0.01) return;
        gs.simFrame++;
        // G7: two-phase decay — plateau while hot (~20s above α=0.3), then fast cooldown (~6s).
        if (!frozenNode) gs.alpha *= (gs.alpha > 0.3) ? 0.999 : 0.985;

        // Force parameters read from settings each frame so live sliders take effect immediately.
        const repulsion = gs.settings.graphRepulsion ?? 0.5;
        const gravity   = gs.settings.graphGravity ?? 5.0;
        // G6: extra damping for releaseStabilizeFrames frames post-drag prevents snap-back.
        let damping     = gs.settings.graphDamping ?? 0.50;
        if (gs.releaseStabilizeFrames > 0) {
            damping = Math.min(damping + 0.2, 0.95);
            gs.releaseStabilizeFrames--;
        }

        const CHARGE          = repulsion * 120;             // base for degree-proportional repulsion (sqrt-scaled below).
        const CHARGE_MAX_DIST = 1500 + repulsion * 200;
        const COLLIDE_PAD     = 8;
        const VELOCITY_DECAY  = 1 - damping;
        const MAX_DISP        = 40 + repulsion * 80;
        const GLOBAL_GRAVITY  = gravity * 0.003;

        const { nodes, edges, nodeDegree, linkStrengths, tagPairs, sharedNeighborPairs } = gs;

        // Adaptive hub detection: hub-heavy graphs (max/avg deg > 5) get +50% repulsion and
        // -50% community-cluster pull so hubs don't collapse onto their cluster centroids.
        let maxDeg = 0, avgDeg = 0, countDeg = 0;
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].orphan) continue;
            const d = nodeDegree[i] || 0;
            if (d > maxDeg) maxDeg = d;
            avgDeg += d; countDeg++;
        }
        avgDeg = countDeg > 0 ? avgDeg / countDeg : 1;
        const hubRatio = avgDeg > 0 ? maxDeg / avgDeg : 1;
        const hubRepulsionMul = hubRatio > 5 ? 1.5 : 1.0;
        const hubClusterMul = hubRatio > 5 ? 0.5 : 1.0;

        buildSpatialGrid(nodes, CHARGE_MAX_DIST);

        // Repulsion: ForceAtlas2 "Dissuade Hubs" — force ∝ √(d_i × d_j). Each cell pair is
        // visited once via 4 neighbor offsets ([0,1],[1,-1],[1,0],[1,1]) to avoid double-counting.
        const chargeDist2 = CHARGE_MAX_DIST * CHARGE_MAX_DIST;
        if (_gridCells) {
            for (let row = 0; row < _gridRows; row++) {
                for (let col = 0; col < _gridCols; col++) {
                    const cellIdx = row * _gridCols + col;
                    const cellA = _gridCells[cellIdx];
                    if (!cellA) continue;
                    for (let ai = 0; ai < cellA.length; ai++) {
                        const i = cellA[ai];
                        const di = (nodeDegree[i] || 0) + 1;
                        for (let aj = ai + 1; aj < cellA.length; aj++) {
                            const j = cellA[aj];
                            let ddx = nodes[j].x - nodes[i].x;
                            let ddy = nodes[j].y - nodes[i].y;
                            const dist2 = ddx * ddx + ddy * ddy;
                            if (dist2 > chargeDist2) continue;
                            let dist;
                            if (dist2 < 0.01) {
                                // Coincident nodes: pick a random direction so they separate.
                                const angle = Math.random() * Math.PI * 2;
                                ddx = Math.cos(angle);
                                ddy = Math.sin(angle);
                                dist = 0.1;
                            } else {
                                dist = Math.sqrt(dist2);
                            }
                            const dj = (nodeDegree[j] || 0) + 1;
                            const force = CHARGE * Math.sqrt(di * dj) * hubRepulsionMul * gs.alpha / dist;
                            const ux = ddx / dist, uy = ddy / dist;
                            nodes[i].vx -= ux * force;
                            nodes[i].vy -= uy * force;
                            nodes[j].vx += ux * force;
                            nodes[j].vy += uy * force;
                        }
                        const neighborOffsets = [
                            [0, 1], [1, -1], [1, 0], [1, 1],
                        ];
                        for (const [dr, dc] of neighborOffsets) {
                            const nr = row + dr, nc = col + dc;
                            if (nr < 0 || nr >= _gridRows || nc < 0 || nc >= _gridCols) continue;
                            const cellB = _gridCells[nr * _gridCols + nc];
                            if (!cellB) continue;
                            for (let bj = 0; bj < cellB.length; bj++) {
                                const j = cellB[bj];
                                let ddx = nodes[j].x - nodes[i].x;
                                let ddy = nodes[j].y - nodes[i].y;
                                const dist2 = ddx * ddx + ddy * ddy;
                                if (dist2 > chargeDist2) continue;
                                let dist;
                                if (dist2 < 0.01) {
                                    const angle = Math.random() * Math.PI * 2;
                                    ddx = Math.cos(angle);
                                    ddy = Math.sin(angle);
                                    dist = 0.1;
                                } else {
                                    dist = Math.sqrt(dist2);
                                }
                                const dj = (nodeDegree[j] || 0) + 1;
                                const force = CHARGE * Math.sqrt(di * dj) * hubRepulsionMul * gs.alpha / dist;
                                const ux = ddx / dist, uy = ddy / dist;
                                nodes[i].vx -= ux * force;
                                nodes[i].vy -= uy * force;
                                nodes[j].vx += ux * force;
                                nodes[j].vy += uy * force;
                            }
                        }
                    }
                }
            }
        }

        // Link attraction: LinLog (logarithmic) attraction with hub penalty.
        // - LinLog (log(1+dist)) spreads clusters apart vs. linear which collapses them.
        // - hubPenalty: high-degree pairs attract less, so hubs don't pull all neighbors onto themselves.
        // - weightFactor: log(1+w) amplifies stronger relationships without exploding force scale.
        for (let e = 0; e < edges.length; e++) {
            const a = edges[e].from, b = edges[e].to;
            if (nodes[a].hidden || nodes[b].hidden || nodes[a].orphan || nodes[b].orphan) continue;
            const ddx = nodes[b].x - nodes[a].x;
            const ddy = nodes[b].y - nodes[a].y;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            const logDist = Math.log(1 + dist);
            const degProduct = (nodeDegree[a] || 1) * (nodeDegree[b] || 1);
            const hubPenalty = 1 / (1 + Math.log(1 + degProduct));
            const weight = edges[e].weight || 1;
            const weightFactor = 1 + Math.log(weight);
            const strength = linkStrengths[e];
            const force = logDist * hubPenalty * weightFactor * strength * gs.alpha * 2;
            const ux = ddx / dist, uy = ddy / dist;
            if (nodes[a] !== frozenNode) { nodes[a].vx += ux * force; nodes[a].vy += uy * force; }
            if (nodes[b] !== frozenNode) { nodes[b].vx -= ux * force; nodes[b].vy -= uy * force; }
        }

        // Same-tag clustering — the strongest clustering force; linear scale by shared tag count.
        for (const pair of tagPairs) {
            const a = nodes[pair.a], b = nodes[pair.b];
            if (a.hidden || b.hidden) continue;
            const ddx = b.x - a.x;
            const ddy = b.y - a.y;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            if (dist < 30) continue;
            const force = 1.5 * pair.shared * gs.alpha;
            const ux = ddx / dist, uy = ddy / dist;
            if (a !== frozenNode) { a.vx += ux * force; a.vy += uy * force; }
            if (b !== frozenNode) { b.vx -= ux * force; b.vy -= uy * force; }
        }

        // n+2 "friends of friends" springs — log-scaled so dense overlap doesn't explode.
        for (const pair of sharedNeighborPairs) {
            const a = nodes[pair.a], b = nodes[pair.b];
            if (a.hidden || b.hidden) continue;
            const ddx = b.x - a.x;
            const ddy = b.y - a.y;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            if (dist < 50) continue;
            const force = 0.3 * Math.log(1 + pair.shared) * gs.alpha;
            const ux = ddx / dist, uy = ddy / dist;
            if (a !== frozenNode) { a.vx += ux * force; a.vy += uy * force; }
            if (b !== frozenNode) { b.vx -= ux * force; b.vy -= uy * force; }
        }

        // Pull each node toward its Louvain-community centroid.
        if (gs.communities && gs.communities.size > 1) {
            updateCommunityCentroids(gs);
            const clusterStrength = 0.02 * hubClusterMul * gs.alpha;
            for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (n === frozenNode || n.pinned || n.hidden || n.orphan) continue;
                if (n.community == null) continue;
                const cm = gs.communities.get(n.community);
                if (!cm || cm.members.length < 2) continue;
                const dx = cm.cx - n.x;
                const dy = cm.cy - n.y;
                n.vx += dx * clusterStrength;
                n.vy += dy * clusterStrength;
            }
        }

        // Center gravity (toward origin) keeps disconnected components from drifting off-canvas.
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i] === frozenNode || nodes[i].pinned || nodes[i].hidden || nodes[i].orphan) continue;
            nodes[i].vx -= nodes[i].x * GLOBAL_GRAVITY * gs.alpha;
            nodes[i].vy -= nodes[i].y * GLOBAL_GRAVITY * gs.alpha;
        }

        // Integrate velocity → position with friction (VELOCITY_DECAY) and per-step displacement clamp.
        let totalSpeed = 0;
        gs.maxDelta = 0;
        const bound = Math.max(gs.W, gs.H) * 3;
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (n === frozenNode || n.pinned || n.hidden || n.orphan) continue;
            n.vx *= (1 - VELOCITY_DECAY);
            n.vy *= (1 - VELOCITY_DECAY);
            const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > MAX_DISP) { n.vx *= MAX_DISP / speed; n.vy *= MAX_DISP / speed; }
            n.x += n.vx; n.y += n.vy;
            n.x = Math.max(-bound, Math.min(bound, n.x));
            n.y = Math.max(-bound, Math.min(bound, n.y));
            totalSpeed += speed;
            gs.maxDelta = Math.max(gs.maxDelta, Math.abs(n.vx), Math.abs(n.vy));
        }

        // Collision pass: cellSize = max collision radius × 2 so any pair that overlaps
        // is in the same or adjacent cells.
        {
            let maxR = 0;
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].hidden || nodes[i].orphan) continue;
                const r = gs.getNodeRadius(nodes[i]) * (nodes[i]._revealScale || 1) + COLLIDE_PAD;
                if (r > maxR) maxR = r;
            }
            const collideCell = maxR * 2 + 1;
            buildSpatialGrid(nodes, collideCell);
            if (_gridCells) {
                for (let row = 0; row < _gridRows; row++) {
                    for (let col = 0; col < _gridCols; col++) {
                        const cellIdx = row * _gridCols + col;
                        const cellA = _gridCells[cellIdx];
                        if (!cellA) continue;
                        for (let ai = 0; ai < cellA.length; ai++) {
                            const i = cellA[ai];
                            if (nodes[i].pinned || nodes[i] === frozenNode) continue;
                            const ri = gs.getNodeRadius(nodes[i]) * (nodes[i]._revealScale || 1) + COLLIDE_PAD;
                            for (let aj = ai + 1; aj < cellA.length; aj++) {
                                const j = cellA[aj];
                                const rj = gs.getNodeRadius(nodes[j]) * (nodes[j]._revealScale || 1) + COLLIDE_PAD;
                                const minD = ri + rj;
                                const ddx = nodes[j].x - nodes[i].x;
                                const ddy = nodes[j].y - nodes[i].y;
                                const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.1;
                                if (dist < minD) {
                                    const push = (minD - dist) * 0.35;
                                    const nx = ddx / dist, ny = ddy / dist;
                                    nodes[i].x -= nx * push; nodes[i].y -= ny * push;
                                    if (!nodes[j].pinned && nodes[j] !== frozenNode) {
                                        nodes[j].x += nx * push; nodes[j].y += ny * push;
                                    }
                                    gs.hasSpringEnergy = true;
                                }
                            }
                            const neighborOffsets = [
                                [0, 1], [1, -1], [1, 0], [1, 1],
                            ];
                            for (const [dr, dc] of neighborOffsets) {
                                const nr = row + dr, nc = col + dc;
                                if (nr < 0 || nr >= _gridRows || nc < 0 || nc >= _gridCols) continue;
                                const cellB = _gridCells[nr * _gridCols + nc];
                                if (!cellB) continue;
                                for (let bj = 0; bj < cellB.length; bj++) {
                                    const j = cellB[bj];
                                    const rj = gs.getNodeRadius(nodes[j]) * (nodes[j]._revealScale || 1) + COLLIDE_PAD;
                                    const minD = ri + rj;
                                    const ddx = nodes[j].x - nodes[i].x;
                                    const ddy = nodes[j].y - nodes[i].y;
                                    const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.1;
                                    if (dist < minD) {
                                        const push = (minD - dist) * 0.35;
                                        const nx = ddx / dist, ny = ddy / dist;
                                        nodes[i].x -= nx * push; nodes[i].y -= ny * push;
                                        if (!nodes[j].pinned && nodes[j] !== frozenNode) {
                                            nodes[j].x += nx * push; nodes[j].y += ny * push;
                                        }
                                        gs.hasSpringEnergy = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        gs.hasSpringEnergy = totalSpeed > Math.max(0.1, nodes.length * 0.005);

        // Auto-save layout when fully revealed AND cool AND quiet (avoids saving mid-jiggle).
        if (!gs.layoutSaved
            && gs.revealedBatch >= gs.revealBatches.length
            && gs.alpha < 0.05
            && gs.maxDelta < 0.5) {
            gs.layoutSaved = true;
            const positions = {};
            for (const n of nodes) {
                if (!n.orphan) positions[n.title] = { x: n.x, y: n.y };
            }
            gs.settings.graphSavedLayout = { positions, timestamp: Date.now() };
            invalidateSettingsCache();
            saveSettingsDebounced();
            gs.simulationStartTime = 0;
            gs.needsDraw = true;
            if (gs.onSettleComplete) gs.onSettleComplete();
        }
    }

    /** Hard-clamp settle: alpha=0, reveal everything, save layout, fire onSettleComplete. */
    function forceSettle() {
        gs.alpha = 0;
        gs.hasSpringEnergy = false;
        gs.maxDelta = 0;
        while (gs.revealedBatch < gs.revealBatches.length) {
            const batch = gs.revealBatches[gs.revealedBatch];
            for (const id of batch) {
                gs.nodes[id].hidden = false;
                gs.nodes[id]._revealScale = 1;
                gs.nodes[id].vx = 0;
                gs.nodes[id].vy = 0;
            }
            gs.revealedBatch++;
        }
        if (!gs.layoutSaved) {
            gs.layoutSaved = true;
            const positions = {};
            for (const n of gs.nodes) {
                if (!n.orphan) positions[n.title] = { x: n.x, y: n.y };
            }
            gs.settings.graphSavedLayout = { positions, timestamp: Date.now() };
            invalidateSettingsCache();
            saveSettingsDebounced();
        }
        gs.simulationStartTime = 0;
        gs.needsDraw = true;
        if (gs.onSettleComplete) gs.onSettleComplete();
    }

    return { simulate, forceSettle };
}
