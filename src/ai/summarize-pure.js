/**
 * Pure helpers for #15 summary feature — split out so range parsing and
 * prompt-building can be regression-tested without ST globals.
 *
 * No imports from ST modules. Keep it that way.
 */

/**
 * Resolve a `start-end`, `-N` (last N), `N-` (from N onward), or bare `N`
 * range string against the current chat length. Returns null on invalid.
 *
 * @param {string} rangeArg
 * @param {number} chatLen
 * @returns {{start: number, end: number}|null}
 */
export function parseRange(rangeArg, chatLen) {
    if (typeof rangeArg !== 'string' || !rangeArg.trim()) return null;
    const trimmed = rangeArg.trim();
    const lastN = trimmed.match(/^-(\d+)$/);
    if (lastN) {
        const n = parseInt(lastN[1], 10);
        if (!Number.isFinite(n) || n <= 0) return null;
        const start = Math.max(0, chatLen - n);
        const end = chatLen - 1;
        return start <= end ? { start, end } : null;
    }
    const fromN = trimmed.match(/^(\d+)-$/);
    if (fromN) {
        const start = parseInt(fromN[1], 10);
        if (!Number.isFinite(start) || start < 0 || start >= chatLen) return null;
        return { start, end: chatLen - 1 };
    }
    const both = trimmed.match(/^(\d+)-(\d+)$/);
    if (both) {
        const start = parseInt(both[1], 10);
        const end = parseInt(both[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= chatLen || start > end) return null;
        return { start, end };
    }
    const single = trimmed.match(/^(\d+)$/);
    if (single) {
        const n = parseInt(single[1], 10);
        if (!Number.isFinite(n) || n < 0 || n >= chatLen) return null;
        return { start: n, end: n };
    }
    return null;
}

/**
 * Build the prompt body from a chat range. Skips hidden (is_system=true) and
 * empty-body messages.
 *
 * @param {Array<{name?: string, mes?: string, is_system?: boolean, is_user?: boolean}>} chatArr
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function buildSummaryUserMessage(chatArr, start, end) {
    const lines = [];
    for (let i = start; i <= end; i++) {
        const msg = chatArr[i];
        if (!msg || msg.is_system) continue;
        const name = msg.name || (msg.is_user ? 'user' : 'assistant');
        const body = (msg.mes || '').trim();
        if (!body) continue;
        lines.push(`### ${name} (#${i})\n${body}`);
    }
    return lines.join('\n\n');
}

/**
 * Apply the "hide range + insert summary message" mutation to a chat array.
 * Pure for testability — summarizeRange (in summarize.js) wraps this with the
 * ST-side I/O. Mutates `chatArr` in place; returns the inserted summary
 * message + hiddenCount for caller bookkeeping.
 *
 * Audit F1+M3 contract: stores the pre-summary `is_system` value on each
 * hidden message's `.extra.dle_original_is_system` so rollback can read it
 * back without any cross-record index math.
 *
 * @param {Array<object>} chatArr
 * @param {{start: number, end: number}} range
 * @param {string} summaryId
 * @param {string} summaryText
 * @param {object} [summaryExtra] - extra fields to set on the inserted summary message
 * @returns {{ summaryMsg: object, hiddenCount: number }}
 */
export function applyHideAndPrepend(chatArr, range, summaryId, summaryText, summaryExtra = {}) {
    let hiddenCount = 0;
    for (let i = range.start; i <= range.end; i++) {
        const msg = chatArr[i];
        if (!msg) continue;
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        msg.extra.dle_original_is_system = !!msg.is_system;
        msg.extra.dle_summarized_into = summaryId;
        msg.is_system = true;
        hiddenCount++;
    }
    const summaryMsg = {
        name: 'DeepLore Summary',
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: summaryText,
        extra: {
            dle_summary_id: summaryId,
            dle_summary_range: { start: range.start, end: range.end },
            ...summaryExtra,
        },
    };
    chatArr.splice(range.start, 0, summaryMsg);
    return { summaryMsg, hiddenCount };
}

/**
 * Reverse `applyHideAndPrepend` for a given summary id. Removes the summary
 * message and restores `is_system` on every message marked with that id.
 *
 * Audit F1+M3 contract: reads `.extra.dle_original_is_system` from each
 * hidden message — no index math, no record lookup. Multi-summary rollback
 * works in any order because state lives on the messages themselves.
 *
 * @param {Array<object>} chatArr
 * @param {string} summaryId
 * @returns {{ restored: number, removed: number }}
 */
export function rollbackById(chatArr, summaryId) {
    let restored = 0;
    let removed = 0;
    if (!Array.isArray(chatArr) || !summaryId) return { restored, removed };
    const sumIdx = chatArr.findIndex(m => m?.extra?.dle_summary_id === summaryId);
    if (sumIdx >= 0) {
        chatArr.splice(sumIdx, 1);
        removed = 1;
    }
    for (const msg of chatArr) {
        if (msg?.extra?.dle_summarized_into !== summaryId) continue;
        const orig = msg.extra.dle_original_is_system;
        msg.is_system = !!orig;
        delete msg.extra.dle_summarized_into;
        delete msg.extra.dle_original_is_system;
        restored++;
    }
    return { restored, removed };
}
