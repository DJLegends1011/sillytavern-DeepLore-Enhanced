/**
 * flight-recorder.js — Always-on per-generation summary capture.
 *
 * Subscribes to onPipelineComplete and snapshots a SUMMARY of the current verdict's
 * trace (not the full trace — keeps size bounded across many gens). Always-on
 * regardless of debugMode; primary data source for pipeline diagnostics.
 */

import { RingBuffer } from './ring-buffer.js';

export const generationBuffer = new RingBuffer(50);

let started = false;

// Session-scoped: "entry X" in gen 5 is the same "entry X" in gen 12.
const _frTitleMap = new Map();
let _frTitleN = 0;
function pseudoTitle(title) {
    if (!title) return '?';
    let p = _frTitleMap.get(title);
    if (!p) { p = `<title-${++_frTitleN}>`; _frTitleMap.set(title, p); }
    return p;
}

function summarizeTrace(trace) {
    if (!trace || typeof trace !== 'object') return null;
    const arr = (k) => Array.isArray(trace[k]) ? trace[k].length : 0;
    return {
        keywordMatched:           arr('keywordMatched'),
        aiSelected:               arr('aiSelected'),
        gatedOut:                 arr('gatedOut'),
        contextualGatingRemoved:  arr('contextualGatingRemoved'),
        cooldownRemoved:          arr('cooldownRemoved'),
        warmupFailed:             arr('warmupFailed'),
        refineKeyBlocked:         arr('refineKeyBlocked'),
        stripDedupRemoved:        arr('stripDedupRemoved'),
        budgetCut:                arr('budgetCut'),
        injected:                 arr('injected'),
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
