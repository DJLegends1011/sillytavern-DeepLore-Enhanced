/**
 * DeepLore Enhanced — Slash Commands: shared helpers.
 *
 * Small cross-command utilities pulled out of the individual command modules so
 * the same toast/console copy and the same fuzzy entry-resolution flow live in
 * exactly one place. Imported by commands-ai / commands-pipeline / commands-gating
 * / commands-admin.
 */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { classifyError } from '../../core/utils.js';
import { ensureIndexFresh } from '../vault/vault.js';
import { fuzzyTitleMatchAll } from '../helpers.js';

/**
 * Refresh the vault index, surfacing the canonical "Could not refresh vault"
 * error toast + console line on failure. Returns true when the index is fresh
 * (caller may proceed), false when the refresh threw (caller should bail).
 *
 * Collapses the ~7 identical `try { await ensureIndexFresh(); } catch (err) {
 * toastr.error(...); console.error(...); return ''; }` copies scattered across
 * the command modules.
 *
 * @param {string} cmdName - the slash command name (e.g. '/dle-pin') for the log line
 * @returns {Promise<boolean>} true if fresh, false if the refresh failed (already toasted)
 */
export async function ensureFreshOrToast(cmdName) {
    try {
        await ensureIndexFresh();
        return true;
    } catch (err) {
        toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
        console.error(`[DLE] ensureIndexFresh failed in ${cmdName}:`, err);
        return false;
    }
}

/**
 * Resolve a user-typed entry name against a candidate set. Exact (case-insensitive)
 * match wins immediately. Otherwise tries fuzzy: 0 matches → toast + null; 1 →
 * info toast + use; 2+ → modal picker, returns null on cancel.
 *
 * Used by /dle-pin, /dle-unpin, /dle-block, /dle-unblock, /dle-optimize-keys so a
 * typo or partial name no longer drops on the floor with "Couldn't find X" —
 * common enough to be frustrating.
 *
 * @param {string} name - raw user input
 * @param {Array<{title: string}>} candidates - objects with a .title field
 * @param {object} opts
 * @param {string} opts.commandLabel - shown in the picker title ("Pin", "Block", etc.)
 * @returns {Promise<object|null>} - the resolved candidate (full object), or null
 */
export async function resolveEntryByName(name, candidates, { commandLabel }) {
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
