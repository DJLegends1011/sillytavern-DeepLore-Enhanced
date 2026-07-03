# Secondary Features Deep Dive

Features that are important but less regression-prone than the core pipeline. Each section covers the code flow, state dependencies, and gotchas.

---

## 1. Session Scribe

**Source:** `src/ai/scribe.js`

**Trigger:** Counter-based inside the `CHARACTER_MESSAGE_RENDERED` handler in `index.js` (registered via `_registerEs(event_types.CHARACTER_MESSAGE_RENDERED, ...)`). Fires when `chat.length - lastScribeChatLength >= settings.scribeInterval` and `!scribeInProgress`.

**Flow:**
```
CHARACTER_MESSAGE_RENDERED
  → Check: chat.length - lastScribeChatLength >= scribeInterval
  → Check: !scribeInProgress
  → runScribe()  (fire-and-forget)
    → setScribeInProgress(true)
    → Build context from recent chat messages
    → Include lastScribeSummary as prior context
    → callAI(scribePrompt, context, resolveConnectionConfig('scribe'))
    → writeNote(vaultName, filename, responseText)  (Obsidian REST API)
    → buildIndex()  (re-index to pick up new note)
    → setLastScribeChatLength(chat.length)
    → setLastScribeSummary(responseText)
    → pushEvent('scribe', {status, chatLength, ...})  (on completion or error)
    → Persist both to chat_metadata
    → setScribeInProgress(false)  (in finally)
```

**State:**
- `scribeInProgress`: Lock. **NOT reset on CHAT_CHANGED** (BUG-275). The in-flight scribe owns its flag and releases it in its own `finally`. Resetting in CHAT_CHANGED would let concurrent scribes race.
- `lastScribeChatLength`: Hydrated from `chat_metadata.deeplore_lastScribeChatLength` on CHAT_CHANGED. Falls back to `chat.length` on first visit.
- `lastScribeSummary`: Hydrated from `chat_metadata.deeplore_lastScribeSummary`. Fed into the next scribe call as context.

**Scribe-informed retrieval:** `lastScribeSummary` is available to the AI search manifest builder, providing session context to improve lore selection even when explicit keywords are sparse.

**Connection:** `resolveConnectionConfig('scribe')` — independent connection config, can inherit from aiSearch.

---

## 2. AI Notebook

**Source:** `index.js` — `GENERATION_ENDED` handler (`_registerEs(event_types.GENERATION_ENDED, ...)`) for primary extraction, and `CHARACTER_MESSAGE_RENDERED` handler fallback block (calls `extractAiNotes()` inside the render handler)

Two modes: `tag` and `extract`.

### Tag Mode (default)
The AI writes `<dle-notes>` blocks in its response. DLE extracts them post-generation.

**Flow (GENERATION_ENDED):**
```
→ Capture tagEpoch = chatEpoch
→ extractAiNotes(lastMessage.mes) → { notes, cleanedMessage }
→ If notes && tagEpoch === chatEpoch:
    → lastMessage.mes = cleanedMessage  (strip tags from visible text)
    → lastMessage.extra.deeplore_ai_notes = notes
    → chat_metadata.deeplore_ai_notepad = capNotepad(existing + notes)
    → saveMetadataDebounced()
```

**Injection (inside `onGenerate()` AI Notepad block, uses `DEFAULT_AI_NOTEPAD_PROMPT`):** Injects previous notes as `[Your previous session notes]` block + instruction prompt (DEFAULT_AI_NOTEPAD_PROMPT) at configured position/depth/role.

### Extract Mode
DLE strips visible note-taking prose, then fires an async API call to extract session notes.

**Flow (GENERATION_ENDED):**
```
→ Strip VISIBLE_NOTES_PATTERNS from lastMessage.mes
→ Check: !notepadExtractInProgress
→ Capture extractEpoch = chatEpoch, swipeIdAtStart
→ Async:
    → setNotepadExtractInProgress(true)
    → callAI(extractPrompt, context, resolveConnectionConfig('aiNotepad'))
    → POST-AWAIT: check extractEpoch === chatEpoch
    → POST-AWAIT: check message.swipe_id === swipeIdAtStart (BUG-AUDIT-CNEW01 — prevents writing notes to wrong message if user swiped during async extraction)
    → If response !== 'NOTHING_TO_NOTE':
        → message.extra.deeplore_ai_notes = response
        → chat_metadata.deeplore_ai_notepad = capNotepad(existing + response)
    → finally: setNotepadExtractInProgress(false)
```

### Fallback (CHARACTER_MESSAGE_RENDERED)
Tag-mode extraction also runs inside the `CHARACTER_MESSAGE_RENDERED` handler (second `extractAiNotes()` call) to catch notes missed by GENERATION_ENDED (e.g., swipe back to a response that has unextracted `<dle-notes>`).

### Storage
- **Per-message:** `message.extra.deeplore_ai_notes` — the extracted notes for this specific message
- **Accumulated:** `chat_metadata.deeplore_ai_notepad` — all notes concatenated
- **Pinned entries:** `chat_metadata.deeplore_ai_notepad_pins` — array of normalized line keys (see `normalizeNotepadLine()` in `src/helpers.js`). Pinned lines survive both cap passes below.

### Cap function `capNotepad(text, opts?)` (#25)

Applied at every append site. Two passes in order:

1. **Entry-count FIFO** — when `settings.aiNotepadMaxEntries > 0` (default 50), oldest non-pinned lines are dropped first until the line count is at or below the cap. Pinned lines (matched by normalized key against `deeplore_ai_notepad_pins`) are skipped even when they are the oldest, so pin = sticky.
2. **64KB char backstop** (`AI_NOTEPAD_MAX_CHARS`) — kept as a hard ceiling so a single pathologically large note can't blow up chat metadata. Trims oldest block at paragraph boundary (`\n\n`).

`opts.settings` and `opts.chat_metadata` are accepted for test isolation; production callers pass `text` only.

### Manual fuzzy dedup

The AI Notepad popup exposes a `Deduplicate` button that walks lines in order and drops later entries whose `normalizeNotepadLine()` key matches an earlier kept line OR whose bigram-Dice similarity (`bigramDiceSimilarity()` in `src/helpers.js`) meets `settings.aiNotepadFuzzyDedupThreshold` (default 0.85). If an incoming line is pinned and the existing match is not, the pin wins — pinned text replaces the kept slot. Deterministic, no LLM dependency. LLM-driven culling is deferred past 2.5 by design.

### Swipe Rollback (BUG-290)
On `MESSAGE_SWIPED` handler (`_registerEs(event_types.MESSAGE_SWIPED, ...)` — notepad rollback block using `lastIndexOf(anchored)`): Removes the **last occurrence** of the swiped message's notes from `deeplore_ai_notepad`, anchored on `'\n' + notes`. Uses `lastIndexOf` (not first `replace`) to avoid removing an earlier message's identical notes.

Same rollback pattern in `MESSAGE_DELETED`, `MESSAGE_SWIPE_DELETED`, and `MESSAGE_EDITED` handlers.

---

## 3. Author's Notebook

**Source:** `index.js` — Author's Notebook injection block inside `onGenerate()` (reads `chat_metadata.deeplore_notebook`, calls `_injectAuxPrompt('deeplore_notebook', ...)`)

Simple user-written per-chat notes. Stored in `chat_metadata.deeplore_notebook`.

Injected as auxiliary prompt via `_injectAuxPrompt('deeplore_notebook', content, position, depth, role)` during onGenerate commit phase. No AI involvement — purely user content.

---

## 4. Auto-Suggest (Auto Lorebook)

**Source:** `src/ai/auto-suggest.js`

**Trigger:** Counter block inside `CHARACTER_MESSAGE_RENDERED` handler (`setAutoSuggestMessageCount(autoSuggestMessageCount + 1)` path). Increments `autoSuggestMessageCount` each render. When count reaches `settings.autoSuggestInterval`, resets counter and fires `runAutoSuggest()`.

**Flow:**
```
→ runAutoSuggest()
    → Build context from recent chat
    → callAutoSuggest(systemPrompt, userMessage, 'autoSuggest')
       (2-mode routing: st / profile — proxy dead-headed v2.5, see ai-subsystem.md §8)
    → Parse response into entry suggestions
    → Return suggestions array
→ showSuggestionPopup(suggestions)
    → Modal with suggested entries for user review
```

**Connection routing:** Auto-suggest has its own `callAutoSuggest()` function (`src/ai/auto-suggest.js:28`) with independent routing and circuit breaker integration — it does NOT call `callAI()` directly (it dispatches `st` mode via `generateQuietPrompt`, `profile` mode via `callAI`). **Custom Proxy mode was removed in v2.5:** the dispatch whitelist is now `st` and `profile` only; a legacy `'proxy'` value falls through to the `Unknown auto-suggest connection mode` throw at `auto-suggest.js:99`. Mirrors the same dead-head in `scribe.js:63` (`callScribe`).

**State:** `autoSuggestMessageCount` — reset to 0 on CHAT_CHANGED.

---

## 5. Context Cartographer

**Source:** `src/ui/cartographer.js`, `index.js` — `.dle-carto` click/keydown delegation on `#chat` (`$('#chat').on('click.dle-carto keydown.dle-carto', '.mes_deeplore_sources', ...)`) and `CHARACTER_MESSAGE_RENDERED` handler's `injectSourcesButton(messageId)` block

Shows a "Sources" button on messages that had lore injected.

### Source Tagging (inside `onGenerate()` — verdict commit block)
```
writeVerdict(buildVerdict({
    trace,
    injectedSources: injectedEntries.map(e => ({ title, filename, matchedBy, priority, tokens, vaultSource })),
    chatId, msgIdx, epoch, lockEpoch,
}))
```

### Source Consumption (inside `CHARACTER_MESSAGE_RENDERED` handler)
```
→ Read current verdict via getCurrent() (verdict-store.js)
→ Check: verdict.msgIdx === messageId && verdict.epoch === chatEpoch
→ Check: verdict.injectedSources is non-empty
→ Check: message.extra._deeplore_sources_tag !== `${verdict.genId}:${verdict.ts}` (double-attach guard)
→ Store verdict.injectedSources on message.extra.deeplore_sources
→ Set message.extra._deeplore_sources_tag for next-swipe idempotency
→ saveMetadataDebounced()
→ injectSourcesButton(messageId)
```

### Click Delegation
Namespaced as `.dle-carto` on `#chat` for clean teardown. Handles `click` and `keydown` (Enter/Space for a11y). Opens `showSourcesPopup(sources, { aiNotes })`.

### Diff Display
Cartographer's "Since last gen" diff is computed via `diffVerdicts(getCurrent(), getPrevious())` (in `src/verdict/verdict-pure.js`). The ring buffer naturally provides the previous turn's verdict — no separate `previousSources` global needed.

**Verdict store** replaces the four legacy globals (`lastInjectionSources`, `lastPipelineTrace`, `previousSources`, `lastInjectionEpoch`). See `docs/gotchas.md` #46 for the full migration rationale.

---

## 6. Relationship Graph

**Source:** `src/graph/graph.js` (orchestrator), `graph-physics.js`, `graph-render.js`, `graph-events.js`, `graph-focus.js`, `graph-analysis.js`, `graph-settings.js`

Custom Canvas-based force-directed graph visualization (no external library).

**Data source:** `mentionWeights` (cross-entry content mentions used for edge weight) + `resolvedLinks` + `requires` + `excludes` + `cascadeLinks` from vault entries. Four edge types: `link`, `requires`, `excludes`, `cascade`.

**Node colors:** Default mode is type-based (constant = orange `#ff9800`, seed = blue, bootstrap = purple, regular = green). Also supports priority, centrality, frequency, community, and custom-field color modes.

**Docked legend panel (v2.6):** the two former legends (edge-type toggles + node color key) are now ONE docked panel anchored top-left over the canvas: `.dle-graph-legend-panel` / `#dle-graph-legend` (built in `graph.js`), with a heading and two labeled sections — **Edges** (click-to-toggle, unchanged handler) and **Node color key** (`#dle-graph-color-legend`). The color key NO LONGER lives in the bottom node-info/tooltip bar and is NOT cleared on node hover (it was previously overwritten by node info on hover — `graph-render.js` f055); it refreshes only on color-mode change via `gs.updateColorLegend()`, painted once on init. The whole Graph view is localized (`dle_graph_*` keys). The ST-free pure modules (`graph-render` / `graph-analysis` / `graph-dag` / `graph-health`) localize via runtime `gs._t` / `gs._tf` / `gs._tp` helpers injected by `graph.js` with English fallbacks — they intentionally do NOT import `i18n.js`, which would break the Node tests in `test/unit.mjs` / health / dag suites that import them.

**Physics:** ForceAtlas2-like repulsion model with configurable parameters.

**Layout modes (`gs.layoutMode`, v2.5):** Toolbar "Layout" select switches `force` (default — physics) ↔ `dag` (Layered DAG). `gs.layoutMode ∈ {force, focus, dag}` is the single discriminant — `graph-physics.js` `simulate()` early-returns unless `layoutMode === 'force'`, freezing the sim for every non-force layout. Non-force layouts stage deterministic positions on `_targetX/_targetY` and lerp in via `lerpEgoPositions` (the focus-tree rig). **Layered DAG** (`graph-dag.js`) uses only `requires`+`cascade` edges: hand-rolled Sugiyama-lite (DFS cycle-break → longest-path layering → deterministic ordering), top→down with directional arrowheads, non-participants hidden. Enter/exit snapshot then restore positions, `edgeVisibility`, `cachedVisibleCount`, and the hidden/reveal formula exactly (mirrors `enterFocusTree`/`exitFocusTree`). Deterministic layouts are NEVER persisted to `graphSavedLayout`. See gotcha #71.

**Focus Tree (ego mode):** Double-click a node to enter. BFS from that root to `graphFocusTreeDepth` hops (default 2), hides everything outside the neighborhood, lays survivors out as a radial tree, and freezes the force sim. Depth is adjustable live via the +/- hop controls.

**Full structural adjacency is memoized on `gs._fullAdj` (L4, 2026-05-29)** via `gs.getFullAdj()` (`src/graph/graph.js`). Built once per popup over ALL `nodes`+`edges`, ignoring `edgeVisibility`. Consumed by `bfsDepth` (`graph-focus.js`) and the Reset-handler radial layout (`graph-events.js`) — both need the structural neighborhood, not the visible-edge subgraph. Invalidation is edge-set mutation only, which never happens: `gs.edges` is immutable for the lifetime of `gs`, and a new popup builds a fresh `gs` with `_fullAdj = null`. Contrast `gs.buildAdjacency()`/`gs.adjacency`, the visibility-filtered adjacency rebuilt on every legend toggle — it deliberately leaves `_fullAdj` alone.

**Hover reach/dim:** Separate from Focus Tree. On hover, BFS reaches `graphHoverDimDistance` hops (default 3) and dims everything beyond. Per-hop alpha falloff is `graphHoverFalloff` (transmission per hop — `E[d] = t^d`).

**Vault Health / World Doctor (`graph-health.js`, v2.5):** "Health" toolbar button toggles a **JS-created floating side panel** — NOT part of the graph container HTML; created on demand, fixed top-right side view, removed on close. Surfaces structural problems by severity: 🔴 broken refs / contradictory gating / circular requires, 🟠 orphans, 🟡 over-constant budget / thin hubs / token-bloat (percentile, not a flat cutoff). Flagged nodes get severity-colored rings on canvas (`gs.healthActive` + `gs.healthFlagged`, keyed by node id). Clicking a finding centers on the culprit. Detectors are pure (`detect*`, unit-tested). Conceptually supersedes "Find Gaps"; both currently coexist.

**Exit key:** `e` (NOT Escape). Escape bubbles to ST popup which would close the graph modal. See `reference_dialog_escape.md` in memory.

**`graph: false` frontmatter field:** Excludes entry from graph entirely.

**Note:** Graph was declared "complete" at v0.2.0, but **v2.5 reopened it** for view modes (Layout selector, Layered DAG, Vault Health) — see `audit/v2.5-graph-views/PLAN.md` and gotcha #71. The old "do not refactor" note (`project_graph_complete.md` in memory) is superseded for v2.5 view-mode work.

---

## 6b. Drawer Browse actions & footer diagnostics dock (v2.6, affordance-only)

**Browse entry actions kebab:** the per-row pin/block/copy actions in the Browse tab are now a hover-reveal cluster behind a `⋮` kebab (`.dle-browse-kebab` inside `.dle-browse-actions`, built in `drawer-render-tabs.js`). Status readouts stay visible; the kebab folds away the action buttons so the row reads calm by default. Pin/block-active rows force the cluster open via `dle-actions-pinned-open` (computed at render). The kebab handler (`drawer-events.js`) toggles `dle-actions-open` on the LIVE DOM node only (and closes any other open cluster first) — it never mutates `ds.browseRowModel`, preserving gotcha #13 (the row model is render-derived, never mutated from event handlers).

**Footer diagnostics dock:** the five footer health icons (vault / connection / pipeline / cache / ai) are now framed as a labeled "diagnostics dock" (`.dle-diag-dock` with a `.dle-diag-dock-label` in `drawer.html`). This is framing/affordance only — the click handlers were already wired in `wireHealthIcons` (`drawer-events.js`) and are unchanged.

---

## 7. Diagnostics

**Source:** `src/diagnostics/`

### boot.js
First import in `index.js` (`import './src/diagnostics/boot.js';` at top of file, before any other DLE imports). Installs console/fetch/XHR/error interceptors and starts PerformanceObserver (long-task tracking) at **module-eval time** so DLE captures cold-start bugs in itself and other extensions. This runs before any other DLE code.

### flight-recorder.js
Ring buffer of per-generation event summaries (`generationBuffer`, size **50** — increased from 20). Started via `startFlightRecorder()` imported and called near the end of `init()`. Records pipeline runs, AI calls, errors, aborts. Used by `/dle-diagnostics` export.

**`recordAbort(msg)`** — dynamically imported and called from `onGenerate()`'s catch block on user abort.

**Boot marker:** `{ kind: 'recorder_started' }` pushed on init.

**Additional flight recorder entry types:**
- `{ skipped: true, reason: 'stepped_thinking' }` — generation skipped because a Stepped Thinking pass is in flight (`index.js:690`)
- `{ skipped: true, reason: 'lock_contention' }` — generation skipped because another pipeline holds the lock (< 30s)
- `{ skipped: true, reason: 'tool_call_continuation' }` — generation skipped because last message has `tool_invocations` (from other extensions using ST's ToolManager)
- `{ forceRelease: true, lockAgeMs, oldEpoch, newEpoch }` — stale lock force-released after 30s
- `{ discarded: true, reason: 'chat_changed_during_index' }` — pipeline bailed during `ensureIndexFresh`
- `{ discarded: true, reason: 'stale_pipeline_tracking_skipped' }` — post-commit tracking skipped due to epoch mismatch
- `{ lockReleaseBlocked: true, reason: 'epoch_mismatch' }` — stale pipeline's `finally` skipped lock release

### state-snapshot.js
`captureStateSnapshot()` — Returns sanitized copy of all state variables for diagnostic export. Removes sensitive data (API keys) via `scrubber.js`.

**Additional snapshot fields:**
- `snap.vault`: +`buildPromiseActive`, `buildEpoch`, `syncActive`, `folderDistribution`
- `snap.pipeline`: +`lastScribeChatLength`, `hasLastScribeSummary`, `perSwipeInjectedKeysCount`, `verdict` (`{genId, msgIdx, epoch, lockEpoch, ts, injectedSourceCount, perEntryCount, epochMatchesChatEpoch, trace}` or null), `verdictRingDepth`
- `snap.staleness`: +`capturedDuringIndexBuild`
- `snap.registeredPrompts` — actual DLE `extension_prompts` metadata (what's currently registered with ST)
- `snap.gatingContext` — active era/location/scene/character values (pseudonymized via `scrubber.js`)

**Pseudonymization:** `pseudonymizeTrace()` now also pseudonymizes `matchedBy` fields and scrubs AI `reason` strings from pipeline trace data.

### performance.js
`startPerformanceObservers()` — installs a `PerformanceObserver` for long tasks (>50ms) into a ring buffer (`longTaskBuffer`). Called from `boot.js` at module-eval time. `captureMemorySnapshot()` — one-shot snapshot of `performance.memory` + navigation timing, included in diagnostic exports.

### interceptors.js / ring-buffer.js
Support infrastructure for the diagnostics system. Console interceptor monkey-patches all five levels (`log`, `warn`, `error`, `debug`, `info`) from all extensions (not just DLE) into `consoleBuffer`. Network interceptor patches `fetch` and `XHR` into `networkBuffer`. Error interceptor captures `window.onerror` and `unhandledrejection` into `errorBuffer`. Ring buffer (`RingBuffer`) keeps last N entries per buffer (fixed-size, oldest evicted on overflow).

**Additional buffers and exports:**
- **`eventBuffer`** (RingBuffer 100): Lifecycle event log. Tracks `chat_changed`, `ai_circuit`, `obsidian_circuit`, `index_build`, `init`, `teardown`, `cache_save`, `cache_load`, `scribe`, `enabled` events with timestamps.
- **`aiCallBuffer`** (RingBuffer 20): Per-AI-call recording. Each entry captures: `caller`, `mode`, `model`, `systemLen`, `userLen`, `timeoutMs`, `durationMs`, `status`, `responseLen`, `tokens`, `error`.
- **`pushEvent(kind, data)`**: Exported function for pushing lifecycle events to `eventBuffer`. Called throughout the codebase (circuit breaker transitions, vault operations, scribe, cache save/load).
- **`installFailures[]`**: Tracks which interceptors failed to install during boot. Included in diagnostic exports.
- **Console `dle` flag**: Console entries carry a `dle: true` flag when the message starts with `[DLE`, enabling the export to split DLE-only vs global console logs.
- **Network `errorBody`**: Network entries capture `errorBody` (first 500 chars of response body) for non-2xx responses.

### scrubber.js
`scrubDeep(value)` — Recursively walks a value and returns a scrubbed deep copy. Masks API keys (field-name matching via `SENSITIVE_KEY_RE`), auth tokens, IPs, emails, hostnames, user paths, and high-entropy token strings. Cardinality-preserving pseudonyms (same real value → same alias within one export). `scrubString(str, ctx)` handles individual string scrubbing.

**`SENSITIVE_KEY_RE` expanded**: Now also matches `helicone_auth`, `cf_access`, `credential`, and `webhook` in addition to the original patterns.

### ui.js (`src/diagnostics/ui.js`)
User-facing entry point: `triggerDiagnosticDownload()` (`src/diagnostics/ui.js:26`) builds the anonymized report + unanonymized reference file and triggers browser download via ephemeral `<a>` element.

### Health check & `diagnoseEntry()` (`src/ui/diagnostics.js` — NOT `src/diagnostics/ui.js`)

`runHealthCheck()` (`src/ui/diagnostics.js:23`) and `diagnoseEntry()` (`src/ui/diagnostics.js:287`) live in `src/ui/diagnostics.js`, a distinct file from the export entry point above. The health check uses `vaultIndex` throughout (`diagnostics.js:77,83,96,151`); an earlier bug where an excludes check referenced an undefined `entries` is fixed in current code.

**`diagnoseEntry()`** reports per-stage exclusion reasons including: `guide_entry` (entry is guide-only), `folder_filter` (filtered by active folder), `blocked` (per-chat block), `contextual_gating` (failed era/location/scene/character filter), `strip_dedup` (removed by strip dedup) — giving granular insight into why an entry wasn't injected.

### toast-dedup.js
`suppressedCounts` Map tracks the number of suppressed toasts per category. `getSuppressedCounts()` exported for diagnostics — included in diagnostic exports to show how often toast dedup is firing.

### export.js
`buildDiagnosticReport()` — Assembles the full diagnostic markdown report. Captures state snapshot, drains all ring buffers (console, network, error, generation, long-task), runs `scrubDeep()`, compresses via gzip, and encodes as base64 data block.

**Export format v2** (`dle-diagnostic-v2`): The verbose diagnostic blob now includes `eventLog` (from `eventBuffer`), `aiCallLog` (from `aiCallBuffer`), `globalConsoleLog` (non-DLE console entries, last 100), and `interceptorInstallFailures`. Console logs are split into `consoleLog` (DLE-only, entries with `dle: true`) and `globalConsoleLog` (everything else, capped at 100).

### Generation Correlation ID (`genId`)
Each generation gets a 6-char correlation ID (`Math.random().toString(36).slice(2, 8)`) created in `onGenerate()`. Threaded to the pipeline trace via `runPipeline()` options, copied by `summarizeTrace()` into flight recorder entries, and included in diagnostic export human-readable per-generation lines. Enables correlating log entries, trace data, and flight recorder records back to a single generation.

### Per-Stage Timing on Trace
10 `*Ms` timing fields on the pipeline trace, each measuring wall-clock duration of the corresponding stage:

`ensureIndexFreshMs`, `pinBlockMs`, `contextualGatingMs`, `reinjectionCooldownMs`, `requiresExcludesMs`, `stripDedupMs`, `formatGroupMs`, `trackGenerationMs`, `recordAnalyticsMs`, `perChatCountsMs`

Visible in `/dle-inspect` timing section (collapsible "Stage Timing" table with per-stage ms and total) and included in diagnostic export trace data.

### Additional pushEvent Kinds
Beyond the existing `init`, `obsidian_circuit`, `search_mode`, `cache_save`, `cache_load`, `scribe`, `enabled`, etc.:

- **`librarian`** — `start`, `completed`, `error`
- **`scribe`** — `start` (supplements existing completion event)
- **`ai_notepad`** — `tag_extracted`, `extract_start`, `extract_completed`, `extract_error`, `extract_empty`
- **`auto_suggest`** — `start`, `completed`
- **`drawer`** — `open`, `close`

### Slash Commands (Diagnostics)
- **`/dle-debug [on|off]`** — Toggle debug mode. No argument = toggle current state. Persists to settings.
- **`/dle-logs [N]`** — Show last N DLE console entries (default 50, max 500). Filters `consoleBuffer` for entries with `dle: true` flag. Displays in popup with copy button.

### `globalThis.__DLE_DEBUG` Namespace
Read-only object created on `init()`. Three getters (no setters):

- **`.state`** — snapshot of key state variables: `vaultIndex`, `generationCount`, `chatEpoch`, `generationLock`, `cooldownTracker`, etc.
- **`.trace`** — returns `getCurrentVerdict()?.trace ?? null`
- **`.verdict`** — returns the current verdict record (genId, msgIdx, epoch, injectedSources, trace, perEntry)
- **`.buffers`** — returns `.drain()` of all 7 ring buffers (`index.js:2783`): `console`, `network` (scrubbed via `scrubDeep` at this read surface — #12), `errors`, `aiCalls`, `aiPrompts` (PII-sensitive, only populated when debugMode=true), `events`, `generations`

For browser console debugging. Read-only — mutations have no effect on DLE state. Installed/torn down by a `debugMode` observer (`installDebugNamespace`, `index.js:2763`): turning debugMode off deletes `__DLE_DEBUG` and clears `aiPromptBuffer` so captured prompts can't be re-exposed.

### `/dle-inspect` Timing Section
Now shows `genId` at the top of the trace view. When timing data is present on the trace, displays a collapsible "Stage Timing" table listing each `*Ms` field with its value and a total row. Collapsed by default to keep the inspect view compact.
