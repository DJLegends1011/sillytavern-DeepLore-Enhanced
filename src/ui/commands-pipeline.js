/** DeepLore — Slash Commands: Pipeline Inspection */
import { chat, chat_metadata, getCurrentChatId } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { NO_ENTRIES_MSG, classifyError } from '../../core/utils.js';
import { formatAndGroup } from '../../core/matching.js';
import { buildExemptionPolicy, applyRequiresExcludesGating, applyContextualGating } from '../stages.js';
import { getSettings, PROMPT_TAG_PREFIX } from '../../settings.js';
import {
    vaultIndex, getWriterVisibleEntries, injectionHistory, generationCount,
    generationLock, trackerKey, buildPromise, fieldDefinitions,
} from '../state.js';
import { getCurrentForChat as getCurrentVerdictForChat } from '../verdict/verdict-store.js';

// Local helper — UI consumers must read the CURRENT CHAT's verdict, not the
// ring-global newest. See docs/gotchas.md #46 ("UI consumer rule").
function _currentVerdictForChat() {
    let cid = null;
    try { cid = getCurrentChatId() ?? null; } catch { cid = null; }
    return getCurrentVerdictForChat(cid);
}
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { ensureFreshOrToast } from './commands-shared.js';
import { showSourcesPopup } from './cartographer.js';
import { runSimulation, showSimulationPopup, buildCopyButton, attachCopyHandler } from './popups.js';
import { tr } from '../i18n/i18n.js';
import { notify } from '../toast-dedup.js';

export function registerPipelineCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-simulate',
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.info(tr('dle_cmd_simulate_nochat_toast'), 'DeepLore');
                return '';
            }
            if (!await ensureFreshOrToast('/dle-simulate')) return '';
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore');
                return '';
            }
            toastr.info(tr('dle_cmd_simulate_running_toast'), 'DeepLore', { timeOut: 2000 });
            const timeline = runSimulation(chat);
            showSimulationPopup(timeline);
            return '';
        },
        helpString: 'Replay chat history step-by-step, showing which entries activate and deactivate at each message.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-why',
        aliases: ['dle-context'],
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.info(tr('dle_toast_no_active_chat'), 'DeepLore');
                return '';
            }
            if (generationLock) {
                toastr.warning('A generation is in progress — wait for it to finish.', 'DeepLore');
                return '';
            }
            // Wait for any in-progress index build to prevent concurrent pipeline execution.
            if (buildPromise) await buildPromise;
            if (!await ensureFreshOrToast('/dle-why')) return '';
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore');
                return '';
            }

            const settings = getSettings();
            // Confirm before making a real API call.
            if (settings.aiSearchEnabled) {
                const proceed = await callGenericPopup('This will make a live AI search call and use API tokens. Continue?', POPUP_TYPE.CONFIRM);
                if (!proceed) return '';
            }
            // BUG-F2: pass context/pins/blocks so AI pre-filter respects gating.
            const gatingContext = chat_metadata?.deeplore_context || {};
            const cmdPins = chat_metadata.deeplore_pins || [];
            const cmdBlocks = chat_metadata.deeplore_blocks || [];
            const folderFilter = chat_metadata?.deeplore_folder_filter || null;
            let finalEntries, matchedKeys;
            try {
                ({ finalEntries, matchedKeys } = await runPipeline(chat, getWriterVisibleEntries(), gatingContext, { pins: cmdPins, blocks: cmdBlocks, folderFilter }));
            } catch (err) {
                console.warn('[DLE] /dle-why pipeline failed:', err);
                notify.error(classifyError(err), { copyable: true });
                return '';
            }

            // Mirror onGenerate order: cooldown → contextual gating → requires/excludes → format.
            let filtered = finalEntries;
            if (settings.reinjectionCooldown > 0) {
                filtered = finalEntries.filter(e => {
                    if (e.constant) return true;
                    const lastGen = injectionHistory.get(trackerKey(e));
                    return lastGen === undefined || (generationCount - lastGen) >= settings.reinjectionCooldown;
                });
            }

            // /dle-why is a diagnostic preview — bootstrapActive=false intentionally.
            // Showing the user "what would inject right now if bootstrap is OFF" is
            // the conservative (and accurate, post-bootstrap) view. Gotcha #60.
            if (gatingContext && Object.keys(gatingContext).length > 0) {
                const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
                const cmdPolicy = buildExemptionPolicy(vaultIndex, cmdPins, cmdBlocks, false);
                filtered = applyContextualGating(filtered, gatingContext, cmdPolicy, settings.debugMode, settings, fieldDefs);
            }

            const cmdPolicy2 = buildExemptionPolicy(vaultIndex, cmdPins, cmdBlocks, false);
            const { result: gated } = applyRequiresExcludesGating(filtered, cmdPolicy2, settings.debugMode, settings.priorityReversed);
            const { count: injectedCount, acceptedEntries } = formatAndGroup(gated, settings, PROMPT_TAG_PREFIX);
            const injected = acceptedEntries || gated.slice(0, injectedCount);

            if (injected.length === 0) {
                toastr.info('No entries would be injected right now — no keywords or fuzzy matches found in the current chat.', 'DeepLore');
                return '';
            }

            const sources = injected.map(e => ({
                title: e.title,
                filename: e.filename,
                // BUG-AUDIT v2.5: matchedKeys keyed by trackerKey (vaultSource:title).
                matchedBy: matchedKeys.get(trackerKey(e)) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
                vaultSource: e.vaultSource || '',
            }));
            showSourcesPopup(sources);
            return '';
        },
        helpString: 'Preview which entries would be included in the next message, and why. Alias: /dle-context',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-inspect',
        aliases: ['dle-i'],
        callback: async () => {
            const _inspectTrace = _currentVerdictForChat()?.trace ?? null;
            if (!_inspectTrace) {
                toastr.info(tr('dle_cmd_inspect_nodata_toast'), 'DeepLore');
                return '';
            }
            const t = _inspectTrace;
            const settings = getSettings();
            const statusIcon = (ok) => ok ? '✓' : '✗';

            const keywordMatchedTitles = new Set(t.keywordMatched.map(m => m.title.toLowerCase()));

            const timingFields = [
                ['Index Refresh', t.ensureIndexFreshMs],
                ['Pin/Block', t.pinBlockMs],
                ['Contextual Gating', t.contextualGatingMs],
                ['Reinjection Cooldown', t.reinjectionCooldownMs],
                ['Requires/Excludes', t.requiresExcludesMs],
                ['Strip Dedup', t.stripDedupMs],
                ['Format & Group', t.formatGroupMs],
                ['Track Generation', t.trackGenerationMs],
                ['Record Analytics', t.recordAnalyticsMs],
                ['Per-Chat Counts', t.perChatCountsMs],
            ];
            const hasTimingData = timingFields.some(([, v]) => v != null);

            // ── Contextual-gating reason builder (shared by both renderers) ──
            // The reason-list logic is identical for plain + HTML; only the
            // escaping and the no-reason fallback text differ. Compute the raw
            // reason fragments once per item.
            const gatingCtx = chat_metadata?.deeplore_context || {};
            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            const contextualReasonStrs = (item) => {
                const entry = vaultIndex.find(e => e.title === item.title);
                const reasons = [];
                if (entry?.customFields) {
                    for (const fd of allDefs) {
                        if (!fd.gating?.enabled) continue;
                        const ev = entry.customFields[fd.name];
                        const av = gatingCtx[fd.contextKey];
                        if (ev == null || ev === '' || (Array.isArray(ev) && !ev.length)) continue;
                        const evStr = Array.isArray(ev) ? ev.join(',') : String(ev);
                        const avStr = av == null || av === '' || (Array.isArray(av) && !av.length) ? '(not set)' : (Array.isArray(av) ? av.join(',') : String(av));
                        if (avStr === '(not set)' || evStr !== avStr) reasons.push({ name: fd.name, evStr, avStr });
                    }
                }
                return reasons;
            };

            // ── Refine-key reason builder (shared) ──
            // Both renderers run the same selective_logic switch; the HTML branch
            // bolds the primary key + logic and word "found in scan text". Build a
            // tiny descriptor and let each renderer assemble its own markup.
            const refineReason = (e, bold) => {
                const logic = e.selectiveLogic || 'and_any';
                const pk = bold ? `<b>${escapeHtml(e.primaryKey)}</b>` : e.primaryKey;
                const keysStr = bold ? e.refineKeys.map(k => escapeHtml(k)).join(', ') : e.refineKeys.join(', ');
                const lg = (s) => bold ? `<b>${s}</b>` : s;
                switch (logic) {
                    case 'and_all':
                        return `matched "${pk}" but selective_logic=${lg('and_all')} requires all of [${keysStr}] (not enough matched)`;
                    case 'not_any':
                        return `matched "${pk}" but selective_logic=${lg('not_any')} blocked because a refine key from [${keysStr}] appeared in the chat`;
                    case 'not_all':
                        return `matched "${pk}" but selective_logic=${lg('not_all')} blocked because ALL of [${keysStr}] matched`;
                    case 'and_any':
                    default:
                        return bold
                            ? `matched "${pk}" but none of [${keysStr}] found in scan text`
                            : `matched "${pk}" but none of [${keysStr}] found`;
                }
            };

            // ── Section descriptors ──
            // One ordered list drives BOTH the plain-text copy buffer and the HTML
            // popup, so a stanza can no longer drift between the two renders. Each
            // descriptor supplies: the gate, the per-format heading, the items, and
            // a per-format item formatter (item text is genuinely format-specific
            // for several stanzas, so plain/html stay distinct closures). `htmlOk`
            // picks the status glyph; `htmlTrailer` is HTML-only trailing markup.
            const sections = [
                {
                    items: t.keywordMatched,
                    plainHeading: () => `Keyword Matched (${t.keywordMatched.length}):`,
                    htmlOk: true,
                    htmlHeading: () => `Keyword Matched (${t.keywordMatched.length})`,
                    plainItem: (m) => `${m.title} — ${m.matchedBy}`,
                    htmlItem: (m) => `${escapeHtml(m.title)} — ${escapeHtml(m.matchedBy)}`,
                },
                {
                    items: t.aiSelected,
                    plainHeading: () => `AI Selected (${t.aiSelected.length}):`,
                    htmlOk: true,
                    htmlHeading: () => `AI Selected (${t.aiSelected.length})`,
                    plainItem: (m) => `${m.title} [${m.confidence}] — ${m.reason}`,
                    htmlItem: (m) => `${escapeHtml(m.title)} [${escapeHtml(m.confidence)}] — ${escapeHtml(m.reason)}`,
                    htmlTrailer: `<p class="dle-text-xs dle-dimmed dle-mt-1"><b>Confidence:</b> HIGH = strong match, MEDIUM = likely relevant, LOW = loosely related or speculative</p>`,
                },
                {
                    items: t.injected || [],
                    plainHeading: () => `Injected (${t.injected.length}, ~${t.totalTokens || '?'} tokens${t.budgetLimit ? ` / ${t.budgetLimit} budget` : ''}):`,
                    htmlOk: true,
                    htmlHeading: () => `Injected (${t.injected.length}, ~${t.totalTokens || '?'} tokens${t.budgetLimit ? ` / ${t.budgetLimit} budget` : ''})`,
                    plainItem: (e) => `${e.title} (~${e.tokens} tokens)${e.truncated ? ` [truncated from ~${e.originalTokens}]` : ''}`,
                    htmlItem: (e) => `${escapeHtml(e.title)} (~${e.tokens} tokens)${e.truncated ? ` <span class="dle-text-warning">[truncated from ~${e.originalTokens}]</span>` : ''}`,
                },
                {
                    items: t.contextualGatingRemoved,
                    plainHeading: () => `Contextual Gating Removed (${t.contextualGatingRemoved.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Contextual Gating Removed (${t.contextualGatingRemoved.length})`,
                    plainItem: (item) => {
                        const reasons = contextualReasonStrs(item).map(r => `${r.name}: ${r.evStr} ≠ ${r.avStr}`);
                        return `${item.title}${reasons.length ? ' — ' + reasons.join(', ') : ''}`;
                    },
                    htmlItem: (item) => {
                        const reasons = contextualReasonStrs(item).map(r => `${escapeHtml(r.name)}: ${escapeHtml(r.evStr)} ≠ ${escapeHtml(r.avStr)}`);
                        const detail = reasons.length ? ` — ${reasons.join(', ')}` : ' — filtered by contextual gating';
                        return `${escapeHtml(item.title)}${detail}`;
                    },
                },
                {
                    items: t.cooldownRemoved,
                    plainHeading: () => `Re-injection Cooldown Removed (${t.cooldownRemoved.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Re-injection Cooldown (${t.cooldownRemoved.length})`,
                    plainItem: (item) => `${item.title}`,
                    htmlItem: (item) => `${escapeHtml(item.title)} — recently injected, on cooldown`,
                },
                {
                    items: t.gatedOut,
                    plainHeading: () => `Gated Out (${t.gatedOut.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Gated Out (${t.gatedOut.length})`,
                    plainItem: (e) => {
                        const reasons = [];
                        if (e.requires?.length > 0) reasons.push(`requires: ${e.requires.join(', ')}`);
                        if (e.excludes?.length > 0) reasons.push(`excludes: ${e.excludes.join(', ')}`);
                        return `${e.title} — ${reasons.join('; ') || 'gating rule'}`;
                    },
                    htmlItem: (e) => {
                        const reasons = [];
                        if (e.requires?.length > 0) {
                            const missing = e.requires.filter(r => !keywordMatchedTitles.has(r.toLowerCase()));
                            if (missing.length > 0) {
                                reasons.push(`requires: ${e.requires.join(', ')} (missing: ${missing.join(', ')})`);
                            } else {
                                reasons.push(`requires: ${e.requires.join(', ')} (all present but removed by later stage)`);
                            }
                        }
                        if (e.excludes?.length > 0) {
                            const blocking = e.excludes.filter(r => keywordMatchedTitles.has(r.toLowerCase()));
                            if (blocking.length > 0) {
                                reasons.push(`excludes: ${e.excludes.join(', ')} (blocking: ${blocking.join(', ')})`);
                            } else {
                                reasons.push(`excludes: ${e.excludes.join(', ')}`);
                            }
                        }
                        return `${escapeHtml(e.title)} — ${escapeHtml(reasons.join('; ') || 'gating rule')}`;
                    },
                },
                {
                    items: t.stripDedupRemoved,
                    plainHeading: () => `Already Injected (${t.stripDedupRemoved.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Already Injected (${t.stripDedupRemoved.length})`,
                    plainItem: (item) => `${item.title}`,
                    htmlItem: (item) => `${escapeHtml(item.title)} — already injected in recent generation(s)`,
                },
                {
                    items: t.probabilitySkipped,
                    plainHeading: () => `Probability Skipped (${t.probabilitySkipped.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Probability Skipped (${t.probabilitySkipped.length})`,
                    plainItem: (e) => `${e.title} (probability: ${e.probability}, rolled: ${e.roll.toFixed(3)})`,
                    htmlItem: (e) => {
                        const rollLabel = e.probability === 0 ? 'probability is 0 (never fires)' : `rolled ${e.roll.toFixed(3)} > ${e.probability}`;
                        return `${escapeHtml(e.title)} — ${rollLabel}`;
                    },
                },
                {
                    items: t.warmupFailed,
                    plainHeading: () => `Warmup Not Met (${t.warmupFailed.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Warmup Not Met (${t.warmupFailed.length})`,
                    plainItem: (e) => `${e.title} (needed: ${e.needed}, found: ${e.found})`,
                    htmlItem: (e) => `${escapeHtml(e.title)} — needs ${e.needed} keyword occurrences, found ${e.found}`,
                },
                {
                    items: t.budgetCut,
                    plainHeading: () => `Budget/Max Cut (${t.budgetCut.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Budget/Max Cut (${t.budgetCut.length})`,
                    plainItem: (e) => `${e.title} (pri ${e.priority}, ~${e.tokens} tokens)`,
                    htmlItem: (e) => `${escapeHtml(e.title)} (pri ${e.priority}, ~${e.tokens} tokens)`,
                },
                {
                    items: t.refineKeyBlocked,
                    plainHeading: () => `Refine Key Blocked (${t.refineKeyBlocked.length}):`,
                    htmlOk: false,
                    htmlHeading: () => `Refine Key Blocked (${t.refineKeyBlocked.length})`,
                    // Audit fix-up: per-entry copy honors selective_logic mode (shared
                    // refineReason builder). Pre-fix the hardcoded AND_ANY phrasing lied
                    // for not_any / not_all entries where a refine MATCH blocked the gate.
                    plainItem: (e) => `${e.title} — ${refineReason(e, false)}`,
                    htmlItem: (e) => `${escapeHtml(e.title)} — ${refineReason(e, true)}`,
                    htmlTrailer: `<p class="dle-text-xs dle-dimmed">Refine keys gating: behavior depends on each entry's selective_logic (and_any / and_all / not_all / not_any).</p>`,
                },
            ];

            // ── Plain-text copy buffer ──
            const plainLines = [
                'Entry Inspector',
                `Mode: ${t.mode} | Indexed: ${t.indexed} | Bootstrap active: ${t.bootstrapActive ? 'yes' : 'no'} | AI fallback: ${t.aiFallback ? 'yes' : 'no'}`,
                ...(t.genId ? [`Generation ID: ${t.genId}`] : []),
                ...(t.aiPreFilter?.removed > 0 ? [`AI pre-filter: ${t.aiPreFilter.removed} entries hidden from AI by contextual gating (${t.aiPreFilter.before} → ${t.aiPreFilter.after})`] : []),
                ...(hasTimingData ? [
                    '',
                    'Stage Timing:',
                    ...timingFields.filter(([, v]) => v != null).map(([name, ms]) => `  ${name}: ${ms}ms`),
                    `  Total: ${timingFields.reduce((sum, [, v]) => sum + (v || 0), 0)}ms`,
                ] : []),
                '',
            ];
            const pushPlainSection = (s) => {
                if (!s.items || s.items.length === 0) return;
                plainLines.push(s.plainHeading());
                for (const item of s.items) plainLines.push(`  ${s.plainItem(item)}`);
                plainLines.push('');
            };
            // Order: keyword, aiSelected, [aiFallback line], fuzzy, injected,
            // contextualGatingRemoved, [folderFilter], cooldown, gatedOut,
            // stripDedup, probability, warmup, budget, refine.
            pushPlainSection(sections[0]); // keyword
            pushPlainSection(sections[1]); // aiSelected
            if (t.aiFallback) plainLines.push('WARNING: AI search failed — keyword results used as fallback', '');
            if (t.fuzzyStats?.active) {
                plainLines.push(`Fuzzy Search: ${t.fuzzyStats.matched} matched from ${t.fuzzyStats.candidates} candidates (threshold: ${t.fuzzyStats.threshold})`);
                plainLines.push('');
            }
            pushPlainSection(sections[2]); // injected
            pushPlainSection(sections[3]); // contextualGatingRemoved
            if (t.folderFilter) {
                plainLines.push(`Folder Filter: ${t.folderFilter.folders.join(', ')} — ${t.folderFilter.removed} entries removed (${t.folderFilter.before} → ${t.folderFilter.after})`);
                plainLines.push('');
            }
            pushPlainSection(sections[4]); // cooldown
            pushPlainSection(sections[5]); // gatedOut
            pushPlainSection(sections[6]); // stripDedup
            pushPlainSection(sections[7]); // probability
            pushPlainSection(sections[8]); // warmup
            pushPlainSection(sections[9]); // budget
            pushPlainSection(sections[10]); // refine
            const plainText = plainLines.join('\n');

            // ── HTML popup ──
            let html = `<div class="dle-popup">`;
            html += `<h3>Entry Inspector</h3>`;
            html += buildCopyButton(plainText);
            html += `<p><b>Mode:</b> ${escapeHtml(t.mode)} | <b>Indexed:</b> ${t.indexed} | <b>Bootstrap active:</b> ${t.bootstrapActive ? 'yes' : 'no'} | <b>AI fallback:</b> ${t.aiFallback ? 'yes' : 'no'}</p>`;
            if (t.genId) html += `<p class="dle-text-xs dle-dimmed"><b>Generation ID:</b> ${escapeHtml(t.genId)}</p>`;
            if (hasTimingData) {
                const totalMs = timingFields.reduce((sum, [, v]) => sum + (v || 0), 0);
                html += `<details><summary class="dle-health-summary"><b>Stage Timing</b> (${totalMs}ms total)</summary>`;
                html += `<table class="dle-table" style="font-size:13px;"><tr><th>Stage</th><th>Time</th></tr>`;
                for (const [name, ms] of timingFields) {
                    if (ms == null) continue;
                    html += `<tr><td>${escapeHtml(name)}</td><td class="dle-text-center">${ms}ms</td></tr>`;
                }
                html += `<tr style="font-weight:bold;"><td>Total</td><td class="dle-text-center">${totalMs}ms</td></tr>`;
                html += `</table></details>`;
            }
            if (t.aiPreFilter?.removed > 0) {
                html += `<p class="dle-text-xs dle-dimmed">AI pre-filter: ${t.aiPreFilter.removed} entries hidden from AI by contextual gating (${t.aiPreFilter.before} → ${t.aiPreFilter.after})</p>`;
            }

            const nothingMatched = t.keywordMatched.length === 0 && t.aiSelected.length === 0
                && (!t.injected || t.injected.length === 0);

            if (nothingMatched) {
                html += `<p class="dle-text-warning">No entries matched. Check scan depth (currently ${settings.scanDepth}), keyword coverage, or run /dle-health.</p>`;
            }

            const pushHtmlSection = (s) => {
                if (!s.items || s.items.length === 0) return;
                const cls = s.htmlOk ? '' : ' class="dle-text-warning"';
                html += `<h4${cls}>${statusIcon(s.htmlOk)} ${s.htmlHeading()}</h4><ul>`;
                for (const item of s.items) html += `<li>${s.htmlItem(item)}</li>`;
                html += '</ul>';
                if (s.htmlTrailer) html += s.htmlTrailer;
            };
            pushHtmlSection(sections[0]); // keyword
            pushHtmlSection(sections[1]); // aiSelected
            if (t.aiFallback) {
                html += `<p class="dle-text-warning">⚠ AI search failed — keyword results used as fallback</p>`;
            }
            if (t.fuzzyStats?.active) {
                const fIcon = t.fuzzyStats.matched > 0 ? statusIcon(true) : 'ℹ';
                html += `<h4>${fIcon} Fuzzy Search (BM25)</h4>`;
                html += `<p>${t.fuzzyStats.matched} entries matched from ${t.fuzzyStats.candidates} candidates (min score threshold: ${t.fuzzyStats.threshold})</p>`;
            }
            pushHtmlSection(sections[2]); // injected
            pushHtmlSection(sections[3]); // contextualGatingRemoved
            pushHtmlSection(sections[4]); // cooldown
            pushHtmlSection(sections[5]); // gatedOut
            pushHtmlSection(sections[6]); // stripDedup
            pushHtmlSection(sections[7]); // probability
            pushHtmlSection(sections[8]); // warmup
            pushHtmlSection(sections[9]); // budget
            pushHtmlSection(sections[10]); // refine

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        helpString: 'Show which entries matched, why, and what the AI selected in the last message.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}
