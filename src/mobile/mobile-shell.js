import {
    aiSearchStats,
    chatInjectionCounts,
    computeOverallStatus,
    vaultIndex,
    indexing,
    indexEverLoaded,
    generationLock,
    librarianChatStats,
    loreGaps,
    pipelinePhase,
    onAiStatsUpdated,
    onCircuitStateChanged,
    onIndexUpdated,
    onIndexingChanged,
    onPipelineComplete,
    onGenerationLockChanged,
    onLoreGapsChanged,
    onPipelinePhaseChanged,
    notifyPinBlockChanged,
    cooldownTracker,
    decayTracker,
    suppressNextAgenticLoop,
    setSuppressNextAgenticLoop,
    resetAiSearchCache,
} from '../state.js';
import { buildObsidianURI, normalizePinBlock, openObsidianUri } from '../helpers.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import {
    buildMobileBrowseOptions,
    buildMobileBrowseRows,
    filterMobileBrowseEntries,
    normalizeMobileBrowseState,
} from './mobile-browse.js';
import { buildMobileStatusStats } from './mobile-stats.js';
import {
    splitInjectionEntries,
    buildMobileInjectionRows,
    extractTimerData,
} from './mobile-injection.js';
import {
    createFab,
    destroyFab,
    updateBadge,
    setFabVisible,
} from './mobile-fab.js';
import {
    createMobileUiState,
    normalizeMobileTab,
} from './mobile-state.js';
import {
    renderOverlay,
    renderOverlayError,
    shouldDismissSwipe,
} from './mobile-overlay.js';
import {
    normalizeMobileVerdict,
    readMobileVerdict,
    subscribeMobileVerdict,
} from './mobile-verdict.js';
import {
    configureMobileI18n,
    mt,
    mtf,
    resetMobileI18n,
} from './mobile-i18n.js';

export const MOBILE_VIEWPORT_WIDTH = 768;
export const TOUCH_TABLET_WIDTH = 1024;
export const MOBILE_FORCE_STORAGE_KEY = 'dleMobileUiForce';
export const MOBILE_DISABLE_STORAGE_KEY = 'dleMobileUiDisabled';

const ROOT_ID = 'dle-mobile-root';
const FORCE_KEY = MOBILE_FORCE_STORAGE_KEY;
const DISABLE_KEY = MOBILE_DISABLE_STORAGE_KEY;

let mobileRoot = null;
let mobileState = createMobileUiState();
let mobileUnsubscribers = [];
let mobileResizeHandler = null;
let mobileMediaQuery = null;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function boolFromStorage(key) {
    try {
        return globalThis.localStorage?.getItem(key) === '1';
    } catch {
        return false;
    }
}

export function normalizeMobilePreference({ force = false, disabled = false } = {}) {
    if (disabled) return 'disabled';
    if (force) return 'forced';
    return 'auto';
}

export function shouldUseMobileUi({
    stMobile = false,
    viewportWidth = Number.POSITIVE_INFINITY,
    coarsePointer = false,
    force = false,
    disabled = false,
} = {}) {
    const preference = normalizeMobilePreference({ force, disabled });
    if (preference === 'disabled') return false;
    if (preference === 'forced') return true;
    if (stMobile) return true;
    if (viewportWidth <= MOBILE_VIEWPORT_WIDTH) return true;
    return coarsePointer && viewportWidth <= TOUCH_TABLET_WIDTH;
}

function getContext() {
    try {
        return typeof SillyTavern !== 'undefined' && SillyTavern.getContext
            ? SillyTavern.getContext()
            : null;
    } catch {
        return null;
    }
}

function readMobileEnvironment() {
    const ctx = getContext();
    let stMobile = false;
    try {
        stMobile = !!ctx?.isMobile?.();
    } catch {
        stMobile = false;
    }

    const viewportWidth = typeof window !== 'undefined'
        ? window.innerWidth || document?.documentElement?.clientWidth || Number.POSITIVE_INFINITY
        : Number.POSITIVE_INFINITY;
    const coarsePointer = typeof window !== 'undefined'
        ? !!window.matchMedia?.('(pointer: coarse)').matches
        : false;

    return {
        stMobile,
        viewportWidth,
        coarsePointer,
        force: boolFromStorage(FORCE_KEY),
        disabled: boolFromStorage(DISABLE_KEY),
    };
}

function readMobileMode(env = readMobileEnvironment()) {
    return normalizeMobilePreference({ force: env.force, disabled: env.disabled });
}

function setMobileMode(mode) {
    try {
        mobileState.errorMessage = '';
        if (mode === 'forced') {
            localStorage.setItem(MOBILE_FORCE_STORAGE_KEY, '1');
            localStorage.removeItem(MOBILE_DISABLE_STORAGE_KEY);
            return 'forced';
        }
        if (mode === 'disabled') {
            localStorage.setItem(MOBILE_DISABLE_STORAGE_KEY, '1');
            localStorage.removeItem(MOBILE_FORCE_STORAGE_KEY);
            return 'disabled';
        }
        localStorage.removeItem(MOBILE_FORCE_STORAGE_KEY);
        localStorage.removeItem(MOBILE_DISABLE_STORAGE_KEY);
        return 'auto';
    } catch (err) {
        mobileState.errorMessage = mtf('dle_mobile_error_mode', 'Could not save mobile mode: ${0}', err.message || err);
        return readMobileMode();
    }
}

function commandForView(view) {
    const commands = {
        injection: '/dle-why',
        browse: '/dle-browse',
        filters: '/dle-context-state',
        health: '/dle-health',
        graph: '/dle-graph',
        setup: '/dle-setup',
    };
    return commands[view] || '';
}

function countInjected(sources) {
    return Array.isArray(sources) ? sources.length : 0;
}


function statusForState(source) {
    if (source.indexing) return mt('dle_mobile_status_indexing', 'Indexing');
    if (source.generationLock || source.pipelinePhase !== 'idle') return mt('dle_mobile_status_working', 'Working');
    if (!source.indexEverLoaded) return mt('dle_mobile_status_not_ready', 'Not ready');
    return mt('dle_mobile_status_ready', 'Ready');
}

export function buildMobileShellSnapshot(source = {}) {
    const verdict = Object.prototype.hasOwnProperty.call(source, 'verdict')
        ? normalizeMobileVerdict(source.verdict)
        : readMobileVerdict(mobileShellOptions.getCurrentVerdict);
    const state = {
        vaultIndex: source.vaultIndex ?? vaultIndex,
        indexing: source.indexing ?? indexing,
        generationLock: source.generationLock ?? generationLock,
        pipelinePhase: source.pipelinePhase ?? pipelinePhase,
        loreGaps: source.loreGaps ?? loreGaps,
        indexEverLoaded: source.indexEverLoaded ?? indexEverLoaded,
    };

    const entryCount = Array.isArray(state.vaultIndex) ? state.vaultIndex.length : 0;
    const gapCount = Array.isArray(state.loreGaps) ? state.loreGaps.length : 0;
    const injectedSources = verdict.injectedSources;
    const trace = verdict.trace;
    const injectedCount = countInjected(injectedSources);
    const context = getContext();
    const settings = source.settings ?? mobileShellOptions.getSettings?.() ?? {};
    const drawerState = source.drawerState ?? mobileShellOptions.getDrawerState?.() ?? {};
    const circuitState = source.circuitState ?? mobileShellOptions.getCircuitState?.() ?? getCircuitState();
    const overallStatus = source.overallStatus ?? computeOverallStatus(circuitState);
    const chatMetadata = source.chatMetadata ?? mobileShellOptions.getChatMetadata?.() ?? globalThis.chat_metadata ?? {};
    const browseContext = source.browseContext || {
        pins: chatMetadata?.deeplore_pins || [],
        blocks: chatMetadata?.deeplore_blocks || [],
        chatInjectionCounts: source.chatInjectionCounts ?? chatInjectionCounts,
    };
    const stats = buildMobileStatusStats({
        statusLabel: statusForState(state),
        entryCount,
        injectedCount,
        indexEverLoaded: state.indexEverLoaded,
        indexing: state.indexing,
        generationLock: state.generationLock,
        pipelinePhase: state.pipelinePhase,
        settings,
        trace,
        contextTokens: source.contextTokens ?? drawerState.contextTokens ?? 0,
        contextLimit: source.contextLimit ?? context?.chatCompletionSettings?.openai_max_context ?? context?.maxContext ?? 0,
        librarianExtraTokens: source.librarianExtraTokens ?? librarianChatStats?.estimatedExtraTokens ?? 0,
        aiSearchStats: source.aiSearchStats ?? aiSearchStats,
        overallStatus,
    });

    return {
        statusLabel: statusForState(state),
        entriesLabel: pluralize(entryCount, 'entry', 'entries'),
        entryCount,
        injectedCount,
        gapCount,
        phaseLabel: state.pipelinePhase || 'idle',
        injectedSources,
        trace,
        entries: Array.isArray(state.vaultIndex) ? state.vaultIndex : [],
        loreGaps: Array.isArray(state.loreGaps) ? state.loreGaps : [],
        stats,
        browseContext,
    };
}

function renderCommandButton(label, icon, command) {
    return `
        <button class="dle-mobile-action" type="button" data-dle-mobile-command="${escapeHtml(command)}">
            <i class="fa-solid ${escapeHtml(icon)}" aria-hidden="true"></i>
            <span>${escapeHtml(label)}</span>
        </button>
    `;
}

function renderInjectionCard(row, state) {
    const expanded = state.injectionExpandedKey === row.key;
    const filteredClass = row.isFiltered ? ' dle-mobile-injection-filtered' : '';
    const expandedClass = expanded ? ' dle-mobile-injection-expanded' : '';
    const badges = [];
    if (row.injectionCount > 0) badges.push(`<span class="dle-mobile-injection-badge">${row.injectionCount}×</span>`);
    if (row.isKeyword) badges.push(`<span class="dle-mobile-injection-badge dle-mobile-injection-badge-key">KEY</span>`);
    if (row.matchLabel && !row.isKeyword && row.matchLabel !== 'KEY') badges.push(`<span class="dle-mobile-injection-badge">${escapeHtml(row.matchLabel)}</span>`);

    return `
        <article class="dle-mobile-injection-card${filteredClass}${expandedClass}" data-dle-mobile-injection-key="${escapeHtml(row.key)}">
            <div class="dle-mobile-injection-title-row">
                <button type="button" data-dle-mobile-injection-expand="${escapeHtml(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                    <i class="fa-solid fa-chevron-${expanded ? 'down' : 'right'}" aria-hidden="true"></i>
                    <strong>${escapeHtml(row.title)}</strong>
                </button>
                <div class="dle-mobile-injection-meta">
                    ${badges.join('')}
                    ${row.tokenLabel ? `<span class="dle-mobile-injection-tokens">${escapeHtml(row.tokenLabel)}</span>` : ''}
                </div>
            </div>
            ${expanded ? `<div class="dle-mobile-injection-detail">
                <div>${escapeHtml(mtf('dle_mobile_injection_matched_by', 'Matched by: ${0}', row.matchedBy || row.matchLabel))}</div>
                ${row.reason ? `<div>${escapeHtml(mtf('dle_mobile_injection_reason', 'Reason: ${0}', row.reason))}</div>` : ''}
                <div class="dle-mobile-injection-links">
                    ${row.filename ? `<button type="button" data-dle-mobile-injection-action="obsidian" data-filename="${escapeHtml(row.filename)}" data-vault="${escapeHtml(row.vaultSource)}">${escapeHtml(mt('dle_mobile_injection_open_obsidian', 'Open in Obsidian'))}</button>` : ''}
                    <button type="button" data-dle-mobile-injection-action="browse" data-title="${escapeHtml(row.title)}" data-vault="${escapeHtml(row.vaultSource)}" data-filename="${escapeHtml(row.filename)}">${escapeHtml(mt('dle_mobile_injection_go_browse', 'Go to Browse \u2192'))}</button>
                </div>
            </div>` : ''}
        </article>
    `;
}

function renderInjection(snapshot, state = mobileState) {
    const injectedSources = Array.isArray(snapshot.injectedSources) ? snapshot.injectedSources : [];
    const filter = state.injectionFilter || 'injected';
    const trace = snapshot.trace;
    const split = splitInjectionEntries(injectedSources, trace, filter);
    const rows = buildMobileInjectionRows(split.entries);
    const settings = mobileShellOptions.getSettings?.() ?? {};
    const timers = extractTimerData(cooldownTracker, decayTracker, settings);

    const filterLabels = {
        injected: mt('dle_mobile_filter_injected', 'Injected'),
        filtered: mt('dle_mobile_filter_filtered', 'Filtered'),
        both: mt('dle_mobile_filter_both', 'Both'),
    };
    const filterButtons = ['injected', 'filtered', 'both'].map(f =>
        `<button type="button" class="dle-mobile-injection-filter-btn${filter === f ? ' active' : ''}" data-dle-mobile-injection-filter="${f}" aria-pressed="${filter === f ? 'true' : 'false'}">${escapeHtml(filterLabels[f] || f)}</button>`
    ).join('');

    const entryCards = rows.length
        ? rows.map(row => renderInjectionCard(row, state)).join('')
        : `<div class="dle-mobile-injection-empty">
            <strong>${escapeHtml(mt('dle_mobile_injection_empty_title', 'No entries injected yet'))}</strong>
            <span>${escapeHtml(mt('dle_mobile_injection_empty_detail', 'Send a message mentioning entry keywords, or check Obsidian connection.'))}</span>
           </div>`;

    const timerRows = timers.length
        ? timers.map(t => `<div class="dle-mobile-injection-timer"><span>${escapeHtml(t.title)}</span><span class="dle-mobile-injection-timer-badge dle-mobile-injection-timer-${t.timerType}">${escapeHtml(t.detail)}</span></div>`).join('')
        : `<div class="dle-mobile-injection-timer-empty">${escapeHtml(mt('dle_mobile_timer_none', 'No active timers'))}</div>`;

    const copyDisabled = !rows.length || filter !== 'injected';

    return `
        <div class="dle-mobile-tab-toolbar">
            <span class="dle-mobile-injection-count">${snapshot.injectedCount}</span>
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-injection-action="copy-titles" aria-label="${escapeHtml(mt('dle_mobile_aria_copy_titles', 'Copy injected titles'))}"${copyDisabled ? ' disabled' : ''}><i class="fa-solid fa-clipboard" aria-hidden="true"></i></button>
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-command="${commandForView('injection')}" aria-label="${escapeHtml(mt('dle_mobile_aria_full_injection', 'Open full Injection view'))}"><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i></button>
        </div>
        <div class="dle-mobile-injection-filters" role="radiogroup" aria-label="${escapeHtml(mt('dle_mobile_aria_filter_entries', 'Filter entries'))}">
            ${filterButtons}
        </div>
        ${split.summary ? `<div class="dle-mobile-injection-summary">${escapeHtml(split.summary)}</div>` : ''}
        <div class="dle-mobile-injection-list">
            ${entryCards}
        </div>
        <details class="dle-mobile-injection-timers">
            <summary><i class="fa-solid fa-clock" aria-hidden="true"></i> ${escapeHtml(mt('dle_mobile_entry_timers', 'Entry Timers'))}</summary>
            <div class="dle-mobile-injection-timer-list">${timerRows}</div>
        </details>
    `;
}

function renderBrowse(snapshot, state = mobileState) {
    const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    const browseState = normalizeMobileBrowseState(state.browse);
    const options = buildMobileBrowseOptions(entries);
    const browseContext = {
        ...snapshot.browseContext,
        injectedSources: snapshot.injectedSources,
    };
    const filtered = filterMobileBrowseEntries(entries, browseState, browseContext);
    const rows = buildMobileBrowseRows(filtered.entries, browseContext);
    const tagOptions = options.tags
        .map(option => `<option value="${escapeHtml(option.value)}"${browseState.tag === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
        .join('');
    const folderOptions = options.folders
        .map(option => `<option value="${escapeHtml(option.value)}"${browseState.folder === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
        .join('');

    return `
        <div class="dle-mobile-tab-toolbar">
            <button class="dle-mobile-wide-action-sm" type="button" data-dle-mobile-command="${commandForView('browse')}" aria-label="${escapeHtml(mt('dle_mobile_aria_full_browse', 'Open full Browse view'))}"><i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i></button>
        </div>
        <div class="dle-mobile-browse-controls">
            <label class="dle-mobile-search">
                <span class="sr-only">${escapeHtml(mt('dle_mobile_browse_search', 'Search entries'))}</span>
                <input type="search" value="${escapeHtml(browseState.query)}" placeholder="${escapeHtml(mt('dle_mobile_browse_search_placeholder', 'Search entries...'))}" data-dle-mobile-browse-field="query">
                <button type="button" data-dle-mobile-action="toggle-browse-help" aria-expanded="${state.browseSearchHelpOpen ? 'true' : 'false'}" aria-label="${escapeHtml(mt('dle_mobile_browse_search_syntax_help', 'Search syntax help'))}">
                    <i class="fa-solid fa-circle-question" aria-hidden="true"></i>
                </button>
            </label>
            ${state.browseSearchHelpOpen ? `<div class="dle-mobile-browse-help">
    <strong>${escapeHtml(mt('dle_mobile_browse_search_syntax', 'Search syntax'))}</strong>
    <div class="dle-mobile-browse-help-grid">
        <div><code>tag:wizard</code> \u2014 ${escapeHtml(mt('dle_mobile_browse_help_tag', 'entries tagged wizard'))}</div>
        <div><code>folder:Locations</code> \u2014 ${escapeHtml(mt('dle_mobile_browse_help_folder', 'entries under Locations/'))}</div>
        <div><code>key:apple</code> \u2014 ${escapeHtml(mt('dle_mobile_browse_help_key', 'keyword exact-match'))}</div>
        <div><code>summary:"old gods"</code> \u2014 ${escapeHtml(mt('dle_mobile_browse_help_summary', 'phrase in summary'))}</div>
        <div><code>field:era=medieval</code> \u2014 ${escapeHtml(mt('dle_mobile_browse_help_field', 'custom-field match'))}</div>
        <div>${escapeHtml(mt('dle_mobile_browse_help_combine', 'Combine prefixes with spaces. Plain words match title/keys/content.'))}</div>
    </div>
</div>` : ''}
            <div class="dle-mobile-browse-filter-grid">
                <select data-dle-mobile-browse-field="status" aria-label="${escapeHtml(mt('dle_mobile_browse_filter_status', 'Status filter'))}">
                    <option value="all"${browseState.status === 'all' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_status', 'Status'))}</option>
                    <option value="injected"${browseState.status === 'injected' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_filter_injected', 'Injected'))}</option>
                    <option value="pinned"${browseState.status === 'pinned' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_action_pinned', 'Pinned'))}</option>
                    <option value="blocked"${browseState.status === 'blocked' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_action_blocked', 'Blocked'))}</option>
                    <option value="constant"${browseState.status === 'constant' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_constant', 'Constant'))}</option>
                    <option value="regular"${browseState.status === 'regular' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_regular', 'Regular'))}</option>
                </select>
                <select data-dle-mobile-browse-field="tag" aria-label="${escapeHtml(mt('dle_mobile_browse_filter_tag', 'Tag filter'))}"><option value="">${escapeHtml(mt('dle_mobile_browse_tags', 'Tags'))}</option>${tagOptions}</select>
                <select data-dle-mobile-browse-field="folder" aria-label="${escapeHtml(mt('dle_mobile_browse_filter_folder', 'Folder filter'))}"><option value="">${escapeHtml(mt('dle_mobile_browse_folder', 'Folder'))}</option>${folderOptions}</select>
                <select data-dle-mobile-browse-field="sort" aria-label="${escapeHtml(mt('dle_mobile_browse_filter_sort', 'Sort entries'))}">
                    <option value="priority_asc"${browseState.sort === 'priority_asc' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_priority', 'Priority'))}</option>
                    <option value="priority_desc"${browseState.sort === 'priority_desc' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_priority_desc', 'Priority desc'))}</option>
                    <option value="alpha_asc"${browseState.sort === 'alpha_asc' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_sort_alpha_asc', 'A-Z'))}</option>
                    <option value="alpha_desc"${browseState.sort === 'alpha_desc' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_sort_alpha_desc', 'Z-A'))}</option>
                    <option value="tokens_desc"${browseState.sort === 'tokens_desc' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_sort_tokens_desc', 'Tokens high'))}</option>
                    <option value="tokens_asc"${browseState.sort === 'tokens_asc' ? ' selected' : ''}>${escapeHtml(mt('dle_mobile_browse_sort_tokens_asc', 'Tokens low'))}</option>
                </select>
            </div>
            <div class="dle-mobile-browse-quick" role="group" aria-label="${escapeHtml(mt('dle_mobile_aria_quick_filters', 'Quick filters'))}">
                <button type="button" data-dle-mobile-browse-quick="since-gen" aria-pressed="${browseState.quick === 'since-gen' ? 'true' : 'false'}">${escapeHtml(mt('dle_mobile_browse_since_generation', 'Since last gen'))}</button>
                <button type="button" data-dle-mobile-browse-quick="never-injected" aria-pressed="${browseState.quick === 'never-injected' ? 'true' : 'false'}">${escapeHtml(mt('dle_mobile_browse_never_injected', 'Never injected'))}</button>
            </div>
            ${filtered.summary ? `<div class="dle-mobile-browse-summary">${escapeHtml(filtered.summary)} <button type="button" data-dle-mobile-browse-clear>${escapeHtml(mt('dle_mobile_browse_clear', 'Clear'))}</button></div>` : ''}
        </div>
        <div class="dle-mobile-browse-list dle-mobile-list">
            ${rows.length ? rows.slice(0, 40).map(row => renderBrowseCard(row, state)).join('') : renderBrowseEmpty(entries, filtered)}
        </div>
    `;
}

function renderBrowseCard(row, state) {
    const expanded = state.browseExpandedKey === row.key;
    const classNames = [
        'dle-mobile-browse-card',
        row.isPinned ? 'dle-mobile-browse-pinned' : '',
        row.isBlocked ? 'dle-mobile-browse-blocked' : '',
        expanded ? 'dle-mobile-browse-expanded' : '',
        row.isInjected ? 'dle-mobile-browse-injected' : '',
    ].filter(Boolean).join(' ');
    const entry = row.entry || {};
    const title = entry.title || row.title || '';
    const vault = entry.vaultSource || '';
    const filename = entry.filename || '';
    const statePills = [
        row.isInjected ? `<span class="dle-mobile-browse-state-pill dle-mobile-browse-state-injected">${escapeHtml(mt('dle_mobile_filter_injected', 'Injected'))}</span>` : '',
        row.isPinned ? `<span class="dle-mobile-browse-state-pill dle-mobile-browse-state-pin">${escapeHtml(mt('dle_mobile_action_pinned', 'Pinned'))}</span>` : '',
        row.isBlocked ? `<span class="dle-mobile-browse-state-pill dle-mobile-browse-state-block">${escapeHtml(mt('dle_mobile_action_blocked', 'Blocked'))}</span>` : '',
    ].filter(Boolean).join('');
    return `
        <article class="${classNames}" data-dle-mobile-browse-key="${escapeHtml(row.key)}">
            <div class="dle-mobile-browse-title-row">
                <button type="button" data-dle-mobile-browse-expand="${escapeHtml(row.key)}" aria-expanded="${expanded ? 'true' : 'false'}">
                    <strong>${escapeHtml(row.title)}</strong>
                </button>
                <span>${escapeHtml(row.priorityLabel)}</span>
            </div>
            <div class="dle-mobile-browse-meta">
                <span>${escapeHtml(row.folderLabel)}</span>
                ${row.keysLabel ? `<span>${escapeHtml(row.keysLabel)}</span>` : ''}
                ${row.tokenLabel ? `<span>${escapeHtml(row.tokenLabel)}</span>` : ''}
                ${row.injectedCount ? `<span>${escapeHtml(row.injectedCount)}x</span>` : ''}
            </div>
            ${statePills ? `<div class="dle-mobile-browse-states">${statePills}</div>` : ''}
            <div class="dle-mobile-browse-actions">
                <button type="button" data-dle-mobile-browse-action="pin" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}" aria-pressed="${row.isPinned ? 'true' : 'false'}">${escapeHtml(row.isPinned ? mt('dle_mobile_action_pinned', 'Pinned') : mt('dle_mobile_action_pin', 'Pin'))}</button>
                <button type="button" data-dle-mobile-browse-action="block" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}" aria-pressed="${row.isBlocked ? 'true' : 'false'}">${escapeHtml(row.isBlocked ? mt('dle_mobile_action_blocked', 'Blocked') : mt('dle_mobile_action_block', 'Block'))}</button>
                <button type="button" data-dle-mobile-browse-action="copy" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}">${escapeHtml(mt('dle_mobile_action_copy', 'Copy'))}</button>
                ${filename ? `<button type="button" data-dle-mobile-browse-action="obsidian" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}">${escapeHtml(mt('dle_mobile_action_open', 'Open'))}</button>` : ''}
            </div>
            ${expanded ? `<div class="dle-mobile-browse-preview">${escapeHtml(row.preview)}</div>` : ''}
        </article>
    `;
}

function renderBrowseEmpty(entries, filtered) {
    const title = entries.length ? mt('dle_mobile_browse_empty_filtered_title', 'No entries match') : mt('dle_mobile_browse_empty_unloaded_title', 'No entries loaded');
    const detail = entries.length && filtered.isFiltered ? mt('dle_mobile_browse_empty_filtered_detail', 'Clear filters or open the full Browse view.') : mt('dle_mobile_browse_empty_unloaded_detail', 'Refresh the vault index first.');
    return `<div class="dle-mobile-browse-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function renderLibrarian(snapshot) {
    const loreGaps = Array.isArray(snapshot.loreGaps) ? snapshot.loreGaps : [];
    const rows = loreGaps.slice(0, 6).map(gap => `
        <li>
            <strong>${escapeHtml(gap.title || gap.id || mt('dle_mobile_librarian_gap', 'Lore gap'))}</strong>
            <span>${escapeHtml(gap.reason || gap.description || mt('dle_mobile_librarian_needs_review', 'Needs review'))}</span>
        </li>
    `).join('');

    return `
        <ul class="dle-mobile-list">${rows || `<li><strong>${escapeHtml(mt('dle_mobile_librarian_empty_title', 'No open gaps'))}</strong><span>${escapeHtml(mt('dle_mobile_librarian_empty_detail', 'Librarian has nothing waiting.'))}</span></li>`}</ul>
    `;
}

function renderModeButton(label, mode, activeMode) {
    const pressed = mode === activeMode ? 'true' : 'false';
    return `
        <button class="dle-mobile-mode-btn" type="button" data-dle-mobile-mode="${escapeHtml(mode)}" aria-pressed="${pressed}">
            ${escapeHtml(label)}
        </button>
    `;
}

function renderTools(mode = 'auto') {
    return `
        <div class="dle-mobile-actions">
            ${renderCommandButton(mt('dle_mobile_tools_health', 'Health'), 'fa-heart-pulse', commandForView('health'))}
            ${renderCommandButton(mt('dle_mobile_tab_filters', 'Filters'), 'fa-filter', commandForView('filters'))}
            ${renderCommandButton(mt('dle_mobile_quick_graph', 'Graph'), 'fa-diagram-project', commandForView('graph'))}
            ${renderCommandButton(mt('dle_mobile_tools_setup', 'Setup'), 'fa-gear', commandForView('setup'))}
        </div>
        <button class="dle-mobile-wide-action" type="button" data-dle-mobile-refresh>${escapeHtml(mt('dle_mobile_tools_refresh', 'Refresh index'))}</button>
        <div class="dle-mobile-mode-group" role="group" aria-label="${escapeHtml(mt('dle_mobile_aria_mobile_mode', 'Mobile UI mode'))}">
            <span>${escapeHtml(mt('dle_mobile_mode_label', 'Mobile UI'))}</span>
            <div>
                ${renderModeButton(mt('dle_mobile_mode_auto', 'Auto'), 'auto', mode)}
                ${renderModeButton(mt('dle_mobile_mode_force', 'Force'), 'forced', mode)}
                ${renderModeButton(mt('dle_mobile_mode_off', 'Off'), 'disabled', mode)}
            </div>
        </div>
    `;
}

function renderFiltersStub() {
    return `
        <div class="dle-mobile-filters-stub">
            <strong>${escapeHtml(mt('dle_mobile_filters_title', 'Filters are coming to mobile'))}</strong>
            <span>${escapeHtml(mt('dle_mobile_filters_detail', 'Folder and gating filters will land here. Until then, use the full desktop view.'))}</span>
            <button class="dle-mobile-wide-action" type="button" data-dle-mobile-command="${commandForView('filters')}">${escapeHtml(mt('dle_mobile_filters_full', 'Open full Filters view'))}</button>
        </div>
    `;
}

function renderBody(snapshot, tab, mode = 'auto', state = mobileState) {
    switch (normalizeMobileTab(tab)) {
        case 'browse': return renderBrowse(snapshot, state);
        case 'filters': return renderFiltersStub();
        case 'librarian': return renderLibrarian(snapshot);
        case 'tools': return renderTools(mode);
        default: return renderInjection(snapshot, state);
    }
}

function renderTabContent(snapshot, state) {
    try {
        return renderBody(snapshot, state.tab, state.mode, state);
    } catch (err) {
        console.error('[DLE] Mobile tab render failed:', state.tab, err);
        return renderOverlayError(mtf('dle_mobile_error_render', 'Could not render ${0}: ${1}', state.tab, err?.message || err));
    }
}

function renderMobileShellContents(snapshot, state = mobileState, contentEntering = false, panelOpening = false) {
    return renderOverlay({
        snapshot,
        uiState: state,
        contentHtml: renderTabContent(snapshot, state),
        skipLibrarianActive: suppressNextAgenticLoop,
        contentEntering,
        panelOpening,
    });
}

export function renderMobileShell(snapshot, state = createMobileUiState()) {
    return `<div id="${ROOT_ID}" class="dle-mobile-shell">${renderMobileShellContents(snapshot, state)}</div>`;
}

function setMobileError(message) {
    mobileState.errorMessage = message || '';
    if (mobileState.errorMessage) mobileState.open = true;
}

function executeCommand(command) {
    if (!command) {
        setMobileError(mt('dle_mobile_error_no_command', 'No mobile command is configured for this action.'));
        renderCurrentState();
        return;
    }
    const ctx = getContext();
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(command).catch(err => {
            console.error('[DLE] Mobile command error:', command, err);
            setMobileError(mtf('dle_mobile_error_command_failed', 'Command failed: ${0}', command));
            renderCurrentState();
        });
    } else {
        console.warn('[DLE] Cannot execute mobile command; SillyTavern context unavailable:', command);
        setMobileError(mtf('dle_mobile_error_cannot_execute', 'Cannot execute ${0}', command));
        renderCurrentState();
    }
}

async function readMetadataApi() {
    const script = await import('../../../../../../script.js');
    const extensions = await import('../../../../../extensions.js');
    return {
        chatMetadata: script.chat_metadata,
        saveMetadataDebounced: extensions.saveMetadataDebounced,
    };
}

export async function runMobileReroll({
    resetSearchCache = resetAiSearchCache,
    readMetadata = readMetadataApi,
    notify = message => globalThis.toastr?.info?.(message, 'DeepLore'),
} = {}) {
    resetSearchCache?.();
    try {
        const { chatMetadata, saveMetadataDebounced } = await readMetadata();
        if (Array.isArray(chatMetadata?.deeplore_injection_log)) {
            chatMetadata.deeplore_injection_log = [];
            saveMetadataDebounced?.();
        }
        notify?.(mt('dle_mobile_toast_reroll', 'Search cache cleared \u2014 next generation will re-select lore.'));
        return { metadataCleared: true };
    } catch (error) {
        console.warn('[DLE] Mobile reroll: injection log not cleared:', error?.message || error);
        return { metadataCleared: false, error };
    }
}

function samePinBlock(item, title, vaultSource) {
    const normalized = normalizePinBlock(item || '');
    return normalized.title.toLowerCase() === String(title || '').toLowerCase()
        && (normalized.vaultSource || null) === (vaultSource || null);
}

async function toggleMobileBrowsePin(title, vaultSource) {
    const { chatMetadata, saveMetadataDebounced } = await readMetadataApi();
    if (!chatMetadata || !title) return;
    if (!chatMetadata.deeplore_pins) chatMetadata.deeplore_pins = [];
    const idx = chatMetadata.deeplore_pins.findIndex(item => samePinBlock(item, title, vaultSource));
    if (idx >= 0) chatMetadata.deeplore_pins.splice(idx, 1);
    else {
        chatMetadata.deeplore_pins.push({ title, vaultSource: vaultSource || null });
        if (chatMetadata.deeplore_blocks) {
            chatMetadata.deeplore_blocks = chatMetadata.deeplore_blocks.filter(item => !samePinBlock(item, title, vaultSource));
        }
    }
    saveMetadataDebounced();
    notifyPinBlockChanged();
}

async function toggleMobileBrowseBlock(title, vaultSource) {
    const { chatMetadata, saveMetadataDebounced } = await readMetadataApi();
    if (!chatMetadata || !title) return;
    if (!chatMetadata.deeplore_blocks) chatMetadata.deeplore_blocks = [];
    const idx = chatMetadata.deeplore_blocks.findIndex(item => samePinBlock(item, title, vaultSource));
    if (idx >= 0) chatMetadata.deeplore_blocks.splice(idx, 1);
    else {
        chatMetadata.deeplore_blocks.push({ title, vaultSource: vaultSource || null });
        if (chatMetadata.deeplore_pins) {
            chatMetadata.deeplore_pins = chatMetadata.deeplore_pins.filter(item => !samePinBlock(item, title, vaultSource));
        }
    }
    saveMetadataDebounced();
    notifyPinBlockChanged();
}

async function copyMobileBrowseTitle(title) {
    if (!title) return;
    try {
        await navigator.clipboard.writeText(title);
        mobileState.errorMessage = '';
    } catch {
        setMobileError(mt('dle_mobile_error_clipboard', 'Clipboard access denied.'));
    }
}

function openMobileBrowseObsidian(filename, vaultSource) {
    const settings = mobileShellOptions.getSettings?.() ?? {};
    const vault = vaultSource && settings.vaults ? settings.vaults.find(v => v.name === vaultSource) : null;
    const vaultName = vault?.name || vaultSource || settings.vaults?.[0]?.name || '';
    const uri = filename ? buildObsidianURI(vaultName, filename) : null;
    if (!uri) {
        setMobileError(mt('dle_mobile_error_obsidian', 'Could not open Obsidian link from this browser context.'));
        return false;
    }
    openObsidianUri(uri);
    return true;
}

function ensureRoot() {
    if (mobileRoot && document.body.contains(mobileRoot)) return mobileRoot;
    mobileRoot = document.getElementById(ROOT_ID);
    if (!mobileRoot) {
        mobileRoot = document.createElement('div');
        mobileRoot.id = ROOT_ID;
        mobileRoot.className = 'dle-mobile-shell';
        mobileRoot.hidden = true;
        document.body.appendChild(mobileRoot);
    }
    return mobileRoot;
}

// Tab whose content the mounted DOM currently shows while open; '' when the
// last render was closed/inactive so stale captures cannot wipe saved scroll.
let renderedScrollTab = '';
// Whether the previous render showed the overlay open — drives the one-shot
// open animation so re-renders do not replay it (visible as a UI blink).
let renderedOpen = false;
// One-shot request to play the content fade on the next render even though
// the tab itself did not change (e.g. injection filter pill switches).
let pendingContentTransition = false;

function captureScrollPosition() {
    if (!renderedScrollTab) return;
    const content = mobileRoot?.querySelector?.('.dle-mobile-overlay-content');
    if (content) mobileState.scrollPositions[renderedScrollTab] = content.scrollTop || 0;
}

function restoreScrollPosition() {
    const content = mobileRoot?.querySelector?.('.dle-mobile-overlay-content');
    if (content) content.scrollTop = mobileState.scrollPositions[mobileState.tab] || 0;
}

function renderCurrentState() {
    const root = ensureRoot();
    const env = readMobileEnvironment();
    const active = shouldUseMobileUi(env);
    mobileState.active = active;
    mobileState.mode = readMobileMode(env);
    root.hidden = !active;
    document.body.classList.toggle('dle-mobile-ui-active', active);
    if (!active) {
        setFabVisible(false); // desktop keeps the drawer; no glass orb
        return;
    }

    const snapshot = buildMobileShellSnapshot();
    const tabChanged = !!(mobileState.open && renderedScrollTab && renderedScrollTab !== mobileState.tab);
    const entering = tabChanged || (mobileState.open && pendingContentTransition);
    pendingContentTransition = false;
    const opening = mobileState.open && !renderedOpen;
    captureScrollPosition();
    root.innerHTML = renderMobileShellContents(snapshot, mobileState, entering, opening);
    renderedScrollTab = mobileState.open ? mobileState.tab : '';
    renderedOpen = mobileState.open;
    restoreScrollPosition();

    updateBadge(snapshot.injectedCount || 0);
    setFabVisible(!mobileState.open);
}

function handleMobileClick(event) {
    const root = ensureRoot();
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;

    const actionEl = target.closest('[data-dle-mobile-action]');
    if (actionEl) {
        const action = actionEl.getAttribute('data-dle-mobile-action');
        if (action === 'quick-skip-librarian') {
            const next = !suppressNextAgenticLoop;
            setSuppressNextAgenticLoop(next);
            globalThis.toastr?.info?.(
                next ? mt('dle_mobile_toast_librarian_skipped', 'Librarian tools will be skipped for the next generation.') : mt('dle_mobile_toast_librarian_enabled', 'Librarian tools re-enabled.'),
                'DeepLore',
            );
            renderCurrentState();
            return;
        }
        if (action === 'quick-reroll') {
            void runMobileReroll().finally(renderCurrentState);
            return;
        }
        // Unknown quick-* actions bail before clearing errorMessage so a stale
        // error is not silently dismissed by an unrecognised tap.
        if (action?.startsWith('quick-')) return;
        mobileState.errorMessage = '';
        if (action === 'toggle-browse-help') {
            mobileState.browseSearchHelpOpen = !mobileState.browseSearchHelpOpen;
            mobileState.open = true;
            renderCurrentState();
            return;
        }
        if (action === 'toggle') mobileState.open = !mobileState.open;
        if (action === 'close') mobileState.open = false;
        if (action === 'toggle-stats') {
            mobileState.statsExpanded = !mobileState.statsExpanded;
            mobileState.open = true;
        }
        if (action === 'settings') {
            import('../ui/settings-ui.js')
                .then(m => m.openSettingsPopup?.())
                .catch(err => {
                    console.error('[DLE] Mobile settings open failed:', err);
                    setMobileError(mt('dle_mobile_error_settings', 'Could not open DeepLore settings.'));
                    renderCurrentState();
                });
            return;
        }
        renderCurrentState();
        return;
    }

    const tabEl = target.closest('[data-dle-mobile-tab]');
    if (tabEl) {
        mobileState.errorMessage = '';
        mobileState.tab = normalizeMobileTab(tabEl.getAttribute('data-dle-mobile-tab'));
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const quickEl = target.closest('[data-dle-mobile-browse-quick]');
    if (quickEl) {
        const quick = quickEl.getAttribute('data-dle-mobile-browse-quick') || '';
        const current = normalizeMobileBrowseState(mobileState.browse);
        mobileState.browse = normalizeMobileBrowseState({ ...current, quick: current.quick === quick ? '' : quick });
        mobileState.browseExpandedKey = '';
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const clearEl = target.closest('[data-dle-mobile-browse-clear]');
    if (clearEl) {
        mobileState.browse = normalizeMobileBrowseState();
        mobileState.browseExpandedKey = '';
        mobileState.browseSearchHelpOpen = false;
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const expandEl = target.closest('[data-dle-mobile-browse-expand]');
    if (expandEl) {
        const key = expandEl.getAttribute('data-dle-mobile-browse-expand') || '';
        mobileState.browseExpandedKey = mobileState.browseExpandedKey === key ? '' : key;
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const browseActionEl = target.closest('[data-dle-mobile-browse-action]');
    if (browseActionEl) {
        const action = browseActionEl.getAttribute('data-dle-mobile-browse-action');
        const title = browseActionEl.getAttribute('data-title') || '';
        const vaultSource = browseActionEl.getAttribute('data-vault') || '';
        const filename = browseActionEl.getAttribute('data-filename') || '';
        Promise.resolve()
            .then(() => {
                if (action === 'pin') return toggleMobileBrowsePin(title, vaultSource || null);
                if (action === 'block') return toggleMobileBrowseBlock(title, vaultSource || null);
                if (action === 'copy') return copyMobileBrowseTitle(title);
                if (action === 'obsidian') return openMobileBrowseObsidian(filename, vaultSource || null);
                return null;
            })
            .catch(err => {
                console.error('[DLE] Mobile Browse action failed:', action, err);
                setMobileError(mtf('dle_mobile_error_browse_action', 'Browse action failed: ${0}', action));
            })
            .finally(renderCurrentState);
        return;
    }

    const injectionFilterEl = target.closest('[data-dle-mobile-injection-filter]');
    if (injectionFilterEl) {
        mobileState.injectionFilter = injectionFilterEl.getAttribute('data-dle-mobile-injection-filter') || 'injected';
        mobileState.injectionExpandedKey = '';
        mobileState.tab = 'injection';
        mobileState.open = true;
        pendingContentTransition = true; // filter pills swap the whole list — fade it
        renderCurrentState();
        return;
    }

    const injectionExpandEl = target.closest('[data-dle-mobile-injection-expand]');
    if (injectionExpandEl) {
        const key = injectionExpandEl.getAttribute('data-dle-mobile-injection-expand') || '';
        mobileState.injectionExpandedKey = mobileState.injectionExpandedKey === key ? '' : key;
        mobileState.open = true;
        renderCurrentState();
        return;
    }

    const injectionActionEl = target.closest('[data-dle-mobile-injection-action]');
    if (injectionActionEl) {
        const action = injectionActionEl.getAttribute('data-dle-mobile-injection-action');
        if (action === 'copy-titles') {
            const sources = buildMobileShellSnapshot().injectedSources;
            const titles = sources.map(s => s.title).filter(Boolean).join('\n');
            if (titles) {
                try {
                    navigator.clipboard.writeText(titles).catch(() => {
                        setMobileError(mt('dle_mobile_error_clipboard', 'Clipboard access denied.'));
                        renderCurrentState();
                    });
                } catch {
                    setMobileError(mt('dle_mobile_error_clipboard', 'Clipboard access denied.'));
                }
            }
        } else if (action === 'obsidian') {
            const filename = injectionActionEl.getAttribute('data-filename') || '';
            const vaultSource = injectionActionEl.getAttribute('data-vault') || '';
            openMobileBrowseObsidian(filename, vaultSource || null);
        } else if (action === 'browse') {
            const title = injectionActionEl.getAttribute('data-title') || '';
            const vaultSource = injectionActionEl.getAttribute('data-vault') || '';
            const currentBrowse = normalizeMobileBrowseState(mobileState.browse);
            mobileState.tab = 'browse';
            mobileState.open = true;
            mobileState.errorMessage = '';
            if (title) {
                mobileState.browse = normalizeMobileBrowseState({ sort: currentBrowse.sort, query: title });
                mobileState.browseExpandedKey = `${vaultSource || ''}:${title}`;
            }
        }
        renderCurrentState();
        return;
    }

    const modeEl = target.closest('[data-dle-mobile-mode]');
    if (modeEl) {
        const mode = modeEl.getAttribute('data-dle-mobile-mode') || 'auto';
        mobileState.mode = setMobileMode(mode);
        if (mobileState.mode === 'disabled') {
            mobileState.open = false;
        } else {
            mobileState.open = true;
        }
        renderCurrentState();
        return;
    }

    const refreshEl = target.closest('[data-dle-mobile-refresh]');
    if (refreshEl) {
        mobileState.open = true;
        renderCurrentState();
        Promise.resolve()
            .then(() => mobileShellOptions.buildIndex?.())
            .catch(err => {
                console.error('[DLE] Mobile refresh error:', err);
                setMobileError(mtf('dle_mobile_error_refresh', 'Refresh failed: ${0}', err?.message || err));
                renderCurrentState();
            });
        return;
    }

    const commandEl = target.closest('[data-dle-mobile-command]');
    if (commandEl) {
        executeCommand(commandEl.getAttribute('data-dle-mobile-command'));
    }
}

function handleMobileInput(event) {
    const root = ensureRoot();
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;

    const fieldEl = target.closest('[data-dle-mobile-browse-field]');
    if (!fieldEl) return;
    const field = fieldEl.getAttribute('data-dle-mobile-browse-field');
    if (!Object.prototype.hasOwnProperty.call(normalizeMobileBrowseState(), field)) return;

    mobileState.browse = normalizeMobileBrowseState({
        ...mobileState.browse,
        [field]: fieldEl.value ?? fieldEl.getAttribute('value') ?? '',
    });
    mobileState.browseExpandedKey = '';
    mobileState.open = true;
    renderCurrentState();
}

let mobileShellOptions = {};

// ── Swipe-to-dismiss touch tracking ──────────────────────────────────────────
let swipeTracking = null;

function handleMobileTouchStart(event) {
    if (swipeTracking) return; // already tracking; ignore additional fingers
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('[data-dle-mobile-swipe-handle]')) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    swipeTracking = { startY: touch.clientY, startTime: Date.now(), dy: 0 };
}

function handleMobileTouchMove(event) {
    if (!swipeTracking) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    swipeTracking.dy = touch.clientY - swipeTracking.startY;
    const panel = mobileRoot?.querySelector?.('.dle-mobile-overlay-panel');
    if (panel && swipeTracking.dy > 0) {
        panel.style.transform = `translateY(${swipeTracking.dy}px)`;
    }
}

function clearSwipeTransform() {
    const panel = mobileRoot?.querySelector?.('.dle-mobile-overlay-panel');
    if (panel?.style) panel.style.transform = '';
}

function handleMobileTouchEnd() {
    if (!swipeTracking) return;
    const { dy, startTime } = swipeTracking;
    swipeTracking = null;
    const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800;
    if (shouldDismissSwipe({ dy, durationMs: Date.now() - startTime, viewportHeight })) {
        mobileState.open = false;
        renderCurrentState();
        return;
    }
    // Plain tap or aborted drag: clear the inline transform WITHOUT a full
    // re-render — replacing the DOM here destroys the element the browser is
    // about to dispatch the synthesized click on, which made header buttons
    // (stats toggle, gear, X) intermittently swallow taps on real devices.
    clearSwipeTransform();
}

function handleMobileTouchCancel() {
    // OS took over the gesture (scroll hand-off, notification, call):
    // no touchend will follow, so disarm and drop any stuck translateY.
    if (!swipeTracking) return;
    swipeTracking = null;
    clearSwipeTransform();
}

export function createMobileShell(options = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    configureMobileI18n({ translate: options.translate, format: options.format });

    mobileShellOptions = options;
    const root = ensureRoot();
    root.removeEventListener('click', handleMobileClick);
    root.removeEventListener('input', handleMobileInput);
    root.removeEventListener('change', handleMobileInput);
    root.addEventListener('click', handleMobileClick);
    root.addEventListener('input', handleMobileInput);
    root.addEventListener('change', handleMobileInput);
    root.removeEventListener('touchstart', handleMobileTouchStart);
    root.removeEventListener('touchmove', handleMobileTouchMove);
    root.removeEventListener('touchend', handleMobileTouchEnd);
    root.removeEventListener('touchcancel', handleMobileTouchCancel);
    root.addEventListener('touchstart', handleMobileTouchStart, { passive: true });
    root.addEventListener('touchmove', handleMobileTouchMove, { passive: true });
    root.addEventListener('touchend', handleMobileTouchEnd);
    root.addEventListener('touchcancel', handleMobileTouchCancel, { passive: true });

    for (const unsubscribe of mobileUnsubscribers) {
        try { unsubscribe(); } catch { /* noop */ }
    }
    mobileUnsubscribers = [
        onIndexUpdated(renderCurrentState),
        onIndexingChanged(renderCurrentState),
        onPipelineComplete(renderCurrentState),
        onGenerationLockChanged(renderCurrentState),
        onLoreGapsChanged(renderCurrentState),
        onPipelinePhaseChanged(renderCurrentState),
        onAiStatsUpdated(renderCurrentState),
        onCircuitStateChanged(renderCurrentState),
        subscribeMobileVerdict(mobileShellOptions.onVerdictChanged, renderCurrentState),
    ];

    if (mobileResizeHandler) window.removeEventListener('resize', mobileResizeHandler);
    mobileResizeHandler = () => window.requestAnimationFrame(renderCurrentState);
    window.addEventListener('resize', mobileResizeHandler);

    if (mobileMediaQuery?.removeEventListener && mobileResizeHandler) {
        mobileMediaQuery.removeEventListener('change', mobileResizeHandler);
    }
    mobileMediaQuery = window.matchMedia?.('(pointer: coarse)');
    mobileMediaQuery?.addEventListener?.('change', mobileResizeHandler);

    destroyFab();
    createFab({
        onTap: () => {
            mobileState.open = !mobileState.open;
            renderCurrentState();
        },
    });

    renderCurrentState();
    return root;
}

export function destroyMobileShell() {
    destroyFab();
    renderedScrollTab = '';
    renderedOpen = false;
    for (const unsubscribe of mobileUnsubscribers) {
        try { unsubscribe(); } catch { /* noop */ }
    }
    mobileUnsubscribers = [];
    if (mobileRoot) {
        mobileRoot.removeEventListener('click', handleMobileClick);
        mobileRoot.removeEventListener('input', handleMobileInput);
        mobileRoot.removeEventListener('change', handleMobileInput);
        mobileRoot.removeEventListener('touchstart', handleMobileTouchStart);
        mobileRoot.removeEventListener('touchmove', handleMobileTouchMove);
        mobileRoot.removeEventListener('touchend', handleMobileTouchEnd);
        mobileRoot.removeEventListener('touchcancel', handleMobileTouchCancel);
        mobileRoot.remove();
        mobileRoot = null;
    }
    swipeTracking = null;
    if (mobileResizeHandler && typeof window !== 'undefined') {
        window.removeEventListener('resize', mobileResizeHandler);
    }
    if (mobileMediaQuery?.removeEventListener && mobileResizeHandler) {
        mobileMediaQuery.removeEventListener('change', mobileResizeHandler);
    }
    mobileResizeHandler = null;
    mobileMediaQuery = null;
    if (typeof document !== 'undefined') {
        document.body.classList.remove('dle-mobile-ui-active');
    }
    mobileShellOptions = {};
    mobileState = createMobileUiState();
    resetMobileI18n();
}
