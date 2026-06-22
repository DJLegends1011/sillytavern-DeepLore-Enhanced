const EMPTY = Object.freeze({
    chatId: null,
    msgIdx: -1,
    injectedSources: Object.freeze([]),
    trace: null,
});

export function normalizeMobileVerdict(verdict) {
    if (!verdict || typeof verdict !== 'object') return EMPTY;
    return {
        chatId: verdict.chatId ?? null,
        msgIdx: Number.isInteger(verdict.msgIdx) ? verdict.msgIdx : -1,
        injectedSources: Array.isArray(verdict.injectedSources) ? verdict.injectedSources : [],
        trace: verdict.trace && typeof verdict.trace === 'object' ? verdict.trace : null,
    };
}

export function readMobileVerdict(getCurrentVerdict) {
    try {
        return normalizeMobileVerdict(typeof getCurrentVerdict === 'function' ? getCurrentVerdict() : null);
    } catch {
        return normalizeMobileVerdict(null);
    }
}

export function subscribeMobileVerdict(onVerdictChanged, callback) {
    if (typeof onVerdictChanged !== 'function' || typeof callback !== 'function') return () => {};
    const unsubscribe = onVerdictChanged(callback);
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}
