import { chat_metadata, saveSettingsDebounced } from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { accountStorage } from '../../../../../util/AccountStorage.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings, invalidateSettingsCache } from '../../settings.js';
import {
    vaultIndex, indexTimestamp, indexEverLoaded,
    aiSearchStats, lastInjectionSources,
    generationLock, indexing,
    notifyGatingChanged, notifyPinBlockChanged,
    fieldDefinitions, folderList,
    loreGaps,
    resetAiSearchCache, setLastInjectionSources,
    aiSearchCache, lastGenerationTrackerSnapshot,
    generationCount, chatEpoch,
    suppressNextAgenticLoop, setSuppressNextAgenticLoop,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { normalizePinBlock, buildObsidianURI, buildObsidianAnchorHtml, openExternalProtocol } from '../helpers.js';
import { buildIndex } from '../vault/vault.js';
import { openRuleBuilder } from '../ui/rule-builder.js';
import {
    ds, TAB_LABELS, TOOL_ACTIONS, EXPAND_ACTIONS, BROWSE_ROW_HEIGHT,
    scheduleRender, announceToScreenReader,
} from './drawer-state.js';
import { renderInjectionTab, renderBrowseTab, renderBrowseWindow, renderStatusZone } from './drawer-render.js';
import { renderLibrarianTab } from './drawer-render-librarian.js';
import { hideGap, dismissGap, getHiddenGapIds, persistGaps } from '../librarian/librarian-tools.js';
import { dedupError } from '../toast-dedup.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Shortcut keys (d, Delete, Backspace) must not fire while the user is editing.
 * INPUT/TEXTAREA/SELECT alone misses contenteditable surfaces (rich-text notebook,
 * CKEditor) — those keys would stomp the drawer selection instead of the text.
 * @param {Element|null} el
 */
function _isSafeShortcutTarget(el) {
    if (!el) return true;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return false;
    if (el.isContentEditable) return false;
    // isContentEditable already covers inheritance; closest() check is belt-and-braces.
    try { if (el.closest && el.closest('[contenteditable="true"]')) return false; } catch { /* ignore selector errors */ }
    return true;
}

export function updateFilterActiveIndicators($drawer) {
    $drawer.find('.dle-browse-filter-select').each(function () {
        const $sel = $(this);
        const isDefault = $sel.val() === '' || $sel.val() === 'all';
        $sel.toggleClass('dle-filter-active', !isDefault);
    });
}

function executeCommand(cmd) {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(cmd).catch(err => {
            console.error('[DLE] Command error:', cmd, err);
            dedupError('A drawer command failed. Check the browser console for details.', 'drawer_cmd_error');
        });
    } else {
        console.warn('[DLE] Cannot execute command — SillyTavern.getContext() unavailable');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Tab Switching
// ════════════════════════════════════════════════════════════════════════════

export function switchTab($drawer, tabName) {
    const $tabs = $drawer.find('.dle-tab');
    const $panels = $drawer.find('.dle-tab-panel');
    const $label = $drawer.find('.dle-tab-label');

    // Roving tabindex: only the active tab is in the tab order.
    $tabs.each(function () {
        const $t = $(this);
        const isActive = $t.data('tab') === tabName;
        $t.toggleClass('active', isActive)
            .attr('aria-selected', isActive ? 'true' : 'false')
            .attr('tabindex', isActive ? '0' : '-1');
    });

    $panels.each(function () {
        const $p = $(this);
        const isActive = $p.data('tab') === tabName;
        $p.toggleClass('active', isActive);
    });

    $label.text(TAB_LABELS[tabName] || tabName);

    if (ds.browseScrollRAF) {
        cancelAnimationFrame(ds.browseScrollRAF);
        ds.browseScrollRAF = null;
    }

    // Librarian sub-tab selection is intentionally not preserved across visits.
    if (tabName === 'librarian') {
        ds.librarianFilter = 'flag';
        scheduleRender(renderLibrarianTab);
    }

    if (tabName === 'browse') {
        ds.browseLastRangeStart = -1;
        ds.browseLastRangeEnd = -1;
        ds._browseLastScrollTop = undefined;
        // BUG-FIX-5: renderBrowseTab() populates ds.browseFilteredEntries; defer
        // renderBrowseWindow() via rAF until the panel's .active class has painted —
        // otherwise the visibility guard (!offsetParent && !offsetHeight) early-returns
        // on a still-hidden panel.
        renderBrowseTab();
        requestAnimationFrame(() => renderBrowseWindow());
    }

    // BUG-042: accountStorage syncs across browsers; localStorage fallback for migration grace period.
    try { accountStorage.setItem('dle-last-drawer-tab', tabName); } catch { /* noop */ }
}

// ════════════════════════════════════════════════════════════════════════════
// Wire Functions (one-time event binding)
// ════════════════════════════════════════════════════════════════════════════

export function wireToolsTab($drawer) {
    // BUG-354: Delegate from $drawer (not #dle-panel-tools) so binding survives container replacement.
    $drawer.on('click', '#dle-panel-tools .dle-tool-btn[data-action]', function () {
        const action = $(this).data('action');
        const cmd = TOOL_ACTIONS[action];
        if (!cmd) return;
        // BUG-359: gate on generation lock, indexing, or master-disabled.
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.warning('DeepLore Enhanced is disabled.', 'DeepLore Enhanced', { timeOut: 2500 });
            return;
        }
        if (generationLock) {
            toastr.warning('Cannot run tools during lore selection.', 'DeepLore Enhanced', { timeOut: 2500 });
            return;
        }
        if (indexing) {
            toastr.warning('Cannot run tools while indexing.', 'DeepLore Enhanced', { timeOut: 2500 });
            return;
        }
        executeCommand(cmd);
    });

    $drawer.on('keydown', '#dle-panel-tools .dle-tool-btn[data-action]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });
}

export function wireTabExpand($drawer) {
    $drawer.on('click', '[data-expand]', async function () {
        try {
            const target = $(this).data('expand');
            // Why tab "Full View" → Context Cartographer popup (no API call).
            if (target === 'injection') {
                const { lastInjectionSources } = await import('../state.js');
                let sources = lastInjectionSources;
                // lastInjectionSources gets cleared after render — fall back to the last AI message.
                if (!sources || sources.length === 0) {
                    const { chat } = await import('../../../../../../script.js');
                    if (chat) {
                        for (let i = chat.length - 1; i >= 0; i--) {
                            if (!chat[i].is_user && chat[i].extra?.deeplore_sources?.length > 0) {
                                sources = chat[i].extra.deeplore_sources;
                                break;
                            }
                        }
                    }
                }
                if (sources && sources.length > 0) {
                    const { showSourcesPopup } = await import('../ui/cartographer.js');
                    showSourcesPopup(sources);
                } else {
                    toastr.info('No lore sources from the last generation. Send a message first.', 'DeepLore Enhanced', { timeOut: 3000 });
                }
                return;
            }
            const cmd = EXPAND_ACTIONS[target];
            if (cmd) executeCommand(cmd);
        } catch (err) {
            console.error('[DLE] Tab expand error:', err);
            toastr.error('Failed to expand tab view.', 'DeepLore Enhanced');
        }
    });
}

export function wireStatusActions($drawer) {
    $drawer.on('click', '.dle-action-btn[data-action]', function () {
        const action = $(this).data('action');
        switch (action) {
            case 'refresh': {
                if (ds.refreshing) return;
                ds.refreshing = true;
                const $refreshBtn = $(this);
                $refreshBtn.prop('disabled', true).find('i').removeClass('fa-sync').addClass('fa-spin fa-spinner');
                buildIndex().catch(err => {
                    // Manual refresh is user-initiated; surface failure rather than silently letting the status bar stay stale.
                    console.warn('[DLE] Manual refresh failed:', err?.message);
                    try {
                        toastr.error(
                            `Vault refresh failed: ${err?.message || 'unknown error'}.`,
                            'DeepLore Enhanced',
                            { timeOut: 10000 },
                        );
                    } catch { /* toastr unavailable */ }
                }).finally(() => {
                    ds.refreshing = false;
                    $refreshBtn.prop('disabled', false).find('i').removeClass('fa-spin fa-spinner').addClass('fa-sync');
                });
                break;
            }
            case 'scribe': {
                if (generationLock) { toastr.warning('Generation in progress.', 'DeepLore Enhanced', { timeOut: 2000 }); return; }
                const $scribeBtn = $(this);
                $scribeBtn.prop('disabled', true).find('i').addClass('fa-spin');
                setTimeout(() => {
                    if ($scribeBtn.prop('disabled')) {
                        $scribeBtn.prop('disabled', false).find('i').removeClass('fa-spin');
                        toastr.warning('Scribe still running or did not return — try again if needed.', 'DeepLore Enhanced', { timeOut: 4000 });
                        announceToScreenReader('Scribe timed out.');
                    }
                }, 15000);
                executeCommand('/dle-scribe');
                break;
            }
            case 'newlore': executeCommand('/dle-newlore'); break;
            case 'librarian-chat': executeCommand('/dle-librarian'); break;
            case 'graph': executeCommand('/dle-graph'); break;
            case 'clear-picks': {
                if (generationLock) {
                    toastr.warning('Cannot clear AI picks during generation — wait for it to finish.', 'DeepLore Enhanced', { timeOut: 2500 });
                    return;
                }
                const settings = getSettings();
                if (settings.debugMode) {
                    const snap = lastGenerationTrackerSnapshot;
                    const log = chat_metadata.deeplore_injection_log;
                    console.debug('[DLE][DIAG] clear-picks-start', {
                        aiCache: {
                            hashEmpty: !aiSearchCache.hash,
                            manifestHashEmpty: !aiSearchCache.manifestHash,
                            resultCount: aiSearchCache.results?.length ?? 0,
                            resultTitles: aiSearchCache.results?.map(r => r.title) ?? [],
                        },
                        injectionLog: {
                            exists: !!log,
                            length: log?.length ?? 0,
                            entries: log?.map(e => ({ gen: e.gen, titles: e.entries?.map(x => x.title) })) ?? [],
                        },
                        snapshot: snap ? {
                            swipeKey: snap.swipeKey,
                            generationCount: snap.generationCount,
                            cooldownSize: snap.cooldown?.size ?? 0,
                            decaySize: snap.decay?.size ?? 0,
                            consecutiveSize: snap.consecutive?.size ?? 0,
                            historySize: snap.injectionHistory?.size ?? 0,
                        } : null,
                        lastInjectionSources: lastInjectionSources ? 'set' : 'null',
                        generationCount,
                        chatEpoch,
                    });
                }
                resetAiSearchCache();
                setLastInjectionSources(null);
                // BUG-396: clear injection log too, so strip-dedup doesn't remove entries that were in deleted/regenerated messages.
                if (chat_metadata.deeplore_injection_log) {
                    chat_metadata.deeplore_injection_log = [];
                    saveMetadataDebounced();
                }
                if (settings.debugMode) {
                    console.debug('[DLE][DIAG] clear-picks-done', {
                        logAfterClear: chat_metadata.deeplore_injection_log,
                        cacheAfterClear: { hashEmpty: !aiSearchCache.hash, resultCount: aiSearchCache.results?.length ?? 0 },
                    });
                }
                announceToScreenReader('Search cache cleared — next generation will re-select lore.');
                toastr.info('Search cache cleared — next generation will re-select lore.', 'DeepLore');
                break;
            }
            case 'skip-tools': {
                const newVal = !suppressNextAgenticLoop;
                setSuppressNextAgenticLoop(newVal);
                $(this).toggleClass('dle-toggle-active', newVal);
                toastr.info(newVal ? 'Librarian tools will be skipped for the next generation.' : 'Librarian tools re-enabled.', 'DeepLore');
                break;
            }
        }
    });

    $drawer.on('keydown', '.dle-action-btn[data-action]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    // Top status (dot + pipeline label) → /dle-status. Mirrors footer health icons.
    $drawer.on('click keydown', '.dle-clickable-status', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        executeCommand('/dle-status');
    });

    // Browse search help icon toggles the syntax popover beside it.
    $drawer.on('click', '.dle-browse-search-help', function (e) {
        e.preventDefault();
        const $popover = $drawer.find('.dle-browse-search-help-popover');
        if (!$popover.length) return;
        const wasOpen = $popover.prop('open');
        $popover.prop('open', !wasOpen);
    });

    $drawer.on('click', '.dle-setup-banner-btn', async () => {
        try {
            const { showSetupWizard } = await import('../ui/setup-wizard.js');
            showSetupWizard();
        } catch (err) {
            console.error('[DLE] Setup wizard error:', err);
            toastr.error('Failed to open setup wizard.', 'DeepLore Enhanced');
        }
    });
    $drawer.on('click', '.dle-setup-banner-dismiss', () => {
        $drawer.find('.dle-setup-banner').remove();
        const s = getSettings();
        s._wizardCompleted = true;
        invalidateSettingsCache();
        saveSettingsDebounced();
    });
}

export function wireInjectionTab($drawer) {
    $drawer.on('click', '.dle-why-filter-btn', function () {
        ds.whyTabFilter = $(this).data('filter') || 'both';
        $drawer.find('.dle-why-filter-btn').attr('aria-checked', 'false');
        $(this).attr('aria-checked', 'true');
        try { accountStorage.setItem('dle-why-filter', ds.whyTabFilter); } catch { /* noop */ }
        scheduleRender(renderInjectionTab);
    });

    // BUG-AUDIT-C11: roving tabindex for Why? filter radiogroup — mirrors Librarian sub-tabs.
    $drawer.on('keydown', '.dle-why-filter-btn', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $(this).trigger('click'); return; }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const $btns = $drawer.find('.dle-why-filter-btn');
        const idx = $btns.index(this);
        const next = e.key === 'ArrowRight' ? (idx + 1) % $btns.length : (idx - 1 + $btns.length) % $btns.length;
        $btns.eq(next).trigger('click').focus();
    });

    $drawer.on('click', '.dle-copy-titles-btn', function () {
        const $btn = $(this);
        const sources = lastInjectionSources;
        if (!sources || sources.length === 0) {
            toastr.warning('No injected entries to copy.', 'DeepLore Enhanced', { timeOut: 2000 });
            return;
        }
        const n = sources.length;
        const titles = sources.map(s => s.title).join('\n');
        navigator.clipboard.writeText(titles).then(
            () => { toastr.success(`Copied ${n} title${n === 1 ? '' : 's'} to clipboard`, 'DeepLore Enhanced', { timeOut: 2000 }); $btn.focus(); },
            () => toastr.warning('Clipboard access denied — check browser permissions.', 'DeepLore Enhanced', { timeOut: 3000 }),
        );
    });
}

export function wireBrowseTab($drawer) {
    // Virtual scroll RAF-throttled re-render. Scroll container is .dle-drawer-inner, not the tab panel.
    // Namespace `.dle-browse` so repeated wireBrowseTab calls (drawer rebuild on chat switch / re-init)
    // can off() the prior binding without stacking.
    const $scrollInner = $drawer.find('.dle-drawer-inner');
    $scrollInner.off('scroll.dle-browse');
    $scrollInner.on('scroll.dle-browse', function () {
        if (ds.browseScrollRAF) return;
        ds.browseScrollRAF = requestAnimationFrame(() => {
            ds.browseScrollRAF = null;
            renderBrowseWindow();
        });
    });

    $drawer.on('click keydown', '.dle-obsidian-link', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        const uri = this.dataset?.obsidianUri;
        if (!openExternalProtocol(uri)) {
            toastr.warning('Could not open Obsidian link from this browser context.', 'DeepLore Enhanced', { timeOut: 2500 });
        }
    });

    $drawer.find('.dle-browse-input').on('input', function () {
        const val = $(this).val();
        clearTimeout(ds.browseSearchTimeout);
        $drawer.find('.dle-browse-refresh-spinner').css('visibility', 'visible');
        ds.browseSearchTimeout = setTimeout(() => {
            $drawer.find('.dle-browse-refresh-spinner').css('visibility', '');
            ds.browseQuery = val;
            scheduleRender(renderBrowseTab);
            requestAnimationFrame(() => {
                const n = ds.browseFilteredEntries?.length ?? 0;
                announceToScreenReader(`${n} result${n !== 1 ? 's' : ''}`);
            });
        }, 250);
    });

    $drawer.find('[data-filter="status"]').on('change', function () {
        ds.browseStatusFilter = $(this).val();
        updateFilterActiveIndicators($drawer);
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-filter="tag"]').on('change', function () {
        ds.browseTagFilter = $(this).val();
        updateFilterActiveIndicators($drawer);
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-filter="folder"]').on('change', function () {
        ds.browseFolderFilter = $(this).val();
        updateFilterActiveIndicators($drawer);
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-sort]').on('change', function () {
        ds.browseSort = $(this).val();
        try { accountStorage.setItem('dle-browse-sort', ds.browseSort); } catch { /* noop */ }
        toastr.info(`Sorted by ${$(this).find('option:selected').text()}`, 'DeepLore Enhanced', { timeOut: 1500 });
        scheduleRender(renderBrowseTab);
    });

    // Delegated — custom field selects are dynamically rendered.
    $drawer.find('.dle-browse-filters').on('change', '.dle-browse-cf-filter', function () {
        const field = $(this).data('cf');
        const val = $(this).val();
        if (val) {
            ds.browseCustomFieldFilters[field] = val;
        } else {
            delete ds.browseCustomFieldFilters[field];
        }
        updateFilterActiveIndicators($drawer);
        scheduleRender(renderBrowseTab);
    });

    $drawer.on('click', '.dle-qf-pill', function () {
        const qf = $(this).data('qf');
        ds.browseQuickFilter = (ds.browseQuickFilter === qf) ? null : qf;
        scheduleRender(renderBrowseTab);
        const label = $(this).text();
        toastr.info(ds.browseQuickFilter ? `Quick filter: ${label}` : 'Quick filter cleared', 'DeepLore Enhanced', { timeOut: 1500 });
        announceToScreenReader(ds.browseQuickFilter ? `${label} filter on` : 'Quick filter off');
    });
    $drawer.on('keydown', '.dle-qf-pill', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    $drawer.on('click', '.dle-browse-clear-filters', function () {
        ds.browseQuery = '';
        ds.browseStatusFilter = 'all';
        ds.browseTagFilter = '';
        ds.browseFolderFilter = '';
        ds.browseCustomFieldFilters = {};
        $drawer.find('.dle-browse-input').val('');
        $drawer.find('[data-filter="status"]').val('all');
        $drawer.find('[data-filter="tag"]').val('');
        $drawer.find('[data-filter="folder"]').val('');
        updateFilterActiveIndicators($drawer);
        scheduleRender(renderBrowseTab);
        toastr.info('Filters cleared.', 'DeepLore Enhanced', { timeOut: 2000 });
    });

    // BUG-AUDIT-3: Store {title, vaultSource} objects to match slash-command format.
    // normalizePinBlock() handles both legacy bare strings and structured objects.
    $drawer.find('.dle-browse-list').on('click', '.dle-browse-pin', function () {
        const title = $(this).data('entry');
        const vaultSource = $(this).data('vault') || null;
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_pins.findIndex(p => {
            const n = normalizePinBlock(p);
            return n.title.toLowerCase() === tl && (n.vaultSource || null) === (vaultSource || null);
        });

        if (idx !== -1) {
            chat_metadata.deeplore_pins.splice(idx, 1);
            announceToScreenReader(`Unpinned ${title}`);
            toastr.info(`Unpinned: ${title}`, 'DeepLore Enhanced', { timeOut: 2000 });
        } else {
            // Pin → also remove from blocks (mutually exclusive).
            chat_metadata.deeplore_pins.push({ title, vaultSource });
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(b => {
                    const n = normalizePinBlock(b);
                    return !(n.title.toLowerCase() === tl && (n.vaultSource || null) === (vaultSource || null));
                });
            }
            announceToScreenReader(`Pinned ${title}`);
            toastr.info(`Pinned: ${title}`, 'DeepLore Enhanced', { timeOut: 2000 });
        }
        saveMetadataDebounced();
        notifyPinBlockChanged();
    });

    $drawer.find('.dle-browse-list').on('keydown', '.dle-browse-pin', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    $drawer.find('.dle-browse-list').on('click', '.dle-browse-block', function () {
        const title = $(this).data('entry');
        const vaultSource = $(this).data('vault') || null;
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_blocks.findIndex(b => {
            const n = normalizePinBlock(b);
            return n.title.toLowerCase() === tl && (n.vaultSource || null) === (vaultSource || null);
        });

        if (idx !== -1) {
            chat_metadata.deeplore_blocks.splice(idx, 1);
            announceToScreenReader(`Unblocked ${title}`);
            toastr.info(`Unblocked: ${title}`, 'DeepLore Enhanced', { timeOut: 2000 });
        } else {
            // Block → also remove from pins (mutually exclusive).
            chat_metadata.deeplore_blocks.push({ title, vaultSource });
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(p => {
                    const n = normalizePinBlock(p);
                    return !(n.title.toLowerCase() === tl && (n.vaultSource || null) === (vaultSource || null));
                });
            }
            announceToScreenReader(`Blocked ${title}`);
            toastr.info(`Blocked: ${title}`, 'DeepLore Enhanced', { timeOut: 2000 });
        }
        saveMetadataDebounced();
        notifyPinBlockChanged();
    });

    $drawer.find('.dle-browse-list').on('keydown', '.dle-browse-block', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    $drawer.find('.dle-browse-list').on('click keydown', '.dle-browse-info', function (e) {
        if (e.type === 'keydown' && e.key === 'Escape' && $(this).attr('aria-expanded') === 'true') {
            e.preventDefault();
            $(this).trigger('click');
            return;
        }
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        const $entry = $(this).closest('.dle-browse-entry');
        const title = $entry.data('title');
        if (!title) return;

        const $list = $drawer.find('.dle-browse-list');
        const $existing = $entry.find('.dle-browse-preview');
        if ($existing.length) {
            // Collapse — reset expanded state and force a virtual-scroll re-render to fix row positions.
            $existing.remove();
            $entry.css('height', BROWSE_ROW_HEIGHT + 'px');
            $(this).attr('aria-expanded', 'false');
            ds.browseExpandedEntry = null;
            ds.browseExpandedIdx = null;
            ds.browseExpandedExtraHeight = 0;
            const totalHeight = ds.browseFilteredEntries.length * BROWSE_ROW_HEIGHT;
            $list.css({ 'min-height': totalHeight + 'px' });
            ds.browseLastRangeStart = -1;
            ds._browseLastScrollTop = undefined;
            renderBrowseWindow();
            return;
        }

        if (ds.browseExpandedEntry) {
            const $prev = $list.find(`.dle-browse-entry[data-title="${CSS.escape(ds.browseExpandedEntry)}"]`);
            if ($prev.length) {
                $prev.find('.dle-browse-preview').remove();
                $prev.css('height', BROWSE_ROW_HEIGHT + 'px');
                $prev.find('.dle-browse-info').attr('aria-expanded', 'false');
            }
        }

        const entry = ds.browseFilteredEntries.find(e => e.title === title);
        if (!entry) return;

        const entryIdx = parseInt($entry.data('idx'), 10);
        ds.browseExpandedEntry = title;
        $(this).attr('aria-expanded', 'true');

        const preview = entry.summary || (entry.content ? entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '') : 'No content');
        const tokens = entry.tokenEstimate ? `${entry.tokenEstimate} tokens` : '';

        const settings = getSettings();
        const srcVault = entry.vaultSource && settings.vaults
            ? settings.vaults.find(v => v.name === entry.vaultSource) : null;
        const vaultName = srcVault ? srcVault.name : (settings.vaults?.[0]?.name || '');
        const uri = entry.filename ? buildObsidianURI(vaultName, entry.filename) : null;
        const linkHtml = uri ? ` ${buildObsidianAnchorHtml(uri)}` : '';

        let fieldsHtml = '';
        if (entry.customFields && Object.keys(entry.customFields).length > 0) {
            const pairs = Object.entries(entry.customFields)
                .filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0))
                .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}`);
            if (pairs.length) fieldsHtml = `<div class="dle-browse-fields">${pairs.join(' &middot; ')}</div>`;
        }

        const previewHtml = `<div class="dle-browse-preview"><div class="dle-browse-preview-text">${escapeHtml(preview)}</div>${fieldsHtml}<div class="dle-browse-preview-meta">${escapeHtml(tokens)}${linkHtml}</div></div>`;

        // Append → height:auto → measure (single forced reflow) → batch writes after the read.
        $entry.append(previewHtml);
        $entry.css('height', 'auto');
        const naturalHeight = $entry[0].scrollHeight;
        const extraHeight = Math.max(0, naturalHeight - BROWSE_ROW_HEIGHT);

        ds.browseExpandedIdx = entryIdx;
        ds.browseExpandedExtraHeight = extraHeight;

        const totalHeight = ds.browseFilteredEntries.length * BROWSE_ROW_HEIGHT + extraHeight;
        $list.css({ 'min-height': totalHeight + 'px' });
        ds.browseLastRangeStart = -1;
        ds._browseLastScrollTop = undefined;
        renderBrowseWindow();
    });
}

export function wireGatingTab($drawer) {
    // Chip X buttons via event delegation — animate out before removing.
    $drawer.find('#dle-panel-gating').on('click', '.dle-chip-x', function () {
        const field = $(this).data('field');
        const value = $(this).data('value');
        if (!field || !chat_metadata) return;

        if (!chat_metadata.deeplore_context) return;
        const ctx = chat_metadata.deeplore_context;

        const $chip = $(this).closest('.dle-chip');
        $chip.addClass('dle-chip-removing');

        // State update fires on transitionend OR a 200ms safety timeout (whichever first).
        // Don't wait for transitionend exclusively — a concurrent gating render would re-create the chip.
        const applyRemoval = () => {
            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            const fd = allDefs.find(d => d.name === field);
            if (fd) {
                const ctxKey = fd.contextKey;
                if (fd.multi && Array.isArray(ctx[ctxKey])) {
                    ctx[ctxKey] = ctx[ctxKey].filter(c => c !== value);
                } else {
                    ctx[ctxKey] = null;
                }
            }
            saveMetadataDebounced();
            notifyGatingChanged();
        };

        let fired = false;
        const once = () => { if (!fired) { fired = true; applyRemoval(); } };
        $chip.one('transitionend', once);
        setTimeout(once, 200);
    });

    $drawer.find('#dle-panel-gating').on('keydown', '.dle-chip-x', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    $drawer.find('#dle-panel-gating').on('click', '.dle-gating-set', async function () {
        const $group = $(this).closest('.dle-gating-group');
        const field = $group.data('field');
        if (!field) return;

        // Built-in fields have dedicated commands; custom fields fall through to generic /dle-set-field.
        const cmdMap = {
            era: '/dle-set-era',
            location: '/dle-set-location',
            scene_type: '/dle-set-scene',
            character_present: '/dle-set-characters',
        };
        const cmd = cmdMap[field] || `/dle-set-field ${field}`;
        executeCommand(cmd);
    });

    $drawer.find('.dle-clear-all-gating-btn').on('click', function () {
        if (!chat_metadata?.deeplore_context) return;
        const ctx = chat_metadata.deeplore_context;
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
            toastr.info('No active gating filters to clear.', 'DeepLore Enhanced', { timeOut: 2000 });
            return;
        }
        saveMetadataDebounced();
        notifyGatingChanged();
        toastr.success(`Cleared ${cleared} gating filter${cleared !== 1 ? 's' : ''}.`, 'DeepLore Enhanced', { timeOut: 2000 });
    });

    $drawer.find('.dle-manage-fields-btn').on('click', () => openRuleBuilder());

    // ── Folder filter ──

    $drawer.find('#dle-panel-gating').on('click', '.dle-folder-chip-x', function () {
        const folder = $(this).data('folder');
        if (!folder || !chat_metadata) return;
        if (!chat_metadata.deeplore_folder_filter) return;

        const $chip = $(this).closest('.dle-chip');
        $chip.addClass('dle-chip-removing');

        let fired = false;
        const apply = () => {
            if (fired) return;
            fired = true;
            chat_metadata.deeplore_folder_filter = chat_metadata.deeplore_folder_filter.filter(f => f !== folder);
            if (chat_metadata.deeplore_folder_filter.length === 0) chat_metadata.deeplore_folder_filter = null;
            saveMetadataDebounced();
            notifyGatingChanged();
        };
        $chip.one('transitionend', apply);
        setTimeout(apply, 200);
    });

    $drawer.find('#dle-panel-gating').on('keydown', '.dle-gating-set', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    $drawer.find('.dle-folder-set-btn').on('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });
    $drawer.find('.dle-folder-set-btn').on('click', async function () {
        const { callGenericPopup, POPUP_TYPE } = await import('../../../../../popup.js');
        const current = chat_metadata?.deeplore_folder_filter || [];
        const currentSet = new Set(current);

        if (folderList.length === 0) {
            await callGenericPopup(
                '<div class="dle-popup"><p>No folders found in the vault. All entries are at the root level.</p></div>',
                POPUP_TYPE.TEXT, '', { wide: false },
            );
            return;
        }

        let html = '<div class="dle-popup"><h4>Select Folders</h4>';
        if (current.length) html += `<p class="dle-mb-2">Active: <strong>${escapeHtml(current.join(', '))}</strong></p>`;
        html += '<div class="dle-flex-col dle-gap-1">';
        html += '<button class="menu_button dle-field-select dle-folder-select dle-flex-between dle-w-full" data-value="">Clear all folders</button>';
        for (const { path, entryCount } of folderList) {
            const isActive = currentSet.has(path);
            const activeClass = isActive ? ' dle-field-select--active' : '';
            html += `<button class="menu_button dle-field-select dle-folder-select dle-flex-between dle-w-full${activeClass}" data-value="${escapeHtml(path)}">${escapeHtml(path)}<span class="dle-text-xs" style="opacity:0.5;margin-left:auto;padding-left:8px;">${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}</span></button>`;
        }
        html += '</div></div>';

        await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
            wide: false,
            onOpen: () => {
                const buttons = document.querySelectorAll('.dle-folder-select');
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
                        const pEl = document.querySelector('.dle-popup p.dle-mb-2');
                        const cf = chat_metadata.deeplore_folder_filter || [];
                        if (pEl) pEl.innerHTML = cf.length ? `Active: <strong>${escapeHtml(cf.join(', '))}</strong>` : '';
                        saveMetadataDebounced();
                        notifyGatingChanged();
                    });
                }
            },
        });
    });

    // BUG-188: keyboard activation on status-zone folder badge + gating value chips.
    $drawer.on('click', '.dle-folder-badge-chip, .dle-gating-value-chip', function () {
        switchTab($drawer, 'gating');
    });
    $drawer.on('keydown', '.dle-folder-badge-chip, .dle-gating-value-chip', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            switchTab($drawer, 'gating');
        }
    });

    // Inline chip clears in the active-filters strip.
    $drawer.on('click keydown', '.dle-active-filters .dle-chip-x', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (!chat_metadata) return;
        const $x = $(this);
        if ($x.hasClass('dle-chip-x-folder')) {
            chat_metadata.deeplore_folder_filter = null;
            saveMetadataDebounced();
            notifyGatingChanged();
            return;
        }
        const $chip = $x.closest('.dle-gating-value-chip');
        const key = $chip.data('ctx-key');
        const val = String($chip.data('ctx-val'));
        const ctx = chat_metadata.deeplore_context;
        if (!key || !ctx || ctx[key] == null) return;
        if (Array.isArray(ctx[key])) {
            ctx[key] = ctx[key].filter(v => String(v) !== val);
            if (ctx[key].length === 0) ctx[key] = [];
        } else {
            ctx[key] = null;
        }
        saveMetadataDebounced();
        notifyGatingChanged();
    });

    // Clear-all chip mirrors the gating-tab "clear all" button.
    $drawer.on('click keydown', '.dle-active-filters .dle-chip-clear-all', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (!chat_metadata) return;
        let cleared = 0;
        if (chat_metadata.deeplore_folder_filter && chat_metadata.deeplore_folder_filter.length > 0) {
            chat_metadata.deeplore_folder_filter = null;
            cleared++;
        }
        const ctx = chat_metadata.deeplore_context;
        if (ctx) {
            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            for (const fd of allDefs) {
                if (!fd.gating?.enabled) continue;
                const v = ctx[fd.contextKey];
                if (fd.multi ? (Array.isArray(v) && v.length > 0) : !!v) {
                    ctx[fd.contextKey] = fd.multi ? [] : null;
                    cleared++;
                }
            }
        }
        if (cleared === 0) return;
        saveMetadataDebounced();
        notifyGatingChanged();
        toastr.success(`Cleared ${cleared} filter${cleared !== 1 ? 's' : ''}.`, 'DeepLore Enhanced', { timeOut: 1500 });
    });

    $drawer.on('click', '[data-action="goto-ai-connections"]', function (e) {
        e.stopPropagation();
        announceToScreenReader('Open Settings, then Connection, then AI Connections subtab.');
        toastr.info('Open Settings → Connection → AI Connections', 'DeepLore Enhanced', { timeOut: 4000 });
    });
    $drawer.on('keydown', '[data-action="goto-ai-connections"]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });

    $drawer.on('click', '.dle-chip-dismiss', function (e) {
        e.stopPropagation();
        ds.reasoningWarningDismissed = true;
        scheduleRender(renderStatusZone);
    });
    $drawer.on('keydown', '.dle-chip-dismiss', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
    });
}

export function wireHealthIcons($drawer) {
    const $footer = $drawer.find('#dle-drawer-footer');
    if (!$footer.length) return;

    $footer.find('.dle-health-icons').on('click', '[data-health]', function (e) {
        e.preventDefault();
        const area = $(this).data('health');
        switch (area) {
            case 'vault': executeCommand('/dle-health'); break;
            case 'connection': executeCommand('/dle-status'); break;
            case 'pipeline': executeCommand('/dle-inspect'); break;
            case 'cache': {
                const ageMs = indexTimestamp ? Date.now() - indexTimestamp : 0;
                const ageSec = Math.round(ageMs / 1000);
                const msg = indexTimestamp
                    ? `Index: ${vaultIndex.length} entries, ${ageSec}s old${indexEverLoaded ? '' : ' (from IndexedDB cache)'}`
                    : 'No index loaded yet.';
                if (typeof toastr !== 'undefined') toastr.info(msg, 'Cache Status');
                break;
            }
            case 'ai': {
                const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
                const msg = `Calls: ${aiSearchStats.calls} | Cached: ${aiSearchStats.cachedHits} | Tokens: ${totalTok.toLocaleString()} (${aiSearchStats.totalInputTokens.toLocaleString()} in, ${aiSearchStats.totalOutputTokens.toLocaleString()} out)`;
                if (typeof toastr !== 'undefined') toastr.info(msg, 'AI Search Stats');
                break;
            }
        }
    });

    $footer.find('.dle-health-icons').on('keydown', '[data-health]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Librarian Tab
// ════════════════════════════════════════════════════════════════════════════
let removeArmedAt = 0;

export function wireLibrarianTab($drawer) {
    // Sub-tab selection (Flags/Activity) is intentionally not persisted across tab entries.
    $drawer.on('click', '.dle-librarian-sub-tab', function () {
        ds.librarianFilter = $(this).data('filter') || 'flag';
        $drawer.find('.dle-librarian-sub-tab').attr('tabindex', '-1').attr('aria-checked', 'false');
        $(this).attr('tabindex', '0').attr('aria-checked', 'true');
        // Sub-tab change displays a different list — clear selection.
        ds.librarianSelected.clear();
        ds.librarianLastClicked = null;
        scheduleRender(renderLibrarianTab);
    });

    $drawer.on('keydown', '.dle-librarian-sub-tab', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const $tabs = $drawer.find('.dle-librarian-sub-tab');
        const idx = $tabs.index(this);
        const next = e.key === 'ArrowRight' ? (idx + 1) % $tabs.length : (idx - 1 + $tabs.length) % $tabs.length;
        $tabs.eq(next).trigger('click').focus();
    });

    $drawer.on('change', '.dle-librarian-sort', function () {
        ds.librarianSort = $(this).val() || 'newest';
        try { accountStorage.setItem('dle-librarian-sort', ds.librarianSort); } catch { /* noop */ }
        scheduleRender(renderLibrarianTab);
    });

    $drawer.on('click', '.dle-librarian-clear-btn', function () {
        ds.librarianSelected.clear();
        ds.librarianLastClicked = null;
        scheduleRender(renderLibrarianTab);
        announceToScreenReader('Selection cleared');
    });

    // Click a gap row → toggle expand (ignore clicks on the checkbox itself).
    $drawer.on('click', '.dle-librarian-entry', function (e) {
        if ($(e.target).closest('.dle-gap-check').length) return;

        const $entry = $(this);
        const $existing = $entry.find('.dle-gap-detail');
        if ($existing.length) {
            $existing.remove();
            $entry.removeClass('dle-gap-expanded').attr('aria-expanded', 'false');
            return;
        }
        $drawer.find('.dle-gap-detail').remove();
        $drawer.find('.dle-librarian-entry').removeClass('dle-gap-expanded').attr('aria-expanded', 'false');

        const gapId = $entry.data('gap-id');
        const gap = loreGaps.find(g => g.id === gapId);
        if (!gap) return;

        const metaParts = [];
        if ((gap.frequency || 1) > 1) metaParts.push(`Flagged ${gap.frequency}×`);
        metaParts.push(`Urgency: ${gap.urgency || 'medium'}`);
        metaParts.push(`Status: ${gap.status === 'written' ? 'Written' : 'Pending'}`);

        let detailHtml = '<div class="dle-gap-detail">'
            + `<div class="dle-gap-detail-reason">${escapeHtml(gap.reason || 'No reason provided')}</div>`
            + `<div class="dle-gap-detail-meta">${metaParts.join(' &middot; ')}</div>`
            + '</div>';
        $entry.append(detailHtml);
        $entry.addClass('dle-gap-expanded').attr('aria-expanded', 'true');
    });

    $drawer.on('keydown', '.dle-librarian-entry', function (e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const $next = $(this).next('.dle-librarian-entry');
            const $target = $next.length ? $next : $drawer.find('.dle-librarian-entry').first();
            if ($target.length) $target[0].focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const $prev = $(this).prev('.dle-librarian-entry');
            const $target = $prev.length ? $prev : $drawer.find('.dle-librarian-entry').last();
            if ($target.length) $target[0].focus();
        } else if (e.key === ' ') {
            // Space toggles expand; the checkbox handles its own activation.
            e.preventDefault();
            $(this).trigger('click');
        } else if (e.key === 'd' && _isSafeShortcutTarget(document.activeElement)) {
            if (ds.librarianSelected.size > 0) {
                e.preventDefault();
                $drawer.find('.dle-librarian-action[data-librarian-action="done"]').trigger('click');
            }
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && _isSafeShortcutTarget(document.activeElement)) {
            if (ds.librarianSelected.size > 0) {
                e.preventDefault();
                $drawer.find('.dle-librarian-action[data-librarian-action="remove"]').trigger('click');
            }
        }
    });

    $drawer.on('click', '.dle-librarian-new-entry-btn', function () {
        executeCommand('/dle-librarian');
    });
    $drawer.on('click', '.dle-librarian-vault-review-btn', function () {
        executeCommand('/dle-review');
    });

    // ─── Activity row: results meta link → context popup ─────────────────────
    $drawer.on('click', '.dle-activity-results-link', async function (e) {
        e.stopPropagation();
        const query = $(this).attr('data-query') || '';
        let titles = [];
        try { titles = JSON.parse($(this).attr('data-results') || '[]'); } catch { titles = []; }
        const { callGenericPopup, POPUP_TYPE } = await import('../../../../../popup.js');
        const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const list = titles.length
            ? '<ul style="margin:6px 0 0 18px;padding:0;">' + titles.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>'
            : '<em>No entries returned.</em>';
        const html = `<div><strong>Query:</strong> ${esc(query)}</div>`
            + `<div style="margin-top:8px;"><strong>Context returned to writing AI (${titles.length} ${titles.length === 1 ? 'entry' : 'entries'}):</strong></div>`
            + list;
        await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false, allowVerticalScrolling: true });
    });

    // ─── Selection ───────────────────────────────────────────────────────────

    $drawer.on('click', '.dle-gap-check', function (e) {
        e.stopPropagation();
        const $entry = $(this).closest('.dle-librarian-entry');
        const gapId = $entry.data('gap-id');
        if (!gapId) return;

        if (e.shiftKey && ds.librarianLastClicked) {
            const $entries = $drawer.find('.dle-librarian-entry');
            const ids = $entries.map(function () { return $(this).data('gap-id'); }).get();
            const startIdx = ids.indexOf(ds.librarianLastClicked);
            const endIdx = ids.indexOf(gapId);
            if (startIdx >= 0 && endIdx >= 0) {
                const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                for (let i = lo; i <= hi; i++) ds.librarianSelected.add(ids[i]);
            }
        } else if (ds.librarianSelected.has(gapId)) {
            ds.librarianSelected.delete(gapId);
        } else {
            ds.librarianSelected.add(gapId);
        }
        ds.librarianLastClicked = gapId;
        const total = $drawer.find('.dle-librarian-list .dle-librarian-entry').length;
        const selected = ds.librarianSelected.size;
        $drawer.find('.dle-librarian-select-all').prop('indeterminate', selected > 0 && selected < total);
        scheduleRender(renderLibrarianTab);
    });

    $drawer.on('click', '.dle-librarian-select-all', function () {
        const checked = $(this).prop('checked');
        const $entries = $drawer.find('.dle-librarian-list .dle-librarian-entry');
        if (checked) {
            $entries.each(function () { ds.librarianSelected.add($(this).data('gap-id')); });
        } else {
            $entries.each(function () { ds.librarianSelected.delete($(this).data('gap-id')); });
            ds.librarianLastClicked = null;
        }
        $(this).prop('indeterminate', false);
        scheduleRender(renderLibrarianTab);
    });

    // ─── Footer action row (Open / Mark Done / Remove) ──────────────────────

    $drawer.on('click', '.dle-librarian-action', function (e) {
        e.stopPropagation();
        if ($(this).prop('disabled')) return;
        const action = $(this).data('librarian-action');
        const ids = [...ds.librarianSelected];
        if (ids.length === 0) return;

        if (action === 'open') {
            if (ids.length !== 1) return;
            executeCommand(`/dle-librarian gap ${ids[0]}`);
            return;
        }

        if (action === 'done') {
            for (const id of ids) {
                const gap = loreGaps.find(g => g.id === id);
                if (gap) gap.status = 'written';
            }
            persistGaps([...loreGaps]);
            ds.librarianSelected.clear();
            ds.librarianLastClicked = null;
            const doneN = ids.length;
            toastr.success(`Marked ${doneN} as written`, 'DeepLore Enhanced', { timeOut: 2000 });
            announceToScreenReader(`${doneN} item${doneN !== 1 ? 's' : ''} marked as Written`);
            scheduleRender(renderLibrarianTab);
            requestAnimationFrame(() => {
                const $first = $drawer.find('.dle-librarian-list .dle-librarian-entry').first();
                if ($first.length) $first[0].focus();
            });
            return;
        }

        if (action === 'remove') {
            const $btn = $(this);
            const now = Date.now();
            // Two-click confirm pattern: first click arms for 3s, second click within window executes.
            if (now - removeArmedAt > 3000) {
                removeArmedAt = now;
                const origHtml = $btn.html();
                $btn.html('<i class="fa-solid fa-trash" aria-hidden="true"></i> Click again to confirm');
                setTimeout(() => {
                    if (Date.now() - removeArmedAt >= 3000) $btn.html(origHtml);
                }, 3000);
                return;
            }
            removeArmedAt = 0;
            const hidden = getHiddenGapIds();
            let hideN = 0, dismissN = 0;
            for (const id of ids) {
                if (hidden.has(id)) {
                    dismissGap(id);
                    dismissN++;
                } else {
                    hideGap(id);
                    hideN++;
                }
            }
            ds.librarianSelected.clear();
            ds.librarianLastClicked = null;
            const parts = [];
            if (hideN) parts.push(`${hideN} hidden (re-flag resurfaces)`);
            if (dismissN) parts.push(`${dismissN} dismissed`);
            announceToScreenReader(parts.join(', '));
            scheduleRender(renderLibrarianTab);
        }
    });

    $drawer.on('click keydown', '.dle-librarian-invert-btn', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        const allIds = $drawer.find('.dle-librarian-list .dle-librarian-entry').map(function () { return $(this).data('gap-id'); }).get();
        const inverted = allIds.filter(id => !ds.librarianSelected.has(id));
        ds.librarianSelected = new Set(inverted);
        scheduleRender(renderLibrarianTab);
    });
}

/** Drawer-wide shortcuts: r=refresh, s=scribe, n=newlore, g=graph, /=focus search. */
export function wireGlobalShortcuts($drawer) {
    $drawer.on('keydown.dle-shortcuts', function (e) {
        if (e.target.matches('input, textarea, [contenteditable]')) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        switch (e.key) {
            case 'r': e.preventDefault(); $drawer.find('.dle-action-btn[data-action="refresh"]').trigger('click'); break;
            case 's': e.preventDefault(); $drawer.find('.dle-action-btn[data-action="scribe"]').trigger('click'); break;
            case 'n': { const $n = $drawer.find('.dle-action-btn[data-action="newlore"]'); if ($n.length) { e.preventDefault(); $n.trigger('click'); } break; }
            case 'g': e.preventDefault(); $drawer.find('.dle-action-btn[data-action="graph"]').trigger('click'); break;
            case '/': {
                const $panel = $drawer.find('#dle-panel-browse');
                if ($panel.hasClass('active')) {
                    e.preventDefault();
                    $drawer.find('.dle-browse-input').trigger('focus');
                }
                break;
            }
        }
    });
}
