/**
 * Disparity filter (Serrano et al.) — backbone extraction.
 *
 * For each edge (i,j) with weight w_ij, p-value at endpoint i is
 *   p_ij = (1 - w_ij / s_i)^(k_i - 1)
 * where s_i = sum of incident edge weights (strength) and k_i = degree.
 * Edge is in the backbone if EITHER endpoint's p-value < alpha (significance threshold).
 *
 * @param {object} gs
 * @param {number} alpha  significance threshold; lower = sparser backbone.
 */
export function computeDisparityFilter(gs, alpha) {
    const { nodes, edges } = gs;

    const strength = new Float64Array(nodes.length);
    const degree = new Uint32Array(nodes.length);

    for (const e of edges) {
        const w = e.weight || 1;
        strength[e.from] += w;
        strength[e.to] += w;
        degree[e.from]++;
        degree[e.to]++;
    }

    let backboneCount = 0;

    for (const e of edges) {
        const w = e.weight || 1;

        const kFrom = degree[e.from];
        const sFrom = strength[e.from];
        let pFrom = 1;
        if (kFrom > 1 && sFrom > 0) {
            // BUG-F5: Clamp ratio to [0,1] — w can exceed sFrom with high mention weights,
            // causing Math.pow(negative, fraction) → NaN
            pFrom = Math.pow(Math.max(0, 1 - w / sFrom), kFrom - 1);
        }

        const kTo = degree[e.to];
        const sTo = strength[e.to];
        let pTo = 1;
        if (kTo > 1 && sTo > 0) {
            // Same BUG-F5 clamp at the "to" endpoint.
            pTo = Math.pow(Math.max(0, 1 - w / sTo), kTo - 1);
        }

        e._backbone = (pFrom < alpha || pTo < alpha);

        // Degree-1 nodes' sole edge is always backbone — disparity filter would otherwise drop them entirely.
        if (kFrom <= 1 || kTo <= 1) e._backbone = true;

        if (e._backbone) backboneCount++;
    }

    gs._backboneCount = backboneCount;
    gs._disparityAlpha = alpha;
}

// ─── Louvain community detection ───

/** @type {string[]} 12-color distinguishable palette indexed by community ID modulo length. */
export const COMMUNITY_PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2',
    '#59a14f', '#edc948', '#b07aa1', '#ff9da7',
    '#9c755f', '#bab0ac', '#86bcb6', '#d37295',
];

/**
 * Louvain modularity optimization (single-pass, 20-iteration cap).
 * Sets `node.community` per node and `gs.communities` metadata map.
 *
 * @param {object} gs
 */
export function computeLouvainCommunities(gs) {
    const { nodes, edges } = gs;
    const n = nodes.length;
    if (n === 0) return;

    // m2 = 2m (twice total edge weight) — modularity formula needs 2m as the denominator.
    let m2 = 0;
    const adj = new Array(n);
    for (let i = 0; i < n; i++) adj[i] = [];

    for (const e of edges) {
        const w = e.weight || 1;
        adj[e.from].push({ node: e.to, weight: w });
        adj[e.to].push({ node: e.from, weight: w });
        m2 += 2 * w;
    }
    if (m2 === 0) {
        // No edges — each node is its own community.
        for (let i = 0; i < n; i++) nodes[i].community = i;
        gs.communities = buildCommunityMeta(gs);
        return;
    }

    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        for (const nb of adj[i]) k[i] += nb.weight;
    }

    // Init: every node is its own singleton community.
    const comm = new Int32Array(n);
    for (let i = 0; i < n; i++) comm[i] = i;

    // Σ_in = sum of weights inside each community; Σ_tot = total incident weight of each community.
    const sigmaIn = new Float64Array(n);
    const sigmaTot = new Float64Array(n);
    for (let i = 0; i < n; i++) sigmaTot[i] = k[i];

    // Phase 1: local moves until no node improves modularity by switching communities.
    const MAX_ITERATIONS = 20;
    // BUG-AUDIT-H17: order allocated once, reshuffled in-place to avoid per-iter allocation.
    const order = Array.from({ length: n }, (_, i) => i);
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        let moved = false;
        // Fisher-Yates shuffle — randomized order improves convergence.
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        for (const i of order) {
            if (nodes[i].orphan) continue;
            const ci = comm[i];

            const neighborComms = new Map();
            let ki_in = 0; // weight from i to its own community.
            for (const nb of adj[i]) {
                const cj = comm[nb.node];
                neighborComms.set(cj, (neighborComms.get(cj) || 0) + nb.weight);
                if (cj === ci) ki_in += nb.weight;
            }

            // Detach i from ci before considering moves so the gain calculation is symmetric.
            sigmaIn[ci] -= 2 * ki_in;
            sigmaTot[ci] -= k[i];

            // bestDelta=0 baseline → "staying" wins ties (initial bestComm=ci).
            let bestComm = ci;
            let bestDelta = 0;

            for (const [cj, ki_cj] of neighborComms) {
                // Δ modularity of moving i into cj (Newman's formula, omitting constant terms).
                const delta = ki_cj - sigmaTot[cj] * k[i] / m2;
                if (delta > bestDelta) {
                    bestDelta = delta;
                    bestComm = cj;
                }
            }

            comm[i] = bestComm;
            const ki_best = neighborComms.get(bestComm) || 0;
            sigmaIn[bestComm] += 2 * ki_best;
            sigmaTot[bestComm] += k[i];

            if (bestComm !== ci) moved = true;
        }

        if (!moved) break;
    }

    // Compact community IDs to a dense 0..C-1 range for palette indexing.
    const uniqueComms = [...new Set(comm)];
    const commMap = new Map();
    uniqueComms.forEach((c, idx) => commMap.set(c, idx));

    for (let i = 0; i < n; i++) {
        nodes[i].community = commMap.get(comm[i]);
    }

    gs.communities = buildCommunityMeta(gs);
}

/**
 * Build community metadata: members[], color (palette-indexed), label, centroid (cx,cy).
 * @returns {Map<number, {id, members, color, label, cx, cy}>}
 */
function buildCommunityMeta(gs) {
    const { nodes } = gs;
    const meta = new Map();

    for (const n of nodes) {
        if (n.community == null) continue;
        if (!meta.has(n.community)) {
            meta.set(n.community, {
                id: n.community,
                members: [],
                color: COMMUNITY_PALETTE[n.community % COMMUNITY_PALETTE.length],
                label: '',
                cx: 0, cy: 0,
            });
        }
        meta.get(n.community).members.push(n);
    }

    // Label = most common non-lorebook tag in the community (every entry has the lorebook tag → useless as a label).
    const lorebookTag = (gs.settings?.lorebookTag || 'lorebook').toLowerCase();
    for (const [, cm] of meta) {
        const tagCounts = new Map();
        for (const n of cm.members) {
            for (const t of (n.tags || [])) {
                if (t.toLowerCase() === lorebookTag) continue;
                tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            }
        }
        let bestTag = '', bestCount = 0;
        for (const [t, c] of tagCounts) {
            if (c > bestCount) { bestTag = t; bestCount = c; }
        }
        // gs._tf injected by graph.js (runtime); absent in headless tests → English fallback.
        cm.label = bestTag || (gs._tf ? gs._tf('dle_graph_cluster_label', cm.id + 1) : `Cluster ${cm.id + 1}`);
    }

    return meta;
}

/** Recompute community centroids — called per physics frame to drive cluster pull. */
export function updateCommunityCentroids(gs) {
    if (!gs.communities) return;
    for (const [, cm] of gs.communities) {
        let sx = 0, sy = 0, count = 0;
        for (const n of cm.members) {
            if (n.hidden || n.orphan) continue;
            sx += n.x; sy += n.y; count++;
        }
        if (count > 0) { cm.cx = sx / count; cm.cy = sy / count; }
    }
}

/** Convex hull via Graham scan. Mutates `points` (swaps pivot to index 0). */
export function convexHull(points) {
    if (points.length < 3) return points.slice();

    // Pivot = bottom-most then left-most point (lex-min on (-y, x)).
    let pivot = 0;
    for (let i = 1; i < points.length; i++) {
        if (points[i].y > points[pivot].y ||
            (points[i].y === points[pivot].y && points[i].x < points[pivot].x)) {
            pivot = i;
        }
    }
    [points[0], points[pivot]] = [points[pivot], points[0]];
    const p0 = points[0];

    // Sort by polar angle around p0; collinear ties broken by distance (nearer first).
    const sorted = points.slice(1).sort((a, b) => {
        const cross = (a.x - p0.x) * (b.y - p0.y) - (a.y - p0.y) * (b.x - p0.x);
        if (cross !== 0) return -cross;
        const da = (a.x - p0.x) ** 2 + (a.y - p0.y) ** 2;
        const db = (b.x - p0.x) ** 2 + (b.y - p0.y) ** 2;
        return da - db;
    });

    const stack = [p0];
    for (const pt of sorted) {
        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            const next = stack[stack.length - 2];
            const cross = (top.x - next.x) * (pt.y - next.y) - (top.y - next.y) * (pt.x - next.x);
            if (cross <= 0) stack.pop();
            else break;
        }
        stack.push(pt);
    }
    return stack;
}

// ─── Gap analysis ───

/**
 * Returns:
 *  - orphans: node ids with zero edges.
 *  - bridges: edge indices that are the SOLE cross-link between two communities (weak bridge).
 *  - typeImbalance: per-community type distribution.
 *  - missingConnections: candidate pairs sharing ≥1 custom-field value but no edge.
 *
 * Requires `communities` (from Louvain).
 */
export function computeGapAnalysis(gs) {
    const { nodes, edges, edgeCountByNode, communities } = gs;

    const orphans = [];
    for (const n of nodes) {
        if ((edgeCountByNode.get(n.id) || 0) === 0) {
            orphans.push(n.id);
        }
    }

    const bridges = [];
    if (communities && communities.size > 1) {
        // Group cross-community edges by undirected community-pair key.
        const crossCounts = new Map();
        const crossEdgeIdxs = new Map();
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            const ca = nodes[e.from].community;
            const cb = nodes[e.to].community;
            if (ca == null || cb == null || ca === cb) continue;
            const key = `${Math.min(ca, cb)},${Math.max(ca, cb)}`;
            crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
            if (!crossEdgeIdxs.has(key)) crossEdgeIdxs.set(key, []);
            crossEdgeIdxs.get(key).push(i);
        }
        for (const [key, count] of crossCounts) {
            if (count === 1) {
                bridges.push(...crossEdgeIdxs.get(key));
            }
        }
    }

    const typeImbalance = new Map();
    if (communities) {
        for (const [cid, cm] of communities) {
            const counts = { regular: 0, constant: 0, seed: 0, bootstrap: 0 };
            for (const n of cm.members) {
                counts[n.type] = (counts[n.type] || 0) + 1;
            }
            typeImbalance.set(cid, { label: cm.label, total: cm.members.length, ...counts });
        }
    }

    // Missing connections: pairs sharing ≥1 custom-field value but no existing edge.
    // Hard-capped at 200 candidates — beyond that the O(n²) scan would stall the popup.
    const missingConnections = [];
    const edgeSet = new Set();
    for (const e of edges) {
        edgeSet.add(`${Math.min(e.from, e.to)},${Math.max(e.from, e.to)}`);
    }
    const candidates = nodes.filter(n => !n.orphan && !n.hidden);
    if (candidates.length <= 200) {
        const vaultIndex = gs._vaultIndex;
        for (let i = 0; i < candidates.length; i++) {
            const ni = candidates[i];
            const ei = vaultIndex?.[ni.id];
            if (!ei) continue;
            for (let j = i + 1; j < candidates.length; j++) {
                const nj = candidates[j];
                const ej = vaultIndex?.[nj.id];
                if (!ej) continue;
                const key = `${Math.min(ni.id, nj.id)},${Math.max(ni.id, nj.id)}`;
                if (edgeSet.has(key)) continue;

                let shared = false;
                const cfi = ei.customFields || {};
                const cfj = ej.customFields || {};
                for (const key of Object.keys(cfi)) {
                    const vi = cfi[key];
                    const vj = cfj[key];
                    if (vi == null || vj == null) continue;
                    // BUG-AUDIT-13: normalize scalars to arrays so e.g. era:"modern" compares
                    // correctly against era:["modern"] — mixed-shape custom fields are common.
                    const arrI = Array.isArray(vi) ? vi : [vi];
                    const arrJ = Array.isArray(vj) ? vj : [vj];
                    if (arrI.some(v => arrJ.includes(v))) { shared = true; break; }
                }
                if (shared) {
                    missingConnections.push({ a: ni.id, b: nj.id, aTitle: ni.title, bTitle: nj.title });
                }
            }
        }
    }

    return { orphans, bridges, typeImbalance, missingConnections };
}
