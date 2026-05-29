# Gotchas — Read Before You Touch Anything

Every item here has caused a regression. Read this before modifying pipeline, state, or lifecycle code.

> **Stable-number contract.** Each `## N.` heading is referenced by number from `CLAUDE.md`, the other `docs/*.md`, code comments (`// see gotchas.md #46`), and `test/regression.test.mjs`. **Never renumber, never reuse a freed number.** Numbers are append-only: a new gotcha takes the next free integer regardless of subsystem (which is why the physical order below is not strictly ascending — #50/#51 are swapped, and #54–#67 interleave). A retired gotcha keeps its number tagged `(RESOLVED vX.Y — kept for reference)`. To jump to a gotcha, Ctrl-F for `## N.` (the dot disambiguates `## 5.` from `## 50.`).

## Index by subsystem

Format: `#N — title`. Listed under the subsystem you'd most likely be editing when it bites. Some gotchas touch multiple areas; they're filed under the primary one.

**Generation pipeline & onGenerate** (`index.js`, `src/pipeline/`, `core/`)
- #1 — Epoch guards (re-check `chatEpoch`/`generationLockEpoch` after every await)
- #2 — `clearPrompts` timing (never without verified replacement)
- #6 — Tool-call continuations (skip pipeline when `tool_invocations`/`is_system`)
- #7 — Generation lock (3 vars, 30s stale auto-release, lockEpoch-gated release)
- #9 — Swipe tracking (`${msgIdx}|${swipe_id}` key, not content hash)
- #13 — Module-scope for onGenerate dependencies
- #26 — `onGenerate` param is `chatMessages` (filtered copy), not global `chat`
- #31 — Vault review bypass (`skipNextPipeline`)
- #32 — Pipeline status toast z-index
- #42 — Stepped Thinking re-entry guard
- #45 — `formatAndGroup` escapes title only, content raw (issue #16)
- #51 — `verdictMsgIdx` anchors on global `chat`, not filtered `chatMessages`
- #60 — Bootstrap exemption is gen-scoped to `bootstrapActive` (Stages H-3)
- #63 — Cascade-pulled `excludeRecursion:true` entries don't seed recursion text (M-5)
- #65 — Stages MEDIUMs bundle (M-3/M-4/M-6/M-7/M-8 — strip-dedup, warmup, gating, truncation hash)

**State & lifecycle** (`src/state.js`, `init()`, observers)
- #3 — State mutation scoping (session vs chat vs generation reset)
- #4 — `trackerKey` vs bare title
- #14 — Listener registration via `_registerEs`
- #15 — `scribeInProgress` must NOT reset on CHAT_CHANGED
- #16 — Build epoch zombie guard
- #33 — `suppressNextAgenticLoop` reset placement
- #44 — `MESSAGE_SWIPE_DELETED` emits an object payload
- #50 — `trackerKey` drift is a regression class (10 drifted sites)
- #59 — Boot-path race guards (BOOT-MED-1/2/3)
- #62 — Vault rename is destructive — confirm before apply (V-M5)

**Verdict store** (`src/verdict/`)
- #46 — Verdict store replaces the four racing globals
- #52 — `pruneCurrentChat` is sampled — cap is soft (200 + N-1)

**AI subsystem & circuit breaker** (`src/ai/`)
- #10 — AI circuit breaker (pure query vs mutation gate; 401/403/429 excluded)
- #11 — Settings cache removed (BUG-088; `invalidateSettingsCache` is a no-op)
- #12 — Connection mode independence (`librarianConnectionMode` separate)
- #34 — `hierarchicalPreFilter` uses an independent breaker probe
- #36 — Error cause chaining (`{ cause: err }`) + `_isDebug()` ST-free read
- #37 — Clear Picks must reset all pipeline caches
- #38 — All `.abort()` calls go through `abortWith`
- #39 — Tool-calling gate is per-model, not just per-source
- #40 — Claude detection must cover OpenRouter relays (`isUnderlyingClaude`)
- #48 — Reuse-sync must honor partial-fetch flags (V-C1)
- #68 — Custom Proxy connection mode dead-headed in v2.5 (migration v3→v4)

**Librarian / agentic loop** (`src/librarian/`)
- #5 — Guide entry isolation (`getWriterVisibleEntries`)
- #8 — No DLE intermediate messages
- #21 — Agentic loop epoch guards (+ `_runFlagIteration`)
- #22 — Agentic loop stale-lock keepalive (C9)
- #23 — Agentic loop re-entrancy guard (C1)
- #24 — Tool result batching (C4 — 4 provider formats)
- #25 — Provider format handling (raw, not normalized)
- #27 — `saveReply` does NOT save to disk (call `saveChatConditional`)
- #28 — `CHARACTER_MESSAGE_RENDERED` cleans `message.mes` async after `saveReply`
- #29 — `type` must be forwarded to `saveReply`
- #30 — `onProse` in the agentic loop is async (must await)
- #35 — `librarianPerMessageActivity` changes gap/dropdown lifecycle
- #41 — Gemini multi-turn messages MUST be OpenAI shape
- #43 — Every post-await branch in agentic dispatch re-checks epoch
- #54 — `onProse` throw must not lose paid-for prose (CRIT-LIB-3)
- #66 — `searchLoreAction` returns structured `{text, titles}` — don't regex `###`
- #67 — Librarian HIGH-severity fixes (HL2/HL3/HL4/HL5)

**Vault, indexing & import** (`src/vault/`, `core/utils.js`)
- #49 — Import dedup existence check must fail loud on network errors (V-C2)
- #55 — `finalizeIndex` incremental derived-state updates (P3)
- #57 — Frontmatter parsing MUST NOT pollute `Object.prototype` (V-H3)
- #61 — `clearIndexCache` aborted txns hang without `tx.onabort` (V-M3)
- #69 — WI import is a contract, not best-effort (v2.5 WI parity)

**Diagnostics & scrubbing** (`src/diagnostics/`, `src/ui/diagnostics.js`)
- #17 — Health check `entries` → `vaultIndex` fix
- #18 — `diagnoseEntry()` pipeline stage coverage
- #19 — `pseudonymizeTrace()` must scrub `matchedBy`/`reason`/`vaultSource`
- #20 — Scrubber pattern callback argument counts

**Drawer, settings & i18n UI** (`src/drawer/`, `src/ui/`, `locales/`)
- #47 — i18n hooks ST's built-in system — don't roll your own
- #53 — PM-mode registration requires `promptManager.activeCharacter`
- #56 — Drawer dismiss handler must exempt clicks inside ST popups
- #58 — Every `<button>` MUST specify `type="button"` (a11y / form-safety)
- #64 — Settings UI MEDIUMs bundle (V-M1/V-M2/V-M4/V-M5)
- #70 — Editable prompts — delete cage + `getPrompt()` invariants (v2.5)

---

## 1. Epoch Guards

**Rule:** Every write to state or `chat_metadata` after an `await` MUST re-check `epoch === chatEpoch`. Every write to prompts or tracking MUST also check `lockEpoch === generationLockEpoch`.

**Why:** `CHAT_CHANGED` can fire at any moment (user switches chat while pipeline runs). Without the guard, a stale pipeline writes data to the wrong chat's metadata, corrupts cooldown/decay maps, or wipes the new pipeline's prompts.

**Pattern:**
```javascript
const epoch = chatEpoch;          // capture at function start
const lockEpoch = generationLockEpoch;
// ... await something ...
if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;
// NOW safe to write
```

**Where in code:** `index.js: onGenerate()` — `epoch`/`lockEpoch` captured after lock acquisition, re-checked at every commit-phase write (no-match/cooldown-empty/gating-empty branches, prompt commit, cartographer source capture, tracking, analytics, per-chat counts). Missing a single check = cross-chat data corruption.

---

## 2. clearPrompts Timing

**Rule:** NEVER call `clearPrompts()` without verified replacement data in hand. NEVER call it before the commit phase.

**Why:** `clearPrompts` deletes all DLE-managed entries from `extension_prompts`. If an early return fires after clearing but before setting new prompts, lore silently disappears. If a stale pipeline reaches `clearPrompts`, it wipes prompts the new pipeline just set.

**Where in code:** `index.js: onGenerate()` — `clearPrompts()` is called in the `groups.length > 0` commit block (after final epoch check) and in the three early-return branches (no-match, cooldown-empty, gating-empty), each guarded by an epoch check first.

---

## 3. State Mutation Scoping

**Rule:** Know the reset scope of every state variable before touching it.

| Scope | Reset trigger | Examples |
|---|---|---|
| Session | Page load only | `aiSearchStats`, `librarianSessionStats` |
| Chat | `CHAT_CHANGED` | `cooldownTracker`, `decayTracker`, `consecutiveInjections`, `injectionHistory`, `generationCount`, `chatInjectionCounts`, `perSwipeInjectedKeys`, `librarianChatStats` |
| Generation | Each `onGenerate` run | `loreGapSearchCount` (always reset in `onGenerate()` after lock acquisition, unconditional) |

**Why:** Resetting a session-scoped stat on chat change loses cross-chat totals. NOT resetting a chat-scoped tracker on chat change leaks stale data into the new chat.

---

## 4. trackerKey vs Bare Title

**Rule:** ALWAYS use `trackerKey(entry)` (format: `${vaultSource}:${title}`) for Map keys. Never use bare `entry.title`.

**Why:** Multi-vault support means the same title can exist in different vaults. Bare titles collide, causing one vault's cooldown/analytics to overwrite another's.

**Where:** `src/state.js: trackerKey()`. Used in: `cooldownTracker`, `injectionHistory`, `decayTracker`, `consecutiveInjections`, `chatInjectionCounts`, `perSwipeInjectedKeys`, `analyticsData`.

---

## 5. Guide Entry Isolation

**Rule:** `lorebook-guide` entries MUST NOT reach the writing AI through any path. Use `getWriterVisibleEntries()` instead of `vaultIndex` for anything the writing AI sees.

**Safe to show in:** Drawer Browse tab, graph, diagnostics, Librarian's `get_writing_guide` tool.

**Where:** `src/state.js: getWriterVisibleEntries()`. Called in `index.js: onGenerate()` at the vault snapshot step. If you add a new path that sends vault data to the AI, it MUST go through this filter.

---

## 6. Tool-Call Continuations

**Rule:** When `lastMsg.extra.tool_invocations` exists or `lastMsg.is_system`, skip the pipeline entirely.

**Why:** Other extensions may use ST's ToolManager. ST re-calls Generate after each tool invocation. Lore from the original generation is still in context. Re-running the pipeline wastes tokens. DLE's own Librarian uses the agentic loop (not ToolManager), so DLE tool calls never trigger this guard.

**Where:** `index.js: onGenerate()` — tool-call continuation skip block (checks `lastMsg.extra.tool_invocations` / `lastMsg.is_system` on the final chat entry).

---

## 7. Generation Lock

**Rule:** The generation lock uses three variables: `generationLock` (boolean), `generationLockTimestamp` (ms), `generationLockEpoch` (counter). A stale lock auto-releases after 30s with an epoch bump.

**Critical invariant:** A force-released stale pipeline MUST NOT release the newer pipeline's lock. The pattern is:
```javascript
if (lockEpoch === generationLockEpoch) setGenerationLock(false);
```

**Why:** Without the lockEpoch check, the stale pipeline's `finally` block releases the new pipeline's lock, allowing a third concurrent pipeline to start.

**Where:** `index.js: onGenerate()` — lock acquisition + 30s stale detection block; and the conditional release in the outer `finally` (`if (lockEpoch === generationLockEpoch) setGenerationLock(false)`). `src/state.js: setGenerationLock()` (increments epoch on acquire).

---

## 8. No DLE Intermediate Messages

**Rule:** The agentic loop produces NO intermediate messages in `chat[]`. It runs its own multi-turn conversation internally, then inserts a single clean message via `addOneMessage()`.

**Why (historical):** The old ToolManager approach created `tool_invocation` system messages and intermediate assistant messages that needed post-hoc stripping. The agentic loop eliminates this entire class of bugs — no `stripDleSystemMessages`, no `_cleanupOrphanedDleIntermediates`, no GENERATION_ENDED consolidation.

**Where:** `index.js: onGenerate()` agentic loop dispatch branch — the `onProse` callback invokes `saveReply` once after the loop completes (single `addOneMessage` via `saveReply`).

---

## 9. Swipe Tracking

**Rule:** Swipe keys use `${msgIdx}|${swipe_id}`, NOT content hashing.

**Why (BUG-291/292/293):** Content hashing failed because:
- Alternate-swipe navigation changes content → new hash → treated as fresh gen → tracker drift
- Delete + regenerate produces same content → hash collision → false rollback
- The slot+swipe_id key is stable across both scenarios

**Where:** `index.js: onGenerate()` — `_snapMatch` swipe-rollback block (early in the try), and the per-chat injection counts / per-swipe tracking block (Stage 9, `_countsStart`). `src/state.js: perSwipeInjectedKeys` state var (BUG-291/292/293 comment).

---

## 10. AI Circuit Breaker

**Rule:** `isAiCircuitOpen()` is a **pure query** — use for UI/status. `tryAcquireHalfOpenProbe()` is the **mutation gate** — use ONLY in actual AI call paths.

**Why (BUG-AUDIT-1/2):** If UI code calls `tryAcquireHalfOpenProbe`, it steals the probe slot from the real AI call, causing the circuit to stay open indefinitely.

**Additional rules:**
- Throttle failures and user aborts do NOT trip the breaker (they're not service failures)
- HTTP 401/403 (auth) and 429 (rate-limit) do NOT trip the breaker — bad API key / provider backoff is user-actionable, not service-down
- Every AI wrapper MUST route its trip decision through the shared `isExcludedFromBreaker(err)` helper — implemented in `src/ai/breaker-pure.js` (intentionally ST-free for tests) and re-exported from `src/ai/ai.js` so existing import paths keep working. Inline classification by copy-paste drifts (Wave-B audit found 4 wrappers with 3-condition checks missing 401/403/429 — second bad-key call locked the user out for 30s). Single source of truth is non-negotiable.
- `hierarchicalPreFilter` uses `releaseHalfOpenProbe()` — its outcome shouldn't affect the breaker since `aiSearch()` handles its own probing. Every non-error early-return MUST release the probe (use the `_releaseProbeOnce` try/finally pattern); otherwise HALF-OPEN slot leaks for the full `AI_PROBE_TIMEOUT` (60s) and blocks recovery (AI-audit H1).
- Stale probes auto-reset after 60s (`AI_PROBE_TIMEOUT`)

**Where:** `src/state.js` — AI circuit breaker state machine: `recordAiFailure()`, `recordAiSuccess()`, `releaseHalfOpenProbe()`, `isAiCircuitOpen()`, `tryAcquireHalfOpenProbe()` (see header comment on the 3-state CLOSED/OPEN/HALF-OPEN machine). `src/ai/breaker-pure.js` — `isExcludedFromBreaker()` shared classifier (pure, ST-free for tests; re-exported from `src/ai/ai.js`). Mirrored in `docs/ai-subsystem.md` "What does NOT trip the breaker" + "All Circuit Breaker Callers" table.

---

## 11. Settings Cache (Removed — BUG-088)

**Rule:** `getSettings()` no longer caches. Every call runs all passes (default-fill, numeric coercion, validation, migrations) idempotently. `invalidateSettingsCache()` is retained as a **no-op** for call-site compatibility. You do NOT need to call it — but calling it is harmless.

**Why (historical):** The old cache required every mutator to remember `invalidateSettingsCache()`. BUG-088 removed the cache because the invalidation discipline was brittle. The `SETTINGS_UPDATED` event handler still calls the no-op for backward compatibility.

**Where:** `settings.js: invalidateSettingsCache()` — BUG-088 comment + no-op stub.

---

## 12. Connection Mode Independence

**Rule:** Each AI feature has its own independent connection config. `librarianConnectionMode` MUST NOT share with retrieval (`aiSearchConnectionMode`).

**Why (user feedback):** The 6 AI feature blocks (AI Search, Scribe, Auto Lorebook, AI Notepad, Librarian, Optimize Keys) are intentionally independent. Don't "helpfully" collapse them. `inherit` mode falls back to `aiSearch` settings (not to each other).

**Where:** `settings.js` — `resolveConnectionConfig(toolKey)` dispatches per-tool. See also `feedback_dle_ai_channels.md` in memory.

---

## 13. Module-Scope for onGenerate Dependencies

**Rule:** Anything that `onGenerate` touches at runtime MUST be module-scope (or imported at module scope), not defined inside `init()`.

**Why (BUG from `bugs_ongenerate_scope.md`):** `_updatePipelineStatus` was originally defined inside `init()` scope. `onGenerate` couldn't see it — every generation crashed silently because ST swallows interceptor errors. The error was invisible until someone checked the console.

**Where:** `index.js: _updatePipelineStatus()` and `_removePipelineStatus()` (module-scope functions).

---

## 14. Listener Registration via `_registerEs`

**Rule:** All `eventSource.on/once` registrations in `init()` MUST use `_registerEs()`. Direct `eventSource.on()` calls bypass teardown tracking.

**Why (BUG-063):** `_teardownDleExtension()` iterates `_dleListeners.eventSource` to remove every tracked listener on teardown (page unload, re-init). A listener registered directly with `eventSource.on()` cannot be removed on teardown, causing duplicate handlers on reload and leaked closures.

**Where:** `index.js: _registerEs()` and `_teardownDleExtension()` (module-scope), plus the re-init guard at the top of the `jQuery()` init (checks `_dleInitialized`). Exception: per-generation listeners wired inside `onGenerate` (e.g. `GENERATION_STOPPED`, `STREAM_TOKEN_RECEIVED`) are torn down in the `finally` block, not via `_registerEs`.

---

## 15. `scribeInProgress` Must NOT Reset on CHAT_CHANGED

**Rule:** Do NOT reset `scribeInProgress` in the CHAT_CHANGED handler. The in-flight scribe owns its own flag and releases it in its own `finally` block.

**Why (BUG-275):** Resetting the flag here races with a scribe that is still mid-`await` on chat A. When the user returns to chat A, a second scribe starts concurrently — two `writeNotes` + two reindexes race, corrupting state.

**Where:** `index.js` CHAT_CHANGED handler (BUG-275 comment explaining why NOT to reset). `src/ai/scribe.js: runScribe()` `finally` block (flag released in scribe's own `finally`).

---

## 16. Build Epoch Zombie Guard

**Rule:** Long-running index builds MUST capture `buildEpoch` at start and bail if epoch changes mid-build. Force-releasing a stuck indexing flag bumps `buildEpoch`.

**Why (BUG-015/AUDIT-C05):** Without this, a zombie build (stuck in a slow Obsidian fetch) that unsticks after a force-release will commit a stale index on top of a fresh one, silently reverting vault changes.

**Where:** `src/state.js: buildEpoch` + `setBuildEpoch()`. `src/vault/vault.js: buildIndex()` (captures `capturedEpoch` + defines `isZombie()`; checks at every `isZombie()` call site, including the final commit guard). `src/vault/vault.js: buildIndexWithReuse()` (separate `capturedBuildEpoch` + `isZombie()` checked mid-loop and before commit). `src/vault/sync.js` — stuck-indexing watchdog (bumps `buildEpoch` on force-release).

---

## 17. Health Check `entries` → `vaultIndex` Fix

**Rule:** The health check in `src/ui/diagnostics.js` must use `vaultIndex` (the live state binding), not a local `entries` variable.

**Why (BUG FIX):** In `runHealthCheck()`'s exclude-reference validation, the code was referencing `entries` (undefined in that scope) instead of `vaultIndex`. This caused the health check to crash on any vault that had entries with `excludes` references, silently swallowing the error and returning incomplete diagnostics.

**Where:** `src/ui/diagnostics.js: runHealthCheck()` — exclude-reference validation block (BUG-AUDIT-H22).

---

## 18. `diagnoseEntry()` Pipeline Stage Coverage

**Rule:** `diagnoseEntry()` must check all pipeline stages that can remove an entry, not just matching and budget.

**Why:** Users running `/dle-health` need to know WHY a specific entry wasn't injected. Missing stages cause false "not matched" diagnoses when the entry was actually matched but filtered out by a later stage.

**Additional stages now checked:** `guide_entry` (entry is guide-only, never reaches writing AI), `folder_filter` (filtered by active folder selection), `blocked` (per-chat block override), `contextual_gating` (failed era/location/scene/character/custom field filter), `strip_dedup` (removed by strip dedup — identical injection in recent context).

**Where:** `src/ui/diagnostics.js` `diagnoseEntry()`.

---

## 19. `pseudonymizeTrace()` Must Scrub `matchedBy`, AI `reason`, and `vaultSource`

**Rule:** When pseudonymizing pipeline trace data for diagnostic export, `matchedBy` fields, AI `reason` strings, AND per-entry `vaultSource` must also be scrubbed.

**Why:** `matchedBy` can contain entry titles and keyword matches that reveal vault content. AI `reason` strings contain the AI's rationale for selecting entries, which can quote vault content or character names. `vaultSource` (per the CLAUDE.md trackerKey invariant — trace entries carry `vaultSource` per-entry) leaks the user's project/vault name (e.g. "Private Lore Vault") even though title/filename are pseudonymized. Without scrubbing these, the "anonymized" diagnostic export leaks user content.

**Where:** `src/diagnostics/pseudonymize-trace.js` (pure helpers, extracted 2026-05-22 for testability). `src/diagnostics/state-snapshot.js` wraps them via `pseudonymizeTracePure(trace, _pseudoCtx)` using a per-snapshot context. Regression coverage: `test/diagnostics.test.mjs` section F (13 tests, F1–F13) — the `vaultSource` leak (F4) was the gap closed alongside the extraction.

---

## 20. Scrubber Pattern Callback Argument Counts

**Rule:** Each pattern `fn` in `src/diagnostics/scrubber.js` MUST have parameter count = (1 match + N capture groups + offset + fullString + ctx). The wrapper appends `ctx` after `String.prototype.replace`'s standard args. A phantom parameter shifts `ctx` to a position that never gets filled → `ctx` is `undefined` → `TypeError` → silently caught → pattern does nothing.

**Why (BUG found by test suite):** 7 of 10 scrubber patterns (Bearer tokens, URL tokens, OpenAI keys, IPv4, IPv6, emails, long tokens) had an extra `_gl` phantom parameter, causing `ctx` to always be `undefined`. The outer try/catch swallowed the TypeError. Result: diagnostic exports only scrubbed file paths and hostnames — IPs, emails, API keys, and bearer tokens passed through unredacted.

**Pattern:** For a regex with N capture groups, the fn should have exactly `N + 4` parameters: `(match, ...Ngroups, offset, fullString, ctx)`.

**Where:** `src/diagnostics/scrubber.js: PATTERNS` array.

---

## 21. Agentic Loop Epoch Guards

**Rule:** The agentic loop MUST check `epoch !== chatEpoch || lockEpoch !== generationLockEpoch` at the TOP of every iteration, before any API call or state mutation. Also check `signal.aborted`. The FLAG-phase helper `_runFlagIteration` mirrors this guard — it accepts `epoch` and `lockEpoch` parameters and re-checks them around its own awaits (before `callWithTools`, after `callWithTools`, around each `flagLoreAction` call, and after each `flagLoreAction` returns before pushing to `toolActivity`).

**Why:** The agentic loop runs multiple iterations (up to 15) with awaits between each. A chat switch or stop-button press during any iteration must bail the loop immediately. Without this, a stale loop writes tool results and creates messages in the wrong chat. For `_runFlagIteration` specifically (CRIT-LIB-1, 2026-05-22), the inner `flagLoreAction` has its own epoch check at `librarian-tools.js:544` that protects `persistGaps` (chat_metadata stays clean), but `sessionActivityLog.push` and `incrementStats` fire unconditionally — without the helper's own guards, an old-chat flag would pollute the NEW chat's Activity feed and double-count session/chat stats. `AbortError` in `_runFlagIteration` is re-thrown (not swallowed) so the main loop's catch can surface it via the standard abort path.

**Where:** `src/librarian/agentic-loop.js: runAgenticLoop()` — epoch + abort check at iteration start of the main `for` loop. `src/librarian/agentic-loop.js: _runFlagIteration()` — pre-call guard, post-`callWithTools` guard, mid-flag-loop guard, post-`flagLoreAction` guard (skips `toolActivity.push` on epoch shift). Tests: `test/regression.test.mjs` F5a–F5d (CRIT-LIB-1).

---

## 22. Agentic Loop Stale-Lock Keepalive (C9)

**Rule:** Call `setGenerationLockTimestamp(Date.now())` before every `callWithTools()` call and before tool processing in the agentic loop.

**Why:** The generation lock has a 30s stale detection (`lockAge > 30_000` in `onGenerate()`'s lock-acquisition block). The agentic loop can run for much longer than 30s (multiple search + API round trips). Without keepalive, the stale-lock detector force-releases the lock mid-loop, bumping `generationLockEpoch`. The loop's next epoch check sees a mismatch and bails, silently dropping the generation.

**Where:** `src/librarian/agentic-loop.js: runAgenticLoop()` — `setGenerationLockTimestamp(Date.now())` is called twice per iteration (before `callWithTools()` and before tool processing). `src/state.js: setGenerationLockTimestamp()` (updates timestamp without toggling the lock).

---

## 23. Agentic Loop Re-Entrancy Guard (C1)

**Rule:** After `abort()`, immediately call `setSendButtonState(true)` + `deactivateSendButtons()`. Restore in `finally`.

**Why:** `abort()` calls ST's `unblockGeneration()`, which re-enables the send button. Without the guard, the user can trigger a new generation while the agentic loop is still running, causing race conditions with `chat.push` and `addOneMessage`.

**Where:** `index.js: onGenerate()` agentic-loop dispatch branch — `setSendButtonState(true)` + `deactivateSendButtons()` immediately after `abort()`; restored in the dispatch `finally` via `setSendButtonState(false)` + `activateSendButtons()`.

---

## 24. Tool Result Batching (C4)

**Rule:** When building tool result messages for the agentic loop, ALL tool results from one assistant turn MUST be batched into the format the provider expects. Claude requires all `tool_result` blocks in a single `user` message. OpenAI/Cohere uses separate `tool` role messages.

**Why:** Claude returns an API error if tool results arrive as separate messages. Google expects `functionResponse` parts in a single `function` role message. Sending results in the wrong format causes a 400 error and breaks the loop.

**Where:** `src/librarian/agentic-api.js` `buildToolResults()` — handles all 4 provider formats.

---

## 25. Provider Format Handling

**Rule:** The agentic loop must preserve provider-native message format for multi-turn conversations. `buildAssistantMessage()` returns the raw response structure (not normalized), and `buildToolResults()` uses the provider-specific format.

**Why:** CMRS passes messages through to the provider API. If DLE normalizes assistant messages to OpenAI format but the provider is Claude, the next API call fails because Claude doesn't understand `tool_calls` in the OpenAI format — it expects `content[]` with `tool_use` blocks. Each provider has its own wire format for tool-calling conversations.

**Where:** `src/librarian/agentic-api.js` — `buildAssistantMessage()`, `buildToolResults()`, `parseToolCalls()`, `getTextContent()` all handle 4 formats (Claude, Google, OpenAI-compatible, Cohere).

---

## 26. `onGenerate` Parameter Must Not Shadow Global `chat`

**Rule:** The `onGenerate` parameter is named `chatMessages` (NOT `chat`). It is a filtered copy (`coreChat`) from ST's interceptor — pushing to it loses data. Always use the global `chat` import from `script.js` for message creation and index lookups.

**Why:** The parameter was previously named `chat`, which shadowed the global `chat` array imported from `script.js`. Code that called `chat.push(msg)` inside `onGenerate` was pushing onto the filtered copy instead of the real chat array, silently losing messages.

**Where:** `index.js` `onGenerate(chatMessages, ...)`.

---

## 27. `saveReply` Does NOT Save to Disk

**Rule:** After calling `saveReply({ type, getMessage })`, you MUST call `saveChatConditional()` to persist the message to disk.

**Why:** `saveReply` handles the message lifecycle (creating the message object, emitting events like `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED`), but it does NOT write to disk. In the agentic loop, `abort()` prevents ST's post-generation save from running, so the message would be lost on reload without an explicit `saveChatConditional()` call.

**Where:** `index.js` agentic loop dispatch (Phase 8b).

---

## 28. `CHARACTER_MESSAGE_RENDERED` Cleans `message.mes` Asynchronously After `saveReply`

**Rule:** Do NOT assume `message.mes` is clean immediately after `await saveReply(...)`. Cleaning happens in the CHARACTER_MESSAGE_RENDERED event handler (`index.js` — the AI Notebook fallback-extraction block inside the `CHARACTER_MESSAGE_RENDERED` handler), which fires asynchronously after saveReply resolves. Code that runs directly after `await saveReply(...)` may still see raw text with `<dle-notes>` tags.

**Why:** `saveReply` creates the message and emits `CHARACTER_MESSAGE_RENDERED`. However, ST's event dispatch resolves asynchronously — DLE's handler (which sets `message.mes = cleanedMessage`) runs after the current continuation. Swipes are written from the raw text by saveReply itself; the handler updates only `message.mes` and the DOM, not swipe slots. The raw text with notes is therefore preserved in swipes and only the in-memory `message.mes` / DOM are cleaned.

**Where:** `index.js` `CHARACTER_MESSAGE_RENDERED` handler (registered via `_registerEs`), agentic loop dispatch (Phase 8b).

---

## 29. `type` Must Be Forwarded to `saveReply`

**Rule:** The `type` parameter from `onGenerate(chatMessages, contextSize, abort, type)` must be forwarded to `saveReply({ type })` for correct swipe and regen behavior.

**Why:** `saveReply` uses `type` to determine whether to create a new message or update an existing swipe. Without forwarding, regens and swipes create duplicate messages instead of replacing the current swipe.

**Guard:** `type !== 'continue' && type !== 'append' && type !== 'appendFinal'` — these types fall through to ST's generation (DLE does not handle continuation types in the agentic loop).

**Where:** `index.js` agentic loop dispatch (Phase 8b).

---

## 30. `onProse` in the Agentic Loop Is Async

**Rule:** `onProse` in the agentic loop is async and MUST be awaited: `await onProse?.(prose)`.

**Why:** `onProse` now calls `saveReply` + `saveChatConditional`, which are async operations. If not awaited, the FLAG phase starts before the message is fully created, events are processed, and data is saved to disk. This can cause race conditions where FLAG tool calls reference a message that doesn't exist yet.

**Where:** `src/librarian/agentic-loop.js` (write tool handler → FLAG phase transition).

---

## 31. Vault Review Bypass Pattern

**Rule:** `/dle-review` MUST set `skipNextPipeline = true` before calling `Generate('normal')`. The flag is consumed at the top of `onGenerate` (after quiet check, before tool-call check) and provides a clean early return.

**Why:** The vault review runs its own generation with a custom system prompt. If the DLE pipeline runs on that generation, it injects lore (wasting tokens and confusing the review AI) and potentially triggers the Librarian agentic loop (which would abort the review generation entirely and run its own loop instead).

**Where:** `src/commands/commands-ai.js` (`/dle-review` handler). `index.js` (consumption in `onGenerate` early guards). `src/state.js` (`skipNextPipeline` + setter).

---

## 32. Pipeline Status Toast Z-Index

**Rule:** `_updatePipelineStatus` prepends to `#form_sheld` (not `#chat`). `#form_sheld` must have `position: relative`. `#send_form` must have `z-index: 2`. The toast sits at `z-index: 1`.

**Why:** `translateY(100%)` is relative to the element's OWN height (~30px), not the parent's height. To fully hide the toast behind the variable-height send form, use `calc(100% + var(--bottomFormBlockSize))`. Without this, the toast peeks out below the send form on screens where `--bottomFormBlockSize` varies.

**Where:** `index.js` (`_updatePipelineStatus`, `_removePipelineStatus`). CSS in the extension's stylesheet.

---

## 33. `suppressNextAgenticLoop` Reset Placement

**Rule:** The `suppressNextAgenticLoop` flag MUST be reset in the `if (suppressNextAgenticLoop)` branch, BEFORE the `else if` agentic dispatch. Do NOT reset it in `finally`.

**Why:** The flag is a one-shot consumed-on-use control. If reset in `finally`, it would be consumed regardless of whether the `if` branch ran. But more critically, if the flag is NOT reset in the `if` branch and is instead reset only in `finally`, there's a subtle ordering issue: the `else if` agentic dispatch block has its own `finally` (with `setSendButtonState(false)` + `activateSendButtons`). If the flag were reset after the agentic dispatch's `finally`, it would work — but placing it in onGenerate's outer `finally` means it runs AFTER the agentic loop's inner `finally`, which is correct timing but wrong semantics. The flag must be consumed at the decision point where it gates the behavior, not deferred.

**Where:** `index.js` agentic dispatch section (Phase 8b). `src/state.js` (`suppressNextAgenticLoop` + setter).

---

## 34. `hierarchicalPreFilter` Uses an Independent Circuit Breaker Probe

**Rule:** When touching the circuit breaker or adding new AI callers, be aware that `hierarchicalPreFilter` acquires and releases its own `tryAcquireHalfOpenProbe()` / `releaseHalfOpenProbe()` slot independently from `aiSearch()`.

**Why:** `hierarchicalPreFilter` is optional and its success/failure should not affect the breaker state. It uses `releaseHalfOpenProbe()` on both success AND failure — it never calls `recordAiSuccess()` or `recordAiFailure()`. This means a hierarchical pre-filter failure doesn't trip the circuit, and a success doesn't clear it. Its probe slot is separate from the main `aiSearch()` call — both can be in-flight in the same pipeline pass (see the two separate `tryAcquireHalfOpenProbe()` calls, one in each function).

**Where:** `src/ai/ai.js: hierarchicalPreFilter()` and `src/ai/ai.js: aiSearch()` — each acquires its own probe.

---

## 35. `librarianPerMessageActivity` Changes Gap and Dropdown Lifecycle

**Rule:** Any code that reads `message.extra.deeplore_tool_calls` must account for whether `librarianPerMessageActivity` is ON or OFF. Its presence is NOT guaranteed.

**Why:** When OFF (default), `deeplore_tool_calls` is deleted from `message.extra` on every swipe (in `index.js` MESSAGE_SWIPED handler — per-message-activity-off branch). Librarian dropdowns are always ephemeral. Gaps accumulate across messages. When ON, tool calls and gap records persist per-message across swipes, and gaps are cleared at generation start instead. This setting changes the entire gap and dropdown lifecycle.

**Where:** `index.js` MESSAGE_SWIPED handler (per-message-activity-off branch deletes `deeplore_tool_calls`), `index.js: onGenerate()` gap-clearing branch (`persistGaps([])` when per-message-activity is on). `src/state.js` (`librarianPerMessageActivity` read via `getSettings()`).

---

## 36. Error Cause Chaining

**Rule:** Re-throws in `ai.js`, `proxy-api.js`, `obsidian-api.js`, and `agentic-api.js` use `new Error(msg, { cause: err })` to preserve original stack traces. Always check `error.cause` when debugging wrapped errors from these modules.

**`_isDebug()` in `stages.js`:** Reads `globalThis.extension_settings?.deeplore_enhanced?.debugMode` directly instead of importing `settings.js`. This preserves test isolation -- tests don't have ST globals, so `_isDebug()` returns `false` by default without requiring a mock settings module.

---

## 37. Clear Picks Must Reset All Pipeline Caches

**Rule:** The "Clear Picks" action must clear the AI search cache AND the injection log (`deeplore_injection_log`). If a new cache is added that influences entry selection, Clear Picks must clear it too.

**Why (BUG-396):** Strip-dedup uses `deeplore_injection_log` to suppress entries "already in context." If a user deletes a message and clears picks, the log still contains entries from the deleted message — strip-dedup removes them as duplicates even though the injected content is gone. The user sees entries vanish despite their keywords appearing in chat.

**Where:** `src/drawer/drawer-events.js` Clear Picks handler. The two things it must clear: (1) `aiSearchCache` — AI selection results, (2) `chat_metadata.deeplore_injection_log` — strip-dedup history. The verdict store is NOT cleared here — clearing user-visible verdict history would lose the "what did DLE choose for message #47?" affordance. Next generation's verdict supersedes the prior one naturally.

---

## 38. All `.abort()` Calls Go Through `abortWith`

**Rule:** All `.abort()` calls in DLE MUST go through `abortWith(controller, reason)` (in `src/diagnostics/interceptors.js`). Direct `controller.abort()` is forbidden. Reviewers should reject PRs that bypass it.

**Why:** `AbortSignal.reason` is read-only post-construction — only settable via `controller.abort(reason)`. `abortWith` calls `controller.abort(new DOMException(reason, 'AbortError'))` so the reason rides on native `signal.reason`. Catch blocks read `controller.signal.reason?.message` AND `externalSignal?.reason?.message` to populate `aiCallBuffer.abortReason` / `aiPromptBuffer.abortReason` and post-mortem diag exports. Direct `controller.abort()` loses post-mortem attribution — diag report shows "aborted" but not WHO fired it (timeout? popup close? user stop button? external signal? non-DLE actor?). The 2026-04-25 Emma stuck-generating bug report (`dle-diagnostics-2026-04-25T02-03-57-482Z.md`) was unresolvable for exactly this reason.

**`onExternalAbort` listeners** must propagate the upstream reason: `() => abortWith(localController, externalSignal.reason?.message || 'fallback_label')`. Stamping a generic reason on the local controller hides which upstream source fired.

**Where:** Every file that creates an `AbortController`. Current sites: `src/ai/ai.js`, `src/ai/proxy-api.js`, `src/librarian/agentic-api.js`, `src/librarian/librarian-review.js`, `src/vault/obsidian-api.js`, `src/vault/scanner.js`. `scribe.js` / `auto-suggest.js` use `generateQuietPrompt` (no abort).

---

## 39. Tool-Calling Gate Is Per-Model, Not Just Per-Source

**Rule:** `isToolCallingSupported()` MUST check the resolved model against `NO_TOOLS_MODELS` regex set, not just the chat-completion source against `NO_TOOLS_SOURCES`.

**Why:** Reasoning-only models (`deepseek-reasoner`, OpenAI `o1`/`o3`/`o4`, OpenRouter `*-r1` relays) belong to sources that DO support tool calling for their non-reasoning siblings. ST has no per-model tool gate (verified against staging `tool-calling.js`, 2026-04-24). Without the per-model check, DLE dispatches Librarian against a reasoner, the API returns no tool_calls, the loop exits with `exitReason='no_tools'`, and the model's reasoning narrative leaks into the assistant message as if it were prose. Silent failure.

**Where:** `src/librarian/agentic-api.js` — `NO_TOOLS_MODELS` regex set, `isReasoningOnlyModel(model)` predicate, `isToolCallingSupported(model?)` checks both.

**Also:** `getTextContent()` strips `<think>...</think>` blocks defensively. Thinking-capable but tool-supporting models (Claude 3.7+, deepseek-chat with thinking on, GLM-4.6) emit `<think>` tags around reasoning even when caller wants only the final reply. ST's `removeReasoningFromString` is gated on `power_user.reasoning.auto_parse` so cannot be relied upon.

---

## 40. Claude Detection Must Cover OpenRouter Relays

**Rule:** Code that gates Claude-specific REQUEST mitigations (thinking-vs-tool_choice 400 sidestep, `json_schema` skip) MUST use `isUnderlyingClaude(model)` — not `getProviderFormat() === 'claude'` and not bare `/^claude-/i.test(model)`.

**Why:** OpenRouter's source string is `'openrouter'`, so `getProviderFormat()` returns `'openai'` even for `anthropic/claude-*` models. OpenRouter forwards `reasoning.effort` to Anthropic upstream, so the same 400 ("Thinking may not be enabled when tool_choice forces tool use") fires for OR-Claude users. Json_schema also leaks because the bare regex `/^claude-/i` does not match `anthropic/claude-3.5-sonnet`.

**Where:** `src/librarian/agentic-api.js: callWithToolsViaProfile()` (`reasoning_effort` override fires for `format === 'claude' || isUnderlyingClaude()`); `src/ai/ai.js: callViaProfile()` (`isClaudeModel = isUnderlyingClaude(effectiveModel)`).

**Do NOT change `getProviderFormat()` itself** — parsing must stay OpenAI-shape for OR responses, regardless of what the underlying model is. The two helpers answer different questions: format = "how do I parse the response", underlying-claude = "what backend will run this".

---

## 41. Gemini Multi-Turn Messages MUST Be OpenAI Shape

**Rule:** `buildAssistantMessage()` and `buildToolResults()` MUST emit OpenAI-shape messages for `format === 'google'` profile mode. Native Gemini shape (`{role:'model', parts:[]}`, `{role:'function', parts:[]}`) is silently dropped.

**Why:** ST's `convertGooglePrompt()` (in `src/prompt-converters.js`) only reads `message.content` from input messages — it ignores any pre-existing `parts` array. Verified against ST staging branch 2026-04-24. If DLE pushes a `{role:'model', parts:[functionCall]}` assistant message back into the conversation, `convertGooglePrompt` sees `message.content === undefined` and emits `{role:'model', content:[{type:'text', text:''}]}`, then converts to `parts:[{text:''}]`. The tool_use round-trip is lost. Every assistant turn after the first becomes empty text. Multi-turn Librarian on Gemini is broken without this fix.

**Round-trip contract:** `parseToolCalls()` stamps a synthetic id (`gemini-{timestamp}-{rand}`) onto the raw `responseContent.parts[i]` via `_dleSyntheticId`. `buildAssistantMessage()` reads it back when constructing OpenAI-shape `tool_calls[].id`. `buildToolResults()` emits `tool_call_id` matching that id. ST's `convertGooglePrompt` builds its own `toolNameMap` from the assistant turn's `tool_calls` and resolves the function name when emitting the next `functionResponse`. If the id mapping breaks, `toolNameMap[id] === 'unknown'` and Gemini sees `functionResponse.name = 'unknown'`.

**Where:** `src/librarian/agentic-api.js` — `parseToolCalls` (id stamp), `buildAssistantMessage` (OpenAI-shape emit for google), `buildToolResults` (OpenAI-shape emit for google).

**Also:** `getTextContent()` filters `p.thought !== true` for google — Gemini 2.5/3 emit reasoning as `parts[].thought=true` which would otherwise leak into prose.

**Also:** `callWithTools()` wraps `sendRequest` in try/catch and re-throws Gemini-specific errors (`/blocked|SAFETY|RECITATION|promptFeedback|Candidate text empty/i`) as `SafetyBlockError` so callers can surface user-actionable guidance instead of generic "Generation failed".

---

## 42. Stepped Thinking Re-Entry Guard

**Rule:** When `inSteppedThinking` is true, `onGenerate()` MUST early-return BEFORE any pipeline work. The flag is set/cleared by listeners on the literal-string events `'GENERATION_MUTEX_CAPTURED'` and `'GENERATION_MUTEX_RELEASED'` (custom events from `cierru/st-stepped-thinking/interconnection.js`, not in ST's `event_types`).

**Why:** Stepped Thinking calls `Generate('normal', { force_chid })` for each thought-chain step. ST's interceptor system fires `deepLoreEnhanced_onGenerate` for those passes too — `type === 'normal'`, indistinguishable from a user turn. Without the gate: every thinking step re-runs vault search + AI scoring + Librarian dispatch, multiplying cost N× and corrupting both Stepped Thinking's output (Librarian eats it) and DLE's per-chat counters/cooldowns. Verified upstream `Generate('normal', { force_chid })` in `cierru/st-stepped-thinking/thinking/engine.js`, payload `{extension_name: 'stepped-thinking'}` in `interconnection.js` (2026-04-24).

**Where:** `index.js` — module-scope `inSteppedThinking` flag + `_steppedThinkingTimeout`; `_registerEs('GENERATION_MUTEX_CAPTURED', ...)` and `_registerEs('GENERATION_MUTEX_RELEASED', ...)` listeners; `onGenerate()` early-return after the `type === 'quiet'` guard but before `skipNextPipeline` check.

**Safety timeout:** 10s `setTimeout` clears the flag if RELEASED never fires (Stepped Thinking error path, ST update breaking the contract, etc.). Better to risk one wasted re-entry than indefinite pipeline lockout.

**RELEASED payload note:** Stepped Thinking emits RELEASED without a payload. DLE clears the flag unconditionally on RELEASED — if other extensions adopt the same mutex pattern, only stepped-thinking would have set the flag in the first place, so unconditional clear is harmless.

---

## 43. Every Post-Await Branch in the Agentic Dispatch Re-Checks Epoch

**Rule:** EVERY async branch in the Librarian agentic dispatch must re-check both `chatEpoch` and `generationLockEpoch` after each await. This applies to all THREE branches: (a) the `onProse` callback (in-loop save), (b) the post-loop `if (proseMsg)` normal path that attaches `tool_calls` and may inject the dropdown, (c) the post-loop `else if (result.prose)` fallback path that handles "AI returned prose without calling write() tool". At minimum check after `saveReply()` and after `saveChatConditional()`. If the epoch changed during the await, bail (set `proseMsg = null` in `onProse`; plain `return` in the post-loop branches).

**Why:** `saveReply` awaits `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED` handlers; either can yield long enough for the user to switch chats. Without a recheck, `chat[chat.length - 1]` is captured on the *new* active chat, then `saveChatConditional()` persists the captured ref into a chat that the user never asked to write to. The post-loop recheck at the outer try/catch isn't enough on its own — it stops further mutation but doesn't prevent a trailing `saveChatConditional()` (or `injectLibrarianDropdown`) from running on the wrong chat.

Branch-specific risks: the `proseMsg` branch (b) is partially-safe because `proseMsg` itself is a direct reference captured against the correct old chat, so the `extra.deeplore_tool_calls = ...` write is safe across a CHAT_CHANGED. BUT the subsequent `injectLibrarianDropdown(chat.length - 1, ...)` uses a `chat.length` lookup that resolves against the NEW active chat — leaking a dropdown into the wrong chat's DOM. The recheck between `await saveChatConditional()` and `injectLibrarianDropdown` covers this (F6 fix, 2026-05-22). The fallback branch (c) is more dangerous because it bypasses `onProse` entirely — its `chat[chat.length - 1]` resolution and the dropdown injection both target the new chat (F3 fix, 2026-05-22). Every new await added to this dispatch needs another guard; do not inherit guards from neighboring blocks.

**Where:** `index.js` — Librarian dispatch block: `onProse` callback (in-loop saves), the post-loop `if (proseMsg)` normal path (post-`saveChatConditional` recheck before `injectLibrarianDropdown`), and the post-loop `else if (result.prose)` fallback branch (rechecks after both `saveReply` and `saveChatConditional`). Tests: `test/regression.test.mjs` F3a–F3c (fallback branch) and F6a–F6c (proseMsg branch).

---

## 44. `MESSAGE_SWIPE_DELETED` Emits an Object Payload

**Rule:** ST emits `MESSAGE_SWIPE_DELETED` with `{ messageId, swipeId, newSwipeId }` — not a scalar `messageId`. Handlers must destructure or extract `payload.messageId` defensively.

**Why:** A handler signature like `(messageId) => ...` silently receives the entire object. Downstream operations such as `chat?.[messageId]` or `Number(messageId)` produce `undefined` / `NaN` and the handler no-ops without throwing. Symptoms: stale `perSwipeInjectedKeys` accumulate after every swipe delete, `deeplore_tool_calls` / `deeplore_sources` / `deeplore_ai_notes` cleanup never fires, `chat_metadata.deeplore_swipe_injected_keys` grows monotonically. Verified upstream emit shape in `public/script.js` (ST 1.12.x).

**Where:** `index.js` — `_registerEs(event_types.MESSAGE_SWIPE_DELETED, ...)`. Same applies to any new ST event handler — confirm the emit shape in upstream `script.js` before assuming scalar params.

---

## 45. `formatAndGroup` Title-Only Escaping Policy

**Rule:** In `formatEntry` (inside `formatAndGroup`), apply `escapeXml` to `entry.title` only. `entry.content` MUST pass through unmodified. Do not re-introduce `escapeXml(entry.content)` or any `<` / `>` / `&` / `"` substitution on content.

**Why:** Title is interpolated as the wrapper tag name (`<{{title}}>`), so unescaped `<` in a title produces an unparseable wrapper. Content is freeform text to ST, the LLM, and every downstream consumer in the injection path — there is no XML parser between `setExtensionPrompt` and the model. Vault authors intentionally embed XML, markdown, code samples, `<3`, nested tags, and ampersands in entry content; escaping clobbers all of those (issue #16). Earlier BUG-090 expanded the escape on the assumption of "downstream XML tooling" — no such tooling exists. The original pre-BUG-090 stub was paranoia about prompt-injection from `</system>`-style tokens, but vault content is author-controlled, not user-input, and ST's prompt structure is JSON-shaped, not text-parsed.

**Where:** `core/matching.js` — `formatEntry` arrow inside `formatAndGroup`. Test: `test/unit.mjs` "XML escaping in content templates: title escaped, content raw (issue #16)".

---

## 46. Verdict Store Replaces the Four Racing Globals

**Rule:** Pipeline outputs (injected sources, full trace, previous-turn diff) live on a single per-turn record in `src/verdict/verdict-store.js`. Read via `getCurrent()` / `getPrevious()` / `getByMessage()`. The legacy globals (`lastInjectionSources`, `lastPipelineTrace`, `previousSources`, `lastInjectionEpoch`) are gone — references in new code must be replaced with verdict reads. Do not reintroduce module-level globals for this data.

**Why (D-05, 2026-05-22):** The four globals raced. `lastInjectionSources` was cleared on render but `lastPipelineTrace` survived → drawer fallback chains (`lastInjectionSources ?? lastPipelineTrace?.injected`) had to be threaded through every consumer. Cartographer + drawer + `/dle-inspect` could disagree across messages because they read different globals at different epoch boundaries. Swipes left partial state behind (rollback only touched some globals). "What did DLE inject on message #47?" was unanswerable — the data was overwritten on message #48. The verdict store fixes all three: one record per turn, msgIdx-anchored, ring buffer + per-chat IDB spill (cap 200, auto-pruned).

**Storage rules:**
- In-memory ring buffer (`RING_CAP=50`) is the fast path. `getCurrent()` / `getPrevious()` read from it synchronously.
- IDB spill (`IDB_PER_CHAT_CAP=200`) is **per-chat, persistent across chat switches**. Each chat's rows survive when the user navigates away, so resume-after-reload of any prior chat replays its verdict history.
- On CHAT_CHANGED: `clearRing()` drops the in-memory ring (synchronous, no IDB touch), `setCurrentChatId(newId)` rebinds scope, `hydrateChat(newId)` async-pulls IDB rows for the destination chat. **Do NOT call `clearChat(null)` here** — that's a nuke-from-orbit helper that wipes every chat's IDB rows, which makes the 200-row per-chat spill moot and permanently breaks resume-after-reload.
- `clearChat(chatId)` (specific chatId) is for "user permanently deleted chat" flows; `clearChatIdb(chatId)` covers IDB-only removal without touching the ring.
- **NEVER** persist verdicts to `chat_metadata` — that would bloat chat files. The Roadmap explicitly rejected that variant.
- Pipeline writes ONE verdict per turn at commit (after `setExtensionPrompt` calls). Empty-injection turns still write a verdict (`injectedSources: []`) so consumers see "nothing this turn" instead of the prior verdict bleeding through.

**Trace shape note:** `trace.keywordMatched`, `aiSelected`, `cooldownRemoved`, `contextualGatingRemoved`, `gatedOut`, `stripDedupRemoved`, `budgetCut`, `refineKeyBlocked`, `probabilitySkipped`, `warmupFailed` now carry `vaultSource` on each entry (2026-05-22). The perEntry aggregator in `verdict-pure.js` requires this to honor the trackerKey invariant (vaultSource:title) under `multiVaultConflictResolution='all'`.

**CHARACTER_MESSAGE_RENDERED attachment:** The handler in `index.js` reads the current verdict and attaches `message.extra.deeplore_sources` only when `verdict.msgIdx === messageId && verdict.epoch === chatEpoch`. The `message.extra._deeplore_sources_tag` flag prevents double-attach on swipe.

**Consumer contract for historical lookups (Wave B audit fix, 2026-05-22):** UI surfaces that inspect a SPECIFIC message (the per-message "Why?" button, cartographer popup opened on an older message, anything reading `message.extra.deeplore_sources` after page reload) MUST thread the message's `msgIdx` (= `chat.length` at gen start = the rendered message's `mesid`) through to the verdict-store API. Resolve via `getByMessageSync(msgIdx, chatId)` for the message's verdict and `getPreviousForMessage(msgIdx, chatId)` for its predecessor — never compare a bare `injectedSources` array against `getCurrent()` / `getPrevious()`, which would invert the diff direction (added/removed swap) whenever the inspected message isn't the live newest one. Also: prefer `getCurrentForChat(chatId)` over the ring-global `getCurrent()` so a stale verdict from another chat in the ring can't pollute the popup. Bug history: cartographer used a conditional fallback `(_currentVerdict?.injectedSources === sources) ? diff(current, prev) : diff({injectedSources: sources}, current)` — the else branch's `(current, previous)` were semantically swapped. Regression guard: `VRD-9` / `VRD-9b` in `test/regression.test.mjs`.

**UI consumer rule (Verdict-audit M4, 2026-05-22):** Every UI render path, slash-command handler, drawer event handler, and tool runtime that reads "the current verdict" MUST resolve it as `getCurrentForChat(getCurrentChatId())`, never bare `getCurrent()`. `getCurrent()` is ring-global — returns the newest verdict for ANY chat in the ring, which leaks a stale verdict from a prior chat for ~50ms after CHAT_CHANGED (between `clearRing()` firing and `hydrateChat()` resolving). The chat-scoped variant correctly returns `null` during that window so the drawer / cartographer / `/dle-inspect` show "no verdict yet" instead of flickering the prior chat's data. Each migrated file defines a local `_currentVerdictForChat()` helper that swallows `getCurrentChatId()` throws (`try/catch → null`) — important during boot before ST internals are wired. The verdict-store API itself honors `getCurrentForChat(null)` → falls through to `getCurrent()` as a boot-window safety net. **Exempt paths (intentional bare `getCurrent`):** verdict-store internal definition; `src/diagnostics/flight-recorder.js` (captures pipeline-complete events where "newest write" IS what just completed). Migrated UI surfaces: `src/drawer/{drawer,drawer-render-tabs,drawer-render-footer,drawer-render-status,drawer-events}.js`, `src/ui/{cartographer,commands-pipeline,diagnostics}.js`, `src/librarian/librarian-tools.js`, `src/diagnostics/state-snapshot.js`. Regression guards: `VRD-13` (lint-style: no bare `getCurrent(` allowed in `src/drawer/`, `src/ui/`, `src/librarian/`, `src/diagnostics/state-snapshot.js`), `VRD-13b` (null-chatId fallback), `VRD-13c` (cross-chat flicker scenario) in `test/regression.test.mjs`.

**Hydrate/write race (F2 fix, 2026-05-22):** `hydrateChat(chatId)` MUST NOT clobber verdicts that arrived in the ring while it was awaiting IDB. CHAT_CHANGED dispatches `clearRing() + setCurrentChatId(new) + hydrateChat(new)` (async); if the user triggers Generate before hydration resolves, `onGenerate` calls `writeVerdict` synchronously and the fresh verdict lands in the ring. The pre-fix code did `ring = ring.filter(v => v.chatId !== chatId); ring.push(...slice)` — which deleted the fresh write, so `getCurrent` / `getCurrentForChat` / `getByMessageSync` all lost that turn's verdict. Fix (Option A — merge instead of replace): preserve any ring entry for this chat whose `ts` is newer than the freshest hydrated `ts` and re-append at the tail. Ordering after merge: other chats unchanged → chronological hydrated slice → preserved-fresh at tail (so backward scans find the live verdict first). Regression guard: `VRD-9c` in `test/regression.test.mjs`.

**Where:** `src/verdict/verdict-store.js` (live, exports `getCurrent` / `getCurrentForChat` / `getPrevious` / `getPreviousForMessage` / `getByMessage` / `getByMessageSync`), `src/verdict/verdict-pure.js` (testable helpers), `src/vault/cache.js` (shared IDB `DeepLoreEnhanced` schema v2). Consumer call sites: drawer (`drawer-render-tabs.js` / `-status.js` / `-footer.js` / `drawer.js` / `drawer-events.js`), `src/ui/cartographer.js`, `src/ui/commands-pipeline.js` (`/dle-inspect`), `src/ui/diagnostics.js`, `src/librarian/librarian-tools.js`, `src/diagnostics/flight-recorder.js`, `src/diagnostics/state-snapshot.js`. Tests: `test/verdict.test.mjs` (70 pure-helper), regression VRD-1..VRD-9c + VRD-13/13b/13c.

---

## 47. i18n Hooks Into ST's Built-in System — Do Not Roll Your Own

**Rule:** All UI translation goes through `src/i18n/i18n.js` which wraps ST's `addLocaleData()` / `t``\` / `translate()` / `getCurrentLocale()` from `public/scripts/i18n.js`. Locale dicts live at `locales/dle.{lang}.json` (UI) and `src/i18n/prompts/{lang}.js` (AI-facing). English is canonical; the six translations (es-es, fr-fr, de-de, ja-jp, zh-cn, ru-ru) are machine-translated and refined by the community.

**Why (v2.5 i18n rollout, 2026-05-22):** ST already has a `data-i18n="key"` MutationObserver that auto-translates injected DOM as soon as a key matches its locale dict. Rolling our own observer would (1) double-fire on every node ST already handles, (2) miss the ST-shipped UI chrome around our extension, and (3) force a second locale-switcher UI. Hooking ST's system means a user who switches ST to Spanish gets DLE in Spanish "for free" — no separate setting, no second reload.

**Boot order (matters):** `initDleI18n()` runs in `index.js` jQuery handler **before** `renderExtensionTemplateAsync('settings')` and before `createDrawerPanel()`. If we registered locale data AFTER inserting `data-i18n` attrs, ST's MutationObserver would fire once with no dict and never re-run for those nodes. Register first; insert HTML second.

**Fallback chain:**
- Requested locale (ST current locale, or override) → base lang (`es` → `es-es`) → `en`.
- Per-key: target dict → EN dict → `translate(key)` (ST's missing-key tracker) → key itself.
- Result: a partially-translated locale never shows raw `dle_xxx_key` strings to users.

**AI prompts are a separate axis:** Setting `aiPromptLocale` (default `''` = follow UI locale) overrides which `src/i18n/prompts/{lang}.js` ships to the LLM. Users on UI=ja-jp can keep `aiPromptLocale='en'` if they don't trust machine-translated prompts to preserve LLM behavior. `resolveAiPromptLocale()` in `i18n-pure.js` codifies precedence: setting → override → UI → 'en'.

**Placeholders:** ST's `t``\` requires `${0}`, `${1}` indexed placeholders — not named, not bare `{0}`. Recon-to-JSON pipeline normalized all 348 interpolations; Pass 3 audit caught 44 cart-diag.json violations and Pass 4 fixed them. Translation pipeline must preserve placeholder count + index per string. `placeholderMismatch()` in `i18n-pure.js` validates source-vs-translation.

**Plurals split into key pairs:** ST's `t``\` doesn't do CLDR plural rules. The recon pass captured 10 strings with embedded JS ternaries (e.g. `"${0} entr${0 === 1 ? 'y' : 'ies'}"`). Nine became simple `_one` / `_other` pairs; one nested ternary (`dle_entries_stat_title`) split into 4 keys (`_lore_one/_other` + `_vault_one/_other` — call site concatenates). Net +10 keys vs source, total 2097 in `locales/dle.en.json`. Consumers must select the right key at runtime: `const k = count === 1 ? 'dle_x_one' : 'dle_x_other'; tr(k)`.

**Machine-translation coverage:** Wave 5 (Haiku) hit 0.5-4.8% UI coverage due to output-token cap. Wave 5b (Opus, 2 chunks per Romance lang to respect 64K output cap) hit **95.8-97.3% real-translation coverage** per locale (es-es 95.8%, fr-fr 95.9%, de-de 95.8%, ja-jp 97.0%, zh-cn 97.3%). Remaining 2.7-4.2% are intentional pass-throughs: brand names ("DeepLore Enhanced", "Emma", "SillyTavern", "Obsidian", "Claude"), config identifiers (`lorebook-guide`, `update_draft`, file paths), tech loanwords valid in target lang (JSON, PNG, HTTPS, AI), pure-markup label fragments (`<b>${0}</b>: ${1}`), and URLs. AI prompt files (`src/i18n/prompts/{lang}.js`, 30 exports + `__meta`) are 100% translated per locale. All tagged `machine_translated: true` + `translator_model: 'claude-opus'` in `__meta`. Untranslated keys still fall back to English via `mergeLocaleDicts()`.

**Where:** `src/i18n/i18n.js` (live ST integration), `src/i18n/i18n-pure.js` (pure helpers + tests), `src/i18n/prompts/{lang}.js` (AI prompt dicts), `locales/dle.{lang}.json` (UI dicts). Init call: `index.js` jQuery handler. Setting: `aiPromptLocale` in `settings.js`. Tests: `test/i18n.test.mjs` (88 assertions, includes canonical-file sanity checks for bare `{N}` and ternary leakage). Community process: wiki page `Contributing-Translations.md`, issue template `.github/ISSUE_TEMPLATE/translation_feedback.md`.

---

## 48. Reuse-Sync Must Honor Partial-Fetch Flags (V-C1)

**Rule:** `buildIndexWithReuse()` MUST treat `data.partial === true` and `isPartialFetchFailure(data.failed, data.total)` the same way `buildIndex()` does — and `finalizeIndex()` MUST be called with `skipCacheSave: true` whenever ANY vault returned partial data this cycle. The earlier code passed neither flag through, so a transient Obsidian REST glitch could silently truncate the IDB cache and wipe trackers/cooldowns/pins on next hydrate.

**Failure mode (the actual bug, ship-blocker V-C1 / 2026-05-22):**
1. Obsidian REST returns a partial directory listing (`data.partial: true`) — recursive `listAllFiles` couldn't walk every subdir due to a transient error.
2. Reuse-sync's loop counts every file missing from `data.files` as "removed" (`hasChanges = true; removedCount++`).
3. `setVaultIndex(dedupedEntries)` commits the truncated index in memory.
4. `finalizeIndex(..., {})` runs WITHOUT `skipCacheSave` → `saveIndexToCache(entries)` writes the truncated set to IDB.
5. Next hydrate loads the incomplete cache. The analytics-prune at `finalizeIndex` L218-227 walks `settings.analyticsData` and deletes any key whose `trackerKey` isn't in the current index — silently dropping cooldowns, decay state, pin/block trackers for entries that were never actually deleted.

**Mitigation:**
- `classifyReuseFetch(data)` in `src/vault/vault-pure.js` is the single source of truth — returns `{action, carryForward, skipCacheSave}`. Used by both the reuse-sync loop (per-vault dispatch) and indirectly by tests.
- Three failure actions all set `skipCacheSave: true` (test `J10` pins this invariant): `invalid` (non-array `data.files`), `partial` (truncated listing), `partial_failure` (high per-file failure rate).
- `buildIndexWithReuse()` passes `skipCacheSave: anyVaultFailed` to `finalizeIndex()` — `anyVaultFailed` is sticky across the vault loop, so a single partial vault protects the whole rebuild's IDB write.

**Asymmetry note:** The original comment at the `finalizeIndex` call site claimed reuse-sync could *always* persist because it carried forward failed vaults. That reasoning is incomplete — the carry-forward covered the entries-array but not the cache-write decision, and partial-listing cases weren't covered by carry-forward at all. The fix removes the asymmetry: reuse-sync now treats cache safety the same way as `buildIndex()`.

**Where:** `src/vault/vault.js: buildIndexWithReuse()` — per-vault partial / partial_failure branches in the fetch loop, and the `skipCacheSave: anyVaultFailed` arg in the final `finalizeIndex` call. `src/vault/vault-pure.js: classifyReuseFetch()` + `PARTIAL_FETCH_FAILURE_THRESHOLD`. Tests: `test/vault.test.mjs` section J (12 V-C1 guards).

---

## 49. Import Dedup Existence Check Must Fail Loud on Network Errors (V-C2)

**Rule:** `_findUniquePath()` in `src/vault/import.js` MUST return `null` on ANY existence-check failure (AbortError or otherwise). The classifier `classifyDedupProbe(fetchResult, err)` in `src/vault/vault-pure.js` is the single source of truth — any error path yields `{accept: false, taken: false}`. Callers (`importEntries`, `upsertConvertedEntry`) MUST then surface a skip/error rather than overwrite.

**Failure mode (ship-blocker V-C2 / 2026-05-22):**
1. User imports a World Info JSON. A file with the same name already exists in their vault.
2. The dedup walker calls `obsidianFetch` to check if `Foo_imported.md` exists.
3. The network glitches mid-flight — `fetch` throws `TypeError: Failed to fetch` (or a DNS error, or a non-Abort timeout).
4. The old `catch (err) { ... return candidatePath; }` returned the candidate path "assume free."
5. The caller's `writeNote(...)` then PUT the new content to `Foo_imported.md` — silently overwriting the user's existing vault file. The behavior was exactly inverted from what a dedup helper should do.

**Mitigation:**
- `classifyDedupProbe(fetchResult, err)` returns three outcomes: `{accept:true, taken:false}` (free), `{accept:false, taken:true}` (advance suffix), `{accept:false, taken:false}` (inconclusive — bail).
- Inconclusive states MUST NOT produce a candidate path. Test `K10` pins that all error variants (Abort, network, timeout, DNS) return inconclusive.
- Callers handle the null return by skipping the file with an error message that names all three possible causes (network, abort, cap-exhausted) so the user can diagnose.

**Where:** `src/vault/import.js: _findUniquePath()` (uses `classifyDedupProbe` internally) + the two call sites in `importEntries()` (L107 region) and `upsertConvertedEntry()` (L188 region). `src/vault/vault-pure.js: classifyDedupProbe()`. Tests: `test/vault.test.mjs` section K (10 V-C2 guards).

---

## 51. `verdictMsgIdx` Must Anchor on Global `chat`, Not Filtered `chatMessages`

**Rule:** When capturing `verdictMsgIdx` at the top of `onGenerate`, use the global `chat` array length, NOT the `chatMessages` interceptor parameter length. The verdict's `msgIdx` must equal the `messageId` that `CHARACTER_MESSAGE_RENDERED` will later fire with.

**Why (F4 fix, 2026-05-22):** `chatMessages` is ST's FILTERED `coreChat` copy (gotcha #26). For some generation modes (regen with trailing `is_system` continuation marker, certain group-chat / hidden-message scenarios), `chatMessages.length !== chat.length`. Meanwhile, `saveReply` pushes onto the GLOBAL `chat` array; `CHARACTER_MESSAGE_RENDERED` fires with `messageId === chat.length - 1` (post-push) which equals `chat.length` (pre-push). The render handler at `index.js` checks `v.msgIdx === messageId && v.epoch === chatEpoch` before attaching `deeplore_sources`. On mismatch, attachment silently skips — no console error, no toast. Symptoms: Cartographer popup and drawer Why? tab show no sources for some generations despite the verdict being correctly written. This defeats the entire msgIdx-anchored lookup model the verdict refactor introduced (#46).

**Where:** `index.js: onGenerate()` — `const verdictMsgIdx = Array.isArray(chat) ? chat.length : -1;`. The handler that consumes it: `index.js` CHARACTER_MESSAGE_RENDERED listener (matches `v.msgIdx === messageId`). Test: `test/regression.test.mjs` F4 case.

---

## 50. `trackerKey` Drift — Bare Title Fallbacks Are a Regression Class

**Rule:** EVERY Map/Set keyed by entry identity in any pipeline, drawer, librarian, or ai-search code path MUST use `trackerKey(entry) = ${vaultSource || ''}:${title}` (or the lowercase-tail variant `${vaultSource || ''}:${title.toLowerCase()}` for case-insensitive lookups). Bare `entry.title` keys silently collapse same-titled cross-vault entries into one slot. Any `<entry>.title` in pipeline trace objects (`keywordMatched`, `aiSelected`, `cooldownRemoved`, `contextualGatingRemoved`, `gatedOut`, `stripDedupRemoved`, `budgetCut`, `refineKeyBlocked`, `probabilitySkipped`, `warmupFailed`, **`injected`**) MUST carry `vaultSource` so downstream perEntry aggregation honors the invariant.

**Why (BUG-AUDIT v2.5 cross-cutting fix, 2026-05-22):** This is the highest-conviction systemic bug class in the v2.5 audit. The contract in CLAUDE.md ("ALWAYS use `trackerKey` for Map keys; bare titles collide") has been re-stated multiple times, yet drifted across at least 10 sites in 6 modules. Each new feature reintroduced the bare-title pattern because the local code "just needed a quick title lookup." The fix below patched every known site; this entry exists to catch the next regression at code-review time.

**Ten sites that drifted (all fixed in this wave — see tests `MV-1..MV-11`):**
1. `src/drawer/drawer-render-tabs.js` — `injectedSet.add(s.title.toLowerCase())` collapsed Alice@vault-a + Alice@vault-b (Browse tab + virtual-scroll window). Now uses `${vaultSource || ''}:${title.toLowerCase()}`.
2. `src/librarian/librarian-tools.js` — `searchLore()` dedup `injectedTitles` set was bare-title; vault-B's "Alice" was suppressed when vault-A's "Alice" was injected.
3. `index.js` `trace.injected` lacked `vaultSource` — fallback chain on drawer (when injectedSources is empty but trace.injected isn't) lost the disambiguator.
4. `src/stages.js: applyStripDedup` + `index.js` log writer — strip-dedup key omitted `vaultSource`. A Castle@A injected last turn falsely suppressed Castle@B this turn.
5. `src/pipeline/match.js` — `titleMap = new Map(entries.map(e => [e.title.toLowerCase(), e]))` was last-vault-wins for cascade_links + characterContextScan. Now uses `Map<title, Entry[]>` and unions across vaults.
6. `src/ai/ai.js` AI search — manifest XML uses bare `name="title"` attribute (single tag for same-titled cross-vault entries). The post-response walk already pushes both vault entries when the AI selects that title (linear iteration of `indexToSearch`); this is the safe behavior, kept stable. Manifest-level vault disambiguation would require a prompt-format change across all 6 locales — **deferred to a future major release**.
7. `src/stages.js: applyRequiresExcludesGating` — `activeTitles = new Set(result.map(e => e.title.toLowerCase()))` collapses cross-vault titles. **DOCUMENTED LIMITATION** (test `MV-7`): `requires: ["Castle"]` in vault B's entry IS satisfied by vault A's "Castle". Don't change semantics — author-written `requires`/`excludes` are bare titles by convention. If author wants vault-scoped requires, future work would extend frontmatter syntax (e.g. `Title@VaultName`).
8. `src/stages.js: applyRequiresExcludesGating` sort tiebreak — bare `a.title.localeCompare(b.title)` was non-deterministic across vaults for same-title same-priority entries. Now uses secondary `vaultSource` tiebreak.
9. `src/helpers.js: buildCategoryManifest` — sample list joined bare titles, showing "Alice, Alice" to the AI for cross-vault duplicates. Second occurrence now suffixed with `@vaultSource`.
10. `src/stages.js: applyPinBlock` — `matchedKeys.set(entry.title, '(pinned)')` lost pin reason for the second vault's same-titled entry. Now uses `trackerKey(entry)`.

**Cross-cutting changes:**
- `matchEntries` (`src/pipeline/match.js`) now writes ALL `matchedKeys.set()` with `trackerKey(entry)` (constants, bootstrap, keyword, cascade, fuzzy, recursion, active-character).
- `runPipeline` (`src/pipeline/pipeline.js`) reads/writes matchedKeys via `trackerKey()` everywhere (AI selections, wiki-link expansion, constant/bootstrap fillers).
- Consumers — `index.js`, `src/ui/commands-pipeline.js` — read `matchedKeys.get(trackerKey(e))`.
- `categorizeRejections(trace, injectedKeys)` (`src/helpers.js`) now takes a Set of trackerKey-shape strings and emits `vaultSource` on output entries. Callers in `src/drawer/drawer-render-tabs.js` and `src/ui/cartographer.js` build the Set as `${vaultSource || ''}:${title.toLowerCase()}`.
- `trace.injected` mapper in `index.js` includes `vaultSource: e.vaultSource || ''`.

**Backward compatibility:** Single-vault setups have `vaultSource === '' || undefined` everywhere. The key `:title` matches itself and does NOT collide with `MyVault:title`. Legacy `deeplore_injection_log` rows written before this fix (no `vaultSource`) compare as `:title` — they still match new entries from single-vault setups, but will NOT match entries from a named vault. This is intentional: a vault rename or re-import should NOT trigger phantom dedup against pre-rename injections.

**Where (regression guards):** `test/regression.test.mjs` `MV-1..MV-11` cover every site listed above. `test/vault.test.mjs` covers the broader multi-vault dedup contract. Any new code touching pipeline trace, drawer state, librarian dedup, or ai-search match resolution MUST add a corresponding `MV-N` guard before landing.

---

## 52. Verdict `pruneCurrentChat` Is Sampled — Cap Is A Soft Limit

**Rule:** `pruneCurrentChat()` (in `src/verdict/verdict-store.js`) does NOT scan IDB on every `writeVerdict`. It increments a module-scope counter (`pruneCallCount`) and only actually scans every `PRUNE_SAMPLE_RATE`'th call (default N=10). Between scans the per-chat IDB store may temporarily contain up to `IDB_PER_CHAT_CAP + N - 1` rows (default 200 + 9 = 209). This is intentional. Do NOT add code that depends on the cap being a hard ceiling.

**Why (Wave C P1 perf fix, 2026-05-22):** The pre-fix implementation called `store.getAll()` on EVERY generation, deserializing every verdict for every chat in the IndexedDB store, then JS-filtering by chatId. Cost was 3-10 ms baseline and 50+ ms on power-user multi-chat installs with many stored verdicts — paid unconditionally even when no prune was needed. The fix is two-pronged:

1. **Counter-based sampling.** 90% of calls now no-op the scan entirely. Worst-case the chat sits at cap+9 between scans; the next scan trims it back down. Cap is a soft limit, not a hard ceiling.

2. **Bounded key-only cursor.** When a scan does run, it uses `store.openKeyCursor(IDBKeyRange.bound(chatId+':', chatId+':￿'), 'next')` to walk oldest-first, collecting keys only — no value deserialization, scoped to the current chat. The key shape `${chatId}:${paddedMsgIdx}:${ts}` from `buildIdbKey` makes this safe. Victims are selected by `selectPruneVictimsFromOrderedKeys(keys, cap)` — the leading slice of an oldest-first list.

**Soft-limit consequences:**
- Tools that introspect IDB row counts must NOT assert `count <= IDB_PER_CHAT_CAP`. Use `<= IDB_PER_CHAT_CAP + PRUNE_SAMPLE_RATE - 1` as the upper bound.
- `clearChat(chatId)` and `clearChatIdb(chatId)` still touch every row for the target chat (no sampling). They use `listIdbForChat()` which performs an unconditional `getAll()` scoped to the chat — fine because they're rare admin ops, not per-generation.
- `hydrateChat` still uses `listIdbForChat()` (`getAll()`). That's correct — hydration needs every row to sort/slice. Don't sample hydration.

**Test override:** `_setPruneSampleRateForTests(rate)` exists so tests can force `rate=1` (scan every call) or `rate=N` to assert sampling behavior. Production code MUST NOT call it. `resetForTests()` re-snaps the rate to 10.

---

## 53. PM-mode Registration Requires `promptManager.activeCharacter` — Boot Without a Character Used To Silently Fail

**Rule:** When `injectionMode === 'prompt_list'`, the four named PM entries (`deeplore_constants`, `deeplore_lore`, `deeplore_notebook`, `deeplore_ai_notepad`) can only be inserted into the per-character prompt order map once `promptManager.activeCharacter` is set. The base `addPrompt()` call works without an active character (orphans live in `promptManager.serviceSettings.prompts`), but they will NOT render in the PM UI and won't be selectable until they're added to a character's order — which is gated on `activeCharacter`.

**Why (BUG-PM1 fix, 2026-05-22):** Old `index.js` PM-init flow polled every 1s with a 10s ceiling, then `clearInterval` and silent exit. If the user booted ST without an auto-loaded character (very common — fresh ST install, after using the No Character placeholder, group-chat boot states), `promptManager.activeCharacter` stayed null for the full 10s and registration silently aborted. First gen post-character-select would fall through to `extension_prompts` mode (no PM entries to fill, so lore appeared at ST's default IN_PROMPT position — NOT where the user dragged the entries in PM, because the entries didn't exist). The CHAT_CHANGED handler at L2174 partly mitigated this by re-registering on chat switch, BUT only when both `injectionMode === 'prompt_list'` AND `promptManager?.activeCharacter` — and `CHAT_CHANGED` doesn't always fire when a user picks a character with no existing chat.

**Three-prong fix (`index.js`):**

1. **Refactored** the registration body to a single idempotent module-level helper, `ensurePmEntriesRegistered()` — returns `true` when promptManager is ready AND activeCharacter is set (full success), `false` when caller should retry. Shared by init, CHAT_CHANGED, CHAT_LOADED, and the background latch — so a single regression in registration logic surfaces in all four call sites at once instead of drifting.

2. **Surface the deferral.** On the 10s ceiling exhausting without success, `dedupWarning('PM-mode init deferred — pick a character to finish registering DLE prompts.', 'pm_init_deferred', ...)` fires exactly once per dedup window. Toast wording is intentionally action-guiding (tells the user what to do), not error-laden — this is an expected boot state for some users, not a failure.

3. **Background latch.** `_startPmRegistrationLatch()` runs every 5s with a 5-minute cap. Self-cancels when `injectionMode` is flipped away from `prompt_list` (so settings-flip mid-wait doesn't leak the timer for 5min) and when `_teardownDleExtension()` runs (so re-init doesn't accumulate latches). The 5-min cap matters: users who never pick a character within 5min of boot are extremely unlikely to ever generate, so unbounded polling would be a long-tail leak.

4. **CHAT_LOADED listener.** `event_types.CHAT_LOADED` (`'chatLoaded'`) fires when ST loads a character with its chat — covers the case where a user picks a character but no CHAT_CHANGED fires (e.g. resuming the same chat that was loaded at boot). The handler is a cheap settings-read + `ensurePmEntriesRegistered()` call — safe to attach unconditionally.

**Idempotency contract:** `ensurePmEntriesRegistered()` is safe to call any number of times. It uses `getPromptById()` to detect existing rows, patches legacy fields in-place (`role`, `extension`, friendly display names), and inserts into the order map only via `!order.find(e => e.identifier === id)` guard — never double-inserts.

**Where:** `index.js` `ensurePmEntriesRegistered()` (top-level helper, near `_teardownDleExtension`), init() PM-mode block, CHAT_CHANGED handler PM-re-register block, init() CHAT_LOADED listener. Test: `test/regression.test.mjs` `PM-1..PM-4b`.

**Where:** `src/verdict/verdict-store.js` (`pruneCurrentChat`, `PRUNE_SAMPLE_RATE`, `pruneCallCount`, `_setPruneSampleRateForTests`, `_getPruneStatsForTests`, `_invokePruneForTests`). Pure helpers in `src/verdict/verdict-pure.js` (`shouldRunPruneScan`, `selectPruneVictimsFromOrderedKeys`). Regression tests: `VRD-10` (sampling) + `VRD-11` (bounded cursor) + `VRD-12` (under-cap no-deletes) in `test/regression.test.mjs`; pure-helper coverage in `test/verdict.test.mjs`.

---

## 66. `searchLoreAction` Returns Structured `{text, titles}` — NEVER Regex `### ...` Out Of The Text

**Rule:** `searchLoreAction()` in `src/librarian/librarian-tools.js` returns `{ text: string, titles: string[] }` (with `toString()` / `Symbol.toPrimitive` back-compat coercion to `text`). Callers that need the authoritative matched-entry list MUST read `.titles` directly. Do NOT regex-extract `### (.+)` headings from `.text` — vault content is freeform Markdown, and entries routinely have their own `### Section`, `### Stats`, `### Background` subheadings. Regex-parsing inflates counts and pollutes the Activity dropdown with section names that don't exist as entries.

**Why (CRIT-LIB-2, 2026-05-22):** The pre-fix agentic-loop did `[...searchResult.matchAll(/^### (.+)$/gm)].map(m => m[1])`, then `.filter(t => t !== 'Related entries:')`. Two problems: (a) every `### Section` inside vault content was falsely added as a "result title", causing the librarian Activity dropdown to claim 4-5 matches when only 1 entry was actually surfaced; (b) the literal-string filter `!== 'Related entries:'` broke under any locale change — translated `### Verwandte Einträge:` / `### 関連エントリ:` headings sailed straight into the title list. Both vanish under the structured return: `.titles` is built from `bestHit.title + linked.map(le => le.title)` in `searchLoreAction`, locale-agnostic and section-heading-immune by construction.

**Defensive coercion:** Callers should still tolerate a legacy bare-string return (`typeof r === 'string' ? r : r?.text ?? ''` for text, `Array.isArray(r?.titles) ? r.titles : []` for titles). Belt-and-suspenders against future regressions.

**Where:** `src/librarian/librarian-tools.js` (`_searchResult` helper + every return in `searchLoreAction`). Consumer: `src/librarian/agentic-loop.js` `case 'search'` block. Regression tests: `LIB-2a..LIB-2e` in `test/regression.test.mjs`.

---

## 54. `onProse` Throw Must Not Lose Paid-For Prose

**Rule:** Inside the agentic loop's `case 'write'` block, `await onProse?.(prose)` MUST be wrapped in a try/catch. On failure, the loop returns `{ prose, toolActivity, usage }` immediately with `prose` populated — never let the throw propagate to index.js's outer catch, which would (a) skip the fallback save branch because `proseMsg` was not yet captured, and (b) surface a generic "Generation failed — try again or disable Librarian" toast over an LLM response the user already paid for.

**Why (CRIT-LIB-3, 2026-05-22):** In the pre-fix code, if `await saveReply()` or `await saveChatConditional()` inside the `onProse` callback threw (disk full, IDB locked, ST internal error, transient race), the throw propagated up through `runAgenticLoop`, into the index.js try/catch at L1281. In that catch, `proseMsg` is null because its assignment (L1199) happens AFTER the failing await. The path then fell through to the generic `dedupError('Generation failed — try again or disable Librarian.')`, telling the user to retry — but the LLM had already generated valid prose and consumed tokens. The prose was lost behind a misleading error.

**Fix design — preserve prose via either dispatch branch:**
- The wrapping try/catch keeps `prose` and `writeDone` set, then `return { prose, toolActivity, usage }` from inside the iteration.
- If onProse failed BEFORE `proseMsg` was captured (saveReply threw): `proseMsg` is null in index.js → the `else if (result.prose)` fallback branch runs `saveReply()` itself. Fallback branch is already F3-hardened with epoch guards.
- If onProse failed AFTER `proseMsg` was captured (saveChatConditional threw mid-await): `proseMsg` is set in index.js → the `if (proseMsg)` primary branch runs, retries `saveChatConditional()`, with F6 epoch guard between save and dropdown injection.

Either way, the user's prose lands in chat and tool_calls get attached. The pushEvent log records `onProse_error` with the failing error message so diagnostics still surfaces the underlying issue.

**Where:** `src/librarian/agentic-loop.js` — `case 'write'` block, the `try { await onProse(prose); } catch { ... return {...} }` wrapper. The two consumer branches at `index.js: 1239` (`if (proseMsg)`) and `index.js: 1256` (`else if (result.prose)`) already exist; this fix routes prose to whichever branch the onProse partial state dictates. Regression tests: `LIB-3a..LIB-3e` in `test/regression.test.mjs`.

---

## 55. `finalizeIndex` Incremental Derived-State Updates (P3)

**Rule:** When modifying `finalizeIndex`, `computeDerivedIndexFields`, BM25 construction, or `computeEntityDerivedState`, ANY change to the full-rebuild math MUST also be reflected in the incremental helpers in `src/vault/vault-incremental.js` (`incrementalMentionWeights`, `incrementalBM25Update`, `incrementalEntityRegexes`) AND the `fullMentionWeights` reference implementation used by the equivalence tests. Drift = silent ranking corruption (BM25) or wrong mention scores that degrade quality invisibly.

**Why (P3 perf fix, Wave C / 2026-05-22):** `finalizeIndex` is called on every `buildIndexWithReuse` tick, but its full rebuild is O(N²) for mentionWeights (every source × every target), O(N) for BM25 tokenization + O(M) IDF, and O(N×K) for `entityShortNameRegexes`. On a 500-entry vault that's ~100-500ms per sync-poll-with-changes. With incremental updates the cost is proportional to changed entries (~5-20ms typical).

**Two-path architecture:**
- `buildIndexWithReuse()` passes `previousEntries: indexSnapshot` to `finalizeIndex()`. `buildIndex()` and `hydrateFromCache()` do NOT — they always full-rebuild (cold start has no prior derived state to delta against, and full rebuilds are unconditional anyway).
- Inside `finalizeIndex`, three derived-state computations check `shouldUseIncremental(changedCount, totalCount)` (default threshold 50% — anything above and the bookkeeping overhead exceeds the savings).
- Incremental paths still call the same state setters (`setMentionWeights`, `setEntityShortNameRegexes`, `setFuzzySearchIndex`). The `entityRegexVersion` bump (BUG-394 / AI cache invalidation) is preserved because `setEntityShortNameRegexes` still fires.

**Correctness invariant:** For the same final entry set, full and incremental paths MUST produce byte-equivalent output:
- Same `mentionWeights` Map (same keys, same counts).
- Same BM25 index (`docs.size`, `idf` values within 1e-9, `invertedIndex` postings, `avgDl`).
- Same `entityNameSet` Set + same regex sources/flags (RegExp identity preserved via `prevRegexes` reuse for surviving names — this is what makes the path actually cheap).

**Where:** `src/vault/vault.js: finalizeIndex()` + `computeDerivedIndexFields()` (incremental dispatch + full-rebuild fallback). `src/vault/vault-incremental.js` (pure helpers). `src/vault/bm25.js` (unchanged — full builder still used by `hydrateFromCache` + the fallback). Tests: `test/vault.test.mjs` section L (13 equivalence + threshold + rename + defensive-fallback guards, including `L1` mentionWeights mod / `L4` BM25 mod / `L7` entity regex parity / `L8` threshold / `L11` rename orphan cleanup).

---

## 56. Drawer Dismiss Handler Must Exempt Clicks Inside ST Popups

**Rule:** The drawer's `click.dle-drawer-dismiss` outside-click handler MUST bail when the click target lives inside any `<dialog class="popup">` (callGenericPopup), `dialog[open]`, `.toast`, `.toast-container`, or `.ui-dialog` — not just `#deeplore-panel`.

**Why:** ST's `callGenericPopup` clones `#popup_template` (which contains `<dialog class="popup">`) and appends it to `document.body` — NOT inside the drawer. The naive "click is outside `#deeplore-panel`" check fires `true` for every click inside a popup spawned from the drawer (rule-builder edit chip, vault-scan, optimize-keys review, "Why not?" diag, gating folder picker, settings-popup confirms, etc.). In overlay mode with no pin, this closed the drawer behind the popup on the user's first click inside the modal. After the dialog closed, the drawer was gone — surprise loss of context.

**Where:** Bail conditions live in `src/drawer/drawer-dismiss-pure.js: shouldBailDrawerDismiss()`. Consumed by the `$(document).on('click.dle-drawer-dismiss', …)` handler in `src/drawer/drawer.js` (`createDrawerPanel()`).

**Selectors and rationale:**
- `dialog.popup, .popup` — ST's `callGenericPopup` base class. Subclasses (`.popup--input`, `.popup--confirm`, `.wide_dialogue_popup`) all inherit from it.
- `dialog[open]` — covers any native `<dialog>` opened via `showModal()` even without `.popup` class (third-party extensions, future ST popups).
- `.toast, .toast-container` — toastr notifications. Many are click-to-dismiss; even ones that aren't must not close the drawer behind them.
- `.ui-dialog` — legacy jQuery-UI dialogs (still surfaces in a few corners of ST).

**Defense in depth:** the helper also calls `document.querySelector('dialog[open]')?.contains(target)` so polyfilled / oddly-classed dialogs still match.

**Regression test:** `test/regression.test.mjs` — `DRAWER-DISMISS-1..4` cover the popup-bail (don't dismiss), drawer-toggle bail (don't dismiss), chat-area click (DO dismiss), and missing-panel defensive return.

---

## 57. Frontmatter Parsing MUST NOT Pollute Object.prototype (V-H3)

**Rule:** `parseFrontmatter()` in `core/utils.js` builds the frontmatter container via `Object.create(null)` — a prototype-less object. Any future refactor that switches back to a plain object literal (`const frontmatter = {}`) re-opens the prototype pollution attack. The frontmatter object MUST have `null` prototype.

**Why (V-H3 ship-blocker / 2026-05-22):** The YAML key regex at `core/utils.js:58` (`/^(\w[\w.-]*)\s*:\s*(.*)/`) matches `__proto__`, `constructor`, and `prototype`. With a plain object, `frontmatter['__proto__'] = value` invokes the inherited `__proto__` setter from `Object.prototype` and replaces the object's prototype chain — or with nested YAML like `__proto__:\n  - pwned`, the array assignment lands as a property on `Object.prototype` itself, visible from EVERY object in the JS process. Vault content is user-controlled and Cartographer / import flows can pull from third-party sources (companion-extension JSON, raw GitHub vault dumps, community-shared lorebooks). One hostile frontmatter file = global state corruption affecting unrelated code across DLE, ST core, and every other ST extension.

**Why Object.create(null) is sufficient (not paranoid):**
- `Object.create(null)` has no prototype chain, so there's no inherited `__proto__` setter to invoke. Direct assignment `frontmatter['__proto__'] = x` creates a regular own property called `__proto__` on the prototype-less object — no chain mutation.
- Same for `constructor` and `prototype` — no inherited accessor to trigger.
- Downstream consumers (`core/pipeline.js`, `src/ui/popups.js:775`, `src/ui/commands-admin.js:168`) use `Object.keys(frontmatter)`, `Object.entries(frontmatter)`, explicit `typeof`/`===` checks, and `Object.prototype.hasOwnProperty.call(frontmatter, key)` — all of which work correctly on prototype-less objects.
- `JSON.stringify(Object.create(null))` returns `'{}'` (Node and all major engines), so the test runner's `assertEqual` (which uses `JSON.stringify(a) === JSON.stringify(b)`) still works.
- Regression test `parseFrontmatter: no frontmatter` checks `Object.keys(frontmatter).length === 0` — passes on prototype-less.

**What this does NOT protect against:** an attacker who controls vault content can still write arbitrary YAML keys into frontmatter (e.g. `evil_key: <script>`). Frontmatter values pass through type coercion + string-escape on the consumer side; this gotcha covers only the global-prototype-corruption attack, not content-injection per se.

**Where:** `core/utils.js: parseFrontmatter()` — the `const frontmatter = Object.create(null);` line. Regression tests: `test/unit.mjs` "V-H3:" parseFrontmatter cases (5 tests covering `__proto__` scalar, `__proto__` nested, `constructor`, `prototype`, and the implementation contract via `Object.getPrototypeOf`). Future contributors should add new V-H3 cases if a new attack vector is discovered.

---

## 67. Librarian HIGH-Severity Fixes (HL2/HL3/HL4/HL5)

Four independent invariants surfaced by the v2.5 Librarian audit (2026-05-22). Each has a sharp failure mode if violated. Tests pin them as `HL2/HL3/HL4/HL5` in `test/regression.test.mjs`.

**HL2 — Scrub-before-truncate for error shaping (`src/librarian/agentic-api.js`).** When sanitizing API error response bodies before re-throwing as `Error.message`, scrub secrets FIRST, slice SECOND. The pre-fix order (`text.substring(0, 200).replace(...)`) cut tokens below the regex's `{10,}` minimum when they began in the last ~15 chars of the 200-char window — the regex missed and a partial bearer/sk-* leaked into the thrown error. Real Anthropic 401/403 bodies quote the offending header. Generalize: any new error-shaping helper that does replace + truncate must scrub first.

**HL3 — Synthetic ids live in a module WeakMap, not on the raw response (`src/librarian/agentic-api.js`).** `parseToolCalls` used to stamp `p._dleSyntheticId = id` onto Google Gemini `responseContent.parts[i]`. That (a) made `parseToolCalls` non-pure despite its name, (b) crashes under strict mode if ST ever freezes responses, (c) leaks stamped ids into diagnostic re-serialization paths. The fix lifts assignment into `_ensureSyntheticIds(data)` → `Map<part, id>`, stored in a module-level `WeakMap` (`_syntheticIds`). `buildAssistantMessage` reads via `_getSyntheticId(part)`. Both consumers see the same id without touching raw data. WeakMap keying by part-object reference is safe because parts are only GC'd when the whole response object is.

**HL4 — Snapshot+restore `extension_prompts` around the agentic dispatch clear (`index.js`).** Per gotcha #2, `clearPrompts` MUST NOT fire without verified replacement. The agentic dispatch clears DLE entries from `extension_prompts` (and PM aux contents) BEFORE `runAgenticLoop` so the agentic system prompt doesn't duplicate them. If the loop throws synchronously (no profile, Gemini safety block on the first call, etc.) the catch never re-populates them. Self-heals next turn, but any same-turn observer (other extension hooked into post-generation events) sees no lore. The fix snapshots DLE-prefixed `extension_prompts` + `deeplore_notebook` + `deeplore_ai_notepad` + PM contents BEFORE the clear, then restores in catch only when **no prose was produced** AND `epoch === chatEpoch && lockEpoch === generationLockEpoch`. Successful agentic runs intentionally leave the cleared state — the agentic message already replaced the pipeline's role for that turn.

**HL5 — Defensive `proseMsg.extra ||= {}` (`index.js`).** ST's `saveReply` normally creates `message.extra = {}`, but third-party extensions can interpose on `MESSAGE_RECEIVED` and strip it. Without the guard, the primary-branch line `proseMsg.extra.deeplore_tool_calls = result.toolActivity` throws TypeError, propagates to the outer catch, and fires `'Generation failed'` AFTER the prose was already saved — dropdown silently lost. The fallback branch (`else if (result.prose)`) already had the guard from the Wave A F3 fix; the primary branch needed mirror coverage. Any new `.extra.<field> = ...` write in the agentic dispatch must repeat the guard.

**Where:** `src/librarian/agentic-api.js` — HL2 scrub-then-slice in `callWithToolsViaProxy`; HL3 `_syntheticIds` WeakMap + `_ensureSyntheticIds`/`_getSyntheticId` helpers; `parseToolCalls` + `buildAssistantMessage` consume via the helpers. `index.js` — HL4 `_promptsSnapshot` capture before clear, restore in catch's no-prose branch; HL5 `proseMsg.extra = proseMsg.extra || {}` before the tool_calls assignment. Tests: `HL2-1..HL5-1` in `test/regression.test.mjs`.

---

## 58. Every `<button>` in DLE HTML MUST Specify `type="button"` (a11y / form-safety)

**Rule:** All `<button>` elements in DLE templates (`drawer.html`, `setup-wizard.html`, `settings-popup.html`, and any future HTML) MUST carry an explicit `type="button"` attribute. Without it, the HTML5 default is `type="submit"`.

**Why (a11y bundle, 2026-05-22):** ST's `callGenericPopup` wraps content in a `<dialog>` that may be parented inside a form (true for the wizard popup specifically — it has text inputs on multiple steps). A bare `<button>` inside any ancestor `<form>` submits that form when the user presses Enter inside an input — silently dismissing the popup mid-flow, losing entered data, and triggering whatever the form's default-submit handler does. The wizard was the urgent case (30 inputs across 9 steps); the drawer (59 buttons) and settings popup (15 buttons) were defensively patched at the same time so the invariant is global. Adding the attr is mechanical and never changes existing event handlers — every DLE click handler is `.on('click', ...)` (delegated or direct), unaffected by the type.

**Also fixed in this bundle:** stray bare `/` between attributes (e.g. `placeholder="x" / data-i18n="..."`) — 18 inputs across the three templates. Modern browsers tolerate it but HTML5 linters, accessibility scanners, and the i18n key-extractor we ship for translators all choke. The slash served no purpose (HTML5 doesn't require self-closing on void elements).

**Wizard a11y note (related, same bundle):** the wizard step buttons (`.dle-wizard-step`) are a tablist of 9 — `role="tablist"` on the `<nav>`, `role="tab"` + `aria-selected` + `aria-controls="dle-wizard-page-N"` on each button; the corresponding `<div class="dle-wizard-page">` panels carry `id="dle-wizard-page-N"` + `role="tabpanel"` + `aria-labelledby="dle-wizard-step-N"`. `goToPage()` in `src/ui/setup-wizard.js` updates `aria-selected` and `aria-current="step"` on switch. Settings popup sidebar's two `--header` divs (`Connection`, `Features`) are `role="presentation"` (NOT `role="tab"`) so their child subtab buttons can themselves carry `role="tab"` / `aria-selected` / `aria-controls` without violating the tablist pattern; `switchConnectionSubtab` / `switchFeaturesSubtab` in `src/ui/settings-ui.js` update `aria-selected` on switch.

**Where:** every `<button>` opening tag in `drawer.html`, `setup-wizard.html`, `settings-popup.html`. Wizard a11y: `setup-wizard.html` step buttons + page divs, `src/ui/setup-wizard.js: goToPage()`. Settings sidebar a11y: `settings-popup.html` `.dle-settings-tab--header` divs + sub-tab buttons, `src/ui/settings-ui.js: switchSettingsTab` / `switchFeaturesSubtab` / `switchConnectionSubtab`.

---

## 59. Boot-Path Race Guards (BOOT-MED-1/2/3)

Three independent boot-time invariants surfaced by the v2.5 audit (2026-05-22). Each protects a narrow but sharp race window between extension load and first user interaction. Tests pin them as `BOOT-MED-1..3` in `test/regression.test.mjs`.

**BOOT-MED-1 — Init latch is promise-based, not boolean (`index.js`).** The jQuery handler is async. The old guard set `_dleInitialized = true` SYNCHRONOUSLY at the top, then awaited i18n + HTML render + drawer + settings + slash commands + flight recorder (~15+ awaits over hundreds of ms). A second jQuery dispatch arriving mid-await (HMR reload, fast double-load, ST extension hot-swap) saw `_dleInitialized === true`, fell into the `_teardownDleExtension()` branch, and torn down the FIRST init's listeners/state WHILE its awaits were still resolving. Half-registered observers, missing handlers, drawer panel destroyed mid-creation. Fix: wrap `_doInit()` in a `_dleInitInProgress` promise; concurrent callers `await _dleInitInProgress; return;` instead of re-entering. `_dleInitialized = true` flips ONLY after every await resolves (inside the IIFE's tail). Third+ dispatches after init completes still trigger a true re-init (BUG-063 contract preserved). The latch sentinel is cleared in `finally` so an init failure doesn't permanently wedge the extension.

**BOOT-MED-2 — `_updatePipelineStatus` must NOT orphan elements (`index.js`).** Old code: `document.createElement('div')` runs unconditionally, then `document.getElementById('form_sheld')?.prepend(el)` no-ops if `#form_sheld` is missing. The detached element is discarded. Next call re-checks `getElementById('dle-pipeline-status')`, doesn't find the orphan (not in DOM), and creates another. Every status update during a missing-target window leaks a div. Rare (DOM-ready usually fires before first generation), but theme variants and a teardown-race window can hit it. Fix: only `createElement` when a parent target exists; fall back to `document.body` if `#form_sheld` is missing (status surfaces with different visual position but stays observable and findable). Same-id check on subsequent calls now reliably finds the existing element regardless of which parent received it.

**BOOT-MED-3 — Critical event handlers register before init's awaits (`index.js`).** The real CHAT_CHANGED handler registers ~700 lines into `_doInit()`, AFTER i18n + HTML + drawer + settings setup. On slow machines or large vaults, a CHAT_CHANGED that lands during this window is DROPPED — DLE never sees the destination chat, vaultIndex / Verdict / per-chat trackers / PM all miss hydration for that chat until the NEXT switch. Fix: register an `_earlyChatChangedStub` at the very TOP of `_doInit()` (before any await). The stub captures the latest chatId in `_pendingChatChanged`. When the real handler installs, `_installRealChatChangedHandler` drains the queue exactly once. Rapid early switches collapse to the final destination (correct semantic — intermediate transient chats never "happened" from DLE's perspective). The stub is tracked in `_dleListeners` so teardown removes it cleanly; teardown also clears `_realChatChangedHandler` + queue state so re-init starts clean.

**Other events that could benefit from early-register (not patched in this wave because race window is much narrower):** `GENERATION_STOPPED` (only fires if user clicks Stop, requires being in a chat), `GENERATION_ENDED` (same), `CHARACTER_MESSAGE_RENDERED` (requires a generation, which requires init to have finished enough to register the interceptor). `APP_READY` already has the BUG-118 latch-and-fallback-timer pattern that covers its own race. The current `CHAT_CHANGED` fix is the highest-value one because it's the ONLY early event that can fire from a plain UI click before any generation occurs.

**Where:** `index.js` — `_dleInitInProgress` + `_doInit()` extraction + the new `jQuery(async function ...)` wrapper at the bottom (Boot-MED-1); `_updatePipelineStatus` (Boot-MED-2); `_earlyChatChangedStub` + `_installRealChatChangedHandler` + the `eventSource.on(CHAT_CHANGED, _earlyChatChangedStub)` registration at the TOP of `_doInit()` + the `_realCcHandler` rename + drain call at the bottom of the CHAT_CHANGED registration block (Boot-MED-3). Tests: `BOOT-MED-1..3` in `test/regression.test.mjs` — 9 tests covering double-dispatch latching, orphan leak prevention (old vs new behavior), and stub-queue-drain semantics including rapid-switch collapse and re-init no-replay.

---

## 60. Bootstrap Exemption Is Gen-Scoped To `bootstrapActive` (Stages H-3)

**Rule:** `lorebook-bootstrap` entries bypass post-pipeline gating ONLY while `bootstrapActive === true` (i.e. `chat.length <= settings.newChatThreshold`). Once bootstrap deactivates, a bootstrap-tagged entry that reaches the post-pipeline stages via cascade-link / AI selection / pin must be gated like any other entry. The canonical truth-source is `helpers.js:isForceInjected(entry, { bootstrapActive })`.

**Why:** Bootstrap is designed to seed lore during the first few generations of a chat. After that, a bootstrap entry is just another candidate — it should be subject to contextual gating, requires/excludes, cooldown, strip-dedup, and folder filter like everything else. Pre-fix (BUG fixed 2026-05-22), `buildExemptionPolicy` unconditionally added bootstrap entries to `forceInject` regardless of chat state. Pre-pipeline filters in `runPipeline` (e.g. the `alwaysInject` builder, the `isForceInjected(e, { bootstrapActive })` partitioning of AI results) honored the flag correctly, but the post-pipeline policy did not. Any bootstrap entry that survived early filtering and arrived at a post-pipeline stage silently bypassed every gate.

**Symptom of regression:** a bootstrap-tagged entry leaks into late-chat generations even when its `era`/`location`/`character_present` doesn't match, even when its `requires` are missing, even when it was injected last turn (cooldown should suppress), even when its folder is filtered out. The user sees stale intro lore re-appearing far past the bootstrap window with no obvious cause.

**Fix:** `buildExemptionPolicy(vaultSnapshot, pins, blocks, bootstrapActive)` takes a 4th positional arg. Bootstrap entries join `forceInject` ONLY when `bootstrapActive === true`. Default is `false` (conservative — accidentally bypassing gating is the bug).

**Where in code:**
- `src/stages.js: buildExemptionPolicy()` — 4th arg added.
- `src/pipeline/pipeline.js: runPipeline()` — the single Wave C P2 cached-policy call now passes `bootstrapActive` (computed inline from `chat.length <= settings.newChatThreshold`).
- `index.js` post-pipeline policy build (~L795) — reads `trace?.bootstrapActive === true` so the post-pipeline stages match the pre-pipeline filter.
- `src/ui/commands-pipeline.js` `/dle-why` slash command — passes `false` intentionally (diagnostic preview shows the conservative "post-bootstrap" view).
- `src/pipeline/pipeline.js: matchTextForExternal()` — defaults to `false` (external context-free match has no chat history, bootstrap not meaningful).

**Tests:** `H-3-1..6` in `test/regression.test.mjs` (default arg, contract agreement with `isForceInjected`, cascade gating, requires/excludes scoping, static guards on the runPipeline + index.js call sites). `I9` in `test/stages.test.mjs` rewritten to assert BOTH halves (active=true survives, active=false gated). `I9b` / `I9c` added for cascade and AI-selected scenarios. `B1` (stages.test.mjs) and the `bootstrap and seed entries ARE in forceInject` test in `unit.mjs` updated to reflect the new contract.

---

## 61. `clearIndexCache` Aborted Transactions Hang Without `tx.onabort` (V-M3)

**Rule:** Every IndexedDB transaction `await` in `src/vault/cache.js` MUST wire all three handlers: `tx.oncomplete`, `tx.onerror`, AND `tx.onabort`. Missing `tx.onabort` causes the `await new Promise(...)` to hang forever on a transaction abort (quota exceeded, version-change abort, browser tab close mid-flight), which means the `finally` block's `db.close()` never runs and the IndexedDB connection leaks for the lifetime of the page.

**Why (V-M3 fix, 2026-05-22):** `saveIndexToCache` and `pruneOrphanedCacheKeys` were updated post-BUG-380 to include `tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))`. `clearIndexCache` was missed in that sweep — it wired only `oncomplete` + `onerror`. The actual abort path was unreachable in the happy case (success drives `oncomplete`) but became a hard hang under quota pressure or a tab close during the Settings → About → Danger Zone "Clear cache" click. The fix copies the sibling pattern verbatim so all three transactional ops in the file share the same shape; the cross-function consistency check `test/vault.test.mjs:N3` asserts ≥3 occurrences of the canonical pattern.

**Pattern (canonical — copy verbatim for new transactional cache.js ops):**
```javascript
await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});
```

**Where:** `src/vault/cache.js: clearIndexCache()`. The same pattern in `saveIndexToCache()` and `pruneOrphanedCacheKeys()` is the reference. Tests: `test/vault.test.mjs` section N (N1–N3). Runtime test would require fake-indexeddb + a settings.js shim (cache.js → settings.js → ST `extensions.js`, unresolvable in node); section N pins three structural / pattern / consistency assertions instead. Browser-side smoke: trigger the "Clear cache" danger-zone action under quota pressure or with another SillyTavern tab open — pre-fix the action hung the popup indefinitely.

---

## 62. Vault Rename Is Destructive — Confirm Before Apply (V-M5, Option B)

**Rule:** When the user changes `settings.vaults[idx].name` via the settings UI, surface a confirmation popup BEFORE committing the rename, and revert both the input value and `settings.vaults[idx].name` if cancelled. The destructive consequence (per-entry trackers keyed on `vaultSource:title` no longer match anything) is documented in the popup body so the user can choose.

**Why (V-M5 known limitation, 2026-05-22):** `trackerKey(entry) = ${vaultSource}:${title}` (`src/state.js`). Every per-entry tracker — `cooldownTracker`, `decayTracker`, `consecutiveInjections`, `injectionHistory`, `chatInjectionCounts`, `perSwipeInjectedKeys`, `settings.analyticsData`, `chat_metadata.deeplore_pins`, `chat_metadata.deeplore_blocks` — uses this key. A vault rename changes the `vaultSource` prefix for every entry under it, so the old keys become orphaned and look like fresh entries with no state. The pipeline's analytics-prune in `finalizeIndex` (`src/vault/vault.js`) actively deletes `settings.analyticsData` keys whose `trackerKey` isn't in the current index, so the orphaned data does NOT survive the next index rebuild.

**Two options considered:**
- **Option A (re-key all trackers on rename):** detect the rename diff (oldName → newName) and walk every tracker / `chat_metadata` map, re-keying `oldName:*` → `newName:*`. Invasive — touches 9+ collections across multiple modules, each with its own lifecycle. Adds a one-shot operation that can partially fail mid-walk (chat_metadata persistence is per-chat). Deferred as future work.
- **Option B (chosen for v2.5):** treat rename as destructive, document it via a confirmation popup + this gotcha entry + the per-test pin in `test/vault.test.mjs` section O. Faster to ship, no surface area for new bugs, and explicit user consent. The existing analytics-prune behavior is documented rather than fought.

**UX contract (Option B):**
1. `focus` on the vault-name input captures `dleOriginalName` via `$.data()`.
2. The pre-existing `input` handler still validates uniqueness against other vault names (auto-suffixes `Vault 2`, etc.).
3. `change` (blur) on the vault-name input compares against `dleOriginalName` — if they differ, fires `callGenericPopup(..., POPUP_TYPE.CONFIRM, ...)` with copy that names the destructive consequence and the affected tracker categories.
4. Cancel → revert `settings.vaults[idx].name` AND the input value to `dleOriginalName`, then `saveSettingsDebounced()`.
5. Confirm → record the new name as the next baseline so a subsequent edit prompts again.

**Where:** `src/ui/settings-ui.js: bindVaultListEvents()` — `focus.dleVault` capture + `change.dleVault` confirmation handler. Tests: `test/vault.test.mjs` section O (O1–O5). Affected runtime collections (read this list before adding any new per-entry tracker — it MUST be updated): `cooldownTracker`, `decayTracker`, `consecutiveInjections`, `injectionHistory`, `chatInjectionCounts`, `perSwipeInjectedKeys`, `analyticsData`, `chat_metadata.deeplore_pins`, `chat_metadata.deeplore_blocks`, `chat_metadata.deeplore_chat_counts`. If Option A is ever implemented, every collection above needs an explicit re-key step.

---

## 63. Cascade-Pulled Entries With `excludeRecursion: true` Must Not Seed Recursion Text (M-5)

**Rule:** In `src/pipeline/match.js`, cascade-link expansion (~L142-167) tracks which linked entries carry `excludeRecursion: true` via a `cascadeExcludedFromRecursion` Set, and the recursion init (~L168-176) builds the initial `newlyMatched` by filtering those entries out of `matchedSet`. Cascade-pulled excluded entries still belong in `matchedSet` (they ARE matched and will be injected) — they just cannot contribute their content to the recursion text scan.

**Why (M-5 fix, 2026-05-22):** `excludeRecursion: true` is author intent for "never use this entry's content for scanning." Cascade pulls entries based on an explicit author relationship (`cascadeLinks`), so a cascade-pulled entry with `excludeRecursion: true` is fully matched and injected — that's correct. But its content must not seed step-1 recursion text, or one round of recursive keyword matching can fire against text the author marked off-limits. The inline filter at the top of the recursion while-loop (`.filter(e => !e.excludeRecursion)`) already catches this and remains the authoritative gate — the cascade-side filter is **belt-and-suspenders defense** so a future refactor of the recursion text gathering (different gather order, different filter location, factored-out helper) cannot silently leak cascade-pulled excluded content for one step.

**Distinguish carefully:**
- `matchedSet`: which entries are matched. Cascade-pulled excludeRecursion entries ARE in this set (they get injected).
- `newlyMatched` initial recursion seed: which entries' content feeds the first recursion text scan. Cascade-pulled excludeRecursion entries are NOT in this seed.
- Downstream injection: cascade-pulled excludeRecursion entries flow normally to the injection path (because they're in `matchedSet`).

**Multi-vault interaction (MV-5 preserved):** Same-titled cross-vault entries pulled via cascade still union into `matchedSet` (`titleMap.get(title)` returns Entry[]). The M-5 filter applies per-entry — vault-A's "Alice" with `excludeRecursion: true` is filtered from the recursion seed, vault-B's "Alice" with `excludeRecursion: false` still seeds normally. Both remain in `matchedSet` for injection. See test `M-5d`.

**Where:** `src/pipeline/match.js` — `cascadeExcludedFromRecursion` Set populated during cascade expansion, consulted when building `newlyMatched` initial seed. Existing inline filter `.filter(e => !e.excludeRecursion)` at the top of the recursion while-loop remains as the authoritative gate. Regression tests: `M-5a..M-5d` in `test/regression.test.mjs` (cascade-pulled-IN-matchedSet, content-not-leaked, excludeRecursion=false-still-recurses, MV-5-cross-vault-cascade-preserved).

---

## 64. Settings UI MEDIUMs Bundle (V-M1, V-M2, V-M4, V-M5 — 2026-05-22)

Four small but sharp UI fixes that each protect a narrow correctness window. None change runtime data shape; all are pinned by `V-M1..M5` tests in `test/regression.test.mjs`.

**V-M1 — Browse folder-grouping fallback must use `getWriterVisibleEntries()`, NOT raw `vaultIndex`.** `src/drawer/drawer-events.js: wireBrowseTab()` (~L630-645). On first toggle, `ds.browseFilteredEntries` is often empty (drawer just opened, no render pass yet). The pre-fix fallback fell through to raw `vaultIndex`, which (a) includes `lorebook-guide` entries the user never sees in Browse, and (b) ignores any active filter set. The folder-expanded Set then contained folders unrelated to what the user was actually looking at. Fix: use `getWriterVisibleEntries()` (parameterless — reads from module-scoped `vaultIndex` internally) for the fallback. This matches the contract from gotcha #5: anything user-facing that respects `lorebook-guide` semantics MUST go through this filter.

**V-M2 — `wireStatusActions` MUST gate on `indexing` the same way `wireToolsTab` does.** `src/drawer/drawer-events.js: wireStatusActions()` (~L201-300). Tool buttons in the drawer's Tools tab refuse to run when `indexing===true` (BUG-359 guard at L140-148). The top status zone's action buttons (`scribe`, `newlore`, `librarian-chat`, `graph`, `clear-picks`, `skip-tools`) only checked `generationLock` — running `/dle-newlore` or `/dle-scribe` mid-index races the build commit (BUG-016 zombie-build territory). Fix: add `if (action !== 'refresh' && indexing) { dedupWarning('Indexing in progress — try again in a moment.', 'index_busy'); return; }` at the top of the click handler. **`refresh` is exempt** because it IS the index trigger (and has its own `ds.refreshing` latch) — gating it would deadlock the user out of recovering from a stuck indexing flag. The shared `dedupWarning` category `index_busy` participates in toast-dedup just like Wave C boot uses for its PM-mode warnings.

**V-M4 — Wizard test-conn surfaces a fallback string when `result.error` is `undefined`.** `src/ui/setup-wizard.js: wireConnectionTest()` (~L275-289). `testConnection` may return `{ ok: false, diagnosis: 'cert', error: undefined }` — the diagnosis branch fires the help popup but the error-line render then does `escapeHtml(undefined)`, which puts the literal string `"undefined"` into the UI. Fix: `const errorText = result.error || (result.diagnosis ? \`Diagnosis: ${result.diagnosis}\` : 'Unknown error');` before the escape call. Order matters — explicit `error` wins when present, diagnosis is the next-best derivative, "Unknown error" is the floor.

**V-M5 — Vault remove confirmation MUST be wrapped in try/catch.** `src/ui/settings-ui.js: bindVaultListEvents()` (~L279-299). The pre-fix shape was `const confirmed = await callGenericPopup(...)` with no try/catch. `callGenericPopup` normally returns `false` for both cancel and backdrop-dismiss (so `if (!confirmed) return;` covers both), but if the popup util THROWS (popup root detached mid-teardown, util unavailable in some boot-race window), the throw escapes the handler entirely — no UI feedback, no `return`, and worse, if a future refactor moves any mutation BEFORE the await, partial mutation could leak. Fix: wrap the await in try/catch, log a diagnostic warning, and treat any throw as "user did not confirm" (bail out, do not splice). Distinct from V-M5 vault-rename (gotcha #62) which is about the destructive consequence of a successful rename — this is about the popup-failure path of a remove.

**Where:** `src/drawer/drawer-events.js: wireBrowseTab()` group-toggle (V-M1); `src/drawer/drawer-events.js: wireStatusActions()` click handler (V-M2); `src/ui/setup-wizard.js: wireConnectionTest()` (V-M4); `src/ui/settings-ui.js: bindVaultListEvents()` vault-remove click handler (V-M5). Tests: `V-M1..M5` in `test/regression.test.mjs` (10 assertions).

---

## 65. Stages MEDIUMs Bundle (M-3, M-4, M-6, M-7, M-8 — 2026-05-22)

Five small pipeline-stage fixes that each shut down a specific footgun. None change runtime data shape; pinned by `M-3-*`, `M-4-*`, `M-6-*`, `M-7-*`, `M-8-*` tests in `test/regression.test.mjs`.

**M-3 — Strip-dedup empty-hash audit (confirmed safe via title differentiation).** `src/stages.js: applyStripDedup()`. Original audit concern: when `entry._contentHash` is unset (parse-failure path, hydration window before cache loader stamps), the read-side dedup key trails an empty hash suffix — could two unrelated entries collide? Investigation: NO. The key shape is `<vaultSource>:<title>|<pos>|<depth>|<role>|<hash>` — distinct titles already differentiate entries in the recentEntries Set regardless of hash state. An earlier patch attempt using a per-entry `_no_hash_<vaultSource>:<title>` sentinel was rejected because it broke the legitimate same-entry case: a parse-failure-window log record (`contentHash: ''`) needs to dedup against a same-entry current-gen entry that also has no `_contentHash` — same canonical entry, both wildcards, MUST match symmetrically (`|| ''` on both sides). The audit conclusion was "no fix needed beyond the existing v2.5 vaultSource prefix"; the M-3 deliverable is the three regression tests below pinning the invariant. Tests `M-3-1..3`: cross-title entries with empty hash do not collide; same-title same-vault entries with empty hash on both sides DO dedup (symmetric wildcard); cross-vault same-title entries do not collide because the vaultSource prefix disambiguates them.

**M-4 — `applyStripDedup` `lookbackDepth <= 0` is a no-op.** `src/stages.js: applyStripDedup()`. `arr.slice(-0)` returns the entire array (because `-0 === 0`), so a call asking for "no lookback" silently got "lookback against ALL injection history" — the opposite intent. The settings UI clamps to min 1, but the function is also called from `index.js`, `/dle-why`, and `matchTextForExternal`, none of which were bound by the UI minimum. **New invariant:** `lookbackDepth <= 0` returns `entries` unchanged with no dedup applied. The footgun is no longer accidental-feature; if a caller really wants "dedup against entire log" they pass `Number.MAX_SAFE_INTEGER` explicitly.

**M-6 — `hasWarmup(entry)` helper unifies warmup gate across all 3 match paths.** `src/helpers.js` (new export). Pre-fix, `src/pipeline/match.js` used two different shape checks: `entry.warmup !== null` in the primary keyword and recursion paths, `entry.warmup && entry.warmup >= 1` in the BM25 fuzzy path. The two diverge on NaN, accidental `0`, empty string, `false`, negative numbers, and Infinity — none of which the frontmatter parser emits today but any of which can surface from cache hydration, manual `chat_metadata` edits, or future field-definition changes. Canonical predicate: `typeof w === 'number' && Number.isFinite(w) && w > 0`. All three sites now call `hasWarmup(entry)`. Future warmup-gate sites MUST use the same helper.

**M-7 — Contextual gating short-circuit honors `exists`/`not_exists` rules.** `src/stages.js: applyContextualGating()`. `exists` and `not_exists` are field-presence checks on the ENTRY, not value comparisons against active context. The original short-circuit (return entries unchanged when no field had user-set context) fired BEFORE the per-entry loop got a chance to evaluate them — so a vault that used `not_exists` to mark "incomplete entries to drop" silently passed every entry when the user hadn't set any other context. Fix: extend `hasAnyContext` so it returns true when ANY enabled rule uses an existence operator, letting the loop run and evaluate them properly. The short-circuit still fires for the original "purely value-comparing rules with no active context" case.

**M-8 — Truncation preserves canonical `_contentHash` for strip-dedup symmetry.** `core/matching.js: formatAndGroup()`. Pre-fix, the truncated entry got `_contentHash = entry._contentHash + '_trunc'` so strip-dedup would not match a truncated entry against a prior full-content injection of the same entry. The intent was "don't let a fragment masquerade as the full thing." But the practical effect was: gen 1 injects "Castle" full (hash X), gen 2's tighter budget truncates "Castle" (hash X_trunc), dedup mismatches, same entry re-injects back-to-back even though the author's canonical content is identical. Truncation is a presentation-layer concession to the budget — it must NOT change dedup identity. **New invariant:** the dedup hash always reflects pre-truncation canonical content, so budget changes don't bypass dedup. `_truncated` flag and `_originalTokens` still record that this version was cut, for any UI/analytics that need to display the fact.

**Where:** `src/stages.js: applyStripDedup()` (M-4), `src/stages.js: applyContextualGating()` (M-7), `src/helpers.js: hasWarmup()` (M-6 helper), `src/pipeline/match.js` (M-6 call sites — 3 places), `core/matching.js: formatAndGroup()` truncated-entry branch (M-8). M-3 is audit-only (no code change beyond the pre-existing v2.5 vaultSource prefix in the dedup key). Tests: `M-3-1..3`, `M-4-1..2`, `M-6-1..4`, `M-7-1..3`, `M-8-1..2` in `test/regression.test.mjs` (17 assertions total). Test `F5` / `F5b` in `test/stages.test.mjs` updated to reflect M-4's behavior change.

---

## 68. Custom Proxy connection mode dead-headed in v2.5

**Files:** `src/ai/ai.js` (callAI dispatch), `src/librarian/agentic-api.js` (4 sites), `src/ai/proxy-api.js` (kept for rollback)
**Date:** 2026-05-23
**Migration:** `settings.js: runMigrations` v3→v4 flips any `*ConnectionMode === 'proxy'` to `'profile'` and sets `_proxyMigrationV2_5_notice` sentinel. Boot-time popup explains + pulse-glows the migrated mode dropdown.
**Rollback path:** Un-hide `<option value="proxy">` in `settings-popup.html` + `setup-wizard.html`. Revert `callAI` dispatch throw. `proxy-api.js` + `breaker-pure.js` classifiers still live.
**Why dead-head not full strip:** Connection Profile may not match every user's pre-v2.5 setup; rollback safety valued. Files marked `@deprecated v2.5`.
**Test:** `PRX-MIG-1/2/3` in `regression.test.mjs` verify migration semantics.

**Affected settings (all migrated 'proxy' → 'profile' if previously set):**
- `aiSearchConnectionMode`
- `scribeConnectionMode`
- `autoSuggestConnectionMode`
- `aiNotepadConnectionMode`
- `librarianConnectionMode`
- `optimizeKeysConnectionMode`

**Cascading consequence:** `enableCorsProxy: true` in ST's `config.yaml` is **no longer required for DLE AI features** as of v2.5 (Profile mode uses CMRS which routes server-side and bypasses the CORS bridge entirely). It IS still required if you use ST's own raw-URL AI requests outside DLE. Vault fetching via Obsidian Local REST API is unaffected — Obsidian's REST plugin has built-in CORS and DLE has never used the CORS bridge for vault traffic (see `docs/vault-and-indexing.md` §3 "CORS proxy usage").

**Inherit chain:** `'inherit'` mode still works (chains to aiSearch). But aiSearch's mode can no longer BE `'proxy'` post-migration, so the inherit chain always lands on `'profile'`. No special handling needed in `resolveConnectionConfig` — the impossibility is enforced at the migration boundary, not the resolve boundary.

---

## 69. WI import is a contract, not a best-effort transform (v2.5 WI parity)

**Files:** `src/helpers.js` (convertWiEntry + WI_ROUND_TRIP_FIELDS), `src/vault/import.js` (importEntries + upsertConvertedEntry), `core/pipeline.js` (parser-side WI_ROUND_TRIP_FIELDS), `core/matching.js` (applySelectiveLogic), `src/ui/wi-import-report-pure.js` (popup builder), `src/ui/wi-import-report.js` (popup wrapper), `settings.js` (wiImportEmHandling).
**Date:** 2026-05-27

**The contract:** every ST World Info field has a documented home. No field silently drops on import. Three tiers:

1. **Native** — DLE acts on the field. `disable`/`enabled:false`, `excludeRecursion`, `role` (Wave 1), plus `selective_logic` with all 4 modes enforced by `applySelectiveLogic` (Wave 3), plus EM positions 5/6 with `## Example Dialogue` subheader handling (Wave 4).
2. **Round-trip preserved** — landed in vault frontmatter as snake_case, surfaced by `/dle-lint`. Two sub-tiers:
   - `W_NOT_IMPLEMENTED` (BUG numbers): `sticky`, `delay`, `group`, `group_weight` — planned to implement.
   - `W_WI_ROUND_TRIP` (Wave 2, no BUG numbers): `vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, + 6 `match_*` toggles. DLE intentionally ignores these.
3. **Documented gaps** — regex keys (BUG-045) treated as literal strings.

**Drift-class regression to guard:** the round-trip table appears in TWO places — importer side (`WI_ROUND_TRIP_FIELDS` in `src/helpers.js`) emits to vault frontmatter, parser side (same name, in `core/pipeline.js`) flags emitted fields via `W_WI_ROUND_TRIP`. A field emitted on import but unflagged by the parser will appear "vanished" to authors reading `/dle-lint` output — exactly the silent downgrade this contract was built to kill. **Reviewers MUST reject single-table edits.** Add to both or neither.

**Pin the predicate:** `applySelectiveLogic` in `core/matching.js` is the single source of truth for the 4 refine-key gating modes. Today only `testEntryMatch` calls it (which transitively covers primary keyword + recursion paths since both route through `testEntryMatch`). Future refine-gate sites MUST route through `applySelectiveLogic` — matches the M-6 `hasWarmup` invariant. BM25 fuzzy bypasses refine keys entirely (TF-IDF is content-wide) — that's an architectural carve-out, not a `selective_logic` exception.

**Wave 1 silent-downgrade fix:** pre-v2.5, `wiEntry.disable === true` silently became an active vault entry — most damaging silent downgrade in the importer. Now emits `enabled: false`, parser skips at load (`parseVaultFile:191`). `wiEntry.excludeRecursion` and `wiEntry.role` had similar drops despite DLE supporting them natively.

**Wave 5 import report struct (`{nativeApplied, roundTripped, skipped, emAppended, emSkipped, emEntries}`)** is threaded through `convertWiEntry` via `options.report` (optional accumulator — harmless when omitted). `importEntries` + `upsertConvertedEntry` return it on result. Wave 5 popup consumes it. The skip policy for EM entries lives at the I/O layer (`importEntries`), not the converter — converter always emits the append form so single-entry callers (companion extensions) behave consistently with batch import.

**Test:** `test/wi-import.test.mjs` (Wave 7) holds the full-parity fixture + no-silent-drop guard. Drift-class regression coverage in `test/regression.test.mjs`.

---

## 70. Editable prompts — delete cage + getPrompt() invariants (v2.5)

**Files:** `src/prompts/prompt-validators.js`, `src/prompts/prompt-api.js`, `src/prompts/prompt-store-pure.js`, `src/prompts/prompt-store.js`, `src/prompts/deprecated-keys.js`, `src/i18n/prompts/en.js`, `test/prompts-delete-safety.test.mjs`, `test/prompts-store.test.mjs`, `test/prompts-api.test.mjs`.
**Date:** 2026-05-28

**The contract:** users can override DLE's 25 built-in LLM prompts with MD files inside their Obsidian vault (`DeepLore/prompts/` by default, configurable). Runtime reads vault → falls back to compiled-in EN dict. Per-prompt revert deletes the vault file. The cage is the safety system around DELETE.

### Delete cage — six orthogonal layers

User vault deletion is the single most damaging failure DLE can have. Layers in order:

| Layer | Where | What it checks |
|---|---|---|
| **L1** Path shape (10 sub-checks) | `validatePromptDeletePath()` (pure) | Non-empty string, starts with sanitized prefix, ends `.md`, no `..` (raw / `%2e%2e` / double-encoded / Unicode lookalikes), no `//`, no leading `/`/`\\`/`~`/drive letter, no `%`/`+`/control chars, single filename past prefix, SCREAMING_SNAKE_CASE stem, ≤ 200 chars. |
| **L2** Stem whitelist | `validatePromptDeletePath()` | Stem MUST be in `KNOWN_PROMPT_KEYS` (derived from `en.js` exports) ∪ `DEPRECATED_PROMPT_KEYS` (allowlist for keys removed in later versions). |
| **L3** Legacy traversal guard | `validateVaultPath()` from `obsidian-api.js` | Re-runs ST-style normalize + traversal check. Defense in depth. |
| **L4** Pre-flight GET + frontmatter verify | `deletePromptFile()` + `verifyPromptFileForDeletion()` (pure) | GET the file. Parse frontmatter. Refuse if `frontmatter.key` does not match validated stem. Refuse if body contains `lorebook-` tag (would be a vault entry, not a prompt). |
| **L5** URL re-assembly | `deletePromptFile()` | After L1-L2 produce the validated stem, the DELETE URL is reassembled internally as `${prefix}${stem}.md`. Caller-supplied path is NEVER used past L1. Asserts assembled equals validated. |
| **L6** Code structure | grep + comment-tag | `deletePromptFile()` is the SOLE exported delete primitive. The marker comment `DLE_DELETE_PRIMITIVE` flags the one allowed site. `test/prompts-api.test.mjs` enforces this structurally by counting `method: 'DELETE'` literals across `src/` — exactly 1, must be in `prompt-api.js`. |

**Add to `DEPRECATED_PROMPT_KEYS` when removing keys, not speculatively.** Empty set at v2.5 ship.

**Reviewers MUST reject** any new `method: 'DELETE'` outside `prompt-api.js`. Also reject any generic `deleteNote()`/`deleteFile()` export from `obsidian-api.js`.

### getPrompt() resolver invariants

`getPrompt(key)` is **synchronous by design** — called inside agentic loops and fence builders without await. Cache is preloaded at boot.

Resolution order:
1. `promptCache` Map (populated at boot by `loadPrompts()`).
2. Compiled-in EN dict by key (final fallback).
3. Empty string + console warn (unknown key — should never happen for a recognized key).

`loadPrompts(locale, connection)` does the two-stage merge: compiled-in baseline, then vault overrides via `buildPromptOverlay()` (pure). Invalid overrides (parse fail, key mismatch, `lorebook-` tag in body, placeholder mismatch) fall back to compiled-in and surface in `errors[]` + per-row `meta.error` for the Prompts tab.

### Placeholder contract

Two interpolation styles, kept distinct on purpose:
- **`${N}` numeric indices** — agentic loop fragments (nonce, tool count, max searches, etc.). Validator enforces parity between vault override and canonical (`validatePromptShape` R3). Substituted at call time by a local `interp(template, ...args)` helper.
- **`{{maxEntries}}` Mustache style** — legacy AI-search system prompt contract. Substituted at call time via `.replace(/\{\{maxEntries\}\}/g, ...)`. Invisible to the validator.

Don't unify these — the AI search prompt is user-editable with the Mustache placeholder already documented, and rewriting it to `${0}` would break every existing custom prompt users have written.

### Status state machine (`computePromptStatus`)

Q11 A+ 4-state machine for the Prompts tab UI:

| `body_hash` vs `source_hash` | `source_hash` vs `canonical_hash` | Status |
|---|---|---|
| match | match | `current_default` (untouched, up to date) |
| match | differ | `stale_default` (untouched, upstream changed) |
| differ | match | `customized` (edited, baseline current) |
| differ | differ | `customized_stale_baseline` (edited, baseline outdated) |

Edge cases: missing `source_hash` → infer from body vs canonical comparison; missing canonical → `customized` (orphan key); all hashes null → `missing`.

### Boot-time load

`index.js` init calls `loadPrompts()` once after `loadSettingsUI()` / `bindSettingsEvents()`. Failures are logged-not-thrown so a missing/misconfigured vault never blocks extension startup. Without a connection, the cache is purely compiled-in — runtime is byte-identical to pre-feature behavior.

### Tests

- `test/prompts-delete-safety.test.mjs` — 225 assertions covering every cage layer, every known prompt key, 100 fuzz inputs, 22 named attack patterns (traversal variants, null byte, encoded, Unicode lookalikes, drive letter, file://, etc.), and the user-configurable-folder sanitizer.
- `test/prompts-store.test.mjs` — 269 assertions covering pure helpers + runtime cache + overlay merge + status state machine + 4 round-trip cases.
- `test/prompts-api.test.mjs` — 40 assertions covering L4 pre-flight + L6 structural ("exactly one DELETE in `src/`, in `prompt-api.js`, with the `DLE_DELETE_PRIMITIVE` comment-tag").

The L6 structural test is the load-bearing review backstop. If you ever see it fail, do not relax it — the failure means a new DELETE site landed that shouldn't have.

## 71. Graph view modes — `layoutMode` discriminant + non-force restore discipline (v2.5)

**Files:** `src/graph/graph-dag.js`, `src/graph/graph-health.js`, `graph.js`, `graph-physics.js`, `graph-render.js`, `graph-events.js`, `graph-focus.js`, `test/dag.test.mjs`, `test/health.test.mjs`. **Date:** 2026-05-28. Design: `audit/v2.5-graph-views/PLAN.md`.

v2.5 reopened the graph (previously "complete" — supersedes `project_graph_complete.md`) to add alternate view modes. Wave 1 shipped **Layered DAG** + **Vault Health**. Invariants a future change MUST honor:

- **`gs.layoutMode` is the single layout discriminant** (`'force' | 'focus' | 'dag'`). It replaced the old binary `focusTreePhysics` flag (fully removed — 6 writers, 1 reader). `graph-physics.js` `simulate()` early-returns unless `layoutMode === 'force'`, so EVERY non-force layout freezes the force sim. Adding a new deterministic layout = add a mode value, stage `_targetX/_targetY`, set `gs._egoLerpActive = true` (reuse `lerpEgoPositions` — it is layout-blind), set `layoutMode`. Do NOT reintroduce a per-feature physics-freeze flag.

- **Non-force layouts MUST clear `hasSpringEnergy` + `maxDelta` when their lerp settles** (2026-05-29 perf fix). Because `simulate()` early-returns in non-force modes, it never reaches the line (`graph-physics.js`) that lowers `hasSpringEnergy` — yet both `enterFocusTree` and `enterDagLayout` set it `true`. `lerpEgoPositions()` now sets `gs.hasSpringEnergy = false; gs.maxDelta = 0` on settle (`!anyMoving`); without that, the tick draw gate (`hasSpringEnergy || maxDelta > 0.01 || …`) stays true forever → a full-canvas redraw EVERY frame for as long as the user sits in focus/DAG. The reveal-anim block re-sets the flags while animating, so clearing on settle is safe. Latent in focus mode since the `focusTreePhysics` era; DAG inherited it until this fix.

- **Force mode must stay byte-identical to pre-v2.5 behavior.** The layoutMode swap was behavior-preserving; the default open is `force`. Reveal animation, saved-layout restore, presets — untouched in force.

- **Deterministic layouts (`dag` and any future) are NEVER persisted to `graphSavedLayout`.** That settings key is force-only and bare-title-keyed. The physics auto-save block sits AFTER the `layoutMode !== 'force'` early-return, so it cannot fire in another mode — keep it that way. DAG/Health recompute on enter.

- **Enter/exit MUST restore state exactly** (mirror `enterFocusTree`/`exitFocusTree`): snapshot `_preLayoutPositions` + `_preLayoutEdgeVis` on enter; on exit restore positions, `edgeVisibility` (+ `buildAdjacency()`), `cachedVisibleCount` (→ `nodes.length`), and the hidden/reveal rule — now the shared pure predicate `isRehidden(n, revealedBatch)` in `graph-util.js`, called by BOTH `exitFocusTree` and `exitDagLayout` so the two non-force exits cannot drift (2026-05-29; was duplicated verbatim). Getting `cachedVisibleCount` wrong breaks `hitRadius()` → clicking. Getting the hidden formula wrong makes `applyFilters` / `e`-reset fight over hidden state. The `applyFilters` un-hide branch is gated on `layoutMode === 'force'`. Regression guards: `test/dag.test.mjs` "enter/exit state restore".

- **DAG edges need a bright render branch.** Disparity-backbone dimming would otherwise draw requires/cascade at α 0.03 → invisible. `graph-render.js` has a `layoutMode === 'dag'` branch (α 0.85) ahead of the backbone/hover cascade, plus arrowhead drawing at the `to` end. DAG flips `edgeVisibility` to requires+cascade only via the existing `buildAdjacency()`.

- **Cycle handling is DAG-local.** The legacy `circularPairs` (graph.js) only catches 2-cycles on `requires` and ignores cascade — insufficient for layering. DAG and Health do their own DFS back-edge break (`breakCycles` in `graph-dag.js`, reused by `graph-health.js detectCircular`). Unbroken cycles → NaN layers.

- **Health panel is JS-created floating, NOT in container HTML.** `graph-health.js initHealth()` builds the side panel with `createElement` + inline styles on demand, appends to `.dle-graph-canvas-wrap`, removes on close — the tooltip/context-menu pattern, not the inline `container.innerHTML` pattern the settings panel uses. Keep new graph sub-UIs to this pattern (lean template, self-contained module). Detectors are pure (`detect*`) and unit-tested; `gs.healthFlagged` map keys are node ids, never bare titles (#50). The severity-ring pulse drives a per-frame redraw ONLY for motion-OK users — the tick gates the forced `needsDraw` on `!gs.reducedMotion`, and `graph-render.js` holds the pulse static under `reducedMotion` (perf + a11y, 2026-05-29). Keep those two in lockstep: if you make the pulse always-on, you re-introduce a permanent full-redraw for reduced-motion users.

- **Map keys = node id (`= index into gs._vaultIndex`) or `trackerKey`, never bare `entry.title`** (#50). New layout/analysis code in graph-dag/graph-health follows this.

- **Programmatic layout exits MUST mirror the select's change handler** (2026-05-28 audit). Only the `#dle-graph-layout-mode` change handler used to call `exitDagLayout()`. The Reset button (`graph-events.js`) and Redraw/`replayReveal` (`graph.js`) drove their own un-pin/re-layout while leaving `layoutMode==='dag'` → frozen physics, DAG-restricted `edgeVisibility`, no recovery. Both now route through the single `gs.resetToForceLayout()` helper (`graph.js`, 2026-05-29) — it exits focus/DAG and syncs the `#dle-graph-layout-mode` `<select>`.value back to `'force'`. Any future code path that resets/re-lays-out the graph MUST call `gs.resetToForceLayout()` rather than re-implementing the exit + select-sync (which is how these two drifted in the first place).

- **`computeHealthFindings` degree is structural, NOT `gs.edgeCountByNode`** (2026-05-28 audit). `edgeCountByNode` is rebuilt under the active `edgeVisibility` filter — DAG mode hides link/excludes, the legend toggles edge types — so reading it makes `detectOrphans`/`detectThinHubs` falsely flag link-only/excludes-only entries when Health is opened in DAG mode or after a legend toggle. Degree is now derived from the full `gs.edges` set, visibility-independent (falls back to `edgeCountByNode` only when no edge list exists, i.e. headless detector tests). `detectCircular` covers requires **AND** `cascadeLinks` (invariant #4 above — it previously regressed to requires-only). `detectTokenBloat` returns `[]` when token sizes have no real spread (`max <= median*1.5`) so a uniform vault flags nothing, not every entry. `detectSelfRefs` (CRIT) catches entries whose requires/excludes/cascade name their own title. DAG `enter()` sets `n._revealScale = 1` on each staged participant so un-hidden nodes don't render invisible for ~10 frames.

Wave 2 (Activity raster, Co-presence/co-injection, Health behavioral findings) needs a Verdict-store→graph read pipe — NOT built yet, and depends on the CHAT_CHANGED IDB-wipe fix (`audit/v2.5-release/INDEX.md` §1).

## 72. ST `data-i18n` is textContent-only — markup-bearing locale strings MUST use `data-i18n-html` (2026-05-28)

ST's native i18n (`public/scripts/i18n.js` `translateElement`) sets `element.textContent` for a plain `data-i18n="key"`, and `setAttribute(attr, value)` for the `data-i18n="[attr]key"` form. There is **no innerHTML path** — `[html]` would just create a bogus `html=""` attribute. So any locale value containing markup (`<strong>`, `<a>`, `<code>`, `<br>`) bound via plain `data-i18n` renders the **literal tags as text**.

This only manifests under a **non-English** locale: ST skips element translation when the UI locale is English (the static template HTML stays), so the bug hides in EN and surfaces in de/es/fr/ja/zh/ru. Originally found via the About-tab credits line under zh-cn (`Made by <strong>pixelnull</strong> …` rendered verbatim); a cross-ref of all `*.html` `data-i18n` keys against EN values containing tags found **25** such keys (drawer empty/browse/search-syntax, setup-wizard copy, settings notes + credits).

**Contract:** elements whose localized value contains HTML use the custom attribute `data-i18n-html="key"` instead of `data-i18n`. ST ignores it (it only scans `data-i18n`). After each template mounts, the owning module calls `applyHtmlI18n(rootEl)` (exported from `src/i18n/i18n.js`), which does `el.innerHTML = tr(key)` for every `[data-i18n-html]` in the subtree. Values are trusted repo locale strings, so innerHTML is safe; do NOT use this attribute for user-derived content.

Call sites (one per mounted template):
- `src/ui/settings-ui.js` `openSettingsPopup` — `applyHtmlI18n($container[0])` right after `$(html)`.
- `src/drawer/drawer.js` — `applyHtmlI18n(...)` right after `.dle-drawer-inner` append.
- `src/ui/setup-wizard.js` — `applyHtmlI18n($wizard[0])` in the popup `onOpen`.

**Limitation:** applied once at mount, NOT re-applied on a live locale switch (ST's MutationObserver doesn't touch `data-i18n-html`). Reopening the popup/drawer/wizard after a locale change re-applies. Full live re-translate would need a locale-change hook — acceptable since ST locale switches generally expect a reload.

**Dynamic renders that REPLACE a static template are a second trap.** Several drawer states (`renderWhyTab` injection empty-state, `renderBrowseTab` no-data) do `$el.html('<p>…hardcoded English…</p>')`, blowing away the static `data-i18n[-html]` markup before it ever shows — so converting the static attribute is necessary but moot for those surfaces; they were English-only under every locale. The fix there is to build the replacement HTML from `tr('key')` (which returns the `_html` key's markup verbatim, so embedded `<code>`/`<a>` render). See `src/drawer/drawer-render-tabs.js` (empty-state + browse-no-data branches) — they mirror the static `drawer.html` structure key-for-key. **Rule:** any JS that `.html()`-replaces an i18n'd static block must rebuild it via `tr()`, not hardcode English. Spinner/status strings too (`dle_empty_state_choosing`).

**Drift guard:** any new `data-i18n="key"` in a `*.html` template where the EN value contains HTML tags is a regression. Reviewers reject it; use `data-i18n-html` + ensure the mounting code calls `applyHtmlI18n`. Guarded by `test/regression.test.mjs` (I18N-HTML-1).

## 73. Drawer header/footer signal vocabulary — header bars are calm, only the footer context bar earns red (v2.5 Wave 1, 2026-05-29)

The drawer status (header) and contentinfo (footer) zones encode a strict, non-overlapping color/signal vocabulary. Conflating them was the bug class this wave fixed (`audit/v2.5-drawer-header-footer/FIX-CONTRACT.md`). The rules below are a contract — reviewers reject violations.

**Header = "what got selected THIS round" (retrospective, per-turn). Footer = "settled context at rest" + system health.**

- **Header token + entries bars NEVER go red/orange.** Fill is a calm theme-derived NEUTRAL gray (`style.css` `.dle-token-bar` / `.dle-entries-bar`, B4), not green (was "good") or blue (was "info"). "Full" means the limiter worked, shown calmly. `drawer-render-status.js` only ever calls `removeClass('dle-budget-high dle-budget-critical')` on these two containers — it must NEVER `addClass` them. The CSS `.dle-budget-high/.dle-budget-critical` hazard rules for these bars were deleted (B1). Re-introducing a red/orange/hatch state on either header bar is a regression.
- **The footer context bar is the ONE bar where red is EARNED** (`.dle-context-high` / `.dle-context-critical`, A3). Threshold on **used + reserved** vs `maxContext` (overflow = losing conversation history), NOT on hitting a header cap you configured. Static glow only — no animation (BUG-170 repaint-storm lesson). At rest it stays calm green (healthy room).
- **Reserved-for-reply is ghosted AND hatched** (`.dle-context-bar-response`, A4) — visually distinct from the solid used fill, never counted as consumed. The bar's `aria-valuenow` is the **used prompt only**; the reserve is announced via `aria-valuetext` ("N used, M reserved for reply, of X max"). Never set `aria-valuenow = used + reserved` again — that conflates reservation with usage.
- **Soft "cap trimmed lore" notes** (`.dle-bar-note`, B2) are gentle/muted/italic, info-tinted — NOT warning-orange, NOT error-red, no hatch/glow, no alarm verbs (dropped/hit/exceeded). They appear ONLY when a cap actually cost lore: entries note ("N of M shown") when `trace.positionalCandidates > injected`; token note ("trimmed to fit") when any `trace.injected[].truncated`.

**Footer token-counting truths (A1/A2):**
- The context bar fill = `promptManager.tokenUsage` ONLY (`ds.contextTokens`). The old `+lib` add (folding `librarianChatStats.estimatedExtraTokens`, a per-chat payload-size proxy) into the bar was wrong — Librarian I/O is a separate API call, never part of ST's settled prompt window. NEVER add librarian tokens back into the context-bar sum.
- Real Librarian token I/O is surfaced as its OWN readout (`.dle-librarian-usage`, "Librarian: N tok") from **`state.librarianLastUsage`** — the measured `result.usage` ({totalInput,totalOutput}) captured in `index.js` after `runAgenticLoop`. This is a **per-turn snapshot** (coherent with the bar's "last generation" semantics), reset on CHAT_CHANGED. `librarianChatStats.estimatedExtraTokens` is a payload-size proxy retained ONLY for the settings-popup readout — do NOT use it for the footer.

**Entries-bar numerator excludes outlets (B3).** Outlets bypass the `maxEntries` cap (`core/matching.js` — position NONE, placed via `{{outlet::name}}` macros) yet land in `acceptedEntries` → `trace.injected`. Counting them let the bar read e.g. "7/5" clamped to 100%. `trace.injected[].outlet` flags them; the bar counts only positional entries and surfaces outlets separately (`(+N outlet)` label suffix). The injection-tab badge still counts all sources — only the **header entries bar** numerator is positional-only.

Cross-module data added this wave: `trace.injected[].outlet` (bool) and `trace.positionalCandidates` (number = positional injected + `budgetCut.length`) — both set in `index.js` at trace commit, read in `drawer-render-status.js`. Footer refreshes the librarian readout on `GENERATION_ENDED` (`drawer.js` `handleGenerationEnded` now also `scheduleRender(renderFooter)`), since usage is set just before that event is emitted.

## 74. Status glyph is pure activity; phase labels come from ONE canonical map set by phase KEY, not text sniff (v2.5 Wave 2, 2026-05-29)

The drawer status dot (`.dle-status-dot`) and the phase-text surfaces were two-axis overloaded — the glyph encoded BOTH activity (which mascot) AND health (what color), and the phase was inferred by string-matching the toast label. Wave 2 (C1–C3) split these.

**C1 — glyph = activity only.** `drawer-render-status.js` renders a Font Awesome spinner (`fa-spinner fa-spin`) whenever `indexing || pipelinePhase !== 'idle' || ds.stGenerating`, and the static DLE brand icon (`STATUS_SVG_IDLE`) at idle. The old `STATUS_SVG_CHOOSING` / `STATUS_SVG_WRITING` mascot variants were **deleted** — 3 shapes could never honestly map to 6+ phases. Do NOT reintroduce phase-specific glyph shapes; phase granularity is the *text label's* job. Spinner sized via `.dle-status-dot i.fa-spinner` (currentColor — no health tint). Reduced-motion is handled by the existing `#deeplore-drawer *` universal animation-kill rule.

**C2 — health off the glyph.** The dot no longer adds `STATUS_CLASSES[status]` colors or the `dle-status-changed` transition pulse. `computeOverallStatus` is kept ONLY to drive the SR-only `announceToScreenReader('Status: …')` live-region signal (a11y, not a visible color). All *visible* system health lives in the footer health icons (vault/connection/pipeline/cache/ai). The dot's tooltip is now activity-oriented ("DeepLore activity: <label> — click for full status"), not "System status: …". Don't put health color back on the glyph.

**C3 — ONE canonical phase→label map, set by phase KEY.** `state.PIPELINE_PHASE_LABELS` + `pipelineLabelFor(phase)` are the single source of truth for BOTH the chat toast (`#dle-pipeline-status` via `_updatePipelineStatus`) and the drawer `.dle-pipeline-label`. The fragile `text.includes('Consulting')` sniff in `index.js` (which broke if the label was relabeled or localized) is gone: `runPipeline`'s `onStatus` callback now receives a **phase key** (`'prefilter'`, `'consulting'`), and `_pipelineOnStatus` does `setPipelinePhase(key); _updatePipelineStatus(pipelineLabelFor(key))`. **Contract:** never infer pipeline phase by matching display text — set the phase deterministically with a key, derive the label from the map. The NEW `prefilter` phase ("Narrowing categories…") is emitted in `pipeline.js` only when `settings.hierarchicalPreFilter` is true (otherwise it would flicker for a no-op). Sub-second stages (gating/dedup/formatAndGroup) get NO phase — they'd only flicker — so they inherit the prior phase's label. The agentic-loop search status keeps its dynamic `(n/m)` progress but uses the canonical "Searching vault…" prefix so its phase still resolves via `startsWith('Searching')`.
