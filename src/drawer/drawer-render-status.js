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
import { tr } from '../i18n/i18n.js';

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
let _lastAnnouncedPhase = null;
let _lastSkipToolsState = null;

// Wave I: the status glyph is a single persistent <goo-spinner> (created once in
// renderStatusZone). Activity is signalled by its SPEED attribute (faster while the
// pipeline works) instead of swapping glyphs — honouring gotcha #74's "glyph hints
// activity" while the goo serves as the DLE brand mark everywhere. The old static brand
// SVG (STATUS_SVG_IDLE) + the FA spinner it alternated with were both retired here.

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
    // Wave I: one persistent goo-spinner — created once so the jelly physics never restart
    // across the many renderStatusZone calls. Speed (not glyph swap) carries activity.
    let dotSpinner = $dot.find('goo-spinner')[0];
    if (!dotSpinner) {
        $dot.html('<goo-spinner size="40" color="currentColor" aria-hidden="true"></goo-spinner>');
        dotSpinner = $dot.find('goo-spinner')[0];
    }
    // f027: idle must read as a genuine resting state, not "still working slowly".
    // Active = brisk gel; idle = STOPPED (speed 0) so the goo holds still, paired with
    // CSS that desaturates/dims the idle dot and mutes the label. The binary working/idle
    // is now carried by motion + color + label weight, not a 0.25-vs-1.4 wobble nobody reads.
    //
    // f045/f108 (reduced-motion coherence): under prefers-reduced-motion the goo freezes
    // (goo-spinner.js stops its rAF loop and reflects data-motion-state="reduced"), so this
    // speed value is inert there. Activity then reads from THREE non-motion channels that the
    // reduced-motion CSS block leaves intact: the dot's accent/opacity/saturation shift, the
    // label weight/color, and a deliberate SLOW STEPPED opacity pulse the CSS applies only to
    // an active dot whose goo is frozen (`.dle-status-active goo-spinner[data-motion-state="reduced"]`).
    // Idle (paused) never pulses — the stepped-pulse rule requires .dle-status-active. So idle
    // vs active vs reduced-motion stay coherent without per-render JS branching here. The dot
    // stays PURE ACTIVITY (gotcha #74); system health remains in the footer health icons only.
    if (dotSpinner) dotSpinner.setAttribute('speed', isActive ? '1.4' : '0');
    $dot.toggleClass('dle-status-active', isActive);
    // Mirror the active state onto the label so its color/weight can shift in CSS.
    $drawer.find('.dle-pipeline-label').toggleClass('dle-status-active', isActive);

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
    // No aria-live here — the visible label is plain content; status transitions are announced
    // once at polite urgency via #dle-drawer-live above (announceToScreenReader). f106.
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Status: ${pipelineText}`);

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

    // Cold start: show a content-shaped skeleton block instead of "0" stats before the
    // first index build. The skeleton reserves the eventual number's footprint (so the
    // real value doesn't reflow the tile on first paint) and reads as "loading" rather
    // than the old dim "…" that looked like an error/unknown state. f091.
    const isColdWaiting = !indexEverLoaded && vaultIndex.length === 0 && !indexing;
    if (isColdWaiting) {
        $drawer.find('[data-stat="entries"]').html('<span class="dle-skeleton" aria-hidden="true"></span>');
        const _connectingText = tr('dle_status_connecting', 'Connecting to Obsidian…');
        // Re-set aria-label alongside the text so SR announces "Connecting…", not the
        // idle phase label set above (DS-2).
        $drawer.find('.dle-pipeline-label').text(_connectingText).attr('aria-label', `Status: ${_connectingText}`);
    }

    // html-1: the .dle-pipeline-label is not a live region (f106 — nesting live regions
    // double-announced), so phase progression (Choosing lore → Consulting vault →
    // Generating) is otherwise silent to screen readers despite the comment promising it.
    // Announce the displayed phase text once, at polite urgency, through #dle-drawer-live
    // when it changes. Skip the idle baseline so SR isn't told "Idle" on every render.
    const _displayedPhaseText = isColdWaiting
        ? tr('dle_status_connecting', 'Connecting to Obsidian…')
        : pipelineText;
    if (_lastAnnouncedPhase !== null && _lastAnnouncedPhase !== _displayedPhaseText) {
        announceToScreenReader(_displayedPhaseText);
    }
    _lastAnnouncedPhase = _displayedPhaseText;

    // Stat values get a flash animation on change. Verdict store holds the authoritative
    // trace + injected sources together — no fallback needed.
    const _statusVerdict = _currentVerdictForChat();
    // Optimistic refresh (f093): a background reuse-sync flips `indexing` true while a
    // perfectly valid prior index is still in memory and still driving the current
    // generation. Don't blank the live count to '…' — that implies data loss where none
    // occurred. Keep the last-known number and add a quiet 'refreshing' adornment instead.
    // Only a TRUE cold start (no index ever loaded) shows the '…' placeholder.
    const isColdIndexing = indexing && !indexEverLoaded && vaultIndex.length === 0;
    const isRefreshing = indexing && !isColdIndexing;
    const entryCount = isColdIndexing ? '…' : vaultIndex.length;
    const $entries = $drawer.find('[data-stat="entries"]');
    const $eStat = $entries.closest('.dle-stat');
    $eStat.toggleClass('dle-stat-refreshing', isRefreshing);
    // f091: while the cold-start skeleton is showing (no index ever loaded, not yet
    // building) keep the reserved skeleton block — don't overwrite it with a literal "0".
    if (!isColdWaiting && $entries.text() !== String(entryCount)) {
        $entries.text(entryCount);
        $eStat.removeClass('dle-stat-changed');
        $eStat[0]?.offsetWidth; // force reflow → restart animation
        const _eStatEl = $eStat[0];
        $eStat.addClass('dle-stat-changed').off('animationend.statclean').one('animationend.statclean', function () { $(this).removeClass('dle-stat-changed'); });
        setTimeout(() => { if (_eStatEl) $(_eStatEl).removeClass('dle-stat-changed'); }, 600);
    }
    const vaultCount = settings.vaults?.filter(v => v.enabled !== false).length || 1;
    const entryTitle = (isColdIndexing || isColdWaiting)
        ? 'Loading lore entries...'
        : isRefreshing
            ? `${entryCount} lore entr${entryCount === 1 ? 'y' : 'ies'} loaded — refreshing in the background…`
            : `${entryCount} lore entr${entryCount === 1 ? 'y' : 'ies'} loaded from ${vaultCount === 1 ? 'your Obsidian vault' : `${vaultCount} Obsidian vaults`}`;
    $eStat.attr('title', entryTitle).attr('aria-label', entryTitle);

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
