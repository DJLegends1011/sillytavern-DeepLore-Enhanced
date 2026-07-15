/**
 * DeepLore — Settings popup "Prompts" tab.
 *
 * Owns every name that belongs to one feature: language dropdown, folder
 * path input, Export / Reload / Reset-All buttons, the per-prompt status
 * grid, and the per-row action buttons (Export / Revert / Update).
 *
 * Extracted out of `settings-ui.js` so the tab can grow (per-row diff editor,
 * validation surface, etc.) without inflating the settings popup module.
 *
 * Public surface:
 *   - `bindPromptsTabHandlers($container, settings)`  — wire the tab
 *   - `renderPromptsGrid($container)`                  — re-render the grid
 *   - `exportAllPrompts(connection, locale)`           — bulk export helper
 *   - `bulkDeletePromptsThroughCage(connection, keys, onStatus)` — shared
 *       delete loop used by the Reset-All button + the Reset-All-Settings flow
 *   - `buildPromptsConnection(settings)`               — UI-side connection
 *       builder that re-uses the canonical `getPrimaryVault` lookup
 */

import { saveSettingsDebounced } from '../../../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { escapeHtml } from '../../../../../utils.js';
import { getPrimaryVault } from '../../settings.js';
import {
    loadPrompts as loadDlePrompts,
    getPromptStatusGrid as getDlePromptStatusGrid,
    getLastLoadErrors as getDlePromptErrors,
    getAiPromptDictForLocale,
    buildPromptsConnectionFromSettings,
} from '../prompts/prompt-store.js';
import {
    writePromptFile,
    deletePromptFile,
    DLE_PROMPTS_DEFAULT_DIR,
} from '../prompts/prompt-api.js';
import { buildPromptFileContent } from '../prompts/prompt-store-pure.js';
import { KNOWN_PROMPT_KEYS, sanitizePromptsFolderPath } from '../prompts/prompt-validators.js';
import * as PromptsEn from '../i18n/prompts/en.js';

// ════════════════════════════════════════════════════════════════════════════
// Connection helper
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the vault connection bundle for a settings object. UI wrapper around
 * the canonical `buildPromptsConnectionFromSettings` — resolves the vault via
 * `getPrimaryVault` first (the legacy "primary or default" selection rule the
 * store-side helper deliberately skips so it stays settings.js-import-free),
 * then hands the resolved vault to the single shared builder. Falls back to
 * the boot path's first-enabled scan when no primary vault is configured.
 *
 * @param {object} settings
 * @returns {{ host: string, port: number, apiKey: string, prefix: string, useHttps: boolean } | null}
 */
export function buildPromptsConnection(settings) {
    return buildPromptsConnectionFromSettings(settings, getPrimaryVault(settings));
}

// ════════════════════════════════════════════════════════════════════════════
// Status line + load-error surface
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the Prompts tab status line.
 *
 * @param {JQuery} $statusEl
 * @param {string} text
 * @param {'info'|'ok'|'warn'|'err'} [tone]
 */
function setPromptsStatus($statusEl, text, tone = 'info') {
    $statusEl.text(text).attr('data-tone', tone);
}

/**
 * Convert loadPrompts errors[] into a short toastr-friendly string. Returns
 * empty when no errors so callers can choose the success branch.
 *
 * @param {{ errors: Array<{ key: string, reason: string }> }} result
 * @returns {string}
 */
function surfacePromptLoadErrors(result) {
    const errs = (result && result.errors) || [];
    if (errs.length === 0) return '';
    return `${errs.length} prompt override(s) invalid — falling back to defaults. See Prompts tab grid for details.`;
}

// ════════════════════════════════════════════════════════════════════════════
// Bulk export + bulk delete (shared between Reset-All button and reset-settings)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Export every known prompt to the vault using the current locale's dict
 * (or the EN dict for keys the locale is missing). Failures are collected,
 * never thrown.
 *
 * @param {object} connection - { host, port, apiKey, prefix, useHttps }
 * @param {string} locale
 * @returns {Promise<{ written: number, failed: Array<{ key: string, error: string }> }>}
 */
export async function exportAllPrompts(connection, locale) {
    const { dict, resolvedLocale } = await getAiPromptDictForLocale(locale);
    let written = 0;
    const failed = [];
    for (const key of KNOWN_PROMPT_KEYS) {
        const value = (dict && typeof dict[key] === 'string') ? dict[key] : PromptsEn[key];
        if (typeof value !== 'string') {
            failed.push({ key, error: 'no canonical value' });
            continue;
        }
        const content = buildPromptFileContent({ key, locale: resolvedLocale, value });
        const writeResult = await writePromptFile(
            connection.host, connection.port, connection.apiKey,
            connection.prefix, key, content, connection.useHttps,
        );
        if (writeResult.ok) written++;
        else failed.push({ key, error: writeResult.error });
    }
    return { written, failed };
}

/**
 * Iterate `keys`, call `deletePromptFile` through the six-layer cage on each,
 * bucket results, and report progress via `onStatus(text)` if provided.
 * Pure-ish orchestration — never throws; callers decide how to surface the
 * counts (toastr, status line, console).
 *
 * Shared between:
 *   - Reset-All-Prompts button (Prompts tab)
 *   - Reset-All-Settings flow (Q10b vault-prompt cleanup confirm)
 *
 * @param {object} connection
 * @param {Iterable<string>} keys
 * @param {(text: string) => void} [onStatus]
 * @returns {Promise<{ deleted: number, alreadyMissing: number, failures: Array<{ key: string, error: string }> }>}
 */
export async function bulkDeletePromptsThroughCage(connection, keys, onStatus) {
    let deleted = 0;
    let alreadyMissing = 0;
    const failures = [];
    for (const key of keys) {
        if (onStatus) onStatus(`Deleting ${key}…`);
        const result = await deletePromptFile(
            connection.host, connection.port, connection.apiKey,
            connection.prefix, key, connection.useHttps,
        );
        if (result.ok) {
            if (result.alreadyMissing) alreadyMissing++;
            else deleted++;
        } else {
            failures.push({ key, error: result.error });
        }
    }
    return { deleted, alreadyMissing, failures };
}

// ════════════════════════════════════════════════════════════════════════════
// Grid rendering — folded badge + actions table
// ════════════════════════════════════════════════════════════════════════════

/**
 * `source:status` → render rules. Combines what used to be the badge table
 * and the per-row action if-chain into a single source of truth.
 *
 * Reachable combinations are enumerated below. Unreachable rows
 * (compiled-in + anything other than current_default cannot happen because
 * `buildPromptOverlay` always reports current_default for compiled-in
 * sources) fall through to the status-only badge default with no actions.
 *
 * Note: the `'missing'` source/status only arises from the defensive
 * pre-load `if (!meta)` branch in `getPromptStatusGrid`; a populated grid
 * (the only state the live UI ever renders, since boot always runs
 * `loadPrompts`) never carries it. So it has no enumerated rule — it falls
 * through to the status-only badge default below.
 */
const PROMPT_ROW_RULES = {
    'compiled-in:current_default':     { badge: { label: 'Default', tone: 'info' },                   actions: ['export-one'] },
    'vault:current_default':           { badge: { label: 'Default', tone: 'info' },                   actions: ['revert-one'] },
    'vault:stale_default':             { badge: { label: 'Stale Default', tone: 'warn' },             actions: ['update-one', 'revert-one'] },
    'vault:customized':                { badge: { label: 'Customized', tone: 'ok' },                  actions: ['revert-one'] },
    'vault:customized_stale_baseline': { badge: { label: 'Customized (stale baseline)', tone: 'warn' }, actions: ['revert-one'] },
};

/**
 * Status-only fallback when `source:status` lookup misses. Keeps badges
 * stable even for unreachable rows from a future status the rules table
 * forgot to enumerate.
 */
const PROMPT_STATUS_BADGE_FALLBACK = {
    current_default: { label: 'Default', tone: 'info' },
    stale_default: { label: 'Stale Default', tone: 'warn' },
    customized: { label: 'Customized', tone: 'ok' },
    customized_stale_baseline: { label: 'Customized (stale baseline)', tone: 'warn' },
};

/** Button factory entries. `data-prompt-action` is the key. */
const PROMPT_ROW_ACTION_BUTTONS = {
    'export-one': { icon: 'fa-file-export',           label: 'Export', title: 'Write this prompt to your vault for editing.' },
    'revert-one': { icon: 'fa-rotate-left',           label: 'Revert', title: 'Delete this prompt file from your vault. The built-in default will be used.' },
    'update-one': { icon: 'fa-arrow-up-from-bracket', label: 'Update', title: 'Replace the file with the current upstream default for this locale.' },
};

/**
 * Substantive prompts are multi-line, user-tunable prose. Fragments are short
 * agentic-loop structural strings (fence headers, tool descriptions). Both
 * are editable, but the UI groups fragments under a collapsible section so
 * the default tab view isn't a wall of one-liners.
 */
function classifyPromptKey(key) {
    if (!key.startsWith('AGENTIC_')) return 'substantive';
    if (key === 'AGENTIC_ROLE_SECTION') return 'substantive';
    return 'fragment';
}

/**
 * Look up the badge + action set for a row. Falls through to the status-only
 * badge table when the source:status pair isn't enumerated.
 *
 * @param {{ source: string, status: string }} row
 * @returns {{ badge: { label: string, tone: string }, actions: string[] }}
 */
function ruleFor(row) {
    const key = `${row.source}:${row.status}`;
    if (PROMPT_ROW_RULES[key]) return PROMPT_ROW_RULES[key];
    const badge = PROMPT_STATUS_BADGE_FALLBACK[row.status] || { label: row.status, tone: 'info' };
    return { badge, actions: [] };
}

/**
 * Render the per-prompt status grid into `#dle-sp-prompts-grid`.
 *
 * Pulls the latest grid via `getDlePromptStatusGrid()`, classifies rows, and
 * emits a substantive section followed by a collapsible fragments section.
 * Action buttons are wired via event delegation in `bindPromptsTabHandlers`.
 *
 * @param {JQuery} $container - The settings popup root.
 */
export function renderPromptsGrid($container) {
    const $grid = $container.find('#dle-sp-prompts-grid');
    if ($grid.length === 0) return;

    const rows = getDlePromptStatusGrid();
    const errors = getDlePromptErrors();
    const errorMap = new Map(errors.map(e => [e.key, e.reason]));

    const substantive = [];
    const fragments = [];
    for (const row of rows) {
        const enriched = { ...row, error: errorMap.get(row.key) || row.error || null };
        if (classifyPromptKey(row.key) === 'substantive') substantive.push(enriched);
        else fragments.push(enriched);
    }
    substantive.sort((a, b) => a.key.localeCompare(b.key));
    fragments.sort((a, b) => a.key.localeCompare(b.key));

    const html = [];
    html.push(`<div class="dle-prompts-grid-section">`);
    html.push(`<h5 class="dle-settings-subsection-label">Substantive prompts (${substantive.length})</h5>`);
    html.push(renderPromptRows(substantive));
    html.push(`</div>`);

    html.push(`<details class="dle-prompts-grid-section">`);
    html.push(`<summary class="dle-settings-subsection-label">Agentic-loop fragments (${fragments.length})</summary>`);
    html.push(renderPromptRows(fragments));
    html.push(`</details>`);

    $grid.html(html.join(''));
}

/**
 * Render rows of the prompt grid as HTML. Actions are wired by the caller
 * via event delegation.
 *
 * @param {Array<{ key: string, source: string, status: string, error: string | null }>} rows
 * @returns {string}
 */
function renderPromptRows(rows) {
    if (rows.length === 0) return '<p class="dle-section-desc"><em>None.</em></p>';
    const out = [];
    out.push('<table class="dle-prompts-grid-table">');
    out.push('<thead><tr><th>Key</th><th>Source</th><th>Status</th><th class="dle-col-actions">Actions</th></tr></thead>');
    out.push('<tbody>');
    for (const row of rows) {
        const { badge, actions } = ruleFor(row);
        const errorIcon = row.error
            ? `<span class="dle-prompt-row-error" title="${escapeHtml(row.error)}">⚠</span>`
            : '';
        const actionsHtml = actions.map(a => renderActionButton(a, row.key)).join(' ');
        out.push(`<tr>
            <td><code>${escapeHtml(row.key)}</code>${errorIcon}</td>
            <td>${escapeHtml(row.source)}</td>
            <td><span class="dle-status" data-tone="${badge.tone}">${escapeHtml(badge.label)}</span></td>
            <td class="dle-col-actions">${actionsHtml}</td>
        </tr>`);
    }
    out.push('</tbody></table>');
    return out.join('');
}

/**
 * Render a single action button. Driven by `PROMPT_ROW_ACTION_BUTTONS`.
 *
 * @param {string} action - One of the keys in `PROMPT_ROW_ACTION_BUTTONS`.
 * @param {string} key - Prompt key the action targets.
 * @returns {string}
 */
function renderActionButton(action, key) {
    const def = PROMPT_ROW_ACTION_BUTTONS[action];
    if (!def) return '';
    return `<button type="button" class="menu_button menu_button_icon" data-prompt-action="${escapeHtml(action)}" data-prompt-key="${escapeHtml(key)}" title="${escapeHtml(def.title)}">
        <i class="fa-solid ${def.icon}" aria-hidden="true"></i><span>${escapeHtml(def.label)}</span>
    </button>`;
}

// ════════════════════════════════════════════════════════════════════════════
// Per-row action handlers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the dict + canonical value for a single per-row export/update.
 * @returns {Promise<{ value: string, locale: string } | null>}
 */
async function resolveCanonicalForKey(locale, key) {
    const { dict, resolvedLocale } = await getAiPromptDictForLocale(locale);
    const value = (dict && typeof dict[key] === 'string') ? dict[key] : PromptsEn[key];
    if (typeof value !== 'string') return null;
    return { value, locale: resolvedLocale };
}

/**
 * Handle a per-row action button click.
 *
 * @param {JQuery} $container
 * @param {object} settings
 * @param {string} action - 'export-one' | 'revert-one' | 'update-one'
 * @param {string} key
 */
async function handlePromptRowAction($container, settings, action, key) {
    const connection = buildPromptsConnection(settings);
    if (!connection) {
        toastr.warning('No enabled Obsidian vault. Connect a vault on the Connection tab first.', 'DeepLore');
        return;
    }
    const $status = $container.find('#dle-sp-prompts-status');

    if (action === 'revert-one') {
        const confirmed = await callGenericPopup(
            `<div style="text-align:center;"><p><strong>Revert <code>${escapeHtml(key)}</code> to the built-in default?</strong></p><p>The vault file will be deleted via the six-layer safety cage. The built-in default takes over until you re-export.</p></div>`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Revert', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;
        const result = await deletePromptFile(
            connection.host, connection.port, connection.apiKey,
            connection.prefix, key, connection.useHttps,
        );
        if (result.ok) {
            setPromptsStatus($status, result.alreadyMissing ? `${key} was already missing.` : `Reverted ${key}.`, 'ok');
        } else {
            setPromptsStatus($status, `Revert failed: ${result.error}`, 'err');
            return;
        }
    } else if (action === 'export-one' || action === 'update-one') {
        const resolved = await resolveCanonicalForKey(settings.aiPromptLocale, key);
        if (!resolved) {
            setPromptsStatus($status, `Export failed: no canonical value for ${key}`, 'err');
            return;
        }
        const content = buildPromptFileContent({ key, locale: resolved.locale, value: resolved.value });
        const writeResult = await writePromptFile(
            connection.host, connection.port, connection.apiKey,
            connection.prefix, key, content, connection.useHttps,
        );
        if (writeResult.ok) {
            setPromptsStatus($status, `${action === 'update-one' ? 'Updated' : 'Exported'} ${key}.`, 'ok');
        } else {
            setPromptsStatus($status, `Write failed: ${writeResult.error}`, 'err');
            return;
        }
    }

    // Refresh cache + grid after any mutation.
    await loadDlePrompts(settings.aiPromptLocale, connection);
    renderPromptsGrid($container);
}

// ════════════════════════════════════════════════════════════════════════════
// Tab wiring
// ════════════════════════════════════════════════════════════════════════════

/**
 * Surface the Prompts tab — wire dropdown, folder field, action buttons, and
 * status grid. Grid refreshes after every mutation (export, reload, reset,
 * per-row action).
 *
 * @param {JQuery} $container - The settings popup root.
 * @param {object} settings
 */
export function bindPromptsTabHandlers($container, settings) {
    const $c = (sel) => $container.find(sel);
    const $status = $c('#dle-sp-prompts-status');

    // Language dropdown — wires aiPromptLocale.
    $c('#dle-sp-prompts-language').on('change', async function () {
        const newLocale = String($(this).val() || '');
        const oldLocale = settings.aiPromptLocale || '';
        if (newLocale === oldLocale) return;

        const connection = buildPromptsConnection(settings);
        // If overrides exist in the vault, warn before clobbering them with
        // the new locale's defaults (Q3 — overwrite-all-with-confirm).
        if (connection) {
            const grid = getDlePromptStatusGrid();
            const hasVaultOverrides = grid.some(r => r.source === 'vault');
            if (hasVaultOverrides) {
                const confirmed = await callGenericPopup(
                    `<div style="text-align:center;"><p><strong>Switch prompt language to ${escapeHtml(newLocale || '(follow UI)')}?</strong></p><p>Every customized prompt file in your vault will be overwritten with the new locale's defaults. Your edits will be lost.</p></div>`,
                    POPUP_TYPE.CONFIRM, '', { okButton: 'Overwrite', cancelButton: 'Cancel' },
                );
                if (!confirmed) {
                    $(this).val(oldLocale);
                    return;
                }
                setPromptsStatus($status, `Overwriting ${grid.length} prompts with ${newLocale || 'UI'} defaults…`, 'warn');
                await exportAllPrompts(connection, newLocale);
            }
        }

        settings.aiPromptLocale = newLocale;
        saveSettingsDebounced();
        const result = await loadDlePrompts(newLocale, connection);
        const surfaced = surfacePromptLoadErrors(result);
        setPromptsStatus($status, surfaced || `Language set to ${newLocale || 'UI'}. ${result.vaultCount} vault overrides active.`, 'ok');
        renderPromptsGrid($container);
    });

    // Folder path — sanitize on change.
    $c('#dle-sp-prompts-folder-path').on('change', function () {
        const raw = String($(this).val() || '').trim();
        const sanitized = sanitizePromptsFolderPath(raw);
        if (!sanitized) {
            toastr.warning('Prompts folder path failed sanitization. Reverted to default.', 'DeepLore');
            $(this).val(DLE_PROMPTS_DEFAULT_DIR);
            settings.promptsFolderPath = DLE_PROMPTS_DEFAULT_DIR;
        } else {
            settings.promptsFolderPath = sanitized;
            $(this).val(sanitized);
        }
        saveSettingsDebounced();
    });

    // Export Prompts to Vault.
    $c('#dle-sp-prompts-export').on('click', async function () {
        if ($(this).hasClass('disabled')) return;
        const connection = buildPromptsConnection(settings);
        if (!connection) {
            toastr.warning('No enabled Obsidian vault. Connect a vault on the Connection tab first.', 'DeepLore');
            return;
        }

        const grid = getDlePromptStatusGrid();
        const hasVaultOverrides = grid.some(r => r.source === 'vault');
        if (hasVaultOverrides) {
            const confirmed = await callGenericPopup(
                `<div style="text-align:center;"><p><strong>Re-export all prompts?</strong></p><p>Every existing prompt file in your vault will be overwritten with the current language's defaults. Your edits will be lost.</p></div>`,
                POPUP_TYPE.CONFIRM, '', { okButton: 'Overwrite', cancelButton: 'Cancel' },
            );
            if (!confirmed) return;
        }

        setPromptsStatus($status, `Exporting ${KNOWN_PROMPT_KEYS.size} prompts to vault…`, 'info');
        $(this).addClass('disabled');
        try {
            const { written, failed } = await exportAllPrompts(connection, settings.aiPromptLocale);
            const result = await loadDlePrompts(settings.aiPromptLocale, connection);
            renderPromptsGrid($container);
            if (failed.length === 0) {
                setPromptsStatus($status, `Exported ${written} prompts. ${result.vaultCount} active overrides.`, 'ok');
                toastr.success(`Exported ${written} prompts to vault.`, 'DeepLore');
            } else {
                setPromptsStatus($status, `Exported ${written}, failed ${failed.length}. See console.`, 'warn');
                toastr.warning(`Exported ${written}, ${failed.length} failed. Check console.`, 'DeepLore');
                console.warn('[DLE prompts] export failures:', failed);
            }
        } catch (err) {
            setPromptsStatus($status, `Export error: ${err.message}`, 'err');
            console.error('[DLE prompts] export error:', err);
        } finally {
            $(this).removeClass('disabled');
        }
    });

    // Reload Prompts from Vault.
    $c('#dle-sp-prompts-reload').on('click', async function () {
        if ($(this).hasClass('disabled')) return;
        $(this).addClass('disabled');
        try {
            const connection = buildPromptsConnection(settings);
            setPromptsStatus($status, 'Reloading prompts…', 'info');
            const result = await loadDlePrompts(settings.aiPromptLocale, connection);
            renderPromptsGrid($container);
            const surfaced = surfacePromptLoadErrors(result);
            setPromptsStatus(
                $status,
                surfaced || `Reloaded. ${result.vaultCount} vault overrides, ${result.loaded - result.vaultCount} compiled-in.`,
                result.errors.length > 0 ? 'warn' : 'ok',
            );
        } catch (err) {
            setPromptsStatus($status, `Reload error: ${err.message}`, 'err');
        } finally {
            $(this).removeClass('disabled');
        }
    });

    // Reset All Prompts — bulk delete via the cage (one call per key).
    $c('#dle-sp-prompts-reset-all').on('click', async function () {
        if ($(this).hasClass('disabled')) return;
        const connection = buildPromptsConnection(settings);
        if (!connection) {
            toastr.warning('No enabled Obsidian vault. Connect a vault on the Connection tab first.', 'DeepLore');
            return;
        }
        const confirmed = await callGenericPopup(
            `<div style="text-align:center;"><p><strong>Delete every prompt file from your vault folder?</strong></p><p>This cannot be undone. Each delete passes through the six-layer safety cage and only files matching known prompt keys will be removed.</p></div>`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Delete All', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;

        $(this).addClass('disabled');
        setPromptsStatus($status, 'Resetting all prompts…', 'warn');
        const { deleted, alreadyMissing, failures } = await bulkDeletePromptsThroughCage(
            connection,
            KNOWN_PROMPT_KEYS,
            text => setPromptsStatus($status, text, 'warn'),
        );
        await loadDlePrompts(settings.aiPromptLocale, connection);
        renderPromptsGrid($container);
        $(this).removeClass('disabled');
        if (failures.length === 0) {
            setPromptsStatus($status, `Reset complete. Deleted ${deleted}, ${alreadyMissing} already missing.`, 'ok');
            toastr.success(`Reset ${deleted} prompts.`, 'DeepLore');
        } else {
            setPromptsStatus($status, `Deleted ${deleted}, ${failures.length} failed. See console.`, 'warn');
            toastr.warning(`Deleted ${deleted}, ${failures.length} failed. Check console.`, 'DeepLore');
            console.warn('[DLE prompts] reset failures:', failures);
        }
    });

    // Delegated per-row action click handler. Idempotent — `bindPromptsTabHandlers`
    // runs once per popup open, and the grid is re-rendered in place.
    const $grid = $c('#dle-sp-prompts-grid');
    $grid.off('click.dleprompts', '[data-prompt-action]');
    $grid.on('click.dleprompts', '[data-prompt-action]', async function () {
        const action = $(this).attr('data-prompt-action');
        const key = $(this).attr('data-prompt-key');
        if (!action || !key) return;
        await handlePromptRowAction($container, settings, action, key);
    });

    // Initial grid render.
    renderPromptsGrid($container);
}

