/**
 * DeepLore — VerdictStore (live).
 *
 * Per-Turn Decision Record store. In-memory ring buffer + IndexedDB spill
 * (per-chat, capped, auto-pruned). Single source of truth for
 * "what did DLE decide on message N?"
 *
 * Replaces 4 racing globals:
 *   lastInjectionSources, lastPipelineTrace, previousSources, lastInjectionEpoch
 *
 * Storage contract:
 *  - Ring buffer in memory: last RING_CAP verdicts across all chats this session.
 *    Used for fast read of getCurrent() / getPrevious() / getByMessageSync().
 *  - IDB store `verdicts` (in DB `DeepLoreEnhanced`, schema v2): per-chat persisted
 *    verdicts. Each chat's rows survive chat switches so resume-after-reload of
 *    any prior chat works. Per-chat cap (IDB_PER_CHAT_CAP) is enforced after each
 *    write via pruneCurrentChat(). NEVER written to chat_metadata (chat files
 *    stay clean).
 *
 * Lifecycle:
 *  - writeVerdict(v): pushes to ring; spills async to IDB; fires observers.
 *  - getCurrent(): newest verdict (any chat in ring).
 *  - getPrevious(): second-newest verdict for the current chat (for cartographer diff).
 *  - getByMessageSync(msgIdx): ring-only lookup by chat.length at gen start.
 *  - clearRing(): drops in-memory ring only, leaves all IDB rows intact. Used on
 *    CHAT_CHANGED so resume-after-reload of the destination chat works.
 *  - clearChatIdb(chatId): drops IDB rows for one chat (e.g. user deletes chat).
 *  - hydrateChat(chatId): loads recent IDB records for chatId into ring. Called on CHAT_CHANGED.
 */

import {
    emptyVerdict,
    buildVerdict,
    diffVerdicts,
    evictRing,
    selectPruneVictimsFromOrderedKeys,
    shouldRunPruneScan,
    validateVerdict,
} from './verdict-pure.js';
import { pushEvent } from '../diagnostics/interceptors.js';

export { emptyVerdict, buildVerdict, diffVerdicts };

const DB_NAME = 'DeepLoreEnhanced';
const DB_VERSION = 2; // bumped from 1 (vault cache) to add verdicts store
const VAULT_STORE = 'vaultCache';
const VERDICT_STORE = 'verdicts';

/** In-memory ring buffer cap. */
const RING_CAP = 50;
/** Per-chat IDB record cap. Auto-pruned on write. */
const IDB_PER_CHAT_CAP = 200;
/**
 * Counter-based sampling rate for `pruneCurrentChat`. Every Nth writeVerdict
 * actually runs the prune scan; the rest no-op. With N=10 the chat may
 * temporarily exceed `IDB_PER_CHAT_CAP` by up to N-1 verdicts between scans,
 * which is acceptable (cap is a soft limit; the upper bound is bounded by N).
 * This eliminates ~90% of the per-generation IDB getAll cost.
 *
 * P1 perf fix (Wave C, 2026-05-22). See docs/gotchas.md #52.
 */
let PRUNE_SAMPLE_RATE = 10;
let pruneCallCount = 0;
let pruneScanCount = 0; // test-only counter: how many calls actually scanned.

/** @type {import('./verdict-pure.js').Verdict[]} */
let ring = [];

/** @type {string|null} The chat id currently in scope. Cleared on CHAT_CHANGED. */
let currentChatId = null;

/**
 * M-4: monotonic hydration epoch. Bumped at the start of every hydrateChat call so
 * a slow IDB read that resolves AFTER a newer CHAT_CHANGED (rapid A→B→C switching)
 * can detect it was superseded and discard its now-stale slice instead of writing
 * a left-behind chat's verdicts into the ring (which could also evict the live
 * chat's rows under RING_CAP). The existing F2 fix only covers writeVerdict-vs-
 * hydrate; this covers hydrate-vs-hydrate.
 */
let hydrationEpoch = 0;

/**
 * Debug guard: the IDB key delimiter is `:` and the no-colon-in-chatId invariant
 * (enforced by ST's `sanitize-filename`, see pruneCurrentChat) is load-bearing for
 * the IDBKeyRange-scoped prune/hydrate scans. If a chatId ever DOES contain `:`,
 * the range bound could split mid-id and a sibling chat's rows could be pruned.
 * That should be impossible — but warn once (cheap, fire-and-forget) if it happens,
 * so the violation surfaces instead of silently corrupting cross-chat history.
 */
let colonChatIdWarned = false;
function assertNoColonChatId(chatId) {
    if (!colonChatIdWarned && typeof chatId === 'string' && chatId.includes(':')) {
        colonChatIdWarned = true;
        console.warn(
            '[DLE] Verdict store: chatId contains \':\' — violates the no-colon IDB-key invariant ' +
            '(see verdict-store pruneCurrentChat). Range-scoped prune/hydrate may misbehave for this chat.',
            { chatId },
        );
    }
}

/** @type {Set<() => void>} */
const observers = new Set();

/**
 * Subscribe to verdict-store changes. Fires on writeVerdict + clearRing + hydrateChat.
 * Returns an unsubscribe function.
 * @param {() => void} cb
 * @returns {() => void}
 */
export function onVerdictChanged(cb) {
    observers.add(cb);
    return () => observers.delete(cb);
}

function notify() {
    for (const cb of [...observers]) {
        try { cb(); } catch (err) { console.warn('[DLE] Verdict observer callback error:', err?.message); }
    }
}

/** @returns {Promise<IDBDatabase>} */
function openDBOnce() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = request.result;
            // BUG-379 lineage: keep vaultCache store on schema bump.
            if (!db.objectStoreNames.contains(VAULT_STORE)) {
                db.createObjectStore(VAULT_STORE);
            }
            if (!db.objectStoreNames.contains(VERDICT_STORE)) {
                // Key is composite string `${chatId}:${msgIdx}:${ts}` (built by caller).
                // No autoIncrement — readers must derive keys deterministically.
                db.createObjectStore(VERDICT_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            console.warn('[DLE] Verdict IndexedDB open blocked — another tab may have an older version open');
            reject(Object.assign(new Error('IndexedDB open blocked by another connection'), { code: 'BLOCKED' }));
        };
    });
}

/** One-shot backoff retry on blocked (mirrors src/vault/cache.js). */
function openDB() {
    return openDBOnce().catch(async (err) => {
        if (err && err.code === 'BLOCKED') {
            console.warn('[DLE] Verdict IndexedDB blocked — retrying in 250ms');
            await new Promise(r => setTimeout(r, 250));
            return openDBOnce();
        }
        throw err;
    });
}

function buildIdbKey(v) {
    // Sortable lex key: chatId | msgIdx (zero-padded) | ts. Enables IDBKeyRange-bound
    // cursor scans scoped to a single chatId (see pruneCurrentChat) and gives
    // selectPruneVictims a stable ordering even if msgIdx ties (shouldn't, but defensive).
    const padded = String(v.msgIdx ?? 0).padStart(6, '0');
    return `${v.chatId ?? ''}:${padded}:${v.ts}`;
}

/**
 * Write a verdict to the ring buffer and (if it has a chatId) spill to IDB.
 * IDB write is async + fire-and-forget; ring write is synchronous so consumers
 * reading immediately after writeVerdict() see the new value.
 *
 * @param {import('./verdict-pure.js').Verdict} verdict
 * @returns {Promise<void>}                            Resolves after IDB spill (or immediately if skipped).
 */
export async function writeVerdict(verdict) {
    if (!validateVerdict(verdict)) {
        console.warn('[DLE] writeVerdict: invalid verdict rejected', { msgIdx: verdict?.msgIdx, epoch: verdict?.epoch });
        return;
    }
    ring.push(verdict);
    ring = evictRing(ring, RING_CAP);
    notify();

    if (!verdict.chatId) return; // tests / headless / first-load — ring-only.

    try {
        const db = await openDB();
        try {
            const tx = db.transaction(VERDICT_STORE, 'readwrite');
            const store = tx.objectStore(VERDICT_STORE);
            store.put(verdict, buildIdbKey(verdict));
            await txDone(tx);
        } finally {
            db.close();
        }
        // Best-effort prune after write so the store never grows past cap. Pass the
        // verdict's OWN chatId (deterministic, captured before any later CHAT_CHANGED)
        // rather than letting the fire-and-forget prune read the mutable currentChatId
        // global — so a chat switch racing the async prune can't retarget it.
        pruneCurrentChat(verdict.chatId).catch(err => console.warn('[DLE] Verdict prune failed:', err?.message));
        pushEvent('verdict_write', { msgIdx: verdict.msgIdx, injected: verdict.injectedSources.length });
    } catch (err) {
        console.warn('[DLE] Verdict IDB write failed:', err?.message);
        pushEvent('verdict_write', { ok: false, error: err?.name || err?.message });
    }
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
}

/**
 * Newest verdict in the ring buffer (any chat). Most callers want the current
 * chat's newest verdict — use getCurrentForChat() if you have a chatId in hand.
 *
 * @returns {import('./verdict-pure.js').Verdict|null}
 */
export function getCurrent() {
    return ring.length > 0 ? ring[ring.length - 1] : null;
}

/**
 * Newest verdict in the ring for the given chat.
 * @param {string|null} chatId
 * @returns {import('./verdict-pure.js').Verdict|null}
 */
export function getCurrentForChat(chatId) {
    if (chatId == null) return getCurrent();
    for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].chatId === chatId) return ring[i];
    }
    return null;
}

/**
 * Second-newest verdict in the ring for the current chat. Used by cartographer
 * diff (replaces `previousSources` global).
 *
 * @returns {import('./verdict-pure.js').Verdict|null}
 */
export function getPrevious() {
    if (currentChatId == null) {
        return ring.length > 1 ? ring[ring.length - 2] : null;
    }
    let seen = 0;
    for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].chatId === currentChatId) {
            if (seen === 1) return ring[i];
            seen++;
        }
    }
    return null;
}

/**
 * Sync ring-only lookup for a specific msgIdx in a specific chat. Returns null
 * if not in ring (no IDB fallback — this is the ring-only fast path; older
 * out-of-ring messages return null rather than touching IDB).
 *
 * Used by sync UI consumers (cartographer popup) that need msgIdx-anchored
 * lookups without going async. Recent messages are almost always in the ring.
 *
 * @param {number} msgIdx
 * @param {string|null} [chatId]   If null/omitted, uses `currentChatId`.
 * @returns {import('./verdict-pure.js').Verdict|null}
 */
export function getByMessageSync(msgIdx, chatId) {
    const cid = chatId ?? currentChatId;
    for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].msgIdx === msgIdx && (cid == null || ring[i].chatId === cid)) return ring[i];
    }
    return null;
}

/**
 * Return the verdict in the ring that immediately precedes `msgIdx` for the
 * given chat — i.e. the verdict with the largest `msgIdx' < msgIdx`. Used by
 * the cartographer popup to compute "what changed since the previous turn"
 * when inspecting an OLDER message (not just the live newest one).
 *
 * Pure in-ring scan, sync. Returns null if no prior verdict is in the ring
 * (caller should treat as "no diff available").
 *
 * @param {number} msgIdx
 * @param {string|null} [chatId]   If null/omitted, uses `currentChatId`.
 * @returns {import('./verdict-pure.js').Verdict|null}
 */
export function getPreviousForMessage(msgIdx, chatId) {
    const cid = chatId ?? currentChatId;
    let best = null;
    for (let i = 0; i < ring.length; i++) {
        const v = ring[i];
        if (cid != null && v.chatId !== cid) continue;
        if (typeof v.msgIdx !== 'number' || v.msgIdx >= msgIdx) continue;
        if (best == null || v.msgIdx > best.msgIdx) best = v;
    }
    return best;
}

/**
 * Set the in-scope chat id. Called on CHAT_CHANGED before hydrateChat.
 * @param {string|null} chatId
 */
export function setCurrentChatId(chatId) {
    assertNoColonChatId(chatId);
    currentChatId = chatId;
}

/**
 * Drop the in-memory ring buffer only. Leaves all IDB rows intact (any chat).
 * Use this on CHAT_CHANGED — the destination chat's persisted verdicts must
 * survive so hydrateChat(newId) can rebuild the ring from IDB on resume.
 *
 * Synchronous. No IDB I/O.
 */
export function clearRing() {
    ring = [];
    notify();
}

/**
 * Drop IDB rows for one chat only. Use when the user permanently removes a
 * chat (delete) or wants to forget that chat's verdict history. Does NOT touch
 * the in-memory ring (call clearRing separately if needed).
 *
 * @param {string} chatId
 * @returns {Promise<void>}
 */
export async function clearChatIdb(chatId) {
    if (!chatId) return;
    try {
        const keys = (await listIdbForChat(chatId)).map(buildIdbKey);
        if (keys.length === 0) return;
        const db = await openDB();
        try {
            const tx = db.transaction(VERDICT_STORE, 'readwrite');
            const store = tx.objectStore(VERDICT_STORE);
            for (const k of keys) store.delete(k);
            await txDone(tx);
        } finally { db.close(); }
    } catch (err) {
        console.warn('[DLE] Verdict clearChatIdb failed:', err?.message);
    }
}

/**
 * Hydrate the ring buffer with recent verdicts for the given chat. Called on
 * CHAT_CHANGED after setCurrentChatId so resume-after-reload reads the right data.
 *
 * F2 race fix (2026-05-22, see docs/gotchas.md #46): the old logic
 * `ring = ring.filter(v => v.chatId !== chatId); ring.push(...slice)` raced
 * with synchronous writeVerdict calls. Sequence that bit:
 *   1. CHAT_CHANGED fires → clearRing() + hydrateChat(newId) (async).
 *   2. User fires Generate immediately; onGenerate writeVerdict pushes a fresh
 *      verdict for newId into the ring.
 *   3. hydrateChat resolves; the .filter() above wiped the just-written verdict
 *      and replaced it with stale IDB slices, so getCurrent / getCurrentForChat
 *      / getByMessageSync all lost the live verdict for that turn.
 * Fix (Option A — merge instead of replace): preserve any ring entry for this
 * chat whose `ts` is newer than the freshest hydrated `ts`. Those are the
 * mid-hydration writes that must survive. Ordering: other chats unchanged, then
 * chronological hydrated slice, then preserved-fresh at the tail so backward
 * scans in getCurrent / getCurrentForChat find the live verdict first.
 *
 * @param {string} chatId
 * @returns {Promise<number>}  Number of verdicts hydrated.
 */
export async function hydrateChat(chatId) {
    if (!chatId) return 0;
    const myEpoch = ++hydrationEpoch;
    try {
        const records = await listIdbForChat(chatId);
        // M-4: a newer hydrateChat (rapid CHAT_CHANGED) started while we awaited IDB.
        // Our slice is for a chat the user has already left — applying it would
        // pollute the ring and risk evicting the current chat's live rows. Bail.
        if (myEpoch !== hydrationEpoch) return 0;
        if (records.length === 0) return 0;
        // Newest-first by msgIdx, take RING_CAP (or fewer).
        const sorted = [...records].sort((a, b) => (b.msgIdx - a.msgIdx) || (b.ts - a.ts));
        const slice = sorted.slice(0, RING_CAP).reverse(); // chronological order in ring.
        // F2: preserve mid-hydration writes (ts newer than freshest hydrated row).
        const incomingMaxTs = slice.length ? Math.max(...slice.map(v => v.ts || 0)) : 0;
        const preservedFresh = ring
            .filter(v => v.chatId === chatId && (v.ts || 0) > incomingMaxTs)
            .sort((a, b) => (a.ts || 0) - (b.ts || 0)); // chronological so newest stays at tail
        const otherChats = ring.filter(v => v.chatId !== chatId);
        ring = [...otherChats, ...slice, ...preservedFresh];
        ring = evictRing(ring, RING_CAP);
        notify();
        pushEvent('verdict_hydrate', { chatId, count: slice.length, preservedFresh: preservedFresh.length });
        return slice.length;
    } catch (err) {
        console.warn('[DLE] Verdict hydrateChat failed:', err?.message);
        return 0;
    }
}

/**
 * Internal: list all IDB rows for a chat. Scoped to the chat's key prefix via
 * `IDBKeyRange.bound` (same range pruneCurrentChat uses) so only this chat's rows
 * are deserialized — NOT every chat in the store. Key shape: `${chatId}:${msgIdx}:${ts}`.
 *
 * @param {string} chatId
 * @returns {Promise<import('./verdict-pure.js').Verdict[]>}
 */
async function listIdbForChat(chatId) {
    const db = await openDB();
    try {
        const tx = db.transaction(VERDICT_STORE, 'readonly');
        const store = tx.objectStore(VERDICT_STORE);
        // Range-scope to this chat's keys so hydrateChat/clearChatIdb scale with the per-chat
        // cap, not total cross-chat history. U+FFFF upper bound excludes longer-prefixed sibling ids.
        const range = IDBKeyRange.bound(`${chatId}:`, `${chatId}:￿`);
        const rows = await new Promise((resolve, reject) => {
            const req = store.getAll(range);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        // chatId field check kept as a belt-and-braces guard alongside the key-range scoping.
        return rows.filter(v => v && v.chatId === chatId && validateVerdict(v));
    } finally {
        db.close();
    }
}

/**
 * Prune the current chat's IDB store down to IDB_PER_CHAT_CAP records.
 *
 * Called after each writeVerdict. Two perf optimizations (Wave C P1, 2026-05-22):
 *
 *  1. Counter-based sampling: only actually scan every PRUNE_SAMPLE_RATE'th
 *     call. Between scans the cap may temporarily exceed by up to N-1 records
 *     — acceptable, the cap is a soft limit. Skips ~90% of scans.
 *
 *  2. Bounded key-only cursor: instead of `getAll()` (full deserialization of
 *     every verdict across every chat in the store), open an `openKeyCursor`
 *     scoped to the current chat's key prefix via `IDBKeyRange.bound`. Walks
 *     oldest-first (default direction) collecting keys only — no value
 *     deserialization. Victims are the leading slice.
 *
 * Key shape (from buildIdbKey): `${chatId}:${paddedMsgIdx}:${ts}`. Range
 * `[chatId+':', chatId+':￿']` scopes to that chat (U+FFFF is the highest
 * BMP code unit — every real key for this chat sorts strictly less).
 *
 * No-colon invariant — ENFORCED, not assumed: ST chat IDs are chat-file
 * basenames, and ST runs every chat filename / rename target through the
 * `sanitize-filename` npm package server-side (SillyTavern
 * `src/endpoints/chats.js` — `import sanitize from 'sanitize-filename'`, applied
 * at save/rename/group-chat paths). `sanitize-filename` strips `:` (an illegal
 * filename character cross-platform), `humanizedDateTime` never emits `:`, and
 * group ids are `Date.now()` digit strings. So a chatId cannot contain `:`, the
 * range bound can never split a key mid-chatId, and `Alice2`/`Alicia` sort
 * strictly OUTSIDE `[Alice:, Alice:￿]` (verified by the T-L10 guard test). See
 * docs/gotchas.md #52 + the thermo-nuclear L10 verification (NON-ISSUE; do NOT
 * change the delimiter — that would orphan every existing verdict IDB row with
 * no migration path). We never read values, so validateVerdict isn't needed here.
 *
 * @param {string|null} [chatId]  Chat to prune. Defaults to the live `currentChatId`.
 *   Production passes the WRITING verdict's own chatId so a CHAT_CHANGED racing the
 *   fire-and-forget prune can't retarget the scan at the now-current chat. The
 *   no-arg form (test-only `_invokePruneForTests`) still uses the global.
 * @returns {Promise<number>}  Number of records deleted (0 if sampling skipped this call).
 */
async function pruneCurrentChat(chatId = currentChatId) {
    if (!chatId) return 0;
    pruneCallCount++;
    if (!shouldRunPruneScan(pruneCallCount, PRUNE_SAMPLE_RATE)) return 0;
    pruneScanCount++;

    const db = await openDB();
    let victims;
    try {
        // Phase 1: oldest-first cursor walk, key-only (no value deserialization).
        const tx = db.transaction(VERDICT_STORE, 'readonly');
        const store = tx.objectStore(VERDICT_STORE);
        const lower = `${chatId}:`;
        const upper = `${chatId}:￿`;
        const range = IDBKeyRange.bound(lower, upper);
        const orderedKeys = await new Promise((resolve, reject) => {
            const keys = [];
            const req = store.openKeyCursor(range, 'next'); // oldest-first
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    keys.push(cursor.key);
                    cursor.continue();
                } else {
                    resolve(keys);
                }
            };
            req.onerror = () => reject(req.error);
        });
        victims = selectPruneVictimsFromOrderedKeys(orderedKeys, IDB_PER_CHAT_CAP);
        // M-3: the under-cap path (victims empty) is the COMMON case — it ran every
        // 10th writeVerdict for the whole life of a chat. Returning here skipped both
        // this try's catch-close and phase-2's finally-close, leaking an IDBDatabase
        // handle on nearly every sampled prune. Close before returning.
        if (victims.length === 0) { db.close(); return 0; }
    } catch (err) {
        db.close();
        throw err;
    }

    // Phase 2: delete victims in a separate readwrite tx (cursor tx is readonly).
    try {
        const tx = db.transaction(VERDICT_STORE, 'readwrite');
        const store = tx.objectStore(VERDICT_STORE);
        for (const k of victims) store.delete(k);
        await txDone(tx);
        return victims.length;
    } finally {
        db.close();
    }
}

/**
 * Reset all in-memory state. Called from tests + module teardown. Does NOT
 * touch IDB (use clearChatIdb(chatId) to drop a single chat's IDB rows).
 */
export function resetForTests() {
    ring = [];
    currentChatId = null;
    observers.clear();
    pruneCallCount = 0;
    pruneScanCount = 0;
    PRUNE_SAMPLE_RATE = 10;
}

/**
 * Test-only: override the prune sample rate so regression tests can exercise
 * the gating without writing 10 verdicts to trigger a single scan. Production
 * code MUST NOT call this — production rate is fixed at 10.
 *
 * @param {number} rate
 */
export function _setPruneSampleRateForTests(rate) {
    if (Number.isFinite(rate) && rate >= 1) PRUNE_SAMPLE_RATE = rate;
}

/**
 * Test-only: introspect the prune counter telemetry.
 * @returns {{ calls: number, scans: number, rate: number }}
 */
export function _getPruneStatsForTests() {
    return { calls: pruneCallCount, scans: pruneScanCount, rate: PRUNE_SAMPLE_RATE };
}

/**
 * Test-only: invoke the (otherwise module-private) pruneCurrentChat directly so
 * regression tests can assert sampling/cursor behavior without needing to
 * round-trip through writeVerdict (which requires IDB).
 * @returns {Promise<number>}
 */
export async function _invokePruneForTests() {
    return pruneCurrentChat();
}

/**
 * Debug-only snapshot of the ring buffer. Don't use in prod consumers — read
 * via getCurrent / getPrevious / getByMessageSync instead.
 * @returns {import('./verdict-pure.js').Verdict[]}
 */
export function _debugRingSnapshot() {
    return [...ring];
}
