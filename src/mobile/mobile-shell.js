import {
    aiSearchStats,
    chatInjectionCounts,
    computeOverallStatus,
    vaultIndex,
    indexing,
    indexEverLoaded,
    generationLock,
    lastInjectionSources,
    lastPipelineTrace,
    librarianChatStats,
    loreGaps,
    pipelinePhase,
    onAiStatsUpdated,
    onCircuitStateChanged,
    onIndexUpdated,
    onIndexingChanged,
    onInjectionSourcesReady,
    onPipelineComplete,
    onGenerationLockChanged,
    onLoreGapsChanged,
    onPipelinePhaseChanged,
    onPipelineTraceUpdated,
} from '../state.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import {
    buildMobileBrowseOptions,
    buildMobileBrowseRows,
    filterMobileBrowseEntries,
    normalizeMobileBrowseState,
} from './mobile-browse.js';
import { buildMobileStatusStats } from './mobile-stats.js';

export const MOBILE_VIEWPORT_WIDTH = 768;
export const TOUCH_TABLET_WIDTH = 1024;
export const MOBILE_FORCE_STORAGE_KEY = 'dleMobileUiForce';
export const MOBILE_DISABLE_STORAGE_KEY = 'dleMobileUiDisabled';

const ROOT_ID = 'dle-mobile-root';
const FORCE_KEY = MOBILE_FORCE_STORAGE_KEY;
const DISABLE_KEY = MOBILE_DISABLE_STORAGE_KEY;

let mobileRoot = null;
let mobileState = {
    open: false,
    view: 'home',
    active: false,
    mode: 'auto',
    errorMessage: '',
    statsExpanded: false,
    browse: normalizeMobileBrowseState(),
    browseSearchHelpOpen: false,
    browseExpandedKey: '',
};
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
        mobileState.errorMessage = `Could not save mobile mode: ${err.message || err}`;
        return readMobileMode();
    }
}

function commandForView(view) {
    const commands = {
        why: '/dle-why',
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
    if (source.indexing) return 'Indexing';
    if (source.generationLock || source.pipelinePhase !== 'idle') return 'Working';
    if (!source.indexEverLoaded) return 'Not ready';
    return 'Ready';
}

export function buildMobileShellSnapshot(source = {}) {
    const state = {
        vaultIndex: source.vaultIndex ?? vaultIndex,
        indexing: source.indexing ?? indexing,
        generationLock: source.generationLock ?? generationLock,
        pipelinePhase: source.pipelinePhase ?? pipelinePhase,
        lastInjectionSources: source.lastInjectionSources ?? lastInjectionSources,
        loreGaps: source.loreGaps ?? loreGaps,
        indexEverLoaded: source.indexEverLoaded ?? indexEverLoaded,
    };

    const entryCount = Array.isArray(state.vaultIndex) ? state.vaultIndex.length : 0;
    const gapCount = Array.isArray(state.loreGaps) ? state.loreGaps.length : 0;
    const injectedCount = countInjected(state.lastInjectionSources);
    const context = getContext();
    const settings = source.settings ?? mobileShellOptions.getSettings?.() ?? {};
    const drawerState = source.drawerState ?? mobileShellOptions.getDrawerState?.() ?? {};
    const circuitState = source.circuitState ?? mobileShellOptions.getCircuitState?.() ?? getCircuitState();
    const overallStatus = source.overallStatus ?? computeOverallStatus(circuitState);
    const browseContext = source.browseContext || {
        pins: globalThis.chat_metadata?.deeplore_pins || [],
        blocks: globalThis.chat_metadata?.deeplore_blocks || [],
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
        lastPipelineTrace: source.lastPipelineTrace ?? lastPipelineTrace,
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
        injectedSources: Array.isArray(state.lastInjectionSources) ? state.lastInjectionSources : [],
        entries: Array.isArray(state.vaultIndex) ? state.vaultIndex : [],
        loreGaps: Array.isArray(state.loreGaps) ? state.loreGaps : [],
        stats,
        browseContext,
    };
}

function renderPill(label, value, tone = '') {
    const toneClass = tone ? ` dle-mobile-pill-${tone}` : '';
    return `<div class="dle-mobile-pill${toneClass}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderActionButton(label, view, icon, command = '') {
    const commandAttr = command ? ` data-dle-mobile-command="${escapeHtml(command)}"` : '';
    return `
        <button class="dle-mobile-action" type="button" data-dle-mobile-view="${escapeHtml(view)}"${commandAttr}>
            <i class="fa-solid ${escapeHtml(icon)}" aria-hidden="true"></i>
            <span>${escapeHtml(label)}</span>
        </button>
    `;
}

function renderStatusMetric(metric) {
    const ratio = Math.max(0, Math.min(100, Number(metric?.ratio || 0)));
    return `
        <div class="dle-mobile-status-metric dle-mobile-status-${escapeHtml(metric?.tone || 'ok')}">
            <span>${escapeHtml(metric?.label || '')}</span>
            <strong>${escapeHtml(metric?.value || '')}</strong>
            ${metric?.detail ? `<small>${escapeHtml(metric.detail)}</small>` : ''}
            <div class="dle-mobile-status-bar" aria-hidden="true"><span style="width:${ratio}%"></span></div>
        </div>
    `;
}

function renderStatusTray(snapshot, state) {
    const stats = snapshot.stats;
    if (!stats) return '';
    const expandedClass = state.statsExpanded ? ' dle-mobile-status-expanded' : '';
    return `
        <section class="dle-mobile-status-tray${expandedClass}" aria-label="DeepLore status">
            <button type="button" class="dle-mobile-status-toggle" data-dle-mobile-action="toggle-stats" aria-expanded="${state.statsExpanded ? 'true' : 'false'}">
                <span>${escapeHtml(stats.collapsed.label)}</span>
                <strong>${escapeHtml(snapshot.injectedCount)} injected</strong>
                <i class="fa-solid fa-chevron-${state.statsExpanded ? 'down' : 'up'}" aria-hidden="true"></i>
            </button>
            ${state.statsExpanded ? `<div class="dle-mobile-status-grid">
                ${renderStatusMetric(stats.budget)}
                ${renderStatusMetric(stats.entries)}
                ${renderStatusMetric(stats.context)}
                ${renderStatusMetric(stats.ai)}
                ${renderStatusMetric(stats.health)}
            </div>` : ''}
        </section>
    `;
}

function renderHome(snapshot, state = mobileState) {
    return `
        ${renderStatusTray(snapshot, state)}
        <div class="dle-mobile-summary">
            ${renderPill('Status', snapshot.statusLabel, snapshot.statusLabel === 'Ready' ? 'ok' : 'warn')}
            ${renderPill('Vault', snapshot.entriesLabel)}
            ${renderPill('Injected', snapshot.injectedCount)}
            ${renderPill('Gaps', snapshot.gapCount, snapshot.gapCount ? 'warn' : 'ok')}
        </div>
        <div class="dle-mobile-actions">
            ${renderActionButton('Why?', 'why', 'fa-circle-question')}
            ${renderActionButton('Browse', 'browse', 'fa-magnifying-glass')}
            ${renderActionButton('Librarian', 'librarian', 'fa-list-check')}
            ${renderActionButton('Tools', 'tools', 'fa-screwdriver-wrench')}
        </div>
    `;
}

function renderWhy(snapshot) {
    const injectedSources = Array.isArray(snapshot.injectedSources) ? snapshot.injectedSources : [];
    const rows = injectedSources.slice(0, 6).map(source => `
        <li>
            <strong>${escapeHtml(source.title || 'Untitled')}</strong>
            <span>${escapeHtml(source.matchedBy || 'selected')}</span>
        </li>
    `).join('');

    return `
        <div class="dle-mobile-drill-header">
            <button type="button" data-dle-mobile-view="home"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <strong>Why?</strong>
        </div>
        <ul class="dle-mobile-list">${rows || '<li><strong>No lore injected yet</strong><span>Run a generation to populate this.</span></li>'}</ul>
        <button class="dle-mobile-wide-action" type="button" data-dle-mobile-command="${commandForView('why')}">Open full Why view</button>
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
        <div class="dle-mobile-drill-header">
            <button type="button" data-dle-mobile-view="home"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <strong>Browse</strong>
        </div>
        <div class="dle-mobile-browse-controls">
            <label class="dle-mobile-search">
                <span class="sr-only">Search entries</span>
                <input type="search" value="${escapeHtml(browseState.query)}" placeholder="Search entries..." data-dle-mobile-browse-field="query">
                <button type="button" data-dle-mobile-action="toggle-browse-help" aria-expanded="${state.browseSearchHelpOpen ? 'true' : 'false'}" aria-label="Search syntax help">
                    <i class="fa-solid fa-circle-question" aria-hidden="true"></i>
                </button>
            </label>
            ${state.browseSearchHelpOpen ? '<div class="dle-mobile-browse-help"><strong>Search syntax</strong><span>tag:character folder:Places key:name summary:rumor field:era=Modern</span></div>' : ''}
            <div class="dle-mobile-browse-filter-grid">
                <select data-dle-mobile-browse-field="status" aria-label="Status filter">
                    <option value="all"${browseState.status === 'all' ? ' selected' : ''}>Status</option>
                    <option value="injected"${browseState.status === 'injected' ? ' selected' : ''}>Injected</option>
                    <option value="pinned"${browseState.status === 'pinned' ? ' selected' : ''}>Pinned</option>
                    <option value="blocked"${browseState.status === 'blocked' ? ' selected' : ''}>Blocked</option>
                    <option value="constant"${browseState.status === 'constant' ? ' selected' : ''}>Constant</option>
                    <option value="regular"${browseState.status === 'regular' ? ' selected' : ''}>Regular</option>
                </select>
                <select data-dle-mobile-browse-field="tag" aria-label="Tag filter"><option value="">Tags</option>${tagOptions}</select>
                <select data-dle-mobile-browse-field="folder" aria-label="Folder filter"><option value="">Folder</option>${folderOptions}</select>
                <select data-dle-mobile-browse-field="sort" aria-label="Sort entries">
                    <option value="priority_asc"${browseState.sort === 'priority_asc' ? ' selected' : ''}>Priority</option>
                    <option value="priority_desc"${browseState.sort === 'priority_desc' ? ' selected' : ''}>Priority desc</option>
                    <option value="alpha_asc"${browseState.sort === 'alpha_asc' ? ' selected' : ''}>A-Z</option>
                    <option value="alpha_desc"${browseState.sort === 'alpha_desc' ? ' selected' : ''}>Z-A</option>
                    <option value="tokens_desc"${browseState.sort === 'tokens_desc' ? ' selected' : ''}>Tokens high</option>
                    <option value="tokens_asc"${browseState.sort === 'tokens_asc' ? ' selected' : ''}>Tokens low</option>
                </select>
            </div>
            <div class="dle-mobile-browse-quick" role="group" aria-label="Quick filters">
                <button type="button" data-dle-mobile-browse-quick="since-gen" aria-pressed="${browseState.quick === 'since-gen' ? 'true' : 'false'}">Since last gen</button>
                <button type="button" data-dle-mobile-browse-quick="never-injected" aria-pressed="${browseState.quick === 'never-injected' ? 'true' : 'false'}">Never injected</button>
            </div>
            ${filtered.summary ? `<div class="dle-mobile-browse-summary">${escapeHtml(filtered.summary)} <button type="button" data-dle-mobile-browse-clear>Clear</button></div>` : ''}
        </div>
        <div class="dle-mobile-browse-list dle-mobile-list">
            ${rows.length ? rows.slice(0, 40).map(row => renderBrowseCard(row, state)).join('') : renderBrowseEmpty(entries, filtered)}
        </div>
        <button class="dle-mobile-wide-action" type="button" data-dle-mobile-command="${commandForView('browse')}">Open full Browse view</button>
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
            <div class="dle-mobile-browse-actions">
                <button type="button" data-dle-mobile-browse-action="pin" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}" aria-pressed="${row.isPinned ? 'true' : 'false'}">Pin</button>
                <button type="button" data-dle-mobile-browse-action="block" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}" aria-pressed="${row.isBlocked ? 'true' : 'false'}">Block</button>
                <button type="button" data-dle-mobile-browse-action="copy" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}">Copy</button>
                ${filename ? `<button type="button" data-dle-mobile-browse-action="obsidian" data-title="${escapeHtml(title)}" data-vault="${escapeHtml(vault)}" data-filename="${escapeHtml(filename)}">Open</button>` : ''}
            </div>
            ${expanded ? `<div class="dle-mobile-browse-preview">${escapeHtml(row.preview)}</div>` : ''}
        </article>
    `;
}

function renderBrowseEmpty(entries, filtered) {
    const title = entries.length ? 'No entries match' : 'No entries loaded';
    const detail = entries.length && filtered.isFiltered ? 'Clear filters or open the full Browse view.' : 'Refresh the vault index first.';
    return `<div class="dle-mobile-browse-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function renderLibrarian(snapshot) {
    const loreGaps = Array.isArray(snapshot.loreGaps) ? snapshot.loreGaps : [];
    const rows = loreGaps.slice(0, 6).map(gap => `
        <li>
            <strong>${escapeHtml(gap.title || gap.id || 'Lore gap')}</strong>
            <span>${escapeHtml(gap.reason || gap.description || 'Needs review')}</span>
        </li>
    `).join('');

    return `
        <div class="dle-mobile-drill-header">
            <button type="button" data-dle-mobile-view="home"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <strong>Librarian</strong>
        </div>
        <ul class="dle-mobile-list">${rows || '<li><strong>No open gaps</strong><span>Librarian has nothing waiting.</span></li>'}</ul>
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
        <div class="dle-mobile-drill-header">
            <button type="button" data-dle-mobile-view="home"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <strong>Tools</strong>
        </div>
        <div class="dle-mobile-actions">
            ${renderActionButton('Health', 'health', 'fa-heart-pulse', commandForView('health'))}
            ${renderActionButton('Filters', 'filters', 'fa-filter', commandForView('filters'))}
            ${renderActionButton('Graph', 'graph', 'fa-diagram-project', commandForView('graph'))}
            ${renderActionButton('Setup', 'setup', 'fa-gear', commandForView('setup'))}
        </div>
        <button class="dle-mobile-wide-action" type="button" data-dle-mobile-refresh>Refresh index</button>
        <div class="dle-mobile-mode-group" role="group" aria-label="Mobile UI mode">
            <span>Mobile UI</span>
            <div>
                ${renderModeButton('Auto', 'auto', mode)}
                ${renderModeButton('Force', 'forced', mode)}
                ${renderModeButton('Off', 'disabled', mode)}
            </div>
        </div>
    `;
}

function renderBody(snapshot, view, mode = 'auto', state = mobileState) {
    switch (view) {
        case 'why': return renderWhy(snapshot);
        case 'browse': return renderBrowse(snapshot, state);
        case 'librarian': return renderLibrarian(snapshot);
        case 'tools': return renderTools(mode);
        default: return renderHome(snapshot, state);
    }
}

function renderMobileShellContents(snapshot, state = mobileState) {
    const openClass = state.open ? ' dle-mobile-open' : '';
    const mode = state.mode || 'auto';
    const errorMessage = state.errorMessage || '';
    const sheetAriaHidden = state.open ? 'false' : 'true';
    const sheetInert = state.open ? '' : ' inert';
    return `
        <button class="dle-mobile-dock${openClass}" type="button" data-dle-mobile-action="toggle" aria-expanded="${state.open ? 'true' : 'false'}" aria-controls="dle-mobile-sheet">
            <i class="fa-solid fa-book-open" aria-hidden="true"></i>
            <span>DeepLore</span>
            <strong>${escapeHtml(snapshot.injectedCount)}</strong>
        </button>
        <section id="dle-mobile-sheet" class="dle-mobile-sheet${openClass}" role="dialog" aria-modal="false" aria-hidden="${sheetAriaHidden}" aria-label="DeepLore mobile controls"${sheetInert}>
            <header class="dle-mobile-header">
                <div>
                    <span>DeepLore</span>
                    <strong>${escapeHtml(snapshot.statusLabel)}</strong>
                </div>
                <button type="button" data-dle-mobile-action="close" aria-label="Close DeepLore mobile panel">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </header>
            <div class="dle-mobile-body">
                ${errorMessage ? `<div class="dle-mobile-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
                ${renderBody(snapshot, state.view, mode, state)}
            </div>
        </section>
    `;
}

export function renderMobileShell(snapshot, state = { open: false, view: 'home', mode: 'auto', errorMessage: '' }) {
    return `<div id="${ROOT_ID}" class="dle-mobile-shell">${renderMobileShellContents(snapshot, state)}</div>`;
}

function setMobileError(message) {
    mobileState.errorMessage = message || '';
    if (mobileState.errorMessage) mobileState.open = true;
}

function executeCommand(command) {
    if (!command) {
        setMobileError('No mobile command is configured for this action.');
        renderCurrentState();
        return;
    }
    const ctx = getContext();
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(command).catch(err => {
            console.error('[DLE] Mobile command error:', command, err);
            setMobileError(`Command failed: ${command}`);
            renderCurrentState();
        });
    } else {
        console.warn('[DLE] Cannot execute mobile command; SillyTavern context unavailable:', command);
        setMobileError(`Cannot execute ${command}`);
        renderCurrentState();
    }
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

function renderCurrentState() {
    const root = ensureRoot();
    const env = readMobileEnvironment();
    const active = shouldUseMobileUi(env);
    mobileState.active = active;
    mobileState.mode = readMobileMode(env);
    root.hidden = !active;
    document.body.classList.toggle('dle-mobile-ui-active', active);
    if (!active) return;

    const snapshot = buildMobileShellSnapshot();
    root.innerHTML = renderMobileShellContents(snapshot, mobileState);
}

function handleMobileClick(event) {
    const root = ensureRoot();
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;

    const actionEl = target.closest('[data-dle-mobile-action]');
    if (actionEl) {
        const action = actionEl.getAttribute('data-dle-mobile-action');
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
                setMobileError(`Refresh failed: ${err?.message || err}`);
                renderCurrentState();
            });
        return;
    }

    const viewEl = target.closest('[data-dle-mobile-view]');
    if (viewEl) {
        const view = viewEl.getAttribute('data-dle-mobile-view') || 'home';
        const localViews = new Set(['home', 'why', 'browse', 'librarian', 'tools']);
        mobileState.open = true;
        const command = viewEl.getAttribute('data-dle-mobile-command');
        if (command && !localViews.has(view)) {
            executeCommand(command);
        } else {
            mobileState.errorMessage = '';
            mobileState.view = localViews.has(view) ? view : mobileState.view;
        }
        renderCurrentState();
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

export function createMobileShell(options = {}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;

    mobileShellOptions = options;
    const root = ensureRoot();
    root.removeEventListener('click', handleMobileClick);
    root.removeEventListener('input', handleMobileInput);
    root.removeEventListener('change', handleMobileInput);
    root.addEventListener('click', handleMobileClick);
    root.addEventListener('input', handleMobileInput);
    root.addEventListener('change', handleMobileInput);

    for (const unsubscribe of mobileUnsubscribers) {
        try { unsubscribe(); } catch { /* noop */ }
    }
    mobileUnsubscribers = [
        onIndexUpdated(renderCurrentState),
        onIndexingChanged(renderCurrentState),
        onInjectionSourcesReady(renderCurrentState),
        onPipelineComplete(renderCurrentState),
        onGenerationLockChanged(renderCurrentState),
        onLoreGapsChanged(renderCurrentState),
        onPipelinePhaseChanged(renderCurrentState),
        onAiStatsUpdated(renderCurrentState),
        onCircuitStateChanged(renderCurrentState),
        onPipelineTraceUpdated(renderCurrentState),
    ];

    if (mobileResizeHandler) window.removeEventListener('resize', mobileResizeHandler);
    mobileResizeHandler = () => window.requestAnimationFrame(renderCurrentState);
    window.addEventListener('resize', mobileResizeHandler);

    if (mobileMediaQuery?.removeEventListener && mobileResizeHandler) {
        mobileMediaQuery.removeEventListener('change', mobileResizeHandler);
    }
    mobileMediaQuery = window.matchMedia?.('(pointer: coarse)');
    mobileMediaQuery?.addEventListener?.('change', mobileResizeHandler);

    renderCurrentState();
    return root;
}

export function destroyMobileShell() {
    for (const unsubscribe of mobileUnsubscribers) {
        try { unsubscribe(); } catch { /* noop */ }
    }
    mobileUnsubscribers = [];
    if (mobileRoot) {
        mobileRoot.removeEventListener('click', handleMobileClick);
        mobileRoot.removeEventListener('input', handleMobileInput);
        mobileRoot.removeEventListener('change', handleMobileInput);
        mobileRoot.remove();
        mobileRoot = null;
    }
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
    mobileState = {
        open: false,
        view: 'home',
        active: false,
        mode: 'auto',
        errorMessage: '',
        statsExpanded: false,
        browse: normalizeMobileBrowseState(),
        browseSearchHelpOpen: false,
        browseExpandedKey: '',
    };
}
