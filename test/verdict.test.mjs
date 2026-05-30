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
    selectPruneVictimsFromOrderedKeys,
    shouldRunPruneScan,
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

// ============================================================================
// Wave C P1 perf fix: pruneCurrentChat sampling + bounded cursor (2026-05-22)
// ============================================================================

section('Verdict — shouldRunPruneScan (sampling gate)');

test('shouldRunPruneScan: rate=10 only true on every 10th call', () => {
    const hits = [];
    for (let i = 1; i <= 30; i++) {
        if (shouldRunPruneScan(i, 10)) hits.push(i);
    }
    assertArrayEquals(hits, [10, 20, 30], 'scans on calls 10, 20, 30 only');
});

test('shouldRunPruneScan: rate=1 always scans (degenerate / disabled sampling)', () => {
    for (let i = 1; i <= 5; i++) {
        assert(shouldRunPruneScan(i, 1), `call ${i} scans when rate=1`);
    }
});

test('shouldRunPruneScan: rate=0 or negative or NaN → always scan (safe default)', () => {
    assert(shouldRunPruneScan(1, 0), 'rate=0 safe default scans');
    assert(shouldRunPruneScan(1, -5), 'negative rate safe default scans');
    assert(shouldRunPruneScan(1, NaN), 'NaN rate safe default scans');
});

test('shouldRunPruneScan: cuts ~90% of work at rate=10 (perf invariant)', () => {
    let scans = 0;
    const total = 1000;
    for (let i = 1; i <= total; i++) if (shouldRunPruneScan(i, 10)) scans++;
    assertEqual(scans, 100, '100 scans for 1000 calls at rate=10');
    // 90% reduction — matches gotcha #52 documented behaviour.
});

section('Verdict — selectPruneVictimsFromOrderedKeys (bounded-cursor variant)');

test('selectPruneVictimsFromOrderedKeys: under cap returns []', () => {
    assertArrayEquals(selectPruneVictimsFromOrderedKeys([], 10), [], 'empty');
    assertArrayEquals(selectPruneVictimsFromOrderedKeys(['a', 'b'], 10), [], 'under cap');
});

test('selectPruneVictimsFromOrderedKeys: at cap returns []', () => {
    assertArrayEquals(selectPruneVictimsFromOrderedKeys(['a', 'b', 'c'], 3), [], 'at cap');
});

test('selectPruneVictimsFromOrderedKeys: drops leading slice when over cap', () => {
    // Keys are oldest-first from the cursor — leading slice is oldest.
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
    const victims = selectPruneVictimsFromOrderedKeys(keys, 3);
    assertArrayEquals(victims, ['k0', 'k1'], 'two oldest evicted, newest three survive');
});

test('selectPruneVictimsFromOrderedKeys: matches selectPruneVictims for ordered input', () => {
    // Cross-check: when the cursor walk produces a properly-ordered key list,
    // the new bounded helper should select the same victims as the legacy
    // catalog-based helper. Both must agree to preserve VRD-6 semantics.
    const catalog = [];
    const orderedKeys = [];
    for (let i = 0; i < 250; i++) {
        const key = `chat-A:${String(i).padStart(6, '0')}:${1000 + i}`;
        catalog.push({ msgIdx: i, ts: 1000 + i, key });
        orderedKeys.push(key);
    }
    const fromCatalog = selectPruneVictims(catalog, 200).sort();
    const fromKeys = selectPruneVictimsFromOrderedKeys(orderedKeys, 200).sort();
    assertArrayEquals(fromKeys, fromCatalog, 'both helpers agree on victim set');
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

// ============================================================================
// T-L10 — verdict prune/list cross-chat lexicographic-exclusion guard (GREEN)
//
// CONTEXT: an early review draft called the verdict prune a cross-chat
// data-corruption bug — "deleting chat `Alice` also nukes `Alice2`/`Alicia`
// because their keys share the `Alice` prefix." That premise is LEXICOGRAPHICALLY
// FALSE. IDB keys are `${chatId}:${paddedMsgIdx}:${ts}` (see buildIdbKey), and
// every chat-scoped op (listIdbForChat → hydrateChat/clearChatIdb, and
// pruneCurrentChat) bounds its range to `IDBKeyRange.bound('Alice:', 'Alice:￿')`.
// The `:` delimiter (0x3A) is what makes the prefix unambiguous:
//   - 'Alice2…' : char after 'Alice' is '2' (0x32) < ':' (0x3A)
//                 → sorts BELOW the lower bound 'Alice:' → EXCLUDED.
//   - 'Alicia…' : char after 'Alice' is 'i' (0x69) > ':' (0x3A)
//                 → sorts ABOVE the upper bound 'Alice:￿' → EXCLUDED.
// So both siblings fall outside the range — for OPPOSITE lexicographic reasons.
// This test pins that contract by driving the REAL production store code
// (hydrateChat / pruneCurrentChat / clearChatIdb — all of which construct the
// real range via the production IDBKeyRange.bound call) against a fake IDB that
// honors IDBKeyRange.bound string-key semantics. A future delimiter change that
// re-introduced the collision (e.g. switching `:` for something that doesn't sit
// between the digits and the letters) would flip these assertions RED.
//
// Severity note: demoted CRITICAL → LOW per the thermo-nuclear verification pass
// (a real `:`-in-chatId collision is impossible — ST sources chatId from chat
// filenames, where sanitize-filename strips `:`). This is a hardening guard, not
// a reproduce-test.
// ============================================================================

section('Verdict — T-L10 prune/list cross-chat lexicographic exclusion (guard)');

/**
 * Minimal in-memory IDB-shaped fake for the chat-scoped read/prune/delete paths.
 *
 * FIDELITY to the real IndexedDB / IDBKeyRange.bound that this test relies on:
 *  - `IDBKeyRange.bound(lower, upper)` models the DEFAULT inclusive-inclusive
 *    bounds (open=false) — matching how verdict-store.js calls it (two-arg form,
 *    no open flags). Membership is pure string comparison `k >= lower && k <= upper`,
 *    which is exactly the byte-order JS `<`/`>` use on strings and is the same
 *    total ordering IndexedDB applies to string keys (UTF-16 code-unit order;
 *    the BMP `￿` upper sentinel the production code uses behaves identically).
 *    THIS is the load-bearing fidelity — the lexicographic exclusion under test.
 *  - `getAll(range)` and `openKeyCursor(range, 'next')` both filter the seeded
 *    rows by that range and (for the cursor) walk oldest-first via sorted keys.
 *  - `put`/`delete`/`clear` mutate the backing array so post-op row counts assert
 *    real deletion. `transaction().oncomplete` fires on a microtask so the live
 *    `txDone` promise resolves.
 *  - NOT modeled (irrelevant here): index/keyPath stores, versioning beyond a
 *    no-op onupgradeneeded, error/abort injection, multi-arg range open flags.
 *
 * This is a from-scratch local fake (the regression.test.mjs makeFakeIdbForPrune
 * shim is not exported); it deliberately mirrors that shim's IDBKeyRange.bound
 * `includes` semantics so the two stay conceptually aligned.
 */
function makeFakeIdbForChats(records) {
    const calls = {
        cursorRanges: [],   // {lower, upper} for every openKeyCursor
        getAllRanges: [],   // {lower, upper} for every getAll(range)
        deletes: [],        // keys deleted
    };
    const fakeIDBKeyRange = {
        bound(lower, upper) {
            // Default inclusive bounds (open=false), pure string comparison —
            // identical ordering to IndexedDB's string-key total order.
            return { _lower: lower, _upper: upper, includes(k) { return k >= lower && k <= upper; } };
        },
    };
    function inRange(range) {
        return records.map(r => r._key).filter(k => range.includes(k)).sort();
    }
    function makeStore() {
        return {
            getAll(range) {
                calls.getAllRanges.push(range ? { lower: range._lower, upper: range._upper } : null);
                const keys = inRange(range);
                const keySet = new Set(keys);
                const req = { onsuccess: null, onerror: null, result: null };
                queueMicrotask(() => {
                    req.result = records.filter(r => keySet.has(r._key)).map(r => r._value);
                    if (req.onsuccess) req.onsuccess();
                });
                return req;
            },
            openKeyCursor(range, direction) {
                calls.cursorRanges.push({ lower: range._lower, upper: range._upper });
                const keys = inRange(range);
                let i = 0;
                const req = { onsuccess: null, onerror: null, result: null };
                const advance = () => {
                    if (i >= keys.length) {
                        req.result = null;
                        if (req.onsuccess) req.onsuccess();
                        return;
                    }
                    req.result = { key: keys[i], continue() { i++; queueMicrotask(advance); } };
                    if (req.onsuccess) req.onsuccess();
                };
                queueMicrotask(advance);
                return req;
            },
            delete(key) {
                calls.deletes.push(key);
                const idx = records.findIndex(r => r._key === key);
                if (idx >= 0) records.splice(idx, 1);
                return { onsuccess: null, onerror: null };
            },
            put(value, key) { records.push({ _key: key, _value: value }); return { onsuccess: null, onerror: null }; },
            clear() { records.length = 0; return { onsuccess: null, onerror: null }; },
        };
    }
    function makeDb() {
        return {
            objectStoreNames: { contains: () => true },
            transaction() {
                const store = makeStore();
                const tx = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null };
                queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
                return tx;
            },
            close() {},
        };
    }
    return {
        indexedDB: {
            open() {
                const req = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, result: makeDb() };
                queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
                return req;
            },
        },
        IDBKeyRange: fakeIDBKeyRange,
        calls,
    };
}

// Build a valid verdict IDB row whose _key matches buildIdbKey(value).
function _row(chatId, msgIdx, ts) {
    const value = {
        chatId, msgIdx, ts, epoch: 0,
        injectedSources: [{ title: `E${msgIdx}`, vaultSource: '' }],
        perEntry: [], trace: null,
    };
    const key = `${chatId}:${String(msgIdx).padStart(6, '0')}:${ts}`;
    return { _key: key, _value: value };
}

// Three lexicographic siblings: the `:` delimiter is the only thing keeping
// 'Alice'`s namespace disjoint from 'Alice2' / 'Alicia'. Each chat gets 2 rows.
function _siblingRecords() {
    return [
        _row('Alice', 0, 1000),
        _row('Alice', 1, 1001),
        _row('Alice2', 0, 2000),
        _row('Alice2', 1, 2001),
        _row('Alicia', 0, 3000),
        _row('Alicia', 1, 3001),
    ];
}

test('T-L10: lexical reality check — siblings are excluded by the `:` delimiter for OPPOSITE reasons', () => {
    // Pin the byte-order facts the whole guard rests on. If a future delimiter
    // change broke either inequality, the production range would stop excluding
    // a sibling and the IDB tests below would (correctly) go red.
    assert(':'.charCodeAt(0) === 0x3a, "':' is 0x3A");
    assert('2'.charCodeAt(0) === 0x32, "'2' is 0x32");
    assert('i'.charCodeAt(0) === 0x69, "'i' is 0x69");
    assert('Alice2:' < 'Alice:', "'Alice2:' sorts BELOW lower bound 'Alice:' (digit < colon)");
    assert('Alicia:' > 'Alice:￿', "'Alicia:' sorts ABOVE upper bound 'Alice:\\uFFFF' (letter > colon)");
});

test('T-L10: hydrateChat(\'Alice\') loads ONLY Alice rows — siblings excluded (real listIdbForChat range)', async () => {
    const store = await import('../src/verdict/verdict-store.js');
    store.resetForTests();

    const records = _siblingRecords();
    const fake = makeFakeIdbForChats(records);
    const prevIdb = globalThis.indexedDB;
    const prevRange = globalThis.IDBKeyRange;
    globalThis.indexedDB = fake.indexedDB;
    globalThis.IDBKeyRange = fake.IDBKeyRange;

    try {
        store.setCurrentChatId('Alice');
        // hydrateChat drives the REAL listIdbForChat → real IDBKeyRange.bound('Alice:','Alice:￿').
        const count = await store.hydrateChat('Alice');
        assertEqual(count, 2, 'exactly Alice\'s 2 rows hydrated (Alice2/Alicia not pulled in)');

        // The range actually requested by production must be the colon-delimited prefix.
        assert(fake.calls.getAllRanges.length >= 1, 'getAll(range) was called');
        const r = fake.calls.getAllRanges[0];
        assertEqual(r.lower, 'Alice:', 'lower bound = chatId + ":"');
        assert(r.upper.startsWith('Alice:'), 'upper bound stays inside the Alice: namespace');

        // Every hydrated verdict belongs to Alice — no sibling leakage into the ring.
        const ring = store._debugRingSnapshot();
        assertEqual(ring.length, 2, 'ring holds exactly the 2 Alice verdicts');
        assert(ring.every(v => v.chatId === 'Alice'), 'no Alice2/Alicia verdict leaked into the ring');
    } finally {
        globalThis.indexedDB = prevIdb;
        globalThis.IDBKeyRange = prevRange;
        store.resetForTests();
    }
});

test('T-L10: pruneCurrentChat(\'Alice\') cursor range never visits sibling keys', async () => {
    const store = await import('../src/verdict/verdict-store.js');
    store.resetForTests();

    // 5 Alice rows so prune has something to walk; siblings present but out of range.
    const records = [
        _row('Alice', 0, 1000), _row('Alice', 1, 1001), _row('Alice', 2, 1002),
        _row('Alice', 3, 1003), _row('Alice', 4, 1004),
        _row('Alice2', 0, 2000), _row('Alice2', 1, 2001),
        _row('Alicia', 0, 3000), _row('Alicia', 1, 3001),
    ];
    const fake = makeFakeIdbForChats(records);
    const prevIdb = globalThis.indexedDB;
    const prevRange = globalThis.IDBKeyRange;
    globalThis.indexedDB = fake.indexedDB;
    globalThis.IDBKeyRange = fake.IDBKeyRange;

    try {
        store.setCurrentChatId('Alice');
        store._setPruneSampleRateForTests(1); // force the scan
        // Cap is 200 → no deletes expected here; the point is the cursor RANGE.
        const deleted = await store._invokePruneForTests();
        assertEqual(deleted, 0, 'under cap → no deletes (sibling safety, not eviction, is the subject)');

        assertEqual(fake.calls.cursorRanges.length, 1, 'cursor opened exactly once');
        const r = fake.calls.cursorRanges[0];
        assertEqual(r.lower, 'Alice:', 'cursor lower bound = "Alice:"');
        assert(r.upper.startsWith('Alice:'), 'cursor upper bound inside Alice: namespace');
        // The fake walks only in-range keys — assert none of them belong to a sibling.
        // (Re-derive what the production range would have matched.)
        const matched = records.map(x => x._key).filter(k => fake.IDBKeyRange.bound(r.lower, r.upper).includes(k));
        assert(matched.length === 5, 'range matched exactly Alice\'s 5 keys');
        assert(matched.every(k => k.startsWith('Alice:')), 'no Alice2:/Alicia: key fell inside the prune range');
    } finally {
        globalThis.indexedDB = prevIdb;
        globalThis.IDBKeyRange = prevRange;
        store.resetForTests();
    }
});

test('T-L10: clearChatIdb(\'Alice\') deletes ONLY Alice rows — Alice2 and Alicia survive', async () => {
    const store = await import('../src/verdict/verdict-store.js');
    store.resetForTests();

    const records = _siblingRecords();
    const fake = makeFakeIdbForChats(records);
    const prevIdb = globalThis.indexedDB;
    const prevRange = globalThis.IDBKeyRange;
    globalThis.indexedDB = fake.indexedDB;
    globalThis.IDBKeyRange = fake.IDBKeyRange;

    try {
        // clearChatIdb also routes through the REAL listIdbForChat range to find keys.
        await store.clearChatIdb('Alice');

        const left = (id) => records.filter(r => r._value.chatId === id).length;
        assertEqual(left('Alice'), 0, 'all Alice rows deleted');
        assertEqual(left('Alice2'), 2, 'Alice2 rows untouched (digit-prefix sibling excluded)');
        assertEqual(left('Alicia'), 2, 'Alicia rows untouched (letter-prefix sibling excluded)');
        assertEqual(fake.calls.deletes.length, 2, 'exactly Alice\'s 2 keys deleted, no sibling key touched');
        assert(fake.calls.deletes.every(k => k.startsWith('Alice:')), 'every deleted key is in the Alice: namespace');
    } finally {
        globalThis.indexedDB = prevIdb;
        globalThis.IDBKeyRange = prevRange;
        store.resetForTests();
    }
});

await summary('Verdict Tests');
