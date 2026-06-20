/**
 * DeepLore — Toast Deduplication.
 * Suppresses repeats within DEDUP_WINDOW_MS. Keyed by category so different
 * messages about the same root cause still dedup.
 */

const DEDUP_WINDOW_MS = 10_000;

/** @type {Map<string, number>} category → timestamp of last toast */
const recentToasts = new Map();

/**
 * toastr.error if category hasn't fired recently.
 * @param {string} message
 * @param {string} category - dedup key (e.g. 'obsidian_connect')
 * @param {object} [options] - merged with toastr defaults
 */
export function dedupError(message, category, options = {}) {
    if (_isDuplicate(category)) return;
    const { hint, ...rest } = options;
    if (hint) console.warn('[DLE]', category, '-', hint);
    try {
        const t = toastr.error(message, 'DeepLore', {
            timeOut: 10000,
            ...rest,
        });
        if (hint && t && t[0]) t[0].title = hint;
        // L-34: stamp the dedup window only AFTER a successful toast — if the
        // call above throws, no toast was shown, so retries must not be suppressed.
        _stampShown(category);
    } catch (e) {
        console.error('[DLE] toastr unavailable:', category, message, e?.message);
    }
}

/**
 * toastr.warning if category hasn't fired recently.
 * @param {string} message
 * @param {string} category
 * @param {object} [options] - merged with toastr defaults
 */
export function dedupWarning(message, category, options = {}) {
    if (_isDuplicate(category)) return;
    const { hint, ...rest } = options;
    if (hint) console.warn('[DLE]', category, '-', hint);
    try {
        const t = toastr.warning(message, 'DeepLore', {
            timeOut: 8000,
            ...rest,
        });
        if (hint && t && t[0]) t[0].title = hint;
        // L-34: stamp the dedup window only AFTER a successful toast (see dedupError).
        _stampShown(category);
    } catch (e) {
        console.warn('[DLE] toastr unavailable:', category, message, e?.message);
    }
}

/**
 * Pure check — does NOT stamp the window. L-34: stamping moved to `_stampShown`,
 * called only after a toast actually renders, so a failed toastr call doesn't
 * suppress the next 10s of retries for a toast that was never shown.
 * @param {string} category
 * @returns {boolean} true if duplicate (suppress)
 */
function _isDuplicate(category) {
    const now = Date.now();
    const last = recentToasts.get(category);
    return !!(last && now - last < DEDUP_WINDOW_MS);
}

/**
 * Record that a toast for `category` was successfully shown, opening the dedup
 * window from now.
 * @param {string} category
 */
function _stampShown(category) {
    recentToasts.set(category, Date.now());
}
