/**
 * Vault Health — pure detector unit tests (graph-health.js).
 */
import {
    detectBrokenRefs, detectContradictoryGating, detectCircular, detectOrphans,
    detectOverConstant, detectTokenBloat, detectThinHubs, detectSelfRefs, computeHealthFindings,
} from '../src/graph/graph-health.js';
import { test, section, summary, assert, assertEqual, assertNotNull } from './helpers.mjs';
import { makeEntry } from './helpers.mjs';

section('detectBrokenRefs');

test('flags requires/excludes/cascade pointing at a missing title', () => {
    const entries = [
        makeEntry('Castle', { requires: ['Ghost Town'], excludes: ['Nowhere'], cascadeLinks: ['Keep'] }),
        makeEntry('Keep'),
    ];
    const broken = detectBrokenRefs(entries);
    // Ghost Town + Nowhere broken; Keep resolves.
    assertEqual(broken.length, 2, 'two broken refs');
    assert(broken.some(b => b.target === 'Ghost Town' && b.kind === 'requires'), 'requires break flagged');
    assert(broken.some(b => b.target === 'Nowhere' && b.kind === 'excludes'), 'excludes break flagged');
});

test('resolves cross-vault bare titles (case-insensitive)', () => {
    const entries = [makeEntry('Alpha', { requires: ['beta'] }), makeEntry('Beta')];
    assertEqual(detectBrokenRefs(entries).length, 0, 'beta resolves to Beta');
});

section('detectContradictoryGating');

test('flags require ∧ exclude on the same target', () => {
    const entries = [makeEntry('X', { requires: ['War'], excludes: ['War'] }), makeEntry('War')];
    const c = detectContradictoryGating(entries);
    assertEqual(c.length, 1, 'one contradiction');
    assertEqual(c[0].target, 'War', 'target reported');
});

section('detectCircular');

test('mutual requires is one cycle', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { requires: ['A'] })];
    assertEqual(detectCircular(entries).length, 1, 'one back-edge in 2-cycle');
});

test('acyclic requires chain has no cycles', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { requires: ['C'] }), makeEntry('C')];
    assertEqual(detectCircular(entries).length, 0, 'chain is acyclic');
});

test('cascade-only cycle is detected (invariant #4 — not requires-only)', () => {
    const entries = [makeEntry('A', { cascadeLinks: ['B'] }), makeEntry('B', { cascadeLinks: ['A'] })];
    assertEqual(detectCircular(entries).length, 1, 'pure cascade A↔B is one cycle');
});

test('mixed requires+cascade cycle is detected', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { cascadeLinks: ['A'] })];
    assertEqual(detectCircular(entries).length, 1, 'requires→cascade back-edge forms a cycle');
});

section('detectOrphans');

test('flags zero-degree node ids', () => {
    const orphans = detectOrphans([0, 1, 2], (id) => (id === 1 ? 4 : 0));
    assertEqual(orphans, [0, 2], 'ids 0 and 2 are orphans');
});

section('detectOverConstant');

test('sums constant token cost', () => {
    const entries = [
        makeEntry('A', { constant: true, tokenEstimate: 100 }),
        makeEntry('B', { constant: true, tokenEstimate: 50 }),
        makeEntry('C', { tokenEstimate: 999 }),
    ];
    const r = detectOverConstant(entries);
    assertEqual(r.count, 2, 'two constants');
    assertEqual(r.tokens, 150, 'summed token cost');
});

section('detectTokenBloat');

test('percentile outlier above floor is flagged', () => {
    const entries = [50, 50, 50, 50, 1000].map((t, i) => makeEntry(`n${i}`, { tokenEstimate: t }));
    const b = detectTokenBloat(entries, 0.9, 400);
    assertEqual(b.length, 1, 'only the 1000-tok outlier');
    assertEqual(b[0].tokens, 1000, 'right entry');
});

test('uniform-small vault flags nothing (floor respected)', () => {
    const entries = [300, 300, 300, 300].map((t, i) => makeEntry(`n${i}`, { tokenEstimate: t }));
    assertEqual(detectTokenBloat(entries, 0.9, 400).length, 0, 'all below floor → none');
});

test('uniform-LARGE vault flags nothing (no spread, even above floor)', () => {
    const entries = [500, 500, 500, 500, 500].map((t, i) => makeEntry(`n${i}`, { tokenEstimate: t }));
    assertEqual(detectTokenBloat(entries, 0.9, 400).length, 0, 'uniform above floor must not flag all');
});

section('detectSelfRefs');

test('flags an entry whose requires names its own title', () => {
    const entries = [makeEntry('Loop', { requires: ['Loop'] }), makeEntry('Other')];
    const r = detectSelfRefs(entries);
    assertEqual(r.length, 1, 'one self-reference');
    assertEqual(r[0].title, 'Loop', 'Loop flagged');
});

test('self-reference via cascade is flagged; clean entries are not', () => {
    const entries = [makeEntry('A', { cascadeLinks: ['a'] }), makeEntry('B', { requires: ['A'] })];
    const r = detectSelfRefs(entries);
    assertEqual(r.length, 1, 'case-insensitive self cascade flagged');
    assertEqual(r[0].title, 'A', 'only A self-refs');
});

section('detectThinHubs');

test('flags high-degree low-token entries', () => {
    const entries = [makeEntry('Hub', { tokenEstimate: 80 }), makeEntry('Big', { tokenEstimate: 80 })];
    const degreeOf = (id) => (id === 0 ? 10 : 2);
    const thin = detectThinHubs(entries, degreeOf, 6, 160);
    assertEqual(thin.length, 1, 'only the high-degree thin one');
    assertEqual(thin[0].title, 'Hub', 'Hub flagged');
});

section('computeHealthFindings (integration)');

test('aggregates findings + builds severity flag map (fallback edgeCountByNode branch)', () => {
    const entries = [
        makeEntry('Castle', { requires: ['Ghost'] }),         // 0: broken ref (CRIT)
        makeEntry('Lonely'),                                   // 1: orphan (WARN)
        makeEntry('Always', { constant: true, tokenEstimate: 200 }), // 2: over-constant (INFO)
    ];
    // No gs.edges → exercises the headless fallback that derives degree from edgeCountByNode.
    const edgeCountByNode = new Map([[0, 2], [1, 0], [2, 3]]);
    const { findings, flagged } = computeHealthFindings({ _vaultIndex: entries, edgeCountByNode });
    assert(findings.some(f => f.key === 'broken-refs' && f.sev === 3), 'broken-refs CRIT present');
    assert(findings.some(f => f.key === 'orphans' && f.sev === 2), 'orphans WARN present');
    assert(findings.some(f => f.key === 'over-constant'), 'over-constant present');
    assertEqual(flagged.get(0), 3, 'broken-ref node flagged CRIT');
    assertEqual(flagged.get(1), 2, 'orphan node flagged WARN');
    // findings sorted by severity descending
    assert(findings[0].sev >= findings[findings.length - 1].sev, 'sorted by severity');
});

// T-L6b — real gs.edges path: degree must come from the FULL edge set across ALL edge
// types (link/requires/excludes/cascade), independent of edgeVisibility. A link-only or
// excludes-only entry IS connected and must NOT be flagged as an orphan — that is the real
// production invariant the fallback-branch test above cannot exercise (it only sees a degree
// count, not the typed edge list). Edge shape mirrors graph.js addEdge:
// { from, to, type, _idx, weight }.
test('real gs.edges: link-only and excludes-only entries are NOT orphans; bare node is', () => {
    const entries = [
        makeEntry('KeywordHub'),  // 0: connected via a 'link' edge to node 1
        makeEntry('LinkOnly'),    // 1: only structural connection is the link edge (no keyword edge)
        makeEntry('ExcludesOnly'),// 2: only connected via an 'excludes' edge to node 3
        makeEntry('Gateway'),     // 3: connected via the excludes edge to node 2
        makeEntry('TrueOrphan'),  // 4: zero edges — the genuine orphan
    ];
    // FULL edge set — note: NO keyword edges touch nodes 1 or 2; their only connections are
    // a 'link' edge (1) and an 'excludes' edge (2). With DAG mode / legend toggles those edge
    // types can be hidden, which is exactly why degree must NOT be read from a visibility-filtered
    // count for the orphan check.
    const edges = [
        { from: 0, to: 1, type: 'link', _idx: 0, weight: 1 },      // link-only connects node 1
        { from: 2, to: 3, type: 'excludes', _idx: 1, weight: 1 },  // excludes-only connects nodes 2 & 3
    ];
    const { findings, flagged } = computeHealthFindings({ _vaultIndex: entries, edges });

    const orphanFinding = findings.find(f => f.key === 'orphans');
    assertNotNull(orphanFinding, 'an orphan finding exists (TrueOrphan)');
    const orphanIds = orphanFinding ? orphanFinding.nodeIds : [];

    // The real production invariant: link-only / excludes-only entries are connected.
    assert(!orphanIds.includes(1), 'link-only entry (node 1) must NOT be flagged as an orphan');
    assert(!orphanIds.includes(2), 'excludes-only entry (node 2) must NOT be flagged as an orphan');
    assert(!orphanIds.includes(0), 'keyword-hub end of the link edge (node 0) is not an orphan');
    assert(!orphanIds.includes(3), 'gateway end of the excludes edge (node 3) is not an orphan');
    // The genuinely disconnected node IS an orphan — proves the detector still fires.
    assert(orphanIds.includes(4), 'truly disconnected entry (node 4) IS flagged as an orphan');
    assertEqual(orphanFinding ? orphanFinding.count : -1, 1, 'exactly one orphan (only TrueOrphan)');
    assertEqual(flagged.get(4), 2, 'TrueOrphan flagged WARN; link/excludes-only nodes not flagged orphan');
    assertEqual(flagged.has(1), false, 'link-only node not in the flagged map (no orphan, no other finding)');
    assertEqual(flagged.has(2), false, 'excludes-only node not in the flagged map');
});

await summary('Vault Health Tests');
