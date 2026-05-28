/**
 * DeepLore Enhanced — /dle-lint slash command.
 * Reads the parser warning ledger populated by buildIndex / buildIndexWithReuse.
 * Manual invoke only — auto-run after index build is OFF per user directive.
 */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { getIndexBuildReport } from '../state.js';
import { buildCopyButton, attachCopyHandler } from './popups.js';

// Order matters — drives display order.
const CODE_LABELS = {
    // ── Warnings (auto-fixed under lenientAuthoring) ──
    W_ALIAS_USED: {
        title: 'Non-canonical field name',
        hint: 'Frontmatter fields are case-sensitive. Rename to the lowercase canonical form (e.g. `Keys:` → `keys:`).',
    },
    W_COMMA_SPLIT: {
        title: 'Comma-string auto-split into list',
        hint: 'Use YAML list syntax: `keys: [alice, bob]` — not `keys: "alice, bob"`.',
    },
    W_COERCED_NUM: {
        title: 'String coerced to number',
        hint: 'Numeric fields should be unquoted: `priority: 3` — not `priority: "3"`.',
    },
    W_NOT_IMPLEMENTED: {
        title: 'Imported field preserved but not enforced',
        hint: 'Field round-trips through customFields but DLE does not act on it yet.',
    },
    W_WI_ROUND_TRIP: {
        title: 'WI field preserved for round-trip readability',
        hint: 'Field was imported from SillyTavern World Info. DLE does not act on it (no plan to). Remove if you don\'t need it preserved.',
    },
    W_INVALID: {
        title: 'Invalid field value',
        hint: 'Field value is not in the allowed set. Fall-back used; check the message for the valid values.',
    },
    // ── Skip reasons ──
    SKIP_NO_FRONTMATTER: {
        title: 'Skipped — no frontmatter',
        hint: 'Entries need a YAML frontmatter block wrapped in `---` fences. See AUTHORING.md.',
    },
    SKIP_NO_LOREBOOK_TAG: {
        title: 'Skipped — missing lorebook tag',
        hint: 'Add the lorebook tag (default `lorebook`) to the entry\'s `tags:` list.',
    },
    SKIP_ENABLED_FALSE: {
        title: 'Skipped — `enabled: false`',
        hint: 'Remove or flip `enabled: true` to include this entry.',
    },
    SKIP_NEVER_INSERT_TAG: {
        title: 'Skipped — has `lorebook-never` tag',
        hint: 'Remove the `lorebook-never` tag to allow injection.',
    },
    SKIP_EMPTY_TITLE: {
        title: 'Skipped — empty title',
        hint: 'Give the entry a non-empty `# H1` heading or a non-empty filename. Empty titles collide and are dropped from cache.',
    },
};

function labelFor(code) {
    return CODE_LABELS[code] || { title: code, hint: '' };
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
    const lines = [];
    lines.push(`DLE Parser Lint — ${report.okCount} clean, ${report.warnCount} with warnings, ${report.skipCount} skipped.`);
    lines.push('');

    if (report.warnCount === 0 && report.skipCount === 0) {
        lines.push('No parser warnings or skips. All entries parsed cleanly.');
        return lines.join('\n');
    }

    const warnGroups = groupWarnings(report.entriesWithWarnings);
    const skipGroups = groupSkips(report.skipped);

    for (const [code, items] of Object.entries(warnGroups)) {
        const { title, hint } = labelFor(code);
        lines.push(`[${code}] ${title} (${items.length})`);
        if (hint) lines.push(`  fix: ${hint}`);
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
        if (hint) lines.push(`  fix: ${hint}`);
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

    if (report.warnCount === 0 && report.skipCount === 0) {
        html += `<h3>Parser Lint</h3>`;
        html += `<p class="dle-success">No parser warnings or skips. All ${totalEntries} entries parsed cleanly.</p>`;
        html += '</div>';
        return html;
    }

    html += `<h3>Parser Lint: ${report.okCount} clean · ${report.warnCount} with warnings · ${report.skipCount} skipped</h3>`;
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
        if (hint) html += `<p class="dle-hint">${escapeHtml(hint)}</p>`;
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
        if (hint) html += `<p class="dle-hint">${escapeHtml(hint)}</p>`;
        html += `<ul class="dle-health-list">`;
        for (const f of filenames) {
            html += `<li><code>${escapeHtml(f)}</code></li>`;
        }
        html += `</ul></details>`;
    }

    html += '</div>';
    return html;
}

export function registerLintCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-lint',
        aliases: ['dle-l'],
        callback: async () => {
            const report = getIndexBuildReport();
            if (!report || (report.okCount === 0 && report.warnCount === 0 && report.skipCount === 0)) {
                await callGenericPopup(
                    '<div class="dle-popup"><h3>Parser Lint</h3><p>No index build has run yet. Trigger a vault refresh (/dle-refresh) and try again.</p></div>',
                    POPUP_TYPE.TEXT,
                    '',
                    { wide: true, large: true, allowVerticalScrolling: true },
                );
                return '';
            }

            const html = renderHtml(report);
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, large: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        helpString: 'Show parser warnings and skipped entries from the last vault index build. Use this when the summary toast mentions warnings or skips.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}
