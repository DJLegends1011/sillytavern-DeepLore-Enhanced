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
import { normalizePinBlock, matchesPinBlock } from '../helpers.js';
import { ensureFreshOrToast, resolveEntryByName } from './commands-shared.js';
import { tr, trf, trPlural } from '../i18n/i18n.js';

export function registerGatingCommands() {
    // ── Per-Chat Pin/Block ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-pin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info(tr('dle_cmd_pin_which_toast'), 'DeepLore Enhanced'); return ''; }
            if (!await ensureFreshOrToast('/dle-pin')) return '';
            const entry = await resolveEntryByName(name, vaultIndex, { commandLabel: 'Pin' });
            if (!entry) return '';
            if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
            if (chat_metadata.deeplore_pins.some(p => matchesPinBlock(p, entry))) {
                toastr.info(trf('dle_cmd_pin_alreadypinned_toast', entry.title), 'DeepLore Enhanced'); return '';
            }
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(b => !matchesPinBlock(b, entry));
            }
            chat_metadata.deeplore_pins.push({ title: entry.title, vaultSource: entry.vaultSource || null });
            saveMetadataDebounced();
            notifyPinBlockChanged();
            toastr.success(trf('dle_toast_entry_pinned', entry.title), 'DeepLore Enhanced');
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
            toastr.success(trf('dle_toast_entry_unpinned', removed), 'DeepLore Enhanced');
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
            if (!name) { toastr.info(tr('dle_cmd_block_which_toast'), 'DeepLore Enhanced'); return ''; }
            if (!await ensureFreshOrToast('/dle-block')) return '';
            const entry = await resolveEntryByName(name, vaultIndex, { commandLabel: 'Block' });
            if (!entry) return '';
            if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
            if (chat_metadata.deeplore_blocks.some(b => matchesPinBlock(b, entry))) {
                toastr.info(trf('dle_cmd_block_alreadyblocked_toast', entry.title), 'DeepLore Enhanced'); return '';
            }
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(p => !matchesPinBlock(p, entry));
            }
            chat_metadata.deeplore_blocks.push({ title: entry.title, vaultSource: entry.vaultSource || null });
            saveMetadataDebounced();
            notifyPinBlockChanged();
            toastr.success(trf('dle_toast_entry_blocked', entry.title), 'DeepLore Enhanced');
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
            toastr.success(trf('dle_toast_entry_unblocked', removed), 'DeepLore Enhanced');
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
                toastr.info(tr('dle_cmd_pins_none_toast'), 'DeepLore Enhanced');
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
                            toastr.success(trf('dle_cmd_clearfield_success_toast', label), 'DeepLore Enhanced');
                        }
                        document.querySelector('.popup-button-ok')?.click();
                    });
                }
            },
        });
    };

    /**
     * Shared scalar-field setter for the built-in era / location / scene-type
     * commands. They are byte-identical apart from the field name and the user-
     * facing label/plural strings; this collapses the three into one body so a
     * copy can't drift. Behavior (scalar `ctx[contextKey] = v` storage, the rich
     * "no entries match" popup listing available values, the success toast) is
     * preserved exactly per field.
     *
     * @param {string} rawValue - the raw slash-command argument
     * @param {object} cfg
     * @param {string} cfg.browseLabel - proper-case label for the browse popup ("Era", "Scene Type")
     * @param {string} cfg.field - customFields field name AND contextKey ("era", "scene_type")
     * @param {string} cfg.setLabel - leading phrase in toasts/popup ("Era", "Scene type")
     * @param {string} cfg.availableLabel - pluralized noun for the popup ("eras", "scene types")
     */
    const setScalarGatingField = async (rawValue, { browseLabel, field, setLabel, availableLabel }) => {
        const v = (rawValue || '').trim();

        if (!v) {
            await showFieldSelectionPopup(browseLabel, field, field);
            return;
        }

        const ctx = ensureCtx();
        ctx[field] = v;
        saveMetadataDebounced();
        notifyGatingChanged();

        const matchCount = countFieldMatches(field, v);
        if (matchCount === 0) {
            const valueMap = collectFieldValues(field);
            const available = [...valueMap.values()].map(x => x.display);
            const listStr = available.length > 0 ? available.join(', ') : 'none';
            await callGenericPopup(
                `<div class="dle-popup"><p>${setLabel} set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available ${availableLabel}: ${escapeHtml(listStr)}</p></div>`,
                POPUP_TYPE.TEXT, '', { wide: false },
            );
        } else {
            toastr.success(`${setLabel} set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
        }
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-era',
        aliases: ['dle-era'],
        callback: async (_args, value) => {
            await setScalarGatingField(value, { browseLabel: 'Era', field: 'era', setLabel: 'Era', availableLabel: 'eras' });
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
            await setScalarGatingField(value, { browseLabel: 'Location', field: 'location', setLabel: 'Location', availableLabel: 'locations' });
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
            await setScalarGatingField(value, { browseLabel: 'Scene Type', field: 'scene_type', setLabel: 'Scene type', availableLabel: 'scene types' });
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
                            toastr.success(trf('dle_cmd_setcharacters_success_toast', [...selected].join(', ')), 'DeepLore Enhanced');
                        } else {
                            toastr.success(tr('dle_cmd_setcharacters_cleared_toast'), 'DeepLore Enhanced');
                        }
                    },
                });
                return '';
            }

            ctx.character_present = v.split(',').map(c => c.trim()).filter(Boolean);
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success(trf('dle_cmd_setcharacters_success_toast', ctx.character_present.join(', ')), 'DeepLore Enhanced');
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
                toastr.info(tr('dle_cmd_setfield_which_toast'), 'DeepLore Enhanced');
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
                toastr.info(tr('dle_cmd_clearfield_which_toast'), 'DeepLore Enhanced');
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
            toastr.success(trf('dle_cmd_clearfield_success_toast', fd.label), 'DeepLore Enhanced');
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
                toastr.info(tr('dle_cmd_clearallcontext_none_toast'), 'DeepLore Enhanced');
                return '';
            }
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success(trPlural('dle_toast_gating_cleared', cleared), 'DeepLore Enhanced');
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
                    toastr.info(tr('dle_cmd_setfolder_nofolders_toast'), 'DeepLore Enhanced');
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
                                    toastr.success(tr('dle_cmd_setfolder_cleared_toast'), 'DeepLore Enhanced');
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
                toastr.info(tr('dle_cmd_setfolder_which_toast'), 'DeepLore Enhanced');
                return '';
            }

            const knownPaths = new Set(folderList.map(f => f.path));
            const valid = folders.filter(f => knownPaths.has(f));
            const unknown = folders.filter(f => !knownPaths.has(f));
            if (unknown.length) {
                toastr.warning(`Unknown folder${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, 'DeepLore Enhanced');
            }
            if (valid.length === 0) {
                toastr.warning(tr('dle_cmd_setfolder_nomatch_toast'), 'DeepLore Enhanced');
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
                toastr.info(tr('dle_cmd_clearfolder_nofilter_toast'), 'DeepLore Enhanced');
                return '';
            }
            chat_metadata.deeplore_folder_filter = null;
            saveMetadataDebounced();
            notifyGatingChanged();
            toastr.success(tr('dle_cmd_clearfolder_cleared_toast'), 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Clear the folder filter, allowing entries from all folders to be injected.',
        returns: ARGUMENT_TYPE.STRING,
    }));
}
