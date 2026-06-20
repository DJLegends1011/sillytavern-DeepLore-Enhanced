/**
 * DeepLore — WI Import Report (pure helpers)
 *
 * Pure split of wi-import-report.js for node testability. No ST imports, no
 * DOM. The report builder + HTML renderer live here; the popup wrapper +
 * settings flip + i18n resolution live in wi-import-report.js.
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

/**
 * English-default copy. Each entry is a function so per-call args (counts,
 * names) can interpolate. The wrapper (wi-import-report.js) overrides any
 * subset of these with ST-i18n-resolved strings before calling
 * renderImportReportHtml — missing overrides fall back to English here so
 * node tests don't need ST i18n boot.
 *
 * Placeholder convention follows DLE's existing i18n contract — caller
 * substitutes positional args at resolve time (CLAUDE.md i18n note).
 */
export const STRINGS_EN = {
    header: (n, source, folderLabel) => `Imported ${n} entries from "${source}" into ${folderLabel}`,
    folderLabel: (folder) => `folder <code>${folder}/</code>`,
    vaultRoot: () => 'vault root',
    renamed: (n) => `${n} renamed to avoid collision`,
    failed: (n) => `${n} failed`,
    nativeSection: () => 'Fields imported and active',
    roundTripSection: () => 'SillyTavern-specific fields preserved (not acted on)',
    roundTripExplainer: () => 'Safe to ignore — DeepLore doesn\'t use these. They land in vault frontmatter so you can see what SillyTavern had configured. Remove the lines only if your Markdown feels cluttered. Run <code>/dle-lint</code> to find which entries carry them.',
    emSection: () => 'Example Messages handling',
    emAppendedCount: (n) => `${n} appended as subheader`,
    emSkippedCount: (n) => `${n} skipped`,
    emExplainer: () => `SillyTavern's "Example Messages" slot is a special prompt position for sample
dialogue lines that ride alongside the example messages already in your chat.
DeepLore doesn't have that slot — by default we tuck these entries' content
under a "## Example Dialogue" subheader inside the entry body, so they still
reach the model when the entry triggers.
<br><br>
Honestly, one short flavor quote inside a character entry is usually enough to
teach an LLM the voice. If you'd rather skip them on future imports, the button
below flips the setting permanently (until you change it back in
<code>Settings → DeepLore → Matching → Import → WI Example Messages on import</code>).
Entries already imported stay in the vault — <code>/dle-delete</code> them by
name if you want them gone.`,
    emSkipButton: () => 'Always skip Example Messages on import (reversible in settings)',
    emEntriesTitle: (n) => `Entry titles (${n})`,
    skippedTag: () => '(skipped)',
    andMore: (n) => `and ${n} more`,
    skippedSection: () => 'Skipped fields',
    errorsSection: (n) => `Errors (${n})`,
};

// Back-compat re-export so older callers / tests that imported EM_EXPLAINER
// directly keep working.
export const EM_EXPLAINER = STRINGS_EN.emExplainer();

/**
 * Render the structured report into an HTML string for callGenericPopup.
 * Pure — testable without jsdom.
 *
 * @param {ReturnType<typeof buildImportReport>} report
 * @param {Partial<typeof STRINGS_EN>} [strings] - per-key overrides resolved
 *   by the i18n-aware wrapper. Missing keys fall back to English. Each value
 *   is a function taking the same args as STRINGS_EN[key].
 * @returns {string} HTML
 */
export function renderImportReportHtml(report, strings = {}) {
    const S = (k, ...args) => (strings[k] || STRINGS_EN[k])(...args);

    const lines = [];
    lines.push('<div class="dle-import-report">');

    const folderLabel = report.folder
        ? S('folderLabel', escHtml(report.folder))
        : S('vaultRoot');
    lines.push(`<h3>${S('header', report.imported, escHtml(report.source), folderLabel)}</h3>`);

    const subline = [];
    if (report.renamed > 0) subline.push(S('renamed', report.renamed));
    if (report.failed > 0) subline.push(`<span style="color:var(--SmartThemeWarningColor,#c44)">${S('failed', report.failed)}</span>`);
    if (subline.length > 0) lines.push(`<p>${subline.join(' &middot; ')}</p>`);

    if (report.nativeApplied.length > 0) {
        lines.push(`<h4>${S('nativeSection')}</h4>`);
        lines.push('<ul class="dle-import-report-cols">');
        for (const { field, count } of report.nativeApplied) {
            lines.push(`<li><code>${escHtml(field)}</code> &mdash; ${count}</li>`);
        }
        lines.push('</ul>');
    }

    if (report.roundTripped.length > 0) {
        lines.push(`<h4>${S('roundTripSection')}</h4>`);
        lines.push(`<p class="dle-text-sm dle-muted">${S('roundTripExplainer')}</p>`);
        lines.push('<ul class="dle-import-report-cols">');
        for (const { field, count } of report.roundTripped) {
            lines.push(`<li><code>${escHtml(field)}</code> &mdash; ${count}</li>`);
        }
        lines.push('</ul>');
    }

    if (report.hasAnyEm) {
        lines.push(`<h4>${S('emSection')}</h4>`);
        const emParts = [];
        if (report.emAppended > 0) emParts.push(S('emAppendedCount', report.emAppended));
        if (report.emSkipped > 0) emParts.push(S('emSkippedCount', report.emSkipped));
        lines.push(`<p>${emParts.join(' &middot; ')}</p>`);
        lines.push('<div class="dle-import-report-em-box">');
        lines.push(`<p class="dle-text-sm">${S('emExplainer')}</p>`);
        if (report.emAppended > 0) {
            lines.push(`<button class="menu_button dle-import-skip-em-future" style="margin-top:0.5em">${S('emSkipButton')}</button>`);
        }
        lines.push('</div>');
        if (report.emEntries.length > 0) {
            const SHOW = 20;
            const visible = report.emEntries.slice(0, SHOW);
            const overflow = report.emEntries.length - visible.length;
            lines.push(`<details><summary class="dle-text-sm">${S('emEntriesTitle', report.emEntries.length)}</summary><ul class="dle-text-sm">`);
            for (const e of visible) {
                const tag = e.action === 'skipped' ? ` <i>${S('skippedTag')}</i>` : '';
                lines.push(`<li>${escHtml(e.title || e.filename)}${tag}</li>`);
            }
            if (overflow > 0) lines.push(`<li>&hellip; ${S('andMore', overflow)}</li>`);
            lines.push('</ul></details>');
        }
    }

    if (report.skipped.length > 0) {
        lines.push(`<h4>${S('skippedSection')}</h4>`);
        lines.push('<ul>');
        for (const { reason, count } of report.skipped) {
            lines.push(`<li><code>${escHtml(reason)}</code> &mdash; ${count}</li>`);
        }
        lines.push('</ul>');
    }

    if (report.errors.length > 0) {
        lines.push(`<h4>${S('errorsSection', report.errors.length)}</h4>`);
        lines.push('<ul class="dle-text-sm">');
        for (const e of report.errors.slice(0, 20)) {
            lines.push(`<li>${escHtml(String(e))}</li>`);
        }
        if (report.errors.length > 20) lines.push(`<li>&hellip; ${S('andMore', report.errors.length - 20)}</li>`);
        lines.push('</ul>');
    }

    lines.push('</div>');
    return lines.join('\n');
}
