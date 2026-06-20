/**
 * DeepLore Enhanced — audit-fix lifecycle regression tests.
 *
 * Covers the P2-1..P2-5 generation-pipeline / lifecycle fixes (index.js +
 * src/pipeline/pipeline.js). All five are confirmed bugs with live line refs.
 *
 * Testing strategy (matches the repo convention for index.js-internal logic —
 * index.js has no export surface and importing it pulls ST globals):
 *   - Pure helpers (P2-1 swipeTargetFor, P2-2 swipe-delete rekey, P2-5 wiki-link
 *     expansion) are MIRRORED here byte-for-byte from the source and exercised
 *     directly. The mirror is the contract — a source change that diverges from
 *     this logic should be caught at review against this file.
 *   - The REAL trackerKey (src/state.js) and buildVerdict (verdict-pure.js) are
 *     imported and used where they are importable without ST globals.
 *   - Behavior that only exists inside onGenerate's closure (P2-3 routing of the
 *     three early-empty exits, P2-4 post-runPipeline epoch/lock guard) is pinned
 *     with STATIC SOURCE GUARDS that read index.js / pipeline.js as text — the
 *     same technique the existing suite uses for runPipeline internals
 *     (regression.test.mjs H-3-5 / PERF-P2-4).
 */

import { readFile } from 'node:fs/promises';
import {
    test, section, summary,
    assert, assertEqual, assertNotEqual, assertNull, assertNotNull,
    makeEntry,
} from './helpers.mjs';
import { trackerKey } from '../src/state.js';
import { buildVerdict } from '../src/verdict/verdict-pure.js';

const indexSrc = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const pipelineSrc = await readFile(new URL('../src/pipeline/pipeline.js', import.meta.url), 'utf8');

// ============================================================================
// P2-1 — Per-swipe injection counts keyed on the assistant's eventual global
// slot (verdictMsgIdx), not the filtered chatMessages user slot.
//
// Mirror of `swipeTargetFor(chatArr, idx)` in index.js.
// ============================================================================

function swipeTargetFor(chatArr, idx) {
    const arr = Array.isArray(chatArr) ? chatArr : [];
    let swipeId = 0;
    const atSlot = arr[idx];
    if (atSlot && !atSlot.is_user) {
        swipeId = atSlot.swipe_id ?? 0;
    } else {
        const last = arr.length > 0 ? arr[arr.length - 1] : null;
        if (last && !last.is_user && (arr.length - 1) === idx) {
            swipeId = last.swipe_id ?? 0;
        }
    }
    return { idx, swipeId, key: `${idx}|${swipeId}` };
}

/**
 * Mirror of the MESSAGE_SWIPED rebuild key derivation (index.js ~2384): iterate
 * global chat, skip is_user, key the assistant on its GLOBAL index `${i}|${swipe_id}`.
 * Returns the set of keys the rebuild would look up.
 */
function messageSwipedKeysFor(chat) {
    const keys = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_user) continue;
        keys.push(`${i}|${m.swipe_id ?? 0}`);
    }
    return keys;
}

section('P2-1 — per-swipe key anchors on assistant slot (verdictMsgIdx)');

test('P2-1a: fresh user→assistant gen stores 1|0, NOT 0|0', () => {
    // Pre-push chat: only the user message exists. verdictMsgIdx = chat.length = 1.
    const chat = [{ is_user: true, mes: 'hello', swipe_id: 0 }];
    const verdictMsgIdx = chat.length; // 1
    const { key } = swipeTargetFor(chat, verdictMsgIdx);
    assertEqual(key, '1|0', 'P2-1: fresh gen keys the assistant slot (1), not the user slot (0)');
    assertNotEqual(key, '0|0', 'P2-1 BUG: old code keyed chatMessages.length-1 == user slot 0|0');
});

test('P2-1b: stored key matches the MESSAGE_SWIPED rebuild key after the reply lands', () => {
    // Write happens pre-push; after saveReply pushes the assistant the global chat is:
    const chat = [{ is_user: true, mes: 'hi', swipe_id: 0 }];
    const verdictMsgIdx = chat.length; // 1
    const { key: writeKey } = swipeTargetFor(chat, verdictMsgIdx);
    // Now the assistant reply is pushed at index 1, swipe_id 0.
    chat.push({ is_user: false, mes: 'reply', swipe_id: 0 });
    const rebuildKeys = messageSwipedKeysFor(chat);
    assert(rebuildKeys.includes(writeKey),
        `P2-1: MESSAGE_SWIPED rebuild (${rebuildKeys.join(',')}) must find the stored write key ${writeKey}`);
});

test('P2-1c: OLD bug key (chatMessages.length-1) would NOT be found by the rebuild', () => {
    const chat = [{ is_user: true, mes: 'hi', swipe_id: 0 }];
    const oldKey = `${chat.length - 1}|0`; // 0|0 — the user slot
    chat.push({ is_user: false, mes: 'reply', swipe_id: 0 });
    const rebuildKeys = messageSwipedKeysFor(chat);
    assert(!rebuildKeys.includes(oldKey),
        `P2-1 BUG: old user-slot key ${oldKey} is absent from rebuild keys (${rebuildKeys.join(',')}) — counts drifted`);
});

test('P2-1d: regen of an existing assistant honors its incremented swipe_id', () => {
    // Multi-turn chat; the trailing assistant is being regenerated/swiped to a new alt.
    // ST keeps the assistant as the last entry with an incremented swipe_id.
    const chat = [
        { is_user: true, mes: 'q1', swipe_id: 0 },
        { is_user: false, mes: 'a1', swipe_id: 2 }, // assistant at index 1, swipe_id 2
    ];
    // On regen the assistant already occupies its slot; verdictMsgIdx points at it.
    const verdictMsgIdx = 1;
    const { key } = swipeTargetFor(chat, verdictMsgIdx);
    assertEqual(key, '1|2', 'P2-1: regen keys the existing assistant slot+swipe_id');
});

test('P2-1e: early snapshot and Stage 9 use the SAME derivation (self-consistent rollback)', () => {
    // The whole point: the early swipe-check (writes snapshot) and Stage 9 (writes
    // per-swipe map) must produce an identical key for the same turn so a regen
    // reproduces last turn's key. Same inputs → same key.
    const chat = [{ is_user: true, mes: 'hi', swipe_id: 0 }];
    const verdictMsgIdx = chat.length;
    const early = swipeTargetFor(chat, verdictMsgIdx);
    const stage9 = swipeTargetFor(chat, verdictMsgIdx);
    assertEqual(early.key, stage9.key, 'P2-1: early-check and Stage 9 derive the identical key');
});

test('P2-1f: SOURCE — both swipe sites call swipeTargetFor(chat, verdictMsgIdx)', () => {
    // The early swipe-check block and Stage 9 must both anchor on chat+verdictMsgIdx,
    // not chatMessages.length-1.
    const calls = (indexSrc.match(/swipeTargetFor\(chat,\s*verdictMsgIdx\)/g) || []).length;
    assert(calls >= 2, `P2-1: expected >=2 swipeTargetFor(chat, verdictMsgIdx) call sites, found ${calls}`);
    // The old user-slot derivation must be gone from the swipe paths.
    assert(!/earlySwipeId\s*=\s*earlyIdx\s*>=\s*0/.test(indexSrc),
        'P2-1: old earlyIdx=chatMessages.length-1 swipe derivation must be removed');
});

test('P2-1g: SOURCE — Stage 9 prune bounds against global chat.length, not chatMessages', () => {
    // Keys are now in global index space, so the 10-slot prune window must derive
    // from global chat.length or it can drop the just-written key.
    assert(/_globalLen\s*=\s*Array\.isArray\(chat\)\s*\?\s*chat\.length/.test(indexSrc),
        'P2-1: prune keepFromIdx must use global chat.length');
});

// ============================================================================
// P2-2 — Middle-swipe delete rekeys surviving per-swipe keys (mirrors ST's
// swipes-array compaction). Mirror of the MESSAGE_SWIPE_DELETED reindex body.
// ============================================================================

/**
 * Mirror of the P2-2 reindex logic in index.js MESSAGE_SWIPE_DELETED handler.
 * Takes a Map<swipeKey, value>, the deleted messageId + swipeId, returns the new Map.
 */
function reindexAfterSwipeDelete(map, messageId, deletedSwipeId) {
    const out = new Map(map);
    const prefix = `${messageId}|`;
    const survivors = [];
    let touched = false;
    for (const k of [...out.keys()]) {
        if (!k.startsWith(prefix)) continue;
        const sid = parseInt(k.slice(prefix.length), 10);
        if (!Number.isFinite(sid)) continue;
        touched = true;
        if (Number.isFinite(deletedSwipeId) && sid === deletedSwipeId) {
            out.delete(k);
            continue;
        }
        survivors.push({ sid, value: out.get(k) });
        out.delete(k);
    }
    if (touched) {
        survivors.sort((a, b) => a.sid - b.sid);
        for (const { sid, value } of survivors) {
            const newSid = (Number.isFinite(deletedSwipeId) && sid > deletedSwipeId) ? sid - 1 : sid;
            out.set(`${prefix}${newSid}`, value);
        }
    }
    return out;
}

section('P2-2 — middle-swipe delete rekeys surviving keys (compaction)');

test('P2-2a: deleting a MIDDLE swipe shifts higher swipes down by one', () => {
    // Message 5 has swipes 0,1,2,3. Delete swipe 1 → array compacts → 0,1,2 (old 2,3→1,2).
    const map = new Map([
        ['5|0', ['v:A']],
        ['5|1', ['v:B']],
        ['5|2', ['v:C']],
        ['5|3', ['v:D']],
    ]);
    const out = reindexAfterSwipeDelete(map, 5, 1);
    assert(out.has('5|0'), 'P2-2: swipe 0 unchanged');
    assertEqual(out.get('5|0'), ['v:A'], 'P2-2: swipe 0 value intact');
    assert(!out.has('5|1') || out.get('5|1')[0] === 'v:C', 'P2-2: old swipe 1 deleted, slot 1 now holds old swipe 2');
    assertEqual(out.get('5|1'), ['v:C'], 'P2-2: old swipe 2 → new swipe 1');
    assertEqual(out.get('5|2'), ['v:D'], 'P2-2: old swipe 3 → new swipe 2');
    assert(!out.has('5|3'), 'P2-2: top slot vacated after shift');
});

test('P2-2b: deleting the LAST swipe just drops it (nothing above to shift)', () => {
    const map = new Map([
        ['5|0', ['v:A']],
        ['5|1', ['v:B']],
        ['5|2', ['v:C']],
    ]);
    const out = reindexAfterSwipeDelete(map, 5, 2);
    assertEqual(out.get('5|0'), ['v:A'], 'P2-2: swipe 0 intact');
    assertEqual(out.get('5|1'), ['v:B'], 'P2-2: swipe 1 intact');
    assert(!out.has('5|2'), 'P2-2: deleted last swipe dropped');
});

test('P2-2c: deleting swipe 0 shifts everything down', () => {
    const map = new Map([
        ['5|0', ['v:A']],
        ['5|1', ['v:B']],
        ['5|2', ['v:C']],
    ]);
    const out = reindexAfterSwipeDelete(map, 5, 0);
    assertEqual(out.get('5|0'), ['v:B'], 'P2-2: old swipe 1 → new swipe 0');
    assertEqual(out.get('5|1'), ['v:C'], 'P2-2: old swipe 2 → new swipe 1');
    assert(!out.has('5|2'), 'P2-2: top slot vacated');
});

test('P2-2d: other messages are untouched by a delete on message 5', () => {
    const map = new Map([
        ['5|0', ['v:A']],
        ['5|1', ['v:B']],
        ['7|0', ['v:Z']],
        ['7|1', ['v:Y']],
    ]);
    const out = reindexAfterSwipeDelete(map, 5, 0);
    assertEqual(out.get('7|0'), ['v:Z'], 'P2-2: message 7 swipe 0 untouched');
    assertEqual(out.get('7|1'), ['v:Y'], 'P2-2: message 7 swipe 1 untouched');
    assertEqual(out.get('5|0'), ['v:B'], 'P2-2: message 5 shifted');
});

test('P2-2e: no surviving keys for the message → no-op', () => {
    const map = new Map([['7|0', ['v:Z']]]);
    const out = reindexAfterSwipeDelete(map, 5, 0);
    assertEqual([...out.keys()].sort(), ['7|0'], 'P2-2: unrelated message untouched, no crash');
});

test('P2-2f: SOURCE — handler reads payload.swipeId and shifts (not the old >= length drop)', () => {
    assert(/deletedSwipeId\s*=\s*\(payload[\s\S]{0,80}payload\.swipeId/.test(indexSrc),
        'P2-2: handler must read payload.swipeId');
    assert(/sid\s*>\s*deletedSwipeId\)\s*\?\s*sid\s*-\s*1/.test(indexSrc),
        'P2-2: handler must shift surviving swipeIds > deleted down by one');
    assert(!/ST does NOT shift swipe_id on delete/.test(indexSrc),
        'P2-2: stale "ST does NOT shift swipe_id" comment must be corrected');
});

// ============================================================================
// P2-3 — Early empty pipeline exits write an empty verdict (verdict contract).
// ============================================================================

section('P2-3 — early-empty exits write an empty verdict');

test('P2-3a: buildVerdict with injectedSources:[] is a valid empty verdict', () => {
    // The real verdict-pure buildVerdict — same call the helper makes.
    const trace = { genId: 'abc123', keywordMatched: [], aiSelected: [], injected: [] };
    const v = buildVerdict({
        trace,
        injectedSources: [],
        chatId: 'chatX',
        msgIdx: 4,
        epoch: 7,
        lockEpoch: 2,
    });
    assertEqual(v.injectedSources, [], 'P2-3: empty verdict carries injectedSources []');
    assertEqual(v.msgIdx, 4, 'P2-3: msgIdx anchored');
    assertEqual(v.chatId, 'chatX', 'P2-3: chatId carried');
    assertNotNull(v.trace, 'P2-3: trace still attached (rejection breakdown survives)');
    assertEqual(v.genId, 'abc123', 'P2-3: genId pulled from trace');
});

test('P2-3b: SOURCE — all three early-empty branches route through _commitEmptyAndReturn', () => {
    // The helper must exist and be invoked by no-match, cooldown-empty, gating-empty.
    assert(/const _commitEmptyAndReturn\s*=\s*\(reason\)\s*=>/.test(indexSrc),
        'P2-3: _commitEmptyAndReturn helper must be defined');
    // The arrow def is `_commitEmptyAndReturn = (reason) =>`, so `_commitEmptyAndReturn(`
    // (open-paren immediately after the name) matches ONLY the 3 call sites.
    const calls = (indexSrc.match(/_commitEmptyAndReturn\(/g) || []).length;
    assert(calls >= 3, `P2-3: expected 3 call sites, found ${calls}`);
    assert(/_commitEmptyAndReturn\('No entries matched'\)/.test(indexSrc),
        'P2-3: no-match branch routes through the helper');
    assert(/_commitEmptyAndReturn\('All entries removed by re-injection cooldown'\)/.test(indexSrc),
        'P2-3: cooldown-empty branch routes through the helper');
    assert(/_commitEmptyAndReturn\('All entries removed by gating rules'\)/.test(indexSrc),
        'P2-3: gating-empty branch routes through the helper');
});

test('P2-3c: SOURCE — helper writes an empty verdict and notifies readiness, epoch-guarded', () => {
    const start = indexSrc.indexOf('const _commitEmptyAndReturn');
    assert(start >= 0, 'P2-3: helper present');
    const body = indexSrc.slice(start, start + 1200);
    assert(/injectedSources:\s*\[\]/.test(body), 'P2-3: helper writes injectedSources: []');
    assert(/writeVerdict\(buildVerdict\(/.test(body), 'P2-3: helper calls writeVerdict(buildVerdict(...))');
    assert(/notifyInjectionSourcesReady\(\)/.test(body), 'P2-3: helper notifies readiness');
    assert(/epoch\s*!==\s*chatEpoch\s*\|\|\s*lockEpoch\s*!==\s*generationLockEpoch/.test(body),
        'P2-3: helper preserves the epoch/lock stale guard before clearPrompts');
    assert(/clearPrompts\(/.test(body), 'P2-3: helper clears prompts');
});

// ============================================================================
// P2-4 — chat_metadata writes are guarded by a post-runPipeline epoch+lock check.
// ============================================================================

section('P2-4 — post-runPipeline epoch/lock guard before any metadata write');

/**
 * Pure model of the guard predicate: a same-chat lock force-release bumps
 * generationLockEpoch but leaves chatEpoch unchanged; the lockEpoch half must
 * catch it. Returns true when the pipeline should BAIL (is stale).
 */
function shouldBailPostPipeline(epoch, chatEpoch, lockEpoch, genLockEpoch) {
    return epoch !== chatEpoch || lockEpoch !== genLockEpoch;
}

test('P2-4a: same-chat lock force-release (lockEpoch bumped, chatEpoch same) → bail', () => {
    // Gen A captured epoch=5, lockEpoch=10. Gen B force-released the lock → genLockEpoch=11.
    const bail = shouldBailPostPipeline(5, 5, 10, 11);
    assert(bail, 'P2-4: lockEpoch mismatch alone (same chatEpoch) must trigger bail');
});

test('P2-4b: cross-chat switch (chatEpoch bumped) → bail', () => {
    const bail = shouldBailPostPipeline(5, 6, 10, 10);
    assert(bail, 'P2-4: chatEpoch mismatch must trigger bail');
});

test('P2-4c: healthy same-gen (both epochs match) → proceed', () => {
    const bail = shouldBailPostPipeline(5, 5, 10, 10);
    assert(!bail, 'P2-4: matching epochs must NOT bail');
});

test('P2-4d: SOURCE — guard sits immediately after runPipeline, before metadata writes', () => {
    // Locate the runPipeline call, the guard, and the GUARDED strip-dedup-log-clear.
    const runIdx = indexSrc.indexOf('await runPipeline(');
    assert(runIdx >= 0, 'P2-4: runPipeline call present');
    // The post-pipeline guard discard marker must appear right after runPipeline.
    const guardIdx = indexSrc.indexOf('superseded_post_pipeline', runIdx);
    assert(guardIdx > runIdx, 'P2-4: post-runPipeline guard (superseded_post_pipeline) must exist after runPipeline');
    // The strip-dedup metadata write is gated by stripDuplicateInjections; the guard
    // must precede it so a stale gen can't wipe the log before bailing.
    const stripWriteIdx = indexSrc.indexOf('settings.stripDuplicateInjections && (_snapMatch', runIdx);
    assert(stripWriteIdx > guardIdx,
        'P2-4: guard must precede the strip-dedup injection-log write');
    // And it checks BOTH epochs (the if-condition precedes the marker by one warn line).
    const guardBlock = indexSrc.slice(guardIdx - 450, guardIdx + 60);
    assert(/epoch\s*!==\s*chatEpoch\s*\|\|\s*lockEpoch\s*!==\s*generationLockEpoch/.test(guardBlock),
        'P2-4: guard must check both chatEpoch and generationLockEpoch');
});

// ============================================================================
// P2-5 — Wiki-link expansion unions same-title cross-vault entries; dedupes by
// trackerKey. Mirror of the rewritten block in src/pipeline/pipeline.js.
// Uses the REAL trackerKey from src/state.js.
// ============================================================================

/**
 * Mirror of the P2-5 wiki-link expansion. Returns the linked candidate entries
 * and the matchedKeys writes (as [trackerKey, reason] pairs).
 */
function wikiLinkExpand(matched, vaultSnapshot) {
    const matchedKeySet = new Set(matched.map(e => trackerKey(e)));
    const titleLookup = new Map();
    for (const e of vaultSnapshot) {
        if (!titleLookup.has(e.title)) titleLookup.set(e.title, []);
        titleLookup.get(e.title).push(e);
    }
    const linkedCandidates = [];
    const matchedKeyWrites = [];
    for (const entry of matched) {
        for (const linkTitle of (entry.resolvedLinks || [])) {
            const candidates = titleLookup.get(linkTitle) || [];
            for (const linked of candidates) {
                const tk = trackerKey(linked);
                if (matchedKeySet.has(tk)) continue;
                if (linked.constant) continue;
                matchedKeySet.add(tk);
                linkedCandidates.push(linked);
                matchedKeyWrites.push([tk, `(wiki-linked from: ${entry.title})`]);
            }
        }
    }
    return { linkedCandidates, matchedKeyWrites };
}

section('P2-5 — wiki-link expansion unions cross-vault same-title entries');

test('P2-5a: a linked title present in TWO vaults expands BOTH (old last-wins dropped one)', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const king = makeEntry('King', { vaultSource: 'VaultA', resolvedLinks: ['Castle'] });
    const vaultSnapshot = [king, castleA, castleB];
    const { linkedCandidates } = wikiLinkExpand([king], vaultSnapshot);
    assertEqual(linkedCandidates.length, 2, 'P2-5: both vaults\' Castle expanded (no last-wins collapse)');
    const keys = linkedCandidates.map(e => trackerKey(e)).sort();
    assertEqual(keys, ['VaultA:Castle', 'VaultB:Castle'], 'P2-5: both distinct trackerKeys present');
});

test('P2-5b: matchedKeys writes use trackerKey (vaultSource:title), not bare title', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const king = makeEntry('King', { vaultSource: 'VaultA', resolvedLinks: ['Castle'] });
    const { matchedKeyWrites } = wikiLinkExpand([king], [king, castleA, castleB]);
    const writtenKeys = matchedKeyWrites.map(([k]) => k).sort();
    assertEqual(writtenKeys, ['VaultA:Castle', 'VaultB:Castle'],
        'P2-5: matchedKeys keyed by trackerKey for both vault entries');
});

test('P2-5c: an already-matched linked entry (same trackerKey) is not re-expanded', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const king = makeEntry('King', { vaultSource: 'VaultA', resolvedLinks: ['Castle'] });
    // castleA already matched.
    const { linkedCandidates } = wikiLinkExpand([king, castleA], [king, castleA]);
    assertEqual(linkedCandidates.length, 0, 'P2-5: already-matched entry skipped by trackerKey check');
});

test('P2-5d: constant linked entries are excluded from expansion', () => {
    const castle = makeEntry('Castle', { vaultSource: 'V', constant: true });
    const king = makeEntry('King', { vaultSource: 'V', resolvedLinks: ['Castle'] });
    const { linkedCandidates } = wikiLinkExpand([king], [king, castle]);
    assertEqual(linkedCandidates.length, 0, 'P2-5: constant entries are not wiki-link candidates');
});

test('P2-5e: cross-vault dedup — when one Castle is already matched, only the OTHER expands', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const king = makeEntry('King', { vaultSource: 'VaultA', resolvedLinks: ['Castle'] });
    // VaultA's Castle already matched; only VaultB's should be pulled in.
    const { linkedCandidates } = wikiLinkExpand([king, castleA], [king, castleA, castleB]);
    assertEqual(linkedCandidates.length, 1, 'P2-5: only the unmatched vault entry expands');
    assertEqual(trackerKey(linkedCandidates[0]), 'VaultB:Castle', 'P2-5: it is VaultB\'s Castle');
});

test('P2-5f: single-vault behavior unchanged (regression-safe)', () => {
    const castle = makeEntry('Castle', { vaultSource: '' });
    const king = makeEntry('King', { vaultSource: '', resolvedLinks: ['Castle'] });
    const { linkedCandidates, matchedKeyWrites } = wikiLinkExpand([king], [king, castle]);
    assertEqual(linkedCandidates.length, 1, 'P2-5: single-vault link expands as before');
    assertEqual(matchedKeyWrites[0][0], ':Castle', 'P2-5: single-vault trackerKey is :title');
});

test('P2-5g: SOURCE — pipeline.js builds Map<title, Entry[]> and dedupes by trackerKey', () => {
    // The bare-title last-wins Map must be gone; the union pattern must be present.
    assert(!/titleLookup\s*=\s*new Map\(vaultSnapshot\.map\(e\s*=>\s*\[e\.title,\s*e\]\)\)/.test(pipelineSrc),
        'P2-5: old last-wins titleLookup (Map(vaultSnapshot.map([e.title,e]))) must be removed');
    assert(/if \(!titleLookup\.has\(e\.title\)\) titleLookup\.set\(e\.title, \[\]\)/.test(pipelineSrc),
        'P2-5: titleLookup must be Map<title, Entry[]> (union)');
    assert(/const tk = trackerKey\(linked\)/.test(pipelineSrc) && /matchedKeySet\.has\(tk\)/.test(pipelineSrc),
        'P2-5: dedup must be by trackerKey, not bare title');
    assert(!/matchedTitles/.test(pipelineSrc),
        'P2-5: the bare-title matchedTitles Set must be gone');
});

await summary('Audit-fix Lifecycle (P2-1..P2-5)');
