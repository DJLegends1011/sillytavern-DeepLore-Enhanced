/**
 * DeepLore Enhanced — Dedicated summary feature (#15).
 *
 * `/dle-summarize-range start-end | N` runs an AI summary of the named chat range,
 * hides the originals via ST's is_system flag, and inserts the summary as a new
 * message at the start of the range. Each operation is recorded in
 * chat_metadata.deeplore_summary_log so `/dle-summarize-rollback` can undo by id
 * or all-at-once.
 *
 * Hidden originals stay in chat[] so ST's reload + AI-context skip both honor
 * them — same mechanic as the built-in /hide command. Rollback flips is_system
 * back to its pre-summary value and removes the summary message.
 */

import { chat, chat_metadata, saveChatConditional, reloadCurrentChat } from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { getSettings, resolveConnectionConfig } from '../../settings.js';
import { callAI } from './ai.js';
import { classifyError } from '../../core/utils.js';
import { parseRange, buildSummaryUserMessage } from './summarize-pure.js';

export { parseRange, buildSummaryUserMessage };

const DEFAULT_PROMPT = 'You are a session summarizer. Read the following chat range and write a concise prose summary that preserves: who acted, what happened, key decisions, and emotional tone. Output the summary only — no preamble, no meta-commentary, no headers.';

/**
 * Generate a short id for the summary record. Not cryptographic — just unique
 * enough that two summaries in the same chat won't collide.
 */
function makeSummaryId() {
    return 'sum_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Run the summary AI call against the resolved scribe connection (reuses the
 * user's already-configured connection; no separate dedicated profile yet).
 *
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
async function callSummaryAI(userMessage, signal) {
    const settings = getSettings();
    const conn = resolveConnectionConfig('scribe');
    const systemPrompt = settings.summarySystemPrompt?.trim() || DEFAULT_PROMPT;
    const result = await callAI(systemPrompt, userMessage, {
        ...conn,
        caller: 'summarize',
        maxTokens: settings.summaryMaxTokens || 400,
        timeout: settings.summaryTimeout || 30000,
        signal,
    });
    return (result.text || '').trim();
}

/**
 * Summarize a chat range and apply the hide+prepend mutation.
 *
 * @param {{start: number, end: number}} range
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, summaryId?: string, summary?: string, error?: string, hiddenCount?: number}>}
 */
export async function summarizeRange(range, signal) {
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') {
        return { ok: false, error: 'Invalid range' };
    }
    if (!Array.isArray(chat)) return { ok: false, error: 'No chat loaded' };
    if (range.start < 0 || range.end >= chat.length || range.start > range.end) {
        return { ok: false, error: `Range out of bounds (chat length ${chat.length})` };
    }

    const userMessage = buildSummaryUserMessage(chat, range.start, range.end);
    if (!userMessage.trim()) {
        return { ok: false, error: 'Selected range has no visible messages to summarize' };
    }

    let summaryText;
    try {
        summaryText = await callSummaryAI(userMessage, signal);
    } catch (err) {
        return { ok: false, error: `AI call failed: ${classifyError(err)}` };
    }
    if (!summaryText) {
        return { ok: false, error: 'AI returned empty summary' };
    }

    const summaryId = makeSummaryId();
    const hiddenIndices = [];
    const originalIsSystem = {};

    // Mark originals hidden, recording prior is_system so rollback can restore exactly.
    for (let i = range.start; i <= range.end; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        originalIsSystem[i] = !!msg.is_system;
        msg.is_system = true;
        msg.extra.dle_summarized_into = summaryId;
        hiddenIndices.push(i);
    }

    // Insert summary as a new message immediately before the (now-hidden) range.
    const summaryMsg = {
        name: 'DeepLore Summary',
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: summaryText,
        extra: {
            dle_summary_id: summaryId,
            dle_summary_range: { start: range.start, end: range.end },
            dle_summary_original_is_system: originalIsSystem,
        },
    };
    chat.splice(range.start, 0, summaryMsg);

    // Persist record for rollback.
    if (!Array.isArray(chat_metadata.deeplore_summary_log)) chat_metadata.deeplore_summary_log = [];
    chat_metadata.deeplore_summary_log.push({
        id: summaryId,
        createdAt: Date.now(),
        // Note: indices shift after splice; record post-shift positions for rollback math.
        summaryIndex: range.start,
        hiddenIndices: hiddenIndices.map(i => i + 1), // +1 because splice pushed them
        originalIsSystem,
    });
    saveMetadataDebounced();
    await saveChatConditional();

    // Force UI redraw — splice doesn't trigger ST's incremental render.
    await reloadCurrentChat();

    return { ok: true, summaryId, summary: summaryText, hiddenCount: hiddenIndices.length };
}

/**
 * Roll back one summary (by id) or all summaries in the current chat. Removes
 * the inserted summary message and restores each hidden original's pre-summary
 * is_system value.
 *
 * @param {string} [summaryId] - if omitted or 'all', rolls back every summary.
 * @returns {Promise<{ok: boolean, restored: number, removed: number, error?: string}>}
 */
export async function rollbackSummary(summaryId) {
    if (!Array.isArray(chat_metadata.deeplore_summary_log) || chat_metadata.deeplore_summary_log.length === 0) {
        return { ok: false, restored: 0, removed: 0, error: 'No summaries to roll back' };
    }
    const targets = (!summaryId || summaryId === 'all')
        ? [...chat_metadata.deeplore_summary_log]
        : chat_metadata.deeplore_summary_log.filter(r => r.id === summaryId);
    if (targets.length === 0) {
        return { ok: false, restored: 0, removed: 0, error: `Summary id "${summaryId}" not found` };
    }

    let restored = 0;
    let removed = 0;
    // Process in reverse order so index math doesn't drift across removals.
    targets.sort((a, b) => b.createdAt - a.createdAt);
    for (const record of targets) {
        // Find the summary message by id (don't trust the stored index — chat may have shifted).
        const sumIdx = chat.findIndex(m => m?.extra?.dle_summary_id === record.id);
        if (sumIdx >= 0) {
            chat.splice(sumIdx, 1);
            removed++;
        }
        // Restore is_system on hidden originals by id, again finding fresh (post-removal).
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (msg?.extra?.dle_summarized_into === record.id) {
                const orig = record.originalIsSystem?.[i + (sumIdx >= 0 && i >= sumIdx ? 1 : 0)] ?? false;
                msg.is_system = !!orig;
                delete msg.extra.dle_summarized_into;
                restored++;
            }
        }
        // Drop the record from the log.
        chat_metadata.deeplore_summary_log = chat_metadata.deeplore_summary_log.filter(r => r.id !== record.id);
    }

    saveMetadataDebounced();
    await saveChatConditional();
    await reloadCurrentChat();

    return { ok: true, restored, removed };
}

/**
 * List recorded summaries in this chat (for picker / status display).
 * @returns {Array<{id: string, createdAt: number, summaryIndex: number, hiddenCount: number}>}
 */
export function listSummaries() {
    if (!Array.isArray(chat_metadata.deeplore_summary_log)) return [];
    return chat_metadata.deeplore_summary_log.map(r => ({
        id: r.id,
        createdAt: r.createdAt,
        summaryIndex: r.summaryIndex,
        hiddenCount: Array.isArray(r.hiddenIndices) ? r.hiddenIndices.length : 0,
    }));
}
