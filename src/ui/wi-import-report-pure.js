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
 * Reasons importEntries can refuse a single entry. Used to classify each
 * failure row so the reconciliation table can colour it and decide whether a
 * retry has any chance of succeeding.
 *
 *   'transient'  — network/timeout/dedup-check glitch. Retry is meaningful: the
 *                  vault was unreachable or the existence probe couldn't be
 *                  verified, so the same entry may land on a second attempt.
 *   'collision'  — dedup cap exhausted (>20 `_imported_N` siblings already
 *                  exist). Retry alone won't help unless the user clears space,
 *                  but we still let them try (e.g. after deleting duplicates).
 *   'convert'    — convertWiEntry threw (malformed entry). Retry is unlikely to
 *                  help — the entry data itself is the problem — so the row is
 *                  retry-able but flagged as low-odds.
 *   'write'      — Obsidian writeNote returned !ok (permissions, disk, API).
 *                  Transient-ish; retry allowed.
 *   'unknown'    — couldn't classify from the message; retry allowed.
 */
const FAILURE_RETRYABLE = new Set(['transient', 'collision', 'write', 'unknown', 'convert']);

/**
 * Classify a flat error string emitted by importEntries into a structured
 * failure row. importEntries currently returns `errors: string[]` shaped
 * `"${filename}: ${reason}"` (or `"Entry: ${message}"` for converter throws),
 * with no back-reference to the source WI entry. We parse the filename back out
 * so the reconciliation table can show a per-entry row and the retry hook can
 * re-match the original entry by filename. Pure — no DOM.
 *
 * If a future importEntries supplies a richer `result.failures` array of
 * `{ filename, title, reason, category }` objects, `buildImportReport` prefers
 * those verbatim and skips this parser (see the `failures` branch below).
 *
 * @param {string} raw - one entry from result.errors
 * @returns {{ name: string, reason: string, category: string, retryable: boolean }}
 */
export function classifyFailure(raw) {
    const s = String(raw == null ? '' : raw);
    // Split on the FIRST ": " — filenames don't contain it, reasons may.
    const sep = s.indexOf(': ');
    let name = '';
    let reason = s;
    if (sep > -1) {
        name = s.slice(0, sep).trim();
        reason = s.slice(sep + 2).trim();
    }
    // "Entry" is the synthetic prefix importEntries uses when convertWiEntry
    // throws before a filename exists — surface it as an unnamed converter error.
    if (name === 'Entry') name = '';

    const low = reason.toLowerCase();
    let category = 'unknown';
    if (low.includes('exceeded') || low.includes('attempts') || low.includes('collision')) {
        category = 'collision';
    } else if (low.includes('network') || low.includes('abort') || low.includes('timeout')
        || low.includes('could not verify') || low.includes('dedup check failed')) {
        category = 'transient';
    } else if (low.includes('convert')) {
        category = 'convert';
    } else if (name) {
        // Named row with an unrecognized reason → most likely a writeNote failure.
        category = 'write';
    }
    return { name, reason, category, retryable: FAILURE_RETRYABLE.has(category) };
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

    // Prefer a structured `failures` array if importEntries supplies one
    // (forward-compat hook — see import.js DOC-NOTE). Otherwise derive rows by
    // parsing the flat `errors` strings so the reconciliation table works today
    // without any import.js change.
    const rawFailures = Array.isArray(result && result.failures) ? result.failures : null;
    const failures = rawFailures
        ? rawFailures.map((f) => ({
            name: String(f.filename || f.name || f.title || ''),
            reason: String(f.reason || f.error || ''),
            category: f.category || classifyFailure(`${f.filename || ''}: ${f.reason || f.error || ''}`).category,
            retryable: f.retryable != null ? !!f.retryable : FAILURE_RETRYABLE.has(f.category || 'unknown'),
        }))
        : (Array.isArray(result && result.errors) ? result.errors : []).map(classifyFailure);

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

        // Reconciliation view: per-entry failure rows with category + retryability.
        failures,
        retryableCount: failures.filter((f) => f.retryable).length,
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

    // Reconciliation view (R2 — recovery path for failed/skipped imports).
    recoverySection: (n) => `Didn't import (${n})`,
    recoveryIntro: () => 'These entries were refused. Review the reason, then retry the ones worth another attempt or dismiss the rest.',
    recoveryColEntry: () => 'Entry',
    recoveryColReason: () => 'Reason',
    recoveryColAction: () => 'Action',
    recoveryUnnamed: () => '(unnamed entry)',
    recoveryRetry: () => 'Retry',
    recoveryDismiss: () => 'Dismiss',
    recoveryRetryAll: (n) => `Retry all ${n}`,
    recoveryNoRetry: () => 'Retry won\'t help',
    recoveryRetrying: () => 'Retrying…',
    recoveryRetrySucceeded: () => 'Imported',
    recoveryRetryFailed: () => 'Failed again',
    recoveryDismissed: () => 'Dismissed',
    recoveryRetryUnavailable: () => 'Retry isn\'t available here — re-run the import from the original source to recover these entries.',
    // Category badges.
    catTransient: () => 'connection',
    catCollision: () => 'name clash',
    catConvert: () => 'bad data',
    catWrite: () => 'write failed',
    catUnknown: () => 'error',
};

// Map a failure category to its badge-copy key (kept beside STRINGS_EN so the
// renderer and tests share one source of truth).
export const CATEGORY_LABEL_KEY = {
    transient: 'catTransient',
    collision: 'catCollision',
    convert: 'catConvert',
    write: 'catWrite',
    unknown: 'catUnknown',
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

    // Reconciliation view (R2): per-entry failure table with retry/dismiss
    // actions, replacing the flat read-only errors list. `canRetry` gates the
    // action column — the wrapper passes it true only when a retry hook is
    // wired (it isn't on every call site). When false, rows are still listed so
    // nothing is hidden, but the per-row Retry button is swapped for a note.
    if (report.failures.length > 0) {
        renderRecoveryTable(report, S, strings, lines);
    }

    lines.push('</div>');
    return lines.join('\n');
}

/**
 * Render the failed/skipped reconciliation table into `lines`. Split out so
 * tests can target it and the main renderer stays scannable. Pure — builds a
 * string; the DOM wrapper attaches click handlers by the `data-dle-*`
 * attributes stamped here.
 *
 * @param {ReturnType<typeof buildImportReport>} report
 * @param {(k: string, ...a: any[]) => string} S - resolved-string accessor
 * @param {object} strings - the raw overrides dict (for the canRetry flag)
 * @param {string[]} lines - accumulator
 */
function renderRecoveryTable(report, S, strings, lines) {
    const canRetry = !!strings.__canRetry;
    const SHOW = 50; // cap the table; overflow rolls up like the old list.
    const rows = report.failures.slice(0, SHOW);
    const overflow = report.failures.length - rows.length;

    lines.push('<div class="dle-import-recovery">');
    lines.push(`<h4>${S('recoverySection', report.failures.length)}</h4>`);
    lines.push(`<p class="dle-text-sm dle-muted">${S('recoveryIntro')}</p>`);

    if (canRetry && report.retryableCount > 0) {
        lines.push(`<div class="dle-import-recovery-bulk"><button type="button" class="menu_button dle-import-retry-all" data-dle-import-retry-all="1">${S('recoveryRetryAll', report.retryableCount)}</button></div>`);
    } else if (!canRetry) {
        lines.push(`<p class="dle-text-sm dle-muted"><i>${S('recoveryRetryUnavailable')}</i></p>`);
    }

    lines.push('<table class="dle-import-recovery-table">');
    lines.push(`<thead><tr><th>${S('recoveryColEntry')}</th><th>${S('recoveryColReason')}</th><th>${S('recoveryColAction')}</th></tr></thead>`);
    lines.push('<tbody>');
    for (let i = 0; i < rows.length; i++) {
        const f = rows[i];
        const name = f.name ? escHtml(f.name) : `<i class="dle-muted">${S('recoveryUnnamed')}</i>`;
        const badgeKey = CATEGORY_LABEL_KEY[f.category] || 'catUnknown';
        const badge = `<span class="dle-import-cat dle-import-cat-${escHtml(f.category)}">${S(badgeKey)}</span>`;
        let action;
        if (canRetry && f.retryable) {
            action = `<button type="button" class="menu_button menu_button_icon dle-import-retry-one" data-dle-import-retry="${i}">${S('recoveryRetry')}</button>`
                + ` <button type="button" class="menu_button menu_button_icon dle-import-dismiss-one" data-dle-import-dismiss="${i}">${S('recoveryDismiss')}</button>`;
        } else if (canRetry && !f.retryable) {
            action = `<span class="dle-text-sm dle-muted">${S('recoveryNoRetry')}</span>`;
        } else {
            action = '<span class="dle-import-cat-spacer" aria-hidden="true"></span>';
        }
        // data-dle-import-name lets the wrapper map the row back to the original
        // WI entry by filename when firing the retry hook.
        lines.push(`<tr class="dle-import-recovery-row" data-dle-import-row="${i}" data-dle-import-name="${escHtml(f.name)}">`
            + `<td class="dle-import-recovery-entry">${name}</td>`
            + `<td class="dle-import-recovery-reason">${badge} <span class="dle-text-sm">${escHtml(f.reason)}</span></td>`
            + `<td class="dle-import-recovery-action">${action}</td>`
            + '</tr>');
    }
    lines.push('</tbody></table>');
    if (overflow > 0) lines.push(`<p class="dle-text-sm dle-muted">&hellip; ${S('andMore', overflow)}</p>`);
    lines.push('</div>');
}
