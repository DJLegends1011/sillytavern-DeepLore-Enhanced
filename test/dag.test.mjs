/**
 * Layered DAG layout — pure-helper unit tests (graph-dag.js).
 * Cycle-breaking, longest-path layering, deterministic ordering, coordinate assignment.
 */
import { breakCycles, assignLayers, groupByLayer, computeDagPositions, initDagLayout } from '../src/graph/graph-dag.js';
import { test, section, summary, assert, assertEqual } from './helpers.mjs';

const titleOf = (id) => `n${id}`;

section('breakCycles');

test('acyclic chain keeps all edges', () => {
    const { acyclic, removed } = breakCycles([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
    assertEqual(acyclic.length, 2, 'both edges kept');
    assertEqual(removed.size, 0, 'no back-edges removed');
});

test('2-cycle drops exactly one edge', () => {
    const { acyclic, removed } = breakCycles([1, 2], [{ from: 1, to: 2 }, { from: 2, to: 1 }]);
    assertEqual(removed.size, 1, 'one back-edge removed');
    assertEqual(acyclic.length, 1, 'one edge survives');
});

test('3-cycle is broken to a path', () => {
    const ids = [1, 2, 3];
    const { acyclic, removed } = breakCycles(ids, [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]);
    assertEqual(removed.size, 1, 'one back-edge removed from 3-cycle');
    assertEqual(acyclic.length, 2, 'two edges survive');
    // Surviving projection must itself be acyclic (assignLayers must terminate with distinct layers).
    const layer = assignLayers(ids, acyclic);
    assert(new Set([...layer.values()]).size >= 2, 'broken cycle yields ≥2 distinct layers');
});

test('self-loop is ignored, not crashing', () => {
    const { acyclic, removed } = breakCycles([1], [{ from: 1, to: 1 }]);
    assertEqual(acyclic.length, 0, 'self-loop excluded from acyclic projection');
    assertEqual(removed.size, 0, 'self-loop not counted as a back-edge');
});

test('edges to ids outside the subgraph are ignored', () => {
    const { acyclic } = breakCycles([1, 2], [{ from: 1, to: 2 }, { from: 2, to: 99 }]);
    assertEqual(acyclic.length, 1, 'edge to non-participant dropped');
});

section('assignLayers (longest path)');

test('linear chain assigns increasing layers', () => {
    const layer = assignLayers([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
    assertEqual(layer.get(1), 0, 'root at layer 0');
    assertEqual(layer.get(2), 1, 'mid at layer 1');
    assertEqual(layer.get(3), 2, 'leaf at layer 2');
});

test('diamond uses longest path for the sink', () => {
    // 1→2, 1→3, 2→4, 3→4  ⇒ 4 must be layer 2 (longest path), not 1.
    const layer = assignLayers([1, 2, 3, 4], [
        { from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 },
    ]);
    assertEqual(layer.get(1), 0, '1 at 0');
    assertEqual(layer.get(2), 1, '2 at 1');
    assertEqual(layer.get(3), 1, '3 at 1');
    assertEqual(layer.get(4), 2, 'sink at longest-path layer 2');
});

test('unequal branch lengths push sink to the longest', () => {
    // 1→2→3→5 and 1→4→5  ⇒ 5 at layer 3.
    const layer = assignLayers([1, 2, 3, 4, 5], [
        { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 5 }, { from: 1, to: 4 }, { from: 4, to: 5 },
    ]);
    assertEqual(layer.get(5), 3, 'sink at longest path (3)');
});

section('groupByLayer (deterministic ordering)');

test('within-layer order is by title then id', () => {
    const ids = [3, 1, 2];
    const layer = new Map([[3, 0], [1, 0], [2, 0]]);
    const byL = groupByLayer(ids, layer, titleOf);
    assertEqual(byL.get(0), [1, 2, 3], 'sorted by title (n1,n2,n3)');
});

section('computeDagPositions');

test('chain: y increases with dependency depth, centered', () => {
    const ids = [1, 2, 3];
    const { positions, layer, maxLayer } = computeDagPositions(
        ids, [{ from: 1, to: 2 }, { from: 2, to: 3 }], { titleOf },
    );
    assertEqual(maxLayer, 2, 'maxLayer = 2');
    assert(positions.get(3).y > positions.get(1).y, 'deeper node sits lower (larger y)');
    assert(positions.get(2).y > positions.get(1).y, 'mid below root');
    // single node per layer ⇒ x centered at 0
    assertEqual(positions.get(1).x, 0, 'lone root centered on x=0');
    assert(layer.get(3) === 2, 'layer map returned');
});

test('siblings on the same layer get distinct x', () => {
    const ids = [1, 2, 3];
    const { positions } = computeDagPositions(
        ids, [{ from: 1, to: 2 }, { from: 1, to: 3 }], { titleOf },
    );
    assert(positions.get(2).x !== positions.get(3).x, 'siblings separated on x');
    assertEqual(positions.get(2).y, positions.get(3).y, 'siblings share a row');
});

test('cyclic input still produces a finite layout', () => {
    const ids = [1, 2, 3];
    const { positions, removed } = computeDagPositions(
        ids, [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }], { titleOf },
    );
    assert(removed.size === 1, 'one cycle edge broken');
    for (const id of ids) {
        const p = positions.get(id);
        assert(p && Number.isFinite(p.x) && Number.isFinite(p.y), `n${id} has finite coords`);
    }
});

section('DAG enter/exit state restore (regression guard — gotcha: layout enter/exit must restore force state)');

function makeGsStub() {
    // 0→1 requires, 1→2 cascade, node 3 isolated orphan, node 4 plain non-participant.
    const nodes = [0, 1, 2, 3, 4].map(i => ({
        id: i, x: i * 10, y: i * 7, vx: 0, vy: 0,
        hidden: false, orphan: i === 3, title: 'n' + i,
        pinned: false, revealBatchIdx: null, _revealScale: 1,
    }));
    const edges = [{ from: 0, to: 1, type: 'requires' }, { from: 1, to: 2, type: 'cascade' }];
    return {
        nodes, edges,
        edgeVisibility: { link: true, requires: true, excludes: true, cascade: true },
        edgeCountByNode: new Map([[0, 1], [1, 2], [2, 1], [3, 0], [4, 0]]),
        W: 800, H: 600, revealedBatch: 0, cachedVisibleCount: nodes.length, layoutMode: 'force',
        buildAdjacency() {}, fitToView() {},
    };
}

test('enter() restricts edges, hides non-participants, stages targets', () => {
    const gs = makeGsStub();
    initDagLayout(gs, null);
    const ok = gs.enterDagLayout();
    assert(ok === true, 'enter succeeded with participants present');
    assertEqual(gs.layoutMode, 'dag', 'layoutMode = dag');
    assertEqual(gs.edgeVisibility.link, false, 'link edges hidden in DAG');
    assertEqual(gs.edgeVisibility.excludes, false, 'excludes hidden in DAG');
    assert(gs.edgeVisibility.requires && gs.edgeVisibility.cascade, 'requires+cascade visible');
    assertEqual(gs.cachedVisibleCount, 3, 'cachedVisibleCount = participant count (0,1,2)');
    assert(gs.nodes[3].hidden && gs.nodes[4].hidden, 'non-participants hidden');
    assert(gs.nodes[0]._targetX != null && gs.nodes[0].pinned && gs.nodes[0]._layoutPinned, 'participant staged + pinned');
    assert(!('settings' in gs), 'enter never touches settings (no graphSavedLayout write at layout layer)');
});

test('exit() restores edgeVisibility, cachedVisibleCount, hidden, and clears targets', () => {
    const gs = makeGsStub();
    initDagLayout(gs, null);
    gs.enterDagLayout();
    gs.exitDagLayout();
    assertEqual(gs.layoutMode, 'force', 'layoutMode back to force');
    assertEqual(gs.edgeVisibility.link, true, 'link visibility restored');
    assertEqual(gs.edgeVisibility.excludes, true, 'excludes visibility restored');
    assertEqual(gs.cachedVisibleCount, 5, 'cachedVisibleCount restored to nodes.length');
    assertEqual(gs._preLayoutPositions, null, 'snapshot cleared');
    assert(gs.nodes[0]._targetX === undefined, 'staged target deleted');
    assert(!gs.nodes[0].pinned && !gs.nodes[0]._layoutPinned, 'layout pin released');
    assertEqual(gs.nodes[0].hidden, false, 'connected node un-hidden on exit');
    assertEqual(gs.nodes[3].hidden, true, 'orphan stays hidden per reveal formula');
});

test('enter() with no requires/cascade is a no-op (stays force)', () => {
    const gs = makeGsStub();
    gs.edges = []; // strip directed edges
    initDagLayout(gs, null);
    const ok = gs.enterDagLayout();
    assert(ok === false, 'enter returns false with no participants');
    assertEqual(gs.layoutMode, 'force', 'layout stays force');
});

await summary('DAG Layout Tests');
