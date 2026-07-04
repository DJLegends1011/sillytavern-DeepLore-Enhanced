/**
 * flight-recorder.js — Always-on per-generation summary capture.
 *
 * Subscribes to onPipelineComplete and snapshots a SUMMARY of the current verdict's
 * trace (not the full trace — keeps size bounded across many gens). Always-on
 * regardless of debugMode; primary data source for pipeline diagnostics.
 */

import { RingBuffer } from './ring-buffer.js';
import { TRACE_ENTRY_ARRAY_KEYS } from './pseudonymize-trace.js';

export const generationBuffer = new RingBuffer(50);

let started = false;

// Session-scoped: "entry X" in gen 5 is the same "entry X" in gen 12.
//
// DISTINCT NAMESPACE: this minter is SESSION-scoped (spans many generations),
// whereas state-snapshot.js's pseudonym context (the single `<title-N>` aliaser
// in pseudonymize-trace.js) is PER-SNAPSHOT. The two cardinalities are unrelated,
// so the flight recorder uses a `<fr-title-N>` prefix to keep the two spaces from
// colliding — `<title-3>` in the snapshot trace and `<fr-title-3>` here are not
// claimed to be the same real entry. See gotcha (single-source pseudonymization).
const _frTitleMap = new Map();
let _frTitleN = 0;
function pseudoTitle(title) {
    if (!title) return '?';
    let p = _frTitleMap.get(title);
    if (!p) { p = `<fr-title-${++_frTitleN}>`; _frTitleMap.set(title, p); }
    return p;
}

function summarizeTrace(trace) {
    if (!trace || typeof trace !== 'object') return null;
    const arr = (k) => Array.isArray(trace[k]) ? trace[k].length : 0;
    // Per-stage entry counts — key list is single-sourced (#13b): every trace
    // entry-array gets a count without hand-maintaining a second enumeration.
    const stageCounts = {};
    for (const k of TRACE_ENTRY_ARRAY_KEYS) stageCounts[k] = arr(k);
    return {
        ...stageCounts,
        injectedTitles:           Array.isArray(trace.injected)
                                      ? trace.injected.slice(0, 30).map(e => pseudoTitle(e?.title || e?.filename || '?'))
                                      : [],
        bootstrapActive:          !!trace.bootstrapActive,
        aiFallback:               !!trace.aiFallback,
        aiError:                  trace.aiError || null,
        budget: trace.budget ? {
            used:  trace.budget.used  ?? null,
            limit: trace.budget.limit ?? null,
            ratio: trace.budget.ratio ?? null,
        } : null,
        aiPreFilter: trace.aiPreFilter ? {
            inputCount:  trace.aiPreFilter.inputCount  ?? null,
            outputCount: trace.aiPreFilter.outputCount ?? null,
        } : null,
        genId:                trace.genId                ?? null,
        totalMs:              trace.totalMs              ?? null,
        keywordMatchMs:       trace.keywordMatchMs       ?? null,
        aiSearchMs:           trace.aiSearchMs           ?? null,
        ensureIndexFreshMs:   trace.ensureIndexFreshMs   ?? null,
        pinBlockMs:           trace.pinBlockMs           ?? null,
        contextualGatingMs:   trace.contextualGatingMs   ?? null,
        reinjectionCooldownMs: trace.reinjectionCooldownMs ?? null,
        requiresExcludesMs:   trace.requiresExcludesMs   ?? null,
        stripDedupMs:         trace.stripDedupMs         ?? null,
        formatGroupMs:        trace.formatGroupMs        ?? null,
        trackGenerationMs:    trace.trackGenerationMs    ?? null,
        recordAnalyticsMs:    trace.recordAnalyticsMs    ?? null,
        perChatCountsMs:      trace.perChatCountsMs      ?? null,
    };
}

/**
 * Record a pipeline abort. Called from index.js catch when the user stops
 * generation or the pipeline times out.
 */
export function recordAbort(reason) {
    try {
        generationBuffer.push({
            t: Date.now(),
            aborted: true,
            reason: reason || 'unknown',
        });
    } catch { /* never throw from diagnostic code */ }
}

/** Start the flight recorder. Safe to call multiple times. */
export async function startFlightRecorder() {
    if (started) return;
    started = true;
    try {
        const stateMod = await import('../state.js');
        const { onPipelineComplete } = stateMod;
        if (typeof onPipelineComplete !== 'function') {
            console.warn('[DLE] Flight recorder: onPipelineComplete not found in state.js — generation recording disabled');
            started = false;
            return;
        }

        generationBuffer.push({ t: Date.now(), kind: 'recorder_started' });
        const verdictMod = await import('../verdict/verdict-store.js');
        onPipelineComplete(() => {
            try {
                const verdict = verdictMod.getCurrent ? verdictMod.getCurrent() : null;
                const trace = verdict?.trace ?? null;
                generationBuffer.push({
                    t: Date.now(),
                    genId: trace?.genId ?? null,
                    generationCount: stateMod.generationCount ?? null,
                    chatEpoch: stateMod.chatEpoch ?? null,
                    aiCircuitOpen: !!stateMod.aiCircuitOpen,
                    aiCircuitFailures: stateMod.aiCircuitFailures ?? 0,
                    summary: summarizeTrace(trace),
                });
            } catch {
                try { generationBuffer.push({ t: Date.now(), error: 'trace summary failed' }); } catch { /* last resort */ }
            }
        });
    } catch (err) {
        console.warn('[DLE] Flight recorder start failed, will retry:', err?.message);
        started = false; // allow retry — import may succeed later
    }
}
