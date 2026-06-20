/**
 * DeepLore — Vault change detection and sync polling
 */
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import { syncIntervalId, indexing, setSyncIntervalId, setIndexing, setBuildPromise, buildEpoch, setBuildEpoch } from '../state.js';
import { getAllCircuitStates } from './obsidian-api.js';

const SYNC_TOAST_TIMEOUT = 8000;
const SYNC_EXTENDED_TIMEOUT = 12000;

// First observation of indexing=true — used to detect stuck builds.
let _indexingSeenSince = 0;

// BUG-018: each setupSyncPolling call bumps this so previously-running chains can bail.
let _syncEpoch = 0;

/**
 * Show a toast notification summarizing vault changes.
 * @param {{ added: string[], removed: string[], modified: string[], keysChanged: string[] }} changes
 */
export function showChangesToast(changes) {
    const truncList = (arr, max = 3) => {
        const shown = arr.slice(0, max).map(s => escapeHtml(s)).join(', ');
        return arr.length > max ? shown + '...' : shown;
    };

    const parts = [];
    if (changes.added.length > 0) {
        parts.push(`+${changes.added.length} new: ${truncList(changes.added)}`);
    }
    if (changes.removed.length > 0) {
        parts.push(`-${changes.removed.length} removed: ${truncList(changes.removed)}`);
    }
    if (changes.modified.length > 0) {
        parts.push(`~${changes.modified.length} modified: ${truncList(changes.modified)}`);
    }
    if (changes.keysChanged.length > 0) {
        parts.push(`Keys changed: ${truncList(changes.keysChanged)}`);
    }

    toastr.info(parts.join('<br>'), 'DeepLore', {
        timeOut: SYNC_TOAST_TIMEOUT,
        extendedTimeOut: SYNC_EXTENDED_TIMEOUT,
        progressBar: true,
        closeButton: true,
        enableHtml: true,
    });
}

/**
 * Set up or tear down periodic vault sync polling.
 * Uses reuse sync when possible (fetch all, skip re-parse of unchanged),
 * falling back to full rebuild if reuse sync fails.
 * @param {Function} [buildIndexFn] - The buildIndex function
 * @param {Function} [buildIndexWithReuseFn] - The buildIndexWithReuse function (optional)
 */
export function setupSyncPolling(buildIndexFn, buildIndexWithReuseFn) {
    const settings = getSettings();

    if (syncIntervalId) {
        clearTimeout(syncIntervalId);
        setSyncIntervalId(null);
    }

    // BUG-018: bump sync epoch to orphan any previously running polling chain.
    const myEpoch = ++_syncEpoch;

    if (settings.syncPollingInterval > 0 && settings.enabled && buildIndexFn) {
        // setTimeout-chained instead of setInterval to prevent overlapping callbacks.
        const scheduleNext = () => {
            if (_syncEpoch !== myEpoch) return;
            // Re-read interval per tick so changes take effect without restart.
            const currentInterval = getSettings().syncPollingInterval;
            if (currentInterval <= 0) return;
            setSyncIntervalId(setTimeout(async () => {
                if (_syncEpoch !== myEpoch) return; // re-check after await

                const current = getSettings();
                if (!current.enabled) {
                    scheduleNext();
                    return;
                }
                // Stuck-indexing guard: force-release after 120s.
                if (indexing) {
                    if (!_indexingSeenSince) _indexingSeenSince = Date.now();
                    if (Date.now() - _indexingSeenSince > 120_000) {
                        console.warn('[DLE] Sync: indexing flag stuck for >120s, force-releasing');
                        setIndexing(false);
                        setBuildPromise(null); // BUG-034: clear stale buildPromise
                        setBuildEpoch(buildEpoch + 1); // BUG-015: invalidate stuck coroutine
                        _indexingSeenSince = 0;
                    } else {
                        scheduleNext();
                        return;
                    }
                } else {
                    _indexingSeenSince = 0;
                }

                // Skip only when EVERY vault circuit is open — one open circuit must
                // not starve healthy vaults. Empty state (cold start) proceeds normally.
                const allStates = getAllCircuitStates();
                const keys = Object.keys(allStates);
                if (keys.length > 0 && keys.every(k => allStates[k].state === 'open')) {
                    if (current.debugMode) {
                        console.debug('[DLE] Sync: all vault circuits open — skipping this tick');
                    }
                    scheduleNext();
                    return;
                }

                try {
                    if (buildIndexWithReuseFn) {
                        const deltaOk = await buildIndexWithReuseFn();
                        if (deltaOk) { scheduleNext(); return; }
                    }
                    await buildIndexFn();
                } catch (err) {
                    console.warn('[DLE] Sync polling error:', err.message);
                }
                scheduleNext();
            }, currentInterval * 1000));
        };
        scheduleNext();
    }
}
