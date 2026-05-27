/**
 * DeepLore Enhanced — WI Import Report (Wave 5, v2.5 WI parity)
 *
 * Browser wrapper around wi-import-report-pure.js. Renders the structured
 * post-import popup that replaces the old success/warning toast.
 *
 * Pure builder + renderer live in wi-import-report-pure.js (node-testable).
 * This module owns the DOM wiring + popup invocation.
 *
 * The popup's "Skip Example Messages on future imports" button flips
 * settings.wiImportEmHandling to 'skip' for subsequent imports. It does NOT
 * delete the entries that already landed — user can /dle-delete them manually
 * if they want. Auto-delete + undo was scoped out to keep v2.5 lean.
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { buildImportReport, renderImportReportHtml } from './wi-import-report-pure.js';

// Re-export pure helpers so other modules + tests have a single import surface.
export { buildImportReport, renderImportReportHtml };

/**
 * Show the import report popup. Wires the "Skip EM on future imports" button
 * to flip settings.wiImportEmHandling. Browser-only.
 *
 * @param {object} result - importEntries return value
 * @param {string} source - human-readable source name
 * @param {string} folder - target folder
 * @param {object} deps - {getSettings, saveSettings} injected so the popup
 *   can flip the setting without dragging settings.js into modules that
 *   otherwise don't need it.
 * @returns {Promise<void>}
 */
export async function showImportReport(result, source, folder, deps = {}) {
    const report = buildImportReport(result, source, folder);
    const html = renderImportReportHtml(report);

    // callGenericPopup doesn't return the DOM, so wire the button via a
    // delegated document listener. Cleanup on close prevents listener buildup.
    const onClick = (ev) => {
        const btn = ev.target.closest('.dle-import-skip-em-future');
        if (!btn) return;
        if (deps.getSettings && deps.saveSettings) {
            const settings = deps.getSettings();
            settings.wiImportEmHandling = 'skip';
            deps.saveSettings();
            btn.textContent = 'Done — EM entries will be skipped next import';
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
