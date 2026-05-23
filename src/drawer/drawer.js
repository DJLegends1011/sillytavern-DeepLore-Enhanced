import { doNavbarIconClick, saveSettingsDebounced, getCurrentChatId } from '../../../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { accountStorage } from '../../../../../util/AccountStorage.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, generationLock,
    loreGaps,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
    onPipelineComplete, onInjectionSourcesReady, onGatingChanged, onPinBlockChanged, onGenerationLockChanged,
    onIndexingChanged, onLoreGapsChanged, onClaudeAutoEffortChanged, onPipelinePhaseChanged,
    onChatInjectionCountsUpdated, onFieldDefinitionsUpdated,
} from '../state.js';
import { getCurrentForChat as getCurrentVerdictForChat, onVerdictChanged } from '../verdict/verdict-store.js';

// Local helper — UI consumers must read the CURRENT CHAT's verdict, not the
// ring-global newest. See docs/gotchas.md #46 ("UI consumer rule").
function _currentVerdictForChat() {
    let cid = null;
    try { cid = getCurrentChatId() ?? null; } catch { cid = null; }
    return getCurrentVerdictForChat(cid);
}

import {
    ds, DRAWER_ID, OVERLAY_CHAT_WIDTH_THRESHOLD,
    scheduleRender, announceToScreenReader, loadSTInternals, dragElement, isMobile, power_user,
    invalidateTemperatureCache,
} from './drawer-state.js';
import {
    renderStatusZone, renderInjectionTab, updateInjectionCountBadges,
    renderBrowseTab, renderGatingTab, renderTimers, renderFooter,
} from './drawer-render.js';
import { renderLibrarianTab } from './drawer-render-librarian.js';
import {
    switchTab,
    wireToolsTab, wireTabExpand, wireStatusActions, wireInjectionTab, wireBrowseTab, wireGatingTab, wireHealthIcons,
    wireLibrarianTab, wireGlobalShortcuts,
} from './drawer-events.js';
import { shouldBailDrawerDismiss } from './drawer-dismiss-pure.js';
import { pushEvent } from '../diagnostics/interceptors.js';

// ════════════════════════════════════════════════════════════════════════════
// Teardown registry (BUG-349 — prevent listener leaks across drawer destroy/recreate)
// ════════════════════════════════════════════════════════════════════════════
let drawerDestroyed = false;
let drawerListeners = { eventSource: [], timers: [], stateObservers: [], windowEvents: [] };
// BUG-119: gap-announce debouncer state must be module-scoped. A drawer re-init
// (HMR / destroyDrawerPanel + createDrawerPanel) would otherwise leave the old
// subscriber's closure alive with a stale `_lastGapCount`, producing duplicate
// announcements with stale counts.
let _gapAnnounceTimer = null;
let _lastGapCount = 0;
const GAP_ANNOUNCE_DEBOUNCE_MS = 500;

// ════════════════════════════════════════════════════════════════════════════
// Public API (consumed by index.js)
// ════════════════════════════════════════════════════════════════════════════

/** Reset ephemeral drawer state on chat change. */
export function resetDrawerState() {
    ds.browseQuery = '';
    ds.browseStatusFilter = 'all';
    ds.browseTagFilter = '';
    // browseSort / librarianSort / browseSort [data-sort] are user UI prefs — accountStorage-persisted, intentionally not reset.
    ds.browseFilteredEntries = [];
    ds.browseRowModel = [];
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    ds.browseExpandedEntry = null;
    // BUG-362: clear expanded-state too, so stale offset math can't persist.
    ds.browseExpandedIdx = null;
    ds.browseExpandedExtraHeight = 0;
    ds.browseNavigateTarget = null;
    ds.browseCustomFieldFilters = {}; // BUG-AUDIT-11
    ds.browseFolderFilter = '';
    // #26: selection is chat-specific (trackerKeys can collide across vault sets).
    // Clear browseSelected BEFORE flipping selectMode so any future selectMode observer
    // sees a consistent (off + empty) state.
    if (ds.browseSelected instanceof Set) ds.browseSelected.clear();
    ds.browseSelectMode = false;
    // ds.browseFolderGrouping + ds.browseExpandedFolders are session-scoped UI state (NOT
    // persisted to accountStorage like browseSort is — they only survive chat-switches).
    // BUG-042 will promote them to accountStorage in a later wave.
    ds.contextTokens = 0;
    // ds.stGenerating tracks ST's generation state across chat switches — GENERATION_ENDED clears it.
    ds.librarianFilter = 'flag';
    ds.librarianSelected.clear();
    ds.librarianLastClicked = null;
    if (ds.browseSearchTimeout) { clearTimeout(ds.browseSearchTimeout); ds.browseSearchTimeout = null; }
    const $input = $(`#${DRAWER_ID} .dle-browse-input`);
    if ($input.length) $input.val('');
    const $status = $(`#${DRAWER_ID} [data-filter="status"]`);
    if ($status.length) $status.val('all');
    const $tag = $(`#${DRAWER_ID} [data-filter="tag"]`);
    if ($tag.length) $tag.val('');
    const $folder = $(`#${DRAWER_ID} [data-filter="folder"]`);
    if ($folder.length) $folder.val('');
    // Re-render librarian tab to clear stale gaps from the previous chat.
    scheduleRender(renderLibrarianTab);
}

// ════════════════════════════════════════════════════════════════════════════
// Tag Cache
// ════════════════════════════════════════════════════════════════════════════

function rebuildTagCache() {
    ds.cachedTagSet = new Set();
    for (const e of vaultIndex) {
        if (e.tags) for (const t of e.tags) ds.cachedTagSet.add(t);
    }
    ds.cachedTagOptions = '<option value="">Tags</option>' +
        [...ds.cachedTagSet].sort().map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    ds.cachedFolderSet = new Set();
    for (const e of vaultIndex) {
        if (e.folderPath) {
            // Hierarchical browsing — index every ancestor segment, not just the leaf.
            const parts = e.folderPath.split('/');
            for (let i = 1; i <= parts.length; i++) {
                ds.cachedFolderSet.add(parts.slice(0, i).join('/'));
            }
        }
    }
    ds.cachedFolderOptions = '<option value="">Folder</option>' +
        [...ds.cachedFolderSet].sort().map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// Drawer Creation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create the drawer panel in #top-settings-holder. Structure mirrors ST's native
 * #rightNavHolder pattern exactly so doNavbarIconClick semantics match.
 */
export async function createDrawerPanel() {
    if ($(`#${DRAWER_ID}`).length) return;

    drawerDestroyed = false;
    drawerListeners.eventSource = [];
    drawerListeners.timers = [];
    drawerListeners.stateObservers = [];
    drawerListeners.windowEvents = [];

    await loadSTInternals();

    const drawerContent = await renderExtensionTemplateAsync(
        'third-party/sillytavern-DeepLore-Enhanced',
        'drawer',
    );

    const $drawer = ds.$drawer = $(`
        <div id="${DRAWER_ID}" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="deeploreDrawerIcon"
                     class="drawer-icon interactable closedIcon dle-drawer-icon-svg"
                     title="Open DeepLore Enhanced drawer"
                     tabindex="0"
                     role="button"
                     aria-expanded="false"
                     aria-label="Open DeepLore Enhanced drawer"><i class="fa-solid fa-book-open fa-fw" aria-hidden="true"></i></div>
            </div>
            <div id="deeplore-panel" class="drawer-content closedDrawer fillRight" role="region" aria-label="DeepLore Enhanced panel">
                <div id="deeplore-panelheader" class="fa-solid fa-grip drag-grabber" aria-hidden="true"></div>
                <div class="dle-drawer-controls">
                    <div class="dle-drawer-pin" title="Pin drawer open">
                        <input type="checkbox" id="dle-drawer-pin" aria-label="Pin drawer open">
                        <label for="dle-drawer-pin">
                            <div class="fa-solid unchecked fa-unlock right_menu_button" aria-hidden="true"></div>
                            <div class="fa-solid checked fa-lock right_menu_button" aria-hidden="true"></div>
                        </label>
                    </div>
                    <!-- NOTE: Do NOT use right_menu_button class on <button> elements — ST applies
                         background-color: rgb(240,240,240) which creates a white square. The lock avoids
                         this because it's a checkbox+label, not a button. Style manually instead. -->
                    <button class="dle-drawer-settings" title="Open DeepLore settings" aria-label="Open DeepLore settings">
                        <i class="fa-solid fa-gear" aria-hidden="true"></i>
                    </button>
                    <button id="dle-drawer-close" class="dle-drawer-close" title="Close drawer" aria-label="Close drawer">
                        <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="scrollableInner dle-drawer-inner">
                </div>
            </div>
        </div>
    `);

    // Footer must live outside .scrollableInner so it stays pinned during scroll.
    $drawer.find('.dle-drawer-inner').append(drawerContent);
    const $footerZone = $drawer.find('#dle-drawer-footer');
    if ($footerZone.length) $footerZone.insertAfter($drawer.find('.dle-drawer-inner'));

    $('#top-settings-holder').append($drawer);

    // Custom SVG icon — async/non-blocking; FA icon serves as fallback if fetch fails.
    fetch('/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced/icon.svg')
        .then(r => r.ok ? r.text() : null)
        .then(svg => {
            if (!svg) return;
            const $icon = $drawer.find('#deeploreDrawerIcon');
            $icon.empty().append($(svg).attr('aria-hidden', 'true'));
        })
        .catch(() => { /* FA fallback stays */ });

    // ═══════════════════════════════════════════════════════════════════════
    // Drawer toggle binding
    // ═══════════════════════════════════════════════════════════════════════

    // ST's initial pass binds .drawer-toggle at page load — dynamically-added drawers
    // need explicit re-binding to doNavbarIconClick. BUG-152: single click handler.
    $drawer.find('.drawer-toggle').on('click', function (e) {
        doNavbarIconClick.call(this, e);
        // Update aria-expanded + overlay mode AFTER ST processes the toggle.
        requestAnimationFrame(() => {
            const isOpen = $drawer.find('#deeplore-panel').hasClass('openDrawer');
            $drawer.find('#deeploreDrawerIcon').attr('aria-expanded', String(isOpen));
            pushEvent('drawer', { action: isOpen ? 'open' : 'close' });
            updateOverlayMode();
        });
    });

    $drawer.find('#deeploreDrawerIcon').on('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $drawer.find('.drawer-toggle').trigger('click');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Overlay mode
    // ═══════════════════════════════════════════════════════════════════════

    // chat_width above the threshold → switch drawer to fixed overlay (mirrors ST's mobile pattern).
    const $panel = $drawer.find('#deeplore-panel');

    function updateOverlayMode() {
        const chatWidth = power_user?.chat_width || 50;
        if (chatWidth >= OVERLAY_CHAT_WIDTH_THRESHOLD) {
            $panel.addClass('dle-overlay-mode');
        } else {
            $panel.removeClass('dle-overlay-mode');
        }
    }

    // BUG-065: re-check on window resize too — dragging across the breakpoint or rotating a tablet
    // must toggle overlay mode without requiring a manual drawer interaction. rAF-debounced.
    let _overlayResizeRaf = null;
    const handleOverlayResize = () => {
        if (_overlayResizeRaf) cancelAnimationFrame(_overlayResizeRaf);
        _overlayResizeRaf = requestAnimationFrame(() => {
            _overlayResizeRaf = null;
            if (drawerDestroyed) return;
            updateOverlayMode();
        });
    };
    window.addEventListener('resize', handleOverlayResize);
    drawerListeners.windowEvents = drawerListeners.windowEvents || [];
    drawerListeners.windowEvents.push({ event: 'resize', handler: handleOverlayResize });
    updateOverlayMode();

    // ═══════════════════════════════════════════════════════════════════════
    // Pin / Close / Mobile
    // ═══════════════════════════════════════════════════════════════════════

    // ST convention: native drawers gate the pin control behind !isMobile().
    if (isMobile && isMobile()) {
        $drawer.find('.dle-drawer-pin').hide();
    }

    const drawerSettings = getSettings();
    if (drawerSettings.drawerPinned && !(isMobile && isMobile())) {
        $drawer.find('#dle-drawer-pin').prop('checked', true);
        $drawer.find('#deeplore-panel').addClass('pinnedOpen');
        $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
    }

    if (drawerSettings.drawerCompactTabs) {
        $drawer.find('.dle-tab-bar').addClass('dle-compact-tabs');
    }

    $drawer.find('#dle-drawer-pin').on('click', function () {
        const pinned = $(this).prop('checked');
        if (pinned) {
            $drawer.find('#deeplore-panel').addClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
        } else {
            $drawer.find('#deeplore-panel').removeClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').removeClass('drawerPinnedOpen');
            // ST convention: close on unpin when another drawer is also open.
            if ($drawer.find('#deeplore-panel').hasClass('openDrawer') && $('.openDrawer').length > 1) {
                doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
            }
        }

        const s = getSettings();
        s.drawerPinned = pinned;
        saveSettingsDebounced();
    });

    $drawer.find('#dle-drawer-close').on('click', function () {
        // Guard the open check so the close button doesn't accidentally toggle the drawer back open.
        if ($panel.hasClass('openDrawer')) {
            doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
        }
    });

    // Dismiss-on-outside-click — only when in overlay mode and not pinned.
    // Bail conditions (see drawer-dismiss-pure.js): clicks inside the panel,
    // inside any popup/dialog/toast spawned over it, or on the drawer toggle
    // icon must NOT dismiss. Without the popup exemption, callGenericPopup
    // dialogs (rendered to <body>, not inside #deeplore-panel) close the
    // drawer behind them on every click — see docs/gotchas.md #56.
    $(document).on('click.dle-drawer-dismiss', (e) => {
        if (!$panel.hasClass('openDrawer')) return;
        if ($panel.hasClass('pinnedOpen')) return;
        if (!$panel.hasClass('dle-overlay-mode')) return;
        if (shouldBailDrawerDismiss(e.target, $panel[0], document)) return;
        doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
    });

    $drawer.find('.dle-drawer-settings').on('click', async function (e) {
        const { openSettingsPopup } = await import('../ui/settings-ui.js');
        openSettingsPopup?.();
        e.currentTarget.blur();
    });

    // Moving UI: hand the panel to ST's drag system.
    if (power_user?.movingUI && dragElement) {
        dragElement($('#deeplore-panel'));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Tab switching
    // ═══════════════════════════════════════════════════════════════════════

    $drawer.find('.dle-tab').on('click', function () {
        switchTab($drawer, $(this).data('tab'));
    });

    // Arrow / Home / End keyboard navigation per ARIA tabs pattern.
    $drawer.find('.dle-tab').on('keydown', function (e) {
        const $tabs = $drawer.find('.dle-tab');
        const idx = $tabs.index(this);
        let newIdx = idx;

        switch (e.key) {
            case 'ArrowRight': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowLeft': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            case 'Escape': {
                // Close drawer if open (overlay mode especially).
                const $pnl = $drawer.find('#deeplore-panel');
                if ($pnl.hasClass('openDrawer') && !$pnl.hasClass('pinnedOpen')) {
                    doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
                    return;
                }
                return;
            }
            default: return;
        }

        e.preventDefault();
        const $newTab = $tabs.eq(newIdx);
        switchTab($drawer, $newTab.data('tab'));
        $newTab.trigger('focus');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wire event handlers (one-time, delegated to sub-module)
    // ═══════════════════════════════════════════════════════════════════════
    wireToolsTab($drawer);
    wireTabExpand($drawer);
    wireStatusActions($drawer);
    wireInjectionTab($drawer);
    wireBrowseTab($drawer);
    wireGatingTab($drawer);
    wireLibrarianTab($drawer);
    wireHealthIcons($drawer);
    wireGlobalShortcuts($drawer);

    // Browse navigation buttons (Why? tab → Browse tab) — delegated here to avoid the drawer-events.js → drawer.js circular import.
    $drawer.on('click', '.dle-browse-nav-btn', function (e) {
        e.stopPropagation();
        const title = $(this).data('browse-title');
        if (title) navigateToBrowseEntry(title);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Context window event — track total prompt tokens after assembly
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx?.eventSource && stCtx?.eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
            // Lazy-import promptManager so the module graph still loads on non-OAI backends.
            if (!ds.promptManagerRef) {
                try {
                    const oai = await import('../../../../../openai.js');
                    ds.promptManagerRef = oai.promptManager;
                } catch { /* non-OAI backend → context bar stays hidden */ }
            }
            if (ds.promptManagerRef) {
                ds.contextBarAvailable = true;
                // Hydrate from last-known tokenUsage so the bar populates on chat load without waiting for a generation.
                if (ds.promptManagerRef.tokenUsage) {
                    ds.contextTokens = ds.promptManagerRef.tokenUsage;
                    scheduleRender(renderFooter);
                }
                const handleChatCompletionPromptReady = () => {
                    if (drawerDestroyed) return;
                    ds.contextTokens = ds.promptManagerRef?.tokenUsage || 0;
                    scheduleRender(renderFooter);
                };
                stCtx.eventSource.on(stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, handleChatCompletionPromptReady);
                drawerListeners.eventSource.push({ event: stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, handler: handleChatCompletionPromptReady });
            }
        }
    } catch (err) {
        console.warn('[DLE] Could not wire context token tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Generation lifecycle — track "Writing..." state
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx2 = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx2?.eventSource && stCtx2?.eventTypes?.GENERATION_STARTED) {
            const handleGenerationStarted = (_type, _opts, dryRun) => {
                if (drawerDestroyed) return;
                // Dry runs (token counting) never fire a matching END event; ignore them.
                if (dryRun) return;
                ds.stGenerating = true;
                scheduleRender(renderStatusZone);
            };
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_STARTED, handleGenerationStarted);
            drawerListeners.eventSource.push({ event: stCtx2.eventTypes.GENERATION_STARTED, handler: handleGenerationStarted });

            const handleGenerationEnded = () => {
                if (drawerDestroyed) return;
                // GENERATION_ENDED may not pass dryRun — skip if stGenerating is already false
                // so a dry-run END can't clear a real generation's state.
                if (!ds.stGenerating) return;
                ds.stGenerating = false;
                scheduleRender(renderStatusZone);
            };
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_ENDED, handleGenerationEnded);
            drawerListeners.eventSource.push({ event: stCtx2.eventTypes.GENERATION_ENDED, handler: handleGenerationEnded });

            // GENERATION_STOPPED safety net — user-Stop sometimes skips GENERATION_ENDED depending on timing.
            if (stCtx2.eventTypes.GENERATION_STOPPED) {
                const handleGenerationStopped = () => {
                    if (drawerDestroyed) return;
                    ds.stGenerating = false;
                    scheduleRender(renderStatusZone);
                };
                stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_STOPPED, handleGenerationStopped);
                drawerListeners.eventSource.push({ event: stCtx2.eventTypes.GENERATION_STOPPED, handler: handleGenerationStopped });
            }
        }
    } catch (err) {
        console.warn('[DLE] Could not wire generation lifecycle tracking:', err.message);
    }

    // E10/Q18: switchTab writes 'dle-last-drawer-tab' on every change; restore it here on open.
    // First-time users fall back to 'injection'.
    const VALID_TABS = new Set(['injection', 'browse', 'gating', 'librarian', 'tools']);
    let initialTab = 'injection';
    try {
        const savedTab = accountStorage.getItem('dle-last-drawer-tab');
        if (savedTab && VALID_TABS.has(savedTab)) initialTab = savedTab;
    } catch { /* noop */ }
    try { switchTab($drawer, initialTab); } catch { /* noop */ }

    // Restore persistent UI prefs from accountStorage.
    try {
        const savedWhyFilter = accountStorage.getItem('dle-why-filter');
        if (savedWhyFilter) ds.whyTabFilter = savedWhyFilter;

        const savedLibSort = accountStorage.getItem('dle-librarian-sort');
        if (savedLibSort) ds.librarianSort = savedLibSort;

        const savedBrowseSort = accountStorage.getItem('dle-browse-sort');
        if (savedBrowseSort) ds.browseSort = savedBrowseSort;
    } catch { /* noop */ }

    // ═══════════════════════════════════════════════════════════════════════
    // Initial render
    // ═══════════════════════════════════════════════════════════════════════

    if (vaultIndex?.length) rebuildTagCache();

    renderStatusZone();
    renderInjectionTab();
    renderBrowseTab();
    renderGatingTab();
    renderLibrarianTab();
    renderTimers();
    renderFooter();

    // ═══════════════════════════════════════════════════════════════════════
    // Observer subscriptions — live data updates
    // ═══════════════════════════════════════════════════════════════════════
    drawerListeners.stateObservers.push(onIndexUpdated(() => {
        if (drawerDestroyed) return;
        rebuildTagCache();
        scheduleRender(renderStatusZone);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        setTimeout(() => announceToScreenReader(`Vault index refreshed: ${vaultIndex.length} entries loaded.`), 0);
    }));

    drawerListeners.stateObservers.push(onAiStatsUpdated(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    }));

    drawerListeners.stateObservers.push(onCircuitStateChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    }));

    drawerListeners.stateObservers.push(onClaudeAutoEffortChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
    }));

    drawerListeners.stateObservers.push(onPipelinePhaseChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
    }));

    drawerListeners.stateObservers.push(onPipelineComplete(() => {
        if (drawerDestroyed) return;
        invalidateTemperatureCache();
        scheduleRender(renderStatusZone);
        // Re-render the injection tab on complete only when verdict's injectedSources
        // are empty — transitions "Choosing lore…" spinner → empty-state guide. With
        // populated sources, onInjectionSourcesReady has already rendered them.
        const _completeVerdict = _currentVerdictForChat();
        const _completeInjCount = _completeVerdict?.injectedSources?.length ?? 0;
        if (_completeInjCount === 0) {
            scheduleRender(renderInjectionTab);
        }
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        if (_completeInjCount > 0) {
            setTimeout(() => announceToScreenReader(`Pipeline complete: ${_completeInjCount} entries injected.`), 0);
        }
    }));

    // Early Why? tab population — fires when injection sources are ready, BEFORE the
    // agentic loop or ST generation starts. Only the injection tab; other tabs update
    // via notifyPipelineComplete.
    drawerListeners.stateObservers.push(onInjectionSourcesReady(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderInjectionTab);
    }));

    drawerListeners.stateObservers.push(onGatingChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
        scheduleRender(renderGatingTab);
    }));

    drawerListeners.stateObservers.push(onPinBlockChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderBrowseTab);
    }));

    drawerListeners.stateObservers.push(onGenerationLockChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
        // Why? tab re-renders on lock ACQUIRE only (shows "Choosing lore..." spinner).
        // On lock release, onInjectionSourcesReady has already populated the tab — re-rendering
        // here would cause a visible flicker from the full DOM replacement.
        if (generationLock) scheduleRender(renderInjectionTab);
    }));

    drawerListeners.stateObservers.push(onIndexingChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderStatusZone);
        scheduleRender(renderBrowseTab);
    }));

    // BUG-119: seed baseline at init so the first announce after a chat reload doesn't fire for pre-existing gaps.
    _lastGapCount = loreGaps.length;
    drawerListeners.stateObservers.push(onLoreGapsChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderLibrarianTab);
        // Footer label suffix reflects librarianChatStats.estimatedExtraTokens — re-render on gap change.
        // ds.contextTokens stays as raw PM tokens; footer adds the extra at display time.
        if (ds.contextBarAvailable) {
            scheduleRender(renderFooter);
        }
        // 500ms debounce smooths bursts during generation.
        const newCount = loreGaps.length;
        if (newCount > _lastGapCount) {
            const added = newCount - _lastGapCount;
            clearTimeout(_gapAnnounceTimer);
            _gapAnnounceTimer = setTimeout(() => {
                const pendingFlags = loreGaps.filter(g => g.status === 'pending' && g.type === 'flag').length;
                if (pendingFlags > 0) {
                    announceToScreenReader(`${added} new lore gap${added !== 1 ? 's' : ''} flagged. ${pendingFlags} pending.`);
                }
            }, GAP_ANNOUNCE_DEBOUNCE_MS);
            drawerListeners.timers.push(_gapAnnounceTimer);
        }
        _lastGapCount = newCount;
    }));

    // Browse badges + Why? badge use chatInjectionCounts; without this subscriber the
    // UI stays stale between pipeline runs that mutate via direct .set().
    // Why? tab uses surgical badge update (no DOM rebuild → no animation restart).
    drawerListeners.stateObservers.push(onChatInjectionCountsUpdated(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderBrowseTab);
        scheduleRender(updateInjectionCountBadges);
    }));

    // Browse tab's rejected-entry lookup reads the current verdict's trace.
    // Why? tab is NOT re-rendered here — onInjectionSourcesReady covers the same pipeline
    // commit (trace + sources are set together on the verdict), and CHAT_CHANGED's clear
    // is covered by onPipelineComplete's empty-sources branch.
    drawerListeners.stateObservers.push(onVerdictChanged(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderBrowseTab);
    }));

    drawerListeners.stateObservers.push(onFieldDefinitionsUpdated(() => {
        if (drawerDestroyed) return;
        scheduleRender(renderGatingTab);
        scheduleRender(renderBrowseTab);
    }));
}

/**
 * Navigate Browse tab to a specific entry: open drawer, switch to Browse, filter, auto-expand.
 * @param {string} title
 */
export function navigateToBrowseEntry(title) {
    if (!ds.$drawer) return;

    // openDrawer class is on #deeplore-panel, not the wrapper.
    const toggle = ds.$drawer.find('.drawer-toggle')[0];
    if (toggle && !ds.$drawer.find('#deeplore-panel').hasClass('openDrawer')) {
        doNavbarIconClick.call(toggle);
    }

    switchTab(ds.$drawer, 'browse');

    ds.browseQuery = title;
    ds.browseStatusFilter = 'all';
    ds.browseTagFilter = '';
    ds.browseNavigateTarget = title; // consumed by renderBrowseTab for auto-expand.

    ds.$drawer.find('.dle-browse-input').val(title);
    ds.$drawer.find('[data-filter="status"]').val('all');
    ds.$drawer.find('[data-filter="tag"]').val('');

    // Focus the search input after render so keyboard users can immediately refine.
    renderBrowseTab();
    setTimeout(() => ds.$drawer?.find('.dle-browse-input').focus(), 0);
}

/** Tear down all listeners + DOM. Called from extension cleanup. */
export function destroyDrawerPanel() {
    drawerDestroyed = true;
    $(document).off('click.dle-drawer-dismiss');
    const stCtxCleanup = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    const esCleanup = stCtxCleanup?.eventSource;
    for (const { event, handler } of drawerListeners.eventSource) {
        try { esCleanup?.removeListener?.(event, handler); } catch { /* ignore */ }
    }
    drawerListeners.eventSource = [];
    // BUG-065: window-level listeners (resize) need explicit removal.
    for (const { event, handler } of (drawerListeners.windowEvents || [])) {
        try { window.removeEventListener(event, handler); } catch { /* ignore */ }
    }
    drawerListeners.windowEvents = [];
    // BUG-026: release state observer subscriptions.
    for (const unsub of drawerListeners.stateObservers) {
        try { if (typeof unsub === 'function') unsub(); } catch { /* ignore */ }
    }
    drawerListeners.stateObservers = [];
    for (const t of drawerListeners.timers) {
        try { clearTimeout(t); } catch { /* ignore */ }
    }
    drawerListeners.timers = [];
    // BUG-119: clear gap-announce debouncer so re-init starts clean.
    if (_gapAnnounceTimer) { try { clearTimeout(_gapAnnounceTimer); } catch { /* ignore */ } }
    _gapAnnounceTimer = null;
    _lastGapCount = 0;
    if (ds && ds.$drawer) {
        try { ds.$drawer.remove(); } catch { /* ignore */ }
        ds.$drawer = null;
    }
}
