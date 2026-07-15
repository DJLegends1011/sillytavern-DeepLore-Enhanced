/** DeepLore — Slash Commands: Admin & Status */
import { saveSettingsDebounced, chat_metadata } from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../../../slash-commands/SlashCommandEnumValue.js';
import { parseFrontmatter, simpleHash, classifyError } from '../../core/utils.js';
import { getSettings, resolveWriteVault } from '../../settings.js';
import { fetchScribeNotes } from '../vault/obsidian-api.js';
import {
    vaultIndex, aiSearchStats, indexTimestamp, trackerKey,
    fieldDefinitions, notifyDebugModeChanged,
} from '../state.js';
import { loadIndexFromCache } from '../vault/cache.js';
import { clearVaultIndexAndCache } from '../vault/vault.js';
import { ensureFreshOrToast } from './commands-shared.js';
import { runHealthCheck } from './diagnostics.js';
import { showNotebookPopup, showAiNotepadPopup, buildCopyButton, attachCopyHandler } from './popups.js';
import { consoleBuffer } from '../diagnostics/interceptors.js';
import { tr, trf } from '../i18n/i18n.js';
import { notify } from '../toast-dedup.js';

/**
 * Entry shapes: { cmd, desc, i18nKey } for commands, { sep, label, i18nKey } for
 * section headers. `desc`/`label` are the canonical English fallback; `i18nKey`
 * lets the Reference tab and command palette emit `data-i18n` so ST's locale
 * MutationObserver translates them (the previous render hardcoded English and
 * silently overwrote the translated static HTML grid). Keep `desc`/`label` in
 * sync with the matching `locales/dle.en.json` value.
 */
export const DLE_COMMANDS = [
    { cmd: '/dle-browse', desc: 'Search and preview vault entries (alias: /dle-b)', i18nKey: 'dle_cmd_desc_browse' },
    { cmd: '/dle-why', desc: 'Show why entries would/wouldn\'t inject (alias: /dle-context)', i18nKey: 'dle_cmd_desc_why' },
    { cmd: '/dle-inspect', desc: 'Inspect what happened in the last message (alias: /dle-i)', i18nKey: 'dle_cmd_desc_inspect' },
    { cmd: '/dle-health', desc: 'Run vault health check (alias: /dle-h)', i18nKey: 'dle_cmd_desc_health' },
    { cmd: '/dle-lint', desc: 'Show parser warnings and skipped entries from last index build (alias: /dle-l)', i18nKey: 'dle_cmd_desc_lint' },
    { cmd: '/dle-refresh', desc: 'Rebuild vault index from Obsidian (alias: /dle-r)', i18nKey: 'dle_cmd_desc_refresh' },
    { cmd: '/dle-status', desc: 'Show extension status and stats', i18nKey: 'dle_cmd_desc_status' },
    { cmd: '/dle-simulate', desc: 'Replay chat showing entry activation timeline', i18nKey: 'dle_cmd_desc_simulate' },
    { cmd: '/dle-graph', desc: 'Visualize entry relationships as a graph (alias: /dle-g)', i18nKey: 'dle_cmd_desc_graph' },
    { cmd: '/dle-analytics', desc: 'View entry match/injection analytics', i18nKey: 'dle_cmd_desc_analytics' },
    { cmd: '/dle-cache-info', desc: 'View vault cache status, size, and clear cache', i18nKey: 'dle_cmd_desc_cache_info' },
    { cmd: '/dle-clear', desc: 'Clear vault cache and live index without re-fetching', i18nKey: 'dle_cmd_desc_clear' },
    { cmd: '/dle-notebook', desc: 'Edit the Notebook for this chat', i18nKey: 'dle_cmd_desc_notebook' },
    { cmd: '/dle-ai-notepad', desc: 'View or clear AI-written session notes', i18nKey: 'dle_cmd_desc_ai_notepad' },
    { cmd: '/dle-scribe', desc: 'Run Session Scribe now', i18nKey: 'dle_cmd_desc_scribe' },
    { cmd: '/dle-scribe-history', desc: 'View past Scribe notes', i18nKey: 'dle_cmd_desc_scribe_history' },
    { cmd: '/dle-newlore', desc: 'AI suggests new lorebook entries from chat', i18nKey: 'dle_cmd_desc_newlore' },
    { cmd: '/dle-optimize-keys', desc: 'AI keyword suggestions for an entry', i18nKey: 'dle_cmd_desc_optimize_keys' },
    { cmd: '/dle-summarize', desc: 'AI-generate summary fields for all entries missing one', i18nKey: 'dle_cmd_desc_summarize' },
    { cmd: '/dle-review', desc: 'Send entire vault to AI for review and feedback', i18nKey: 'dle_cmd_desc_review' },
    { cmd: '/dle-librarian', desc: 'Open Librarian AI session (new entry, gap review, or vault review)', i18nKey: 'dle_cmd_desc_librarian' },
    { cmd: '/dle-import', desc: 'Import SillyTavern World Info into Obsidian vault', i18nKey: 'dle_cmd_desc_import' },
    { cmd: '/dle-setup', desc: 'Run guided setup wizard', i18nKey: 'dle_cmd_desc_setup' },
    { sep: true, label: 'Per-Chat Overrides', i18nKey: 'dle_cmd_section_overrides' },
    { cmd: '/dle-pin', desc: 'Pin an entry (always inject in this chat)', i18nKey: 'dle_cmd_desc_pin' },
    { cmd: '/dle-unpin', desc: 'Remove a pin', i18nKey: 'dle_cmd_desc_unpin' },
    { cmd: '/dle-block', desc: 'Block an entry (never inject in this chat)', i18nKey: 'dle_cmd_desc_block' },
    { cmd: '/dle-unblock', desc: 'Remove a block', i18nKey: 'dle_cmd_desc_unblock' },
    { cmd: '/dle-pins', desc: 'Show all pins and blocks for this chat', i18nKey: 'dle_cmd_desc_pins' },
    { sep: true, label: 'Contextual Gating', i18nKey: 'dle_cmd_section_gating' },
    { cmd: '/dle-set-field', desc: 'Set a custom gating field', i18nKey: 'dle_cmd_desc_set_field' },
    { cmd: '/dle-clear-field', desc: 'Clear a custom gating field', i18nKey: 'dle_cmd_desc_clear_field' },
    { cmd: '/dle-clear-all-context', desc: 'Clear all gating filters at once (alias: /dle-reset-context)', i18nKey: 'dle_cmd_desc_clear_all_context' },
    { cmd: '/dle-set-era', desc: 'Set era filter (alias: /dle-era)', i18nKey: 'dle_cmd_desc_set_era' },
    { cmd: '/dle-set-location', desc: 'Set location filter (alias: /dle-loc)', i18nKey: 'dle_cmd_desc_set_location' },
    { cmd: '/dle-set-scene', desc: 'Set scene type filter', i18nKey: 'dle_cmd_desc_set_scene' },
    { cmd: '/dle-set-characters', desc: 'Set present characters', i18nKey: 'dle_cmd_desc_set_characters' },
    { cmd: '/dle-set-folder', desc: 'Filter by Obsidian folder path', i18nKey: 'dle_cmd_desc_set_folder' },
    { cmd: '/dle-context-state', desc: 'Show current gating state (alias: /dle-ctx)', i18nKey: 'dle_cmd_desc_context_state' },
    { sep: true, label: 'Diagnostics', i18nKey: 'dle_cmd_section_diagnostics' },
    { cmd: '/dle-diagnostics', desc: 'Export a diagnostics markdown report', i18nKey: 'dle_cmd_desc_diagnostics' },
    { cmd: '/dle-debug', desc: 'Toggle debug mode on or off', i18nKey: 'dle_cmd_desc_debug' },
    { cmd: '/dle-logs', desc: 'Show recent DLE console log entries', i18nKey: 'dle_cmd_desc_logs' },
];

export function registerAdminCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-notebook',
        callback: async () => {
            await showNotebookPopup();
            return '';
        },
        helpString: 'Open the Author Notebook editor for the current chat.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-ai-notepad',
        callback: async (_args, value) => {
            const subcommand = (value || '').trim().toLowerCase();
            if (subcommand === 'clear') {
                chat_metadata.deeplore_ai_notepad = '';
                saveMetadataDebounced();
                toastr.success(tr('dle_cmd_ai_notepad_cleared_toast'), 'DeepLore');
                return '';
            }
            await showAiNotepadPopup();
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional subcommand',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            enumProvider: () => [new SlashCommandEnumValue('clear', 'wipe AI Notepad for this chat')],
        })],
        helpString: 'View or clear AI-written session notes. Usage: /dle-ai-notepad [clear]',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-status',
        callback: async () => {
            const settings = getSettings();
            const constants = vaultIndex.filter(e => e.constant).length;
            const seeds = vaultIndex.filter(e => e.seed).length;
            const bootstraps = vaultIndex.filter(e => e.bootstrap).length;
            const guides = vaultIndex.filter(e => e.guide).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Vaults: ${(settings.vaults || []).filter(v => v.enabled).map(v => `${v.name} (:${v.port})`).join(', ') || 'none'}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Seed Tag: ${settings.seedTag ? '#' + settings.seedTag : '(none)'}`,
                `Bootstrap Tag: ${settings.bootstrapTag ? '#' + settings.bootstrapTag : '(none)'} (threshold: ${settings.newChatThreshold} messages)`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ${seeds} seed, ${bootstraps} bootstrap, ${guides} guide, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL} seconds`,
                `AI Search: ${settings.aiSearchEnabled ? 'on' : 'off'}`,
                `AI Stats: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cache hits, ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out tokens`,
                `Custom Fields: ${(() => { const defs = fieldDefinitions.length > 0 ? fieldDefinitions : []; return defs.length > 0 ? `${defs.length} (${defs.map(f => f.name).join(', ')})` : 'defaults'; })()}`,
                `Folder Filter: ${chat_metadata?.deeplore_folder_filter?.length ? chat_metadata.deeplore_folder_filter.join(', ') : 'none (all folders)'}`,
                `Auto-Sync: ${settings.syncPollingInterval > 0 ? settings.syncPollingInterval + 's interval' : 'off'}`,
            ];
            const msg = lines.join('\n');
            const html = `<div class="dle-popup">${buildCopyButton(msg)}<pre class="dle-text-pre">${escapeHtml(msg)}</pre></div>`;
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return msg;
        },
        helpString: 'Show DeepLore connection status and index stats.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe-history',
        callback: async () => {
            const settings = getSettings();
            if (!settings.scribeFolder) {
                toastr.warning(tr('dle_cmd_scribehistory_nowfolder_toast'), 'DeepLore');
                return '';
            }

            toastr.info(tr('dle_cmd_scribehistory_fetching_toast'), 'DeepLore', { timeOut: 2000 });

            try {
                // Scribe writes go to the per-tool configured vault (#32). Reading
                // history from the primary vault here would silently show "no notes"
                // whenever the user routes Scribe to a non-primary vault.
                const histVault = resolveWriteVault('scribe', settings);
                const data = await fetchScribeNotes(histVault.host, histVault.port, histVault.apiKey, settings.scribeFolder, !!histVault.https);
                if (!data.ok) throw new Error(data.error || 'Failed to fetch notes');

                if (!data.notes || data.notes.length === 0) {
                    toastr.info(tr('dle_cmd_scribehistory_nonotes_toast'), 'DeepLore');
                    return '';
                }

                const parsed = data.notes.map(note => {
                    const { frontmatter, body } = parseFrontmatter(note.content);
                    return {
                        filename: note.filename,
                        date: frontmatter.date || '',
                        character: frontmatter.character || '',
                        body: body.trim(),
                    };
                }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

                let html = '<div class="dle-popup">';
                html += `<h3>Session Notes (${parsed.length})</h3>`;
                html += '<input type="text" id="dle-scribe-history-search" class="text_pole" placeholder="Search by character, date, or note text..." aria-label="Search session notes" style="margin-bottom:8px;width:100%;" />';
                html += '<div id="dle-scribe-history-list">';

                for (const note of parsed) {
                    const dateDisplay = note.date ? new Date(note.date).toLocaleString() : 'Unknown date';
                    const preview = note.body.substring(0, 200).replace(/\n/g, ' ') + (note.body.length > 200 ? '...' : '');
                    const noteId = simpleHash(note.filename);
                    const haystack = `${note.character || ''} ${note.date || ''} ${note.body}`.toLowerCase();

                    html += `<div class="dle-card dle-popup-section dle-scribe-history-item" data-haystack="${escapeHtml(haystack)}">`;
                    html += `<div class="dle-note-toggle dle-card-header" data-target="dle-note-${noteId}" aria-expanded="false" role="button" tabindex="0">`;
                    html += `<strong>${escapeHtml(note.character || 'Unknown')}</strong>`;
                    html += `<span class="dle-text-xs dle-muted">${escapeHtml(dateDisplay)}</span>`;
                    html += `</div>`;
                    html += `<span class="dle-text-xs dle-faint">${escapeHtml(preview)}</span>`;
                    html += `<div id="dle-note-${noteId}" class="dle-popup-detail">${escapeHtml(note.body)}</div>`;
                    html += `</div>`;
                }
                html += '</div></div>';

                const container = document.createElement('div');
                container.innerHTML = html;
                // BUG-186: mouse + keyboard activation
                const _togNote = (toggle) => {
                    const targetId = toggle.dataset.target;
                    const targetEl = document.getElementById(targetId);
                    if (targetEl) {
                        targetEl.classList.toggle('dle-open');
                        toggle.setAttribute('aria-expanded', targetEl.classList.contains('dle-open'));
                    }
                };
                container.addEventListener('click', (e) => {
                    const toggle = e.target.closest('.dle-note-toggle');
                    if (toggle) _togNote(toggle);
                });
                container.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    const toggle = e.target.closest('.dle-note-toggle');
                    if (!toggle) return;
                    e.preventDefault();
                    _togNote(toggle);
                });
                // Live filter on character/date/body — case-insensitive substring against
                // pre-computed haystacks. Keeps render simple, no re-flow.
                const searchInput = container.querySelector('#dle-scribe-history-search');
                if (searchInput) {
                    let timer = null;
                    searchInput.addEventListener('input', () => {
                        clearTimeout(timer);
                        timer = setTimeout(() => {
                            const q = searchInput.value.toLowerCase().trim();
                            container.querySelectorAll('.dle-scribe-history-item').forEach(el => {
                                const hay = el.dataset.haystack || '';
                                el.style.display = (!q || hay.includes(q)) ? '' : 'none';
                            });
                        }, 100);
                    });
                }

                await callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
            } catch (err) {
                console.error('[DLE] Scribe history error:', err);
                notify.error(classifyError(err), { copyable: true });
            }
            return '';
        },
        helpString: 'Show all session notes from the scribe folder.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-analytics',
        callback: async () => {
            const settings = getSettings();
            const analytics = settings.analyticsData || {};
            // Audit DIAG-03: `_librarian` (and any future `_`-prefixed meta bucket)
            // is internal state, not an entry — skip it in the user-facing table.
            const titles = Object.keys(analytics)
                .filter(k => !k.startsWith('_'))
                .sort((a, b) => (analytics[b].injected || 0) - (analytics[a].injected || 0));

            // Keys are trackerKeys (vaultSource:title). Display the bare title
            // (split on FIRST ':') so the table matches the Never-Injected list;
            // the stored Object.keys(analytics) trackerKey is untouched.
            const displayTitle = (key) => {
                const idx = key.indexOf(':');
                return idx === -1 ? key : key.slice(idx + 1);
            };
            const plainLines = ['Entry Analytics', '', 'Entry\tMatched\tInjected\tLast Used'];
            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                plainLines.push(`${displayTitle(title)}\t${d.matched || 0}\t${d.injected || 0}\t${lastUsed}`);
            }
            const neverInjected = vaultIndex.filter(e => !analytics[trackerKey(e)] || (analytics[trackerKey(e)].injected || 0) === 0);
            if (neverInjected.length > 0) {
                plainLines.push('', 'Never Injected:');
                for (const e of neverInjected) {
                    plainLines.push(`  ${e.title} (${e.keys.length} keys, priority ${e.priority})`);
                }
            }
            const plainText = plainLines.join('\n');

            let html = '<div class="dle-popup">';
            html += buildCopyButton(plainText);
            html += '<table class="dle-table">';
            html += '<tr><th>Entry</th><th>Matched</th><th>Injected</th><th>Last Used</th></tr>';

            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                html += `<tr><td>${escapeHtml(displayTitle(title))}</td><td class="dle-text-center">${d.matched || 0}</td><td class="dle-text-center">${d.injected || 0}</td><td class="dle-text-center">${lastUsed}</td></tr>`;
            }
            html += '</table>';

            if (neverInjected.length > 0) {
                html += '<hr><h4>Never Injected</h4><ul>';
                for (const e of neverInjected) {
                    html += `<li>${escapeHtml(e.title)} (${e.keys.length} keys, priority ${e.priority})</li>`;
                }
                html += '</ul>';
            }

            if (titles.length === 0 && neverInjected.length === 0) {
                html = '<p>No analytics data yet. Generate some messages first.</p>';
            }

            const libStats = analytics._librarian;
            if (libStats) {
                html += '<hr><h4>Librarian</h4>';
                html += `<p>Searches: ${libStats.totalGapSearches || 0} | Flags: ${libStats.totalGapFlags || 0} | Entries Written: ${libStats.totalEntriesWritten || 0} | Updated: ${libStats.totalEntriesUpdated || 0}</p>`;
                const unmet = libStats.topUnmetQueries || [];
                if (unmet.length > 0) {
                    html += '<h5>Top Unmet Queries</h5><ul>';
                    for (const u of unmet.slice(0, 10)) {
                        html += `<li>${escapeHtml(u.query)} (${u.count}x)</li>`;
                    }
                    html += '</ul>';
                }
            }

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, large: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        helpString: 'Show entry usage analytics: how often each entry was matched and injected.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-diagnostics',
        aliases: ['dle-diag'],
        callback: async () => {
            try {
                const { triggerDiagnosticDownload } = await import('../diagnostics/ui.js');
                await triggerDiagnosticDownload();
                toastr.success(tr('dle_cmd_diagnostics_downloaded_toast'), 'DeepLore', { timeOut: 8000 });
            } catch (err) {
                notify.error(`Diagnostic export failed: ${classifyError(err)}`, { copyable: true });
                console.error('[DLE] /dle-diagnostics failed:', err);
            }
            return '';
        },
        helpString: 'Export an anonymized diagnostic report (.md) for support requests. Same as the System tab button.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-health',
        aliases: ['dle-h'],
        callback: async () => {
            if (!await ensureFreshOrToast('/dle-health')) return '';

            const health = runHealthCheck();
            const { issues, errors, warnings } = health;
            const infos = issues.filter(i => i.severity === 'info').length;

            const plainLines = [];
            if (issues.length === 0) {
                plainLines.push('Health Check: No issues found.');
            } else {
                plainLines.push(`Health Check: ${errors} errors, ${warnings} warnings, ${infos} info`, '');
                const grouped = {};
                for (const issue of issues) {
                    if (!grouped[issue.type]) grouped[issue.type] = [];
                    grouped[issue.type].push(issue);
                }
                for (const [type, items] of Object.entries(grouped)) {
                    plainLines.push(`[${type}] (${items.length})`);
                    for (const item of items) {
                        plainLines.push(`  [${item.severity}] ${item.entry}: ${item.detail}`);
                    }
                    plainLines.push('');
                }
            }
            const plainText = plainLines.join('\n');

            let html = '<div class="dle-popup">';

            if (issues.length === 0) {
                html += '<p class="dle-success">No issues found! All entries and settings look healthy.</p>';
            } else {
                html += `<h3>Health Check: ${errors} errors, ${warnings} warnings, ${infos} info</h3>`;
                html += buildCopyButton(plainText);

                // Severity filter chips — toggle visibility per severity. Errors on by default.
                html += '<div class="dle-health-severity-chips" role="toolbar" aria-label="Filter health issues by severity" style="margin:8px 0;">';
                html += `<button type="button" class="menu_button dle-health-sev-chip dle-active" data-sev="error" aria-pressed="true">${errors} errors</button>`;
                html += `<button type="button" class="menu_button dle-health-sev-chip dle-active" data-sev="warning" aria-pressed="true">${warnings} warnings</button>`;
                html += `<button type="button" class="menu_button dle-health-sev-chip dle-active" data-sev="info" aria-pressed="true">${infos} info</button>`;
                html += '</div>';

                const grouped2 = {};
                for (const issue of issues) {
                    if (!grouped2[issue.type]) grouped2[issue.type] = [];
                    grouped2[issue.type].push(issue);
                }

                const severityBadge = (sev) => {
                    const cls = { error: 'dle-error', warning: 'dle-warning', info: 'dle-info' };
                    return `<span class="dle-badge ${cls[sev] || ''}">[${sev}]</span>`;
                };

                for (const [type, items] of Object.entries(grouped2)) {
                    const typeErrors = items.filter(i => i.severity === 'error').length;
                    html += `<details ${typeErrors > 0 ? 'open' : ''}><summary class="dle-health-summary"><strong>${escapeHtml(type)}</strong> (${items.length})</summary>`;
                    html += `<ul class="dle-health-list">`;
                    for (const item of items) {
                        const copyBtn = `<button type="button" class="dle-health-row-copy menu_button_icon dle-text-xs" data-copy="${escapeHtml(item.entry)}" title="Copy entry name" aria-label="Copy entry name"><i class="fa-solid fa-clipboard" aria-hidden="true"></i></button>`;
                        html += `<li data-sev="${item.severity}">${severityBadge(item.severity)} <strong>${escapeHtml(item.entry)}</strong> ${copyBtn}: ${escapeHtml(item.detail)}</li>`;
                    }
                    html += `</ul></details>`;
                }
            }

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, large: true, allowVerticalScrolling: true,
                onOpen: () => {
                    const popupEl = document.querySelector('.popup');
                    attachCopyHandler(popupEl);
                    if (!popupEl) return;
                    // Severity chip toggles.
                    popupEl.querySelectorAll('.dle-health-sev-chip').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const sev = btn.dataset.sev;
                            const active = !btn.classList.contains('dle-active');
                            btn.classList.toggle('dle-active', active);
                            btn.setAttribute('aria-pressed', String(active));
                            popupEl.querySelectorAll(`.dle-health-list li[data-sev="${sev}"]`).forEach(li => {
                                li.style.display = active ? '' : 'none';
                            });
                        });
                    });
                    // Per-row copy.
                    popupEl.addEventListener('click', async (ev) => {
                        const btn = ev.target.closest('.dle-health-row-copy');
                        if (!btn) return;
                        ev.stopPropagation();
                        const text = btn.dataset.copy;
                        if (!text) return;
                        try {
                            await navigator.clipboard.writeText(text);
                            toastr.success(trf('dle_toast_title_copied', text), 'DeepLore', { timeOut: 1200 });
                        } catch { /* clipboard unavailable */ }
                    });
                },
            });
            return '';
        },
        helpString: 'Run 30+ health checks on vault entries and settings: circular requires, duplicates, orphaned references, conflicting overrides, budget warnings, and more.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-cache-info',
        callback: async () => {
            const cacheData = await loadIndexFromCache();
            const cacheAge = cacheData?.timestamp ? Math.round((Date.now() - cacheData.timestamp) / 1000) : null;
            const cacheEntries = cacheData?.entries?.length || 0;

            let storageInfo = 'Unknown';
            try {
                if (navigator.storage?.estimate) {
                    const est = await navigator.storage.estimate();
                    const usedMB = ((est.usage || 0) / 1024 / 1024).toFixed(1);
                    const quotaMB = ((est.quota || 0) / 1024 / 1024).toFixed(0);
                    const pct = est.quota ? Math.round(((est.usage || 0) / est.quota) * 100) : 0;
                    storageInfo = `${usedMB} MB used of ${quotaMB} MB (${pct}%)`;
                }
            } catch { /* storage API unavailable */ }

            let ageLabel = 'No cache';
            if (cacheAge !== null) {
                if (cacheAge < 60) ageLabel = `${cacheAge}s ago`;
                else if (cacheAge < 3600) ageLabel = `${Math.round(cacheAge / 60)}m ago`;
                else ageLabel = `${(cacheAge / 3600).toFixed(1)}h ago`;
            }

            let html = `<div class="dle-popup">`;
            html += `<h3>Vault Cache Info</h3>`;
            html += `<p><b>Cached entries:</b> ${cacheEntries} (live index: ${vaultIndex.length})</p>`;
            html += `<p><b>Cache age:</b> ${ageLabel}</p>`;
            html += `<p><b>Browser storage:</b> ${storageInfo}</p>`;
            html += `<p><b>Index loaded at:</b> ${indexTimestamp ? new Date(indexTimestamp).toLocaleTimeString() : 'never'}</p>`;
            html += `<br><button type="button" class="menu_button dle-cache-clear-btn" style="margin-top: 8px;"><i class="fa-solid fa-trash-can"></i> Clear Cache</button>`;
            html += `</div>`;

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: false,
                onOpen: () => {
                    document.querySelector('.dle-cache-clear-btn')?.addEventListener('click', async () => {
                        // Issue #39: wipe-and-stop — clears IDB cache AND the live in-memory
                        // index (clearIndexCache alone left vaultIndex populated, so Browse
                        // still showed entries and the next rebuild re-preserved them).
                        const result = await clearVaultIndexAndCache();
                        if (!result.ok) {
                            if (result.reason === 'idb') {
                                // Memory wipe happened; only the IDB wipe failed — error, not
                                // success, and keep the popup open so the user can retry (gotcha #95).
                                notify.error(tr('dle_cmd_clear_idb_failed_toast'), { category: 'cache_clear_idb' });
                            } else {
                                notify.warning(tr('dle_cmd_clear_busy_toast'), { category: 'cache_clear_busy' });
                            }
                            return;
                        }
                        notify.success(tr('dle_cmd_cacheinfo_cleared_toast'));
                        document.querySelector('.dle-cache-clear-btn')?.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                    });
                },
            });
            return '';
        },
        helpString: 'Show vault cache status: size, age, entry count, and a button to clear it.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-setup',
        callback: async () => {
            const { showSetupWizard, getWizardResumeStep } = await import('./setup-wizard.js');
            // Resume where a "Finish later" skip left off (getWizardResumeStep returns 1
            // for a fresh/completed run, since completion clears the skip sentinel).
            await showSetupWizard(getWizardResumeStep());
            return '';
        },
        helpString: 'Open the setup wizard: connect vault, configure tags, matching, AI, and more.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-debug',
        callback: async (_args, value) => {
            const settings = getSettings();
            const arg = (value || '').trim().toLowerCase();
            if (arg === 'on') settings.debugMode = true;
            else if (arg === 'off') settings.debugMode = false;
            else settings.debugMode = !settings.debugMode;
            saveSettingsDebounced();
            notifyDebugModeChanged();
            toastr.success(trf('dle_cmd_debug_toggled_toast', settings.debugMode ? 'ON' : 'OFF'), 'DeepLore');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional explicit state',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            enumProvider: () => [
                new SlashCommandEnumValue('on', 'force debug logging on'),
                new SlashCommandEnumValue('off', 'force debug logging off'),
            ],
        })],
        helpString: 'Toggle debug logging. Usage: /dle-debug [on|off]',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-logs',
        callback: async (_args, value) => {
            // Honest parse: a real number (incl. an explicit small one) is clamped to
            // the help-text range 1-500; only genuinely non-numeric / missing input
            // falls back to the default 50. `parseInt(value) || 50` used to coerce 0
            // AND garbage to 50 — masking a typed "0" and any unparseable arg alike.
            const parsed = Number(value);
            const n = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 50;
            const all = consoleBuffer.drain();
            const dleEntries = all.filter(e => e.dle || (e.msg && e.msg.includes('[DLE]')));
            const recent = dleEntries.slice(-n);

            if (recent.length === 0) {
                toastr.info(tr('dle_cmd_logs_nologs_toast'), 'DeepLore');
                return '';
            }

            const lines = recent.map(e => {
                const ts = new Date(e.t).toLocaleTimeString();
                return `[${ts}] [${e.level}] ${e.msg}`;
            });
            const plainText = lines.join('\n');

            const html = `<div class="dle-popup">${buildCopyButton(plainText)}<pre class="dle-text-pre" style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px;">${escapeHtml(plainText)}</pre></div>`;
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, large: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'how many entries to show (1-500, default 50)',
            typeList: [ARGUMENT_TYPE.NUMBER],
            isRequired: false,
        })],
        helpString: 'Show recent DLE console log entries. Usage: /dle-logs [count]',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── Command Palette (/dle) ──
    // /dle-help removed — ST's /help auto-discovers via helpString fields.

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle',
        callback: async () => {
            const executableCommands = DLE_COMMANDS.filter(c => !c.sep);

            const container = document.createElement('div');
            container.classList.add('dle-popup', 'dle-command-palette');

            const searchWrap = document.createElement('div');
            searchWrap.classList.add('dle-palette-search-wrap');
            searchWrap.innerHTML = `<input type="text" class="dle-palette-search text_pole" placeholder="Search commands..." autofocus />`;
            container.appendChild(searchWrap);

            const listEl = document.createElement('div');
            listEl.classList.add('dle-palette-list');
            container.appendChild(listEl);

            function renderList(filter) {
                const lowerFilter = (filter || '').toLowerCase();
                let html = '';
                let visibleCount = 0;
                for (const c of executableCommands) {
                    if (lowerFilter && !c.cmd.toLowerCase().includes(lowerFilter) && !c.desc.toLowerCase().includes(lowerFilter)) continue;
                    const activeClass = visibleCount === 0 ? ' dle-palette-active' : '';
                    html += `<div class="dle-palette-item menu_button${activeClass}" data-cmd="${escapeHtml(c.cmd)}" data-idx="${visibleCount}">`;
                    html += `<code class="dle-palette-cmd">${escapeHtml(c.cmd)}</code>`;
                    // data-i18n lets ST's locale observer translate the desc on insert; the
                    // English `desc` stays as the fallback text node.
                    const i18nAttr = c.i18nKey ? ` data-i18n="${escapeHtml(c.i18nKey)}"` : '';
                    html += `<span class="dle-palette-desc"${i18nAttr}>${escapeHtml(c.desc)}</span>`;
                    html += `</div>`;
                    visibleCount++;
                }
                if (!html) html = '<div class="dle-palette-empty dle-muted">No matching commands</div>';
                listEl.innerHTML = html;
            }

            renderList('');

            const searchInput = container.querySelector('.dle-palette-search');
            searchInput.addEventListener('input', () => renderList(searchInput.value));

            let clickedCmd = null;

            const setActive = (newIdx) => {
                const items = listEl.querySelectorAll('.dle-palette-item');
                if (items.length === 0) return;
                const idx = ((newIdx % items.length) + items.length) % items.length;
                items.forEach((el, i) => el.classList.toggle('dle-palette-active', i === idx));
                items[idx].scrollIntoView({ block: 'nearest' });
            };

            const currentActiveIdx = () => {
                const items = listEl.querySelectorAll('.dle-palette-item');
                for (let i = 0; i < items.length; i++) if (items[i].classList.contains('dle-palette-active')) return i;
                return -1;
            };

            // Arrow keys move highlight; Enter runs highlighted command. Mouse clicks still work.
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive(currentActiveIdx() + 1); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(currentActiveIdx() - 1); }
                else if (e.key === 'Enter') {
                    const items = listEl.querySelectorAll('.dle-palette-item');
                    const idx = currentActiveIdx();
                    const target = idx >= 0 ? items[idx] : items[0];
                    if (target) {
                        e.preventDefault();
                        clickedCmd = target.dataset.cmd;
                        document.querySelector('.popup .popup-button-ok')?.click();
                    }
                }
            });

            container.addEventListener('click', (e) => {
                const item = e.target.closest('.dle-palette-item');
                if (!item) return;
                clickedCmd = item.dataset.cmd;
                document.querySelector('.popup .popup-button-ok')?.click();
            });

            await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
                wide: true,
                allowVerticalScrolling: true,
                onOpen: () => {
                    requestAnimationFrame(() => container.querySelector('.dle-palette-search')?.focus());
                },
            });

            if (clickedCmd) {
                const ctx = SillyTavern?.getContext?.();
                if (ctx?.executeSlashCommands) {
                    await ctx.executeSlashCommands(clickedCmd);
                }
            }

            return '';
        },
        helpString: 'Open command palette — search and run any DLE command.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}
