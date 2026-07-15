/**
 * DeepLore — /dle-lint slash command.
 * Reads the parser warning ledger populated by buildIndex / buildIndexWithReuse.
 * Manual invoke only — auto-run after index build is OFF per user directive.
 */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { getIndexBuildReport } from '../state.js';
import { tr, trf } from '../i18n/i18n.js';
import { buildCopyButton, attachCopyHandler } from './popups.js';

/**
 * Each code maps to its locale key prefix plus an English fallback for the
 * title/hint. Titles/hints resolve through tr() at render time so a German or
 * Japanese user sees the localized lint vocabulary that already ships in every
 * locale (dle_lint_w_* / dle_lint_skip_*); the inline EN strings keep node
 * tests and missing-key cases rendering. Mirrors the _resolved(key, fallback)
 * idiom proven in wi-import-report.js. Order matters — drives display order.
 */
const CODE_LABELS = {
    // ── Warnings (auto-fixed under lenientAuthoring) ──
    W_ALIAS_USED: {
        key: 'dle_lint_w_aliasused',
        title: 'Non-canonical field name',
        hint: 'Frontmatter fields are case-sensitive. Rename to the lowercase canonical form (e.g. `Keys:` → `keys:`).',
    },
    W_COMMA_SPLIT: {
        key: 'dle_lint_w_commasplit',
        title: 'Comma-string auto-split into list',
        hint: 'Use YAML list syntax: `keys: [alice, bob]` — not `keys: "alice, bob"`.',
    },
    W_COERCED_NUM: {
        key: 'dle_lint_w_coercednum',
        title: 'String coerced to number',
        hint: 'Numeric fields should be unquoted: `priority: 3` — not `priority: "3"`.',
    },
    W_NOT_IMPLEMENTED: {
        key: 'dle_lint_w_notimpl',
        title: 'Imported field preserved but not enforced',
        hint: 'Field round-trips through customFields but DLE does not act on it yet.',
    },
    W_WI_ROUND_TRIP: {
        key: 'dle_lint_w_wiroundtrip',
        title: 'WI field preserved for round-trip readability',
        hint: 'Field was imported from SillyTavern World Info. DLE does not act on it (no plan to). Remove if you don\'t need it preserved.',
    },
    W_INVALID: {
        key: 'dle_lint_w_invalid',
        title: 'Invalid field value',
        hint: 'Field value is not in the allowed set. Fall-back used; check the message for the valid values.',
    },
    // ── Skip reasons ──
    SKIP_NO_FRONTMATTER: {
        key: 'dle_lint_skip_nofm',
        title: 'Skipped — no frontmatter',
        hint: 'Entries need a YAML frontmatter block wrapped in `---` fences. See AUTHORING.md.',
    },
    SKIP_NO_LOREBOOK_TAG: {
        key: 'dle_lint_skip_notag',
        title: 'Skipped — missing lorebook tag',
        hint: 'Add the lorebook tag (default `lorebook`) to the entry\'s `tags:` list.',
    },
    SKIP_ENABLED_FALSE: {
        key: 'dle_lint_skip_disabled',
        title: 'Skipped — `enabled: false`',
        hint: 'Remove or flip `enabled: true` to include this entry.',
    },
    SKIP_NEVER_INSERT_TAG: {
        key: 'dle_lint_skip_never',
        title: 'Skipped — has `lorebook-never` tag',
        hint: 'Remove the `lorebook-never` tag to allow injection.',
    },
    SKIP_EMPTY_TITLE: {
        key: 'dle_lint_skip_emptytitle',
        title: 'Skipped — empty title',
        hint: 'Give the entry a non-empty `# H1` heading or a non-empty filename. Empty titles collide and are dropped from cache.',
    },
};

/** tr() the key, but fall back to the inline EN string if the key is absent. */
function _resolved(key, fallback) {
    const v = tr(key);
    return v === key ? fallback : v;
}

/**
 * Render a hint string's inline Markdown code spans (`like this`) as <code>,
 * escaping every segment so dynamic field names / values can't open an XSS hole.
 * Odd-index segments are the ones between backtick pairs. A trailing unpaired
 * backtick segment is treated as plain text (no <code> wrap) and still escaped.
 */
function renderHintHtml(hint) {
    const segments = String(hint).split('`');
    return segments
        .map((seg, i) => {
            const safe = escapeHtml(seg);
            // Wrap odd segments unless it's a dangling unpaired tail.
            return i % 2 === 1 && i < segments.length - 1 ? `<code>${safe}</code>` : safe;
        })
        .join('');
}

function labelFor(code) {
    const def = CODE_LABELS[code];
    if (!def) return { title: code, hint: '' };
    return {
        title: _resolved(`${def.key}_title`, def.title),
        hint: def.hint ? _resolved(`${def.key}_hint`, def.hint) : '',
    };
}

/** @returns { [code]: Array<{filename, title, field?, message?}> } */
function groupWarnings(entriesWithWarnings) {
    const groups = {};
    for (const rec of entriesWithWarnings) {
        for (const w of rec.warnings) {
            if (!groups[w.code]) groups[w.code] = [];
            groups[w.code].push({
                filename: rec.filename,
                title: rec.title,
                field: w.field,
                message: w.message,
            });
        }
    }
    return groups;
}

/** @returns { [reasonCode]: string[] } */
function groupSkips(skipped) {
    const groups = {};
    for (const s of skipped) {
        if (!groups[s.reason]) groups[s.reason] = [];
        groups[s.reason].push(s.filename);
    }
    return groups;
}

function renderPlain(report) {
    const fixLabel = _resolved('dle_cmd_lint_plaintext_fix_label', 'fix:');
    const summary = `${report.okCount} clean, ${report.warnCount} with warnings, ${report.skipCount} skipped.`;
    const lines = [];
    lines.push(trf('dle_cmd_lint_plaintext_header', summary));
    lines.push('');

    if (report.warnCount === 0 && report.skipCount === 0) {
        lines.push(_resolved('dle_cmd_lint_plaintext_clean', 'No parser warnings or skips. All entries parsed cleanly.'));
        return lines.join('\n');
    }

    const warnGroups = groupWarnings(report.entriesWithWarnings);
    const skipGroups = groupSkips(report.skipped);

    for (const [code, items] of Object.entries(warnGroups)) {
        const { title, hint } = labelFor(code);
        lines.push(`[${code}] ${title} (${items.length})`);
        if (hint) lines.push(`  ${fixLabel} ${hint}`);
        for (const it of items) {
            const loc = it.field ? ` (field "${it.field}")` : '';
            const msg = it.message ? ` — ${it.message}` : '';
            lines.push(`  • ${it.title} <${it.filename}>${loc}${msg}`);
        }
        lines.push('');
    }

    for (const [code, filenames] of Object.entries(skipGroups)) {
        const { title, hint } = labelFor(code);
        lines.push(`[${code}] ${title} (${filenames.length})`);
        if (hint) lines.push(`  ${fixLabel} ${hint}`);
        for (const f of filenames) {
            lines.push(`  • ${f}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function renderHtml(report) {
    let html = '<div class="dle-popup">';
    const totalEntries = report.okCount + report.warnCount;
    // Localized 'fix:' lead-in, reused as the hint chip (colon trimmed for the chip).
    const fixChip = _resolved('dle_cmd_lint_plaintext_fix_label', 'fix:').replace(/[:：]\s*$/, '');
    const hintHtml = (hint) =>
        `<p class="dle-hint"><span class="dle-hint-label">${escapeHtml(fixChip)}</span>`
        + `<span class="dle-hint-body">${renderHintHtml(hint)}</span></p>`;

    if (report.warnCount === 0 && report.skipCount === 0) {
        const cleanTail = `${totalEntries} entries parsed cleanly.`;
        html += `<h3>${escapeHtml(trf('dle_cmd_lint_html_header', '').trim())}</h3>`;
        html += `<p class="dle-success">${escapeHtml(trf('dle_cmd_lint_html_clean', cleanTail))}</p>`;
        html += '</div>';
        return html;
    }

    const headerSummary = `${report.okCount} clean · ${report.warnCount} with warnings · ${report.skipCount} skipped`;
    html += `<h3>${escapeHtml(trf('dle_cmd_lint_html_header', headerSummary))}</h3>`;
    html += buildCopyButton(renderPlain(report));

    const warnGroups = groupWarnings(report.entriesWithWarnings);
    const skipGroups = groupSkips(report.skipped);

    const severityBadge = (sev) => {
        const cls = sev === 'skip' ? 'dle-error' : 'dle-warning';
        return `<span class="dle-badge ${cls}">[${sev}]</span>`;
    };

    for (const [code, items] of Object.entries(warnGroups)) {
        const { title, hint } = labelFor(code);
        html += `<details open><summary class="dle-health-summary">${severityBadge('warn')} <strong>${escapeHtml(title)}</strong> <code>${escapeHtml(code)}</code> (${items.length})</summary>`;
        if (hint) html += hintHtml(hint);
        html += `<ul class="dle-health-list">`;
        for (const it of items) {
            const field = it.field ? ` <em>field "${escapeHtml(it.field)}"</em>` : '';
            const msg = it.message ? ` — ${escapeHtml(it.message)}` : '';
            html += `<li><strong>${escapeHtml(it.title)}</strong> <code>${escapeHtml(it.filename)}</code>${field}${msg}</li>`;
        }
        html += `</ul></details>`;
    }

    for (const [code, filenames] of Object.entries(skipGroups)) {
        const { title, hint } = labelFor(code);
        html += `<details open><summary class="dle-health-summary">${severityBadge('skip')} <strong>${escapeHtml(title)}</strong> <code>${escapeHtml(code)}</code> (${filenames.length})</summary>`;
        if (hint) html += hintHtml(hint);
        html += `<ul class="dle-health-list">`;
        for (const f of filenames) {
            html += `<li><code>${escapeHtml(f)}</code></li>`;
        }
        html += `</ul></details>`;
    }

    html += '</div>';
    return html;
}

/**
 * Open the parser-lint popup for the last index build report. Exported so other
 * surfaces (e.g. the post-sync toast pointer) can open it directly without
 * routing through the slash-command parser.
 */
export async function openLintPopup() {
    const report = getIndexBuildReport();
    if (!report || (report.okCount === 0 && report.warnCount === 0 && report.skipCount === 0)) {
        const nodataHeader = escapeHtml(trf('dle_cmd_lint_html_header', '').trim());
        const nodataMsg = escapeHtml(_resolved(
            'dle_cmd_lint_nodata_msg',
            'No index build has run yet. Trigger a vault refresh (/dle-refresh) and try again.',
        ));
        await callGenericPopup(
            `<div class="dle-popup"><h3>${nodataHeader}</h3><p>${nodataMsg}</p></div>`,
            POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
        return;
    }

    const html = renderHtml(report);
    await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true,
        onOpen: () => attachCopyHandler(document.querySelector('.popup')),
    });
}

export function registerLintCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-lint',
        aliases: ['dle-l'],
        callback: async () => {
            await openLintPopup();
            return '';
        },
        helpString: _resolved(
            'dle_cmd_lint_help',
            'Show parser warnings and skipped entries from the last vault index build. Use this when the summary toast mentions warnings or skips.',
        ),
        returns: ARGUMENT_TYPE.STRING,
    }));
}
