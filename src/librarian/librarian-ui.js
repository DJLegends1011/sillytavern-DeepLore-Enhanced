/**
 * DeepLore — Librarian UI: per-message tool-call dropdown.
 * Mirrors ST's reasoning block ("Thought for X seconds") visually.
 */
import { getSettings } from '../../settings.js';

function buildSummaryText(toolCalls) {
    const searches = toolCalls.filter(c => c.type === 'search').length;
    const gaps = toolCalls.filter(c => c.type === 'flag' && c.subtype !== 'update').length;
    const updates = toolCalls.filter(c => c.type === 'flag' && c.subtype === 'update').length;
    const totalFlags = gaps + updates;

    const parts = [];
    if (searches > 0) {
        parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`);
    }

    const flagParts = [];
    if (gaps > 0) flagParts.push(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'}`);
    if (updates > 0) flagParts.push(`${updates} ${updates === 1 ? 'update' : 'updates'}`);

    if (searches > 0 && totalFlags > 0) {
        return `Consulted lore vault (${parts[0]}, ${flagParts.join(', ')} noted)`;
    }
    if (searches > 0) {
        return `Consulted lore vault (${parts[0]})`;
    }
    return `Noted ${flagParts.join(' and ')} in your lore`;
}

function buildEntryHtml(call) {
    if (call.type === 'search') {
        let resultText;
        if (call.resultCount > 0) {
            const titles = Array.isArray(call.resultTitles) ? call.resultTitles : [];
            // Cap inline list at 3 — long lists overflow the chat row width and bury
            // the icon/query.  Full list still in the title attribute for hover.
            const visibleTitles = titles.slice(0, 3);
            const overflow = titles.length > visibleTitles.length;
            const visibleText = visibleTitles.join(', ') + (overflow ? `, +${titles.length - visibleTitles.length} more` : '');
            const fullTitle = titles.join(', ');
            resultText = `${call.resultCount} ${call.resultCount === 1 ? 'entry' : 'entries'} found (${visibleText})`;
            return `<div class="dle-librarian-dropdown-entry">
                <span class="dle-librarian-icon fa-solid fa-magnifying-glass"></span>
                <span class="dle-librarian-query">${escapeHtml(call.query)}</span>
                <span class="dle-librarian-result" title="${escapeHtml(fullTitle)}">${escapeHtml(resultText)}</span>
            </div>`;
        }
        const resultTextNoHits = 'no results';
        return `<div class="dle-librarian-dropdown-entry">
            <span class="dle-librarian-icon fa-solid fa-magnifying-glass"></span>
            <span class="dle-librarian-query">${escapeHtml(call.query)}</span>
            <span class="dle-librarian-result">${escapeHtml(resultTextNoHits)}</span>
        </div>`;
    }
    // flag (gap or update)
    const isUpdate = call.subtype === 'update';
    const icon = isUpdate ? 'fa-pen-to-square' : 'fa-flag';
    const urgencyLabel = call.urgency ? ` (${call.urgency})` : '';
    const entryRef = isUpdate && call.entryTitle ? ` — ${escapeHtml(call.entryTitle)}` : '';
    return `<div class="dle-librarian-dropdown-entry${isUpdate ? ' dle-flag-update' : ''}">
        <span class="dle-librarian-icon fa-solid ${icon}"></span>
        <span class="dle-librarian-query">${escapeHtml(call.query)}${entryRef}</span>
        <span class="dle-librarian-result">${escapeHtml(urgencyLabel)}</span>
    </div>`;
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Inject the "Consulted lore vault" dropdown into a chat message.
 * @param {number} messageId - mesid
 * @param {Array} toolCalls
 */
export function injectLibrarianDropdown(messageId, toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return;

    const settings = getSettings();
    // visibility.js relies on this gate — keep even though upstream also checks.
    if (!settings.librarianEnabled) return;
    if (!settings.librarianShowToolCalls) return;

    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;

    // Re-inject path: handles swipes and re-renders.
    const existing = mesEl.querySelector('.dle-librarian-details');
    if (existing) existing.remove();

    const summaryText = buildSummaryText(toolCalls);
    const entriesHtml = toolCalls.map(buildEntryHtml).join('\n');

    const details = document.createElement('details');
    details.className = 'dle-librarian-details';
    details.innerHTML = `
        <summary class="dle-librarian-summary">
            <div class="dle-librarian-header">
                <span class="dle-librarian-icon-header fa-solid fa-book-bookmark"></span>
                <span class="dle-librarian-title">${escapeHtml(summaryText)}</span>
                <div class="dle-librarian-arrow fa-solid fa-chevron-up"></div>
            </div>
        </summary>
        <div class="dle-librarian-content">
            ${entriesHtml}
        </div>
    `;

    const mesBlock = mesEl.querySelector('.mes_block');
    if (!mesBlock) return;
    // Place after reasoning details when present, otherwise before mes_text.

    const reasoningDetails = mesBlock.querySelector('.mes_reasoning_details');
    const mesText = mesBlock.querySelector('.mes_text');

    if (reasoningDetails) {
        reasoningDetails.after(details);
    } else if (mesText) {
        mesText.before(details);
    } else {
        mesBlock.appendChild(details);
    }
}

export function removeLibrarianDropdown(messageId) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;
    const existing = mesEl.querySelector('.dle-librarian-details');
    if (existing) existing.remove();
}
