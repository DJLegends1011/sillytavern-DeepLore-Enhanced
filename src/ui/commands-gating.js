/** DeepLore Enhanced — Slash Commands: Per-Chat Gating */
import { chat_metadata } from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../../../slash-commands/SlashCommandEnumValue.js';
import { vaultIndex, fieldDefinitions, folderList, notifyGatingChanged, notifyPinBlockChanged } from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { classifyError } from '../../core/utils.js';
import { ensureIndexFresh } from '../vault/vault.js';
import { normalizePinBlock, matchesPinBlock, fuzzyTitleMatchAll } from '../helpers.js';

/**
 * Resolve a user-typed entry name against a candidate set. Exact (case-insensitive)
 * match wins immediately. Otherwise tries fuzzy: 0 matches → toast + null; 1 →
 * info toast + use; 2+ → modal picker, returns null on cancel.
 *
 * Used by /dle-pin, /dle-unpin, /dle-block, /dle-unblock so a typo or partial
 * name no longer drops on the floor with "Couldn't find X" — common enough to
 * be frustrating.
 *
 * @param {string} name - raw user input
 * @param {Array<{title: string}>} candidates - objects with a .title field
 * @param {object} opts
 * @param {string} opts.commandLabel - shown in the picker title ("Pin", "Block", etc.)
 * @returns {Promise<object|null>} - the resolved candidate (full object), or null
 */
async function resolveEntryByName(name, candidates, { commandLabel }) {
    const exact = candidates.find(c => c.title.toLowerCase() === name.toLowerCase());
    if (exact) return exact;

    const titles = candidates.map(c => c.title);
    const matches = fuzzyTitleMatchAll(name, titles, 0.6);
    if (matches.length === 0) {
        toastr.warning(`No entry matching "${name}".`, 'DeepLore Enhanced');
        return null;
    }
    if (matches.length === 1) {
        const match = candidates.find(c => c.title === matches[0].title);
        toastr.info(`Matched "${match.title}" (${Math.round(matches[0].similarity * 100)}%).`, 'DeepLore Enhanced');
        return match;
    }

    const top = matches.slice(0, 10);
    const html = `<div class="dle-popup">
        <h3>${escapeHtml(commandLabel)}: pick an entry</h3>
        <p class="dle-text-xs dle-muted">No exact match for "${escapeHtml(name)}". Found ${matches.length} similar:</p>
        <ol class="dle-fuzzy-picker-list">
            ${top.map(m => `<li><button type="button" class="menu_button dle-fuzzy-pick" data-title="${escapeHtml(m.title)}">${escapeHtml(m.title)} <span class="dle-dimmed">(${Math.round(m.similarity * 100)}%)</span></button></li>`).join('')}
        </ol>
        ${matches.length > 10 ? `<p class="dle-text-xs dle-muted">…and ${matches.length - 10} more (not shown).</p>` : ''}
    </div>`;

    let picked = null;
    await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        // Scope queries to this popup's dialog so a stacked popup doesn't
        // cross-fire (global document.querySelector* would pick up sibling popups).
        onOpen: (popup) => {
            popup.dlg.querySelectorAll('.dle-fuzzy-pick').forEach(btn => {
                btn.addEventListener('click', () => {
                    picked = btn.getAttribute('data-title');
                    popup.okButton?.click();
                });
            });
        },
    });

    if (!picked) return null;
    return candidates.find(c => c.title === picked) || null;
}

export function registerGatingCommands() {
    // ── Per-Chat Pin/Block ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-pin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Pin which entry? Try: /dle-pin Eris', 'DeepLore Enhanced'); return ''; }
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-pin:', err);
                return '';
            }
            const entry = await resolveEntryByName(name, vaultIndex, { commandLabel: 'Pin' });
            if (!entry) return '';
            if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
            if (chat_metadata.deeplore_pins.some(p => matchesPinBlock(p, entry))) {
                toastr.info(`"${entry.title}" is already pinned.`, 'DeepLore Enhanced'); return '';
            }
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(b => !matchesPinBlock(b, entry));
            }
            chat_metadata.deeplore_pins.push({ title: entry.title, vaultSource: entry.vaultSource || null });
            saveMetadataDebounced();
            notifyPinBlockChanged();
            toastr.success(`Pinned "${entry.title}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'entry title to pin',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: () => vaultIndex.map(e => new SlashCommandEnumValue(e.title)),
        })],
        helpString: 'Pin an entry so it always injects in this chat. Usage: /dle-pin <entry name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-unpin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Unpin which entry? Try: /dle-unpin Eris', 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_pins || chat_metadata.deeplore_pins.length === 0) {
                toastr.info('No pinned entries.', 'DeepLore Enhanced'); return '';
            }
            // Build {title} shape that resolveEntryByName understands so fuzzy / picker fires.
            const pinSet = chat_metadata.deeplore_pins.map(p => ({ ...normalizePinBlock(p), _raw: p }));
            const chosen = await resolveEntryByName(name, pinSet, { commandLabel: 'Unpin' });
            if (!chosen) return '';
            const idx = chat_metadata.deeplore_pins.indexOf(chosen._raw);
            if (idx === -1) { toastr.info(`"${chosen.title}" is not pinned.`, 'DeepLore Enhanced'); return ''; }
            const removedItem = chat_metadata.deeplore_pins.splice(idx, 1)[0];
            const removed = normalizePinBlock(removedItem).title;
            saveMetadataDebounced();
            notifyPinBlockChanged();
            toastr.success(`Unpinned "${removed}".`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'pinned entry title to unpin',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: () => (chat_metadata.deeplore_pins || []).map(p => new SlashCommandEnumValue(normalizePinBlock(p).title)),
        })],
        helpString: 'Remove a per-chat pin. Usage: /dle-unpin <entry name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-block',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Block which entry? Try: /dle-block Eris', 'DeepLore Enhanced'); return ''; }
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-block:', err);
                return '';
            }
            const entry = await resolveEntryByName(name, vaultIndex, { commandLabel: 'Block' });
            if (!entry) return '';
            if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
            if (chat_metadata.deeplore_blocks.some(b => matchesPinBlock(b, entry))) {
                toastr.info(`"${entry.title}" is already blocked.`, 'DeepLore Enhanced'); return '';
            }
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(p => !matchesPinBlock(p, entry));
            }
            chat_metadata.deeplore_blocks.push({ title: entry.title, vaultSource: entry.vaultSource || null });
            saveMetadataDebounced();
            notifyPinBlockChanged();
            toastr.success(`Blocked "${entry.title}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'entry title to block',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: () => vaultIndex.map(e => new SlashCommandEnumValue(e.title)),
        })],
        helpString: 'Block an entry so it never injects in this chat. Usage: /dle-block <entry name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-unblock',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Unblock which entry? Try: /dle-unblock Eris', 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_blocks || chat_metadata.deeplore_blocks.length === 0) {
                toastr.info('No blocked entries.', 'DeepLore Enhanced'); return '';
            }
            const blockSet = chat_metadata.deeplore_blocks.map(b => ({ ...normalizePinBlock(b), _raw: b }));
            const chosen = await resolveEntryByName(name, blockSet, { commandLabel: 'Unblock' });
            if (!chosen) return '';
            const idx = chat_metadata.deeplore_blocks.indexOf(chosen._raw);
            if (idx === -1) { toastr.info(`"${chosen.title}" is not blocked.`, 'DeepLore Enhanced'); return ''; }
            const removedItem = chat_metadata.deeplore_blocks.splice(idx, 1)[0];
            const removed = normalizePinBlock(removedItem).title;
            saveMetadataDebounced();
            notifyPinBlockChanged();
            toastr.success(`Unblocked "${removed}".`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'blocked entry title to unblock',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
            enumProvider: () => (chat_metadata.deeplore_blocks || []).map(b => new SlashCommandEnumValue(normalizePinBlock(b).title)),
        })],
        helpString: 'Remove a per-chat block. Usage: /dle-unblock <entry name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-pins',
        callback: async () => {
            const pins = chat_metadata.deeplore_pins || [];
            const blocks = chat_metadata.deeplore_blocks || [];
            if (pins.length === 0 && blocks.length === 0) {
                toastr.info('No per-chat pins or blocks.', 'DeepLore Enhanced');
                return '';
            }
            let html = '<div class="dle-popup">';
            if (pins.length > 0) {
                html += `<h4>Pinned (${pins.length})</h4><ul>`;
                for (const p of pins) {
                    const pb = normalizePinBlock(p);
                    const vaultLabel = pb.vaultSource ? ` <span class="dle-dimmed">(${escapeHtml(pb.vaultSource)})</span>` : '';
                    html += `<li class="dle-success">${escapeHtml(pb.title)}${vaultLabel}</li>`;
                }
                html += '</ul>';
            }
            if (blocks.length > 0) {
                html += `<h4>Blocked (${blocks.length})</h4><ul>`;
                for (const b of blocks) {
                    const pb = normalizePinBlock(b);
                    const vaultLabel = pb.vaultSource ? ` <span class="dle-dimmed">(${escapeHtml(pb.vaultSource)})</span>` : '';
                    html += `<li class="dle-error">${escapeHtml(pb.title)}${vaultLabel}</li>`;
                }
                html += '</ul>';
            }
            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false });
            return '';
        },
        helpString: 'Show all per-chat pinned and blocked entries.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── Contextual Gating ──

    const ensureCtx = () => {
        if (!chat_metadata.deeplore_context) chat_metadata.deeplore_context = {};
        return chat_metadata.deeplore_context;
    };

    /** @returns Map<normalizedValue, { display: string, count: number }> */
    const collectFieldValues = (fieldName) => {
        const valueMap = new Map();
        for (const entry of vaultIndex) {
            const val = entry.customFields?.[fieldName];
            const arr = Array.isArray(val) ? val : (val != null && val !== '' ? [val] : []);
            for (const raw of arr) {
                const key = String(raw).toLowerCase().trim();
                if (!key) continue;
                if (valueMap.has(key)) {
                    valueMap.get(key).count++;
                } else {
                    valueMap.set(key, { display: String(raw).trim(), count: 1 });
                }
            }
        }
        return valueMap;
    };

    /** Case-insensitive exact match against customFields. */
    const countFieldMatches = (fieldName, value) => {
        const lower = value.toLowerCase();
        let count = 0;
        for (const entry of vaultIndex) {
            const val = entry.customFields?.[fieldName];
            const arr = Array.isArray(val) ? val : (val != null && val !== '' ? [val] : []);
            if (arr.some(v => String(v).toLowerCase() === lower)) {
                count++;
            }
        }
        return count;
    };

    const showFieldSelectionPopup = async (label, entryField, ctxField) => {
        const ctx = ensureCtx();
        const valueMap = collectFieldValues(entryField);

        if (valueMap.size === 0) {
            await callGenericPopup(
                `<div class="dle-popup"><p>No entries have a <strong>${label.toLowerCase()}</strong> field set.</p></div>`,
                POPUP_TYPE.TEXT, '', { wide: false },
            );
            return;
        }

        const sorted = [...valueMap.entries()].sort((a, b) => b[1].count - a[1].count || a[1].display.localeCompare(b[1].display));

        // BUG-AUDIT-10: handle scalar AND array context values — multi-value
        // fields (e.g. character_present) store arrays.
        const rawCurrentValue = ctx[ctxField] || '';
        const currentDisplay = Array.isArray(rawCurrentValue) ? rawCurrentValue.join(', ') : String(rawCurrentValue);
        const currentLower = Array.isArray(rawCurrentValue) ? rawCurrentValue.map(v => String(v).toLowerCase()) : [];
        let html = `<div class="dle-popup"><h4>Select ${label}</h4>`;
        if (currentDisplay) {
            html += `<p class="dle-mb-2">Current: <strong>${escapeHtml(currentDisplay)}</strong></p>`;
        }
        html += '<div class="dle-flex-col dle-gap-1">';
        html += `<button class="menu_button dle-field-select dle-flex-between dle-w-full" data-value="">Clear filter</button>`;
        for (const [, { display, count }] of sorted) {
            const isActive = Array.isArray(rawCurrentValue)
                ? currentLower.includes(display.toLowerCase())
                : String(rawCurrentValue).toLowerCase() === display.toLowerCase();
            const activeClass = isActive ? ' dle-field-select--active' : '';
            html += `<button class="menu_button dle-field-select dle-flex-between dle-w-full${activeClass}" data-value="${escapeHtml(display)}">${escapeHtml(display)}<span class="dle-text-xs" style="opacity:0.5;margin-left:auto;padding-left:8px;">${count} ${count === 1 ? 'entry' : 'entries'}</span></button>`;
        }
        html += '</div></div>';

        // BUG-105: scope querySelectorAll to the popup root, not document.
        await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
            wide: false,
            onOpen: (popup) => {
                const root = popup?.dlg || document;
                const buttons = root.querySelectorAll('.dle-field-select');
                for (const btn of buttons) {
                    btn.addEventListener('click', () => {
                        const selected = btn.getAttribute('data-value');
                        ctx[ctxField] = selected;
                        saveMetadataDebounced();
                        notifyGatingChanged();
                        if (selected) {
                            toastr.success(`${label} set to "${selected}" for this chat.`, 'DeepLore Enhanced');
                        } else {
                            toastr.success(`${label} cleared.`, 'DeepLore Enhanced');
                        }
                        document.querySelector('.popup-button-ok')?.click();
                    });
                }
            },
        });
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-era',
        aliases: ['dle-era'],
        callback: async (_args, value) => {
            const v = (value || '').trim();

            if (!v) {
                await showFieldSelectionPopup('Era', 'era', 'era');
                return '';
            }

            const ctx = ensureCtx();
            ctx.era = v;
            saveMetadataDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches('era', v);
            if (matchCount === 0) {
                const valueMap = collectFieldValues('era');
                const available = [...valueMap.values()].map(x => x.display);
                const listStr = available.length > 0 ? available.join(', ') : 'none';
                await callGenericPopup(
                    `<div class="dle-popup"><p>Era set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available eras: ${escapeHtml(listStr)}</p></div>`,
                    POPUP_TYPE.TEXT, '', { wide: false },
                );
            } else {
                toastr.success(`Era set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'era value (e.g. Modern, Medieval)',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: () => [...collectFieldValues('era').values()].map(v => new SlashCommandEnumValue(v.display)),
        })],
        helpString: 'Set the current era for contextual gating. Usage: /dle-set-era <era>. Run without args to browse available values.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-location',
        aliases: ['dle-loc'],
        callback: async (_args, value) => {
            const v = (value || '').trim();

            if (!v) {
                await showFieldSelectionPopup('Location', 'location', 'location');
                return '';
            }

            const ctx = ensureCtx();
            ctx.location = v;
            saveMetadataDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches('location', v);
            if (matchCount === 0) {
                const valueMap = collectFieldValues('location');
                const available = [...valueMap.values()].map(x => x.display);
                const listStr = available.length > 0 ? available.join(', ') : 'none';
                await callGenericPopup(
                    `<div class="dle-popup"><p>Location set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available locations: ${escapeHtml(listStr)}</p></div>`,
                    POPUP_TYPE.TEXT, '', { wide: false },
                );
            } else {
                toastr.success(`Location set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'location value',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: () => [...collectFieldValues('location').values()].map(v => new SlashCommandEnumValue(v.display)),
        })],
        helpString: 'Set the current location for contextual gating. Usage: /dle-set-location <location>. Run without args to browse available values.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-scene',
        callback: async (_args, value) => {
            const v = (value || '').trim();

            if (!v) {
                await showFieldSelectionPopup('Scene Type', 'scene_type', 'scene_type');
                return '';
            }

            const ctx = ensureCtx();
            ctx.scene_type = v;
            saveMetadataDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches('scene_type', v);
            if (matchCount === 0) {
                const valueMap = collectFieldValues('scene_type');
                const available = [...valueMap.values()].map(x => x.display);
                const listStr = available.length > 0 ? available.join(', ') : 'none';
                await callGenericPopup(
                    `<div class="dle-popup"><p>Scene type set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available scene types: ${escapeHtml(listStr)}</p></div>`,
                    POPUP_TYPE.TEXT, '', { wide: false },
                );
            } else {
                toastr.success(`Scene type set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
            }
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'scene type value',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: () => [...collectFieldValues('scene_type').values()].map(v => new SlashCommandEnumValue(v.display)),
        })],
        helpString: 'Set the current scene type for contextual gating. Usage: /dle-set-scene <type>. Run without args to browse available values.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-characters',
        callback: async (_args, value) => {
            const ctx = ensureCtx();
            const v = (value || '').trim();

            if (!v) {
                const valueMap = collectFieldValues('character_present');
                if (valueMap.size === 0) {
                    await callGenericPopup(
                        '<div class="dle-popup"><p>No entries have a <strong>character_present</strong> field set.</p></div>',
                        POPUP_TYPE.TEXT, '', { wide: false },
                    );
                    return '';
                }

                const sorted = [...valueMap.entries()].sort((a, b) => b[1].count - a[1].count || a[1].display.localeCompare(b[1].display));
                const currentArr = Array.isArray(ctx.character_present) ? ctx.character_present : [];
                const currentLower = new Set(currentArr.map(c => c.toLowerCase()));

                const selected = new Set(currentArr);

                let html = '<div class="dle-popup"><h4>Characters Present</h4>';
                if (currentArr.length > 0) {
                    html += `<p class="dle-mb-2">Current: <strong>${escapeHtml(currentArr.join(', '))}</strong></p>`;
                }
                html += '<p class="dle-text-xs dle-muted dle-mb-2">Click to toggle. Changes apply when you close this popup.</p>';
                html += '<div class="dle-flex-col dle-gap-1">';
                html += '<button class="menu_button dle-char-select dle-flex-between dle-w-full" data-value="">Clear all</button>';
                for (const [, { display, count }] of sorted) {
                    const isActive = currentLower.has(display.toLowerCase());
                    const activeClass = isActive ? ' dle-field-select--active' : '';
                    html += `<button class="menu_button dle-char-select dle-flex-between dle-w-full${activeClass}" data-value="${escapeHtml(display)}">${escapeHtml(display)}<span class="dle-text-xs" style="opacity:0.5;margin-left:auto;padding-left:8px;">${count} ${count === 1 ? 'entry' : 'entries'}</span></button>`;
                }
                html += '</div></div>';

                // BUG-105: scope querySelectorAll to the popup root, not document.
                await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                    wide: false,
                    onOpen: (popup) => {
                        const root = popup?.dlg || document;
                        const buttons = root.querySelectorAll('.dle-char-select');
                        for (const btn of buttons) {
                            btn.addEventListener('click', () => {
                                const val = btn.getAttribute('data-value');
                                if (!val) {
                                    selected.clear();
                                    for (const b of buttons) b.classList.remove('dle-field-select--active');
                                } else {
                                    const lower = val.toLowerCase();
                                    const has = [...selected].some(s => s.toLowerCase() === lower);
                                    if (has) {
                                        for (const s of selected) {
                                            if (s.toLowerCase() === lower) { selected.delete(s); break; }
                                        }
                                        btn.classList.remove('dle-field-select--active');
                                    } else {
                                        selected.add(val);
                                        btn.classList.add('dle-field-select--active');
                                    }
                                }
                            });
                        }
                    },
                    onClose: () => {
                        ctx.character_present = [...selected];
                        saveMetadataDebounced();
                        notifyGatingChanged();
                        if (selected.size > 0) {
                            toastr.success(`Characters present: ${[...selected].join(', ')}`, 'DeepLore Enhanced');
                        } else {
                            toastr.success('Present characters cleared.', 'DeepLore Enhanced');
                        }
                    },
                });
                return '';
            }

            ctx.character_present = v.split(',').map(c => c.trim()).filter(Boolean);
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success(`Characters present: ${ctx.character_present.join(', ')}`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'comma-separated character names',
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: () => [...collectFieldValues('character_present').values()].map(v => new SlashCommandEnumValue(v.display)),
        })],
        helpString: 'Set which characters are present for contextual gating. Usage: /dle-set-characters <name1, name2>. Run without args to browse and toggle.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-context-state',
        aliases: ['dle-ctx'],
        callback: async () => {
            const ctx = chat_metadata.deeplore_context || {};
            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            const lines = allDefs.map(fd => {
                const val = ctx[fd.contextKey];
                const display = val == null || val === '' ? '(not set)' : (Array.isArray(val) ? (val.join(', ') || '(not set)') : String(val));
                return `${fd.label}: ${display}`;
            });
            const html = `<pre class="dle-text-pre">${escapeHtml(lines.join('\n'))}</pre>`;
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false });
            return '';
        },
        helpString: 'Show current contextual gating state for all defined fields.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── Generic Field Commands ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-field',
        callback: async (_args, input) => {
            const parts = (input || '').trim().split(/\s+/);
            const fieldName = parts[0] || '';
            const value = parts.slice(1).join(' ').trim();

            if (!fieldName) {
                toastr.info('Set which field? Try: /dle-set-field era Modern (or run with just the field name to browse values).', 'DeepLore Enhanced');
                return '';
            }

            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            const fd = allDefs.find(d => d.name === fieldName);
            if (!fd) {
                toastr.warning(`Unknown field "${fieldName}". Defined fields: ${allDefs.map(d => d.name).join(', ')}`, 'DeepLore Enhanced');
                return '';
            }

            if (!value) {
                await showFieldSelectionPopup(fd.label, fd.name, fd.contextKey);
                return '';
            }

            const ctx = ensureCtx();
            if (fd.multi) {
                const newValues = value.split(',').map(v => v.trim()).filter(Boolean);
                ctx[fd.contextKey] = newValues;
            } else {
                ctx[fd.contextKey] = value;
            }
            saveMetadataDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches(fd.name, value);
            toastr.success(
                `${fd.label} set to "${value}"${matchCount > 0 ? ` — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}` : ' — no entries match'}.`,
                'DeepLore Enhanced',
            );
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'field name and optional value',
            enumProvider: () => {
                const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
                return allDefs.map(f => new SlashCommandEnumValue(f.name, f.label));
            },
        })],
        helpString: 'Set a custom gating field value. Usage: /dle-set-field <field_name> [value]. Run with just the field name to browse values.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-clear-field',
        callback: async (_args, fieldName) => {
            const name = (fieldName || '').trim();
            if (!name) {
                toastr.info('Clear which field? Try: /dle-clear-field era', 'DeepLore Enhanced');
                return '';
            }

            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            const fd = allDefs.find(d => d.name === name);
            if (!fd) {
                toastr.warning(`Unknown field "${name}". Defined fields: ${allDefs.map(d => d.name).join(', ')}`, 'DeepLore Enhanced');
                return '';
            }

            const ctx = ensureCtx();
            if (fd.multi) {
                ctx[fd.contextKey] = [];
            } else {
                ctx[fd.contextKey] = null;
            }
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success(`${fd.label} cleared.`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'field name to clear',
            enumProvider: () => {
                const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
                return allDefs.map(f => new SlashCommandEnumValue(f.name, f.label));
            },
        })],
        helpString: 'Clear a gating field value. Usage: /dle-clear-field <field_name>.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-clear-all-context',
        aliases: ['dle-reset-context'],
        callback: async () => {
            const ctx = ensureCtx();
            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            let cleared = 0;
            for (const fd of allDefs) {
                if (!fd.gating?.enabled) continue;
                const val = ctx[fd.contextKey];
                if (fd.multi ? (Array.isArray(val) && val.length > 0) : !!val) {
                    ctx[fd.contextKey] = fd.multi ? [] : null;
                    cleared++;
                }
            }
            if (cleared === 0) {
                toastr.info('No active gating filters to clear.', 'DeepLore Enhanced');
                return '';
            }
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success(`Cleared ${cleared} gating filter${cleared !== 1 ? 's' : ''}.`, 'DeepLore Enhanced');
            return `Cleared ${cleared} fields`;
        },
        helpString: 'Clear all active gating context fields (era, location, scene, characters, custom fields) at once.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── Folder Filter ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-folder',
        aliases: ['dle-folder'],
        callback: async (_args, input) => {
            const value = (input || '').trim();

            if (!value) {
                if (folderList.length === 0) {
                    toastr.info('No folders found in the vault. All entries are at the root level.', 'DeepLore Enhanced');
                    return '';
                }
                const current = chat_metadata?.deeplore_folder_filter || [];
                const currentSet = new Set(current);
                let html = '<div class="dle-popup"><h4>Select Folders</h4>';
                if (current.length) html += `<p class="dle-mb-2">Active: <strong>${escapeHtml(current.join(', '))}</strong></p>`;
                html += '<div class="dle-flex-col dle-gap-1">';
                html += '<button class="menu_button dle-field-select dle-folder-cmd-select dle-flex-between dle-w-full" data-value="">Clear all folders</button>';
                for (const { path, entryCount } of folderList) {
                    const isActive = currentSet.has(path);
                    const activeClass = isActive ? ' dle-field-select--active' : '';
                    html += `<button class="menu_button dle-field-select dle-folder-cmd-select dle-flex-between dle-w-full${activeClass}" data-value="${escapeHtml(path)}">${escapeHtml(path)}<span class="dle-text-xs" style="opacity:0.5;margin-left:auto;padding-left:8px;">${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}</span></button>`;
                }
                html += '</div></div>';

                await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                    wide: false,
                    onOpen: () => {
                        const buttons = document.querySelectorAll('.dle-folder-cmd-select');
                        for (const btn of buttons) {
                            btn.addEventListener('click', () => {
                                const selected = btn.getAttribute('data-value');
                                if (!selected) {
                                    chat_metadata.deeplore_folder_filter = null;
                                    saveMetadataDebounced();
                                    notifyGatingChanged();
                                    toastr.success('Folder filter cleared — all folders active.', 'DeepLore Enhanced');
                                    document.querySelector('.popup-button-ok')?.click();
                                    return;
                                }
                                if (!chat_metadata.deeplore_folder_filter) chat_metadata.deeplore_folder_filter = [];
                                const idx = chat_metadata.deeplore_folder_filter.indexOf(selected);
                                if (idx !== -1) {
                                    chat_metadata.deeplore_folder_filter.splice(idx, 1);
                                    if (chat_metadata.deeplore_folder_filter.length === 0) chat_metadata.deeplore_folder_filter = null;
                                    btn.classList.remove('dle-field-select--active');
                                } else {
                                    chat_metadata.deeplore_folder_filter.push(selected);
                                    btn.classList.add('dle-field-select--active');
                                }
                                saveMetadataDebounced();
                                notifyGatingChanged();
                            });
                        }
                    },
                });
                return '';
            }

            // Space-separated, with optional quotes for paths containing spaces.
            const folders = value.match(/"[^"]+"|[^\s]+/g)?.map(f => f.replace(/"/g, '').trim()).filter(Boolean) || [];
            if (folders.length === 0) {
                toastr.info('Set which folder? Try: /dle-set-folder Characters (run with no args to browse folders).', 'DeepLore Enhanced');
                return '';
            }

            const knownPaths = new Set(folderList.map(f => f.path));
            const valid = folders.filter(f => knownPaths.has(f));
            const unknown = folders.filter(f => !knownPaths.has(f));
            if (unknown.length) {
                toastr.warning(`Unknown folder${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, 'DeepLore Enhanced');
            }
            if (valid.length === 0) {
                toastr.warning('No matching folders found. Use /dle-set-folder with no args to see available folders.', 'DeepLore Enhanced');
                return '';
            }

            chat_metadata.deeplore_folder_filter = valid;
            saveMetadataDebounced();
            notifyGatingChanged();

            const matchCount = vaultIndex.filter(e => {
                if (!e.folderPath) return true;
                return valid.some(f => e.folderPath === f || e.folderPath.startsWith(f + '/'));
            }).length;
            toastr.success(`Folder filter: ${valid.join(', ')} — ${matchCount} entries match.`, 'DeepLore Enhanced');
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'folder path(s) to filter by (space-separated, quote paths with spaces)',
            enumProvider: () => folderList.map(f => new SlashCommandEnumValue(f.path, `${f.entryCount} entries`)),
        })],
        helpString: 'Set which vault folders are active for this chat. Only entries in selected folders will be injected. No args opens a selection popup.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-clear-folder',
        callback: async () => {
            if (!chat_metadata?.deeplore_folder_filter?.length) {
                toastr.info('No folder filter is active.', 'DeepLore Enhanced');
                return '';
            }
            chat_metadata.deeplore_folder_filter = null;
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success('Folder filter cleared — all folders active.', 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Clear the folder filter, allowing entries from all folders to be injected.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}
