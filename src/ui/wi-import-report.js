/**
 * DeepLore Enhanced — WI Import Report (Wave 5, v2.5 WI parity)
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
        emExplainer: () => _resolved('dle_wi_import_report_em_explainer', 'SillyTavern\'s "Example Messages" slot is a special prompt position for sample dialogue lines that ride alongside the example messages already in your chat. DeepLore doesn\'t have that slot — by default we tuck these entries\' content under a "## Example Dialogue" subheader inside the entry body, so they still reach the model when the entry triggers.<br><br>Honestly, one short flavor quote inside a character entry is usually enough to teach an LLM the voice. If you\'d rather skip them on future imports, the button below flips the setting permanently (until you change it back in <code>Settings → DeepLore Enhanced → Matching → Import → WI Example Messages on import</code>). Entries already imported stay in the vault — <code>/dle-delete</code> them by name if you want them gone.'),
        emSkipButton: () => _resolved('dle_wi_import_report_em_skip_button', 'Always skip Example Messages on import (reversible in settings)'),
        emEntriesTitle: (n) => _interp(_resolved('dle_wi_import_report_em_entries_title', 'Entry titles (${0})'), n),
        skippedTag: () => _resolved('dle_wi_import_report_skipped_tag', '(skipped)'),
        andMore: (n) => _interp(_resolved('dle_wi_import_report_and_more', 'and ${0} more'), n),
        skippedSection: () => _resolved('dle_wi_import_report_skipped_section', 'Skipped fields'),
        errorsSection: (n) => _interp(_resolved('dle_wi_import_report_errors_section', 'Errors (${0})'), n),
    };
}

/**
 * Show the import report popup. Wires the "Skip EM on future imports" button
 * to flip settings.wiImportEmHandling. Browser-only.
 */
export async function showImportReport(result, source, folder, deps = {}) {
    const report = buildImportReport(result, source, folder);
    const html = renderImportReportHtml(report, buildI18nStrings());

    // callGenericPopup doesn't return the DOM directly so scope the listener
    // to ST's `.popup` container — narrows the document-level handler from
    // the audit-flagged "any DOM surface with that class" to just the popup
    // body, in case some other UI later reuses the class name.
    const doneText = _resolved(
        'dle_wi_import_report_em_skip_done',
        'Done — Example Messages will be skipped on future imports. Revert in Settings → DeepLore Enhanced → Matching → Import.',
    );
    const onClick = (ev) => {
        const btn = ev.target.closest('.dle-import-skip-em-future');
        if (!btn) return;
        if (!ev.target.closest('.popup, .dialogue_popup, .popup-content')) return;
        if (deps.getSettings && deps.saveSettings) {
            const settings = deps.getSettings();
            settings.wiImportEmHandling = 'skip';
            deps.saveSettings();
            btn.textContent = doneText;
            btn.disabled = true;
        }
    };
    document.addEventListener('click', onClick);
    try {
        await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: false, okButton: 'OK' });
    } finally {
        document.removeEventListener('click', onClick);
    }
}
