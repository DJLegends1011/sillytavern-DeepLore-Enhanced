import { mt, mtf } from './mobile-i18n.js';

export function formatMobileStatNumber(value) {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
}

function percent(used, limit) {
    if (!limit || limit <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function toneForRatio(ratio) {
    if (ratio >= 95) return 'critical';
    if (ratio >= 80) return 'warn';
    return 'ok';
}

const STATUS_LABELS = {
    degraded: ['dle_mobile_status_degraded', 'Degraded'],
    limited: ['dle_mobile_status_limited', 'Limited'],
    offline: ['dle_mobile_status_offline', 'Offline'],
    ok: ['dle_mobile_status_ok', 'OK'],
    unknown: ['dle_mobile_status_unknown', 'Unknown'],
};

function titleCaseStatus(status) {
    const normalized = String(status || 'unknown').replace(/[-\s]+/g, '_').toLowerCase();
    const label = STATUS_LABELS[normalized];
    if (label) return mt(label[0], label[1]);
    const raw = String(status || 'unknown').replace(/[-_]+/g, ' ');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function buildMobileStatusStats({
    statusLabel = mt('dle_mobile_status_ready', 'Ready'),
    entryCount = 0,
    injectedCount = 0,
    indexEverLoaded = false,
    indexing = false,
    generationLock = false,
    pipelinePhase = 'idle',
    settings = {},
    trace = null,
    contextTokens = 0,
    contextLimit = 0,
    librarianExtraTokens = 0,
    aiSearchStats = {},
    overallStatus = 'ok',
} = {}) {
    const budgetLimit = settings.unlimitedBudget ? 0 : Number(settings.maxTokensBudget || 0);
    const budgetUsed = Number(trace?.totalTokens || 0);
    const budgetRatio = percent(budgetUsed, budgetLimit);
    const entriesLimit = settings.unlimitedEntries ? 0 : Number(settings.maxEntries || 0);
    const usedEntries = Array.isArray(trace?.injected)
        ? trace.injected.length
        : Number(injectedCount || 0);
    const entriesRatio = percent(usedEntries, entriesLimit);
    const contextUsed = Number(contextTokens || 0) + Number(librarianExtraTokens || 0);
    const contextRatio = percent(contextUsed, contextLimit);
    const aiTotalTokens = Number(aiSearchStats.totalInputTokens || 0) + Number(aiSearchStats.totalOutputTokens || 0);

    let collapsed = { label: statusLabel, tone: overallStatus === 'ok' ? 'ok' : 'warn' };
    if (!indexEverLoaded && entryCount === 0) collapsed = { label: mt('dle_mobile_stat_no_index', 'No index'), tone: 'warn' };
    if (indexing) collapsed = { label: mt('dle_mobile_status_indexing', 'Indexing'), tone: 'warn' };
    if (generationLock || pipelinePhase !== 'idle') collapsed = { label: mt('dle_mobile_status_working', 'Working'), tone: 'warn' };
    if (overallStatus === 'offline' || overallStatus === 'limited') collapsed = { label: titleCaseStatus(overallStatus), tone: 'critical' };
    if (budgetRatio >= 80) collapsed = { label: budgetRatio >= 95 ? mt('dle_mobile_stat_budget_full', 'Budget full') : mt('dle_mobile_stat_budget_high', 'Budget high'), tone: toneForRatio(budgetRatio) };

    return {
        collapsed,
        budget: {
            label: mt('dle_mobile_stat_budget', 'Budget'),
            value: budgetLimit
                ? `${formatMobileStatNumber(budgetUsed)} / ${formatMobileStatNumber(budgetLimit)}`
                : mtf('dle_mobile_stat_used', '${0} used', formatMobileStatNumber(budgetUsed)),
            ratio: budgetRatio,
            tone: toneForRatio(budgetRatio),
        },
        entries: {
            label: mt('dle_mobile_stat_entries', 'Entries'),
            value: entriesLimit ? `${usedEntries} / ${entriesLimit}` : mtf('dle_mobile_stat_used', '${0} used', usedEntries),
            ratio: entriesRatio,
            tone: toneForRatio(entriesRatio),
        },
        context: {
            label: mt('dle_mobile_stat_context', 'Context'),
            value: contextLimit
                ? `${formatMobileStatNumber(contextUsed)} / ${formatMobileStatNumber(contextLimit)}`
                : mtf('dle_mobile_stat_used', '${0} used', formatMobileStatNumber(contextUsed)),
            ratio: contextRatio,
            tone: toneForRatio(contextRatio),
        },
        ai: {
            label: mt('dle_mobile_stat_ai', 'AI'),
            value: mtf('dle_mobile_stat_calls', '${0} calls', Number(aiSearchStats.calls || 0)),
            detail: mtf('dle_mobile_stat_cached_tokens', '${0} cached \u00b7 ${1} tokens', Number(aiSearchStats.cachedHits || 0), formatMobileStatNumber(aiTotalTokens)),
            tone: 'ok',
        },
        health: {
            label: mt('dle_mobile_stat_health', 'Health'),
            value: titleCaseStatus(overallStatus),
            detail: statusLabel,
            tone: overallStatus === 'ok' ? 'ok' : overallStatus === 'degraded' ? 'warn' : 'critical',
        },
    };
}
