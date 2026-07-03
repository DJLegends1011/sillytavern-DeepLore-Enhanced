/**
 * DeepLore — Toast facade + deduplication.
 *
 * Two layers live here:
 *
 *  1. The low-level dedup window (`_isDuplicate` / `_stampShown`) — suppresses
 *     repeats of the same `category` within DEDUP_WINDOW_MS. Keyed by category so
 *     different messages about the same root cause still dedup.
 *
 *  2. The `notify` facade (v2.6 E1) — a single entry point that routes severity,
 *     applies the same dedup window, and adds two affordances raw toastr lacks:
 *       - click-to-copy error bodies (`copyable: true`)
 *       - optional action buttons (`actions: [{ label, onClick }]`)
 *
 * The legacy `dedupError` / `dedupWarning` exports are PRESERVED verbatim in
 * behavior and signature (other modules import them and the R1 contract — they
 * return a "was actually shown" boolean and share dedup categories like
 * 'ai_circuit'). They are now thin shims over the shared `_emit` core, so the
 * dedup window and the L-34 "stamp only after a successful render" rule stay
 * identical across the old helpers and the new facade.
 *
 * Dependency-light: the only runtime globals touched are `toastr` (toastr lib,
 * provided by ST) and `document`/`navigator` (for copy + action buttons), each
 * probed defensively so this module is safe to import before the DOM/toastr are
 * ready and safe to re-import (no top-level side effects).
 */

const DEDUP_WINDOW_MS = 10_000;

/** @type {Map<string, number>} category → timestamp of last toast */
const recentToasts = new Map();

/** Severity → toastr method name + default timeout (ms). */
const SEVERITY_MAP = {
    info: { method: 'info', timeOut: 5000 },
    success: { method: 'success', timeOut: 5000 },
    warning: { method: 'warning', timeOut: 8000 },
    error: { method: 'error', timeOut: 10000 },
};

/**
 * Shared emit core. Honors the dedup window when `category` is provided, stamps
 * the window only after a successful render (L-34), and wires the optional
 * copyable / action-button affordances.
 *
 * @param {object} cfg
 * @param {'info'|'success'|'warning'|'error'} cfg.severity
 * @param {string} cfg.message            - body text (already i18n'd by caller)
 * @param {string} [cfg.title]            - toast title (defaults to 'DeepLore')
 * @param {string} [cfg.category]         - dedup key; omit to bypass dedup entirely
 * @param {string} [cfg.hint]             - console-only diagnostic; also set as
 *                                          the toast title attr if `title` unset
 * @param {boolean} [cfg.copyable]        - make the body click-to-copy
 * @param {string} [cfg.copyText]         - text copied on click (defaults to message)
 * @param {Array<{label:string,onClick:Function}>} [cfg.actions] - action buttons
 * @param {object} [cfg.options]          - extra toastr options (timeOut, etc.)
 * @returns {boolean} true only if a toast actually rendered (not deduped, toastr
 *   present, no throw). Lets callers gate side effects on real surfacing.
 */
function _emit(cfg) {
    const {
        severity = 'info',
        message,
        title,
        category,
        hint,
        copyable = false,
        copyText,
        actions,
        options = {},
    } = cfg || {};

    if (category && _isDuplicate(category)) return false;
    if (hint) console.warn('[DLE]', category || severity, '-', hint);

    const sev = SEVERITY_MAP[severity] || SEVERITY_MAP.info;
    const wantsInteraction = copyable || (Array.isArray(actions) && actions.length > 0);

    // Copy/action affordances need the toast element to stick around long enough
    // to click. Bump the timeout and disable on-hover auto-hide unless the caller
    // already pinned their own values. closeButton is FORCED on: ST's global
    // toastr.options sets closeButton:false and tapToDismiss is off here, so
    // without an explicit × these zero-timeout toasts would be undismissable (stuck
    // until reload). toastr renders its own × with class .toast-close-button, which
    // _attachCopy already excludes from the click-to-copy handler.
    const interactionDefaults = wantsInteraction
        ? { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true }
        : {};

    try {
        const t = toastr[sev.method](message, title || 'DeepLore', {
            timeOut: sev.timeOut,
            ...interactionDefaults,
            ...options,
        });

        // toastr returns a jQuery-wrapped node (or undefined if it deduped via its
        // own preventDuplicates). Only decorate when we actually got an element.
        const el = t && t[0];
        if (el) {
            if (hint && !title) el.title = hint;
            if (copyable) _attachCopy(el, copyText != null ? copyText : message);
            if (Array.isArray(actions) && actions.length > 0) _attachActions(el, actions);
        }

        // L-34: stamp the dedup window only AFTER a successful render — a thrown
        // toastr call shows nothing, so retries must not be suppressed.
        if (category) _stampShown(category);
        return true;
    } catch (e) {
        const log = severity === 'error' ? console.error : console.warn;
        log('[DLE] toastr unavailable:', category || severity, message, e?.message);
        return false;
    }
}

/**
 * Make a rendered toast body click-to-copy. Best-effort: if neither the async
 * clipboard API nor the legacy execCommand path is available, the click is a
 * no-op (we never throw out of a toast handler).
 * @param {HTMLElement} el  - toastr's wrapper element
 * @param {string} text     - text to copy
 */
function _attachCopy(el, text) {
    try {
        el.classList.add('dle-toast-copyable');
        el.setAttribute('title', 'Click to copy');
        el.addEventListener('click', (ev) => {
            // Don't hijack clicks on action buttons / the close affordance.
            const tgt = ev.target;
            if (tgt && tgt.closest && tgt.closest('.dle-toast-action, .toast-close-button')) return;
            _copyToClipboard(String(text));
            el.classList.add('dle-toast-copied');
            setTimeout(() => { try { el.classList.remove('dle-toast-copied'); } catch { /* gone */ } }, 1200);
        });
    } catch { /* DOM unavailable — skip the affordance, toast still shows */ }
}

/**
 * Append action buttons to a rendered toast. Each button calls its `onClick`
 * (errors swallowed so one bad handler can't take down the toast).
 * @param {HTMLElement} el
 * @param {Array<{label:string,onClick:Function}>} actions
 */
function _attachActions(el, actions) {
    try {
        const bar = document.createElement('div');
        bar.className = 'dle-toast-actions';
        for (const a of actions) {
            if (!a || !a.label) continue;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dle-toast-action menu_button';
            btn.textContent = a.label;
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation(); // don't trigger copy/dismiss
                try { a.onClick?.(ev); } catch (e) { console.warn('[DLE] toast action failed:', e?.message); }
            });
            bar.appendChild(btn);
        }
        if (bar.childNodes.length) el.appendChild(bar);
    } catch { /* DOM unavailable — skip buttons, toast still shows */ }
}

/** Copy `text` to clipboard, async API first, execCommand fallback, never throws. */
function _copyToClipboard(text) {
    try {
        if (navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => _execCopy(text));
            return;
        }
    } catch { /* fall through */ }
    _execCopy(text);
}

function _execCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    } catch { /* best-effort only */ }
}

/**
 * The `notify` facade — preferred entry point for new toast sites.
 *
 * Usage:
 *   notify.error('Couldn't reach your vault.', { category: 'obsidian_connect' });
 *   notify.error(classifyError(err), { copyable: true });
 *   notify({ severity: 'warning', message: 'Reindex failed', copyable: true,
 *            actions: [{ label: 'Retry', onClick: () => buildIndex() }] });
 *
 * `dedupKey` is accepted as an alias for `category` (both map to the same window).
 *
 * @param {object} cfg - see {@link _emit}; also accepts `dedupKey` alias.
 * @returns {boolean} true if a toast actually rendered.
 */
export function notify(cfg = {}) {
    const { dedupKey, ...rest } = cfg;
    return _emit({ ...rest, category: rest.category ?? dedupKey });
}

/**
 * Severity helper factory. `notify.error(message, opts)` etc.
 * @param {'info'|'success'|'warning'|'error'} severity
 */
function _severityHelper(severity) {
    /**
     * @param {string} message
     * @param {object} [opts] - { category|dedupKey, title, hint, copyable, copyText, actions, ...toastrOptions }
     * @returns {boolean} true if a toast actually rendered.
     */
    return function (message, opts = {}) {
        const { category, dedupKey, title, hint, copyable, copyText, actions, ...options } = opts;
        return _emit({
            severity,
            message,
            title,
            category: category ?? dedupKey,
            hint,
            copyable,
            copyText,
            actions,
            options,
        });
    };
}

notify.info = _severityHelper('info');
notify.success = _severityHelper('success');
notify.warning = _severityHelper('warning');
notify.error = _severityHelper('error');

/**
 * toastr.error if category hasn't fired recently. Thin shim over `_emit` — the
 * R1 signature + return contract is preserved exactly.
 * @param {string} message
 * @param {string} category - dedup key (e.g. 'obsidian_connect')
 * @param {object} [options] - merged with toastr defaults; `hint` is console-only
 * @returns {boolean} true only if a toast was actually shown (not suppressed by
 *   the dedup window, and toastr did not throw). Lets callers gate side effects
 *   (e.g. markAiCircuitTripSurfaced) on the toast having actually surfaced.
 */
export function dedupError(message, category, options = {}) {
    const { hint, ...rest } = options;
    return _emit({ severity: 'error', message, category, hint, options: rest });
}

/**
 * toastr.warning if category hasn't fired recently. Thin shim over `_emit`.
 * @param {string} message
 * @param {string} category
 * @param {object} [options] - merged with toastr defaults; `hint` is console-only
 * @returns {boolean} true only if a toast was actually shown (see dedupError).
 */
export function dedupWarning(message, category, options = {}) {
    const { hint, ...rest } = options;
    return _emit({ severity: 'warning', message, category, hint, options: rest });
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
