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
