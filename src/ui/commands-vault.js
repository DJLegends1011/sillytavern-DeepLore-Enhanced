/** DeepLore Enhanced — Slash Commands: Vault Management */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { classifyError } from '../../core/utils.js';
import { getSettings } from '../../settings.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { vaultIndex, setIndexTimestamp } from '../state.js';
import { buildIndex } from '../vault/vault.js';
// graph.js (~3140 LOC) is lazy-loaded inline below — only paid for when /dle-graph runs.
import { showBrowsePopup } from './popups.js';
import { parseWorldInfoJson, importEntries } from '../vault/import.js';
import { world_names, loadWorldInfo } from '../../../../../world-info.js';
import { dedupWarning } from '../toast-dedup.js';

export function registerVaultCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-graph',
        aliases: ['dle-g'],
        callback: async () => {
            const { showGraphPopup } = await import('../graph/graph.js');
            await showGraphPopup();
            return '';
        },
        helpString: 'Visualize entry relationships as an interactive force-directed graph.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-browse',
        aliases: ['dle-b'],
        callback: async () => {
            await showBrowsePopup();
            return '';
        },
        helpString: 'Open the entry browser — searchable, filterable popup of all indexed entries.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-refresh',
        aliases: ['dle-r'],
        callback: async () => {
            // Don't pre-clear vaultIndex — buildIndex replaces it atomically. Pre-clearing
            // would give any concurrent generation zero entries during rebuild.
            try {
                setIndexTimestamp(0);
                await buildIndex();
                const msg = `Indexed ${vaultIndex.length} entries.`;
                toastr.success(msg, 'DeepLore Enhanced');
                return msg;
            } catch (err) {
                console.warn('[DLE] /dle-refresh failed:', err);
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                return '';
            }
        },
        helpString: 'Rebuild the vault index by re-fetching all entries from Obsidian.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-import',
        callback: async (_args, folderArg) => {
            const folder = (folderArg || '').trim();

            const hasLorebooks = Array.isArray(world_names) && world_names.length > 0;
            const lbOptions = hasLorebooks
                ? world_names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
                : '';

            // Capture in closure — popup DOM is removed before callGenericPopup resolves.
            let capturedJson = '';

            const jsonInput = await callGenericPopup(
                `<div class="dle-popup">
                    <h3>Import SillyTavern World Info</h3>
                    <p>Import entries from an existing SillyTavern lorebook, a local JSON file, or paste JSON directly.</p>
                    ${folder ? `<p>Target folder: <strong>${escapeHtml(folder)}</strong></p>` : '<p>Entries will be created in the vault root. Pass a folder name as argument, e.g. <code>/dle-import Imported</code></p>'}

                    <!-- Lorebook dropdown -->
                    <div id="dle-import-lb-section" class="dle-mb-2${hasLorebooks ? '' : ' dle-hidden'}">
                        <label><small>Select a SillyTavern Lorebook</small></label>
                        <select id="dle-import-lorebook" class="text_pole">
                            <option value="">— Select a lorebook —</option>
                            ${lbOptions}
                        </select>
                    </div>

                    <!-- File browse button -->
                    <div class="dle-mb-2">
                        <input type="file" id="dle-import-file" accept=".json" class="dle-hidden" />
                        <div id="dle-import-browse" class="menu_button menu_button_icon" style="display: inline-flex;">
                            <i class="fa-solid fa-file-import"></i>
                            <span>Browse local JSON file...</span>
                        </div>
                    </div>

                    <!-- Textarea for manual paste -->
                    <label><small>Or paste JSON below</small></label>
                    <textarea id="dle-import-json" class="text_pole dle-import-textarea" placeholder="Paste World Info JSON here..."></textarea>
                </div>`,
                POPUP_TYPE.CONFIRM, '', { wide: true, onOpen: () => {
                    const lbSelect = document.getElementById('dle-import-lorebook');
                    const textarea = document.getElementById('dle-import-json');

                    if (textarea) {
                        textarea.addEventListener('input', () => { capturedJson = textarea.value; });
                    }

                    if (lbSelect) {
                        lbSelect.addEventListener('change', async () => {
                            const name = lbSelect.value;
                            if (!name) return;
                            try {
                                const data = await loadWorldInfo(name);
                                if (!data) {
                                    toastr.error(`Failed to load lorebook "${name}".`, 'DeepLore Enhanced');
                                    return;
                                }
                                const json = JSON.stringify(data, null, 2);
                                if (textarea) textarea.value = json;
                                capturedJson = json;
                            } catch (err) {
                                console.error('[DLE] loadWorldInfo error:', err);
                                toastr.error(classifyError(err), 'DeepLore Enhanced');
                            }
                        });
                    }

                    const browseBtn = document.getElementById('dle-import-browse');
                    const fileInput = document.getElementById('dle-import-file');
                    if (browseBtn && fileInput) {
                        browseBtn.addEventListener('click', () => fileInput.click());
                        fileInput.addEventListener('change', () => {
                            const file = fileInput.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = () => {
                                const text = /** @type {string} */ (reader.result);
                                if (textarea) textarea.value = text;
                                capturedJson = text;
                            };
                            reader.onerror = () => {
                                toastr.error('Failed to read file.', 'DeepLore Enhanced');
                            };
                            reader.readAsText(file);
                        });
                    }
                } },
            );

            if (!jsonInput) return '';

            const jsonText = capturedJson.trim();
            if (!jsonText) {
                toastr.warning('No JSON provided.', 'DeepLore Enhanced');
                return '';
            }

            if (jsonText.length > 10 * 1024 * 1024) {
                const proceed = await callGenericPopup(
                    '<p>The input is larger than 10 MB. This may take a while to process. Continue?</p>',
                    POPUP_TYPE.CONFIRM, '', {},
                );
                if (!proceed) return '';
            }

            try {
                JSON.parse(jsonText);
            } catch (parseErr) {
                console.warn('[DLE] /dle-import JSON parse failed:', parseErr);
                toastr.error('Invalid JSON format. Paste a lorebook export and try again.', 'DeepLore Enhanced');
                return '';
            }

            try {
                const { entries, source } = parseWorldInfoJson(jsonText);
                if (entries.length === 0) {
                    toastr.info('No entries found in the JSON.', 'DeepLore Enhanced');
                    return '';
                }

                const emptyCount = entries.filter(e =>
                    (!e.content || !e.content.trim()) && (!e.key || !e.key.length || e.key.every(k => !k.trim())),
                ).length;
                if (emptyCount > 0) {
                    toastr.warning(`${emptyCount} entries have no content and no keys — they will be imported but may be empty.`, 'DeepLore Enhanced');
                }

                const confirmed = await callGenericPopup(
                    `<p>Found <b>${entries.length}</b> entries from "${escapeHtml(source)}".</p>
                    <p>Import to ${folder ? `folder <b>${escapeHtml(folder)}/</b>` : 'vault root'}?</p>`,
                    POPUP_TYPE.CONFIRM, '', {},
                );
                if (!confirmed) return '';

                const progressToast = toastr.info(`Importing 0/${entries.length} entries...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
                const result = await importEntries(entries, folder, (done, total) => {
                    progressToast.find('.toast-message').text(`Importing ${done}/${total} entries...`);
                });
                progressToast.remove();

                // Wave 5: structured import report popup replaces the simple
                // success/warning toast. The popup shows per-field counts for
                // Wave 1/2/3 native + round-trip handling, the EM section with
                // the friendly explainer, and a "Skip EM on future imports"
                // button that flips settings.wiImportEmHandling.
                if (result.failed > 0) console.warn('[DLE] Import errors:', result.errors);
                const { showImportReport } = await import('./wi-import-report.js');
                await showImportReport(result, source, folder, { getSettings, saveSettings: saveSettingsDebounced });

                // C.2: WI 'Order' → DLE 'priority' inverts semantically — WI sorts
                // high-first, DLE sorts low-first. Priorities round-trip as raw numbers
                // but user-visible behaviour differs. One-shot warning per import.
                if (result.imported > 0) {
                    dedupWarning(
                        "WI 'Order' is inverted in DLE Priority (lower = higher priority). Verify your entries sort as expected.",
                        'wi_import_priority_flip',
                        { timeOut: 15000 },
                    );
                }

                // BUG-108: single buildIndex at the end avoids a window where generation
                // sees a partially-summarized index between two sequential rebuilds.
                let needsRebuild = true;

                if (result.imported > 0) {
                    const settings = getSettings();
                    if (settings.aiSearchEnabled) {
                        // Rebuild first so we can filter for unsummarized entries.
                        setIndexTimestamp(0);
                        await buildIndex();
                        needsRebuild = false;

                        const offerSummaries = await callGenericPopup(
                            `<p>Generate AI summaries for the ${result.imported} imported entries?</p>
                            <p class="dle-text-sm dle-muted">This uses your AI search connection to create meaningful summaries, replacing the default placeholder. Each summary is presented for review before writing.</p>`,
                            POPUP_TYPE.CONFIRM, '', {},
                        );
                        if (offerSummaries) {
                            const imported = vaultIndex.filter(e => !e.summary || e.summary === 'Imported from SillyTavern World Info' || !e.summary.trim());
                            if (imported.length > 0) {
                                const { summarizeEntries } = await import('./commands-ai.js');
                                const sumResult = await summarizeEntries(imported);
                                toastr.success(`Summaries: ${sumResult.generated} written, ${sumResult.skipped} skipped, ${sumResult.failed} failed.`, 'DeepLore Enhanced');
                                if (sumResult.generated > 0) needsRebuild = true;
                            }
                        }
                    }
                }

                if (needsRebuild) {
                    setIndexTimestamp(0);
                    await buildIndex();
                }
            } catch (err) {
                console.error('[DLE] Import error:', err);
                toastr.error(classifyError(err), 'DeepLore Enhanced');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional target folder in the vault (default: vault root)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        helpString: 'Import SillyTavern World Info JSON into the Obsidian vault. Usage: /dle-import <folder>. Example: /dle-import Imported.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}
