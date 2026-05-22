/**
 * DeepLore Enhanced — Verdict pure-helper tests
 *
 * Covers shape, perEntry aggregation, diff, ring eviction, prune-victim selection,
 * validateVerdict, and emptyVerdict. ST-importing live store (verdict-store.js) tested
 * separately under integration.mjs once we add a fake-IndexedDB stub there.
 *
 * Run with: node test/verdict.test.mjs
 */

import {
    emptyVerdict,
    buildVerdict,
    buildPerEntry,
    diffVerdicts,
    evictRing,
    selectPruneVictims,
    validateVerdict,
} from '../src/verdict/verdict-pure.js';

import { test, section, summary, assert, assertEqual, assertArrayEquals } from './helpers.mjs';

section('Verdict — emptyVerdict / shape');

test('emptyVerdict returns canonical empty shape', () => {
    const v = emptyVerdict();
    assertEqual(v.genId, null, 'genId null');
    assertEqual(v.chatId, null, 'chatId null');
    assertEqual(v.msgIdx, -1, 'msgIdx sentinel');
    assertEqual(v.epoch, -1, 'epoch sentinel');
    assertEqual(v.lockEpoch, -1, 'lockEpoch sentinel');
    assertEqual(v.ts, 0, 'ts zero');
    assertArrayEquals(v.injectedSources, [], 'injectedSources empty array');
    assertEqual(v.trace, null, 'trace null');
    assertArrayEquals(v.perEntry, [], 'perEntry empty array');
});

section('Verdict — buildVerdict basic');

test('buildVerdict copies trace + injectedSources + identity', () => {
    const trace = {
        genId: 'abc123',
        mode: 'two-stage',
        keywordMatched: [{ title: 'Alice', vaultSource: 'main', matchedBy: 'alice' }],
        aiSelected: [{ title: 'Alice', vaultSource: 'main', confidence: 0.9, reason: 'mentioned' }],
        injected: [{ title: 'Alice', tokens: 50 }],
    };
    const injectedSources = [{ title: 'Alice', filename: 'alice.md', matchedBy: 'alice', priority: 100, tokens: 50, vaultSource: 'main' }];
    const v = buildVerdict({ trace, injectedSources, chatId: 'chat-1', msgIdx: 7, epoch: 3, lockEpoch: 12 });

    assertEqual(v.genId, 'abc123', 'genId propagated from trace');
    assertEqual(v.chatId, 'chat-1', 'chatId set');
    assertEqual(v.msgIdx, 7, 'msgIdx set');
    assertEqual(v.epoch, 3, 'epoch set');
    assertEqual(v.lockEpoch, 12, 'lockEpoch set');
    assert(v.ts > 0, 'ts set');
    assertEqual(v.injectedSources.length, 1, 'injectedSources passed through');
    assertEqual(v.trace.mode, 'two-stage', 'trace passed through');
    assert(v.perEntry.length === 1, 'perEntry aggregated');
});

test('buildVerdict tolerates null trace', () => {
    const v = buildVerdict({ trace: null, injectedSources: [], chatId: null, msgIdx: 0, epoch: 0, lockEpoch: 0 });
    assertEqual(v.trace, null, 'null trace preserved');
    assertEqual(v.genId, null, 'genId null when trace null');
    assertArrayEquals(v.perEntry, [], 'perEntry empty when trace null');
});

test('buildVerdict coerces non-number msgIdx/epoch to sentinels', () => {
    const v = buildVerdict({ trace: null, injectedSources: [], chatId: null, msgIdx: 'oops', epoch: undefined, lockEpoch: null });
    assertEqual(v.msgIdx, -1, 'string msgIdx → sentinel');
    assertEqual(v.epoch, -1, 'undefined epoch → sentinel');
    assertEqual(v.lockEpoch, -1, 'null lockEpoch → sentinel');
});

section('Verdict — buildPerEntry aggregation');

test('buildPerEntry: keyword-matched and injected entry has injected finalState', () => {
    const trace = {
        keywordMatched: [{ title: 'Alice', matchedBy: 'alice', vaultSource: 'main' }],
        injected: [],
    };
    const injectedSources = [{ title: 'Alice', vaultSource: 'main', tokens: 50 }];
    const rows = buildPerEntry(trace, injectedSources);
    assertEqual(rows.length, 1, 'one row');
    assertEqual(rows[0].finalState, 'injected', 'finalState injected (terminal wins)');
    assert(rows[0].reasons.length === 2, 'reason chain: matched + injected');
    assertEqual(rows[0].tokens, 50, 'tokens recorded');
});

test('buildPerEntry: keyword-matched but cooldown-removed has cooldown finalState', () => {
    const trace = {
        keywordMatched: [{ title: 'Alice', matchedBy: 'alice', vaultSource: 'main' }],
        cooldownRemoved: [{ title: 'Alice', vaultSource: 'main', reason: 'cooldown active' }],
        injected: [],
    };
    const rows = buildPerEntry(trace, []);
    assertEqual(rows.length, 1, 'one row');
    assertEqual(rows[0].finalState, 'cooldown', 'finalState cooldown');
});

test('buildPerEntry: budget_cut overrides matched_only but not injected', () => {
    const trace = {
        keywordMatched: [{ title: 'Alice', matchedBy: 'alice', vaultSource: 'main' }],
        budgetCut: [{ title: 'Alice', tokens: 500, priority: 50, vaultSource: 'main' }],
        injected: [],
    };
    const rows = buildPerEntry(trace, []);
    assertEqual(rows[0].finalState, 'budget_cut', 'budget_cut when not injected');
    assertEqual(rows[0].tokens, 500, 'tokens from budgetCut');
});

test('buildPerEntry: AI selected with confidence captures confidence', () => {
    const trace = {
        keywordMatched: [],
        aiSelected: [{ title: 'Bob', confidence: 0.82, reason: 'recurring NPC', vaultSource: 'main' }],
    };
    const rows = buildPerEntry(trace, []);
    assertEqual(rows[0].confidence, 0.82, 'confidence captured');
});

test('buildPerEntry: trackerKey collision across vaultSources stays distinct', () => {
    const trace = {
        keywordMatched: [
            { title: 'Alice', matchedBy: 'alice', vaultSource: 'vault-a' },
            { title: 'Alice', matchedBy: 'alice', vaultSource: 'vault-b' },
        ],
        injected: [],
    };
    const rows = buildPerEntry(trace, []);
    assertEqual(rows.length, 2, 'two distinct entries');
});

test('buildPerEntry: null trace returns empty', () => {
    assertArrayEquals(buildPerEntry(null, []), [], 'null trace → []');
});

test('buildPerEntry: missing stage arrays tolerated', () => {
    const trace = { keywordMatched: [{ title: 'X', matchedBy: 'x', vaultSource: '' }] };
    const rows = buildPerEntry(trace, []);
    assertEqual(rows.length, 1, 'works with sparse trace');
});

section('Verdict — diffVerdicts');

test('diffVerdicts: previous null → empty diff', () => {
    const cur = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: '' }], chatId: null, msgIdx: 0, epoch: 0, lockEpoch: 0 });
    const { added, removed } = diffVerdicts(cur, null);
    assertArrayEquals(added, [], 'added empty');
    assertArrayEquals(removed, [], 'removed empty');
});

test('diffVerdicts: detects added entry', () => {
    const prev = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: '' }], chatId: 'c', msgIdx: 0, epoch: 0, lockEpoch: 0 });
    const cur = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: '' }, { title: 'B', vaultSource: '' }], chatId: 'c', msgIdx: 1, epoch: 0, lockEpoch: 0 });
    const { added, removed } = diffVerdicts(cur, prev);
    assertEqual(added.length, 1, 'one added');
    assertEqual(added[0].title, 'B', 'added is B');
    assertArrayEquals(removed, [], 'removed empty');
});

test('diffVerdicts: detects removed entry', () => {
    const prev = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: '' }, { title: 'B', vaultSource: '' }], chatId: 'c', msgIdx: 0, epoch: 0, lockEpoch: 0 });
    const cur = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: '' }], chatId: 'c', msgIdx: 1, epoch: 0, lockEpoch: 0 });
    const { added, removed } = diffVerdicts(cur, prev);
    assertArrayEquals(added, [], 'added empty');
    assertEqual(removed[0].title, 'B', 'B removed');
});

test('diffVerdicts: vault-source-keyed dedup (same title diff vault → both kept)', () => {
    const prev = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: 'v1' }], chatId: 'c', msgIdx: 0, epoch: 0, lockEpoch: 0 });
    const cur = buildVerdict({ trace: null, injectedSources: [{ title: 'A', vaultSource: 'v2' }], chatId: 'c', msgIdx: 1, epoch: 0, lockEpoch: 0 });
    const { added, removed } = diffVerdicts(cur, prev);
    assertEqual(added.length, 1, 'v2 added');
    assertEqual(removed.length, 1, 'v1 removed');
});

section('Verdict — evictRing');

test('evictRing: under cap returns input', () => {
    const buf = [{ a: 1 }, { a: 2 }, { a: 3 }];
    assertEqual(evictRing(buf, 5).length, 3, 'no eviction');
});

test('evictRing: at cap returns input', () => {
    const buf = [{ a: 1 }, { a: 2 }, { a: 3 }];
    assertEqual(evictRing(buf, 3).length, 3, 'no eviction at cap');
});

test('evictRing: drops oldest', () => {
    const buf = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }];
    const result = evictRing(buf, 3);
    assertEqual(result.length, 3, 'trimmed to cap');
    assertEqual(result[0].a, 3, 'oldest two dropped');
    assertEqual(result[2].a, 5, 'newest preserved');
});

test('evictRing: non-array returns []', () => {
    assertArrayEquals(evictRing(null, 5), [], 'null → []');
    assertArrayEquals(evictRing(undefined, 5), [], 'undefined → []');
});

section('Verdict — selectPruneVictims');

test('selectPruneVictims: empty/short catalog returns []', () => {
    assertArrayEquals(selectPruneVictims([], 50), [], 'empty');
    assertArrayEquals(selectPruneVictims([{ msgIdx: 1, ts: 1, key: 'k' }], 50), [], 'short');
});

test('selectPruneVictims: drops oldest msgIdx beyond cap', () => {
    const catalog = [];
    for (let i = 0; i < 10; i++) catalog.push({ msgIdx: i, ts: i, key: `k${i}` });
    const victims = selectPruneVictims(catalog, 3);
    assertEqual(victims.length, 7, '10 - 3 = 7 victims');
    // newest 3 = msgIdx 7,8,9 survive. Victims = 0..6.
    assert(victims.includes('k0'), 'oldest in victims');
    assert(victims.includes('k6'), 'last surviving boundary in victims');
    assert(!victims.includes('k7'), 'k7 survives');
    assert(!victims.includes('k9'), 'newest survives');
});

test('selectPruneVictims: ts tiebreak on equal msgIdx', () => {
    const catalog = [
        { msgIdx: 5, ts: 10, key: 'old' },
        { msgIdx: 5, ts: 20, key: 'new' },
    ];
    const victims = selectPruneVictims(catalog, 1);
    assertArrayEquals(victims, ['old'], 'older ts evicted on msgIdx tie');
});

section('Verdict — validateVerdict');

test('validateVerdict: rejects null / non-object', () => {
    assert(!validateVerdict(null), 'null rejected');
    assert(!validateVerdict(undefined), 'undefined rejected');
    assert(!validateVerdict('string'), 'string rejected');
    assert(!validateVerdict(123), 'number rejected');
});

test('validateVerdict: rejects missing msgIdx/epoch', () => {
    assert(!validateVerdict({ epoch: 0, injectedSources: [], perEntry: [] }), 'no msgIdx');
    assert(!validateVerdict({ msgIdx: 0, injectedSources: [], perEntry: [] }), 'no epoch');
});

test('validateVerdict: rejects non-array injectedSources/perEntry', () => {
    assert(!validateVerdict({ msgIdx: 0, epoch: 0, injectedSources: {}, perEntry: [] }), 'object injectedSources');
    assert(!validateVerdict({ msgIdx: 0, epoch: 0, injectedSources: [], perEntry: 'oops' }), 'string perEntry');
});

test('validateVerdict: accepts valid record', () => {
    const v = emptyVerdict();
    assert(validateVerdict(v), 'emptyVerdict() valid');
    const built = buildVerdict({ trace: { genId: 'x', keywordMatched: [], injected: [] }, injectedSources: [], chatId: null, msgIdx: 0, epoch: 0, lockEpoch: 0 });
    assert(validateVerdict(built), 'buildVerdict() valid');
});

summary('Verdict Tests');
