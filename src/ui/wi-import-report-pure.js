/**
 * DeepLore Enhanced — WI Import Report (pure helpers)
 *
 * Pure split of wi-import-report.js for node testability. No ST imports, no
 * DOM. The report builder + HTML renderer live here; the popup wrapper +
 * settings flip live in wi-import-report.js.
 *
 * Convention matches drawer-browse-pure.js / verdict-pure.js — anything node
 * can exercise without jsdom goes in *-pure.js.
 */

// Local minimal escapeHtml — core/utils.js exports escapeXml but not escapeHtml,
// and pulling the full ST utils.js would couple this module to the browser path.
// Same character set as ST's escapeHtml — 5 chars cover XSS in HTML body context.
function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Shape a raw importEntries result into a structured report consumed by the
 * renderer. Pure — no DOM, no globals.
 *
 * @param {object} result - importEntries return: {imported, failed, renamed, errors, report}
 * @param {string} source - human-readable source name (e.g. "World Info", "Character Card")
 * @param {string} folder - target folder ('' = vault root)
 * @returns {object} structured report
 */
export function buildImportReport(result, source, folder) {
    const r = (result && result.report) || {};
    const native = r.nativeApplied || {};
    const roundTripped = r.roundTripped || {};
    const skipped = r.skipped || {};

    return {
        source: source || 'World Info',
        folder: folder || '',
        imported: (result && result.imported) || 0,
        failed: (result && result.failed) || 0,
        renamed: (result && result.renamed) || 0,
        errors: Array.isArray(result && result.errors) ? result.errors : [],

        nativeApplied: Object.entries(native)
            .filter(([, count]) => count > 0)
            .map(([field, count]) => ({ field, count }))
            .sort((a, b) => b.count - a.count),

        roundTripped: Object.entries(roundTripped)
            .filter(([, count]) => count > 0)
            .map(([field, count]) => ({ field, count }))
            .sort((a, b) => b.count - a.count),

        skipped: Object.entries(skipped)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count),

        emAppended: r.emAppended || 0,
        emSkipped: r.emSkipped || 0,
        emEntries: Array.isArray(r.emEntries) ? r.emEntries : [],
        hasAnyEm: (r.emAppended || 0) + (r.emSkipped || 0) > 0,
    };
}

export const EM_EXPLAINER = `
SillyTavern's "Example Messages" slot is a special prompt position for sample
dialogue lines that ride alongside the example messages already in your chat.
DeepLore doesn't have that slot — by default we tucked these entries' content
under a "## Example Dialogue" subheader inside the entry body, so they still
reach the model when the entry triggers.
<br><br>
Honestly, one short flavor quote inside a character entry is usually enough to
teach an LLM the voice. If you'd rather have these entries skipped on future
imports, click the button below. (Entries already imported stay in the vault —
you can /dle-delete them by name if you want them gone.)
`.trim();

/**
 * Render the structured report into an HTML string for callGenericPopup.
 * Pure — testable without jsdom.
 *
 * @param {ReturnType<typeof buildImportReport>} report
 * @returns {string} HTML
 */
export function renderImportReportHtml(report) {
    const lines = [];
    lines.push('<div class="dle-import-report">');

    const folderLabel = report.folder ? `folder <code>${escHtml(report.folder)}/</code>` : 'vault root';
    lines.push(`<h3>Imported ${report.imported} entries from "${escHtml(report.source)}" into ${folderLabel}</h3>`);

    const subline = [];
    if (report.renamed > 0) subline.push(`${report.renamed} renamed to avoid collision`);
    if (report.failed > 0) subline.push(`<span style="color:#c44">${report.failed} failed</span>`);
    if (subline.length > 0) lines.push(`<p>${subline.join(' &middot; ')}</p>`);

    if (report.nativeApplied.length > 0) {
        lines.push('<h4>Native fields applied</h4>');
        lines.push('<ul style="columns:2;column-gap:2em">');
        for (const { field, count } of report.nativeApplied) {
            lines.push(`<li><code>${escHtml(field)}</code> &mdash; ${count}</li>`);
        }
        lines.push('</ul>');
    }

    if (report.roundTripped.length > 0) {
        lines.push('<h4>Round-tripped (preserved, not enforced by DLE)</h4>');
        lines.push('<ul style="columns:2;column-gap:2em">');
        for (const { field, count } of report.roundTripped) {
            lines.push(`<li><code>${escHtml(field)}</code> &mdash; ${count}</li>`);
        }
        lines.push('</ul>');
        lines.push('<p class="dle-text-sm dle-muted">Run <code>/dle-lint</code> to see which entries carry these fields. DLE doesn\'t act on them; remove the lines if you don\'t need them preserved.</p>');
    }

    if (report.hasAnyEm) {
        lines.push('<h4>Example Messages handling</h4>');
        const emParts = [];
        if (report.emAppended > 0) emParts.push(`${report.emAppended} appended as subheader`);
        if (report.emSkipped > 0) emParts.push(`${report.emSkipped} skipped`);
        lines.push(`<p>${emParts.join(' &middot; ')}</p>`);
        lines.push('<div style="border:1px solid var(--SmartThemeBorderColor,#444);padding:0.75em;border-radius:4px;margin:0.5em 0">');
        lines.push(`<p class="dle-text-sm">${EM_EXPLAINER}</p>`);
        if (report.emAppended > 0) {
            lines.push('<button class="menu_button dle-import-skip-em-future" style="margin-top:0.5em">Skip Example Messages on future imports</button>');
        }
        lines.push('</div>');
        if (report.emEntries.length > 0 && report.emEntries.length <= 20) {
            lines.push('<details><summary class="dle-text-sm">Entry titles (' + report.emEntries.length + ')</summary><ul class="dle-text-sm">');
            for (const e of report.emEntries) {
                const tag = e.action === 'skipped' ? ' <i>(skipped)</i>' : '';
                lines.push(`<li>${escHtml(e.title || e.filename)}${tag}</li>`);
            }
            lines.push('</ul></details>');
        }
    }

    if (report.skipped.length > 0) {
        lines.push('<h4>Skipped fields</h4>');
        lines.push('<ul>');
        for (const { reason, count } of report.skipped) {
            lines.push(`<li><code>${escHtml(reason)}</code> &mdash; ${count}</li>`);
        }
        lines.push('</ul>');
    }

    if (report.errors.length > 0) {
        lines.push('<h4>Errors (' + report.errors.length + ')</h4>');
        lines.push('<ul class="dle-text-sm">');
        for (const e of report.errors.slice(0, 20)) {
            lines.push(`<li>${escHtml(String(e))}</li>`);
        }
        if (report.errors.length > 20) lines.push(`<li>&hellip; and ${report.errors.length - 20} more</li>`);
        lines.push('</ul>');
    }

    lines.push('</div>');
    return lines.join('\n');
}
