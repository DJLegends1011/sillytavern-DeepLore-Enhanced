# State and Lifecycle Deep Dive

All mutable state lives in `src/state.js`. This doc covers the state architecture, every variable's scope, the observer pattern, and the full CHAT_CHANGED reset sequence.

---

## Architecture

`state.js` declares all globals as `let` exports. ES modules export live bindings, but `let` exports can only be reassigned from the declaring module. So every variable has a corresponding `set*()` setter function that other modules call.

No getter functions exist — other modules `import { vaultIndex } from './state.js'` and read the live binding directly. Setters that should trigger UI updates call a `notify*()` function (observer pattern).

---

## State Variable Categories

### Vault Index State
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `vaultIndex` | `VaultEntry[]` | Session (rebuilt) | vault.js | pipeline, stages, drawer, graph, commands |
| `folderList` | `[{path, entryCount}]` | Session (rebuilt) | vault.js | drawer gating tab, CHAT_CHANGED |
| `indexTimestamp` | `number` (ms) | Session (rebuilt) | vault.js | ensureIndexFresh TTL check |
| `indexing` | `boolean` | Session | vault.js | UI status, build dedup |
| `buildPromise` | `Promise\|null` | Session | vault.js | ensureIndexFresh dedup |
| `indexEverLoaded` | `boolean` | Session | vault.js | first-gen dedup log clear, empty vault detection |
| `previousIndexSnapshot` | `object\|null` | Session | vault.js, core/sync.js | change detection |
| `lastVaultFailureCount` | `number` | Session | vault.js | computeOverallStatus |
| `lastVaultAttemptCount` | `number` | Session | vault.js | computeOverallStatus |
| `vaultAvgTokens` | `number` | Session (rebuilt) | vault.js | manifest header |
| `fieldDefinitions` | `FieldDefinition[]` | Session (rebuilt) | vault.js | contextual gating, drawer, rule builder |
| `fieldDefinitionsLoaded` | `boolean` | Session | vault.js | guard for defaults |
| `entityNameSet` | `Set<string>` | Session (rebuilt) | vault.js | AI cache sliding window |
| `entityShortNameRegexes` | `Map` | Session (rebuilt) | vault.js | AI cache entity detection |
| `entityRegexVersion` | `number` (monotonic) | Session | setEntityShortNameRegexes | AI cache staleness check |
| `fuzzySearchIndex` | `object\|null` | Session (rebuilt) | vault.js | BM25 matching |
| `mentionWeights` | `Map` | Session (rebuilt) | vault.js | graph edges |
| `buildEpoch` | `number` (counter) | Session | vault.js | zombie build guard |
| `syncIntervalId` | `number\|null` | Session | vault/sync.js | sync dedup, teardown |

### AI Search State
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `aiSearchCache` | `{hash, manifestHash, chatLineCount, results, matchedEntrySet}` | Chat (cleared) | ai.js, CHAT_CHANGED, notifyGatingChanged | aiSearch cache check |
| `aiSearchStats` | `{calls, cachedHits, totalInputTokens, totalOutputTokens, hierarchicalCalls}` | **Session** (NOT reset) | ai.js | drawer footer |

### Generation Tracking
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `generationLock` | `boolean` | Chat (released) | onGenerate, CHAT_CHANGED | onGenerate lock check |
| `generationLockTimestamp` | `number` (ms) | Chat (released) | setGenerationLock, setGenerationLockTimestamp | stale lock detection |
| `generationLockEpoch` | `number` (counter) | Chat (bumped) | setGenerationLock, CHAT_CHANGED, GENERATION_STOPPED | epoch guards |
| `chatEpoch` | `number` (counter) | Never (monotonic) | CHAT_CHANGED (+1) | all epoch guards |
| `generationCount` | `number` | Chat (→0) | finally block, CHAT_CHANGED | cooldown, analytics, rebuild trigger |
| `lastIndexGenerationCount` | `number` | Chat (→0) | vault.js | generation-based rebuild trigger |

### Injection Tracking

**Verdict store** (`src/verdict/verdict-store.js`, 2026-05-22) replaces four racing globals
(`lastInjectionSources`, `lastInjectionEpoch`, `previousSources`, `lastPipelineTrace`).
A verdict is one authoritative per-turn record carrying `injectedSources`, full pipeline
`trace`, `perEntry` aggregation, `chatId` + `msgIdx` for cross-chat staleness detection,
and `epoch`/`lockEpoch` tags. Storage: in-memory ring buffer (cap 50) + IndexedDB spill
(per-chat, cap 200, auto-pruned). Never written to `chat_metadata` — chat files stay clean.

**Verdict APIs (verdict-store.js):**
| API | Use |
|---|---|
| `writeVerdict(v)` | Pipeline writes one verdict at commit (replaces 4× setLast*). |
| `getCurrent()` | Newest verdict (any chat in ring). |
| `getCurrentForChat(chatId)` | Newest for a specific chat. |
| `getPrevious()` | Second-newest for the current chat (replaces `previousSources` diff anchor). |
| `getByMessage(msgIdx, chatId?)` | Verdict-by-message lookup; falls back to IDB. |
| `setCurrentChatId(chatId)` | Rebind scope on CHAT_CHANGED. |
| `clearChat(chatId)` | Drop ring + IDB records for a chat. `null` = wipe everything. |
| `hydrateChat(chatId)` | Pull recent IDB records for resume-after-reload. |
| `onVerdictChanged(cb)` | Observer; fires on every write / clear / hydrate. |

**Verdict shape (per record):** `genId`, `chatId`, `msgIdx`, `epoch`, `lockEpoch`, `ts`,
`injectedSources[]`, `trace` (full pipeline trace — keywordMatched, aiSelected, gatedOut,
budgetCut, injected, all stage `*Ms` timings, fuzzyStats, etc.), `perEntry[]` (one row per
candidate seen this turn with `finalState`, reason chain, confidence, tokens).

**`trace.keywordMatched` / `aiSelected` and removal-stage arrays now carry `vaultSource`**
(2026-05-22) so `perEntry` aggregation can distinguish multi-vault same-title entries
under `multiVaultConflictResolution='all'` (CLAUDE.md trackerKey invariant).

| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `cooldownTracker` | `Map<trackerKey, remaining>` | Chat (cleared) | trackGeneration, decrementTrackers, CHAT_CHANGED | matching, cooldown stage |
| `decayTracker` | `Map<trackerKey, gensSince>` | Chat (cleared) | trackGeneration, decrementTrackers, CHAT_CHANGED | matching decay boost |
| `consecutiveInjections` | `Map<trackerKey, count>` | Chat (cleared) | trackGeneration, CHAT_CHANGED | decay calculation |
| `injectionHistory` | `Map<trackerKey, lastGen>` | Chat (cleared) | trackGeneration, CHAT_CHANGED | reinjection cooldown |
| `chatInjectionCounts` | `Map<trackerKey, count>` | Chat (hydrated) | onGenerate stage 9, MESSAGE_SWIPED, CHAT_CHANGED | drawer, analytics |
| `perSwipeInjectedKeys` | `Map<swipeKey, Set<trackerKey>>` | Chat (hydrated) | onGenerate stage 9, CHAT_CHANGED | swipe rollback |
| `lastGenerationTrackerSnapshot` | `object\|null` | Chat (→null) | onGenerate swipe phase, CHAT_CHANGED | swipe rollback |
| `lastWarningRatio` | `number` | Chat (→0) | onGenerate context warning | warning dedup |

### Scribe State
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `lastScribeChatLength` | `number` | Chat (hydrated) | runScribe, CHAT_CHANGED | scribe trigger |
| `scribeInProgress` | `boolean` | **NOT reset on CHAT_CHANGED** | runScribe | scribe lock |
| `lastScribeSummary` | `string` | Chat (hydrated) | runScribe, CHAT_CHANGED | scribe context, AI search |

### Librarian State
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `loreGaps` | `array` | Chat (hydrated) | persistGaps, CHAT_CHANGED | drawer librarian tab |
| `loreGapSearchCount` | `number` | Generation (→0) | onGenerate (agentic dispatch), searchLoreAction | max search limit |
| `librarianSessionStats` | `{searchCalls, flagCalls, estimatedExtraTokens}` | **Session** (NOT reset) | librarian-tools.js | drawer footer |
| `librarianChatStats` | `{searchCalls, flagCalls, estimatedExtraTokens}` | Chat (→zeroed) | librarian-tools.js, CHAT_CHANGED | drawer |

### Pipeline Control Flags
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `skipNextPipeline` | `boolean` | Consumed on use (→false) | commands-ai.js (`/dle-review`) | onGenerate (early return before tool-call check) |
| `suppressNextAgenticLoop` | `boolean` | Consumed on use (→false) | drawer-events.js (skip-tools toggle button) | onGenerate (agentic dispatch branch) |

### UI State
| Variable | Type | Reset scope | Writers | Readers |
|---|---|---|---|---|
| `pipelinePhase` | `'idle'\|'choosing'\|'generating'\|'writing'\|'searching'\|'flagging'` | Session | `setPipelinePhase()` | drawer status display |
| `autoSuggestMessageCount` | `number` | Chat (→0) | CHARACTER_MESSAGE_RENDERED, CHAT_CHANGED | auto-suggest trigger |
| `notepadExtractInProgress` | `boolean` | Chat (→false) | GENERATION_ENDED, CHAT_CHANGED | extract lock |
| `lastHealthResult` | `{errors, warnings}\|null` | Session | /dle-health command | settings badge |
| `claudeAutoEffortBad` | `boolean` | Session | init pre-flight | drawer chip, settings banner |
| `claudeAutoEffortDetail` | `object\|null` | Session | init pre-flight | toast message |
| `ds.browseRowModel` | `Array<{type:'header'\|'entry'...}>` | Chat (→[]) | `renderBrowseTab()` | `renderBrowseWindow()` virtual scroll |
| `ds.browseFolderGrouping` | `boolean` | Session (NOT reset on CHAT_CHANGED — UI pref) | group-toggle button | `renderBrowseTab()` row-model builder |
| `ds.browseExpandedFolders` | `Set<string>` | Session (NOT reset on CHAT_CHANGED) | group toggle (seed), folder-header click | `buildBrowseRowModel()` |
| `ds.browseSelectMode` | `boolean` | Chat (→false) | select-toggle button, CHAT_CHANGED | renderer (shows row checkboxes) |
| `ds.browseSelected` | `Set<string>` (trackerKey-keyed) | Chat (→clear) | row checkbox, folder select-all, CHAT_CHANGED | toolbar count, `runBatchOptimize()` |

### AI Circuit Breaker State
| Variable | Type | Scope |
|---|---|---|
| `aiCircuitOpen` | `boolean` | Session |
| `aiCircuitFailures` | `number` | Session |
| `aiCircuitOpenedAt` | `number` (ms) | Session |
| `aiCircuitHalfOpenProbe` | `boolean` (private) | Session |
| `aiCircuitProbeTimestamp` | `number` (private) | Session |

**`pushEventSafe()`** (state.js): Lazy-loaded wrapper for `pushEvent()` from `src/diagnostics/interceptors.js`. Used by the circuit breaker state machine so that open/close transitions push to the `eventBuffer` without creating a hard import dependency from state.js on the diagnostics module. Called from `recordAiFailure()` (on CLOSED -> OPEN) and `recordAiSuccess()` (on OPEN -> CLOSED).

---

## Observer Pattern

Each observable is a `Set<() => void>`. Registration returns an unsubscribe function. Callbacks are never cleared — the extension initializes once and persists for page lifetime.

| Observable | `on*()` | `notify*()` | Triggers | Subscribers |
|---|---|---|---|---|
| Index updated | `onIndexUpdated` | `notifyIndexUpdated` | finalizeIndex in vault.js | drawer, settings-ui |
| AI stats | `onAiStatsUpdated` | `notifyAiStatsUpdated` | aiSearch, scribe calls | drawer footer |
| Circuit state | `onCircuitStateChanged` | `notifyCircuitStateChanged` | recordAiSuccess/Failure | drawer, settings-ui |
| Injection sources ready | `onInjectionSourcesReady` | `notifyInjectionSourcesReady` | `setLastInjectionSources()` commit (before `notifyPipelineComplete`) | drawer (Why? tab only) |
| Pipeline complete | `onPipelineComplete` | `notifyPipelineComplete` | onGenerate finally, CHAT_CHANGED | drawer (all tabs) |
| Gating changed | `onGatingChanged` | `notifyGatingChanged` | context/field changes, CHAT_CHANGED | drawer gating tab |
| Pin/block changed | `onPinBlockChanged` | `notifyPinBlockChanged` | pin/block commands | drawer injection tab |
| Generation lock | `onGenerationLockChanged` | `notifyGenerationLockChanged` | setGenerationLock | drawer status |
| Field definitions | `onFieldDefinitionsUpdated` | `notifyFieldDefinitionsUpdated` | setFieldDefinitions | drawer gating tab, rule builder |
| Indexing state | `onIndexingChanged` | `notifyIndexingChanged` | setIndexing | drawer status |
| Lore gaps | `onLoreGapsChanged` | `notifyLoreGapsChanged` | setLoreGaps | drawer librarian tab |
| Claude auto-effort | `onClaudeAutoEffortChanged` | (inline in setter) | setClaudeAutoEffortState | drawer chip, settings banner |
| Pipeline phase | `onPipelinePhaseChanged` | `notifyPipelinePhase` (via `setPipelinePhase`) | `setPipelinePhase()` | drawer status display |

**Side effects in notify functions:**
- `notifyGatingChanged()` also resets `aiSearchCache` (gating changes invalidate cached AI results)
- `notifyPinBlockChanged()` also resets `aiSearchCache` (same reason)
- `notifyFieldDefinitionsUpdated()` also resets `aiSearchCache`

---

## CHAT_CHANGED Handler

Full ordered reset sequence in `index.js` (`CHAT_CHANGED` handler registered via `_registerEs(event_types.CHAT_CHANGED, ...)`). This is the most complex event handler — every line is load-bearing.

### 1. Epoch + Lock
```
setChatEpoch(chatEpoch + 1)           // Invalidates all in-flight pipeline epoch checks
_removePipelineStatus()                // Clean up UI
if (generationLock):
  setGenerationLockEpoch(lockEpoch+1)  // Invalidate stale pipeline commits
  setGenerationLock(false)             // Release lock for new chat
```

### 2. Scribe State Hydration
```
setLastScribeChatLength(metadata.deeplore_lastScribeChatLength || chat.length)
setLastScribeSummary(metadata.deeplore_lastScribeSummary || '')
// BUG-275: Do NOT reset scribeInProgress — in-flight scribe owns its own flag
setNotepadExtractInProgress(false)     // BUG-061: Safe to reset — epoch guard protects writes
```

### 3. Per-Chat Tracker Reset
```
injectionHistory.clear()
cooldownTracker.clear()
decayTracker.clear()
consecutiveInjections.clear()
```

### 4. Chat Injection Counts Hydration
```
Hydrate chatInjectionCounts from chat_metadata.deeplore_chat_counts
Prune orphaned keys (if vaultIndex populated) — BUG-072
```

### 5. Folder Filter Validation
```
Prune stale folder names from deeplore_folder_filter — BUG-074
```

### 6. Swipe Keys Hydration
```
Hydrate perSwipeInjectedKeys from chat_metadata.deeplore_swipe_injected_keys
setLastGenerationTrackerSnapshot(null)
```

### 7. Counter/Cache Resets
```
setGenerationCount(0)
setLastIndexGenerationCount(0)
setLastInjectionEpoch(-1)
setLastWarningRatio(0)
setAiSearchCache({...empty...})
resetAiThrottle()
setAutoSuggestMessageCount(0)
setLastPipelineTrace(null)
setLastInjectionSources(null)
setPreviousSources(null)
resetCartographer()
```

### 8. Librarian State Hydration
```
setLoreGaps(metadata.deeplore_lore_gaps?.map(normalizeLoreGap) || [])
setLoreGapSearchCount(0)
setLibrarianChatStats({...zeroed...})
clearSessionActivityLog()
```

### 9. UI Reset + Notifications
```
resetDrawerState()
notifyPipelineComplete()     // Forces drawer re-render
notifyGatingChanged()        // Forces gating tab re-render + AI cache invalidation
```

### 10. PM Entry Re-Registration
If `injectionMode === 'prompt_list'`, re-registers PM entries for the new active character.

### 11. Chat Load UI Injection
Deferred via `setTimeout` + `requestAnimationFrame`. Epoch-guarded (`injectEpoch === chatEpoch`).
- **Migration pass 1**: `tool_invocations` → `deeplore_tool_calls` (BUG-126 sentinel)
- **Migration pass 2**: `deeplore_sources` from empty intermediates → correct reply
- **UI injection**: Cartographer buttons + Librarian dropdowns on last 50 messages

**Save semantics:** When migration mutated `m.extra.*` and/or set the `deeplore_migration_v2` sentinel, persistence MUST go through `await saveChatConditional()`, not `saveMetadataDebounced()`. The debounced metadata save can be cancelled by a CHAT_CHANGED that fires before the timer expires — the sentinel and message extras would both be lost, so the migration would re-run on the next reload while the dropdown UI vanishes for the current session. The RAF callback is async; re-check `injectEpoch === chatEpoch` immediately before the await.

---

## Event Subscriptions

All registered via `_registerEs()` in `init()`. Full list:

| Event | Handler |
|---|---|
| `GENERATION_STOPPED` | Release lock, clear status, bump lockEpoch, clear prompts (inline in `init()`) |
| `GENERATION_ENDED` (AI Notebook) | Extract `<dle-notes>` (tag mode) or async extract (extract mode) (inline in `init()`) |
| `CHARACTER_MESSAGE_RENDERED` | Cartographer sources, AI Notebook fallback, Scribe trigger, Auto-suggest (inline in `init()`) |
| `MESSAGE_SWIPED` | Clear tool calls/sources/notes on swiped message, rebuild counts (inline in `init()`) |
| ~~`MESSAGE_DELETED`~~ | *(Removed — agentic loop produces no intermediates to clean up)* |
| `MESSAGE_SWIPE_DELETED` | Clean up per-message extras (inline in `init()`) |
| `CHAT_DELETED` / `GROUP_CHAT_DELETED` | `_onChatDeleted` — clear Librarian session state |
| `CONNECTION_PROFILE_DELETED` | `_onProfileDeleted` — null dangling profileIds, toast |
| `CONNECTION_PROFILE_UPDATED` | `_onProfileUpdated` — invalidate settings cache |
| `SETTINGS_UPDATED` | Invalidate settings cache (inline in `init()`) |
| `MESSAGE_EDITED` | Remove AI notes from edited message (inline in `init()`) |
| `CHAT_CHANGED` | Full reset sequence (see above — inline in `init()`) |
| `APP_READY` | `_wizardOnce` (first-run wizard) + `_autoConnectOnce` (auto-connect), both `{ once: true }` |

---

## trackerKey(entry)

```javascript
export function trackerKey(entry) {
    return `${entry.vaultSource || ''}:${entry.title}`;
}
```

**Format:** `vaultSource:title` (e.g., `MyVault:King Alaric` or `:King Alaric` for single-vault)

**Purpose:** Prevents multi-vault title collisions in all Map-based tracking.

**Used in:** cooldownTracker, injectionHistory, decayTracker, consecutiveInjections, chatInjectionCounts, perSwipeInjectedKeys, analyticsData, chatInjectionCounts hydration/pruning.

---

## Circuit Breaker State Machine

Three states: **CLOSED** → **OPEN** → **HALF-OPEN** → CLOSED (on success) or OPEN (on failure).

```
CLOSED: aiCircuitOpen=false. All AI calls pass through.
OPEN:   aiCircuitOpen=true, cooldown not expired. All calls blocked.
HALF-OPEN: aiCircuitOpen=true, cooldown expired. One probe allowed.
```

- **Threshold:** 2 consecutive failures (`AI_CIRCUIT_THRESHOLD`)
- **Cooldown:** 30s (`AI_CIRCUIT_COOLDOWN`)
- **Probe timeout:** 60s (`AI_PROBE_TIMEOUT`) — stale probe auto-resets
- **Atomic probe:** `aiCircuitHalfOpenProbe` flag prevents thundering herd

**API split (BUG-AUDIT-1/2):**
- `isAiCircuitOpen()` — **pure query**, no mutations. Safe for UI.
- `tryAcquireHalfOpenProbe()` — **mutation gate**. Only for AI call paths.
- `releaseHalfOpenProbe()` — Used by `hierarchicalPreFilter` (its outcome shouldn't affect breaker).

See `src/state.js` — `recordAiFailure()`, `recordAiSuccess()`, `releaseHalfOpenProbe()`, `isAiCircuitOpen()`, `tryAcquireHalfOpenProbe()` — for full implementation.
