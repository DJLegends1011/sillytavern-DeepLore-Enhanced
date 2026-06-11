/**
 * DeepLore Enhanced — Mobile glass overlay chrome.
 * Pure renderers: take snapshots/UI state, return HTML strings. No DOM access.
 * The shell composes these and owns all event handling.
 */

import { MOBILE_DEFAULT_TAB, normalizeMobileTab } from './mobile-state.js';

export const OVERLAY_ID = 'dle-mobile-overlay';

export const OVERLAY_TAB_DEFS = [
    { id: 'injection', label: 'Injection', icon: 'fa-circle-question' },
    { id: 'browse', label: 'Browse', icon: 'fa-book-open' },
    { id: 'filters', label: 'Filters', icon: 'fa-filter' },
    { id: 'librarian', label: 'Librarian', icon: 'fa-book-bookmark' },
    { id: 'tools', label: 'Tools', icon: 'fa-toolbox' },
];

export const QUICK_ACTION_DEFS = [
    { id: 'refresh', label: 'Refresh index', short: 'Refresh', icon: 'fa-rotate', kind: 'refresh' },
    { id: 'reroll', label: 'Reroll Lore', short: 'Reroll', icon: 'fa-shuffle', kind: 'action' },
    { id: 'skip-librarian', label: 'Skip Librarian', short: 'Skip', icon: 'fa-ban', kind: 'toggle' },
    { id: 'scribe', label: 'Scribe', short: 'Scribe', icon: 'fa-feather-pointed', kind: 'command', command: '/dle-scribe' },
    { id: 'new-entry', label: 'New Entry', short: 'New', icon: 'fa-plus', kind: 'command', command: '/dle-newlore' },
    { id: 'librarian-chat', label: 'Librarian Chat', short: 'Chat', icon: 'fa-book-bookmark', kind: 'command', command: '/dle-librarian' },
    { id: 'graph', label: 'Graph', short: 'Graph', icon: 'fa-diagram-project', kind: 'command', command: '/dle-graph' },
];

export const SWIPE_DISMISS_VELOCITY = 300; // px/s downward
export const SWIPE_DISMISS_FRACTION = 0.4; // of viewport height

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderStatusMetric(metric) {
    const ratio = Math.max(0, Math.min(100, Number(metric?.ratio || 0)));
    return `
        <div class="dle-mobile-status-metric dle-mobile-status-${escapeHtml(metric?.tone || 'ok')}">
            <span>${escapeHtml(metric?.label || '')}</span>
            <strong>${escapeHtml(metric?.value ?? '')}</strong>
            ${metric?.detail ? `<small>${escapeHtml(metric.detail)}</small>` : ''}
            <div class="dle-mobile-status-bar" aria-hidden="true"><span style="width:${ratio}%"></span></div>
        </div>
    `;
}

export function renderOverlayHeader(snapshot = {}, uiState = {}) {
    const expanded = !!uiState.statsExpanded;
    const subtitle = `${snapshot.statusLabel || 'Unknown'} · ${snapshot.injectedCount ?? 0} injected`;
    const stats = snapshot.stats;
    return `
        <header class="dle-mobile-overlay-header" data-dle-mobile-swipe-handle>
            <button type="button" class="dle-mobile-overlay-status" data-dle-mobile-action="toggle-stats" aria-expanded="${expanded ? 'true' : 'false'}">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                <span class="dle-mobile-overlay-status-text">
                    <strong>DeepLore</strong>
                    <small>${escapeHtml(subtitle)}</small>
                </span>
                <i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i>
            </button>
            <button type="button" class="dle-mobile-overlay-icon-btn" data-dle-mobile-action="settings" aria-label="Open DeepLore settings">
                <i class="fa-solid fa-gear" aria-hidden="true"></i>
            </button>
            <button type="button" class="dle-mobile-overlay-icon-btn" data-dle-mobile-action="close" aria-label="Close DeepLore overlay">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        </header>
        ${expanded && stats ? `<div class="dle-mobile-status-grid">
            ${renderStatusMetric(stats.budget)}
            ${renderStatusMetric(stats.entries)}
            ${renderStatusMetric(stats.context)}
            ${renderStatusMetric(stats.ai)}
            ${renderStatusMetric(stats.health)}
        </div>` : ''}
    `;
}

export function renderOverlayTabBar(activeTab = MOBILE_DEFAULT_TAB, badges) {
    badges = badges ?? {};
    const current = normalizeMobileTab(activeTab);
    const buttons = OVERLAY_TAB_DEFS.map(tab => `
        <button type="button" role="tab" class="dle-mobile-overlay-tab" data-dle-mobile-tab="${tab.id}" aria-selected="${tab.id === current ? 'true' : 'false'}">
            <i class="fa-solid ${tab.icon}" aria-hidden="true"></i>
            <span>${escapeHtml(tab.label)}</span>
            ${badges[tab.id] ? '<span class="dle-mobile-overlay-tab-dot" aria-hidden="true"></span>' : ''}
        </button>
    `).join('');
    return `<nav class="dle-mobile-overlay-tabs" role="tablist" aria-label="DeepLore sections">${buttons}</nav>`;
}

export function renderQuickActions(options) {
    const { skipLibrarianActive = false } = options ?? {};
    const buttons = QUICK_ACTION_DEFS.map(action => {
        const label = escapeHtml(action.label);
        const body = `<i class="fa-solid ${action.icon}" aria-hidden="true"></i><span class="dle-mobile-overlay-quick-label">${escapeHtml(action.short || action.label)}</span>`;
        if (action.kind === 'command') {
            return `<button type="button" class="dle-mobile-overlay-quick-btn" data-dle-mobile-command="${action.command}" aria-label="${label}" title="${label}">${body}</button>`;
        }
        if (action.kind === 'refresh') {
            return `<button type="button" class="dle-mobile-overlay-quick-btn" data-dle-mobile-refresh aria-label="${label}" title="${label}">${body}</button>`;
        }
        const pressed = action.kind === 'toggle' ? ` aria-pressed="${skipLibrarianActive ? 'true' : 'false'}"` : '';
        const activeClass = action.kind === 'toggle' && skipLibrarianActive ? ' dle-mobile-overlay-quick-active' : '';
        return `<button type="button" class="dle-mobile-overlay-quick-btn${activeClass}" data-dle-mobile-action="quick-${action.id}"${pressed} aria-label="${label}" title="${label}">${body}</button>`;
    }).join('');
    return `<div class="dle-mobile-overlay-quick" role="toolbar" aria-label="Quick actions">${buttons}</div>`;
}

export function renderOverlayError(message) {
    return `<div class="dle-mobile-error" role="alert">${escapeHtml(message)}</div>`;
}

export function renderOverlay({ snapshot = {}, uiState = {}, contentHtml = '', skipLibrarianActive = false, contentEntering = false } = {}) {
    const open = !!uiState.open;
    return `
        <section id="${OVERLAY_ID}" class="dle-mobile-overlay${open ? ' dle-mobile-open' : ''}" role="dialog" aria-modal="false" aria-hidden="${open ? 'false' : 'true'}" aria-label="DeepLore mobile overlay"${open ? '' : ' inert'}>
            <div class="dle-mobile-overlay-scrim" data-dle-mobile-action="close"></div>
            <div class="dle-mobile-overlay-panel">
                ${renderOverlayHeader(snapshot, uiState)}
                ${renderOverlayTabBar(uiState.tab, { librarian: (snapshot.gapCount || 0) > 0 })}
                ${renderQuickActions({ skipLibrarianActive })}
                <div class="dle-mobile-overlay-content${contentEntering ? ' dle-mobile-tab-enter' : ''}">
                    ${uiState.errorMessage ? renderOverlayError(uiState.errorMessage) : ''}
                    ${contentHtml}
                </div>
            </div>
        </section>
    `;
}

export function shouldDismissSwipe({ dy = 0, durationMs = 0, viewportHeight = 0 } = {}) {
    if (dy <= 0) return false;
    const velocity = durationMs > 0 ? (dy / durationMs) * 1000 : 0;
    if (viewportHeight > 0 && dy >= viewportHeight * SWIPE_DISMISS_FRACTION) return true;
    return velocity >= SWIPE_DISMISS_VELOCITY;
}
