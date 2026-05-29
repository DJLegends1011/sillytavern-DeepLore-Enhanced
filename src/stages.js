/**
 * DeepLore Enhanced — Pipeline Stages
 * Pure(ish) — each stage takes explicit inputs, no implicit global reads.
 */
import { trackerKey } from './state.js';
import { normalizePinBlock, matchesPinBlock, comparePriority } from './helpers.js';
import { evaluateOperator } from './fields.js';

/** Lazy debugMode read — avoids importing settings.js (ST globals break tests). */
function _isDebug() {
    try {
        const ext = globalThis.extension_settings?.deeplore_enhanced;
        return ext?.debugMode === true;
    } catch { return false; }
}

/**
 * Build the ExemptionPolicy — single source of truth for which entries skip
 * gating. forceInject skips contextual gating, requires/excludes, reinjection
 * cooldown, and strip dedup. Only budget limits can exclude a forceInject entry.
 *
 * **Bootstrap exemption is gen-scoped.** Bootstrap entries are designed to seed
 * lore during the first few generations of a chat. They MUST only bypass gating
 * while `bootstrapActive === true` (chat short enough per `newChatThreshold`).
 * Once bootstrap deactivates, a bootstrap-tagged entry that reaches a stage via
 * cascade-link / AI selection / pin must be gated like any other entry — see
 * `helpers.js:isForceInjected` (the canonical truth-source mirrored here). The
 * pre-pipeline `alwaysInject` filter in `pipeline.js` already honors this; the
 * post-pipeline stages would silently bypass gating without the third arg.
 * See gotcha #60.
 *
 * @param {Array} vaultSnapshot - All vault entries
 * @param {Array} pins - Per-chat pins (strings or {title, vaultSource})
 * @param {Array} blocks - Per-chat blocks
 * @param {boolean} [bootstrapActive=false] - When true, bootstrap entries join
 *   forceInject. When false (default), they're gated normally. Default false is
 *   deliberately conservative — accidentally bypassing gating is the bug; the
 *   normal flow always passes the real value.
 * @returns {{ forceInject: Set<string>, pins: Array<{title:string, vaultSource:string|null}>, blocks: Array<{title:string, vaultSource:string|null}> }}
 */
export function buildExemptionPolicy(vaultSnapshot, pins, blocks, bootstrapActive = false) {
    // BUG-AUDIT-9: seed is exempt from contextual gating — designed to be
    // always-available across the entire chat.
    // Bootstrap is gen-scoped via bootstrapActive (gotcha #60); mirrors
    // helpers.js:isForceInjected so pre- and post-pipeline filters agree.
    // BUG-399: forceInject keyed by trackerKey so multi-vault duplicates don't
    // collapse — vault-A's constant "Castle" no longer exempts vault-B's "Castle".
    const forceInject = new Set();
    for (const entry of vaultSnapshot) {
        if (entry.constant || entry.seed || (bootstrapActive && entry.bootstrap)) {
            forceInject.add(trackerKey(entry));
        }
    }
    // H23: backward compat with bare-string pin/block items.
    const normalizedPins = (pins || []).map(normalizePinBlock);
    const normalizedBlocks = (blocks || []).map(normalizePinBlock);
    // Bare-string pins have vaultSource=null (match any vault), so one pin can
    // produce N trackerKeys — walk the snapshot and add every match.
    for (const pb of normalizedPins) {
        for (const entry of vaultSnapshot) {
            if (matchesPinBlock(pb, entry)) forceInject.add(trackerKey(entry));
        }
    }
    return {
        forceInject,
        pins: normalizedPins,
        blocks: normalizedBlocks,
    };
}

/**
 * Apply per-chat pin/block overrides. Pins added with constant=true / priority=10;
 * blocks remove entirely (override constants). Pinned entries are shallow-cloned
 * to avoid mutating shared vaultIndex objects.
 *
 * @param {Array} entries - Pipeline results (from runPipeline)
 * @param {Array} vaultSnapshot - Full vault, for finding pinned entries not in entries
 * @param {{ forceInject: Set, pins: Set, blocks: Set }} policy
 * @param {Map} matchedKeys - mutated: pins get '(pinned)'
 * @returns {Array}
 */
export function applyPinBlock(entries, vaultSnapshot, policy, matchedKeys) {
    let result = [...entries];
    let addedCount = 0;
    let upgradedCount = 0;
    let blockedCount = 0;

    // H23: matchesPinBlock for vault-aware matching, backward-compat with bare strings.
    if (policy.pins.length > 0) {
        // BUG-AUDIT-H15: index for O(1) lookup instead of findIndex per pin.
        // Key by trackerKey (vaultSource:title) so same-title entries from different
        // vaults don't collide — pinning vault B's "Castle" must not overwrite the
        // already-matched vault A "Castle" in the result list.
        const resultIdx = new Map();
        for (let ri = 0; ri < result.length; ri++) {
            const k = trackerKey(result[ri]);
            if (!resultIdx.has(k)) resultIdx.set(k, ri);
        }
        for (const entry of vaultSnapshot) {
            const isPinned = policy.pins.some(pb => matchesPinBlock(pb, entry));
            if (isPinned) {
                // BUG-030: deep-clone array fields to prevent shared refs with vaultIndex.
                const cloneFields = {
                    keys: [...(entry.keys || [])],
                    tags: [...(entry.tags || [])],
                    requires: [...(entry.requires || [])],
                    excludes: [...(entry.excludes || [])],
                    links: [...(entry.links || [])],
                    resolvedLinks: [...(entry.resolvedLinks || [])],
                    // BUG-AUDIT-P8: shallow clone via spread — avoids JSON round-trip cost.
                    customFields: entry.customFields
                        ? Object.fromEntries(Object.entries(entry.customFields).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
                        : {},
                };
                const k = trackerKey(entry);
                if (!resultIdx.has(k)) {
                    resultIdx.set(k, result.length);
                    result.push({ ...entry, constant: true, priority: 10, ...cloneFields });
                    // BUG-AUDIT v2.5: matchedKeys keyed by trackerKey (vaultSource:title)
                    // so same-titled cross-vault pins don't overwrite each other.
                    matchedKeys.set(trackerKey(entry), '(pinned)');
                    addedCount++;
                } else {
                    const idx = resultIdx.get(k);
                    if (idx !== undefined) result[idx] = { ...entry, constant: true, priority: 10, ...cloneFields };
                    upgradedCount++;
                }
            }
        }
    }

    // Blocks override constants.
    if (policy.blocks.length > 0) {
        const beforeBlock = result.length;
        result = result.filter(e => !policy.blocks.some(pb => matchesPinBlock(pb, e)));
        blockedCount = beforeBlock - result.length;
    }

    if ((addedCount > 0 || upgradedCount > 0 || blockedCount > 0) && _isDebug()) {
        console.debug('[DLE] Pin/Block: +%d pinned, %d upgraded, -%d blocked', addedCount, upgradedCount, blockedCount);
    }

    return result;
}

/**
 * Filter entries by contextual gating using fieldDefinitions (replaces the old
 * hardcoded era/location/sceneType/characterPresent loop). ForceInject is exempt.
 *
 * @param {Array} entries
 * @param {object} context - chat_metadata.deeplore_context (dynamic keys)
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @param {object} [settings]
 * @param {import('./fields.js').FieldDefinition[]} [fieldDefs]
 * @returns {Array}
 */
export function applyContextualGating(entries, context, policy, debugMode, settings, fieldDefs) {
    if (!fieldDefs || fieldDefs.length === 0) return entries;

    const fallbackTolerance = (settings && settings.contextualGatingTolerance) || 'strict';

    // Only apply gating if at least one context dimension is set, OR any enabled
    // gating rule uses an existence operator. `exists`/`not_exists` evaluate entry
    // shape (does the entry have a value for this field?), they do NOT compare
    // against active context — so the "no context anywhere" short-circuit would
    // otherwise skip them entirely. M-7 (2026-05-22): a vault that relies on
    // `not_exists` to mark "incomplete entries to drop" used to silently pass
    // every entry when the user hadn't set any other context, because the
    // short-circuit fired before the per-entry loop ran. Including existence
    // rules in `hasAnyContext` lets the loop run and evaluate them properly.
    const hasAnyContext = fieldDefs.some(fd => {
        if (!fd.gating || !fd.gating.enabled) return false;
        if (fd.gating.operator === 'exists' || fd.gating.operator === 'not_exists') return true;
        const val = context[fd.contextKey];
        return val != null && val !== '' && (!Array.isArray(val) || val.length > 0);
    });
    if (!hasAnyContext) return entries;

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(trackerKey(e))) return true;

        for (const fd of fieldDefs) {
            if (!fd.gating || !fd.gating.enabled) continue;

            const entryValue = e.customFields?.[fd.name];
            const activeValue = context[fd.contextKey];
            const tolerance = fd.gating.tolerance || fallbackTolerance;
            const isExistenceOp = fd.gating.operator === 'exists' || fd.gating.operator === 'not_exists';

            // No entry value → pass (entry doesn't care about this field). Existence
            // operators intentionally gate on absence, so they don't get this exemption.
            if (!isExistenceOp && (entryValue == null || (Array.isArray(entryValue) && entryValue.length === 0))) continue;
            if (!isExistenceOp && entryValue === '') continue;

            // Entry has value, no active context set — existence ops ignore active
            // context entirely, so always let them evaluate.
            if (!isExistenceOp && (activeValue == null || activeValue === '' || (Array.isArray(activeValue) && activeValue.length === 0))) {
                if (tolerance === 'strict') return false;
                continue; // moderate/lenient: pass through
            }

            if (!evaluateOperator(fd.gating.operator, entryValue, activeValue)) {
                // BUG-H8: lenient passes only match_any/match_all non-matches as "not
                // relevant". Precision ops (eq/gt/lt/not_any) always filter — they
                // express explicit constraints.
                if (tolerance === 'lenient' && (fd.gating.operator === 'match_any' || fd.gating.operator === 'match_all')) {
                    continue;
                }
                return false;
            }
        }
        return true;
    });

    if (debugMode && result.length < before) {
        const activeFields = fieldDefs
            .filter(fd => fd.gating?.enabled && context[fd.contextKey])
            .map(fd => `${fd.name}: ${context[fd.contextKey]}`)
            .join(', ');
        console.log(`[DLE] Contextual gating removed ${before - result.length} entries (${activeFields || 'none'})`);
    }

    return result;
}

/**
 * Filter entries by active folder selection. Includes entries in selected
 * folders + their subfolders. Root-level entries (no folder) always pass.
 * ForceInject is exempt.
 *
 * @param {Array} entries
 * @param {string[]|null} selectedFolders - null/empty = no filter
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @returns {Array}
 */
export function applyFolderFilter(entries, selectedFolders, policy, debugMode) {
    if (!selectedFolders || selectedFolders.length === 0) return entries;

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(trackerKey(e))) return true;
        if (!e.folderPath) return true; // root always passes
        return selectedFolders.some(f => e.folderPath === f || e.folderPath.startsWith(f + '/'));
    });

    if (debugMode && result.length < before) {
        console.log(`[DLE] Folder filter removed ${before - result.length} entries (folders: ${selectedFolders.join(', ')})`);
    }

    return result;
}

/**
 * Filter entries injected within reinjectionCooldown generations. ForceInject exempt.
 *
 * @param {Array} entries
 * @param {{ forceInject: Set }} policy
 * @param {Map} injectionHistory - Map<trackerKey, lastInjectedGeneration>
 * @param {number} generationCount
 * @param {number} reinjectionCooldown - generations to skip
 * @param {boolean} debugMode
 * @returns {Array}
 */
export function applyReinjectionCooldown(entries, policy, injectionHistory, generationCount, reinjectionCooldown, debugMode) {
    if (reinjectionCooldown <= 0) return entries;

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(trackerKey(e))) return true;
        const lastGen = injectionHistory.get(trackerKey(e));
        if (lastGen !== undefined && (generationCount - lastGen) < reinjectionCooldown) {
            if (debugMode) {
                console.debug(`[DLE] Re-injection cooldown: "${e.title}" was injected ${generationCount - lastGen} gens ago (cooldown: ${reinjectionCooldown}) — skipping`);
            }
            return false;
        }
        return true;
    });

    if (debugMode && result.length < before) {
        console.log(`[DLE] Re-injection cooldown removed ${before - result.length} entries`);
    }

    return result;
}

/**
 * Apply requires/excludes gating. ForceInject exempt from both.
 *
 * @param {Array} entries
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @returns {{ result: Array, removed: Array }}
 */
export function applyRequiresExcludesGating(entries, policy, debugMode, priorityReversed = false) {
    // Perf: when NOTHING gates on requires/excludes (the common case) skip the fixpoint loop,
    // the Set/Map builds, and the contradiction scan entirely — just return important-FIRST
    // order (what downstream budget truncation needs). One O(N log N) sort instead of two
    // sorts + up to 10 O(N) passes + 2 Set/Map builds.
    const hasGating = entries.some(e => (e.requires && e.requires.length > 0) || (e.excludes && e.excludes.length > 0));
    if (!hasGating) {
        const sorted = [...entries].sort((a, b) =>
            comparePriority(a, b, priorityReversed)
            || a.title.localeCompare(b.title)
            || (a.vaultSource || '').localeCompare(b.vaultSource || ''));
        return { result: sorted, removed: [] };
    }
    // BUG-029: order so HIGHER-priority entries are processed LAST (so their
    // excludes-targets may already be gone — the high-priority entry survives).
    // Default: lower priority-number = higher importance → descending raw.
    // #16 reversed: higher priority-number = higher importance → ascending raw.
    // comparePriority returns the "important-first" ordering; negate to get "important-last".
    // BUG-AUDIT v2.5: secondary tiebreak by vaultSource keeps sort deterministic across vaults
    // when two entries share the same title — without it, two "Castle"s would sort in load order.
    let result = [...entries].sort((a, b) =>
        -comparePriority(a, b, priorityReversed)
        || a.title.localeCompare(b.title)
        || (a.vaultSource || '').localeCompare(b.vaultSource || ''),
    );
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    // L13: refcount titles instead of a plain Set. With two same-titled entries from
    // DIFFERENT vaults, dropping one must NOT purge the title while its twin survives —
    // otherwise a third entry's `requires:[Title]` wrongly fails. A title is "active"
    // (satisfies a bare cross-vault `requires`/`excludes` lookup) while its count > 0.
    // This preserves gotcha #50 item 7 (permissive cross-vault requires: any vault's
    // "Castle" satisfies a bare `requires:[Castle]`) — the lookup stays bare-title — and
    // only fixes the destructive-delete-while-a-duplicate-survives asymmetry.
    const activeTitles = new Map();
    const isActive = (t) => (activeTitles.get(t) || 0) > 0;
    const dropTitle = (t) => {
        const n = (activeTitles.get(t) || 0) - 1;
        if (n <= 0) activeTitles.delete(t); else activeTitles.set(t, n);
    };
    for (const e of result) {
        const t = e.title.toLowerCase();
        activeTitles.set(t, (activeTitles.get(t) || 0) + 1);
    }

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        iterations++;

        const nextResult = [];
        for (const entry of result) {
            if (policy.forceInject.has(trackerKey(entry))) { nextResult.push(entry); continue; }

            if (entry.requires && entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => isActive(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    dropTitle(entry.title.toLowerCase());
                    continue;
                }
            }
            if (entry.excludes && entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => isActive(r.toLowerCase()));
                if (anyPresent) {
                    changed = true;
                    dropTitle(entry.title.toLowerCase());
                    continue;
                }
            }
            nextResult.push(entry);
        }
        result = nextResult;
    }

    // Detect contradictory gating for debugging.
    const resultSet = new Set(result);
    const removed = entries.filter(e => !resultSet.has(e));
    // Perf: the contradiction-detection Map build + nested scans only produce a console.warn,
    // so gate the whole thing behind debugMode (was always-on every generation).
    if (debugMode && removed.length > 0) {
        const entryMap = new Map(entries.map(e => [e.title.toLowerCase(), e]));
        for (const r of removed) {
            if (r.requires && r.requires.length > 0) {
                for (const req of r.requires) {
                    const reqEntry = entryMap.get(req.toLowerCase());
                    if (reqEntry && reqEntry.excludes && reqEntry.excludes.some(exc => exc.toLowerCase() === r.title.toLowerCase())) {
                        console.warn(`[DLE] Contradictory gating: "${r.title}" requires "${reqEntry.title}" but "${reqEntry.title}" excludes "${r.title}" — both dropped`);
                    }
                }
            }
        }
    }

    if (iterations >= MAX_ITERATIONS && changed) {
        console.warn('[DLE] Gating did not stabilize after', MAX_ITERATIONS, 'iterations');
    }

    if (debugMode && removed.length > 0) {
        console.log(`[DLE] Gating removed ${removed.length} entries:`,
            removed.map(e => ({ title: e.title, requires: e.requires, excludes: e.excludes })));
    }

    // BUG-012: re-sort "important first" before returning. The reversed iteration
    // order is an internal detail of the excludes-resolution loop; downstream
    // consumers (formatAndGroup budget cap) need important-first so they survive truncation.
    // BUG-AUDIT v2.5: vaultSource tiebreak for cross-vault same-title determinism.
    result.sort((a, b) =>
        comparePriority(a, b, priorityReversed)
        || a.title.localeCompare(b.title)
        || (a.vaultSource || '').localeCompare(b.vaultSource || ''),
    );

    return { result, removed };
}

/**
 * Strip entries injected in recent generations. ForceInject exempt.
 *
 * @param {Array} entries
 * @param {{ forceInject: Set }} policy
 * @param {Array} injectionLog - chat_metadata.deeplore_injection_log
 * @param {number} lookbackDepth
 * @param {object} defaultSettings - fallback position/depth/role
 * @param {boolean} debugMode
 * @returns {Array}
 */
export function applyStripDedup(entries, policy, injectionLog, lookbackDepth, defaultSettings, debugMode) {
    if (debugMode) {
        console.debug('[DLE][DIAG] strip-dedup-fn-entry', {
            logExists: !!injectionLog,
            logIsArray: Array.isArray(injectionLog),
            logLength: injectionLog?.length ?? 0,
            lookbackDepth,
            entryCount: entries.length,
        });
    }
    // M-4 (2026-05-22): `arr.slice(-0)` returns the entire array because `-0 === 0`,
    // so a `lookbackDepth=0` call would silently dedup against EVERY historical log
    // entry — the opposite of "no lookback". The settings UI clamps to min 1, but
    // this function is exported and called from `index.js`, the `/dle-why` slash
    // command, and external callers that may not respect the UI minimum. Treat
    // `<= 0` as "dedup disabled" to match the semantic the name implies.
    if (lookbackDepth <= 0) {
        if (debugMode) console.debug('[DLE][DIAG] strip-dedup-fn-early-return — lookbackDepth <= 0, dedup disabled');
        return entries;
    }
    if (!injectionLog || injectionLog.length === 0) {
        if (debugMode) console.debug('[DLE][DIAG] strip-dedup-fn-early-return — log empty or missing, returning all entries');
        return entries;
    }

    const recentEntries = new Set();
    const recentLogs = injectionLog.slice(-lookbackDepth);
    for (const logEntry of recentLogs.flatMap(l => l.entries || [])) {
        // BUG-AUDIT v2.5: include vaultSource in the dedup key so a "Castle" entry
        // injected from vault A doesn't suppress a same-titled but different "Castle"
        // from vault B on the next turn. Legacy log entries without vaultSource use
        // '' which matches new single-vault entries (backward compatible).
        recentEntries.add(`${logEntry.vaultSource || ''}:${logEntry.title}|${logEntry.pos}|${logEntry.depth}|${logEntry.role}|${logEntry.contentHash || ''}`);
    }

    if (debugMode) {
        console.debug('[DLE][DIAG] strip-dedup-set', {
            recentLogCount: recentLogs.length,
            recentLogGens: recentLogs.map(l => l.gen),
            dedupSetSize: recentEntries.size,
            dedupTitles: [...recentEntries].map(k => k.split('|')[0]),
        });
    }

    const before = entries.length;
    const result = entries.filter(e => {
        const forceExempt = policy.forceInject.has(trackerKey(e));
        if (forceExempt) {
            if (debugMode) console.debug(`[DLE][DIAG] strip-dedup-entry-check EXEMPT "${e.title}" (forceInject)`);
            return true;
        }
        // Audit S3-3: defaultSettings is optional — null-guard the fallback reads.
        const ds = defaultSettings || {};
        // M-3 (2026-05-22): cross-entry collisions on an empty `_contentHash` are
        // already prevented because the dedup key includes
        // `vaultSource:title|pos|depth|role` — two distinct entries differ at the
        // title portion long before the hash slot matters. The original spec
        // (and an earlier patch attempt) called for a per-entry `_no_hash_*`
        // sentinel, but that breaks the legitimate same-entry case where a
        // parse-failure window logged `contentHash: ''` and the current gen
        // still has no `_contentHash` — same canonical entry, no hash either
        // side, should dedup. So the read side mirrors the log-write side
        // symmetrically with `|| ''`. The regression test `M-3-1` in
        // `regression.test.mjs` guards the cross-entry case (different titles
        // with empty hash do NOT collide), which is the real risk this fix
        // protects against.
        // BUG-AUDIT v2.5: vaultSource prefix matches the log-write side above.
        const key = `${e.vaultSource || ''}:${e.title}|${e.injectionPosition ?? ds.injectionPosition}|${e.injectionDepth ?? ds.injectionDepth}|${e.injectionRole ?? ds.injectionRole}|${e._contentHash || ''}`;
        const matched = recentEntries.has(key);
        if (debugMode) {
            console.debug(`[DLE][DIAG] strip-dedup-entry-check "${e.title}" — ${matched ? 'STRIPPED' : 'KEPT'}`, { key });
        }
        return !matched;
    });

    if (debugMode && result.length < before) {
        console.debug(`[DLE][DIAG] strip-dedup-summary: removed ${before - result.length}/${before} entries`);
    }

    return result;
}

/**
 * Track cooldowns/decay/injection history after a generation. Caller is
 * responsible for epoch gating.
 *
 * @param {Array} injectedEntries
 * @param {number} generationCount - pre-increment
 * @param {Map} cooldownTracker - mutable
 * @param {Map} decayTracker - mutable
 * @param {Map} injectionHistory - mutable
 * @param {object} settings
 */
export function trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings) {
    for (const entry of injectedEntries) {
        if (entry.cooldown !== null && entry.cooldown > 0) {
            // +1 compensates for the decrement that fires immediately after.
            cooldownTracker.set(trackerKey(entry), entry.cooldown + 1);
        }
    }

    if (settings.reinjectionCooldown > 0) {
        for (const entry of injectedEntries) {
            injectionHistory.set(trackerKey(entry), generationCount + 1);
        }
    }

    if (_isDebug() && injectedEntries.length > 0) {
        const cooldownCount = injectedEntries.filter(e => e.cooldown !== null && e.cooldown > 0).length;
        console.debug('[DLE] Track: %d injected, %d cooldowns set, reinjection=%s', injectedEntries.length, cooldownCount, settings.reinjectionCooldown > 0);
    }
}

/**
 * Decrement cooldown / update decay. Runs in the finally block per generation.
 *
 * @param {Map} cooldownTracker
 * @param {Map} decayTracker
 * @param {Array} injectedEntries
 * @param {object} settings
 * @param {Map} [consecutiveInjections] - mutable
 */
export function decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections) {
    let expiredCooldowns = 0;
    let decayPruned = 0;
    let streaksBroken = 0;

    for (const [title, remaining] of cooldownTracker) {
        if (remaining <= 1) {
            cooldownTracker.delete(title);
            expiredCooldowns++;
        } else {
            cooldownTracker.set(title, remaining - 1);
        }
    }

    // Shared by decay and consecutive tracking.
    const injectedKeys = new Set(injectedEntries.map(e => trackerKey(e)));

    if (settings.decayEnabled) {
        for (const entry of injectedEntries) {
            decayTracker.set(trackerKey(entry), 0);
        }
        const pruneThreshold = (settings.decayBoostThreshold || 5) * 2;
        for (const [tk, staleness] of decayTracker) {
            if (!injectedKeys.has(tk)) {
                if (staleness + 1 >= pruneThreshold) { // BUG-H10: was > (off-by-one, kept 1 extra gen)
                    decayTracker.delete(tk);
                    decayPruned++;
                } else {
                    decayTracker.set(tk, staleness + 1);
                }
            }
        }
    }

    // Independent of decay — consumed by AI manifest builder for [FREQUENT] hints.
    if (consecutiveInjections) {
        for (const entry of injectedEntries) {
            const tk = trackerKey(entry);
            consecutiveInjections.set(tk, (consecutiveInjections.get(tk) || 0) + 1);
        }
        for (const [tk] of consecutiveInjections) {
            if (!injectedKeys.has(tk)) {
                consecutiveInjections.delete(tk);
                streaksBroken++;
            }
        }
    }

    if (_isDebug() && (expiredCooldowns > 0 || decayPruned > 0 || streaksBroken > 0)) {
        console.debug('[DLE] Decrement: %d cooldowns expired, %d decay pruned, %d streaks broken', expiredCooldowns, decayPruned, streaksBroken);
    }
}

/**
 * Record analytics for matched and injected entries.
 *
 * @param {Array} matchedEntries - pre-budget
 * @param {Array} injectedEntries - post-budget
 * @param {object} analyticsData - mutable, from settings
 */
export function recordAnalytics(matchedEntries, injectedEntries, analyticsData) {
    for (const entry of matchedEntries) {
        const aKey = trackerKey(entry);
        if (!Object.hasOwn(analyticsData, aKey)) {
            analyticsData[aKey] = { matched: 0, injected: 0, lastTriggered: 0 };
        }
        analyticsData[aKey].matched++;
        analyticsData[aKey].lastTriggered = Date.now();
    }
    for (const entry of injectedEntries) {
        const aKey = trackerKey(entry);
        if (!Object.hasOwn(analyticsData, aKey)) {
            analyticsData[aKey] = { matched: 0, injected: 0, lastTriggered: 0 };
        }
        analyticsData[aKey].injected++;
    }

    // Prune entries not triggered in 30+ days.
    const ANALYTICS_STALE_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let stalePruned = 0;
    for (const key of Object.keys(analyticsData)) {
        if (analyticsData[key].lastTriggered && (now - analyticsData[key].lastTriggered) > ANALYTICS_STALE_MS) {
            delete analyticsData[key];
            stalePruned++;
        }
    }

    // Cap at 500, evict oldest by lastTriggered. `_`-prefixed meta buckets
    // (e.g. `_librarian`) are exempt — no lastTriggered, would sort first.
    const ANALYTICS_MAX = 500;
    const keys = Object.keys(analyticsData).filter(k => !k.startsWith('_'));
    let capEvicted = 0;
    if (keys.length > ANALYTICS_MAX) {
        keys.sort((a, b) => (analyticsData[a].lastTriggered || 0) - (analyticsData[b].lastTriggered || 0));
        for (const key of keys.slice(0, keys.length - ANALYTICS_MAX)) {
            delete analyticsData[key];
            capEvicted++;
        }
    }

    if (_isDebug() && (stalePruned > 0 || capEvicted > 0)) {
        console.debug('[DLE] Analytics: %d stale pruned, %d cap evicted', stalePruned, capEvicted);
    }
}
