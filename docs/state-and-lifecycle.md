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
(per-chat, **soft cap 200 — actually 200+9** worst-case between sampled prune scans;
Wave C P1 perf fix 2026-05-22). Never written to `chat_metadata` — chat files stay clean.
`pruneCurrentChat` runs the actual IDB scan every 10th `writeVerdict` (counter-gated +
bounded `openKeyCursor` scoped to the current chatId, key-only walk, no value
deserialization). 90% of generations no-op the scan. See `docs/gotchas.md` #52.

**Verdict APIs (verdict-store.js):**
| API | Use |
|---|---|
| `writeVerdict(v)` | Pipeline writes one verdict at commit (replaces 4× setLast*). Async; ring write is sync so immediate reads see it, IDB spill fire-and-forget. |
| `getCurrent()` | Newest verdict (any chat in ring). |
| `getCurrentForChat(chatId)` | Newest for a specific chat (backward ring scan). |
| `getPrevious()` | Second-newest for the current chat (replaces `previousSources` diff anchor). |
| `getByMessageSync(msgIdx, chatId?)` | Ring-only sync lookup (no IDB fallback). For sync UI consumers (cartographer popup). |
| `getPreviousForMessage(msgIdx, chatId?)` | Ring verdict with the largest `msgIdx' < msgIdx` — "what changed since the prior turn" when inspecting an OLDER message. Sync. |
| `getByMessage(msgIdx, chatId?)` | Async verdict-by-message lookup; ring first, falls back to range-scoped IDB scan. |
| `setCurrentChatId(chatId)` | Rebind scope on CHAT_CHANGED. |
| `clearRing()` | Drop in-memory ring only (sync, no IDB touch). **Use on CHAT_CHANGED** so the destination chat's IDB rows survive for hydrate. |
| `clearChatIdb(chatId)` | Drop IDB rows for one chat (e.g. user deletes chat). Ring untouched. |
| `clearChat(chatId)` | Drop ring + IDB records for a chat. `null` = wipe everything (nuke-from-orbit only; **never** call on CHAT_CHANGED — it deletes every chat's persisted verdicts). |
| `hydrateChat(chatId)` | Pull recent IDB records for resume-after-reload. F2 race fix: merges (not replaces) mid-hydration writes whose `ts` beats the freshest hydrated row. See gotchas #46. |
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
| `librarianChatStats` | `{searchCalls, flagCalls, estimatedExtraTokens}` | Chat (→zeroed) | librarian-tools.js, CHAT_CHANGED | drawer (settings popup readout only — NOT footer) |
| `librarianLastUsage` | `{input, output, total}` | Chat (→zeroed) | index.js (post-`runAgenticLoop`, from `result.usage`), CHAT_CHANGED | drawer footer `.dle-librarian-usage` readout |

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

### Editable Prompts State (`src/prompts/prompt-store.js`, 2026-05-28)
| Variable | Type | Scope | Writers | Readers |
|---|---|---|---|---|
| `promptCache` | `Map<key, string>` | Session | `loadPrompts()` | `getPrompt()` (sync hot path) |
| `promptMeta` | `Map<key, object>` | Session | `loadPrompts()` | `getPromptStatusGrid()` (UI) |
| `_currentLocale` | `string` | Session | `loadPrompts()` | `reloadPrompts()` |
| `_loaded` | `boolean` | Session | `loadPrompts()` | tests only |
| `_lastLoadErrors` | `Array<{key,reason}>` | Session | `loadPrompts()` | `getLastLoadErrors()`, toastr surface |
| `_lastConnection` | `object\|null` | Session | `loadPrompts()` | `reloadPrompts()` |
| **Setting** `aiPromptLocale` | `string` (locale or `''`) | Settings (persisted) | Prompts tab dropdown | `loadPrompts(settings.aiPromptLocale, ...)` |
| **Setting** `promptsFolderPath` | `string` (relative path ending `/`) | Settings (persisted) | Prompts tab folder field | `buildPromptsConnection()` → `sanitizePromptsFolderPath()` |

Boot order: `index.js` calls `loadPrompts()` after `loadSettingsUI()` / `bindSettingsEvents()`. Failures logged-not-thrown so a missing vault never blocks startup. `getPrompt()` is sync — cache is preloaded, every lookup is a Map hit.

`buildPromptOverlay()` and `computePromptStatus()` are pure (in `prompt-store-pure.js`) — tested directly without mocks. The status state machine outputs one of `current_default`, `stale_default`, `customized`, `customized_stale_baseline`, `missing`.

See `docs/gotchas.md` #70 for the delete cage layers and the load-bearing structural test that enforces exactly one HTTP `DELETE` site in `src/`.

### i18n State (`src/i18n/i18n.js`, 2026-05-22)
| Variable | Type | Scope | Writers | Readers |
|---|---|---|---|---|
| `_dleDict` | `object\|null` | Session | `initDleI18n()` | `tr()` lookups |
| `_enFallbackDict` | `object\|null` | Session | `initDleI18n()` | `tr()` fallback |
| `_dleLocale` | `string\|null` | Session | `initDleI18n()` | `getI18nStats()` |
| `_initPromise` | `Promise\|null` | Session | `initDleI18n()` (dedupe) | concurrent init |
| `_aiPromptLocale` | `string\|null` | Session | `setAiPromptLocale()` (test/debug) | `getEffectiveAiPromptLocale()` |
| **Setting** `aiPromptLocale` | `string` (locale code or `''`) | Settings (persisted) | Settings UI / `/dle` cmds | `getEffectiveAiPromptLocale(settingValue)` |

Init order matters: `initDleI18n()` runs in `index.js` jQuery handler **before** any HTML template render, so ST's MutationObserver picks up `data-i18n` attrs on first insertion. Concurrent callers get the same `_initPromise` — no duplicate fetches.

Pure helpers (`src/i18n/i18n-pure.js`) carry no state — they're imported by `i18n.js` and tested independently in `test/i18n.test.mjs`.

**`pushEventSafe()`** (state.js): Lazy-loaded wrapper for `pushEvent()` from `src/diagnostics/interceptors.js`. Used by the circuit breaker state machine so that open/close transitions push to the `eventBuffer` without creating a hard import dependency from state.js on the diagnostics module. Called from `recordAiFailure()` (on CLOSED -> OPEN) and `recordAiSuccess()` (on OPEN -> CLOSED).

---

## Observer Pattern

Each observable is a `Set<() => void>`. Registration returns an unsubscribe function. Callbacks are never cleared — the extension initializes once and persists for page lifetime.

| Observable | `on*()` | `notify*()` | Triggers | Subscribers |
|---|---|---|---|---|
| Index updated | `onIndexUpdated` | `notifyIndexUpdated` | finalizeIndex in vault.js | drawer, settings-ui |
| AI stats | `onAiStatsUpdated` | `notifyAiStatsUpdated` | aiSearch, scribe calls | drawer footer |
| Circuit state | `onCircuitStateChanged` | `notifyCircuitStateChanged` | recordAiSuccess/Failure | drawer, settings-ui |
| Injection sources ready | `onInjectionSourcesReady` | `notifyInjectionSourcesReady` | `writeVerdict()` commit in onGenerate (index.js :1217, :1239 — fires immediately after the per-turn verdict is written, before the agentic loop / ST generation) | drawer (Why? tab only) |
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

### 7. Counter/Cache Resets + Verdict Rebind
```
setGenerationCount(0)
setLastIndexGenerationCount(0)
setLastWarningRatio(0)
resetAiSearchCache()              // canonical empty shape (incl. matchedEntrySet)
resetAiThrottle()
setAutoSuggestMessageCount(0)
resetCartographer()

// Verdict store (REPLACES the old setLastInjectionEpoch(-1) /
//                setLastPipelineTrace(null) / setLastInjectionSources(null) /
//                setPreviousSources(null) line — all four globals were deleted
//                in the Verdict refactor; see state.js :48,:75,:103):
newVerdictChatId = getCurrentChatId() || null
clearVerdictRing()                // clearRing — in-memory ring ONLY, no IDB touch
setVerdictChatId(newVerdictChatId) // setCurrentChatId — rebind scope
if (newVerdictChatId) hydrateVerdictChat(newVerdictChatId)  // async, fire-and-forget
```
**Do NOT call `clearChat(null)` here** — that nukes every chat's IDB rows and defeats the
per-chat spill (resume-after-reload). `clearRing()` is the only correct call on chat switch.
See `docs/gotchas.md` #46. `index.js` imports these aliased: `clearRing as clearVerdictRing`,
`setCurrentChatId as setVerdictChatId`, `hydrateChat as hydrateVerdictChat` (index.js :90-93).

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
| `CHAT_CHANGED` | Full reset sequence (see above — inline in `init()`). **Early-registered stub** at top of `_doInit()` (`_earlyChatChangedStub`) captures events that fire before the real `_realCcHandler` registers; `_installRealChatChangedHandler` drains the queued chatId once. See gotchas #59 (BOOT-MED-3). |
| `APP_READY` | `_wizardOnce` (first-run wizard) + `_autoConnectOnce` (auto-connect), both `{ once: true }` |

**Boot-time module-scope vars (`index.js`, Boot-MED-1/3, 2026-05-22):**
| Variable | Purpose |
|---|---|
| `_dleInitialized` | True only AFTER `_doInit()` resolves all awaits. Guards true re-init (BUG-063). |
| `_dleInitInProgress` | Promise sentinel during `_doInit()` execution. Second jQuery dispatch awaits this instead of tearing down the still-initializing first instance. Cleared in `finally`. |
| `_realChatChangedHandler` | Set by `_installRealChatChangedHandler`. While `null`, the early stub queues events; once set, the stub becomes a trampoline that forwards directly. |
| `_pendingChatChanged` / `_pendingChatChangedFired` | Single-slot queue for CHAT_CHANGED events that fire during init's awaits. Drained exactly once at `_installRealChatChangedHandler`. |

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
