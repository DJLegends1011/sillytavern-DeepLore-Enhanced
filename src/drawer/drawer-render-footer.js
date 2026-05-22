import { amount_gen } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, lastPipelineTrace, librarianChatStats,
    aiSearchStats, isAiCircuitOpen, aiCircuitOpenedAt, resetAiCircuitBreaker,
    indexEverLoaded, indexTimestamp, lastHealthResult,
} from '../state.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import { ds, formatTokensCompact, activityLog, announceToScreenReader } from './drawer-state.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';

const AI_CIRCUIT_COOLDOWN_MS = 30_000; // mirror state.js — drawer doesn't import the constant directly

// ════════════════════════════════════════════════════════════════════════════
// Footer Zone — Health Icons + AI Stats + Context Bar
// ════════════════════════════════════════════════════════════════════════════

/**
 * PR #28.1 — Footer reset button click handler. Confirmation popup first;
 * on confirm, calls state.resetAiCircuitBreaker() and surfaces a toast.
 * Re-renders the footer so the button hides on success.
 */
async function handleResetClick(e) {
    e?.preventDefault?.();
    const confirmed = await callGenericPopup(
        'Reset AI breaker?<br><br><span class="dle-text-xs dle-muted">Pending cooldown will be discarded. Next AI call attempts immediately.</span>',
        POPUP_TYPE.CONFIRM, '', {},
    );
    if (!confirmed) return;
    const result = resetAiCircuitBreaker();
    if (result.wasOpen) {
        toastr.success(result.hadPendingCooldown ? 'AI breaker reset — pending cooldown discarded.' : 'AI breaker reset.', 'DeepLore Enhanced');
    } else {
        toastr.info('AI breaker was already closed.', 'DeepLore Enhanced');
    }
    // Re-render so the conditional button hides without waiting for the next event.
    try { renderFooter(); } catch { /* drawer may be teardown-mid */ }
}

export function renderFooter() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $footer = $drawer.find('#dle-drawer-footer');
    if (!$footer.length) return;

    // ── Context window bar ──
    const $barContainer = $footer.find('.dle-context-bar-container');

    // Non-OAI backends don't expose prompt token tracking — hide the bar entirely.
    if (!ds.contextBarAvailable) {
        $barContainer.hide();
    } else {
        $barContainer.show();
    }

    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    // chatCompletionSettings respects "unlocked context"; ctx.maxContext is the base slider only.
    const maxContext = ctx?.chatCompletionSettings?.openai_max_context || ctx?.maxContext || 0;
    const responseTokens = ctx?.chatCompletionSettings?.openai_max_tokens || amount_gen || 0;
    const contextUsed = ds.contextTokens || 0;
    const libExtra = librarianChatStats?.estimatedExtraTokens || 0;
    const totalUsed = contextUsed + libExtra;

    if (maxContext > 0) {
        const contextPct = Math.min(100, (totalUsed / maxContext) * 100);
        const responsePct = Math.min(100 - contextPct, (responseTokens / maxContext) * 100);

        $footer.find('.dle-context-bar-context').css('width', `${contextPct}%`);
        $footer.find('.dle-context-bar-response').css({
            left: `${contextPct}%`,
            width: `${responsePct}%`,
        });

        const label = totalUsed
            ? `${formatTokensCompact(totalUsed)} / ${formatTokensCompact(maxContext)}${libExtra > 0 ? ` (+${formatTokensCompact(libExtra)} lib)` : ''}`
            : `— / ${formatTokensCompact(maxContext)}`;
        $footer.find('.dle-context-bar-label').text(label);

        const tooltipParts = [`${formatTokensCompact(contextUsed)} prompt tokens`];
        if (libExtra > 0) tooltipParts.push(`${formatTokensCompact(libExtra)} librarian tokens`);
        tooltipParts.push(`${formatTokensCompact(responseTokens)} response reserve`);
        tooltipParts.push(`${formatTokensCompact(maxContext)} max context`);
        const contextTitle = tooltipParts.join(' · ');
        $barContainer.attr('aria-valuenow', totalUsed + responseTokens).attr('aria-valuemax', maxContext);
        $barContainer.attr('title', contextTitle);
    } else {
        $footer.find('.dle-context-bar-context').css('width', '0%');
        $footer.find('.dle-context-bar-response').css({ left: '0%', width: '0%' });
        $footer.find('.dle-context-bar-label').text('Context data unavailable \u2014 waiting for first generation');
        $barContainer.attr('aria-valuenow', 0).attr('aria-valuemax', 0);
        $barContainer.attr('title', 'Context data unavailable \u2014 waiting for first generation');
    }

    // ── Activity feed ──
    const $activityFeed = $footer.find('.dle-activity-feed');
    $activityFeed.attr('role', 'log').attr('aria-live', 'polite');
    if ($activityFeed.length && activityLog.length > 0) {
        let feedHtml = '';
        for (const a of activityLog) {
            const time = new Date(a.ts);
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isoTime = time.toISOString();
            feedHtml += `<div class="dle-activity-row">`;
            feedHtml += `<span class="dle-activity-time" title="${isoTime}">${timeStr}</span>`;
            feedHtml += `<span class="dle-activity-mode">${a.mode}</span>`;
            let detail = `${a.injected} entr${a.injected === 1 ? 'y' : 'ies'}, ${formatTokensCompact(a.tokens)} tok`;
            if (a.folderFilter?.length) detail += ` [${a.folderFilter.length} folder${a.folderFilter.length !== 1 ? 's' : ''}]`;
            feedHtml += `<span>${detail}</span>`;
            feedHtml += `</div>`;
        }
        $activityFeed.html(feedHtml);
    }

    // ── Health icons ──
    const settings = getSettings();

    const $vault = $footer.find('[data-health="vault"]');
    if (lastHealthResult) {
        const { errors, warnings } = lastHealthResult;
        if (errors > 0) {
            $vault.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
            $vault.attr('aria-label', `Vault health: ${errors} errors — click to see details`).attr('title', `Vault health: ${errors} errors, ${warnings} warnings — click to run health check`);
        } else if (warnings > 3) {
            $vault.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $vault.attr('aria-label', `Vault health: ${warnings} warnings — click to see details`).attr('title', `Vault health: ${warnings} warnings — click to run health check`);
        } else {
            $vault.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $vault.attr('aria-label', `Vault health: OK — click to run a full health check`).attr('title', `Vault health: OK${warnings ? ` (${warnings} minor warnings)` : ''} — click to run health check`);
        }
    } else {
        $vault.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $vault.attr('aria-label', 'Vault health: not checked yet — click to run health check').attr('title', 'Vault health: not checked yet — click to run health check');
    }

    // Connection icon = aggregate Obsidian circuit-breaker state across vaults.
    const $conn = $footer.find('[data-health="connection"]');
    const circuit = getCircuitState();
    if (circuit.state === 'closed') {
        $conn.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $conn.attr('aria-label', 'Obsidian: connected — click for full status').attr('title', 'Obsidian: connected — click for full status');
    } else if (circuit.state === 'half-open') {
        $conn.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $conn.attr('aria-label', 'Obsidian: recovering — probing vault').attr('title', 'Obsidian: recovering — click to view connection status');
    } else {
        $conn.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
        $conn.attr('aria-label', `Obsidian: unreachable (${circuit.failures} failures) — click to view connection status`).attr('title', `Obsidian: unreachable (${circuit.failures} failures) — click to view connection status`);
    }

    const $pipe = $footer.find('[data-health="pipeline"]');
    if (lastPipelineTrace) {
        const entryCount = lastPipelineTrace.injected?.length || 0;
        const hasResults = entryCount > 0 || lastPipelineTrace.totalTokens > 0;
        if (hasResults) {
            $pipe.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $pipe.attr('aria-label', `Lore selection: last run found ${entryCount} entries — click for details`).attr('title', `Lore selection: last run found ${entryCount} entries — click for details`);
        } else {
            $pipe.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $pipe.attr('aria-label', 'Lore selection: last run produced no results — click for details').attr('title', 'Lore selection: last run produced no results — click for details');
        }
    } else {
        $pipe.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $pipe.attr('aria-label', 'Lore selection: no runs yet').attr('title', 'Lore selection: no runs yet — send a message to trigger');
    }

    const $cache = $footer.find('[data-health="cache"]');
    if (indexEverLoaded && indexTimestamp) {
        const ageMs = Date.now() - indexTimestamp;
        const cacheTTL = (settings.cacheTTL || 300) * 1000;
        const ageSecs = Math.round(ageMs / 1000);
        if (ageMs < cacheTTL) {
            const cacheLabel = `Cache: fresh (${ageSecs} seconds old, ${vaultIndex.length} entries)`;
            $cache.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
        } else {
            const cacheLabel = `Cache: stale (${ageSecs} seconds old, ${vaultIndex.length} entries) — click to view cache status`;
            $cache.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
        }
    } else if (vaultIndex.length > 0) {
        const cacheLabel = `Cache: loaded from storage (${vaultIndex.length} entries, not yet refreshed)`;
        $cache.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
    } else {
        $cache.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $cache.attr('aria-label', 'Cache: empty — no index loaded').attr('title', 'Cache: empty — no index loaded');
    }

    const $ai = $footer.find('[data-health="ai"]');
    const $reset = $footer.find('#dle-reset-ai-breaker');
    const breakerOpen = isAiCircuitOpen();
    if (breakerOpen) {
        $ai.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
        const remainingMs = Math.max(0, AI_CIRCUIT_COOLDOWN_MS - (Date.now() - aiCircuitOpenedAt));
        const remainingSec = Math.ceil(remainingMs / 1000);
        const cooldownNote = remainingMs > 0 ? ` (retry in ~${remainingSec}s)` : ' (ready for probe — next call attempts)';
        $ai.attr('aria-label', `AI search: temporarily paused${cooldownNote}`).attr('title', `AI search: temporarily paused${cooldownNote} — click reset button to clear immediately`);
        // PR #28.1: surface reset button only while breaker open.
        if ($reset.length) {
            $reset.removeClass('dle-hidden');
            $reset.attr('title', `Reset AI breaker — discard pending cooldown${remainingMs > 0 ? ` (${remainingSec}s left)` : ''}`);
            $reset.off('click.dleReset').on('click.dleReset', handleResetClick);
        }
    } else if (aiSearchStats.calls > 0) {
        $ai.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $ai.attr('aria-label', `AI search: OK (${aiSearchStats.calls} calls this session) — click for details`).attr('title', `AI search: OK (${aiSearchStats.calls} calls this session) — click for details`);
    } else if (settings.aiSearchEnabled !== false) {
        $ai.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $ai.attr('aria-label', 'AI search: enabled but no calls yet').attr('title', 'AI search: enabled but no calls yet — will activate on first generation');
    } else {
        $ai.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $ai.attr('aria-label', 'AI search: disabled').attr('title', 'AI search: disabled — enable in DeepLore settings');
    }
    if (!breakerOpen && $reset.length) {
        $reset.addClass('dle-hidden');
        $reset.off('click.dleReset');
    }

    // ── AI stats ──
    $footer.find('[data-ai-stat="calls"]').text(`${aiSearchStats.calls} calls`);
    $footer.find('[data-ai-stat="cached"]').text(`${aiSearchStats.cachedHits} cached`);
    const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
    $footer.find('[data-ai-stat="tokens"]').text(`${formatTokensCompact(totalTok)} tokens`);

    // Click/keyboard surface — announces input/output token split for screen readers.
    const $aiStats = $footer.find('.dle-ai-stats');
    if ($aiStats.length && (aiSearchStats.totalInputTokens > 0 || aiSearchStats.totalOutputTokens > 0)) {
        const splitTitle = `${formatTokensCompact(aiSearchStats.totalInputTokens)} input tokens · ${formatTokensCompact(aiSearchStats.totalOutputTokens)} output tokens`;
        $aiStats.attr('title', splitTitle).attr('role', 'button').attr('tabindex', '0');
        $aiStats.off('click.aistats keydown.aistats').on('click.aistats', function () {
            announceToScreenReader(`AI search: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cached. ${splitTitle}`);
        }).on('keydown.aistats', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); }
        });
    }
}
