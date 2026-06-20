import { amount_gen, getCurrentChatId } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, librarianLastUsage,
    aiSearchStats, isAiCircuitOpen, aiCircuitOpenedAt, resetAiCircuitBreaker,
    indexEverLoaded, indexTimestamp, lastHealthResult,
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
import { ds, formatTokensCompact, activityLog, announceToScreenReader, isDrawerVisible } from './drawer-state.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { tr } from '../i18n/i18n.js';

const AI_CIRCUIT_COOLDOWN_MS = 30_000; // mirror state.js — drawer doesn't import the constant directly

// Hash of the last activity-feed render inputs — skip the destroy/rebuild when unchanged.
// renderFooter is driven by the high-frequency CHAT_COMPLETION_PROMPT_READY event (every
// prompt-ready tick), but activityLog only mutates once per completed generation (pushActivity).
// Mirrors the _lastInjectionRenderHash pattern in drawer-render-tabs.js.
let _lastActivityFeedHash = null;

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
        toastr.success(result.hadPendingCooldown ? tr('dle_toast_breaker_reset_with_cooldown') : tr('dle_toast_breaker_reset_normal'), 'DeepLore Enhanced');
    } else {
        toastr.info(tr('dle_toast_breaker_already_closed'), 'DeepLore Enhanced');
    }
    // Re-render so the conditional button hides without waiting for the next event.
    try { renderFooter(); } catch { /* drawer may be teardown-mid */ }
}

// Wave F: footer selector cache. The footer DOM is rendered once per drawer lifetime, but
// renderFooter is driven by the high-frequency CHAT_COMPLETION_PROMPT_READY tick — re-querying
// ~16 selectors every call is wasted work. Rebuild only when the footer element identity changes
// (drawer destroy/recreate, HMR). Cached elements are only mutated in place (class/attr/text/.html
// on the node itself), never replaced, so the captured jQuery refs stay valid.
let _fc = null;
let _fcRoot = null;
function _footerCache($footer) {
    const root = $footer[0];
    if (_fc && _fcRoot === root) return _fc;
    _fcRoot = root;
    _fc = {
        barContainer: $footer.find('.dle-context-bar-container'),
        barContext: $footer.find('.dle-context-bar-context'),
        barResponse: $footer.find('.dle-context-bar-response'),
        barLabel: $footer.find('.dle-context-bar-label'),
        libUsage: $footer.find('.dle-librarian-usage'),
        activityFeed: $footer.find('.dle-activity-feed'),
        vault: $footer.find('[data-health="vault"]'),
        conn: $footer.find('[data-health="connection"]'),
        pipe: $footer.find('[data-health="pipeline"]'),
        cache: $footer.find('[data-health="cache"]'),
        ai: $footer.find('[data-health="ai"]'),
        reset: $footer.find('#dle-reset-ai-breaker'),
        aiCalls: $footer.find('[data-ai-stat="calls"]'),
        aiCached: $footer.find('[data-ai-stat="cached"]'),
        aiTokens: $footer.find('[data-ai-stat="tokens"]'),
        aiStats: $footer.find('.dle-ai-stats'),
    };
    return _fc;
}

export function renderFooter() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $footer = $drawer.find('#dle-drawer-footer');
    if (!$footer.length) return;
    // Wave F: skip footer repaint into a hidden drawer (CHAT_COMPLETION_PROMPT_READY drives this
    // every prompt-ready tick); replayed on open (drawer.js toggle handler).
    if (!isDrawerVisible()) return;
    const fc = _footerCache($footer);

    // ── Context window bar ──
    const $barContainer = fc.barContainer;

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
    // A1: the bar represents the ONE real settled prompt — promptManager.tokenUsage only.
    // The old `+lib` add folded librarianChatStats.estimatedExtraTokens (a payload-size
    // proxy that accumulates per chat) into a window it was never part of. Librarian I/O
    // is a separate API call; it's surfaced as its own readout below, not in this bar.
    const contextUsed = ds.contextTokens || 0;

    if (maxContext > 0) {
        const contextPct = Math.min(100, (contextUsed / maxContext) * 100);
        const responsePct = Math.min(100 - contextPct, (responseTokens / maxContext) * 100);

        fc.barContext.css('width', `${contextPct}%`);
        fc.barResponse.css({
            left: `${contextPct}%`,
            width: `${responsePct}%`,
        });

        // A3: this is the ONE bar where red is earned — overflow (used + reserved → max)
        // means the conversation is about to lose history. Threshold on used + reserved.
        const fillPct = contextPct + responsePct;
        $barContainer.removeClass('dle-context-high dle-context-critical');
        if (fillPct >= 95) $barContainer.addClass('dle-context-critical');
        else if (fillPct >= 85) $barContainer.addClass('dle-context-high');

        const label = contextUsed
            ? `${formatTokensCompact(contextUsed)} / ${formatTokensCompact(maxContext)}`
            : `— / ${formatTokensCompact(maxContext)}`;
        fc.barLabel.text(label);

        // A4: announce used and reserved SEPARATELY — aria-valuenow is the used prompt only
        // (never used + reserved, which conflated reservation with consumption). The reserve
        // is described in aria-valuetext + the tooltip.
        const contextTitle = [
            `${formatTokensCompact(contextUsed)} prompt tokens`,
            `${formatTokensCompact(responseTokens)} response reserve`,
            `${formatTokensCompact(maxContext)} max context`,
        ].join(' · ');
        $barContainer
            .attr('aria-valuenow', contextUsed)
            .attr('aria-valuemax', maxContext)
            .attr('aria-valuetext', `${formatTokensCompact(contextUsed)} used, ${formatTokensCompact(responseTokens)} reserved for reply, of ${formatTokensCompact(maxContext)} max`)
            .attr('title', contextTitle);
    } else {
        fc.barContext.css('width', '0%');
        fc.barResponse.css({ left: '0%', width: '0%' });
        fc.barLabel.text('Context data unavailable \u2014 waiting for first generation');
        $barContainer.removeClass('dle-context-high dle-context-critical');
        $barContainer.attr('aria-valuenow', 0).attr('aria-valuemax', 0).removeAttr('aria-valuetext');
        $barContainer.attr('title', 'Context data unavailable \u2014 waiting for first generation');
    }

    // A2: real Librarian token I/O of the last agentic turn (state.librarianLastUsage,
    // set from result.usage). A distinct readout \u2014 Librarian runs its own API call via
    // CMRS, so its cost is NOT part of ST's settled prompt window above. Hidden until a
    // Librarian turn has run this chat.
    const $libUsage = fc.libUsage;
    if ($libUsage.length) {
        const lib = librarianLastUsage || { input: 0, output: 0, total: 0 };
        if (lib.total > 0) {
            $libUsage
                .text(`Librarian: ${formatTokensCompact(lib.total)} tok`)
                .attr('title', `Last Librarian turn \u2014 ${formatTokensCompact(lib.input)} in \u00b7 ${formatTokensCompact(lib.output)} out`)
                .removeClass('dle-hidden');
        } else {
            $libUsage.text('').addClass('dle-hidden');
        }
    }

    // ── Activity feed ──
    const $activityFeed = fc.activityFeed;
    $activityFeed.attr('role', 'log').attr('aria-live', 'polite');
    if ($activityFeed.length && activityLog.length > 0) {
        // Content-hash guard — the feed DOM only changes when activityLog mutates (once per
        // completed generation), but renderFooter runs every CHAT_COMPLETION_PROMPT_READY tick.
        // Skip the destroy/rebuild when the underlying rows are unchanged. Hash the same fields
        // the markup is derived from (ts, outcome/mode, injected, tokens, folder count).
        const _feedHash = activityLog
            .map(a => `${a.ts}|${a.outcome ?? a.mode ?? ''}|${a.injected}|${a.tokens}|${a.folderFilter?.length || 0}`)
            .join(';');
        if (_feedHash !== _lastActivityFeedHash) {
            _lastActivityFeedHash = _feedHash;
            let feedHtml = '';
            for (const a of activityLog) {
                const time = new Date(a.ts);
                const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const isoTime = time.toISOString();
                feedHtml += `<div class="dle-activity-row">`;
                feedHtml += `<span class="dle-activity-time" title="${isoTime}">${timeStr}</span>`;
                // D3 (v2.5 Wave 3): this is the run OUTCOME (Keywords / AI / Fallback), NOT the
                // configured search mode shown in the header stat. "ran as" + the title disambiguate
                // the two so one word ("mode") stops meaning two things. (a.mode = legacy in-memory
                // fallback; activityLog is never persisted so old-shape rows are transient.)
                const outcome = a.outcome ?? a.mode ?? '';
                feedHtml += `<span class="dle-activity-outcome" title="Outcome — how lore selection resolved this run (independent of the configured search mode in the header)">ran as ${outcome}</span>`;
                let detail = `${a.injected} entr${a.injected === 1 ? 'y' : 'ies'}, ${formatTokensCompact(a.tokens)} tok`;
                if (a.folderFilter?.length) detail += ` [${a.folderFilter.length} folder${a.folderFilter.length !== 1 ? 's' : ''}]`;
                feedHtml += `<span>${detail}</span>`;
                feedHtml += `</div>`;
            }
            $activityFeed.html(feedHtml);
        }
    }

    // ── Health icons ──
    const settings = getSettings();

    const $vault = fc.vault;
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
    const $conn = fc.conn;
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

    const $pipe = fc.pipe;
    const _footerTrace = _currentVerdictForChat()?.trace ?? null;
    if (_footerTrace) {
        const entryCount = _footerTrace.injected?.length || 0;
        const hasResults = entryCount > 0 || _footerTrace.totalTokens > 0;
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

    const $cache = fc.cache;
    if (indexEverLoaded && indexTimestamp) {
        const ageMs = Date.now() - indexTimestamp;
        const cacheTTL = (settings.cacheTTL || 300) * 1000;
        const ageSecs = Math.round(ageMs / 1000);
        // D2 (v2.5 Wave 3): cache age is NEVER a warning. Past-TTL is a benign self-healing
        // state — ensureIndexFresh refreshes it on the next generation. Both fresh and aged are
        // green (healthy); the distinction lives in the tooltip, not the color. The old "stale"
        // alarm copy + orange were dropped per the signal vocabulary (ORANGE = genuine attention
        // needed, not "self-heals next gen"). See docs/gotchas.md #75.
        const cacheLabel = ageMs < cacheTTL
            ? `Cache: fresh (${ageSecs} seconds old, ${vaultIndex.length} entries)`
            : `Cache: ready (${ageSecs} seconds old, ${vaultIndex.length} entries) — refreshes automatically on next generation`;
        $cache.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
    } else if (vaultIndex.length > 0) {
        // D2: an IDB-hydrated index (loaded from storage, awaiting first refresh) is also
        // benign/OK — not a warning. Green with neutral copy.
        const cacheLabel = `Cache: loaded from storage (${vaultIndex.length} entries) — refreshes on next generation`;
        $cache.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
    } else {
        $cache.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $cache.attr('aria-label', 'Cache: empty — no index loaded').attr('title', 'Cache: empty — no index loaded');
    }

    const $ai = fc.ai;
    const $reset = fc.reset;
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
    fc.aiCalls.text(`${aiSearchStats.calls} calls`);
    fc.aiCached.text(`${aiSearchStats.cachedHits} cached`);
    const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
    fc.aiTokens.text(`${formatTokensCompact(totalTok)} tokens`);

    // Click/keyboard surface — announces input/output token split for screen readers.
    const $aiStats = fc.aiStats;
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
