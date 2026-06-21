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

function titleCaseStatus(status) {
    const raw = String(status || 'unknown').replace(/[-_]+/g, ' ');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function buildMobileStatusStats({
    statusLabel = 'Ready',
    entryCount = 0,
    injectedCount = 0,
    indexEverLoaded = false,
    indexing = false,
    generationLock = false,
    pipelinePhase = 'idle',
    settings = {},
    lastPipelineTrace = null,
    contextTokens = 0,
    contextLimit = 0,
    librarianExtraTokens = 0,
    aiSearchStats = {},
    overallStatus = 'ok',
} = {}) {
    const budgetLimit = settings.unlimitedBudget ? 0 : Number(settings.maxTokensBudget || 0);
    const budgetUsed = Number(lastPipelineTrace?.totalTokens || 0);
    const budgetRatio = percent(budgetUsed, budgetLimit);
    const entriesLimit = settings.unlimitedEntries ? 0 : Number(settings.maxEntries || 0);
    const usedEntries = Array.isArray(lastPipelineTrace?.injected)
        ? lastPipelineTrace.injected.length
        : Number(injectedCount || 0);
    const entriesRatio = percent(usedEntries, entriesLimit);
    const contextUsed = Number(contextTokens || 0) + Number(librarianExtraTokens || 0);
    const contextRatio = percent(contextUsed, contextLimit);
    const aiTotalTokens = Number(aiSearchStats.totalInputTokens || 0) + Number(aiSearchStats.totalOutputTokens || 0);

    let collapsed = { label: statusLabel, tone: overallStatus === 'ok' ? 'ok' : 'warn' };
    if (!indexEverLoaded && entryCount === 0) collapsed = { label: 'No index', tone: 'warn' };
    if (indexing) collapsed = { label: 'Indexing', tone: 'warn' };
    if (generationLock || pipelinePhase !== 'idle') collapsed = { label: 'Working', tone: 'warn' };
    if (overallStatus === 'offline' || overallStatus === 'limited') collapsed = { label: titleCaseStatus(overallStatus), tone: 'critical' };
    if (budgetRatio >= 80) collapsed = { label: budgetRatio >= 95 ? 'Budget full' : 'Budget high', tone: toneForRatio(budgetRatio) };

    return {
        collapsed,
        budget: {
            label: 'Budget',
            value: budgetLimit
                ? `${formatMobileStatNumber(budgetUsed)} / ${formatMobileStatNumber(budgetLimit)}`
                : `${formatMobileStatNumber(budgetUsed)} used`,
            ratio: budgetRatio,
            tone: toneForRatio(budgetRatio),
        },
        entries: {
            label: 'Entries',
            value: entriesLimit ? `${usedEntries} / ${entriesLimit}` : `${usedEntries} used`,
            ratio: entriesRatio,
            tone: toneForRatio(entriesRatio),
        },
        context: {
            label: 'Context',
            value: contextLimit
                ? `${formatMobileStatNumber(contextUsed)} / ${formatMobileStatNumber(contextLimit)}`
                : `${formatMobileStatNumber(contextUsed)} used`,
            ratio: contextRatio,
            tone: toneForRatio(contextRatio),
        },
        ai: {
            label: 'AI',
            value: `${Number(aiSearchStats.calls || 0)} calls`,
            detail: `${Number(aiSearchStats.cachedHits || 0)} cached \u00b7 ${formatMobileStatNumber(aiTotalTokens)} tokens`,
            tone: 'ok',
        },
        health: {
            label: 'Health',
            value: titleCaseStatus(overallStatus),
            detail: statusLabel,
            tone: overallStatus === 'ok' ? 'ok' : overallStatus === 'degraded' ? 'warn' : 'critical',
        },
    };
}
