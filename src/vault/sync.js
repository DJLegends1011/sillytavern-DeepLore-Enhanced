/**
 * DeepLore — Vault change detection and sync polling
 */
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import { syncIntervalId, indexing, setSyncIntervalId, setIndexing, setBuildPromise, buildEpoch, setBuildEpoch, getIndexBuildReport } from '../state.js';
import { getAllCircuitStates } from './obsidian-api.js';
import { tr, trf, trPlural } from '../i18n/i18n.js';
import { openLintPopup } from '../ui/commands-lint.js';

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

    // Surface warnings/skips from the same build so the lint tool is discoverable
    // at the moment authoring breaks — a passive, clickable pointer, not an
    // auto-popup (auto-lint-after-build stays OFF per directive). Suppressed when
    // counts are zero so clean builds stay quiet.
    const report = getIndexBuildReport();
    const warnCount = report ? (report.warnCount || 0) : 0;
    const skipCount = report ? (report.skipCount || 0) : 0;
    const showLintPointer = (warnCount + skipCount) > 0;
    if (showLintPointer) {
        const segs = [];
        if (skipCount > 0) segs.push(trf('dle_sync_toast_skipped', skipCount));
        if (warnCount > 0) segs.push(trPlural('dle_sync_toast_warnings', warnCount));
        const cta = `<span class="dle-lint-toast-link" style="text-decoration:underline;cursor:pointer">${escapeHtml(tr('dle_sync_toast_lint_cta'))}</span>`;
        parts.push(`<span class="dle-sync-toast-lint">⚠ ${escapeHtml(segs.join(' · '))} — ${cta}</span>`);
    }

    // escapeHtml:false — this toast intentionally renders markup (<br> joins + the
    // clickable lint CTA span). toastr 2.1.3 has NO `enableHtml` option (that's
    // angular-toastr); the real toggle is `escapeHtml`, and ST's global sets it
    // true, so we must override it here or the markup renders as literal text and
    // the CTA click handler never binds. All dynamic content above is already
    // escaped piecewise (truncList + escapeHtml), so this is safe.
    const $toast = toastr.info(parts.join('<br>'), 'DeepLore', {
        timeOut: SYNC_TOAST_TIMEOUT,
        extendedTimeOut: SYNC_EXTENDED_TIMEOUT,
        progressBar: true,
        closeButton: true,
        escapeHtml: false,
    });

    // Open the lint popup when the pointer is clicked. Scoped to the lint link so
    // clicking elsewhere on the toast keeps toastr's default dismiss behavior.
    if (showLintPointer && $toast && typeof $toast.on === 'function') {
        $toast.on('click', '.dle-lint-toast-link', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openLintPopup();
        });
    }
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
