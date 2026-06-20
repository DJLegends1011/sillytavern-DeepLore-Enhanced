/**
 * DeepLore — Librarian Visibility
 *
 * Surfaces handled here: drawer tab/panel, per-message dropdowns.
 * Other surfaces self-gate: ToolManager (settings-ui.js), injectLibrarianDropdown
 * (librarian-ui.js early-return), /dle-librarian slash command (commands-ai.js).
 */
import { getContext } from '../../../../../extensions.js';

/** Idempotent — safe to call from settings toggle and init. */
export function applyLibrarianVisibility(enabled) {
    const display = enabled ? '' : 'none';
    const $tab = $('#dle-tab-librarian');
    const $panel = $('#dle-panel-librarian');
    if ($tab.length) $tab.css('display', display);
    if ($panel.length) $panel.css('display', display);

    if (!enabled) {
        try {
            const ctx = getContext();
            const chat = ctx?.chat;
            if (Array.isArray(chat)) {
                import('./librarian-ui.js').then(m => {
                    for (let i = 0; i < chat.length; i++) {
                        try { m.removeLibrarianDropdown(i); } catch { /* noop */ }
                    }
                }).catch((e) => { console.debug('[DLE] visibility: failed to load librarian-ui:', e?.message); });
            }
        } catch { /* noop */ }
    }
}
