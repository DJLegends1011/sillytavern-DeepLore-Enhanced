/**
 * DeepLore Enhanced — IndexedDB Persistent Vault Cache
 * Stores parsed vault index with content hashes for instant hydration on page load.
 * Validates against Obsidian in background after hydration.
 */

import { getSettings } from '../../settings.js';
import { dedupWarning } from '../toast-dedup.js';
import { pushEvent } from '../diagnostics/interceptors.js';
import { simpleHash } from '../../core/utils.js';
import { validateCachedEntry } from './cache-validate.js';
export { validateCachedEntry };

const DB_NAME = 'DeepLoreEnhanced';
// v2 (2026-05-22): added `verdicts` object store for VerdictStore. Both modules must
// use the same version so neither throws VersionError when the other has upgraded.
const DB_VERSION = 2;
const STORE_NAME = 'vaultCache';
const VERDICT_STORE_NAME = 'verdicts'; // owned by src/verdict/verdict-store.js, created here too for coexistence on upgrade.
const CACHE_SCHEMA_VERSION = 4; // H-06: key includes lorebookTag + conflictResolution

/**
 * BUG-371: tracks whether the most recent saveIndexToCache call persisted.
 * pruneOrphanedCacheKeys reads this so a quota/blocked failure doesn't wipe
 * every key and leave the user with no valid cache. null = no save attempted
 * (prune safe — it can only remove keys for vaults the user no longer has).
 */
let _lastSaveSucceeded = null;

/**
 * Build a cache key incorporating enabled vault configuration so multi-vault
 * setups can't serve vault A's cache as vault B's data.
 */
function getCacheKey() {
    try {
        const settings = getSettings();
        const fp = (settings.vaults || [])
            .filter(v => v.enabled)
            .map(v => `${v.name}:${v.host || '127.0.0.1'}:${v.port}:${v.https ? 'https' : 'http'}:${simpleHash(v.apiKey || '')}`)
            .sort()
            .join('|');
        // H-06: tag and conflict mode are part of the fingerprint so changing either
        // invalidates the cache instead of serving stale data.
        const tag = settings.lorebookTag || 'lorebook';
        const conflict = settings.multiVaultConflictResolution || 'all';
        return fp ? `index_${tag}_${conflict}_${fp}` : 'primaryIndex';
    } catch (err) {
        console.warn('[DLE] getCacheKey failed, using fallback key:', err?.message);
        return 'primaryIndex';
    }
}

/** @returns {Promise<IDBDatabase>} */
function openDBOnce() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
            // VerdictStore co-creates this from src/verdict/verdict-store.js; create here too so
            // whichever module opens the DB first triggers a complete upgrade.
            if (!db.objectStoreNames.contains(VERDICT_STORE_NAME)) {
                db.createObjectStore(VERDICT_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            console.warn('[DLE] IndexedDB open blocked — another tab may have an older version open');
            reject(Object.assign(new Error('IndexedDB open blocked by another connection'), { code: 'BLOCKED' }));
        };
    });
}

/** BUG-379: one-shot backoff retry on blocked. @returns {Promise<IDBDatabase>} */
function openDB() {
    return openDBOnce().catch(async (err) => {
        if (err && err.code === 'BLOCKED') {
            console.warn('[DLE] IndexedDB blocked — retrying in 250ms');
            try {
                dedupWarning(
                    'Vault cache database is blocked by another tab. Close other SillyTavern tabs if lore fails to load.',
                    'cache_blocked',
                );
            } catch { /* toastr may not be ready */ }
            await new Promise(r => setTimeout(r, 250));
            return openDBOnce();
        }
        throw err;
    });
}

/**
 * Save the parsed vault index to IndexedDB.
 * Stores entry data + content hashes for validation on next load.
 * @param {import('../core/pipeline.js').VaultEntry[]} entries - Parsed vault entries
 * @returns {Promise<boolean>} true if the cache was successfully persisted; false on quota/other failure
 */
export async function saveIndexToCache(entries) {
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const cacheData = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            timestamp: Date.now(),
            entries: entries.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_') || k === '_contentHash' || k === '_originalRequires' || k === '_originalExcludes' || k === '_originalCascadeLinks'))),
        };

        store.put(cacheData, getCacheKey());

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
        _lastSaveSucceeded = true;
        pushEvent('cache_save', { entryCount: entries.length, ok: true });
        return true;
    } catch (err) {
        _lastSaveSucceeded = false;
        pushEvent('cache_save', { entryCount: entries.length, ok: false, error: err?.name || err?.message });
        if (err.name === 'QuotaExceededError' || (err.message && err.message.includes('quota'))) {
            console.warn('[DLE] IndexedDB storage quota exceeded — vault cache could not be saved. Consider clearing browser data.');
            try {
                dedupWarning(
                    'Browser storage full — vault cache could not be saved. Free space by clearing this site\'s data in your browser settings (Settings > Privacy > Site Data).',
                    'cache_quota',
                );
            } catch {
                // toastr may not be available in all contexts
            }
        } else {
            console.warn('[DLE] Failed to save index to IndexedDB:', err.message);
        }
        return false;
    } finally {
        if (db) db.close();
    }
}

/**
 * Load the vault index from IndexedDB cache.
 * @returns {Promise<{ entries: import('../core/pipeline.js').VaultEntry[], timestamp: number } | null>}
 */
export async function loadIndexFromCache() {
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const result = await new Promise((resolve, reject) => {
            const request = store.get(getCacheKey());
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!result || !Array.isArray(result.entries) || result.entries.length === 0) {
            return null;
        }

        if (result.schemaVersion !== CACHE_SCHEMA_VERSION) {
            if (getSettings().debugMode) console.log(`[DLE] Cache schema version mismatch (have ${result.schemaVersion}, want ${CACHE_SCHEMA_VERSION}) — rebuilding`);
            try { dedupWarning('Refreshing your lore cache after an update — back in a moment.', 'cache_schema'); } catch { /* toastr may not be ready */ }
            return null;
        }

        // Discard corrupt entries from browser crashes / quota pressure.
        const validEntries = result.entries.filter(e => {
            const ok = validateCachedEntry(e);
            if (!ok) console.warn(`[DLE] Discarding corrupt cached entry: ${e?.title || '(no title)'}`);
            return ok;
        });
        if (validEntries.length === 0) return null;

        const discarded = result.entries.length - validEntries.length;
        pushEvent('cache_load', { hit: true, entryCount: validEntries.length, corruptDiscarded: discarded });
        return {
            entries: validEntries,
            timestamp: result.timestamp || 0,
        };
    } catch (err) {
        console.warn('[DLE] Failed to load index from IndexedDB:', err.message);
        pushEvent('cache_load', { hit: false, error: err?.message });
        return null;
    } finally {
        if (db) db.close();
    }
}

/**
 * H20: Remove orphaned cache keys that don't match the current vault config.
 *
 * BUG-371: must guard against the case where the new index failed to persist
 * (quota, blocked) — otherwise we wipe every key and leave the user with nothing.
 * Reads the module-level `_lastSaveSucceeded` flag by default; tests may override.
 *
 * @param {boolean} [saveSucceeded] - Override the module-level save-success flag.
 * @returns {Promise<number>} Number of orphaned keys removed
 */
export async function pruneOrphanedCacheKeys(saveSucceeded) {
    const effective = (saveSucceeded === undefined) ? _lastSaveSucceeded : saveSucceeded;
    if (effective === false) {
        console.warn('[DLE] Skipping orphan prune — prior saveIndexToCache did not succeed (would have wiped valid cache)');
        return 0;
    }
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const currentKey = getCacheKey();

        const allKeys = await new Promise((resolve, reject) => {
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        let pruned = 0;
        for (const key of allKeys) {
            if (key !== currentKey) {
                store.delete(key);
                pruned++;
            }
        }

        // BUG-380: always await the transaction before db.close(), even if no deletes
        // were issued — closing during an in-flight transaction can abort it.
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
        if (pruned > 0 && getSettings().debugMode) console.log(`[DLE] Pruned ${pruned} orphaned cache key(s)`);
        return pruned;
    } catch (err) {
        console.warn('[DLE] Failed to prune orphaned cache keys:', err.message);
        return 0;
    } finally {
        if (db) db.close();
    }
}

/**
 * Clear the IndexedDB vault cache.
 * @returns {Promise<void>}
 */
export async function clearIndexCache() {
    // BUG-123: clear ALL keys, not just the current fingerprint — old fingerprints
    // from previous vault configs would otherwise linger until next prune.
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('[DLE] Failed to clear IndexedDB cache:', err.message);
    } finally {
        if (db) db.close();
    }
}
