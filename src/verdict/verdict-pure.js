/**
 * DeepLore Enhanced — Verdict pure helpers.
 *
 * Per-Turn Decision Record ("Verdict"). Replaces 4 racing globals
 * (`lastInjectionSources`, `lastPipelineTrace`, `previousSources`, `lastInjectionEpoch`)
 * with one authoritative per-message record of what DLE decided that turn.
 *
 * Pure functions only — no IndexedDB, no ST imports, no state mutation. Safe to
 * load from `test/unit.mjs`.
 *
 * Shape, eviction policy, and per-entry aggregation live here. The live store
 * (`verdict-store.js`) wraps these with a ring buffer + IDB persistence.
 */

/**
 * Verdict shape (canonical for v2.5+).
 *
 * @typedef {object} Verdict
 * @property {string|null} genId        Unique generation id (from pipeline trace).
 * @property {string|null} chatId       SillyTavern chat id at gen time (IDB key prefix). Null in tests/headless.
 * @property {number}      msgIdx       chat.length at generation start. Stable index for "which message did this verdict belong to."
 * @property {number}      epoch        chatEpoch at gen time. Race guard.
 * @property {number}      lockEpoch    generationLockEpoch at gen time. Stale-pipeline guard.
 * @property {number}      ts           Date.now() at finalization.
 * @property {Array<InjectedSource>} injectedSources  Replaces `lastInjectionSources`. The sources the writing AI sees this turn.
 * @property {object}      trace        Full pipeline trace (existing shape — keywordMatched, aiSelected, gatedOut, budgetCut, injected, stage timings, fuzzyStats, etc.).
 * @property {Array<PerEntry>} perEntry Eager aggregation: one row per entry seen by the pipeline this turn, with finalState + reason chain. Computed by buildPerEntry().
 *
 * @typedef {object} InjectedSource
 * @property {string} title
 * @property {string} filename
 * @property {string} matchedBy
 * @property {number} priority
 * @property {number} tokens
 * @property {string} vaultSource
 *
 * @typedef {object} PerEntry
 * @property {string} title
 * @property {string} vaultSource
 * @property {'injected'|'budget_cut'|'gated_out'|'cooldown'|'dedup'|'context_gated'|'rejected_by_ai'|'matched_only'} finalState
 * @property {Array<string>} reasons   Ordered reason chain. e.g. ["keyword match: alice", "AI confidence 0.85: recurring NPC", "injected"].
 * @property {number|null} confidence  AI confidence 0..1 if AI scored it; null otherwise.
 * @property {number|null} tokens
 */

/**
 * Empty verdict, used at chat-load / failed-gen boundaries.
 * @returns {Verdict}
 */
export function emptyVerdict() {
    return {
        genId: null,
        chatId: null,
        msgIdx: -1,
        epoch: -1,
        lockEpoch: -1,
        ts: 0,
        injectedSources: [],
        trace: null,
        perEntry: [],
    };
}

/**
 * Build a verdict record from a pipeline trace + commit-time data.
 * Eager perEntry aggregation so all consumers read one canonical list.
 *
 * @param {object} input
 * @param {object} input.trace             Pipeline trace from runPipeline.
 * @param {Array<InjectedSource>} input.injectedSources  What the writing AI sees this turn.
 * @param {string|null} input.chatId
 * @param {number} input.msgIdx
 * @param {number} input.epoch
 * @param {number} input.lockEpoch
 * @returns {Verdict}
 */
export function buildVerdict({ trace, injectedSources, chatId, msgIdx, epoch, lockEpoch }) {
    return {
        genId: trace?.genId ?? null,
        chatId: chatId ?? null,
        msgIdx: typeof msgIdx === 'number' ? msgIdx : -1,
        epoch: typeof epoch === 'number' ? epoch : -1,
        lockEpoch: typeof lockEpoch === 'number' ? lockEpoch : -1,
        ts: Date.now(),
        injectedSources: Array.isArray(injectedSources) ? injectedSources : [],
        trace: trace ?? null,
        perEntry: trace ? buildPerEntry(trace, injectedSources) : [],
    };
}

/**
 * Eagerly aggregate one row per entry seen by the pipeline this turn.
 * Walks every removal stage + the injected list and unions them by trackerKey.
 *
 * Lateness wins: if an entry appears in multiple stages, the last stage stamps finalState.
 * Stage order (least-to-most-final): matched_only → context_gated → cooldown → gated_out
 *   → dedup → budget_cut → rejected_by_ai → injected.
 *
 * @param {object} trace
 * @param {Array<InjectedSource>} injectedSources
 * @returns {Array<PerEntry>}
 */
export function buildPerEntry(trace, injectedSources) {
    if (!trace) return [];
    /** @type {Map<string, PerEntry>} */
    const byKey = new Map();

    const tk = (title, vaultSource) => `${vaultSource || ''}:${title || ''}`;
    const upsert = (title, vaultSource, finalState, reason, extras = {}) => {
        const key = tk(title, vaultSource);
        const prior = byKey.get(key);
        if (prior) {
            prior.finalState = finalState;
            if (reason) prior.reasons.push(reason);
            if (extras.confidence != null) prior.confidence = extras.confidence;
            if (extras.tokens != null) prior.tokens = extras.tokens;
            return;
        }
        byKey.set(key, {
            title: title || '',
            vaultSource: vaultSource || '',
            finalState,
            reasons: reason ? [reason] : [],
            confidence: extras.confidence ?? null,
            tokens: extras.tokens ?? null,
        });
    };

    // Stage 0: keyword/AI selection populates the candidate set with matched_only.
    for (const m of trace.keywordMatched || []) {
        upsert(m.title, m.vaultSource, 'matched_only', `keyword: ${m.matchedBy || '?'}`);
    }
    for (const m of trace.aiSelected || []) {
        upsert(m.title, m.vaultSource, 'matched_only', `AI selected${m.confidence != null ? ` (conf ${m.confidence})` : ''}${m.reason ? `: ${m.reason}` : ''}`, { confidence: m.confidence ?? null });
    }

    // Removal stages stamp finalState in pipeline order.
    for (const m of trace.contextualGatingRemoved || []) {
        upsert(m.title, m.vaultSource, 'context_gated', m.reason || 'contextual gating');
    }
    for (const m of trace.cooldownRemoved || []) {
        upsert(m.title, m.vaultSource, 'cooldown', m.reason || 'cooldown active');
    }
    for (const m of trace.gatedOut || []) {
        const r = m.requires ? `requires unmet: ${m.requires.join(',')}` : m.excludes ? `excluded by: ${m.excludes.join(',')}` : 'gating';
        upsert(m.title, m.vaultSource, 'gated_out', r);
    }
    for (const m of trace.stripDedupRemoved || []) {
        upsert(m.title, m.vaultSource, 'dedup', m.reason || 'already in recent context');
    }
    for (const m of trace.budgetCut || []) {
        upsert(m.title, m.vaultSource, 'budget_cut', `over budget (${m.tokens ?? '?'} tokens, priority ${m.priority ?? '?'})`, { tokens: m.tokens ?? null });
    }
    for (const m of trace.refineKeyBlocked || []) {
        upsert(m.title, m.vaultSource, 'rejected_by_ai', m.reason || 'refine-key gating');
    }
    for (const m of trace.probabilitySkipped || []) {
        upsert(m.title, m.vaultSource, 'rejected_by_ai', 'probability skip');
    }
    for (const m of trace.warmupFailed || []) {
        upsert(m.title, m.vaultSource, 'rejected_by_ai', 'warmup not met');
    }

    // Injection is the terminal state for surviving entries.
    for (const e of injectedSources || []) {
        upsert(e.title, e.vaultSource, 'injected', `injected (~${e.tokens ?? '?'} tokens)`, { tokens: e.tokens ?? null });
    }

    return [...byKey.values()];
}

/**
 * Compute (added, removed) diff between two verdicts' injectedSources.
 * Replaces the old `computeSourcesDiff(lastInjectionSources, previousSources)` call chain.
 *
 * @param {Verdict|null} current
 * @param {Verdict|null} previous
 * @returns {{ added: InjectedSource[], removed: InjectedSource[] }}
 */
export function diffVerdicts(current, previous) {
    const cur = current?.injectedSources || [];
    if (!previous) return { added: [], removed: [] };
    const prev = previous.injectedSources || [];
    const prevMap = new Map(prev.map(s => [`${s.vaultSource || ''}:${s.title}`, s]));
    const curMap = new Map(cur.map(s => [`${s.vaultSource || ''}:${s.title}`, s]));
    const added = cur.filter(s => !prevMap.has(`${s.vaultSource || ''}:${s.title}`));
    const removed = prev.filter(s => !curMap.has(`${s.vaultSource || ''}:${s.title}`));
    return { added, removed };
}

/**
 * Apply ring-buffer eviction policy. Returns a new array with the oldest entries
 * dropped if the buffer exceeded the cap. Pure — does not mutate.
 *
 * @param {Verdict[]} buffer
 * @param {number} cap
 * @returns {Verdict[]}
 */
export function evictRing(buffer, cap) {
    if (!Array.isArray(buffer)) return [];
    if (buffer.length <= cap) return buffer;
    return buffer.slice(buffer.length - cap);
}

/**
 * Decide which verdicts to drop from the per-chat IDB store. Pure.
 *
 * Keeps the most recent `cap` verdicts. Returns the list of IDB keys to delete.
 *
 * @param {Array<{ msgIdx: number, ts: number, key: string }>} catalog  Existing IDB records (key + sort metadata).
 * @param {number} cap
 * @returns {string[]}                                                  Keys to delete.
 */
export function selectPruneVictims(catalog, cap) {
    if (!Array.isArray(catalog) || catalog.length <= cap) return [];
    // Sort newest-first by msgIdx (primary) then ts (tiebreak). Drop everything past the cap.
    const sorted = [...catalog].sort((a, b) => (b.msgIdx - a.msgIdx) || (b.ts - a.ts));
    return sorted.slice(cap).map(r => r.key);
}

/**
 * Validate a candidate verdict object loaded from IDB. Used to discard corrupt
 * records on hydrate. Mirrors the cache-validate pattern in `src/vault/cache.js`.
 *
 * @param {any} v
 * @returns {boolean}
 */
export function validateVerdict(v) {
    if (!v || typeof v !== 'object') return false;
    if (typeof v.msgIdx !== 'number') return false;
    if (typeof v.epoch !== 'number') return false;
    if (!Array.isArray(v.injectedSources)) return false;
    if (v.trace != null && typeof v.trace !== 'object') return false;
    if (!Array.isArray(v.perEntry)) return false;
    return true;
}
