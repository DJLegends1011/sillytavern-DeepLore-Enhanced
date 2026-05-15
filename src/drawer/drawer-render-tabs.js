import { chat_metadata } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, lastInjectionSources, previousSources, lastPipelineTrace,
    generationLock, indexing,
    cooldownTracker, decayTracker, chatInjectionCounts, trackerKey,
    fieldDefinitions,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { buildObsidianURI, buildObsidianAnchorHtml, computeSourcesDiff, categorizeRejections, resolveEntryVault, normalizePinBlock } from '../helpers.js';
import {
    ds, BROWSE_ROW_HEIGHT, BROWSE_OVERSCAN,
    getMatchLabel, computeEntryTemperatures,
} from './drawer-state.js';

let _cachedRejectionMap = new Map();
let _cachedRejectionTrace = null;
let _cachedExpandedPreviewHtml = null;
// BUG-360: trackerKey (vaultSource:title) — bare titles would collide across vaults.
let _cachedExpandedPreviewKey = null;
let _cachedFieldValues = null;
let _cachedFieldValuesIndexLen = -1;
// Hash of last renderInjectionTab inputs — skip render when unchanged.
let _lastInjectionRenderHash = null;

// ════════════════════════════════════════════════════════════════════════════
// Why? Tab
// ════════════════════════════════════════════════════════════════════════════

export function renderInjectionTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const sources = lastInjectionSources;
    const prev = previousSources;
    const trace = lastPipelineTrace;

    // Content-hash guard — skip full re-render when inputs are unchanged. Hash inputs:
    // sources (title/tokens/matchedBy/vaultSource), filter state, trace's rejected-entry
    // summary. Counts are updated surgically via updateInjectionCountBadges() and are
    // intentionally excluded from the hash.
    const _hashParts = [
        ds.whyTabFilter || '',
        generationLock ? '1' : '0',
        sources ? sources.map(s => `${s.title}|${s.tokens}|${s.matchedBy}|${s.vaultSource || ''}`).join(';') : 'null',
        trace ? `${trace.injected?.length ?? 0}:${trace.matched?.length ?? 0}:${trace.aiSelected?.length ?? 0}:${trace.budgetCut?.length ?? 0}` : 'null',
    ];
    const _hash = _hashParts.join('#');
    if (_hash === _lastInjectionRenderHash) return;
    _lastInjectionRenderHash = _hash;
    const $list = $drawer.find('.dle-why-list');
    const $empty = $drawer.find('#dle-panel-injection .dle-empty-state');
    const $diff = $drawer.find('.dle-section-diff');
    const $whyNotSection = $drawer.find('.dle-why-not-section');
    const $whyNotList = $drawer.find('.dle-why-not-list');

    if (!sources || sources.length === 0) {
        $list.empty();
        $whyNotSection.removeClass('dle-visible');
        $diff.empty();
        if (generationLock) {
            $empty.html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><p>Choosing lore...</p>').addClass('dle-visible');
        } else {
            $empty.html(
                '<i class="fa-solid fa-circle-question" aria-hidden="true"></i>'
                + '<p>No entries injected yet. Send a message mentioning entry keywords, or check Obsidian connection.</p>'
                + '<div class="dle-empty-guide">'
                + '<p>To see lore injection in action:</p>'
                + '<ol>'
                + '<li>Connect to an Obsidian vault with <code>#lorebook</code>-tagged entries</li>'
                + '<li>Send a message mentioning a keyword from your entries</li>'
                + '<li>This tab will show which entries were injected and why</li>'
                + '</ol>'
                + '<p class="dle-empty-commands"><code>/dle-setup</code> — configure your vault &nbsp; <code>/dle-browse</code> — see indexed entries</p>'
                + '</div>',
            ).addClass('dle-visible');
        }
        return;
    }

    $empty.removeClass('dle-visible');

    const $filterToggle = $drawer.find('.dle-why-filter-toggle');
    // BUG-AUDIT-C11: roving tabindex — only the active radio button is in tab order.
    $filterToggle.find('.dle-why-filter-btn').removeClass('active').attr('aria-checked', 'false').attr('tabindex', '-1');
    $filterToggle.find(`[data-filter="${ds.whyTabFilter}"]`).addClass('active').attr('aria-checked', 'true').attr('tabindex', '0');

    const diff = computeSourcesDiff(sources, prev);

    $diff.attr('aria-live', 'polite');
    const diffParts = [];
    if (diff.added.length) diffParts.push(`<span class="dle-diff-add">+${diff.added.length} new</span>`);
    if (diff.removed.length) diffParts.push(`<span class="dle-diff-remove">-${diff.removed.length} removed</span>`);
    $diff.html(diffParts.join(' '));

    const settings = getSettings();
    const addedTitles = new Set(diff.added.map(s => s.title));
    const removedTitles = new Set(diff.removed.map(s => s.title));

    // BUG-AUDIT-H14: title→entry lookup once instead of vaultIndex.find() per entry — O(N+M) vs O(N*M).
    const titleToEntry = new Map();
    for (const e of vaultIndex) {
        if (!titleToEntry.has(e.title)) titleToEntry.set(e.title, e);
    }

    function buildWhyHtml(srcs) {
        let h = '';
        for (let idx = 0; idx < srcs.length; idx++) {
            const src = srcs[idx];
            const isNew = addedTitles.has(src.title);
            const isConstant = src.constant || (src.matchedBy && src.matchedBy.toLowerCase().includes('constant'));
            const classes = ['dle-why-entry'];
            if (isNew) classes.push('dle-why-new');
            if (isConstant) classes.push('dle-why-constant');

            const { uri } = resolveEntryVault(src, settings.vaults);
            const matchLabel = getMatchLabel(src.matchedBy);

            const entryAriaLabel = `${escapeHtml(src.title)}, ${src.tokens != null ? src.tokens : 'unknown'} tokens, matched by ${matchLabel}${isNew ? ', newly added' : ''}`;
            const countKey = `${src.vaultSource || ''}:${src.title}`;
            h += `<div class="${classes.join(' ')}" style="--i:${idx}" role="listitem" aria-label="${entryAriaLabel}" data-title="${escapeHtml(src.title)}" data-count-key="${escapeHtml(countKey)}">`;
            h += `<span class="dle-why-title">`;
            if (uri) {
                h += buildObsidianAnchorHtml(uri, { text: src.title, ariaLabel: `Open ${src.title} in Obsidian` });
            } else {
                h += escapeHtml(src.title);
            }
            // Show folder path if entry has one
            const whyEntry = titleToEntry.get(src.title);
            if (whyEntry?.folderPath) {
                h += ` <span class="dle-entry-folder" title="${escapeHtml(whyEntry.folderPath)}">${escapeHtml(whyEntry.folderPath)}</span>`;
            }
            h += `</span>`;
            h += `<span class="dle-why-meta">`;
            const tokVal = src.tokens || 0;
            const tokHue = Math.max(0, 120 - (tokVal / 5000) * 120); // hue 120=green (light), 0=red (heavy)
            h += `<span class="dle-why-tokens" style="color: hsl(${Math.round(tokHue)}, 80%, 50%)" aria-label="${tokVal} tokens">${tokVal} tokens</span>`;
            const whyChatCount = chatInjectionCounts.get(`${src.vaultSource || ''}:${src.title}`) || 0;
            if (whyChatCount > 0) h += `<span class="dle-inject-count" title="Injected ${whyChatCount} times this chat" aria-label="Injected ${whyChatCount} times this chat">${whyChatCount}×</span>`;
            h += `<span class="dle-why-match" data-match-type="${matchLabel.toLowerCase()}" title="Matched via ${escapeHtml(src.matchedBy || '?')}">${matchLabel}</span>`;
            if (isNew) h += `<span class="dle-why-new-badge" title="New this message — not injected in previous response" aria-label="New this message — not injected in previous response">NEW</span>`;
            h += `<button class="dle-browse-nav-btn" data-browse-title="${escapeHtml(src.title)}" title="Show in Browse" aria-label="Show ${escapeHtml(src.title)} in Browse tab"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button>`;
            h += `</span>`;
            h += `</div>`;
        }
        return h;
    }

    const showInjected = ds.whyTabFilter !== 'filtered';
    const showFiltered = ds.whyTabFilter !== 'injected';
    $list.toggle(showInjected);
    $diff.toggle(showInjected);

    // Animate-out removed entries, then swap; safety timeout in case animationend never fires.
    if (showInjected && removedTitles.size > 0 && $list.children().length > 0) {
        const exitEls = $list.find('.dle-why-entry').filter(function () {
            return removedTitles.has($(this).data('title'));
        });
        if (exitEls.length > 0) {
            exitEls.addClass('dle-why-exit');
            let swapped = false;
            const swap = () => { if (!swapped) { swapped = true; $list.html(buildWhyHtml(sources)); } };
            exitEls[0].addEventListener('animationend', swap, { once: true });
            setTimeout(swap, 250);
        } else {
            $list.html(buildWhyHtml(sources));
        }
    } else {
        $list.html(buildWhyHtml(sources));
    }

    // ── "Why Not" section — candidates that got filtered out ──
    if (!showFiltered) {
        $whyNotSection.removeClass('dle-visible');
    } else if (trace) {
        const injectedTitles = new Set(sources.map(s => s.title));
        const rejectedGroups = categorizeRejections(trace, injectedTitles);
        const nonEmpty = rejectedGroups.filter(g => g.entries.length > 0);

        if (nonEmpty.length > 0) {
            let whyNotHtml = '';
            for (const group of nonEmpty) {
                whyNotHtml += `<div class="dle-why-not-group-header" role="heading" aria-level="4" aria-label="Filtered entries — ${escapeHtml(group.label)}">`;
                whyNotHtml += `<span class="dle-why-not-group-icon">${group.icon}</span> `;
                whyNotHtml += `<span class="dle-why-not-group-label">${escapeHtml(group.label)}</span>`;
                whyNotHtml += `<span class="dle-why-not-group-count">${group.entries.length}</span>`;
                whyNotHtml += `</div>`;
                for (const e of group.entries) {
                    whyNotHtml += `<div class="dle-why-entry dle-why-not-entry dle-why-not-grouped" role="listitem" aria-label="Filtered out: ${escapeHtml(e.reason)}">`;
                    whyNotHtml += `<span class="dle-why-title dle-muted">${escapeHtml(e.title)}</span>`;
                    whyNotHtml += `<span class="dle-why-meta"><span class="dle-why-match dle-why-not-reason" title="${escapeHtml(e.reason)}" aria-label="${escapeHtml(e.reason)}">${escapeHtml(e.reason)}</span>`;
                    whyNotHtml += `<button class="dle-browse-nav-btn" data-browse-title="${escapeHtml(e.title)}" title="Show in Browse" aria-label="Show ${escapeHtml(e.title)} in Browse tab"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button></span>`;
                    whyNotHtml += `</div>`;
                }
            }
            $whyNotList.html(whyNotHtml);
            $whyNotSection.addClass('dle-visible');
        } else {
            $whyNotSection.removeClass('dle-visible');
        }
    } else {
        $whyNotSection.removeClass('dle-visible');
    }
}

/**
 * Surgically update `×N` count badges on Why? tab entries without rebuilding DOM.
 * Called instead of renderInjectionTab when only chatInjectionCounts changed —
 * avoids replaying stagger-in animations and preserves DOM identity.
 */
export function updateInjectionCountBadges() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $entries = $drawer.find('.dle-why-list .dle-why-entry');
    if (!$entries.length) return;
    $entries.each(function () {
        const $entry = $(this);
        const key = $entry.attr('data-count-key');
        if (!key) return;
        const count = chatInjectionCounts.get(key) || 0;
        const $meta = $entry.find('.dle-why-meta');
        let $badge = $meta.find('.dle-inject-count');
        if (count > 0) {
            const label = `Injected ${count} times this chat`;
            if ($badge.length === 0) {
                // Order must match buildWhyHtml — insert before the match-type label.
                const $matchLabel = $meta.find('.dle-why-match');
                const badgeHtml = `<span class="dle-inject-count" title="${label}" aria-label="${label}">${count}×</span>`;
                if ($matchLabel.length) $matchLabel.before(badgeHtml);
                else $meta.append(badgeHtml);
            } else {
                $badge.text(`${count}×`).attr('title', label).attr('aria-label', label);
            }
        } else if ($badge.length) {
            $badge.remove();
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Browse Tab
// ════════════════════════════════════════════════════════════════════════════

export function renderBrowseTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    // Invalidate virtual scroll cache so stale entry references are never rendered.
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    const $list = $drawer.find('.dle-browse-list');
    const $emptyLoading = $drawer.find('#dle-browse-loading');
    const $emptyNoData = $drawer.find('#dle-browse-empty-no-data');
    const $emptyNoResults = $drawer.find('#dle-browse-empty-no-results');
    const $refreshSpinner = $drawer.find('.dle-browse-refresh-spinner');

    $refreshSpinner.toggle(!!indexing && vaultIndex.length > 0);

    $drawer.find('#dle-panel-browse').attr('aria-busy', indexing ? 'true' : 'false');

    if (!vaultIndex || vaultIndex.length === 0) {
        $list.empty();
        if (indexing) {
            $emptyLoading.addClass('dle-visible');
            $emptyNoData.removeClass('dle-visible');
        } else {
            $emptyLoading.removeClass('dle-visible');
            $emptyNoData.html(
                '<p>No vault entries indexed yet. Connect Obsidian and run <code>/dle-setup</code> to get started.</p>' +
                '<p class="dle-empty-legend">Entries show P50 priority (lower wins) or CONST (always injected).</p>'
            ).addClass('dle-visible');
        }
        $emptyNoResults.removeClass('dle-visible');
        return;
    }

    $emptyLoading.removeClass('dle-visible');
    $emptyNoData.removeClass('dle-visible');

    // Tag/folder caches are rebuilt on index update; reset stale filters when the tag/folder no longer exists.
    const $tagSelect = $drawer.find('[data-filter="tag"]');
    if (ds.cachedTagOptions) {
        $tagSelect.html(ds.cachedTagOptions);
        if (ds.browseTagFilter) $tagSelect.val(ds.browseTagFilter);
    }
    if (ds.browseTagFilter && ds.cachedTagSet && !ds.cachedTagSet.has(ds.browseTagFilter)) {
        ds.browseTagFilter = '';
    }

    const $folderSelect = $drawer.find('[data-filter="folder"]');
    if ($folderSelect.length) {
        if (ds.cachedFolderOptions) {
            $folderSelect.html(ds.cachedFolderOptions);
            if (ds.browseFolderFilter) $folderSelect.val(ds.browseFolderFilter);
        }
        if (ds.browseFolderFilter && ds.cachedFolderSet && !ds.cachedFolderSet.has(ds.browseFolderFilter)) {
            ds.browseFolderFilter = '';
        }
    }

    // P8: rebuild options with live entry counts each render (fast Map pass).
    if ($tagSelect.length && ds.cachedTagSet) {
        const tagCounts = new Map();
        for (const e of vaultIndex) {
            if (e.tags) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        }
        $tagSelect.html('<option value="">Tags</option>' +
            [...ds.cachedTagSet].sort().map(t => `<option value="${escapeHtml(t)}"${ds.browseTagFilter === t ? ' selected' : ''}>${escapeHtml(t)} (${tagCounts.get(t) || 0})</option>`).join(''));
    }
    if ($folderSelect.length && ds.cachedFolderSet) {
        const folderCounts = new Map();
        for (const e of vaultIndex) {
            if (e.folderPath) {
                const parts = e.folderPath.split('/');
                for (let i = 1; i <= parts.length; i++) {
                    const seg = parts.slice(0, i).join('/');
                    if (ds.cachedFolderSet.has(seg)) folderCounts.set(seg, (folderCounts.get(seg) || 0) + 1);
                }
            }
        }
        $folderSelect.html('<option value="">Folder</option>' +
            [...ds.cachedFolderSet].sort().map(f => `<option value="${escapeHtml(f)}"${ds.browseFolderFilter === f ? ' selected' : ''}>${escapeHtml(f)} (${folderCounts.get(f) || 0})</option>`).join(''));
    }

    // Custom field filter dropdowns — values cached, recomputed only when vault size changes.
    const browseFieldDefs = (fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS)
        .filter(fd => fd.gating?.enabled);
    const $cfContainer = $drawer.find('.dle-browse-custom-filters');
    if ($cfContainer.length && browseFieldDefs.length > 0) {
        if (_cachedFieldValuesIndexLen !== vaultIndex.length) {
            _cachedFieldValues = {};
            for (const fd of browseFieldDefs) {
                const vals = new Set();
                for (const e of vaultIndex) {
                    const v = e.customFields?.[fd.name];
                    if (v == null) continue;
                    if (Array.isArray(v)) v.forEach(x => { if (x) vals.add(String(x)); });
                    else if (v !== '') vals.add(String(v));
                }
                if (vals.size > 0) _cachedFieldValues[fd.name] = [...vals].sort();
            }
            _cachedFieldValuesIndexLen = vaultIndex.length;
        }
        const fieldValues = _cachedFieldValues;
        let cfHtml = '';
        for (const fd of browseFieldDefs) {
            const vals = fieldValues[fd.name];
            if (!vals || vals.length === 0) continue;
            const current = ds.browseCustomFieldFilters[fd.name] || '';
            cfHtml += `<select class="text_pole dle-browse-filter-select dle-browse-cf-filter" data-cf="${escapeHtml(fd.name)}" aria-label="Filter by ${escapeHtml(fd.label)}">`;
            cfHtml += `<option value="">${escapeHtml(fd.label)}</option>`;
            for (const v of vals) {
                cfHtml += `<option value="${escapeHtml(v)}"${current === v ? ' selected' : ''}>${escapeHtml(v)}</option>`;
            }
            cfHtml += '</select>';
        }
        // Don't replace HTML while a dropdown is open — would close it mid-interaction.
        const activeEl = document.activeElement;
        if (!(activeEl && $cfContainer[0]?.contains(activeEl) && (activeEl.tagName === 'SELECT' || activeEl.closest('.dle-browse-cf-filter')))) {
            $cfContainer.html(cfHtml);
        }
    }

    const settings = getSettings();

    const query = ds.browseQuery.toLowerCase();
    const statusFilter = ds.browseStatusFilter;
    const tagFilter = ds.browseTagFilter;
    const sortKey = ds.browseSort;

    // BUG-AUDIT-3: normalizePinBlock handles legacy bare-string entries alongside {title,vaultSource} objects.
    // Multi-vault key vaultSource:title (trackerKey invariant) — same-title cross-vault pins must not collide.
    const pins = chat_metadata?.deeplore_pins || [];
    const blocks = chat_metadata?.deeplore_blocks || [];
    const pinSet = new Set(pins.map(p => { const n = normalizePinBlock(p); return `${n.vaultSource || ''}:${n.title.toLowerCase()}`; }));
    const blockSet = new Set(blocks.map(b => { const n = normalizePinBlock(b); return `${n.vaultSource || ''}:${n.title.toLowerCase()}`; }));

    // lastInjectionSources gets cleared after message render — fall back to lastPipelineTrace.
    const injectedSet = new Set();
    const injSources = lastInjectionSources ?? lastPipelineTrace?.injected;
    if (injSources) {
        for (const s of injSources) injectedSet.add(s.title.toLowerCase());
    }

    // Search syntax: bare tokens AND substring-match title+keys; prefixes (tag:/folder:/key:/summary:/field:name=val) are field-qualified.
    const _queryTokens = query ? query.split(/\s+/).filter(Boolean) : [];
    const _prefixFilters = [];
    const _bareTokens = [];
    for (const tok of _queryTokens) {
        const colonIdx = tok.indexOf(':');
        if (colonIdx > 0) {
            const prefix = tok.slice(0, colonIdx);
            const val = tok.slice(colonIdx + 1);
            if (val) _prefixFilters.push({ prefix, val });
        } else {
            _bareTokens.push(tok);
        }
    }

    let entries = vaultIndex.filter(e => {
        if (_bareTokens.length) {
            for (const bt of _bareTokens) {
                const titleMatch = e.title.toLowerCase().includes(bt);
                const keyMatch = e.keys && e.keys.some(k => k.toLowerCase().includes(bt));
                if (!titleMatch && !keyMatch) return false;
            }
        }
        for (const { prefix, val } of _prefixFilters) {
            const lv = val.toLowerCase();
            if (prefix === 'tag') {
                if (!e.tags || !e.tags.some(t => t.toLowerCase().includes(lv))) return false;
            } else if (prefix === 'folder') {
                if (!e.folderPath || !e.folderPath.toLowerCase().includes(lv)) return false;
            } else if (prefix === 'key') {
                if (!e.keys || !e.keys.some(k => k.toLowerCase().includes(lv))) return false;
            } else if (prefix === 'summary') {
                if (!e.summary || !e.summary.toLowerCase().includes(lv)) return false;
            } else if (prefix === 'field') {
                // field:name=value — exact (case-insensitive) field-value match.
                const eqIdx = val.indexOf('=');
                if (eqIdx < 0) return false;
                const fname = val.slice(0, eqIdx).toLowerCase();
                const fval = val.slice(eqIdx + 1).toLowerCase();
                const ev = e.customFields?.[fname] ?? e.customFields?.[Object.keys(e.customFields || {}).find(k => k.toLowerCase() === fname) || ''];
                if (ev == null) return false;
                const evStr = Array.isArray(ev) ? ev.map(v => String(v).toLowerCase()) : [String(ev).toLowerCase()];
                if (!evStr.includes(fval)) return false;
            }
            // Unknown prefixes pass through unfiltered.
        }

        const tl = e.title.toLowerCase();
        const pbKey = `${e.vaultSource || ''}:${tl}`;
        if (statusFilter === 'injected' && !injectedSet.has(tl)) return false;
        if (statusFilter === 'pinned' && !pinSet.has(pbKey)) return false;
        if (statusFilter === 'blocked' && !blockSet.has(pbKey)) return false;
        if (statusFilter === 'constant' && !e.constant) return false;
        if (statusFilter === 'seed' && !e.seed) return false;
        if (statusFilter === 'bootstrap' && !e.bootstrap) return false;
        if (statusFilter === 'never_injected') {
            const key = trackerKey(e);
            const allTime = settings.analyticsData?.[key];
            if (allTime && (allTime.injected || 0) > 0) return false;
        }

        if (tagFilter && (!e.tags || !e.tags.includes(tagFilter))) return false;

        if (ds.browseFolderFilter) {
            if (!e.folderPath) return false;
            if (e.folderPath !== ds.browseFolderFilter && !e.folderPath.startsWith(ds.browseFolderFilter + '/')) return false;
        }

        for (const [cfName, cfVal] of Object.entries(ds.browseCustomFieldFilters)) {
            if (!cfVal) continue;
            const ev = e.customFields?.[cfName];
            if (ev == null) return false;
            if (Array.isArray(ev)) {
                if (!ev.some(v => String(v).toLowerCase() === cfVal.toLowerCase())) return false;
            } else {
                if (String(ev).toLowerCase() !== cfVal.toLowerCase()) return false;
            }
        }

        return true;
    });

    entries = [...entries];
    switch (sortKey) {
        case 'priority_asc': entries.sort((a, b) => (a.priority || 50) - (b.priority || 50)); break;
        case 'priority_desc': entries.sort((a, b) => (b.priority || 50) - (a.priority || 50)); break;
        case 'alpha_asc': entries.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'alpha_desc': entries.sort((a, b) => b.title.localeCompare(a.title)); break;
        case 'tokens_desc': entries.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
        case 'tokens_asc': entries.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
        case 'injections_desc': entries.sort((a, b) => (chatInjectionCounts.get(trackerKey(b)) || 0) - (chatInjectionCounts.get(trackerKey(a)) || 0)); break;
        default: entries.sort((a, b) => (a.priority || 50) - (b.priority || 50));
    }

    // P10: ds.browseQuickFilter = null | 'since-gen' | 'never-injected' (undefined = off).
    let $quickFilters = $drawer.find('.dle-browse-quick-filters');
    if (!$quickFilters.length) {
        const $browsePanel = $drawer.find('#dle-panel-browse');
        $browsePanel.find('.dle-browse-controls-row, .dle-browse-toolbar').first().after('<div class="dle-browse-quick-filters" role="group" aria-label="Quick filters"></div>');
        $quickFilters = $drawer.find('.dle-browse-quick-filters');
    }
    const activeQF = ds.browseQuickFilter ?? null;
    const sinceGenActive = activeQF === 'since-gen';
    const neverInjectedActive = activeQF === 'never-injected';
    $quickFilters.html(
        `<span class="dle-qf-pill${sinceGenActive ? ' dle-qf-active' : ''}" role="button" tabindex="0" aria-pressed="${sinceGenActive}" data-qf="since-gen">Since last gen</span>` +
        `<span class="dle-qf-pill${neverInjectedActive ? ' dle-qf-active' : ''}" role="button" tabindex="0" aria-pressed="${neverInjectedActive}" data-qf="never-injected">Never injected</span>`
    );
    if (sinceGenActive && lastInjectionSources && previousSources) {
        const diff = computeSourcesDiff(lastInjectionSources, previousSources);
        const addedKeys = new Set(diff.added.map(s => s.title.toLowerCase()));
        entries = entries.filter(e => addedKeys.has(e.title.toLowerCase()));
    } else if (neverInjectedActive) {
        entries = entries.filter(e => !chatInjectionCounts.has(trackerKey(e)) || chatInjectionCounts.get(trackerKey(e)) === 0);
    }

    const $summary = $drawer.find('.dle-browse-summary');
    const isFiltered = query || statusFilter !== 'all' || tagFilter || ds.browseFolderFilter || Object.values(ds.browseCustomFieldFilters).some(v => v);
    $summary.attr('aria-live', 'polite');
    if (isFiltered && entries.length !== vaultIndex.length) {
        $summary.text(`Showing ${entries.length} of ${vaultIndex.length} entries`).show();
    } else {
        $summary.hide();
    }

    ds.browseFilteredEntries = entries;
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    // Carto/Why? navigation target survives one filter run for auto-expand; otherwise collapse.
    if (ds.browseNavigateTarget) {
        ds.browseExpandedEntry = ds.browseNavigateTarget;
        ds.browseNavigateTarget = null;
    } else {
        ds.browseExpandedEntry = null;
        ds.browseExpandedIdx = null;
        ds.browseExpandedExtraHeight = 0;
        _cachedExpandedPreviewKey = null;
        _cachedExpandedPreviewHtml = null;
    }

    // min-height so flex doesn't collapse the virtual-scroll container.
    const listEl = $list[0];
    if (!listEl) return;
    const totalHeight = entries.length * BROWSE_ROW_HEIGHT + (ds.browseExpandedExtraHeight || 0);
    $list.css({ 'min-height': totalHeight + 'px' });

    // Reset scroll to top only when the filter signature actually changed.
    // Resetting unconditionally on every render (e.g. pin/block toggle that re-renders) yanked the user back mid-scroll.
    const _filterSignature = JSON.stringify({
        q: query || '',
        s: statusFilter || 'all',
        t: tagFilter || '',
        f: ds.browseFolderFilter || '',
        cf: ds.browseCustomFieldFilters || {},
        qf: ds.browseQuickFilter ?? null,
        sort: sortKey || 'priority_asc',
    });
    const scrollContainer = $drawer.find('.dle-drawer-inner')[0];
    if (scrollContainer && ds._browseLastFilterSig !== _filterSignature) {
        scrollContainer.scrollTop = 0;
        ds._browseLastScrollTop = undefined;
    }
    ds._browseLastFilterSig = _filterSignature;

    renderBrowseWindow();

    if (entries.length === 0) {
        const filterDesc = [];
        if (statusFilter && statusFilter !== 'all') filterDesc.push(`status=${escapeHtml(statusFilter)}`);
        if (tagFilter) filterDesc.push(`tag=${escapeHtml(tagFilter)}`);
        if (ds.browseFolderFilter) filterDesc.push(`folder=${escapeHtml(ds.browseFolderFilter)}`);
        if (query) filterDesc.push(`search=${escapeHtml(query)}`);
        for (const [k, v] of Object.entries(ds.browseCustomFieldFilters)) { if (v) filterDesc.push(`${escapeHtml(k)}=${escapeHtml(v)}`); }
        if (activeQF) filterDesc.push(`quick=${escapeHtml(activeQF)}`);
        const filterMsg = filterDesc.length ? `No entries match: ${filterDesc.join(', ')}` : 'No entries match your filters';
        $emptyNoResults.html(`<p>${filterMsg}</p><button class="dle-browse-clear-filters" type="button">Clear all filters</button>`).addClass('dle-visible');
    } else {
        $emptyNoResults.removeClass('dle-visible');
    }
}

/** Render the visible window of browse entries (virtual scroll). */
export function renderBrowseWindow() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $list = $drawer.find('.dle-browse-list');
    const listEl = $list[0];
    if (!listEl) return;

    const entries = ds.browseFilteredEntries;
    if (!entries.length) { $list.empty(); return; }

    // Scroll container is .dle-drawer-inner (scrollableInner), not the tab panel.
    const scrollContainer = $drawer.find('.dle-drawer-inner')[0];
    if (!scrollContainer) return;
    // Drawer hidden — getBoundingClientRect would return zeros; bail.
    if (!scrollContainer.offsetParent && !scrollContainer.offsetHeight) return;

    const scrollTop = scrollContainer.scrollTop;
    if (ds._browseLastScrollTop !== undefined && Math.abs(scrollTop - ds._browseLastScrollTop) < 1) return;
    ds._browseLastScrollTop = scrollTop;

    const viewHeight = scrollContainer.clientHeight;
    // getBoundingClientRect tolerates intermediate positioned parents; relativeScroll is list-top
    // minus container-top (negative=list above viewport, positive=below).
    const containerRect = scrollContainer.getBoundingClientRect();
    const listRect = listEl.getBoundingClientRect();
    const relativeScroll = containerRect.top - listRect.top;

    // BUG-350: rows after the expanded entry are shifted down by browseExpandedExtraHeight.
    // Subtract that offset from pixel offsets past the expanded-entry boundary before dividing by row height.
    const expandedOffset = (ds.browseExpandedIdx !== null && ds.browseExpandedExtraHeight > 0)
        ? ds.browseExpandedExtraHeight : 0;
    const expandedBoundary = ds.browseExpandedIdx !== null
        ? (ds.browseExpandedIdx + 1) * BROWSE_ROW_HEIGHT : Infinity;
    const adjustedStart = relativeScroll > expandedBoundary
        ? relativeScroll - expandedOffset : relativeScroll;
    const adjustedEnd = (relativeScroll + viewHeight) > expandedBoundary
        ? (relativeScroll + viewHeight) - expandedOffset : (relativeScroll + viewHeight);
    const startIdx = Math.max(0, Math.floor(adjustedStart / BROWSE_ROW_HEIGHT) - BROWSE_OVERSCAN);
    const endIdx = Math.min(entries.length, Math.ceil(adjustedEnd / BROWSE_ROW_HEIGHT) + BROWSE_OVERSCAN);

    if (startIdx === ds.browseLastRangeStart && endIdx === ds.browseLastRangeEnd) return;
    ds.browseLastRangeStart = startIdx;
    ds.browseLastRangeEnd = endIdx;

    // BUG-AUDIT-3: see renderBrowseTab note on normalizePinBlock and vaultSource:title key.
    const pins = chat_metadata?.deeplore_pins || [];
    const blocks = chat_metadata?.deeplore_blocks || [];
    const pinSet = new Set(pins.map(p => { const n = normalizePinBlock(p); return `${n.vaultSource || ''}:${n.title.toLowerCase()}`; }));
    const blockSet = new Set(blocks.map(b => { const n = normalizePinBlock(b); return `${n.vaultSource || ''}:${n.title.toLowerCase()}`; }));
    // CHARACTER_MESSAGE_RENDERED moves sources to message.extra; lastPipelineTrace is the fallback.
    const injectedSet = new Set();
    const injSources = lastInjectionSources ?? lastPipelineTrace?.injected;
    if (injSources) {
        for (const s of injSources) injectedSet.add(s.title.toLowerCase());
    }

    const tempMap = computeEntryTemperatures();

    // Rejection lookup is cached; rebuild only when the trace identity changes.
    if (lastPipelineTrace !== _cachedRejectionTrace) {
        _cachedRejectionMap = new Map();
        _cachedRejectionTrace = lastPipelineTrace;
        if (lastPipelineTrace) {
            const rejGroups = categorizeRejections(lastPipelineTrace, injectedSet);
            for (const group of rejGroups) {
                for (const entry of group.entries) {
                    if (!_cachedRejectionMap.has(entry.title.toLowerCase())) {
                        _cachedRejectionMap.set(entry.title.toLowerCase(), { label: group.label, icon: group.icon, reason: entry.reason });
                    }
                }
            }
        }
    }
    const rejectionMap = _cachedRejectionMap;

    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
        const e = entries[i];
        const tl = e.title.toLowerCase();
        const pbKey = `${e.vaultSource || ''}:${tl}`;
        const isPinned = pinSet.has(pbKey);
        const isBlocked = blockSet.has(pbKey);
        const isInjected = injectedSet.has(tl);

        const classes = ['dle-browse-entry'];
        if (isInjected) classes.push('dle-browse-injected');

        const keysStr = e.constant ? '(constant)' : (e.keys ? e.keys.slice(0, 4).join(', ') : '');
        const prioLabel = e.constant ? 'CONST' : `P${e.priority || 50}`;
        const prioClass = e.constant ? ' dle-browse-constant' : '';

        const statusParts = [];
        if (isInjected) statusParts.push('Injected');
        if (isPinned) statusParts.push('pinned');
        if (isBlocked) statusParts.push('blocked');
        if (e.constant) statusParts.push('constant');
        const browseAriaLabel = `${escapeHtml(e.title)}, ${prioLabel}${statusParts.length ? ', ' + statusParts.join(', ') : ''}`;

        let top = i * BROWSE_ROW_HEIGHT;
        if (ds.browseExpandedIdx !== null && i > ds.browseExpandedIdx) {
            top += ds.browseExpandedExtraHeight;
        }
        const tempKey = trackerKey(e);
        const temp = tempMap.get(tempKey);
        const tempStyle = temp && temp.hue !== 'neutral' ? `--dle-temp:${temp.tempScore.toFixed(2)};--dle-temp-hue:${temp.hue};` : '';
        const tempClass = temp && temp.hue !== 'neutral' ? ` dle-temp-${temp.hue}` : '';

        const previewId = `dle-preview-${CSS.escape(trackerKey(e))}`;
        html += `<div class="${classes.join(' ')}${tempClass}" data-title="${escapeHtml(e.title)}" data-idx="${i}" role="listitem" aria-label="${browseAriaLabel}" aria-controls="${previewId}" aria-setsize="${entries.length}" aria-posinset="${i + 1}" style="position:absolute;top:${top}px;left:0;right:0;height:${BROWSE_ROW_HEIGHT}px;${tempStyle}">`;
        const _hoverParts = [];
        if (e.summary) _hoverParts.push(escapeHtml(e.summary));
        if (e.keys && e.keys.length) _hoverParts.push(`Keys: ${escapeHtml(e.keys.join(', '))}`);
        if (e.tokenEstimate) _hoverParts.push(`Tokens: ${e.tokenEstimate}`);
        const _hoverTitle = _hoverParts.length ? ` title="${_hoverParts.join('&#10;&#10;')}"` : '';
        html += `<div class="dle-browse-info" role="button" tabindex="0" aria-expanded="false" aria-label="Expand ${escapeHtml(e.title)} (Enter or click)" aria-describedby="${previewId}"${_hoverTitle}>`;
        html += `<span class="dle-browse-title">${escapeHtml(e.title)}${e.guide ? ' <span class="dle-browse-guide-pill" title="Writing guide — read by the Librarian (Emma) only, never sent to the writing AI. Add \'lorebook-guide\' tag to create one."><i class="fa-solid fa-book-open-reader" aria-hidden="true"></i> Guide</span>' : ''}</span>`;
        html += `<span class="dle-browse-keys" aria-label="Keywords: ${escapeHtml(keysStr || 'none')}">${escapeHtml(keysStr)}</span>`;
        html += `</div>`;
        html += `<div class="dle-browse-controls">`;
        const rejection = !isInjected ? rejectionMap.get(tl) : null;
        if (rejection) {
            html += `<span class="dle-browse-why-not" title="${escapeHtml(rejection.label)}: ${escapeHtml(rejection.reason)}" aria-label="${escapeHtml(rejection.label)}"><i class="fa-solid ${escapeHtml(rejection.icon)}" aria-hidden="true"></i></span>`;
        }
        const browseCount = chatInjectionCounts.get(trackerKey(e)) || 0;
        if (browseCount > 0) html += `<span class="dle-inject-count" title="Injected ${browseCount} times this chat" aria-label="Injected ${browseCount} times this chat">${browseCount}×</span>`;
        html += `<span class="dle-browse-priority${prioClass}" title="${e.constant ? 'Constant — always injected. Set via #lorebook-always tag.' : `Priority ${e.priority || 50} (lower = more important)`}" aria-label="${e.constant ? 'Constant entry, always injected' : `Priority ${e.priority || 50}`}">${prioLabel}</span>`;
        html += `<button class="dle-browse-pin${isPinned ? ' dle-pin-active' : ''}" data-entry="${escapeHtml(e.title)}" data-vault="${escapeHtml(e.vaultSource || '')}" aria-label="${isPinned ? 'Unpin' : 'Pin'}" title="${isPinned ? 'Pinned — always inject' : 'Click to pin'}"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>`;
        html += `<button class="dle-browse-block${isBlocked ? ' dle-block-active' : ''}" data-entry="${escapeHtml(e.title)}" data-vault="${escapeHtml(e.vaultSource || '')}" aria-label="${isBlocked ? 'Unblock' : 'Block'}" title="${isBlocked ? 'Blocked — never inject' : 'Click to block'}"><i class="fa-solid fa-ban" aria-hidden="true"></i></button>`;
        html += `<button class="dle-browse-copy-title-btn" data-action="copy-title" data-title="${escapeHtml(e.title)}" aria-label="Copy title" title="Copy title"><i class="fa-solid fa-copy" aria-hidden="true"></i></button>`;
        html += `</div>`;
        html += `</div>`;
    }

    $list.html(html);

    // Re-expand previously-expanded entry across re-renders, reusing cached preview HTML.
    if (ds.browseExpandedEntry) {
        const $entry = $list.find(`.dle-browse-entry[data-title="${CSS.escape(ds.browseExpandedEntry)}"]`);
        if ($entry.length) {
            const entry = ds.browseFilteredEntries.find(e => e.title === ds.browseExpandedEntry);
            if (entry) {
                // BUG-360: trackerKey (vaultSource:title) — bare title collides across vaults.
                const expandedKey = trackerKey(entry);
                if (_cachedExpandedPreviewKey !== expandedKey) {
                    const preview = entry.summary || (entry.content ? entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '') : 'No content');
                    const tokens = entry.tokenEstimate ? `${entry.tokenEstimate} tokens` : '';
                    const settings = getSettings();
                    const srcVault = entry.vaultSource && settings.vaults ? settings.vaults.find(v => v.name === entry.vaultSource) : null;
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
                    let relatedHtml = '';
                    const related = [];
                    for (const link of entry.resolvedLinks || []) {
                        if (!related.includes(link)) related.push(link);
                    }
                    if (related.length < 5) {
                        const entryKeys = new Set((entry.keys || []).map(k => k.toLowerCase()));
                        if (entryKeys.size > 0) {
                            for (const other of vaultIndex) {
                                if (other.title === entry.title) continue;
                                if (related.includes(other.title)) continue;
                                const overlap = (other.keys || []).filter(k => entryKeys.has(k.toLowerCase())).length;
                                if (overlap > 0) related.push(other.title);
                                if (related.length >= 5) break;
                            }
                        }
                    }
                    if (related.length > 0) {
                        relatedHtml = `<div class="dle-browse-related"><span class="dle-muted">Related:</span> `;
                        for (const r of related.slice(0, 5)) {
                            relatedHtml += `<span class="dle-browse-related-chip dle-browse-nav-btn" data-browse-title="${escapeHtml(r)}" title="Show in Browse">${escapeHtml(r)}</span>`;
                        }
                        relatedHtml += `</div>`;
                    }
                    _cachedExpandedPreviewHtml = `<div class="dle-browse-preview" id="dle-preview-${CSS.escape(expandedKey)}"><div class="dle-browse-preview-text">${escapeHtml(preview)}</div>${fieldsHtml}${relatedHtml}<div class="dle-browse-preview-meta">${escapeHtml(tokens)}${linkHtml}</div></div>`;
                    _cachedExpandedPreviewKey = expandedKey;
                }

                $entry.append(_cachedExpandedPreviewHtml);
                $entry.find('.dle-browse-info').attr('aria-expanded', 'true');
                $entry.css({ height: 'auto' });
                const expandedHeight = $entry[0].scrollHeight;
                ds.browseExpandedIdx = parseInt($entry.data('idx'), 10);
                ds.browseExpandedExtraHeight = Math.max(0, expandedHeight - BROWSE_ROW_HEIGHT);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Gating Tab
// ════════════════════════════════════════════════════════════════════════════

export function renderGatingTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const ctx = chat_metadata?.deeplore_context;

    // ── Folder filter section ──
    const activeFolders = chat_metadata?.deeplore_folder_filter || [];
    const $folderSection = $drawer.find('.dle-gating-folder-section');
    if ($folderSection.length) {
        const hasFolders = activeFolders.length > 0;
        $folderSection.find('.dle-folder-dot')
            .toggleClass('dle-gating-dot-active', hasFolders)
            .toggleClass('dle-gating-dot-empty', !hasFolders);
        const $chips = $folderSection.find('.dle-folder-chips');
        const $empty = $folderSection.find('.dle-folder-empty');
        if (hasFolders) {
            let chipsHtml = '';
            for (const f of activeFolders) {
                chipsHtml += `<span class="dle-chip" title="${escapeHtml(f)}">${escapeHtml(f)} <button class="dle-chip-x dle-folder-chip-x" data-folder="${escapeHtml(f)}" aria-label="Remove ${escapeHtml(f)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`;
            }
            const excluded = vaultIndex.filter(e => {
                if (!e.folderPath) return false;
                return !activeFolders.some(f => e.folderPath === f || e.folderPath.startsWith(f + '/'));
            }).length;
            if (excluded > 0) {
                chipsHtml += `<span class="dle-gating-count" title="${excluded} entries outside selected folders will be filtered out" aria-label="Excluding ${excluded} entries">excluding ${excluded}</span>`;
            }
            $chips.html(chipsHtml).show();
            $empty.hide();
        } else {
            $chips.empty().hide();
            $empty.show();
        }
    }

    const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;

    const $container = $drawer.find('.dle-gating-fields-container');
    const enabledDefs = fieldDefs.filter(fd => fd.gating?.enabled);
    if ($container.length) {
        $container.empty();
        for (const fd of enabledDefs) {
            const hasValue = ctx && (fd.multi
                ? (Array.isArray(ctx[fd.contextKey]) && ctx[fd.contextKey].length > 0)
                : !!ctx[fd.contextKey]);
            const dotClass = hasValue ? 'dle-gating-dot-active' : 'dle-gating-dot-empty';
            const setIcon = fd.multi ? 'fa-plus-circle' : 'fa-pen-to-square';
            const setLabel = fd.multi ? `Add to ${escapeHtml(fd.label)}` : `Set ${escapeHtml(fd.label)}`;
            const fieldHtml = `<div class="dle-gating-group" data-field="${escapeHtml(fd.name)}"${fd.multi ? ' data-multi="true"' : ''}>
                <span class="dle-gating-dot ${dotClass}" aria-hidden="true"></span>
                <span class="dle-gating-label" id="dle-gating-${escapeHtml(fd.name)}" title="${escapeHtml(fd.label)}">${escapeHtml(fd.label)}</span>
                <div class="dle-gating-value" aria-labelledby="dle-gating-${escapeHtml(fd.name)}">
                    <button class="menu_button menu_button_icon dle-gating-set" title="${setLabel}" aria-label="${setLabel}">
                        <i class="fa-solid ${setIcon}" aria-hidden="true"></i>
                    </button>
                </div>
            </div>`;
            $container.append(fieldHtml);
        }
        const anySet = enabledDefs.some(fd => {
            if (!ctx) return false;
            return fd.multi
                ? (Array.isArray(ctx[fd.contextKey]) && ctx[fd.contextKey].length > 0)
                : !!ctx[fd.contextKey];
        });
        $container.find('.dle-gating-hint').remove();
        if (!anySet && enabledDefs.length > 0) {
            $container.append('<div class="dle-gating-hint">Set gating fields to filter which lore entries are included. Set via slash command (<code>/dle-set-field</code>) or click the field below.</div>');
        }
    }

    for (const fd of fieldDefs) {
        if (!fd.gating?.enabled) continue;
        const $group = $drawer.find(`.dle-gating-group[data-field="${fd.name}"]`);
        const $value = $group.find('.dle-gating-value');
        const value = ctx ? ctx[fd.contextKey] : null;
        const $setBtn = $value.find('.dle-gating-set');

        $value.find('.dle-chip, .dle-gating-empty, .dle-gating-count, .dle-gating-clear-btn').remove();

        if (!fd.multi) {
            if (value) {
                $setBtn.before(`<span class="dle-chip">${escapeHtml(value)} <button class="dle-chip-x" data-field="${escapeHtml(fd.name)}" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span><button class="dle-gating-clear-btn" type="button" data-action="clear-gating-field" data-field="${escapeHtml(fd.name)}" aria-label="Clear ${escapeHtml(fd.label)}">×</button>`);
                // Impact count: entries with this field set that don't match the active value.
                const filtered = vaultIndex.filter(e => {
                    const val = e.customFields?.[fd.name];
                    if (!val || (Array.isArray(val) && val.length === 0)) return false;
                    if (Array.isArray(val)) return !val.some(v => v.toLowerCase() === value.toLowerCase());
                    return String(val).toLowerCase() !== value.toLowerCase();
                }).length;
                if (filtered > 0) {
                    $setBtn.before(`<span class="dle-gating-count" aria-label="Excluding ${filtered} entries" title="${filtered} entries don't match this value and will be filtered out">excluding ${filtered}</span>`);
                }
            } else {
                $setBtn.before(`<span class="dle-gating-empty" aria-label="${escapeHtml(fd.label)}: not set">Not set — click + to filter</span>`);
            }
        } else {
            // Array (multi-value) field.
            if (value && value.length > 0) {
                for (const c of value) {
                    $setBtn.before(`<span class="dle-chip">${escapeHtml(c)} <button class="dle-chip-x" data-field="${escapeHtml(fd.name)}" data-value="${escapeHtml(c)}" aria-label="Remove ${escapeHtml(c)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
                }
                // Impact count: entries with this field set but no value-overlap with the active selection.
                const activeSet = new Set(value.map(c => c.toLowerCase()));
                const filtered = vaultIndex.filter(e => {
                    const eVal = e.customFields?.[fd.name];
                    return eVal?.length && !eVal.some(v => activeSet.has(v.toLowerCase()));
                }).length;
                if (filtered > 0) {
                    $setBtn.before(`<span class="dle-gating-count" aria-label="Excluding ${filtered} entries" title="${filtered} entries don't match this value and will be filtered out">excluding ${filtered}</span>`);
                }
                $setBtn.before(`<button class="dle-gating-clear-btn" type="button" data-action="clear-gating-field-all" data-field="${escapeHtml(fd.name)}" aria-label="Clear all ${escapeHtml(fd.label)}">Clear all</button>`);
            } else {
                $setBtn.before(`<span class="dle-gating-empty" aria-label="${escapeHtml(fd.label)}: none set">None set — click + to add</span>`);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Timers
// ════════════════════════════════════════════════════════════════════════════

export function renderTimers() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $list = $drawer.find('.dle-timer-list');
    const $empty = $drawer.find('.dle-timer-empty');
    const rows = [];
    const settings = getSettings();

    let timerIdx = 0;
    for (const [key, remaining] of cooldownTracker) {
        const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
        rows.push(`<div class="dle-timer-row" style="--i:${timerIdx++}" role="listitem">
            <span class="dle-timer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="dle-timer-badge dle-timer-cooldown">${remaining} message${remaining !== 1 ? 's' : ''} cooldown</span>
        </div>`);
    }

    // Decay: only render entries past the boost threshold.
    if (settings.decayEnabled) {
        const boostThreshold = settings.decayBoostThreshold || 5;
        for (const [key, staleness] of decayTracker) {
            if (staleness >= boostThreshold) {
                const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
                rows.push(`<div class="dle-timer-row" style="--i:${timerIdx++}" role="listitem">
                    <span class="dle-timer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="dle-timer-badge dle-timer-stale">stale ${staleness} message${staleness !== 1 ? 's' : ''}</span>
                </div>`);
            }
        }
    }

    // Warmup is static config (entry.warmup threshold), not an active timer — intentionally not surfaced here.

    $list.html(rows.join(''));
    $empty.toggleClass('dle-visible', rows.length === 0);
}
