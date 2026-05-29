# AI Subsystem Internals

Code-level reference for the DLE AI subsystem. For pipeline flow see `CLAUDE.md`; for generation ordering see `docs/generation-pipeline.md`.

> **DEPRECATED v2.5 — Custom Proxy connection mode**: Proxy mode (`mode === 'proxy'`, direct Anthropic Messages API via ST's CORS bridge to claude-code-proxy) was dead-headed in v2.5. `callAI()` dispatch throws `"Custom Proxy mode was removed in v2.5..."` when invoked with `'proxy'`. Code paths in this doc (proxy-api.js, `callProxyViaCorsBridge`, proxy branches in the agentic API, proxy-related cache key fields, etc.) are preserved for rollback safety and remain documented below. The UI is hidden. Users with `*ConnectionMode === 'proxy'` are migrated to `'profile'` on boot (settingsVersion 3→4) and shown a one-shot popup. **Connection Profile (CMRS) is the only supported path.** See `docs/gotchas.md` #68 for migration semantics, rollback path, and test coverage.

Source files: `src/ai/ai.js`, `src/ai/manifest.js`, `src/ai/proxy-api.js` (`@deprecated v2.5` — kept for rollback), `src/ai/claude-adaptive-check.js`, `src/ai/models.js`, `settings.js` (`resolveConnectionConfig()` + `TOOL_SETTINGS_KEYS`), `src/state.js` (circuit breaker state + `recordAiFailure`/`recordAiSuccess`/`isAiCircuitOpen`/`tryAcquireHalfOpenProbe`/`releaseHalfOpenProbe`), `src/helpers.js` (`extractAiResponseClient`/`normalizeResults`/`clusterEntries`/`buildCategoryManifest`), `src/librarian/agentic-api.js` (agentic loop API layer).

---

## 1. Connection Routing

### `resolveConnectionConfig(toolKey)` -- settings.js

Central dispatch that resolves any feature's AI connection settings into a uniform config object. Eliminates per-caller if/else routing.

```js
// settings.js: TOOL_SETTINGS_KEYS constant
const TOOL_SETTINGS_KEYS = {
    aiSearch:     { mode, profileId, proxyUrl, model, maxTokens, timeout },
    scribe:       { ... },
    autoSuggest:  { ... },
    aiNotepad:    { ... },
    librarian:    { ... },   // note: maxTokens key is 'librarianSessionMaxTokens'
    optimizeKeys: { ... },
};

// Returns: { mode, profileId, proxyUrl, model, maxTokens, timeout }
resolveConnectionConfig(toolKey) -> config
```

**Inherit fallback** (in `resolveConnectionConfig()`): When a tool's mode is `'inherit'` and `toolKey !== 'aiSearch'`, mode and profileId resolve from AI Search's settings. Model and proxyUrl cascade: tool's own value if set, else AI Search's. `maxTokens` and `timeout` always come from the tool's own settings (never inherited). **v2.5:** inherit still works as a chain, but the resolved mode can no longer BE `'proxy'` — aiSearch's mode is forced to `'profile'` by migration (gotcha #68), so the inherit chain always lands on profile.

**Gotchas:**
- AI Search itself cannot inherit (it IS the root). If `aiSearchConnectionMode === 'inherit'`, that value flows through unchanged -- callers treat it as the literal mode string.
- `librarianConnectionMode` must NOT share with retrieval (per user feedback). Don't collapse them. The `librarian` connection config is used by the agentic loop (in proxy mode — DEPRECATED v2.5, see gotcha #68) and by Emma's chat session (the review popup).
- **DEPRECATED v2.5:** When `mode === 'inherit'` resolves to `'proxy'`, the proxyUrl falls back to `toolProxyUrl || aiSearch.proxyUrl` -- but when mode is NOT inherit, proxyUrl falls back to `toolProxyUrl || defaultSettings[keys.proxyUrl]` (in `resolveConnectionConfig()`). These are different fallback chains. (Both paths now unreachable in production code because proxy mode is dead-headed; preserved for rollback.)

### Agentic Loop Connection -- agentic-api.js

> **DEPRECATED v2.5**: Custom Proxy mode dead-headed. Dispatch throws `"Custom Proxy mode was removed in v2.5..."`. Code paths preserved for rollback. UI hidden. Users with `librarianConnectionMode: 'proxy'` are migrated to `'profile'` on boot (settingsVersion 3→4) and shown a one-shot popup. See gotcha #68.

The Librarian's agentic generation loop uses a **separate API path** from `callAI()`. `callWithTools()` in `agentic-api.js` dispatches based on the resolved Librarian connection mode:

- ~~**Proxy mode** (`resolveConnectionConfig('librarian').mode === 'proxy'`): calls `callWithToolsViaProxy()`, which sends directly to an Anthropic-compatible proxy via ST's CORS bridge (`/proxy/` endpoint). Tools are converted from OpenAI to Anthropic format. System messages are extracted into the `system` field. `isToolCallingSupported()` returns true, `getProviderFormat()` returns `'claude'`, and `getActiveMaxTokens()` uses the Librarian's configured maxTokens.~~ **DEPRECATED v2.5** — dispatch throws. The four call sites in `agentic-api.js` still exist (rollback-safe) but are unreachable in production.
- **Profile mode** (default and only supported path as of v2.5): calls `ConnectionManagerRequestService.sendRequest()` using the Librarian's own configured profile (`connConfig.profileId`, resolved from `librarianProfileId` or — if mode is `inherit` — the aiSearch profile). NOT the globally-active main-chat profile. Unset profile throws hard error rather than silently inheriting active (#27 sym 2).

The Librarian profile setting (`librarianConnectionMode`, `librarianProfileId`, etc.) is also used by Emma's conversation loop in `librarian-session.js` (the review popup).

**Underlying-Claude detection vs format detection.** `getProviderFormat()` keys off `oai_settings.chat_completion_source` only — for OpenRouter it returns `'openai'` even when the routed model is `anthropic/claude-3.5-sonnet`. This is correct for response parsing (OR returns OpenAI-shape responses regardless of upstream provider). But Claude-specific REQUEST mitigations (the `reasoning_effort: 'auto'` override that disables thinking-vs-tool_choice 400; the `json_schema` skip in `ai.js`) must fire for OR-Claude too. Use `isUnderlyingClaude(model?)` for any decision that depends on what the model actually IS rather than how the response will be SHAPED. The two helpers are intentionally split: `getProviderFormat()` answers "how do I parse" and `isUnderlyingClaude()` answers "what backend will eventually run this".

### AI Call Throttle -- ai.js module-top constants

```js
let _lastAiCallTimestamp = 0;           // module-scoped, reset on chat change
const AI_CALL_MIN_INTERVAL_MS = 500;    // 500ms minimum between actual API calls
```

Enforced in `callAI()`. Cache hits and circuit-breaker skips bypass throttle (they don't make API calls). Throttle errors have `err.throttled = true` and do NOT trip the circuit breaker.

`resetAiThrottle()`: Sets `_lastAiCallTimestamp = 0`. Called on chat change to prevent cross-chat penalty.

**Critical**: Throttle timestamp is stamped on SUCCESS only (in `callAI()` — BUG-039). Failed calls don't consume the window, so immediate retries aren't blocked.

### `callAI()` -- ai.js

Unified router. All AI features call this, never `callViaProfile`/`callProxyViaCorsBridge` directly.

```js
callAI(systemPrompt, userMessage, connectionConfig) -> {text, usage}
// connectionConfig: { mode, profileId, proxyUrl, model, maxTokens, timeout, cacheHints, signal, skipThrottle, caller }
```

Dispatches to `callViaProfile()` when `mode === 'profile'`, or ~~`callProxyViaCorsBridge()` when `mode === 'proxy'`~~ **(DEPRECATED v2.5 — throws `"Custom Proxy mode was removed in v2.5..."`)**. Proxy mode default model `'claude-haiku-4-5-20251001'` is dead code retained for rollback. See gotcha #68.

**Dispatch is an explicit whitelist** (AI-M3, 2026-05-22): the dispatch is `if (mode === 'profile') ... else if (mode === 'proxy') throw ... else throw`. `'inherit'` MUST be resolved by `resolveConnectionConfig` upstream — `callAI` throws loudly if it ever sees `'inherit'` or any other unknown value rather than silently falling through to the proxy branch with an empty `proxyUrl` (which would trip the circuit breaker on the second call). If you add a new mode, extend the whitelist explicitly — never widen the `else` branch. **v2.5 update:** the `'proxy'` branch now throws unconditionally (was: call `callProxyViaCorsBridge()`); the rollback path restores the dispatch.

**`caller` label**: All callers now pass a `caller` string (e.g. `'aiSearch'`, `'scribe'`, `'autoSuggest'`, `'hierarchicalPreFilter'`, `'aiNotepad'`, `'optimizeKeys'`). This label is recorded in the `aiCallBuffer` for per-call diagnostics.

**`aiCallBuffer` recording**: `callAI()` wraps the actual dispatch in a recording layer that pushes to the `aiCallBuffer` (RingBuffer 40 in `src/diagnostics/interceptors.js`). Each entry captures: `caller`, `mode`, `model`, `systemLen` (system prompt length), `userLen` (user message length), `timeoutMs`, `durationMs`, `status` (success/error/timeout/abort), `responseLen`, `tokens` (usage object), `error` (truncated error message on failure), `abortReason` (string|null — populated when call ended via abort; identifies source, e.g. `'ai:timeout'`, `'popup_closing'`, `'controller_replace'`).

**Abort attribution**: All `.abort()` calls in DLE go through `abortWith(controller, reason)` (in `src/diagnostics/interceptors.js`). The reason rides on native `signal.reason` as a `DOMException`. Catch blocks read `controller.signal.reason?.message` AND `externalSignal?.reason?.message` and pick whichever is non-empty (controller wins) — written to `aiCallBuffer.abortReason` and `aiPromptBuffer.abortReason`. Direct `controller.abort()` loses post-mortem attribution.

`skipThrottle: true` is used by `hierarchicalPreFilter` which chains with `aiSearch` -- both calls in one generation must not throttle each other.

---

## 2. AI Search

### `aiSearch()` -- ai.js

```js
aiSearch(chat, candidateManifest, candidateHeader, snapshot, candidateEntries, signal)
  -> { results: AiSearchMatch[], error: boolean, errorMessage?: string }
```

**Timeout:** the call passes `timeout: settings.aiSearchTimeout` (`ai.js:895`), default **20000ms** (`settings.js:100`, validation range `{min:1000, max:999999}` at `settings.js:350`). The 500ms throttle is separate — see AI Call Throttle above.

**State read:** `vaultIndex`, `aiSearchCache`, `aiSearchStats`, `entityNameSet`, `entityShortNameRegexes`, `entityRegexVersion`, `lastScribeSummary`, `decayTracker`, `consecutiveInjections`.
**State written:** `aiSearchCache` (via `setAiSearchCache`), `aiSearchStats` (mutated in-place).
**Dependencies:** `getSettings()`, `buildAiChatContext()`, `simpleHash()`, `callAI()`, `extractAiResponseClient()`, `normalizeResults()`, `fuzzyTitleMatch()`.

**Flow** (all steps inside `aiSearch()`):

1. Guard: bail if `!aiSearchEnabled` or empty manifest
2. Strip trailing assistant message from chat for cache stability (BUG-CACHE-FIX)
3. Build `chatContext` from `buildAiChatContext(chatForCache, scanDepth)`
4. Prepend seed entries on new chats
5. Append scribe summary if `scribeInformedRetrieval` is on
6. **Cache check** (see sliding window below) -- hits return without acquiring the probe so a half-open circuit isn't pinned by cached returns
7. Circuit breaker: `tryAcquireHalfOpenProbe()` -- blocks if breaker is open. Acquired only on cache miss, just before the AI call
8. Build system prompt with `{{maxEntries}}` substitution
9. Build user message: manifest info + manifest + chat context
10. Proxy mode: split into cacheHints `{stablePrefix, dynamicSuffix}`
11. `callAI()`
12. Parse response via `extractAiResponseClient()`
13. Handle object-shaped responses -- unwrap `{results: [...]}` etc.
14. `normalizeResults()` -- zero usable items from non-empty array trips breaker
15. Exact title match against `candidateEntries`
16. Fuzzy match unmatched titles via `fuzzyTitleMatch()`
17. Sort by confidence tier: high > medium > low
18. Confidence threshold filter -- `aiConfidenceThreshold` setting
19. Cache results and `recordAiSuccess()`

**Error handling** (catch block in `aiSearch()`): Classifies errors into categories that determine circuit breaker behavior:
- **User abort** (`err.userAborted === true`): no breaker trip, silent
- **Timeout** (`err.timedOut === true`): no breaker trip, warning logged
- **Throttle** (`err.throttled`): no breaker trip, debug-only
- **Rate limit** (429 / message match): no breaker trip, user warning
- **Auth error** (401/403): no breaker trip, user error toast
- **Everything else**: `recordAiFailure()` -- trips breaker after 2 consecutive

### Sliding Window Cache -- ai.js (inside `aiSearch()`)

Cache key components (concatenated into `settingsKey`, then hashed with the manifest to form `manifestHash`):

| Component | Source | Why it's in the key |
|---|---|---|
| `CACHE_SHAPE_VERSION` | const `'v2'` in `aiSearch()` | Bump invalidates old caches on shape changes |
| `aiSearchMode` | settings | Two-stage vs ai-only vs keywords-only |
| `aiSearchScanDepth` | settings | Chat window size feeding the AI |
| `maxEntries` | settings | Target selection count |
| `unlimitedEntries` | settings | Disables fill-to-N |
| `promptHash` | `simpleHash(aiSearchSystemPrompt)` | BUG-020: prompt content edits |
| `aiSearchConnectionMode` | settings | profile vs proxy routing |
| `aiSearchProfileId` | settings | Profile mode endpoint |
| `aiSearchModel` | settings | Model selection |
| `aiSearchProxyUrl` | settings | AI M2: proxy endpoint URL (proxy mode) — without it, switching endpoint serves the prior endpoint's results |
| `aiSearchMaxTokens` | settings | AI M2: response cap — lower cap can truncate ranking; without it, a tighter cap silently reuses the looser-cap call |
| `aiConfidenceThreshold` | settings, default `'low'` | BUG-019: filter threshold |
| `manifestSummaryMode` | settings, default `'prefer_summary'` | BUG-021 |
| `aiSearchManifestSummaryLength` | settings, default `600` | BUG-021 |

```js
// in aiSearch()
const settingsKey = `${CACHE_SHAPE_VERSION}|${aiSearchMode}|${scanDepth}|${maxEntries}|${unlimitedEntries}|${promptHash}|${connectionMode}|${profileId}|${model}|${proxyUrl}|${maxTokens}|${confidenceThreshold}|${manifestSummaryMode}|${summaryLength}`;
const manifestHash = simpleHash(settingsKey + candidateManifest);
```

Four cache-hit paths, checked in order (all in `aiSearch()`):

1. **Exact match**: `chatHash === cached.hash && manifestHash === cached.manifestHash`. Catches identical re-runs.

2. **Keyword-stable hit**: Manifest unchanged, current `candidateEntries` titles are a subset of `cached.matchedEntrySet`. Catches typo fixes, "ok continue", reaction messages. Skipped in `ai-only` mode.

3. **Swipe/regen safety net**: Manifest unchanged, chat line count <= cached count. After trailing-assistant strip, swipe/regen should hit exact match -- this is a defensive fallback.

4. **Sliding window**: Manifest unchanged, chat grew (new lines only). Scans new lines against `entityNameSet` using pre-compiled word-boundary regexes from `entityShortNameRegexes`. Cache valid if no new entity mentions. **Skipped when `entityRegexVersion` differs from cached version** (BUG-394 -- post-rebuild staleness).

**Cache writes** (in `aiSearch()`): Stores `{hash, manifestHash, chatLineCount, results[], matchedEntrySet, entityRegexVersion}` via `setAiSearchCache()`.

`resolveCachedResults()` (local helper inside `aiSearch()`): Replays cached title-based results against `candidateEntries` (not full `vaultIndex`) to prevent blocked/gated entries from leaking through (BUG-382).

### Response Parsing

**`extractAiResponseClient(text)`** -- helpers.js

Tries three strategies in order (all inside `extractAiResponseClient()`):
1. Direct `JSON.parse()`
2. Markdown code fence extraction via regex
3. Bracket-balanced JSON array extraction with string-awareness -- sorts candidates largest-first, tries each

All candidates are validated via `isValidResultArray()` (inner helper in `extractAiResponseClient()`): must be an array where at least one element is a string or an object with `.title` or `.name`.

**`normalizeResults(arr)`** -- helpers.js

Maps raw parsed items to `{title, confidence, reason}` objects. Rejects non-string/non-object items (BUG-391 -- prevents `42` or `[object Object]` becoming fake titles). Filters out null/empty/`"null"`/`"undefined"` titles.

**`fuzzyTitleMatch(aiTitle, candidateTitles, threshold=0.6)`** -- helpers.js

Bigram Dice coefficient similarity. Returns `{title, similarity}` for best match above threshold, or null.

---

## 3. Hierarchical Pre-Filter

### `hierarchicalPreFilter(candidates, chat, signal)` -- ai.js

Two-phase AI search for large vaults. Called from the pipeline before `aiSearch()`.

```
HIERARCHICAL_THRESHOLD = 40  // ai.js: module-top const
AI_PREFILTER_MAX_TOKENS = 512  // ai.js: module-top const
```

**Trigger conditions** (in `hierarchicalPreFilter()`):
- Selectable entries (non-force-injected) >= 40
- Cluster count > 3
- In `summary_only` mode, entries without summaries are excluded before counting (BUG-387)

**Flow** (all steps inside `hierarchicalPreFilter()`):

1. Filter out force-injected entries, apply summary_only filter
2. `clusterEntries(selectable)` -> `Map<category, entries[]>` (helpers.js:`clusterEntries()`)
3. Skip if < 40 selectable or <= 3 clusters
4. `buildCategoryManifest(clusters)` -> compact text (helpers.js:`buildCategoryManifest()`)
5. `tryAcquireHalfOpenProbe()` -- blocks if circuit breaker open
6. `callAI()` with `skipThrottle: true`
7. Parse categories via `extractAiResponseClient()`
8. Handle object wrappers: `{categories: [...]}`, `{labels: [...]}`, etc.
9. Filter candidates to selected categories
10. Re-include force-injected entries
11. Aggressiveness check: if filtering removed > `(1 - hierarchicalAggressiveness)` fraction, return null
12. `releaseHalfOpenProbe()` -- does NOT record success/failure

**`clusterEntries(entries)`** -- helpers.js

Clusters by first non-infrastructure tag. `LOREBOOK_INFRA_TAGS` (helpers.js: module-top const) contains `lorebook`, `lorebook-always`, `lorebook-seed`, `lorebook-bootstrap`, `lorebook-guide`, `lorebook-never`, `lorebook-constant`. These are skipped when picking the clustering tag because WI imports put `lorebook` on everything (BUG-384). Falls back to top folder from filename, then `'Uncategorized'`.

**`buildCategoryManifest(clusters)`** -- helpers.js

One line per category: `[CategoryName] (N entries): title1, title2, ... (+M more)`
Shows up to 5 sample titles per category.

**Gotchas:**
- `releaseHalfOpenProbe()` (state.js): Clears the probe flag without recording success or failure. This is intentional -- the pre-filter's outcome shouldn't affect the circuit breaker since `aiSearch()` manages its own probing independently.
- Stats: Hierarchical calls increment `aiSearchStats.totalInputTokens`/`totalOutputTokens` and `aiSearchStats.hierarchicalCalls`, but NOT `aiSearchStats.calls` (BUG-017/BUG-393). The dedicated counter prevents double-counting while keeping token averages accurate.
- On error, the probe is released (not recorded as failure) unless `err.throttled` (in `hierarchicalPreFilter()` catch block). The pre-filter returns null on any failure, falling back to single-call search.

---

## 4. Candidate Manifest

### `buildCandidateManifest(candidates, excludeBootstrap, settings)` -- manifest.js

Pure function (no SillyTavern imports). The ai.js wrapper (`buildCandidateManifest()` in ai.js) injects `getSettings()`.

```js
// Returns: { manifest: string, header: string }
```

**What's excluded:**
- Constants (`entry.constant === true`) -- via `isForceInjected()` (helpers.js:`isForceInjected()`)
- Bootstraps when `excludeBootstrap === true` (passed when chat is short enough for bootstrap injection)
- In `summary_only` mode: entries without a summary field (in `buildCandidateManifest()`)

**Per-entry XML format** (in `buildCandidateManifest()`):
```xml
<entry name="EscapedTitle">
Title (TokenEstimate tok) -> link1, link2 [STALE - consider refreshing]
[Era: medieval | Location: tavern]
Summary text truncated to aiSearchManifestSummaryLength...
</entry>
```

**Summary selection** (in `buildCandidateManifest()`) controlled by `manifestSummaryMode`:
- `'prefer_summary'` (default): Use `entry.summary`, fallback to truncated content
- `'content_only'`: Always use truncated content
- `'summary_only'`: Use summary only (entries without summaries excluded upstream)

Summary truncation: `truncateToSentence(content.substring(0, summaryLen * 3), summaryLen)` where `summaryLen` defaults to `aiSearchManifestSummaryLength || 600`.

**Annotations** (all in `buildCandidateManifest()`):
- Decay hint `[STALE]` when `staleness >= decayBoostThreshold`
- Frequency hint `[FREQUENT]` when `consecutiveInjections >= decayPenaltyThreshold`
- Custom field annotations from `entry.customFields` using `fieldDefinitions` label map

**Header** (in `buildCandidateManifest()`):
```
Candidate entries: N (from M total).
K entries are always included (~T tokens).
Token budget: ~B tokens total.
```
The forced-entry count uses `candidates.length - selectable.length` (BUG-047: counts against total, not selectable). Budget line omitted when `unlimitedBudget` is true.

---

## 5. Circuit Breaker Integration

### State Machine -- state.js (circuit breaker section)

Three states:

```
CLOSED  -- aiCircuitOpen=false. All calls pass through.
OPEN    -- aiCircuitOpen=true, cooldown not expired. All calls blocked.
HALF-OPEN -- aiCircuitOpen=true, cooldown expired. One probe allowed.
```

**Constants** (state.js: module-top consts in the circuit breaker block):
```js
AI_CIRCUIT_THRESHOLD = 2       // consecutive failures to trip
AI_CIRCUIT_COOLDOWN  = 30_000  // ms before half-open probe
AI_PROBE_TIMEOUT     = 60_000  // ms before stale probe auto-resets
```

**State variables** (state.js: module-top exports/locals in the circuit breaker block):
```js
export let aiCircuitOpen = false;
export let aiCircuitFailures = 0;
export let aiCircuitOpenedAt = 0;
let aiCircuitHalfOpenProbe = false;      // not exported
let aiCircuitProbeTimestamp = 0;         // not exported
```

### `isAiCircuitOpen()` -- state.js

**Pure query. Never mutates state.** Safe for UI rendering, status checks, non-AI code paths.

Returns `true` (blocked) when:
- Circuit open AND cooldown not expired
- Circuit open AND cooldown expired AND probe is in-flight AND probe is not stale

Returns `false` (proceed) when:
- Circuit closed
- Cooldown expired, no probe dispatched (caller should use `tryAcquireHalfOpenProbe`)
- Cooldown expired, probe dispatched but stale (> 60s)

### `tryAcquireHalfOpenProbe()` -- state.js

**Mutation gate. Only call from actual AI code paths** (aiSearch, hierarchicalPreFilter).

Returns `true` if:
- Circuit closed (all pass)
- Circuit open, cooldown expired, no active probe -- acquires atomically
- Circuit open, cooldown expired, probe stale (> 60s) -- resets and re-acquires

Returns `false` if:
- Still in cooldown
- Probe already in-flight and not stale

**Caller contract**: If `tryAcquireHalfOpenProbe()` returns true and circuit was open, caller MUST eventually call `recordAiSuccess()`, `recordAiFailure()`, or `releaseHalfOpenProbe()`.

### `recordAiFailure()` -- state.js

- Clears half-open probe flag
- Increments `aiCircuitFailures`
- If failures >= threshold (2): sets `aiCircuitOpen = true`, refreshes `aiCircuitOpenedAt`
- Notifies observers on state transition CLOSED -> OPEN

### `recordAiSuccess()` -- state.js

- Clears probe flag, timestamp, failures, circuit open flag, opened-at
- Notifies observers on state transition OPEN -> CLOSED

### `releaseHalfOpenProbe()` -- state.js

Clears probe flag and timestamp without recording success or failure. Used by `hierarchicalPreFilter` so its outcome doesn't cascade to the main search's circuit state.

**L2 (v2.5):** Fires `notifyCircuitStateChanged()` on release. Without this, UI surfaces (drawer status indicator, settings-ui chip) that subscribe to circuit-state changes can show stale "probing" state until the next `recordAi*` call mutates the breaker. The notify is a pure UI-refresh hint — the raw `aiCircuitOpen` flag is unchanged (release is not a transition). Locked by regression test L2-1..L2-4.

### What does NOT trip the breaker

The exclusion list is shared across ALL wrappers via `isExcludedFromBreaker(err)` — implemented in `src/ai/breaker-pure.js` (intentionally ST-free so it can be unit-tested) and re-exported from `src/ai/ai.js` so callers keep importing from there. Every caller in the table below routes its trip decision through this single helper — copy-pasting the four conditions per wrapper is how drift creeps back in (see Wave-B audit, 2026-05-22).

- Throttle failures (`err.throttled`)
- Timeouts (`err.timedOut` or `AbortError`)
- User aborts (`err.userAborted`, or `AbortError` whose message contains "aborted by user")
- Rate limits (HTTP 429, or message matching `rate.?limit|too many requests`)
- Auth errors (HTTP 401/403, or message matching `unauthoriz|forbidden|invalid api key|auth`)

Only unclassified errors (typically 5xx, network failures, or persistent format drift) call `recordAiFailure()`.

### All Circuit Breaker Callers

All AI-calling functions use the same circuit breaker probe pattern and the same exclusion classifier (`isExcludedFromBreaker()`):

**Mode availability per feature (verified 2026-05-28 against `settings.js` defaults + per-caller dispatch).** `proxy` is dead-headed everywhere in v2.5 — it throws at the callAI dispatch or, for scribe/auto-suggest, at their own explicit `mode === 'proxy'` guard (`scribe.js:63-64`, the auto-suggest mirror). The live mode sets are:

| Feature | Default mode | Live modes | `st` path? |
|---|---|---|---|
| AI Search (`aiSearch`) | `profile` | `profile` only | No — routes solely through `callAI` (`ai.js:888-899`). Never used `generateQuietPrompt`. |
| Scribe (`scribe`) | `inherit` | `inherit`/`st`/`profile` | Yes — `st` = `generateQuietPrompt` (`scribe.js:67-76`) |
| Auto-Suggest / Auto-Lorebook (`autoSuggest`) | `inherit` | `inherit`/`st`/`profile` | Yes — `st` = `generateQuietPrompt` (`auto-suggest.js:34-44`) |
| AI Notepad (`aiNotepad`) | `inherit` | `inherit`/`profile` | No |
| Librarian (`librarian`) | `inherit` | `inherit`/`profile` | No |
| Optimize Keys (`optimizeKeys`) | `inherit` | `inherit`/`profile` | No |

`librarianConnectionMode`'s validation enum still lists `'proxy'` (`settings.js:391`) as a legacy stored value the migration handles; it is not a reachable runtime path.

| Function | File | Live modes | Notes |
|---|---|---|---|
| `aiSearch()` | `src/ai/ai.js` | profile | Main caller; `recordAiSuccess/Failure()`. (`proxy` dead-headed; no `st` path.) |
| `hierarchicalPreFilter()` | `src/ai/ai.js` | profile | `releaseHalfOpenProbe()` only — never records success/failure. Every non-error early-return MUST release the probe (try/finally guard via `_releaseProbeOnce`); otherwise HALF-OPEN slot leaks for 60s and blocks recovery (AI-audit H1). |
| `callAutoSuggest()` | `src/ai/auto-suggest.js` | st, profile | `recordAiSuccess/Failure()`. `proxy` throws at the explicit guard. |
| `callScribe()` (internal) | `src/ai/scribe.js` | st, profile | `recordAiSuccess/Failure()`. `proxy` throws (`scribe.js:63-64`). |
| `callSummaryAI()` (internal to `summarizeRange`) | `src/ai/summarize.js` | inherits scribe config | `recordAiSuccess/Failure()`. Was bypassing the breaker entirely pre-Wave-B. |
| Per-entry call in `summarizeEntries()` batch | `src/ui/commands-ai.js` | resolves `optimizeKeys` tool config | `recordAiSuccess/Failure()` per entry. Was bypassing both `resolveConnectionConfig` and the breaker pre-Wave-B. Skipped entries on open breaker count toward `failed`, not aborted — loop continues. |

When adding a new AI caller, it must follow this pattern AND route its trip decision through `isExcludedFromBreaker()`. When touching the circuit breaker, update this table.

### Error Classification -- core/utils.js `classifyError()`

`classifyError()` categorizes API errors for circuit breaker decisions and user-facing messages. In addition to the original types, 6 new error types have been added:

| Type | Detection | Breaker trip? |
|---|---|---|
| `CORS` | Network error with CORS-related message patterns | No |
| `QUOTA_BILLING` | HTTP 402 (Payment Required) | No |
| `JSON_PARSE` | JSON parse/syntax errors in response | Yes (format drift) |
| `MODEL_NOT_FOUND` | HTTP 404 + model-related message, or explicit model-not-found error | No |
| `OVERLOADED` | HTTP 529 (service overloaded) | No |

These complement the existing types (timeout, rate_limit, auth, user_abort, throttle, network, unknown).

---

## 6. Claude Adaptive-Thinking Check

### Module -- claude-adaptive-check.js

Detects when a Connection Manager profile uses Claude opus-4-6 / sonnet-4-6 (adaptive thinking models) but the bound OpenAI completion preset lacks an explicit `reasoning_effort` set to low/medium/high. ST rejects these requests with a 400 error.

```js
const CLAUDE_ADAPTIVE_REGEX = /^claude-(opus-4-6|sonnet-4-6)/i;  // claude-adaptive-check.js: module-top const
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);         // claude-adaptive-check.js: module-top const
```

### `detectClaudeAdaptiveIssue(profileId, modelOverride, opts)` -- claude-adaptive-check.js

```js
// Returns: {bad: boolean, reason?: string, profileName?, modelName?, presetName?}
```

**Flow** (all steps inside `detectClaudeAdaptiveIssue()`):
1. Bail early if no profileId or no SillyTavern context
2. Get profile via `ConnectionManagerRequestService.getProfile()`
3. Skip if `profile.api !== 'claude'` -- OpenRouter/custom wrappers handle this differently
4. Check model against `CLAUDE_ADAPTIVE_REGEX`
5. Check preset exists -- `reason: 'no_preset'` if missing
6. Read `reasoning_effort` from preset (BUG-397: always JIT, never memoized; callers can pass `opts.freshPreset`)
7. Return `bad: true` with `reason: 'auto'` or `reason: 'unset'` if effort is invalid

**Wrapped in try/catch** (in `detectClaudeAdaptiveIssue()`): Detection must never throw -- returns `{bad: false}` on any error.

### Pre-flight in `callViaProfile()` -- ai.js

Dynamic-imported at call time (`await import('./claude-adaptive-check.js')`). When `bad === true` (inside `callViaProfile()`):
- Sets `claudeAutoEffortState` via `setClaudeAutoEffortState(true, detail)` (state.js:`setClaudeAutoEffortState()`), which notifies UI observers
- One-shot toast via `claimClaudeAdaptiveToastSlot(detail)`
- Stores detail for error rewriting in the catch block

### Error rewriting -- ai.js (in `callViaProfile()` catch block)

When the actual API call fails AND `claudeAdaptiveDetail` was set pre-flight AND the error message matches `400|bad request|top_k|thinking|reasoning_effort`, the error is rewritten to a human-readable message from `buildClaudeAdaptiveMessage(detail, 'error')`. The import is wrapped separately (BUG-069) so import failure doesn't mask the original error.

### `claimClaudeAdaptiveToastSlot(detail)` -- claude-adaptive-check.js

Session-scoped one-shot tracking. Key is `profileName|modelName|presetName`. Returns `true` (show toast) only the first time per combo per browser session. The `_sessionToastShown` Set (claude-adaptive-check.js: module-top const) is never persisted.

### `resolveFeatureConnectionMode(settings, feature)` -- claude-adaptive-check.js

Resolves inherit chain: `settings[featureConnectionModeKey]` -> if `'inherit'`, falls back to `settings.aiSearchConnectionMode || 'profile'`.

### `shouldCheckClaudeAdaptiveForFeature(settings, feature)` -- claude-adaptive-check.js

Returns true only when the feature's effective mode is `'profile'`. Proxy mode routes through a local proxy that handles thinking itself, so the native-Anthropic preset check would be a false positive.

---

## 7. Proxy Mode

> **DEPRECATED v2.5**: This entire section documents code that is unreachable in production. `callAI()` dispatch throws when `mode === 'proxy'`. UI hidden in settings popup + setup wizard. Files marked `@deprecated v2.5`. Preserved for rollback safety only — un-hide `<option value="proxy">` and revert the callAI dispatch throw to restore. **Profile mode is the only supported path as of v2.5.** See gotcha #68 for migration semantics, rollback path, and `PRX-MIG-1/2/3` test coverage in `test/regression.test.mjs`.

### `callProxyViaCorsBridge()` -- proxy-api.js

```js
callProxyViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout=15000, cacheHints, externalSignal)
  -> {text: string, usage: {input_tokens, output_tokens}}
```

Routes through SillyTavern's built-in CORS proxy at `/proxy/:url`. **DEPRECATED v2.5 — see #68.** ~~Requires `enableCorsProxy: true` in ST's config.yaml~~ -- without it, the proxy returns 404 with a "CORS proxy is disabled" message, which is caught and surfaced as a descriptive error (in `callProxyViaCorsBridge()`). **As of v2.5 DLE AI features no longer require `enableCorsProxy: true`** — Profile mode (CMRS) routes server-side and bypasses the CORS proxy entirely. This callsite is unreachable; documentation retained for the rollback path.

**URL construction** (in `callProxyViaCorsBridge()`):
```js
const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;
```
The target URL is `encodeURIComponent`-encoded to prevent Express from collapsing `://` to `:/`.

**Request format**: Anthropic Messages API format (body build in `callProxyViaCorsBridge()`):
- `anthropic-version: 2023-06-01` header
- System prompt as `[{type: 'text', text, cache_control: {type: 'ephemeral'}}]`
- User content: plain string, or two-block array when `cacheHints` provided (stable prefix with `cache_control: {type: 'ephemeral'}` + dynamic suffix) (userContent assembly in `callProxyViaCorsBridge()`)

**Abort handling** (abort wiring + catch block in `callProxyViaCorsBridge()`):
- Internal `AbortController` with timeout
- External signal wired to internal controller
- On abort, distinguishes user abort (`externalSignal.aborted` -> `err.userAborted = true`) from timeout (`err.timedOut = true`). Both set `err.name = 'AbortError'`.

**Error response scrubbing** (in `callProxyViaCorsBridge()` non-ok branch): **Redacts first, then truncates to 150 chars** (AI-M5, 2026-05-22). Pre-fix the truncate-then-redact order let any token starting in the last ~15 chars of the 150-char window slip through truncated mid-key (below the `{10,}` regex minimum). Patterns cover Anthropic (`sk-`), OpenAI (`sk-proj-` matched first as the superset), Google (`AIza`), Groq (`gsk_`), and generic Bearer tokens. Same pattern as `agentic-api.js` (HIGH-LIB-2). When extending the scrubber, never reorder these two operations.

**JSON parse safety** (in `callProxyViaCorsBridge()` — BUG-041): Separate `response.text()` and `JSON.parse()` calls for distinct error messages.

### `validateProxyUrl(url)` -- proxy-api.js

SSRF validation. Called at the start of `callProxyViaCorsBridge()` and in `fetchModels()`.

**Blocks** (all in `validateProxyUrl()`):
- Empty/malformed/non-http(s) URLs
- Cloud metadata endpoints: `169.254.169.254`, `metadata.google.internal`, `100.100.100.200`
- `localhost`, `0.0.0.0`, `::1`, `::ffff:127.0.0.1`
- Private/reserved ranges: 10.x, 172.16-31.x, 192.168.x, 100.64-127.x (CGNAT), 169.254.x (link-local), 0.x, fd/fe80 (IPv6)
- Numeric/hex/octal IP shorthand

**Allows:** `127.0.0.1` only (local proxies).

### `testProxyConnection(proxyUrl, model, externalSignal?)` -- proxy-api.js

Sends a minimal probe (`'Reply OK.'` system, `'ping'` user, max 8 tokens, 15s timeout). Returns `{ok: boolean, response?, error?, aborted?: boolean}`.

**Cancellable** (AI-M6, 2026-05-22): optional `externalSignal` (`AbortSignal`) propagates user-cancel from the Settings UI Test button. Second click during in-flight probe aborts via the same controller; popup close should call `.abort()` on the controller too. When `externalSignal` triggers, the returned object has `aborted: true` so callers can distinguish user-cancel from real proxy failures and show "Cancelled" instead of "Failed".

---

## 8. Auto-Suggest Connection Routing

### `callAutoSuggest(systemPrompt, userMessage, toolKey)` -- auto-suggest.js

Routes auto-suggest AI calls through the same connection-mode system as `callScribe`. Two live modes (`proxy` dead-headed v2.5 — throws at the explicit `mode === 'proxy'` guard before falling through to `st`):

- **`st` mode** (`auto-suggest.js:34-44`): Uses `generateQuietPrompt({ quietPrompt, skipWIAN, responseLength })`. Wraps a `Promise.race()` to handle GENERATION_STOPPED early-exit (BUG-244) and a configurable timeout. `recordAiSuccess/Failure()` integrations included; timeouts and user aborts do NOT trip the breaker.
- **`profile` mode** (`auto-suggest.js:83`): Delegates to `callAI()` with `{ ...resolved, caller: 'autoSuggest' }`. Circuit breaker probe acquired via `tryAcquireHalfOpenProbe()`.

Default `toolKey = 'autoSuggest'` — callers can override to route through a different connection config (useful for testing).

**Circuit breaker:** Both live modes call `isAiCircuitOpen()` + `tryAcquireHalfOpenProbe()`. `recordAiSuccess()` on success; `recordAiFailure()` on error (skipped for throttled/abort/timeout).
