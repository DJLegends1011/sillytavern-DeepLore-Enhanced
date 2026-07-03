/**
 * Librarian tab v2 contract:
 * - Flat Flags list with Activity sub-tab; selective heatmap (frequency >= 2 || urgency === 'high').
 * - Two-tier soft-remove via sibling arrays in chat_metadata: `deeplore_lore_gaps_hidden` (re-flag resurfaces)
 *   and `deeplore_lore_gaps_dismissed` (permanent).
 */
import { escapeHtml } from '../../../../../utils.js';
import { loreGaps } from '../state.js';
import { getSettings } from '../../settings.js';
import { getHiddenGapIds, getDismissedGapIds, buildLibrarianActivityFeed } from '../librarian/librarian-tools.js';
import { ds, isDrawerVisible } from './drawer-state.js';
import { tr, trPlural } from '../i18n/i18n.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

const URGENCY_SCORE = { low: 0.2, medium: 0.5, high: 1.0 };

/** Status set is `pending` ↔ `written` only; soft-remove uses sibling arrays (see file header). */
const STATUS_ICONS = {
    pending: { icon: '<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>', cls: 'dle-gap-pending', label: 'Pending' },
    written: { icon: '<i class="fa-solid fa-check" aria-hidden="true"></i>', cls: 'dle-gap-written', label: 'Written' },
};

/**
 * 0-3 heatmap intensity score: 40% frequency-norm + 40% urgency + 20% recency, scaled.
 * Tinting is selectively applied — only entries meeting the `frequency >= 2 || urgency === 'high'`
 * gate use this score; everything else stays untinted regardless.
 */
function computeGapScore(gap) {
    const urgency = URGENCY_SCORE[gap.urgency] || 0.5;
    const freqNorm = Math.min(1, ((gap.frequency || 1) - 1) / 9);
    const ageMs = Date.now() - (gap.timestamp || 0);
    const ageHours = ageMs / (1000 * 60 * 60);
    const recency = Math.max(0, 1.0 - ageHours / 24);
    const raw = (freqNorm * 0.4) + (urgency * 0.4) + (recency * 0.2);
    return Math.min(3, raw * 3.0);
}

/** ms timestamp → "just now" / "Nm ago" / "Nh ago" / "Nd ago". */
function relativeTime(ts) {
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// ════════════════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════════════════

export function renderLibrarianTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    // Wave F: skip painting into a hidden drawer; replayed on open (drawer.js toggle handler).
    // Safe because the librarian tab-bar badge (.dle-librarian-badge) is written below in THIS
    // function but only needs to be live while the drawer is open — gating is drawer-visible-only
    // (not active-tab), so the badge refreshes for every tab whenever the drawer is open.
    if (!isDrawerVisible()) return;

    const $list = $drawer.find('.dle-librarian-list');
    const $empty = $drawer.find('#dle-panel-librarian .dle-empty-state');
    const $selectAllBar = $drawer.find('.dle-librarian-select-all-bar');
    const $actionRow = $drawer.find('.dle-librarian-action-row');
    const $toolbarBottom = $drawer.find('#dle-panel-librarian .dle-librarian-toolbar-bottom');

    // Roving tabindex.
    const $subTabs = $drawer.find('.dle-librarian-sub-tabs');
    $subTabs.find('.dle-librarian-sub-tab').removeClass('active').attr('aria-checked', 'false').attr('tabindex', '-1');
    $subTabs.find(`[data-filter="${ds.librarianFilter}"]`).addClass('active').attr('aria-checked', 'true').attr('tabindex', '0');

    $drawer.find('.dle-librarian-sort').val(ds.librarianSort);

    // Sub-tab badge = NEW items since this sub-tab was last viewed.
    // Stamping the active sub-tab BEFORE computing counts keeps its own badge empty.
    const hiddenIds = getHiddenGapIds();
    const dismissedIds = getDismissedGapIds();
    const visibleFlagGaps = loreGaps.filter(g => g.type === 'flag' && !hiddenIds.has(g.id) && !dismissedIds.has(g.id));
    const activityFeed = buildLibrarianActivityFeed();

    ds.librarianLastViewed[ds.librarianFilter] = Date.now();

    const flagNew = visibleFlagGaps.filter(g => (g.timestamp || 0) > ds.librarianLastViewed.flag).length;
    const activityNew = activityFeed.filter(it => (it.ts || 0) > ds.librarianLastViewed.activity).length;
    $subTabs.find('[data-filter="flag"] .dle-sub-tab-count').text(flagNew > 0 ? `(${flagNew})` : '').attr('aria-label', `Flag tab, ${flagNew} new`);
    $subTabs.find('[data-filter="activity"] .dle-sub-tab-count').text(activityNew > 0 ? `(${activityNew})` : '').attr('aria-label', `Activity tab, ${activityNew} new`);

    // ─── Activity sub-tab ───────────────────────────────────────────────────
    if (ds.librarianFilter === 'activity') {
        $selectAllBar.hide();
        $actionRow.hide();
        const feed = activityFeed;

        if (feed.length === 0) {
            $list.empty();
            const $text = $empty.find('.dle-librarian-empty-text');
            $text.text(tr('dle_librarian_empty_activity'));
            $empty.find('.dle-librarian-empty-actions').css('display', '');
            $empty.addClass('dle-visible');
            $toolbarBottom.css('display', 'none');
            updateLibrarianBadge();
            return;
        }
        $empty.removeClass('dle-visible');
        $toolbarBottom.css('display', '');

        let html = '';
        for (const item of feed) {
            const icon = item.kind === 'tool-search'
                ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true" title="Search"></i>'
                : '<i class="fa-solid fa-flag" aria-hidden="true" title="Flag"></i>';
            const isSearch = item.type === 'search';
            const hasResults = isSearch && (item.resultTitles && item.resultTitles.length > 0);
            const metaText = item.kind === 'gap-flag'
                ? `${item.urgency || 'medium'}${item.frequency > 1 ? `, flagged ${item.frequency} times` : item.frequency === 1 ? ', flagged once' : ''}`
                : isSearch
                    ? `${item.resultCount} result${item.resultCount !== 1 ? 's' : ''}`
                    : (item.urgency || '');
            const metaHtml = hasResults
                ? `<button type="button" class="dle-activity-meta dle-activity-results-link dle-text-xs" data-results="${escapeHtml(JSON.stringify(item.resultTitles))}" data-query="${escapeHtml(item.query)}" title="Show context returned to writing AI">${escapeHtml(metaText)}</button>`
                : `<span class="dle-activity-meta dle-text-xs dle-muted">${escapeHtml(metaText)}</span>`;
            html += `<div class="dle-librarian-activity-row" role="listitem">`
                + `<span class="dle-activity-icon">${icon}</span>`
                + `<span class="dle-activity-query" title="${escapeHtml(item.query)}">${escapeHtml(item.query)}</span>`
                + metaHtml
                + `<span class="dle-activity-time dle-text-xs dle-muted">${relativeTime(item.ts)}</span>`
                + `</div>`;
        }
        $list.html(html);
        updateLibrarianBadge();
        return;
    }

    // ─── Flags sub-tab ──────────────────────────────────────────────────────
    let gaps = [...visibleFlagGaps];

    switch (ds.librarianSort) {
        case 'frequency':
            gaps.sort((a, b) => (b.frequency || 1) - (a.frequency || 1));
            break;
        case 'urgency': {
            const order = { high: 0, medium: 1, low: 2 };
            gaps.sort((a, b) => (order[a.urgency] ?? 1) - (order[b.urgency] ?? 1));
            break;
        }
        case 'newest':
        default:
            gaps.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            break;
    }

    if (gaps.length === 0) {
        $list.empty();
        $selectAllBar.hide();
        $actionRow.hide();
        const enabled = getSettings().librarianEnabled;
        const $text = $empty.find('.dle-librarian-empty-text');
        const $emptyActions = $empty.find('.dle-librarian-empty-actions');
        if (!enabled) {
            $text.text(tr('dle_librarian_disabled_text'));
            $emptyActions.css('display', 'none');
        } else {
            $text.text(tr('dle_librarian_empty_flags'));
            $emptyActions.css('display', '');
        }
        // Defensive: drop stale hint paragraphs from earlier renders (pre-fix duplication bug).
        $text.nextAll('p').remove();
        $empty.addClass('dle-visible');
        $toolbarBottom.css('display', 'none');
        updateLibrarianBadge();
        return;
    }
    $empty.removeClass('dle-visible');
    $toolbarBottom.css('display', '');
    $selectAllBar.show();
    // f041: legacy standalone action row retired — actions moved into the bulk bar.
    $actionRow.hide();

    let html = '';
    for (const gap of gaps) {
        const score = computeGapScore(gap);
        const tinted = (gap.frequency || 1) >= 2 || gap.urgency === 'high';
        const tintClass = tinted ? 'dle-gap-tinted' : '';
        const isUpdate = gap.subtype === 'update';
        const subtypeClass = isUpdate ? 'dle-gap-update' : '';
        const statusInfo = STATUS_ICONS[gap.status] || STATUS_ICONS.pending;
        const title = escapeHtml(gap.query || '');
        const entryTitleAttr = gap.entryTitle ? `data-entry-title="${escapeHtml(gap.entryTitle)}"` : '';
        const time = relativeTime(gap.timestamp);
        const isSelected = ds.librarianSelected.has(gap.id);
        const selClass = isSelected ? 'dle-gap-selected' : '';
        // f042: a one-line reason teaser so the row carries WHY it was flagged without
        // forcing an expand. Full reason (+ meta) still lives in the expanded .dle-gap-detail.
        const reasonRaw = (gap.reason || '').trim();
        const reasonTeaser = reasonRaw ? escapeHtml(reasonRaw.replace(/\s+/g, ' ')) : '';

        html += `<div class="dle-librarian-entry ${tintClass} ${subtypeClass} ${selClass}" style="--dle-gap:${score.toFixed(2)}" `
            + `data-gap-id="${escapeHtml(gap.id)}" data-subtype="${escapeHtml(gap.subtype || 'gap')}" ${entryTitleAttr} `
            + `data-urgency="${escapeHtml(gap.urgency || 'medium')}" role="listitem" `
            + `aria-expanded="false" aria-label="${title}, ${statusInfo.label}" tabindex="0">`;
        html += `<input type="checkbox" class="dle-gap-check" ${isSelected ? 'checked' : ''} aria-label="${escapeHtml(tr('dle_select_all_aria'))}: ${title}" tabindex="-1">`;
        // Update-type flags use a pen icon; plain gaps use the status icon.
        if (isUpdate) {
            html += `<span class="dle-gap-status dle-gap-update-icon" title="${escapeHtml(tr('dle_gap_update_needed'))}" aria-label="${escapeHtml(tr('dle_gap_update_needed'))}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></span>`;
        } else {
            html += `<span class="dle-gap-status ${statusInfo.cls}" title="${statusInfo.label}" aria-label="${statusInfo.label}">${statusInfo.icon}</span>`;
        }
        // f042: title + update-target chip + inline reason teaser all stack in the main column
        // so the gap is self-describing at a glance. Single grid column → the grid stays a
        // simple 5-column single-row layout (check/status · main · time · chevron).
        html += `<span class="dle-gap-main">`;
        html += `<span class="dle-gap-title-row">`;
        html += `<span class="dle-gap-title">${title}</span>`;
        if (isUpdate && gap.entryTitle) {
            html += `<span class="dle-gap-entry-title dle-text-xs dle-muted">${escapeHtml(gap.entryTitle)}</span>`;
        }
        html += `</span>`;
        if (reasonTeaser) {
            html += `<span class="dle-gap-reason-teaser dle-text-xs dle-muted">${reasonTeaser}</span>`;
        }
        html += `</span>`;
        html += `<span class="dle-gap-time dle-text-xs dle-muted">${time}</span>`;
        // f042: explicit chevron affordance — the row was already click-to-expand, but the
        // gesture was undiscoverable. The chevron rotates via the row's aria-expanded state
        // (CSS), and is aria-hidden because the row itself owns the expand semantics.
        html += `<span class="dle-gap-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>`;
        html += `</div>`;
    }

    const focusedGapId = document.activeElement?.closest?.('.dle-librarian-entry')?.dataset?.gapId;
    $list.html(html);
    if (focusedGapId) {
        const $target = $list.find(`[data-gap-id="${focusedGapId}"]`);
        if ($target.length) {
            $target[0].focus();
        } else {
            const $first = $list.find('.dle-librarian-entry').first();
            if ($first.length) $first[0].focus();
        }
    }

    const selCount = ds.librarianSelected.size;
    const allSelected = selCount > 0 && gaps.every(g => ds.librarianSelected.has(g.id));
    const hasSelection = selCount > 0;
    const hasSingleSelection = selCount === 1;

    // f041: the bar is the single contextual bulk-action surface. The select-all
    // checkbox + count are always present; the count switches from a passive hint to
    // a live "N selected" readout and the action cluster (Open/Done/Remove + Clear/Invert)
    // toggles in only when rows are picked. The static action row below the list is
    // retired (kept hidden in markup for back-compat) — actions live in the bar now.
    $selectAllBar.find('.dle-librarian-select-all').prop('checked', allSelected);
    $selectAllBar.toggleClass('dle-has-selection', hasSelection);
    const $count = $selectAllBar.find('.dle-librarian-select-count');
    $count.text(hasSelection ? trPlural('dle_librarian_n_selected', selCount) : tr('dle_librarian_select_hint'));

    // Action buttons live inside the bar's contextual cluster; disabled when empty.
    // Handlers are delegated (drawer-events.js), so position is immaterial.
    $selectAllBar.find('[data-librarian-action="open"]').prop('disabled', !hasSingleSelection).attr('aria-disabled', !hasSingleSelection ? 'true' : null);
    $selectAllBar.find('[data-librarian-action="done"]').prop('disabled', !hasSelection);
    $selectAllBar.find('[data-librarian-action="remove"]').prop('disabled', !hasSelection);

    // Legacy standalone action row is fully superseded — keep it hidden regardless.
    $actionRow.hide();

    updateLibrarianBadge();
}

export function updateLibrarianBadge() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const hiddenIds = getHiddenGapIds();
    const dismissedIds = getDismissedGapIds();
    const pendingCount = loreGaps.filter(g =>
        g.status === 'pending'
        && g.type === 'flag'
        && !hiddenIds.has(g.id)
        && !dismissedIds.has(g.id)
    ).length;

    const $badge = $drawer.find('.dle-librarian-badge');
    if (pendingCount > 0) {
        $badge.text(pendingCount).addClass('dle-visible');
    } else {
        $badge.text('').removeClass('dle-visible');
    }

    const $tab = $drawer.find('#dle-tab-librarian');
    $tab.attr('aria-label', pendingCount > 0
        ? `Librarian -- ${pendingCount} pending flag${pendingCount !== 1 ? 's' : ''}`
        : 'Librarian -- lore activity and writing assistant');
}
