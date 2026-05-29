/**
 * Vault Health — pure detector unit tests (graph-health.js).
 */
import {
    detectBrokenRefs, detectContradictoryGating, detectCircular, detectOrphans,
    detectOverConstant, detectTokenBloat, detectThinHubs, computeHealthFindings,
} from '../src/graph/graph-health.js';
import { test, section, summary, assert, assertEqual } from './helpers.mjs';
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

section('detectThinHubs');

test('flags high-degree low-token entries', () => {
    const entries = [makeEntry('Hub', { tokenEstimate: 80 }), makeEntry('Big', { tokenEstimate: 80 })];
    const degreeOf = (id) => (id === 0 ? 10 : 2);
    const thin = detectThinHubs(entries, degreeOf, 6, 160);
    assertEqual(thin.length, 1, 'only the high-degree thin one');
    assertEqual(thin[0].title, 'Hub', 'Hub flagged');
});

section('computeHealthFindings (integration)');

test('aggregates findings + builds severity flag map', () => {
    const entries = [
        makeEntry('Castle', { requires: ['Ghost'] }),         // 0: broken ref (CRIT)
        makeEntry('Lonely'),                                   // 1: orphan (WARN)
        makeEntry('Always', { constant: true, tokenEstimate: 200 }), // 2: over-constant (INFO)
    ];
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

await summary('Vault Health Tests');
