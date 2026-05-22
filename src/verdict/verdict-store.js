/**
 * DeepLore Enhanced — VerdictStore (live).
 *
 * Per-Turn Decision Record store. In-memory ring buffer + IndexedDB spill
 * (current chat only, capped, auto-pruned). Single source of truth for
 * "what did DLE decide on message N?"
 *
 * Replaces 4 racing globals:
 *   lastInjectionSources, lastPipelineTrace, previousSources, lastInjectionEpoch
 *
 * Storage contract:
 *  - Ring buffer in memory: last RING_CAP verdicts across all chats this session.
 *    Used for fast read of getCurrent() / getPrevious() / getByMessage().
 *  - IDB store `verdicts` (in DB `DeepLoreEnhanced`, schema v2): per-chat persisted
 *    verdicts for the current chat only. Other chats' IDB records are dropped on
 *    CHAT_CHANGED. NEVER written to chat_metadata (chat files stay clean).
 *
 * Lifecycle:
 *  - writeVerdict(v): pushes to ring; spills async to IDB; fires observers.
 *  - getCurrent(): newest verdict (any chat in ring).
 *  - getPrevious(): second-newest verdict for the current chat (for cartographer diff).
 *  - getByMessage(msgIdx): looks up by chat.length at gen start.
 *  - clearChat(chatId): wipes ring entries + IDB records for chatId. Called on CHAT_CHANGED.
 *  - hydrateChat(chatId): loads recent IDB records for chatId into ring. Called on CHAT_CHANGED.
 */

import {
    emptyVerdict,
    buildVerdict,
    diffVerdicts,
    evictRing,
    selectPruneVictims,
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

/** @type {import('./verdict-pure.js').Verdict[]} */
let ring = [];

/** @type {string|null} The chat id currently in scope. Cleared on CHAT_CHANGED. */
let currentChatId = null;

/** @type {Set<() => void>} */
const observers = new Set();

/**
 * Subscribe to verdict-store changes. Fires on writeVerdict + clearChat + hydrateChat.
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
    // Sortable lex key: chatId | msgIdx (zero-padded) | ts. Ensures range scans work and
    // selectPruneVictims sees a stable ordering even if msgIdx ties (shouldn't but defensive).
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
        // Best-effort prune after write so the store never grows past cap.
        pruneCurrentChat().catch(err => console.warn('[DLE] Verdict prune failed:', err?.message));
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
 * Look up the verdict for a specific message index. Fast in-ring scan; falls
 * back to IDB query if absent.
 *
 * @param {number} msgIdx
 * @param {string|null} [chatId]
 * @returns {Promise<import('./verdict-pure.js').Verdict|null>}
 */
export async function getByMessage(msgIdx, chatId) {
    const cid = chatId ?? currentChatId;
    // Search newest-to-oldest (most likely the recent one).
    for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].msgIdx === msgIdx && (cid == null || ring[i].chatId === cid)) return ring[i];
    }
    if (cid == null) return null;
    // Scan IDB for the requested chat (cheaper than a full prune scan since we early-exit).
    try {
        const records = await listIdbForChat(cid);
        for (const rec of records) {
            if (rec.msgIdx === msgIdx) return rec;
        }
    } catch (err) {
        console.warn('[DLE] Verdict getByMessage IDB lookup failed:', err?.message);
    }
    return null;
}

/**
 * Set the in-scope chat id. Called on CHAT_CHANGED before hydrateChat.
 * @param {string|null} chatId
 */
export function setCurrentChatId(chatId) {
    currentChatId = chatId;
}

/**
 * Drop ring entries + IDB records for a given chat. Called on CHAT_CHANGED so
 * other chats' IDB rows do not accumulate beyond a single chat's lifetime.
 *
 * @param {string|null} chatId  If null, wipes everything (in-memory + all IDB rows).
 * @returns {Promise<void>}
 */
export async function clearChat(chatId) {
    if (chatId == null) {
        ring = [];
        notify();
        try {
            const db = await openDB();
            try {
                const tx = db.transaction(VERDICT_STORE, 'readwrite');
                tx.objectStore(VERDICT_STORE).clear();
                await txDone(tx);
            } finally { db.close(); }
        } catch (err) {
            console.warn('[DLE] Verdict clear-all failed:', err?.message);
        }
        return;
    }
    ring = ring.filter(v => v.chatId !== chatId);
    notify();
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
        console.warn('[DLE] Verdict clearChat IDB failed:', err?.message);
    }
}

/**
 * Hydrate the ring buffer with recent verdicts for the given chat. Called on
 * CHAT_CHANGED after setCurrentChatId so resume-after-reload reads the right data.
 *
 * @param {string} chatId
 * @returns {Promise<number>}  Number of verdicts hydrated.
 */
export async function hydrateChat(chatId) {
    if (!chatId) return 0;
    try {
        const records = await listIdbForChat(chatId);
        if (records.length === 0) return 0;
        // Newest-first by msgIdx, take RING_CAP (or fewer).
        const sorted = [...records].sort((a, b) => (b.msgIdx - a.msgIdx) || (b.ts - a.ts));
        const slice = sorted.slice(0, RING_CAP).reverse(); // chronological order in ring.
        // Drop any existing ring rows for this chat first to avoid dupes.
        ring = ring.filter(v => v.chatId !== chatId);
        ring.push(...slice);
        ring = evictRing(ring, RING_CAP);
        notify();
        pushEvent('verdict_hydrate', { chatId, count: slice.length });
        return slice.length;
    } catch (err) {
        console.warn('[DLE] Verdict hydrateChat failed:', err?.message);
        return 0;
    }
}

/**
 * Internal: list all IDB rows for a chat. Iterates the verdicts store and
 * filters by chatId field. (No IDB index on chatId yet — store is small per
 * the per-chat cap, so a full scan is acceptable.)
 *
 * @param {string} chatId
 * @returns {Promise<import('./verdict-pure.js').Verdict[]>}
 */
async function listIdbForChat(chatId) {
    const db = await openDB();
    try {
        const tx = db.transaction(VERDICT_STORE, 'readonly');
        const store = tx.objectStore(VERDICT_STORE);
        const all = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        return all.filter(v => v && v.chatId === chatId && validateVerdict(v));
    } finally {
        db.close();
    }
}

/**
 * Prune the current chat's IDB store down to IDB_PER_CHAT_CAP records.
 * Called after each writeVerdict.
 *
 * @returns {Promise<number>}  Number of records deleted.
 */
async function pruneCurrentChat() {
    if (!currentChatId) return 0;
    const records = await listIdbForChat(currentChatId);
    const catalog = records.map(v => ({ msgIdx: v.msgIdx, ts: v.ts, key: buildIdbKey(v) }));
    const victims = selectPruneVictims(catalog, IDB_PER_CHAT_CAP);
    if (victims.length === 0) return 0;
    const db = await openDB();
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
 * touch IDB (use clearChat(null) for that).
 */
export function resetForTests() {
    ring = [];
    currentChatId = null;
    observers.clear();
}

/**
 * Debug-only snapshot of the ring buffer. Don't use in prod consumers — read
 * via getCurrent / getPrevious / getByMessage instead.
 * @returns {import('./verdict-pure.js').Verdict[]}
 */
export function _debugRingSnapshot() {
    return [...ring];
}
