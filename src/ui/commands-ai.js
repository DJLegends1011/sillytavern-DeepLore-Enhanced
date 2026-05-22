/** DeepLore Enhanced — Slash Commands: AI Features */
import {
    sendMessageAsUser,
    Generate,
    chat,
} from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../../../slash-commands/SlashCommandEnumValue.js';
import { classifyError, NO_ENTRIES_MSG, yamlEscape } from '../../core/utils.js';
import { getSettings, getPrimaryVault } from '../../settings.js';
import { vaultIndex, scribeInProgress, setIndexTimestamp, setSkipNextPipeline } from '../state.js';
import { buildIndex, ensureIndexFresh, getMaxResponseTokens } from '../vault/vault.js';
import { runScribe } from '../ai/scribe.js';
import { runAutoSuggest, showSuggestionPopup } from '../ai/auto-suggest.js';
import { optimizeEntryKeys, showOptimizePopup } from './popups.js';
import { fuzzyTitleMatchAll } from '../helpers.js';

export function registerAiCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-optimize-keys',
        callback: async (_args, entryName) => {
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-optimize-keys:', err);
                return '';
            }
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }
            const name = (entryName || '').trim();
            if (!name) {
                toastr.info('Usage: /dle-optimize-keys <entry name>', 'DeepLore Enhanced');
                return '';
            }
            let entry = vaultIndex.find(e => e.title.toLowerCase() === name.toLowerCase());
            if (!entry) {
                // Fuzzy fallback so a typo / partial name doesn't drop on the floor.
                const titles = vaultIndex.map(e => e.title);
                const matches = fuzzyTitleMatchAll(name, titles, 0.6);
                if (matches.length === 0) {
                    toastr.warning(`Entry "${name}" not found.`, 'DeepLore Enhanced');
                    return '';
                }
                if (matches.length === 1) {
                    entry = vaultIndex.find(e => e.title === matches[0].title);
                    toastr.info(`Matched "${entry.title}" (${Math.round(matches[0].similarity * 100)}%).`, 'DeepLore Enhanced');
                } else {
                    const top = matches.slice(0, 10);
                    const html = `<div class="dle-popup">
                        <h3>Optimize keys: pick an entry</h3>
                        <p class="dle-text-xs dle-muted">No exact match for "${escapeHtml(name)}". Found ${matches.length} similar:</p>
                        <ol class="dle-fuzzy-picker-list">
                            ${top.map(m => `<li><button type="button" class="menu_button dle-fuzzy-pick" data-title="${escapeHtml(m.title)}">${escapeHtml(m.title)} <span class="dle-dimmed">(${Math.round(m.similarity * 100)}%)</span></button></li>`).join('')}
                        </ol>
                    </div>`;
                    let picked = null;
                    await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                        wide: true,
                        onOpen: () => {
                            document.querySelectorAll('.dle-fuzzy-pick').forEach(btn => {
                                btn.addEventListener('click', () => {
                                    picked = btn.getAttribute('data-title');
                                    document.querySelector('.popup-button-ok')?.click();
                                });
                            });
                        },
                    });
                    if (!picked) return '';
                    entry = vaultIndex.find(e => e.title === picked);
                    if (!entry) return '';
                }
            }
            const loadingToast = toastr.info(`Optimizing keywords for "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
            try {
                const result = await optimizeEntryKeys(entry);
                toastr.clear(loadingToast);
                await showOptimizePopup(entry, result);
            } catch (err) {
                toastr.clear(loadingToast);
                console.error('[DLE] Optimize keys error:', err);
                toastr.error(classifyError(err), 'DeepLore Enhanced');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'vault entry title',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: () => vaultIndex.map(e => new SlashCommandEnumValue(e.title)),
        })],
        helpString: 'Suggest better keywords for an entry using AI. Usage: /dle-optimize-keys <entry name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    const newloreCallback = async () => {
        if (!chat || chat.length === 0) {
            toastr.info('No active chat.', 'DeepLore Enhanced');
            return '';
        }
        const loadingToast = toastr.info('Analyzing chat for new entries...', 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
        try {
            const suggestions = await runAutoSuggest();
            toastr.clear(loadingToast);
            await showSuggestionPopup(suggestions);
        } catch (err) {
            toastr.clear(loadingToast);
            console.error('[DLE] Auto-suggest error:', err);
            toastr.error(classifyError(err), 'DeepLore Enhanced');
        }
        return '';
    };
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-newlore',
        callback: newloreCallback,
        helpString: 'Analyze the chat for characters, locations, and concepts not in your lorebook, and suggest new entries to create.',
        returns: ARGUMENT_TYPE.STRING,
    }));
    // Backwards-compatible alias.
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-suggest',
        callback: newloreCallback,
        helpString: 'Analyze the chat and suggest new lorebook entries. Alias for /dle-newlore.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe',
        callback: async (_args, userPrompt) => {
            if (scribeInProgress) {
                toastr.warning('A session summary is already being written. Wait for it to finish.', 'DeepLore Enhanced');
                return '';
            }
            // BUG-AUDIT-H23: missing scribeFolder would write to "undefined/".
            const settings = getSettings();
            if (!settings.scribeFolder) {
                toastr.warning('Session Scribe folder is not set. Configure it in Settings → Features → Session Scribe.', 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Writing session note...', 'DeepLore Enhanced');
            await runScribe(userPrompt?.trim() || '');
            return 'Session note written.';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional focus topic for the scribe',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        helpString: 'Write a session summary note to Obsidian. Usage: /dle-scribe <focus topic>. Example: /dle-scribe What happened with the sword?',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-review',
        callback: async (_args, userPrompt) => {
            try {
            await ensureIndexFresh();

            // BUG-AUDIT Fix 21: lorebook-guide entries are Librarian-only and must
            // never reach the writing AI. /dle-review previously dumped raw vaultIndex,
            // leaking guide content as a persistent user message. Mirrors writer-visible
            // contract from getWriterVisibleEntries() / matchTextForExternal.
            const reviewEntries = vaultIndex.filter(e => !e.guide);

            if (reviewEntries.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }

            const settings = getSettings();
            const totalTokens = reviewEntries.reduce((sum, e) => sum + e.tokenEstimate, 0);

            const confirmed = await callGenericPopup(
                `<p>This will send <b>${reviewEntries.length}</b> entries (~${totalTokens} tokens) as a visible user message and generate an AI response.</p>
                <p class="dle-text-xs dle-muted">Warning: The review message will remain in chat history and may influence subsequent AI responses. Consider starting a new chat or deleting the messages afterward if you don't want this.</p>
                <p>This may be expensive. Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const loreDump = reviewEntries.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Enhanced Review — ${reviewEntries.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DLE] Lore review prompt:', message);
            }

            toastr.info(`Sending ${reviewEntries.length} entries (~${totalTokens} tokens)...`, 'DeepLore Enhanced', { timeOut: 5000 });

            // Bypass DLE pipeline for this generation — review prompt is the entire vault.
            setSkipNextPipeline(true);
            try {
                await sendMessageAsUser(message, '');
                await Generate('normal');
            } finally {
                setSkipNextPipeline(false);
            }

            return '';
            } catch (err) {
                console.warn('[DLE] /dle-review failed:', err);
                toastr.error('Couldn\'t send your lore for review. Check your AI connection and try again.', 'DeepLore Enhanced');
                return '';
            }
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'optional question to ask about the vault',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        helpString: 'Send the entire vault to the AI for review and feedback. Usage: /dle-review <question>. Example: /dle-review What inconsistencies do you see?',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize',
        callback: async () => {
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-summarize:', err);
                return '';
            }
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }

            const missingSummary = vaultIndex.filter(e => !e.summary || !e.summary.trim());
            if (missingSummary.length === 0) {
                toastr.success('All entries already have summaries.', 'DeepLore Enhanced');
                return '';
            }

            const confirmed = await callGenericPopup(
                `<p>Found <b>${missingSummary.length}</b> entries without AI search summaries.</p>
                <p>This will generate summaries using your AI search connection and present each for review before writing to Obsidian.</p>
                <p>Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const result = await summarizeEntries(missingSummary);
            let msg = `Done: ${result.generated} written, ${result.skipped} skipped, ${result.failed} failed`;
            if (result.aborted > 0) msg += `, ${result.aborted} aborted`;
            msg += '.';
            toastr.success(msg, 'DeepLore Enhanced');

            if (result.generated > 0) {
                setIndexTimestamp(0);
                await buildIndex();
            }
            return '';
        },
        helpString: 'Generate AI search summaries for entries that are missing them. Each summary is presented for review before writing.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-librarian',
        callback: async (_args, subcommand) => {
            if (!getSettings().librarianEnabled) {
                toastr.warning('Librarian is disabled. Enable it in DeepLore Enhanced settings.', 'DeepLore Enhanced');
                return '';
            }
            const { openLibrarianPopup } = await import('../librarian/librarian-review.js');
            const { loreGaps } = await import('../state.js');
            const sub = (subcommand || '').trim();

            if (sub.startsWith('gap ')) {
                const gapId = sub.slice(4).trim();
                const gap = loreGaps.find(g => g.id === gapId);
                if (!gap) {
                    toastr.warning(`Gap "${gapId}" not found.`, 'DeepLore Enhanced');
                    return '';
                }
                await openLibrarianPopup('gap', { gap });
            } else if (sub === 'review') {
                await openLibrarianPopup('review');
            } else if (sub === 'audit') {
                await openLibrarianPopup('audit');
            } else {
                await openLibrarianPopup('new');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'subcommand: review | audit | gap <id>',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            // Dynamic enum: static subcommands + gap-by-id for any open gaps.
            enumProvider: async () => {
                const { loreGaps } = await import('../state.js');
                const base = [
                    new SlashCommandEnumValue('review', 'open the review browser'),
                    new SlashCommandEnumValue('audit', 'audit existing entries'),
                ];
                const gaps = (Array.isArray(loreGaps) ? loreGaps : []).map(g =>
                    new SlashCommandEnumValue(`gap ${g.id}`, g.summary || g.title || g.id),
                );
                return [...base, ...gaps];
            },
        })],
        helpString: 'Open the Librarian AI session. Usage: /dle-librarian [gap &lt;id&gt; | review | audit]',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

/**
 * Each summary is presented for review before writing. Aborted via button in review popup.
 * @returns {{ generated: number, skipped: number, failed: number, aborted: number }}
 */
export async function summarizeEntries(entries) {
    const { callAI } = await import('../ai/ai.js');
    const { writeNote, obsidianFetch, encodeVaultPath } = await import('../vault/obsidian-api.js');
    const settings = getSettings();
    const vault = getPrimaryVault(settings);

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    let aborted = false;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        toastr.info(`Generating summary ${i + 1}/${entries.length}: "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });

        try {
            const systemPrompt = 'You are a lore librarian. Write a concise AI search summary (max 600 chars) for the following lorebook entry. The summary should answer: What is this? When should it be selected? Key relationships? Do NOT include physical descriptions or atmospheric prose. Write for an AI that needs to decide whether to inject this entry.';
            const userMsg = `Entry: ${entry.title}\n\nContent:\n${entry.content.substring(0, 3000)}`;

            const result = await callAI(systemPrompt, userMsg, {
                caller: 'summaryGen',
                mode: settings.aiSearchConnectionMode || 'profile',
                profileId: settings.aiSearchProfileId,
                proxyUrl: settings.aiSearchProxyUrl,
                model: settings.aiSearchModel,
                maxTokens: 300,
                timeout: settings.aiSearchTimeout,
            });
            const responseText = result.text;

            const summary = responseText.trim().substring(0, 600);
            if (!summary) {
                failed++;
                continue;
            }

            const remaining = entries.length - i - 1;
            const reviewHtml = `
                <div class="dle-popup">
                    <h4>${escapeHtml(entry.title)}</h4>
                    <p class="dle-text-xs dle-muted dle-mb-2">Progress: ${i + 1} of ${entries.length} | ${generated} written, ${skipped} skipped, ${failed} failed${remaining > 0 ? ` | ${remaining} remaining` : ''}</p>
                    <p class="dle-text-sm dle-muted">Entry content preview: ${escapeHtml(entry.content.substring(0, 200))}...</p>
                    <hr>
                    <p><b>Generated Summary:</b></p>
                    <textarea id="dle-summary-edit" class="text_pole dle-summary-textarea">${escapeHtml(summary)}</textarea>
                    <p class="dle-text-xs dle-faint">OK = write to Obsidian, Cancel = skip this entry.</p>
                    ${remaining > 0 ? '<button id="dle-summary-abort" class="menu_button" style="margin-top:8px;"><i class="fa-solid fa-stop"></i> Abort remaining</button>' : ''}
                </div>`;

            let capturedTextarea = null;
            let userAborted = false;
            const approved = await callGenericPopup(reviewHtml, POPUP_TYPE.CONFIRM, '', {
                wide: true,
                onOpen: () => {
                    capturedTextarea = document.getElementById('dle-summary-edit');
                    const abortBtn = document.getElementById('dle-summary-abort');
                    if (abortBtn) {
                        abortBtn.addEventListener('click', () => {
                            userAborted = true;
                            document.querySelector('.popup-button-cancel')?.click();
                        });
                    }
                },
            });

            if (userAborted) {
                aborted = true;
                break;
            }

            if (!approved) {
                skipped++;
                continue;
            }

            const finalSummary = capturedTextarea?.value?.trim() || summary;

            const fileResult = await obsidianFetch({
                host: vault.host,
                port: vault.port,
                apiKey: vault.apiKey,
                https: !!vault.https,
                path: `/vault/${encodeVaultPath(entry.filename)}`,
                accept: 'text/markdown',
            });

            if (fileResult.status !== 200) {
                failed++;
                console.warn(`[DLE] Failed to read ${entry.filename}: HTTP ${fileResult.status}`);
                continue;
            }

            let fileContent = fileResult.data;
            if (fileContent.startsWith('---')) {
                const endIdx = fileContent.indexOf('---', 3);
                if (endIdx > 0) {
                    const fmSection = fileContent.substring(0, endIdx);
                    const rest = fileContent.substring(endIdx);
                    const cleaned = fmSection.replace(/^summary:.*$/m, '').replace(/\n{3,}/g, '\n\n');
                    fileContent = cleaned + `summary: ${yamlEscape(finalSummary)}\n` + rest;
                }
            }

            const writeResult = await writeNote(vault.host, vault.port, vault.apiKey, entry.filename, fileContent, !!vault.https);
            if (writeResult.ok) {
                generated++;
            } else {
                failed++;
            }
        } catch (err) {
            console.error(`[DLE] Summary generation error for "${entry.title}":`, err);
            failed++;
        }
    }

    const abortedCount = aborted ? entries.length - generated - skipped - failed : 0;
    return { generated, skipped, failed, aborted: abortedCount };
}
