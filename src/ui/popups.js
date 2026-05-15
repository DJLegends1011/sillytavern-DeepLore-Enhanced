/** DeepLore Enhanced — Popup modules. showGraphPopup moved to src/graph.js. */
import {
    chat_metadata,
    chat,
} from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { getTokenCountAsync } from '../../../../../tokenizers.js';
import { parseFrontmatter, simpleHash, buildScanText, classifyError, NO_ENTRIES_MSG } from '../../core/utils.js';
import { testEntryMatch } from '../../core/matching.js';
import { getSettings, getVaultByName } from '../../settings.js';
import { writeNote, obsidianFetch, encodeVaultPath } from '../vault/obsidian-api.js';
import {
    vaultIndex, trackerKey, chatEpoch,
    setVaultIndex, setIndexTimestamp,
    notifyPinBlockChanged,
} from '../state.js';
import { buildIndex } from '../vault/vault.js';
import { callAutoSuggest } from '../ai/auto-suggest.js';
import { extractAiResponseClient, buildObsidianURI, buildObsidianAnchorHtml, openExternalProtocol, STAGE_COLORS, normalizePinBlock } from '../helpers.js';
import { diagnoseEntry } from './diagnostics.js';
import { computeEntryTemperatures } from '../drawer/drawer-state.js';

/**
 * Serialize a value for YAML frontmatter.
 * Strings are quoted only when they contain YAML special chars or look
 * like other YAML scalar types (would otherwise parse-ambiguously).
 */
function yamlSerializeValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    const str = String(val);
    if (/^[{[\]|>*&!%#@`'",?:~-]/.test(str) || /[:#{}[\],]/.test(str) || str === '' ||
        /^(true|false|yes|no|on|off|null|~)$/i.test(str) || !isNaN(Number(str))) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return str;
}

/**
 * Pair with attachCopyHandler() — the latter delegates clicks on `.dle-copy-btn`.
 * Text is base64-encoded into the data attribute to dodge HTML-escaping issues
 * with quotes and newlines.
 */
export function buildCopyButton(plainText) {
    const encoded = btoa(unescape(encodeURIComponent(plainText)));
    return `<button class="menu_button dle-copy-btn dle-text-sm" data-copy="${encoded}">Copy to Clipboard</button>`;
}

/** Idempotent — class-guarded to avoid duplicate listeners. */
export function attachCopyHandler(container) {
    if (!container || container._dleCopyHandlerAttached) return;
    container._dleCopyHandlerAttached = true;
    container.addEventListener('click', async (e) => {
        const btn = e.target.closest('.dle-copy-btn');
        if (!btn) return;
        try {
            const encoded = btn.dataset.copy;
            const text = decodeURIComponent(escape(atob(encoded)));
            await navigator.clipboard.writeText(text);
            const original = btn.textContent;
            btn.textContent = 'Copied!';
            btn.disabled = true;
            // Track timer on element + isConnected check: if popup closes before
            // the timer fires, callback runs against a detached button (silent leak).
            if (btn._dleCopyResetTimer) clearTimeout(btn._dleCopyResetTimer);
            btn._dleCopyResetTimer = setTimeout(() => {
                btn._dleCopyResetTimer = null;
                if (!btn.isConnected) return;
                btn.textContent = original;
                btn.disabled = false;
            }, 1500);
        } catch (err) {
            console.error('[DLE] Clipboard copy failed:', err);
            btn.textContent = 'Copy failed';
            if (btn._dleCopyResetTimer) clearTimeout(btn._dleCopyResetTimer);
            btn._dleCopyResetTimer = setTimeout(() => {
                btn._dleCopyResetTimer = null;
                if (!btn.isConnected) return;
                btn.textContent = 'Copy to Clipboard';
            }, 2000);
        }
    });
}

export async function showNotebookPopup() {
    // BUG-AUDIT-DP04: snapshot epoch at open — discard edits if chat changed during edit.
    const epochAtOpen = chatEpoch;
    const currentContent = chat_metadata?.deeplore_notebook || '';

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    container.innerHTML = `
        <h3>Author Notebook</h3>
        <p class="dle-muted dle-text-sm">Persistent scratchpad for this chat. Contents are injected into every generation when enabled. Use for character notes, plot threads, reminders, or anything the AI should always know.</p>
        <textarea id="dle-notebook-textarea" class="text_pole dle-w-full" rows="15" placeholder="Write notes here...">${escapeHtml(currentContent)}</textarea>
        <span id="dle-notebook-token-count" class="dle-text-xs dle-faint"></span>
    `;

    // Capture in closure — popup DOM is destroyed before callGenericPopup resolves.
    let capturedValue = currentContent;
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
        onOpen: async () => {
            const textarea = document.getElementById('dle-notebook-textarea');
            const countEl = document.getElementById('dle-notebook-token-count');
            if (textarea && countEl) {
                const updateCount = async () => {
                    try {
                        capturedValue = textarea.value;
                        const tokens = await getTokenCountAsync(textarea.value);
                        countEl.textContent = `~${tokens} tokens`;
                    } catch { countEl.textContent = ''; }
                };
                textarea.addEventListener('input', updateCount);
                await updateCount();
            }
        },
    });

    if (result) {
        if (epochAtOpen !== chatEpoch) {
            toastr.warning('Chat changed while editing — changes discarded to prevent cross-chat corruption.', 'DeepLore Enhanced');
            return;
        }
        chat_metadata.deeplore_notebook = capturedValue;
        saveMetadataDebounced();
    }
}

export async function showAiNotepadPopup() {
    // BUG-AUDIT-DP04: snapshot epoch at open — discard edits if chat changed during edit.
    const epochAtOpen = chatEpoch;
    const currentNotes = chat_metadata?.deeplore_ai_notepad || '';

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    container.innerHTML = `
        <h3>AI Notepad</h3>
        <p class="dle-muted dle-text-sm">Session notes written by the AI using &lt;dle-notes&gt; tags. These are stripped from visible chat and reinjected into future messages.</p>
        <textarea id="dle-ai-notepad-textarea" class="text_pole dle-w-full" rows="15" placeholder="No AI notes yet for this chat.">${escapeHtml(currentNotes)}</textarea>
        <span id="dle-ai-notepad-token-count" class="dle-text-xs dle-faint"></span>
    `;

    let capturedValue = currentNotes;
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
        onOpen: async () => {
            const textarea = document.getElementById('dle-ai-notepad-textarea');
            const countEl = document.getElementById('dle-ai-notepad-token-count');
            if (textarea && countEl) {
                const updateCount = async () => {
                    try {
                        capturedValue = textarea.value;
                        const tokens = await getTokenCountAsync(textarea.value);
                        countEl.textContent = `~${tokens} tokens`;
                    } catch { countEl.textContent = ''; }
                };
                textarea.addEventListener('input', updateCount);
                await updateCount();
            }
        },
    });

    if (result) {
        if (epochAtOpen !== chatEpoch) {
            toastr.warning('Chat changed while editing — changes discarded to prevent cross-chat corruption.', 'DeepLore Enhanced');
            return;
        }
        chat_metadata.deeplore_ai_notepad = capturedValue;
        saveMetadataDebounced();
    }
}

export async function showBrowsePopup() {
    if (vaultIndex.length === 0) {
        toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const analytics = settings.analyticsData || {};
    const allTags = [...new Set(vaultIndex.flatMap(e => e.tags))].sort();
    // BUG-136: re-read pins/blocks per access so drawer changes reflect immediately.
    const getPins = () => new Set((chat_metadata.deeplore_pins || []).map(t => (typeof t === 'string' ? t : t.title).toLowerCase()));
    const getBlocks = () => new Set((chat_metadata.deeplore_blocks || []).map(t => (typeof t === 'string' ? t : t.title).toLowerCase()));
    let pins = getPins();
    let blocks = getBlocks();

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    container.innerHTML = `
        <h3>Entry Browser (${vaultIndex.length} entries)</h3>
        <div class="dle-browse-controls">
            <input id="dle-browse-search" type="text" class="text_pole dle-browse-search" placeholder="Search titles, keywords, content..." />
            <select id="dle-browse-status" class="text_pole dle-browse-filter">
                <option value="all">All Status</option>
                <option value="pinned">Pinned</option>
                <option value="blocked">Blocked</option>
                <option value="constant">Constants</option>
                <option value="seed">Seeds</option>
                <option value="bootstrap">Bootstrap</option>
                <option value="regular">Regular</option>
                <option value="never_injected">Never Injected</option>
            </select>
            <select id="dle-browse-tag" class="text_pole dle-browse-filter">
                <option value="">All Tags</option>
                ${allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
            </select>
            <select id="dle-browse-sort" class="text_pole dle-browse-sort">
                <option value="priority_asc">Priority (high→low)</option>
                <option value="priority_desc">Priority (low→high)</option>
                <option value="alpha_asc">Alphabetical (A→Z)</option>
                <option value="alpha_desc">Alphabetical (Z→A)</option>
                <option value="tokens_desc">Token size (largest)</option>
                <option value="tokens_asc">Token size (smallest)</option>
                <option value="injected_desc">Most injected</option>
                <option value="injected_asc">Least injected</option>
            </select>
            <button type="button" id="dle-browse-reset" class="menu_button menu_button_icon" title="Reset all filters" aria-label="Reset all filters"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i></button>
        </div>
        <div id="dle-browse-list" class="dle-scroll-region"></div>
        <span id="dle-browse-count" class="dle-text-xs dle-faint"></span>
    `;

    // H8: pre-computed haystacks reused across re-renders.
    const haystacks = new Map();
    for (const e of vaultIndex) {
        haystacks.set(e, `${e.title} ${e.keys.join(' ')} ${e.content}`.toLowerCase());
    }

    function renderList() {
        pins = getPins();
        blocks = getBlocks();

        const searchEl = container.querySelector('#dle-browse-search');
        const statusEl = container.querySelector('#dle-browse-status');
        const tagEl = container.querySelector('#dle-browse-tag');
        const sortEl = container.querySelector('#dle-browse-sort');
        const listEl = container.querySelector('#dle-browse-list');
        const countEl = container.querySelector('#dle-browse-count');

        const search = (searchEl?.value || '').toLowerCase();
        const status = statusEl?.value || 'all';
        const tag = tagEl?.value || '';
        const sort = sortEl?.value || 'priority_asc';

        let filtered = vaultIndex.filter(e => {
            if (status === 'pinned' && !pins.has(e.title.toLowerCase())) return false;
            if (status === 'blocked' && !blocks.has(e.title.toLowerCase())) return false;
            if (status === 'constant' && !e.constant) return false;
            if (status === 'seed' && !e.seed) return false;
            if (status === 'bootstrap' && !e.bootstrap) return false;
            if (status === 'regular' && (e.constant || e.seed || e.bootstrap)) return false;
            if (status === 'never_injected') {
                const a = analytics[trackerKey(e)];
                if (a && a.injected > 0) return false;
            }
            if (tag && !e.tags.includes(tag)) return false;
            if (search) {
                if (!haystacks.get(e).includes(search)) return false;
            }
            return true;
        });

        const getInjected = (e) => (analytics[trackerKey(e)]?.injected || 0);
        switch (sort) {
            case 'priority_asc': filtered.sort((a, b) => a.priority - b.priority); break;
            case 'priority_desc': filtered.sort((a, b) => b.priority - a.priority); break;
            case 'alpha_asc': filtered.sort((a, b) => a.title.localeCompare(b.title)); break;
            case 'alpha_desc': filtered.sort((a, b) => b.title.localeCompare(a.title)); break;
            case 'tokens_desc': filtered.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
            case 'tokens_asc': filtered.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
            case 'injected_desc': filtered.sort((a, b) => getInjected(b) - getInjected(a)); break;
            case 'injected_asc': filtered.sort((a, b) => getInjected(a) - getInjected(b)); break;
            default: filtered.sort((a, b) => a.priority - b.priority);
        }
        countEl.textContent = `Showing ${filtered.length} of ${vaultIndex.length} entries`;

        const tempMap = computeEntryTemperatures();
        let html = '<table class="dle-browse-table"><thead><tr>';
        html += '<th class="dle-col-title">Title</th>';
        html += '<th class="dle-col-keys">Keywords</th>';
        html += '<th class="dle-col-pri">Pri</th>';
        html += '<th class="dle-col-tok">Tokens</th>';
        html += '<th class="dle-col-usage">Usage</th>';
        html += '</tr></thead><tbody>';
        for (const entry of filtered) {
            const statusBadges = [];
            if (pins.has(entry.title.toLowerCase())) statusBadges.push('<span class="dle-badge dle-success">[pinned]</span>');
            if (blocks.has(entry.title.toLowerCase())) statusBadges.push('<span class="dle-badge dle-error">[blocked]</span>');
            if (entry.constant) statusBadges.push('<span class="dle-text-xs dle-success">[const]</span>');
            if (entry.seed) statusBadges.push('<span class="dle-text-xs dle-info">[seed]</span>');
            if (entry.bootstrap) statusBadges.push('<span class="dle-text-xs dle-warning">[boot]</span>');

            const keysDisplay = entry.keys.slice(0, 5).map(k => escapeHtml(k)).join(', ') + (entry.keys.length > 5 ? '...' : '');
            const a = analytics[trackerKey(entry)];
            const matchedNum = a?.matched || 0;
            const injectedNum = a?.injected || 0;
            const usageStr = a ? `${matchedNum}m / ${injectedNum}i` : '—';
            const entryId = simpleHash(entry.filename);

            const entryVaultName = entry.vaultSource
                ? (settings.vaults?.find(v => v.name === entry.vaultSource)?.name || '')
                : (settings.vaults?.[0]?.name || '');
            const obsidianUri = buildObsidianURI(entryVaultName, entry.filename);
            const obsidianLink = obsidianUri
                ? ` ${buildObsidianAnchorHtml(obsidianUri, { className: 'dle-text-xs dle-muted' })}`
                : '';

            const temp = tempMap.get(trackerKey(entry));
            const tempAttr = temp && temp.hue !== 'neutral' ? ` data-temp="${temp.hue}"` : '';
            const isPinned = pins.has(entry.title.toLowerCase());
            const isBlocked = blocks.has(entry.title.toLowerCase());
            const rowActions = `<span class="dle-browse-row-actions" data-no-toggle="1">`
                + `<button type="button" class="dle-browse-row-pin menu_button_icon dle-text-xs" data-title="${escapeHtml(entry.title)}" data-vault="${escapeHtml(entry.vaultSource || '')}" title="${isPinned ? 'Unpin' : 'Pin'} ${escapeHtml(entry.title)}" aria-label="${isPinned ? 'Unpin' : 'Pin'} ${escapeHtml(entry.title)}"><i class="fa-solid fa-thumbtack${isPinned ? '' : ''}" aria-hidden="true" style="${isPinned ? 'color:var(--dle-success,#3a3);' : 'opacity:0.5;'}"></i></button>`
                + `<button type="button" class="dle-browse-row-block menu_button_icon dle-text-xs" data-title="${escapeHtml(entry.title)}" data-vault="${escapeHtml(entry.vaultSource || '')}" title="${isBlocked ? 'Unblock' : 'Block'} ${escapeHtml(entry.title)}" aria-label="${isBlocked ? 'Unblock' : 'Block'} ${escapeHtml(entry.title)}"><i class="fa-solid fa-ban" aria-hidden="true" style="${isBlocked ? 'color:var(--dle-error,#a33);' : 'opacity:0.5;'}"></i></button>`
                + `<button type="button" class="dle-browse-row-copy menu_button_icon dle-text-xs" data-title="${escapeHtml(entry.title)}" title="Copy title" aria-label="Copy ${escapeHtml(entry.title)}"><i class="fa-solid fa-clipboard" aria-hidden="true" style="opacity:0.6;"></i></button>`
                + `</span>`;
            html += `<tr class="dle-entry-toggle dle-browse-table-row" data-target="dle-entry-${entryId}" aria-expanded="false"${tempAttr}>`;
            html += `<td class="dle-browse-table-title"><strong>${escapeHtml(entry.title)}</strong> ${statusBadges.join(' ')} ${rowActions}</td>`;
            html += `<td class="dle-browse-table-keys">${keysDisplay || '<em class="dle-muted">none</em>'}</td>`;
            html += `<td class="dle-text-center">P${entry.priority}</td>`;
            html += `<td class="dle-text-right">~${entry.tokenEstimate}</td>`;
            html += `<td class="dle-text-right" title="matched / injected">${usageStr}</td>`;
            html += `</tr>`;
            html += `<tr id="dle-entry-${entryId}" class="dle-hidden"><td colspan="5" class="dle-browse-table-detail">`;
            const truncated = entry.content.length > 500 ? entry.content.substring(0, 500) + '…' : entry.content;
            html += `<div class="dle-preview">${escapeHtml(truncated)}</div>`;
            html += `<div class="dle-text-xs dle-muted dle-mt-1">`;
            html += `Links: ${entry.resolvedLinks.length > 0 ? entry.resolvedLinks.map(l => escapeHtml(l)).join(', ') : 'none'}`;
            html += ` · Tags: ${entry.tags.length > 0 ? entry.tags.map(t => escapeHtml(t)).join(', ') : 'none'}`;
            if (entry.requires.length > 0) html += ` · Requires: ${entry.requires.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.excludes.length > 0) html += ` · Excludes: ${entry.excludes.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.probability !== null) html += ` · Probability: ${entry.probability}`;
            if (entry.vaultSource && (settings.vaults || []).length > 1) html += ` · Vault: ${escapeHtml(entry.vaultSource)}`;
            html += obsidianLink;
            html += `</div>`;
            if (chat && chat.length > 0 && !entry.constant) {
                html += `<div id="dle-whynot-${entryId}" class="dle-mt-1"><button class="menu_button dle-whynot-btn dle-text-xs" data-title="${escapeHtml(entry.title)}">Why not injected?</button></div>`;
            }
            html += `</td></tr>`;
        }
        html += '</tbody></table>';
        if (filtered.length === 0) {
            const hasActiveFilters = !!search || (status !== 'all') || !!tag;
            if (hasActiveFilters) {
                listEl.innerHTML = '<div class="dle-empty-state"><i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i><p>No entries match your filters.</p><button type="button" id="dle-browse-reset-empty" class="menu_button">Clear all filters</button></div>';
            } else {
                listEl.innerHTML = '<p class="dle-dimmed">No entries.</p>';
            }
        } else {
            listEl.innerHTML = html;
        }
    }

    function resetBrowseFilters() {
        const searchEl = container.querySelector('#dle-browse-search');
        const statusEl = container.querySelector('#dle-browse-status');
        const tagEl = container.querySelector('#dle-browse-tag');
        if (searchEl) searchEl.value = '';
        if (statusEl) statusEl.value = 'all';
        if (tagEl) tagEl.value = '';
        renderList();
    }

    // Delegation registered once on container — not per render.
    container.addEventListener('click', (e) => {
        const link = e.target.closest('.dle-obsidian-link');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        if (!openExternalProtocol(link.dataset?.obsidianUri)) {
            toastr.warning('Could not open Obsidian link from this browser context.', 'DeepLore Enhanced', { timeOut: 2500 });
        }
    });

    container.addEventListener('click', (e) => {
        // Skip the row-toggle when the click landed in the inline action group.
        if (e.target.closest('[data-no-toggle="1"]')) return;
        const toggle = e.target.closest('.dle-entry-toggle');
        if (!toggle) return;
        const targetId = toggle.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
            targetEl.classList.toggle('dle-hidden');
            toggle.setAttribute('aria-expanded', !targetEl.classList.contains('dle-hidden'));
        }
    });

    // Reset filters (header button + 0-results CTA).
    container.addEventListener('click', (e) => {
        if (e.target.closest('#dle-browse-reset') || e.target.closest('#dle-browse-reset-empty')) {
            e.stopPropagation();
            resetBrowseFilters();
        }
    });

    // Per-row pin / block / copy actions.
    container.addEventListener('click', (e) => {
        const pinBtn = e.target.closest('.dle-browse-row-pin');
        const blockBtn = e.target.closest('.dle-browse-row-block');
        const copyBtn = e.target.closest('.dle-browse-row-copy');
        if (!pinBtn && !blockBtn && !copyBtn) return;
        e.stopPropagation();
        const btn = pinBtn || blockBtn || copyBtn;
        const title = btn.dataset.title;
        if (!title) return;
        if (copyBtn) {
            navigator.clipboard?.writeText(title).then(() => {
                toastr.success(`Copied "${title}"`, 'DeepLore Enhanced', { timeOut: 1200 });
            }).catch(() => { /* clipboard unavailable */ });
            return;
        }
        const vaultSource = btn.dataset.vault || null;
        const tl = title.toLowerCase();
        const matches = (p) => {
            const n = normalizePinBlock(p);
            return n.title.toLowerCase() === tl && (n.vaultSource || null) === (vaultSource || null);
        };
        if (pinBtn) {
            if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
            const idx = chat_metadata.deeplore_pins.findIndex(matches);
            if (idx !== -1) {
                chat_metadata.deeplore_pins.splice(idx, 1);
                toastr.info(`Unpinned: ${title}`, 'DeepLore Enhanced', { timeOut: 1500 });
            } else {
                chat_metadata.deeplore_pins.push({ title, vaultSource });
                if (chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(p => !matches(p));
                toastr.info(`Pinned: ${title}`, 'DeepLore Enhanced', { timeOut: 1500 });
            }
        } else {
            if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
            const idx = chat_metadata.deeplore_blocks.findIndex(matches);
            if (idx !== -1) {
                chat_metadata.deeplore_blocks.splice(idx, 1);
                toastr.info(`Unblocked: ${title}`, 'DeepLore Enhanced', { timeOut: 1500 });
            } else {
                chat_metadata.deeplore_blocks.push({ title, vaultSource });
                if (chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(p => !matches(p));
                toastr.info(`Blocked: ${title}`, 'DeepLore Enhanced', { timeOut: 1500 });
            }
        }
        saveMetadataDebounced();
        notifyPinBlockChanged();
        renderList();
    });

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.dle-whynot-btn');
        if (!btn) return;
        e.stopPropagation();
        const title = btn.dataset.title;
        const entry = vaultIndex.find(en => en.title === title);
        if (!entry) return;
        const result = diagnoseEntry(entry, chat);
        const color = STAGE_COLORS[result.stage] || '#999';
        const suggestions = result.suggestions.length > 0
            ? `<br><span class="dle-text-xs dle-muted">Suggestion: ${escapeHtml(result.suggestions[0])}</span>`
            : '';
        btn.parentElement.innerHTML = `<div class="dle-text-sm dle-diag-result" style="color: ${color};">${escapeHtml(result.detail)}${suggestions}</div>`;
    });

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: async () => {
            renderList();
            // H8: debounce search input to avoid re-rendering on every keystroke.
            let searchTimer = null;
            container.querySelector('#dle-browse-search')?.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(renderList, 150);
            });
            container.querySelector('#dle-browse-status')?.addEventListener('change', renderList);
            container.querySelector('#dle-browse-tag')?.addEventListener('change', renderList);
            container.querySelector('#dle-browse-sort')?.addEventListener('change', renderList);
        },
    });
}

/** Step-by-step replay; skips probability/warmup/cooldown for clean visualisation. */
export function runSimulation(chatMsgs) {
    const settings = getSettings();
    const timeline = [];
    let previousActive = new Set();

    for (let i = 1; i <= chatMsgs.length; i++) {
        const slicedChat = chatMsgs.slice(0, i);
        const scanText = buildScanText(slicedChat, settings.scanDepth);
        const currentActive = new Set();

        for (const entry of vaultIndex) {
            if (entry.constant) currentActive.add(entry.title);
        }

        if (i <= settings.newChatThreshold) {
            for (const entry of vaultIndex) {
                if (entry.bootstrap) currentActive.add(entry.title);
            }
        }

        if (settings.scanDepth > 0) {
            for (const entry of vaultIndex) {
                if (entry.constant) continue;
                const entryText = entry.scanDepth !== null
                    ? buildScanText(slicedChat, entry.scanDepth)
                    : scanText;
                const key = testEntryMatch(entry, entryText, settings);
                if (key) currentActive.add(entry.title);
            }
        }

        const newlyActivated = [...currentActive].filter(t => !previousActive.has(t));
        const deactivated = [...previousActive].filter(t => !currentActive.has(t));

        const msg = chatMsgs[i - 1];
        timeline.push({
            messageIndex: i - 1,
            speaker: msg.is_user ? 'User' : (msg.name || 'AI'),
            active: [...currentActive],
            newlyActivated,
            deactivated,
        });

        previousActive = currentActive;
    }

    return timeline;
}

export function showSimulationPopup(timeline) {
    const plainLines = [`Activation Simulation (${timeline.length} messages)`, ''];
    for (const step of timeline) {
        let line = `#${step.messageIndex + 1} ${step.speaker} (${step.active.length} active)`;
        if (step.newlyActivated.length > 0) line += `  + ${step.newlyActivated.join(', ')}`;
        if (step.deactivated.length > 0) line += `  - ${step.deactivated.join(', ')}`;
        plainLines.push(line);
    }
    const plainText = plainLines.join('\n');

    let html = '<div class="dle-popup">';
    html += `<h3>Activation Simulation (${timeline.length} messages)</h3>`;
    html += '<p class="dle-text-xs dle-muted dle-mb-2">Note: This simulation uses keyword matching only. AI search, gating filters, cooldown/warmup timers, probability, and pin/block overrides are not included. Actual injection results during generation may differ.</p>';
    html += buildCopyButton(plainText);
    html += '<div class="dle-scroll-region">';

    for (const step of timeline) {
        const hasChanges = step.newlyActivated.length > 0 || step.deactivated.length > 0;

        html += `<div class="dle-text-sm dle-sim-step${hasChanges ? ' dle-sim-step--changed' : ''}">`;
        html += `<strong>#${step.messageIndex + 1} ${escapeHtml(step.speaker)}</strong>`;
        html += ` <span class="dle-text-xs dle-faint">(${step.active.length} active)</span>`;

        if (step.newlyActivated.length > 0) {
            html += `<br><span class="dle-success">+ ${step.newlyActivated.map(t => escapeHtml(t)).join(', ')}</span>`;
        }
        if (step.deactivated.length > 0) {
            html += `<br><span class="dle-error">- ${step.deactivated.map(t => escapeHtml(t)).join(', ')}</span>`;
        }
        html += '</div>';
    }

    html += '</div></div>';
    callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true,
        onOpen: () => attachCopyHandler(document.querySelector('.popup')),
    });
}

// ── Optimize Keys ──

export const DEFAULT_OPTIMIZE_KEYS_PROMPT = `You are a keyword optimization assistant for a lorebook system. Given an entry's title, content, and current keywords, suggest improved keywords that will trigger this entry when relevant topics come up in conversation.

Guidelines:
- Include the entry title and common aliases
- Add thematic keywords (topics, events, emotions this entry relates to)
- For keyword-only mode: be precise, avoid overly generic terms
- For two-stage mode: be broader since AI will filter later
- Return 3-10 keywords, ordered by importance

Respond with a JSON object: {"suggested": ["keyword1", "keyword2", ...], "reasoning": "Brief explanation of changes"}`;

export async function optimizeEntryKeys(entry) {
    const settings = getSettings();
    const mode = settings.optimizeKeysMode;
    const modeHint = mode === 'keyword-only'
        ? 'This system uses KEYWORD-ONLY matching (no AI filter). Be precise — avoid generic words.'
        : 'This system uses TWO-STAGE matching (keywords → AI filter). Be broader — the AI will refine.';

    const systemPrompt = settings.optimizeKeysPrompt?.trim() || DEFAULT_OPTIMIZE_KEYS_PROMPT;
    const userMessage = `Mode: ${modeHint}\n\nTitle: ${entry.title}\nCurrent keywords: ${entry.keys.join(', ')}\nContent:\n${entry.content.substring(0, 1500)}\n\nSuggest optimized keywords as JSON.`;

    const result = await callAutoSuggest(systemPrompt, userMessage, 'optimizeKeys');
    const parsed = extractAiResponseClient(result.text);

    if (parsed && parsed.suggested && Array.isArray(parsed.suggested)) {
        return { suggested: parsed.suggested, reasoning: parsed.reasoning || '' };
    }
    if (Array.isArray(parsed)) {
        return { suggested: parsed.map(String), reasoning: '' };
    }
    return null;
}

export async function showOptimizePopup(entry, result) {
    if (!result) {
        toastr.warning('Could not get keyword suggestions.', 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const html = `
        <div class="dle-popup">
            <h3>Optimize Keywords: ${escapeHtml(entry.title)}</h3>
            <div class="dle-optimize-columns">
                <div class="dle-optimize-col">
                    <h4>Current Keywords</h4>
                    <ul>${entry.keys.map(k => `<li>${escapeHtml(k)}</li>`).join('') || '<li><em>none</em></li>'}</ul>
                </div>
                <div class="dle-optimize-col">
                    <h4>Suggested Keywords</h4>
                    <ul>${result.suggested.map(k => `<li>${escapeHtml(k)}</li>`).join('')}</ul>
                </div>
            </div>
            ${result.reasoning ? `<p class="dle-muted dle-text-sm"><strong>Reasoning:</strong> ${escapeHtml(result.reasoning)}</p>` : ''}
        </div>
    `;

    const accept = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        okButton: 'Accept & Write',
        cancelButton: 'Cancel',
    });

    if (accept) {
        try {
            const optVault = getVaultByName(settings, entry.vaultSource);
            // Re-fetch from Obsidian — _rawContent caching was removed to save memory.
            let rawContent = entry.content;
            try {
                const fetchResult = await obsidianFetch({ host: optVault.host, port: optVault.port, apiKey: optVault.apiKey, path: `/vault/${encodeVaultPath(entry.filename)}`, accept: 'text/markdown' });
                if (fetchResult.status === 200) rawContent = fetchResult.data;
            } catch { /* fall back to entry.content */ }
            const { frontmatter, body } = parseFrontmatter(rawContent);
            const newKeys = result.suggested;
            const keysYaml = newKeys.map(k => `  - ${yamlSerializeValue(k)}`).join('\n');

            let newContent = '---\n';
            for (const [key, val] of Object.entries(frontmatter)) {
                if (key === 'keys') {
                    newContent += `keys:\n${keysYaml}\n`;
                } else if (Array.isArray(val)) {
                    newContent += `${key}:\n${val.map(v => `  - ${yamlSerializeValue(v)}`).join('\n')}\n`;
                } else {
                    newContent += `${key}: ${yamlSerializeValue(val)}\n`;
                }
            }
            if (!frontmatter.keys) {
                newContent += `keys:\n${keysYaml}\n`;
            }
            newContent += `---\n${body}`;

            const data = await writeNote(optVault.host, optVault.port, optVault.apiKey, entry.filename, newContent, !!optVault.https);
            if (data.ok) {
                toastr.success(`Keywords updated for "${entry.title}"`, 'DeepLore Enhanced');
                setVaultIndex([]);
                setIndexTimestamp(0);
                await buildIndex();
            } else {
                console.warn('[DLE] Optimize keys write failed:', data && data.error);
                toastr.error('Couldn\'t save the new keywords to your vault.', 'DeepLore Enhanced');
            }
        } catch (err) {
            toastr.error(classifyError(err), 'DeepLore Enhanced');
        }
    }
}
