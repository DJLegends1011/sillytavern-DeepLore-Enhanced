/** DeepLore Enhanced — Context Cartographer */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { buildCopyButton, attachCopyHandler } from './popups.js';
import { chat, getCurrentChatId } from '../../../../../../script.js';
import { simpleHash } from '../../core/utils.js';
import { getSettings } from '../../settings.js';
import { vaultIndex, vaultAvgTokens, chatInjectionCounts, trackerKey } from '../state.js';
import {
    getCurrentForChat as getCurrentVerdictForChat,
    getByMessageSync as getVerdictByMessageSync,
    getPreviousForMessage as getVerdictPreviousForMessage,
} from '../verdict/verdict-store.js';
import { diffVerdicts } from '../verdict/verdict-pure.js';
import { diagnoseEntry } from './diagnostics.js';
import { STAGE_COLORS, categorizeRejections, resolveEntryVault, parseMatchReason, tokenBarColor, formatRelativeTime, comparePriority, openObsidianUri } from '../helpers.js';
import { navigateToBrowseEntry } from '../drawer/drawer.js';
/**
 * No-op kept for backward compatibility with CHAT_CHANGED handler. Verdict store
 * already wipes per-chat in-memory state on chat switch via clearVerdictRing
 * (with per-chat IDB rows separately reachable via clearVerdictChatIdb) — no
 * separate cartographer-local state to reset.
 */
export function resetCartographer() {
    // Intentionally empty: previousSources global is gone; verdict-store ring buffer
    // is the single source of truth (resolved per-msgIdx by showSourcesPopup).
}

export function injectSourcesButton(messageId) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    if (mesEl.length === 0) return;
    if (mesEl.find('.mes_deeplore_sources').length > 0) return;

    const btn = $('<div title="Why? — See which lore was injected" class="mes_button mes_deeplore_sources fa-solid fa-book-open" role="button" tabindex="0" aria-label="Why? — See which lore was injected"></div>');
    mesEl.find('.extraMesButtons').prepend(btn);
}

function formatMatchReason(matchedBy) {
    if (!matchedBy) return '';
    const { type, keyword } = parseMatchReason(matchedBy);
    const labels = {
        constant: '(Constant)', pinned: '(Pinned)', bootstrap: '(Bootstrap)',
        seed: '(Seed)', ai: '(AI)', unknown: '',
    };
    if (type === 'keyword_ai' || type === 'keyword') return `(Keyword: ${escapeHtml(keyword)})`;
    return labels[type] || '';
}

/**
 * @param {Array<{title: string, filename: string, matchedBy: string, priority: number, tokens: number}>} sources
 * @param {{ aiNotes?: string, msgIdx?: number }} [opts]
 *   `msgIdx`: when the popup is opened for a specific message (e.g. the per-message "Why?"
 *   button), pass `chat.length`-style index for that message. The popup resolves the matching
 *   verdict (and its predecessor) via the verdict store so the "added/removed" diff stays
 *   correct for historical messages — not just the live newest one. Omit for previews where
 *   `sources` is synthesized outside the pipeline.
 */
export function showSourcesPopup(sources, opts = {}) {
    const settings = getSettings();
    const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
    const maxTokens = Math.max(...sources.map(s => s.tokens), 1);
    const avgTokens = vaultAvgTokens || 0;
    const positionLabels = { 0: 'After Main Prompt', 1: 'In-chat', 2: 'Before Main Prompt' };

    // Keyed by trackerKey (vaultSource:title) so same-title entries across vaults don't collide.
    // Title-only fallback for callers whose input has no vaultSource (e.g. trace data) —
    // first-match is correct here.
    const entryByTrackerKey = new Map(vaultIndex.map(e => [trackerKey(e), e]));
    const findByTitle = (title) => vaultIndex.find(e => e.title === title);
    const resolveEntry = (title, vaultSource) => (vaultSource ? entryByTrackerKey.get(`${vaultSource}:${title}`) : null) || findByTitle(title);
    const groups = new Map();
    for (const src of sources) {
        const entry = resolveEntry(src.title, src.vaultSource);
        const pos = entry?.injectionPosition ?? settings.injectionPosition;
        const depth = entry?.injectionDepth ?? settings.injectionDepth;
        const posKey = pos === 1 ? `In-chat @depth ${depth}` : (positionLabels[pos] || 'Unknown');
        if (!groups.has(posKey)) groups.set(posKey, []);
        groups.get(posKey).push({ ...src, entry });
    }

    // Diff "current vs previous turn" from the verdict ring buffer. When the caller passes
    // `opts.msgIdx` (per-message "Why?" button on a specific message), we resolve the verdict
    // for THAT message + its predecessor so the diff stays correct for historical messages.
    // Without msgIdx (preview / generic drawer expand), fall back to the chat-scoped newest
    // verdict and its predecessor.
    //
    // Bug history: an earlier fallback path passed `{ injectedSources: sources }` as `current`
    // and the live newest verdict as `previous`, which inverted the diff for any message that
    // wasn't the live one (e.g. clicking "Why?" on an older message, or after page reload
    // when `sources` came from `message.extra.deeplore_sources`). Threading msgIdx through
    // caller + resolving via the verdict-store API restores the correct direction.
    const _chatId = (() => { try { return getCurrentChatId() ?? null; } catch { return null; } })();
    const _resolvedMsgIdx = typeof opts.msgIdx === 'number' ? opts.msgIdx : null;
    const _currentVerdict = _resolvedMsgIdx != null
        ? (getVerdictByMessageSync(_resolvedMsgIdx, _chatId) || { injectedSources: sources })
        : (getCurrentVerdictForChat(_chatId) || { injectedSources: sources });
    const _previousVerdict = _resolvedMsgIdx != null
        ? getVerdictPreviousForMessage(_resolvedMsgIdx, _chatId)
        : getVerdictPreviousForMessage(getCurrentVerdictForChat(_chatId)?.msgIdx ?? Number.MAX_SAFE_INTEGER, _chatId);
    const diff = diffVerdicts(_currentVerdict, _previousVerdict);

    const plainLines = [`Injected Sources (${sources.length} entries, ~${totalTokens} tokens)`, '', 'Entry\tTokens\tMatched By\tFolder\tChat×\tAll-time Inj\tAll-time Match\tLast Used'];
    for (const src of sources) {
        const ek = src.entry ? trackerKey(src.entry) : `${src.vaultSource || ''}:${src.title}`;
        const cc = chatInjectionCounts.get(ek) || 0;
        const at = settings.analyticsData?.[ek];
        const folder = resolveEntry(src.title, src.vaultSource)?.folderPath || '';
        plainLines.push(`${src.title}\t${src.tokens}\t${src.matchedBy}\t${folder}\t${cc}\t${at?.injected || 0}\t${at?.matched || 0}\t${at?.lastTriggered ? new Date(at.lastTriggered).toLocaleString() : 'Never'}`);
    }

    // Per-render regex cache: large vaults share matchedBy keywords across hundreds
    // of entries — without this, identical RegExp objects rebuild repeatedly.
    /** @type {Map<string, RegExp>} */
    const _highlightRegexCache = new Map();
    function _highlightRegexFor(keyword) {
        if (_highlightRegexCache.has(keyword)) return _highlightRegexCache.get(keyword);
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(${escaped})`, 'gi');
        _highlightRegexCache.set(keyword, re);
        return re;
    }

    let html = `<div class="dle-popup">`;
    html += buildCopyButton(plainLines.join('\n'));
    html += `<h3>Why? — Injected Sources (${sources.length} entries, ~${totalTokens} tokens)</h3>`;

    if (diff.added.length > 0 || diff.removed.length > 0) {
        html += `<div class="dle-card dle-text-sm">`;
        if (diff.added.length > 0) {
            const addedLabels = diff.added.map(s => `${escapeHtml(s.title)} ${formatMatchReason(s.matchedBy)}`);
            html += `<span class="dle-success">+${diff.added.length} new:</span> <span class="dle-muted">${addedLabels.join(', ')}</span><br>`;
        }
        if (diff.removed.length > 0) {
            const removedLabels = diff.removed.map(s => `${escapeHtml(s.title)} (${s.removalReason})`);
            html += `<span class="dle-error">-${diff.removed.length} removed:</span> <span class="dle-muted">${removedLabels.join(', ')}</span>`;
        }
        html += `</div>`;
    }

    for (const [posLabel, groupSources] of groups) {
        // #16: settings.priorityReversed flips. Default lower-is-higher.
        groupSources.sort((a, b) => comparePriority(a, b, settings.priorityReversed));

        const groupTokens = groupSources.reduce((sum, s) => sum + s.tokens, 0);
        html += `<h4 class="dle-carto-heading">${escapeHtml(posLabel)} (~${groupTokens} tokens)</h4>`;

        for (const src of groupSources) {
            const pct = Math.max(2, Math.round((src.tokens / maxTokens) * 100));
            const barColor = tokenBarColor(src.tokens, avgTokens);
            const { uri } = resolveEntryVault(src, settings.vaults);
            // gotcha #83 (P3-8): use the shared .dle-obsidian-link class + rel + the delegated
            // openObsidianUri handler (wired below) so the obsidian:// click launches via a hidden
            // iframe instead of navigating the ST top frame. target/rel are the markup safety net.
            const titleHtml = uri
                ? `<a href="${escapeHtml(uri)}" target="_blank" rel="noopener noreferrer" class="dle-carto-obsidian-link dle-obsidian-link">${escapeHtml(src.title)}</a>`
                : escapeHtml(src.title);
            const entryId = simpleHash(src.filename + '_ctx');
            const rawPreview = src.entry ? src.entry.content.substring(0, 300) + (src.entry.content.length > 300 ? '...' : '') : '';

            html += `<div class="dle-card">`;
            html += `<div class="dle-ctx-toggle dle-card-header" data-target="dle-ctx-${entryId}" aria-expanded="false" role="button" tabindex="0">`;
            html += `<span><strong>${titleHtml}</strong> <span class="dle-text-xs dle-faint">pri ${src.priority}</span>`;
            html += ` <button type="button" class="dle-carto-browse-btn" data-browse-title="${escapeHtml(src.title)}" data-browse-vault="${escapeHtml(src.vaultSource || '')}" title="Show in Browse"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button></span>`;
            html += `<span class="dle-text-xs" style="color: ${barColor};">~${src.tokens} tok</span>`;
            html += `</div>`;
            html += `<div class="dle-carto-token-bar">`;
            html += `<div class="dle-carto-token-bar-fill" style="background: ${barColor}; width: ${pct}%;"></div>`;
            html += `</div>`;
            const vaultLabel = src.vaultSource && (settings.vaults || []).length > 1 ? ` · <em>${escapeHtml(src.vaultSource)}</em>` : '';
            const folderLabel = src.entry?.folderPath ? ` · <span class="dle-entry-folder">${escapeHtml(src.entry.folderPath)}</span>` : '';
            html += `<span class="dle-text-xs dle-muted">${escapeHtml(src.matchedBy)}${vaultLabel}${folderLabel}</span>`;

            const entryKey = src.entry ? trackerKey(src.entry) : `${src.vaultSource || ''}:${src.title}`;
            const chatCount = chatInjectionCounts.get(entryKey) || 0;
            const allTime = settings.analyticsData?.[entryKey];
            const statParts = [];
            if (chatCount > 0) statParts.push(`This chat: ${chatCount}×`);
            if (allTime) {
                statParts.push(`All-time: ${allTime.injected || 0} injected / ${allTime.matched || 0} matched`);
                const lastUsed = formatRelativeTime(allTime.lastTriggered);
                if (lastUsed) statParts.push(`Last: ${lastUsed}`);
            }
            if (statParts.length > 0) {
                html += `<div class="dle-carto-stats dle-text-xs">${statParts.join(' · ')}</div>`;
            }

            if (src.entry) {
                const meta = [];
                if (src.entry.keys?.length > 0) meta.push(`Keys: ${src.entry.keys.slice(0, 5).join(', ')}${src.entry.keys.length > 5 ? '...' : ''}`);
                if (src.entry.requires?.length > 0) meta.push(`Requires: ${src.entry.requires.join(', ')}`);
                if (src.entry.customFields) {
                    for (const [key, val] of Object.entries(src.entry.customFields)) {
                        if (val != null && val !== '' && (!Array.isArray(val) || val.length > 0)) {
                            const display = Array.isArray(val) ? val.join(', ') : String(val);
                            meta.push(`${key}: ${display}`);
                        }
                    }
                }
                if (src.entry.resolvedLinks?.length > 0) meta.push(`Links: ${src.entry.resolvedLinks.slice(0, 5).join(', ')}`);

                // Run regex on raw text BEFORE escaping to avoid matching inside HTML entities;
                // use \x00 placeholders that survive escapeHtml, then swap to <mark> tags after.
                let highlighted = rawPreview;
                if (src.matchedBy && !src.matchedBy.startsWith('(')) {
                    const keyword = src.matchedBy.split('→')[0].trim();
                    if (keyword.length >= 2) {
                        highlighted = highlighted.replace(_highlightRegexFor(keyword), '\x00MARK_START\x00$1\x00MARK_END\x00');
                    }
                }
                highlighted = escapeHtml(highlighted)
                    .replace(/\x00MARK_START\x00/g, '<mark class="dle-highlight">')
                    .replace(/\x00MARK_END\x00/g, '</mark>');

                html += `<div id="dle-ctx-${entryId}" class="dle-ctx-detail">`;
                if (meta.length > 0) {
                    html += `<div class="dle-text-xs dle-faint dle-mb-1">${meta.map(m => escapeHtml(m)).join(' · ')}</div>`;
                }
                html += `<div class="dle-preview">${highlighted}</div>`;
                html += `</div>`;
            }
            html += `</div>`;
        }
    }

    // ── Rejected Entries (staged breakdown) ──
    // Trace comes from the SAME verdict we just diffed — keeps rejected-entries view
    // consistent with the injected-entries view when inspecting historical messages.
    const _cartoTrace = _currentVerdict?.trace ?? null;
    if (_cartoTrace && chat && chat.length > 0) {
        // BUG-AUDIT v2.5: trackerKey-shape keys so same-titled cross-vault entries don't collide.
        const injectedKeys = new Set(sources.map(s => `${s.vaultSource || ''}:${(s.title || '').toLowerCase()}`));
        const rejectedGroups = categorizeRejections(_cartoTrace, injectedKeys);

        if (rejectedGroups.length > 0) {
            const totalRejected = rejectedGroups.reduce((sum, g) => sum + g.entries.length, 0);
            html += `<hr class="dle-my-3" style="border-color: var(--dle-border);">`;
            html += `<h4 class="dle-carto-heading" style="color: var(--dle-text-muted);">Not Injected (${totalRejected} entries)</h4>`;

            for (const group of rejectedGroups) {
                const groupId = simpleHash(`rejected_${group.label}`);
                html += `<div class="dle-card dle-carto-rejected">`;
                html += `<div class="dle-ctx-toggle dle-card-header" data-target="dle-rej-${groupId}" aria-expanded="false" role="button" tabindex="0">`;
                html += `<span><i class="fa-solid ${group.icon} dle-text-muted" style="margin-right: 6px;"></i><strong>${escapeHtml(group.label)}</strong> <span class="dle-text-xs dle-faint">(${group.entries.length})</span></span>`;
                html += `<span class="dle-text-xs dle-faint">click to expand</span>`;
                html += `</div>`;
                html += `<div id="dle-rej-${groupId}" class="dle-ctx-detail">`;

                for (const e of group.entries) {
                    // Trace entries carry no vaultSource — falls back to first title match.
                    const entry = resolveEntry(e.title, e.vaultSource);
                    const whynotId = simpleHash(`whynot_${e.title}`);
                    html += `<div class="dle-carto-entry-row">`;
                    html += `<span class="dle-text-sm">${escapeHtml(e.title)} <button type="button" class="dle-carto-browse-btn" data-browse-title="${escapeHtml(e.title)}" data-browse-vault="${escapeHtml(e.vaultSource || '')}" title="Show in Browse"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button></span>`;
                    if (entry && !entry.constant) {
                        // Audit Q27 (S9-3): carry data-vault through to the whynot handler so
                        // multi-vault same-title entries resolve to the correct entry (gotcha #4).
                        html += ` <button type="button" class="menu_button dle-carto-whynot-btn dle-text-xs" data-title="${escapeHtml(e.title)}" data-vault="${escapeHtml(e.vaultSource || '')}" data-container="dle-whynot-carto-${whynotId}">Why?</button>`;
                        html += `<div id="dle-whynot-carto-${whynotId}"></div>`;
                    }
                    const rejKey = entry ? trackerKey(entry) : `${e.vaultSource || ''}:${e.title}`;
                    const rejAllTime = settings.analyticsData?.[rejKey];
                    if (rejAllTime) {
                        const lastUsed = formatRelativeTime(rejAllTime.lastTriggered);
                        html += `<div class="dle-carto-stats dle-text-xs">${rejAllTime.injected || 0} injected / ${rejAllTime.matched || 0} matched${lastUsed ? ` · Last: ${lastUsed}` : ''}</div>`;
                    }
                    html += `</div>`;
                }

                html += `</div></div>`;
            }
        }
    }

    const anyVaultNamed = settings.vaults && settings.vaults.some(v => v.name);
    html += anyVaultNamed
        ? '<p class="dle-faint dle-text-xs dle-mt-2">Click entry names to open in Obsidian. Click entries to expand content preview.</p>'
        : '<p class="dle-faint dle-text-xs dle-mt-2">Set vault names in Vault Connections to enable deep links.</p>';

    if (opts.aiNotes) {
        html += `<div class="dle-card dle-mt-2">
            <h4><i class="fa-solid fa-robot" style="margin-right: 4px;"></i>AI Notes (this message)</h4>
            <pre class="dle-text-sm dle-preview">${escapeHtml(opts.aiNotes)}</pre>
        </div>`;
    }

    html += '</div>';

    const container = document.createElement('div');
    container.innerHTML = html;

    // BUG-186: mouse + keyboard activation.
    const _toggleCard = (toggle) => {
        const targetId = toggle.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
            targetEl.classList.toggle('dle-ctx-expanded');
            toggle.setAttribute('aria-expanded', targetEl.classList.contains('dle-ctx-expanded'));
        }
    };
    container.addEventListener('click', (e) => {
        const toggle = e.target.closest('.dle-ctx-toggle');
        if (!toggle) return;
        _toggleCard(toggle);
    });
    container.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const toggle = e.target.closest('.dle-ctx-toggle');
        if (!toggle) return;
        e.preventDefault();
        _toggleCard(toggle);
    });

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.dle-carto-whynot-btn');
        if (!btn) return;
        e.stopPropagation();
        const title = btn.dataset.title;
        const vault = btn.dataset.vault || null;
        const containerId = btn.dataset.container;
        // Audit Q27 (S9-3): resolve via trackerKey when vaultSource is known, fall back
        // to first title match for legacy trace entries that don't carry vaultSource.
        const entry = (vault && entryByTrackerKey.get(`${vault}:${title}`))
            || vaultIndex.find(en => en.title === title);
        if (!entry || !chat || chat.length === 0) return;
        const result = diagnoseEntry(entry, chat);
        const color = STAGE_COLORS[result.stage] || 'var(--dle-text-muted)';
        const suggestions = result.suggestions.length > 0
            ? `<br><span class="dle-text-xs dle-muted">Suggestion: ${escapeHtml(result.suggestions[0])}</span>`
            : '';
        const targetEl = document.getElementById(containerId);
        if (targetEl) {
            targetEl.innerHTML = `<div class="dle-text-sm dle-diag-result" style="color: ${color};">${escapeHtml(result.detail)}${suggestions}</div>`;
        }
        btn.remove();
    });

    container.addEventListener('click', (e) => {
        const browseBtn = e.target.closest('.dle-carto-browse-btn');
        if (!browseBtn) return;
        e.stopPropagation();
        const title = browseBtn.dataset.browseTitle;
        if (title) {
            // P3-9 (gotcha #50): thread vaultSource so cross-vault same-title nav opens the RIGHT row.
            const vaultSource = browseBtn.dataset.browseVault || '';
            navigateToBrowseEntry({ title, vaultSource });
            document.querySelector('.popup .popup_ok')?.click();
        }
    });

    // gotcha #83 (P3-8): delegated handler so the obsidian:// title link launches via a hidden
    // iframe (openObsidianUri) instead of navigating the ST top frame. Mirrors the drawer pattern.
    container.addEventListener('click', (e) => {
        const link = e.target.closest('.dle-obsidian-link');
        if (!link) return;
        e.preventDefault();
        openObsidianUri(link.getAttribute('href'));
    });

    callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true,
        onOpen: () => attachCopyHandler(document.querySelector('.popup')),
    });
}
