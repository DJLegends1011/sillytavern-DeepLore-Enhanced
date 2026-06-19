import { chat_metadata, getCurrentChatId } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex,
    indexing, indexEverLoaded, computeOverallStatus,
    vaultAvgTokens, claudeAutoEffortBad, claudeAutoEffortDetail,
    pipelinePhase, pipelineLabelFor,
    suppressNextAgenticLoop,
} from '../state.js';
import { getCurrentForChat as getCurrentVerdictForChat } from '../verdict/verdict-store.js';

// Local helper — UI consumers must read the CURRENT CHAT's verdict, not the
// ring-global newest. See docs/gotchas.md #46 ("UI consumer rule").
function _currentVerdictForChat() {
    let cid = null;
    try { cid = getCurrentChatId() ?? null; } catch { cid = null; }
    return getCurrentVerdictForChat(cid);
}
import { getCircuitState } from '../vault/obsidian-api.js';
import { ds, MODE_LABELS, MODE_DESCRIPTIONS, announceToScreenReader, formatTokensCompact } from './drawer-state.js';

let _lastAnnouncedStatus = null;
let _lastSkipToolsState = null;

// C1 (v2.5 Wave 2): the glyph is now PURE ACTIVITY — a spinner while the pipeline is
// working, this static DLE brand icon at idle. The old STATUS_SVG_CHOOSING / STATUS_SVG_WRITING
// mascot variants were removed: 3 shapes could never honestly map to 6+ phases (the phase text
// label carries the granularity now). Cleaned Illustrator export: fills → currentColor.
const STATUS_SVG_IDLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 375" fill="currentColor"><path fill-rule="evenodd" d="M228.93,357.53c-18.46,0-36.93.01-55.39,0-6.97-.01-8.36-1.48-9.99-8.39-2.72-11.52-5.63-23-8.76-34.42-2.56-9.33-9.19-14.32-18.63-14.47-9.81-.16-19.64.7-29.46,1.07-5.48.21-10.97.69-16.43.39-10.65-.57-17.71-6.08-19.97-16.53-1.95-8.99-2.53-18.27-3.88-27.4-.69-4.68-1.54-9.37-2.69-13.95-1.9-7.57-6.22-13.53-12.7-17.91-2.38-1.61-4.81-3.16-7.01-4.99-5.17-4.31-5.96-10.54-2.05-15.99 1.6-2.22 3.34-4.4 5.3-6.3 16.1-15.59 21.18-34.5 18.11-56.44-2.72-19.49-1-38.65 7.38-56.82 11.32-24.54 29.97-41.76 53.8-53.62 28.48-14.17 58.65-17.71 89.94-13.77 21.29 2.68 41.42 8.79 59.64 20.37 29.01 18.43 45.39 45.46 53.11 78.47 9.34 39.95.48 76.21-21.62 109.87-4.59 6.99-9.5 13.76-14.39 20.54-9.35 12.96-12.51 27.64-11.48 43.25 1.26 19.02 5.93 37.44 10.96 55.75 2.14 7.78-.46 11.27-8.4 11.28-18.46.02-36.93 0-55.39 0z M188,233.59c-16.46-1.72-30.63-7.05-43.31-16.24-29.56-21.43-42.78-57.87-33.99-93.49 8.51-34.48 37.98-60.73 73.77-65.7 26.63-3.7 47.26 9.82 52.96 34.69 3.84 16.77-2.95 32.93-18.08 43.06-8 5.36-17.03 8.15-26.18 10.68-11.24 3.11-21.53 8.02-29.43 16.92-15.47 17.44-12.46 44.92 6.63 60.72 2.48 2.05 5.24 3.84 8.08 5.37 2.71 1.46 5.7 2.42 9.55 3.99z M197.15,203.71c-6.05-.16-10.86-5.23-10.64-11.21.22-5.99 5.38-10.87 11.27-10.68 5.96.2 10.89 5.44 10.64 11.3-.26 6.13-5.18 6.75-11.27 10.59z"/><path d="M197.59,90.51c5.96.08 10.95 5.17 10.86 11.09-.08 5.92-5.21 10.95-11.09 10.88-5.95-.07-10.91-5.16-10.84-11.1.07-6 5.12-10.95 11.07-10.87z"/></svg>`;

export function renderStatusZone() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const settings = getSettings();

    const status = computeOverallStatus(getCircuitState());

    // Skip the very first baseline set — only announce subsequent transitions.
    if (_lastAnnouncedStatus !== null && _lastAnnouncedStatus !== status) {
        announceToScreenReader(`Status: ${status}`);
    }
    _lastAnnouncedStatus = status;

    // C1 (Wave 2): the glyph is PURE ACTIVITY — a spinner while the pipeline works, the static
    // DLE brand icon at idle. C2: health no longer colors the glyph or pulses it (the old
    // STATUS_CLASSES color + dle-status-changed transition pulse are gone). The SR-only status
    // announce above is kept as an a11y live-region signal, but the visible dot carries activity
    // only; system health lives entirely in the footer health icons now.
    const $dot = $drawer.find('.dle-status-dot');
    const isActive = !!indexing || pipelinePhase !== 'idle' || ds.stGenerating;
    $dot.html(isActive
        ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>'
        : STATUS_SVG_IDLE);
    $dot.toggleClass('dle-status-active', isActive);

    // C3: canonical phase labels (state.PIPELINE_PHASE_LABELS) — single source of truth shared
    // with the chat toast (_updatePipelineStatus in index.js). Sub-second stages keep the prior
    // phase's label (no flicker). Indexing is its own top-level phase.
    const pipelineText = indexing
        ? pipelineLabelFor('indexing')
        : (pipelinePhase !== 'idle'
            ? pipelineLabelFor(pipelinePhase)
            : (ds.stGenerating ? pipelineLabelFor('generating') : pipelineLabelFor('idle')));
    // The dot is the activity glyph AND a click target for full status (handler bound elsewhere).
    $dot.attr('title', `DeepLore activity: ${pipelineText} — click for full status`)
        .attr('aria-label', `DeepLore activity: ${pipelineText} — click for full status`);
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Status: ${pipelineText}`).attr('aria-live', 'polite');

    const $skipBtn = $drawer.find('.dle-action-btn[data-action="skip-tools"]');
    $skipBtn.toggleClass('dle-toggle-active', suppressNextAgenticLoop);
    const $skipLabel = $skipBtn.find('.dle-action-label');
    if ($skipLabel.length) {
        $skipLabel.text(suppressNextAgenticLoop ? 'Skipping Next' : 'Skip Librarian');
    }
    $skipBtn.attr('title', suppressNextAgenticLoop
        ? 'Librarian will be skipped on the next reply (click to re-enable)'
        : 'Skip Librarian tools for next generation');
    if (_lastSkipToolsState !== null && _lastSkipToolsState !== suppressNextAgenticLoop) {
        $skipBtn.removeClass('dle-skip-tools-pulse');
        requestAnimationFrame(() => {
            $skipBtn.addClass('dle-skip-tools-pulse').off('animationend.skiptoolspulse').one('animationend.skiptoolspulse', function () {
                $(this).removeClass('dle-skip-tools-pulse');
            });
        });
    }
    _lastSkipToolsState = suppressNextAgenticLoop;

    const $setupBanner = $drawer.find('.dle-setup-banner');
    const hasEnabledVaults = (settings.vaults || []).some(v => v.enabled);
    if (!hasEnabledVaults && !settings._wizardCompleted && !indexEverLoaded) {
        if (!$setupBanner.length) {
            const banner = `<div class="dle-setup-banner" role="status" style="padding: var(--dle-space-2) var(--dle-space-3); background: color-mix(in srgb, var(--dle-info) 15%, transparent); border-radius: 4px; margin: var(--dle-space-2) 0; display: flex; align-items: center; gap: var(--dle-space-2); font-size: var(--dle-text-sm);">
                <i class="fa-solid fa-wand-magic-sparkles" style="color: var(--dle-info);"></i>
                <span>New to DeepLore?</span>
                <button class="dle-setup-banner-btn menu_button" style="padding: 4px 12px; min-height: 28px; font-size: var(--dle-text-xs);" title="Run the setup wizard">Run Setup</button>
                <button class="dle-setup-banner-dismiss" style="margin-left: auto; background: none; border: none; cursor: pointer; opacity: 0.5; padding: 2px;" title="Dismiss" aria-label="Dismiss setup banner"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
            $drawer.find('.dle-zone-status').after(banner);
        }
    } else {
        $setupBanner.remove();
    }

    // Cold start: show loading shimmer instead of "0" stats before the first index build.
    if (!indexEverLoaded && vaultIndex.length === 0 && !indexing) {
        $drawer.find('[data-stat="entries"]').html('<span class="dle-shimmer">…</span>');
        $drawer.find('[data-stat="tokens"]').html('<span class="dle-shimmer">…</span>');
        $drawer.find('.dle-pipeline-label').text('Connecting to Obsidian…');
    }

    // Stat values get a flash animation on change. Verdict store holds the authoritative
    // trace + injected sources together — no fallback needed.
    const _statusVerdict = _currentVerdictForChat();
    const entryCount = indexing ? '…' : vaultIndex.length;
    const $entries = $drawer.find('[data-stat="entries"]');
    if ($entries.text() !== String(entryCount)) {
        $entries.text(entryCount);
        const $eStat = $entries.closest('.dle-stat');
        $eStat.removeClass('dle-stat-changed');
        $eStat[0]?.offsetWidth; // force reflow → restart animation
        const _eStatEl = $eStat[0];
        $eStat.addClass('dle-stat-changed').off('animationend.statclean').one('animationend.statclean', function () { $(this).removeClass('dle-stat-changed'); });
        setTimeout(() => { if (_eStatEl) $(_eStatEl).removeClass('dle-stat-changed'); }, 600);
    }
    const vaultCount = settings.vaults?.filter(v => v.enabled !== false).length || 1;
    const entryTitle = indexing
        ? 'Loading lore entries...'
        : `${entryCount} lore entr${entryCount === 1 ? 'y' : 'ies'} loaded from ${vaultCount === 1 ? 'your Obsidian vault' : `${vaultCount} Obsidian vaults`}`;
    $entries.closest('.dle-stat').attr('title', entryTitle).attr('aria-label', entryTitle);

    const mode = settings.aiSearchEnabled !== false
        ? (MODE_LABELS[settings.aiSearchMode] || settings.aiSearchMode || '—')
        : 'Keywords';
    const modeKey = settings.aiSearchEnabled !== false ? (settings.aiSearchMode || 'two-stage') : 'keywords-only';
    const modeDesc = MODE_DESCRIPTIONS[modeKey] || mode;
    const modeTitle = `Search mode: ${mode} — ${modeDesc}`;
    $drawer.find('[data-stat="mode"]').text(mode).attr('title', modeTitle).attr('aria-label', modeTitle);

    // Token bar. When unlimited budget: bar shows proportion of total vault being injected
    // (used / total vault tokens) so users still see relative scale; floor at 1% so the bar is visible.
    const trace = _statusVerdict?.trace ?? null;
    const budget = settings.unlimitedBudget ? 0 : (settings.maxTokensBudget || 0);
    const used = trace?.totalTokens || 0;
    const totalVaultTokens = vaultIndex.length * (vaultAvgTokens || 200);
    const pct = budget
        ? Math.min(100, Math.round((used / (budget || 1)) * 100))
        : (settings.unlimitedBudget && used > 0 && totalVaultTokens > 0)
            ? Math.min(100, Math.round((used / totalVaultTokens) * 100)) || 1
            : 0;
    const $barContainer = $drawer.find('.dle-token-bar-container');
    $barContainer.attr('aria-valuenow', used).attr('aria-valuemax', budget);
    // B1/B4: header bars never go red. This bar shows "this round's lore selection" — a cap
    // hit means the limiter worked, shown calmly, not an alarm. The ONE earned-red bar is the
    // footer context bar (overflow). Clear any legacy hazard classes; never re-add them.
    $barContainer.removeClass('dle-budget-high dle-budget-critical');
    // Wave C: calm pre-truncation cue. At >=85% fill the bar enters a NEAR-CAP tier — a subtle
    // warning tint (NOT red; "footer earns red / calm header"), telling the user lore is about to
    // be trimmed BEFORE a cut actually happens. Only meaningful when a real cap is configured.
    const _tokenNearCap = !!budget && pct >= 85;
    $barContainer.toggleClass('dle-budget-near', _tokenNearCap);
    $drawer.find('.dle-token-bar').css('width', `${pct}%`);
    // B2: soft, non-alarm note ONLY when the budget actually cost lore — i.e. an entry was
    // truncated to fit. Neutral copy; no alarm verbs, no red/hatch/glow. Signal from
    // trace.injected[].truncated (set in core/matching.js when budget forces a cut).
    const _truncatedAny = Array.isArray(trace?.injected) && trace.injected.some(e => e.truncated);
    const $tokenNote = $drawer.find('.dle-token-bar-note');
    if ($tokenNote.length) {
        if (_truncatedAny) $tokenNote.text('trimmed to fit').removeClass('dle-hidden');
        else $tokenNote.text('').addClass('dle-hidden');
    }
    const budgetLabel = budget
        ? `Budget: ${formatTokensCompact(used)} / ${formatTokensCompact(budget)}`
        : settings.unlimitedBudget
            ? `Budget: ${formatTokensCompact(used)} / \u221E`
            : 'Budget: waiting';
    $drawer.find('.dle-token-bar-label').text(budgetLabel);
    let breakdownParts = [];
    if (trace?.injected?.length) {
        const src = _statusVerdict?.injectedSources || [];
        // Key by trackerKey (vaultSource:title.toLowerCase()), not bare title — two
        // cross-vault entries sharing a title would otherwise collide and misattribute
        // one entry's tokens to the wrong bucket. Mirrors every sibling drawer site
        // (gotcha #50; trackerKey invariant). See test MV-DTK in regression.test.mjs.
        const srcMap = new Map(src.map(s => [`${s.vaultSource || ''}:${(s.title || '').toLowerCase()}`, (s.matchedBy || '').toLowerCase()]));
        let constTokens = 0, keywordTokens = 0, aiTokens = 0, pinTokens = 0, otherTokens = 0;
        for (const e of trace.injected) {
            const reason = srcMap.get(`${e.vaultSource || ''}:${(e.title || '').toLowerCase()}`) || '';
            if (reason.includes('constant') || reason.includes('always')) constTokens += e.tokens;
            else if (reason.startsWith('ai:') || reason.includes('ai selection')) aiTokens += e.tokens;
            else if (reason.includes('pinned')) pinTokens += e.tokens;
            else if (reason.includes('fuzzy') || reason.includes('keyword') || reason.includes('(')) keywordTokens += e.tokens;
            else otherTokens += e.tokens;
        }
        if (constTokens) breakdownParts.push(`Constants: ${formatTokensCompact(constTokens)}`);
        if (keywordTokens) breakdownParts.push(`Keyword: ${formatTokensCompact(keywordTokens)}`);
        if (aiTokens) breakdownParts.push(`AI: ${formatTokensCompact(aiTokens)}`);
        if (pinTokens) breakdownParts.push(`Pinned: ${formatTokensCompact(pinTokens)}`);
        if (otherTokens) breakdownParts.push(`Other: ${formatTokensCompact(otherTokens)}`);
    }
    const breakdownStr = breakdownParts.length ? `\n${breakdownParts.join(' | ')}` : '';
    const tokenTitle = budget
        ? `Lore budget: ${formatTokensCompact(used)} of ${formatTokensCompact(budget)} tokens used${breakdownStr}`
        : settings.unlimitedBudget
            ? `Lore budget: ${formatTokensCompact(used)} tokens used (unlimited)${breakdownStr}`
            : 'Lore budget: waiting for first generation';
    $barContainer.attr('title', tokenTitle);

    // B3: the bar counts only cap-governed (positional) entries against maxEntries. Outlets
    // bypass the cap (core/matching.js — position NONE, placed via {{outlet::name}} macros)
    // yet land in trace.injected, so counting them let the bar read e.g. "7/5" clamped to
    // 100%. trace.injected[].outlet flags them; surface outlets separately so the bar tells
    // the truth about the limiter and outlets aren't silently folded into a cap they ignore.
    const _injArr = _statusVerdict?.trace?.injected;
    let injectedNum, outletNum = 0;
    if (Array.isArray(_injArr)) {
        outletNum = _injArr.filter(e => e.outlet).length;
        injectedNum = _injArr.length - outletNum;
    } else {
        // No trace this turn → fall back to the source count (no outlet split available).
        injectedNum = _statusVerdict?.injectedSources?.length ?? 0;
    }
    const maxEntries = settings.unlimitedEntries ? 0 : (settings.maxEntries || 0);
    const entriesPct = maxEntries
        ? Math.min(100, Math.round((injectedNum / maxEntries) * 100))
        : (settings.unlimitedEntries && injectedNum > 0 && vaultIndex.length > 0)
            ? Math.min(100, Math.round((injectedNum / vaultIndex.length) * 100)) || 1
            : 0;
    const $entriesBarContainer = $drawer.find('.dle-entries-bar-container');
    $entriesBarContainer.toggleClass('dle-indexing-shimmer', !!indexing);
    $entriesBarContainer.attr('aria-valuenow', injectedNum).attr('aria-valuemax', maxEntries);
    // B1/B4: header entries bar never goes red. Clear legacy hazard classes; never re-add.
    $entriesBarContainer.removeClass('dle-budget-high dle-budget-critical');
    // Wave C: same calm NEAR-CAP cue as the token bar — >=85% of the entry cap.
    const _entriesNearCap = !!maxEntries && entriesPct >= 85;
    $entriesBarContainer.toggleClass('dle-budget-near', _entriesNearCap);
    $drawer.find('.dle-entries-bar').css('width', `${entriesPct}%`);
    const _outletSuffix = outletNum > 0 ? ` (+${outletNum} outlet)` : '';
    const entriesLabel = maxEntries
        ? `Entries | ${injectedNum} / ${maxEntries}${_outletSuffix}`
        : settings.unlimitedEntries
            ? `Entries | ${injectedNum} / \u221E${_outletSuffix}`
            : 'Entries | waiting';
    $drawer.find('.dle-entries-bar-label').text(entriesLabel);
    // B2: soft note ONLY when the entry cap actually cost lore \u2014 more positional candidates
    // matched than were shown. Neutral "N of M shown", no alarm styling. positionalCandidates
    // = positional injected + budgetCut (set in index.js); falls back to injectedNum (no note).
    const _positionalCandidates = Number.isFinite(trace?.positionalCandidates) ? trace.positionalCandidates : injectedNum;
    const _entriesTrimmed = _positionalCandidates > injectedNum;
    const $entriesNote = $drawer.find('.dle-entries-bar-note');
    if ($entriesNote.length) {
        if (_entriesTrimmed) $entriesNote.text(`${injectedNum} of ${_positionalCandidates} shown`).removeClass('dle-hidden');
        else $entriesNote.text('').addClass('dle-hidden');
    }
    const _outletTitle = outletNum > 0
        ? ` Plus ${outletNum} outlet ${outletNum === 1 ? 'entry' : 'entries'} placed via {{outlet}} macros — these bypass the entry cap.`
        : '';
    const entriesTitle = (maxEntries
        ? `${injectedNum} of ${maxEntries} entr${maxEntries === 1 ? 'y' : 'ies'} injected — limits how many lore entries are included per message`
        : settings.unlimitedEntries
            ? `${injectedNum} entr${injectedNum === 1 ? 'y' : 'ies'} injected (unlimited) — no entry count cap configured`
            : 'Entry limit: waiting for first generation') + _outletTitle;
    $entriesBarContainer.attr('title', entriesTitle);

    const ctx = chat_metadata?.deeplore_context;
    const $filters = $drawer.find('.dle-active-filters');
    const chips = [];
    const activeFolders = chat_metadata?.deeplore_folder_filter || [];
    const xBtn = (label) => `<button type="button" class="dle-chip-x" aria-label="Remove filter: ${escapeHtml(label)}" title="Remove filter"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    if (activeFolders.length > 0) {
        const folderLabel = activeFolders.length === 1 ? activeFolders[0] : `${activeFolders.length} folders`;
        chips.push(`<span class="dle-chip dle-chip-sm dle-folder-badge-chip" role="button" aria-pressed="true" tabindex="0" title="Folder filter active: ${escapeHtml(activeFolders.join(', '))}" data-action="goto-gating"><i class="fa-solid fa-folder" aria-hidden="true" style="margin-right:3px;font-size:0.8em;"></i>${escapeHtml(folderLabel)}<button type="button" class="dle-chip-x dle-chip-x-folder" aria-label="Clear folder filter" title="Clear folder filter"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
    }
    if (ctx) {
        for (const [key, val] of Object.entries(ctx)) {
            if (val == null || val === '') continue;
            if (Array.isArray(val)) {
                for (const v of val) chips.push(`<span class="dle-chip dle-chip-sm dle-gating-value-chip" role="button" tabindex="0" data-action="goto-gating" data-ctx-key="${escapeHtml(key)}" data-ctx-val="${escapeHtml(v)}" aria-label="${escapeHtml(key)}: ${escapeHtml(v)} — click to open Filters tab">${escapeHtml(v)}${xBtn(`${key}: ${v}`)}</span>`);
            } else {
                chips.push(`<span class="dle-chip dle-chip-sm dle-gating-value-chip" role="button" tabindex="0" data-action="goto-gating" data-ctx-key="${escapeHtml(key)}" data-ctx-val="${escapeHtml(val)}" aria-label="${escapeHtml(key)}: ${escapeHtml(val)} — click to open Filters tab">${escapeHtml(val)}${xBtn(`${key}: ${val}`)}</span>`);
            }
        }
    }
    // "Clear all" chip when 2+ active filter chips are visible.
    if (chips.length >= 2) {
        chips.push('<button type="button" class="dle-chip dle-chip-sm dle-chip-clear-all" aria-label="Clear all active filters" title="Clear all active filters">Clear all ×</button>');
    }
    // Claude adaptive-thinking misconfiguration: persistent chip rather than spammy toasts.
    // ds.reasoningWarningDismissed is session-scoped — re-shown after reload.
    if (claudeAutoEffortBad && claudeAutoEffortDetail && !ds.reasoningWarningDismissed) {
        const d = claudeAutoEffortDetail;
        const tip = `${d.modelName || 'Claude'} on profile "${d.profileName || '?'}" needs reasoning_effort set on preset "${d.presetName || '?'}" (Low/Medium/High). Click to open settings.`;
        chips.push(`<button type="button" class="dle-chip dle-chip-sm dle-chip-warn dle-reasoning-warning-btn" title="${escapeHtml(tip)}" data-action="goto-ai-connections" aria-label="Reasoning Effort misconfigured — click to open settings" style="background:color-mix(in srgb, var(--dle-warning, #d97706) 20%, transparent);color:var(--dle-warning, #d97706);display:inline-flex;align-items:center;gap:3px;cursor:pointer;border:none;"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true" style="font-size:0.8em;"></i>Reasoning Effort<span class="dle-chip-dismiss" role="button" tabindex="0" aria-label="Dismiss warning" style="margin-left:4px;opacity:0.7;font-size:1em;line-height:1;">×</span></button>`);
    }

    if (chips.length > 0) {
        $filters.html(chips.join(''));
        $filters.show();
    } else {
        $filters.empty().hide();
    }

    updateTabBadges();
}

export function updateTabBadges() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    // Verdict store holds injectedSources + trace together; either path resolves count.
    const _badgeVerdict = _currentVerdictForChat();
    const injCount = _badgeVerdict?.injectedSources?.length ?? _badgeVerdict?.trace?.injected?.length ?? 0;
    $drawer.find('[data-badge="injection"]').text(injCount || '');

    const browseTotal = vaultIndex?.length || 0;
    const hasActiveFilters = ds.browseQuery || ds.browseStatusFilter !== 'all' || ds.browseTagFilter || ds.browseFolderFilter || Object.keys(ds.browseCustomFieldFilters).length > 0;
    const browseLabel = hasActiveFilters && ds.browseFilteredEntries.length !== browseTotal
        ? `${ds.browseFilteredEntries.length}/${browseTotal}`
        : (browseTotal || '');
    $drawer.find('[data-badge="browse"]').text(browseLabel);

    const gatingCtx = chat_metadata?.deeplore_context;
    let gatingCount = 0;
    if (gatingCtx) {
        for (const val of Object.values(gatingCtx)) {
            if (val == null || val === '') continue;
            if (Array.isArray(val)) gatingCount += val.length;
            else gatingCount++;
        }
    }
    const gatingFolders = chat_metadata?.deeplore_folder_filter;
    if (gatingFolders?.length) gatingCount += gatingFolders.length;
    $drawer.find('[data-badge="gating"]').text(gatingCount || '');
}
