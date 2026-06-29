/**
 * DeepLore — WI Import Report (Wave 5, v2.5 WI parity)
 *
 * Browser wrapper around wi-import-report-pure.js. Renders the structured
 * post-import popup that replaces the old success/warning toast. Resolves
 * i18n via ST's tr() at popup-render time and passes the localized strings
 * dict into the pure renderer.
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { buildImportReport, renderImportReportHtml } from './wi-import-report-pure.js';
import { tr } from '../i18n/i18n.js';

// Re-export pure helpers so other modules + tests have a single import surface.
export { buildImportReport, renderImportReportHtml };

/**
 * Resolve every popup string from the active DLE locale dict.
 *
 * Placeholders follow DLE's `${0}`, `${1}` convention (CLAUDE.md i18n note).
 * tr() returns the raw value when the key is present in the active locale,
 * the EN fallback dict otherwise, then ST's translate() as the final tier.
 * If all three miss, returns the key string itself — which would render an
 * ugly key in the popup; we substitute the EN default inline as a last
 * defensive fallback by checking whether the resolved value equals the key.
 */
function _resolved(key, fallback) {
    const v = tr(key);
    return v === key ? fallback : v;
}

function _interp(template, ...args) {
    // ${0}, ${1}, … positional placeholder substitution.
    return String(template).replace(/\$\{(\d+)\}/g, (_, i) => {
        const v = args[Number(i)];
        return v == null ? '' : String(v);
    });
}

function buildI18nStrings() {
    return {
        header: (n, source, folderLabel) => _interp(
            _resolved('dle_wi_import_report_header', 'Imported ${0} entries from "${1}" into ${2}'),
            n, source, folderLabel,
        ),
        folderLabel: (folder) => _interp(
            _resolved('dle_wi_import_report_folder_label', 'folder <code>${0}/</code>'),
            folder,
        ),
        vaultRoot: () => _resolved('dle_wi_import_report_vault_root', 'vault root'),
        renamed: (n) => _interp(_resolved('dle_wi_import_report_renamed', '${0} renamed to avoid collision'), n),
        failed: (n) => _interp(_resolved('dle_wi_import_report_failed', '${0} failed'), n),
        nativeSection: () => _resolved('dle_wi_import_report_native_section', 'Fields imported and active'),
        roundTripSection: () => _resolved('dle_wi_import_report_roundtrip_section', 'SillyTavern-specific fields preserved (not acted on)'),
        roundTripExplainer: () => _resolved('dle_wi_import_report_roundtrip_explainer', 'Safe to ignore — DeepLore doesn\'t use these. They land in vault frontmatter so you can see what SillyTavern had configured. Remove the lines only if your Markdown feels cluttered. Run <code>/dle-lint</code> to find which entries carry them.'),
        emSection: () => _resolved('dle_wi_import_report_em_section', 'Example Messages handling'),
        emAppendedCount: (n) => _interp(_resolved('dle_wi_import_report_em_appended', '${0} appended as subheader'), n),
        emSkippedCount: (n) => _interp(_resolved('dle_wi_import_report_em_skipped', '${0} skipped'), n),
        emExplainer: () => _resolved('dle_wi_import_report_em_explainer', 'SillyTavern\'s "Example Messages" slot is a special prompt position for sample dialogue lines that ride alongside the example messages already in your chat. DeepLore doesn\'t have that slot — by default we tuck these entries\' content under a "## Example Dialogue" subheader inside the entry body, so they still reach the model when the entry triggers.<br><br>Honestly, one short flavor quote inside a character entry is usually enough to teach an LLM the voice. If you\'d rather skip them on future imports, the button below flips the setting permanently (until you change it back in <code>Settings → DeepLore → Matching → Import → WI Example Messages on import</code>). Entries already imported stay in the vault — <code>/dle-delete</code> them by name if you want them gone.'),
        emSkipButton: () => _resolved('dle_wi_import_report_em_skip_button', 'Always skip Example Messages on import (reversible in settings)'),
        emEntriesTitle: (n) => _interp(_resolved('dle_wi_import_report_em_entries_title', 'Entry titles (${0})'), n),
        skippedTag: () => _resolved('dle_wi_import_report_skipped_tag', '(skipped)'),
        andMore: (n) => _interp(_resolved('dle_wi_import_report_and_more', 'and ${0} more'), n),
        skippedSection: () => _resolved('dle_wi_import_report_skipped_section', 'Skipped fields'),
        errorsSection: (n) => _interp(_resolved('dle_wi_import_report_errors_section', 'Errors (${0})'), n),

        // Reconciliation view (R2 — recovery path for failed/skipped imports).
        recoverySection: (n) => _interp(_resolved('dle_import_recovery_section', 'Didn\'t import (${0})'), n),
        recoveryIntro: () => _resolved('dle_import_recovery_intro', 'These entries were refused. Review the reason, then retry the ones worth another attempt or dismiss the rest.'),
        recoveryColEntry: () => _resolved('dle_import_recovery_col_entry', 'Entry'),
        recoveryColReason: () => _resolved('dle_import_recovery_col_reason', 'Reason'),
        recoveryColAction: () => _resolved('dle_import_recovery_col_action', 'Action'),
        recoveryUnnamed: () => _resolved('dle_import_recovery_unnamed', '(unnamed entry)'),
        recoveryRetry: () => _resolved('dle_import_recovery_retry', 'Retry'),
        recoveryDismiss: () => _resolved('dle_import_recovery_dismiss', 'Dismiss'),
        recoveryRetryAll: (n) => _interp(_resolved('dle_import_recovery_retry_all', 'Retry all ${0}'), n),
        recoveryNoRetry: () => _resolved('dle_import_recovery_no_retry', 'Retry won\'t help'),
        recoveryRetrying: () => _resolved('dle_import_recovery_retrying', 'Retrying…'),
        recoveryRetrySucceeded: () => _resolved('dle_import_recovery_retry_succeeded', 'Imported'),
        recoveryRetryFailed: () => _resolved('dle_import_recovery_retry_failed', 'Failed again'),
        recoveryDismissed: () => _resolved('dle_import_recovery_dismissed', 'Dismissed'),
        recoveryRetryUnavailable: () => _resolved('dle_import_recovery_retry_unavailable', 'Retry isn\'t available here — re-run the import from the original source to recover these entries.'),
        catTransient: () => _resolved('dle_import_recovery_cat_transient', 'connection'),
        catCollision: () => _resolved('dle_import_recovery_cat_collision', 'name clash'),
        catConvert: () => _resolved('dle_import_recovery_cat_convert', 'bad data'),
        catWrite: () => _resolved('dle_import_recovery_cat_write', 'write failed'),
        catUnknown: () => _resolved('dle_import_recovery_cat_unknown', 'error'),
    };
}

/**
 * Show the import report popup. Wires the "Skip EM on future imports" button
 * to flip settings.wiImportEmHandling, plus the per-entry recovery table's
 * Retry / Dismiss / Retry-all actions. Browser-only.
 *
 * @param {object} result - importEntries() return value
 * @param {string} source - lorebook/source label
 * @param {string} folder - target vault folder
 * @param {object} [deps]
 * @param {() => object} [deps.getSettings]
 * @param {() => void} [deps.saveSettings]
 * @param {(failures: object[]) => Promise<object>} [deps.onRetry] - re-run the
 *   import for the given failure rows (a subset of `report.failures`, each
 *   `{ name, reason, category, retryable }` where `name` is the entry's
 *   filename). The call site owns mapping each row back to its source WI entry
 *   (it holds the parsed `entries[]`) and MUST return an importEntries-shaped
 *   result `{ imported, failed, errors, ... }`. When present, the recovery
 *   table shows live Retry buttons; when absent it is read-only with a
 *   "re-run from source" hint. See the call-site HOOK in the task notes.
 */
export async function showImportReport(result, source, folder, deps = {}) {
    const report = buildImportReport(result, source, folder);
    const strings = buildI18nStrings();
    // Gate the live recovery actions on a wired retry hook. Without it, the
    // table renders read-only (rows still listed; no per-row Retry button).
    const canRetry = typeof deps.onRetry === 'function' && report.retryableCount > 0;
    strings.__canRetry = canRetry;
    const html = renderImportReportHtml(report, strings);

    // callGenericPopup doesn't return the DOM directly so scope the listener
    // to ST's `.popup` container — narrows the document-level handler from
    // the audit-flagged "any DOM surface with that class" to just the popup
    // body, in case some other UI later reuses the class name.
    const doneText = _resolved(
        'dle_wi_import_report_em_skip_done',
        'Done — Example Messages will be skipped on future imports. Revert in Settings → DeepLore → Matching → Import.',
    );
    // Per-row recovery state, so a retried/dismissed row doesn't fire twice.
    const rowDone = new Set();

    // Resolve a recovery <tr> by failure index; set its action cell to a status
    // pill. Scoped to the popup so we never touch unrelated DOM.
    const setRowStatus = (root, idx, statusKey, cls) => {
        const tr = root.querySelector(`.dle-import-recovery-row[data-dle-import-row="${idx}"]`);
        if (!tr) return;
        const cell = tr.querySelector('.dle-import-recovery-action');
        if (cell) cell.innerHTML = `<span class="dle-import-recovery-status ${cls}">${strings[statusKey]()}</span>`;
        tr.classList.add('dle-import-recovery-row-done');
    };

    // Run deps.onRetry for a set of failure indices, reflecting results per row.
    const runRetry = async (root, indices) => {
        const live = indices.filter((i) => !rowDone.has(i) && report.failures[i] && report.failures[i].retryable);
        if (live.length === 0) return;
        for (const i of live) {
            rowDone.add(i);
            setRowStatus(root, i, 'recoveryRetrying', 'dle-import-recovery-status-pending');
        }
        const payload = live.map((i) => report.failures[i]);
        let res = null;
        try {
            res = await deps.onRetry(payload);
        } catch (err) {
            console.warn('[DLE] Import retry hook threw:', err);
        }
        // The hook returns an importEntries-shaped result. A row succeeded if its
        // filename no longer appears in the new errors[]. Without a usable result
        // we conservatively mark every attempted row as failed-again.
        const stillFailed = new Set(
            (res && Array.isArray(res.errors) ? res.errors : payload.map((p) => `${p.name}: retry`))
                .map((e) => String(e).split(': ')[0].trim()),
        );
        for (const i of live) {
            const ok = res && Array.isArray(res.errors) && !stillFailed.has(report.failures[i].name);
            setRowStatus(root, i,
                ok ? 'recoveryRetrySucceeded' : 'recoveryRetryFailed',
                ok ? 'dle-import-recovery-status-ok' : 'dle-import-recovery-status-fail');
            // Re-failed rows can be tried again.
            if (!ok) rowDone.delete(i);
        }
    };

    const onClick = (ev) => {
        const scope = ev.target.closest('.popup, .dialogue_popup, .popup-content');
        if (!scope) return;

        // EM skip-on-future toggle (existing).
        const emBtn = ev.target.closest('.dle-import-skip-em-future');
        if (emBtn) {
            if (deps.getSettings && deps.saveSettings) {
                const settings = deps.getSettings();
                settings.wiImportEmHandling = 'skip';
                deps.saveSettings();
                emBtn.textContent = doneText;
                emBtn.disabled = true;
            }
            return;
        }

        if (!canRetry) return;

        // Per-row Retry.
        const retryBtn = ev.target.closest('[data-dle-import-retry]');
        if (retryBtn) {
            const idx = Number(retryBtn.getAttribute('data-dle-import-retry'));
            void runRetry(scope, [idx]);
            return;
        }
        // Per-row Dismiss — local only, no hook call.
        const dismissBtn = ev.target.closest('[data-dle-import-dismiss]');
        if (dismissBtn) {
            const idx = Number(dismissBtn.getAttribute('data-dle-import-dismiss'));
            if (!rowDone.has(idx)) {
                rowDone.add(idx);
                setRowStatus(scope, idx, 'recoveryDismissed', 'dle-import-recovery-status-dismissed');
            }
            return;
        }
        // Retry all retryable rows.
        const retryAllBtn = ev.target.closest('[data-dle-import-retry-all]');
        if (retryAllBtn) {
            retryAllBtn.disabled = true;
            const all = report.failures.map((_, i) => i);
            void runRetry(scope, all);
            return;
        }
    };
    document.addEventListener('click', onClick);
    try {
        await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: false, okButton: 'OK' });
    } finally {
        document.removeEventListener('click', onClick);
    }
}
