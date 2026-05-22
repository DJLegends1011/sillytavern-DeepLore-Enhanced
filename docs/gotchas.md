# Gotchas — Read Before You Touch Anything

Every item here has caused a regression. Read this before modifying pipeline, state, or lifecycle code.

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
- `hierarchicalPreFilter` uses `releaseHalfOpenProbe()` — its outcome shouldn't affect the breaker since `aiSearch()` handles its own probing
- Stale probes auto-reset after 60s (`AI_PROBE_TIMEOUT`)

**Where:** `src/state.js` — AI circuit breaker state machine: `recordAiFailure()`, `recordAiSuccess()`, `releaseHalfOpenProbe()`, `isAiCircuitOpen()`, `tryAcquireHalfOpenProbe()` (see header comment on the 3-state CLOSED/OPEN/HALF-OPEN machine).

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

## 19. `pseudonymizeTrace()` Must Scrub `matchedBy` and AI `reason`

**Rule:** When pseudonymizing pipeline trace data for diagnostic export, `matchedBy` fields and AI `reason` strings must also be scrubbed.

**Why:** `matchedBy` can contain entry titles and keyword matches that reveal vault content. AI `reason` strings contain the AI's rationale for selecting entries, which can quote vault content or character names. Without scrubbing these, the "anonymized" diagnostic export leaks user content.

**Where:** `src/diagnostics/state-snapshot.js` `pseudonymizeTrace()`.

---

## 20. Scrubber Pattern Callback Argument Counts

**Rule:** Each pattern `fn` in `src/diagnostics/scrubber.js` MUST have parameter count = (1 match + N capture groups + offset + fullString + ctx). The wrapper appends `ctx` after `String.prototype.replace`'s standard args. A phantom parameter shifts `ctx` to a position that never gets filled → `ctx` is `undefined` → `TypeError` → silently caught → pattern does nothing.

**Why (BUG found by test suite):** 7 of 10 scrubber patterns (Bearer tokens, URL tokens, OpenAI keys, IPv4, IPv6, emails, long tokens) had an extra `_gl` phantom parameter, causing `ctx` to always be `undefined`. The outer try/catch swallowed the TypeError. Result: diagnostic exports only scrubbed file paths and hostnames — IPs, emails, API keys, and bearer tokens passed through unredacted.

**Pattern:** For a regex with N capture groups, the fn should have exactly `N + 4` parameters: `(match, ...Ngroups, offset, fullString, ctx)`.

**Where:** `src/diagnostics/scrubber.js: PATTERNS` array.

---

## 21. Agentic Loop Epoch Guards

**Rule:** The agentic loop MUST check `epoch !== chatEpoch || lockEpoch !== generationLockEpoch` at the TOP of every iteration, before any API call or state mutation. Also check `signal.aborted`.

**Why:** The agentic loop runs multiple iterations (up to 15) with awaits between each. A chat switch or stop-button press during any iteration must bail the loop immediately. Without this, a stale loop writes tool results and creates messages in the wrong chat.

**Where:** `src/librarian/agentic-loop.js: runAgenticLoop()` — epoch + abort check at iteration start of the main `for` loop.

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

## 43. `onProse` Re-Checks Epoch After Every Await

**Rule:** Inside `onProse` (Librarian write-tool handler), re-check both `chatEpoch` and `generationLockEpoch` after each await — at minimum after `saveReply()` and after `saveChatConditional()`. If the epoch changed during the await, set `proseMsg = null` and bail.

**Why:** `saveReply` awaits `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED` handlers; either can yield long enough for the user to switch chats. Without a recheck, `chat[chat.length - 1]` is captured on the *new* active chat, then `saveChatConditional()` persists the captured ref into a chat that the user never asked to write to. The post-loop recheck at the outer try/catch isn't enough on its own — it stops downstream mutation but doesn't prevent the trailing `saveChatConditional()` inside `onProse` from running on the wrong chat. Pattern: any new await inside `onProse` needs another guard.

**Where:** `index.js` — Librarian dispatch block (`runAgenticLoop` callback path).

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
- IDB spill (`IDB_PER_CHAT_CAP=200`) is current-chat-only. On CHAT_CHANGED: `clearChat(null)` drops the ring, `setCurrentChatId(newId)` rebinds scope, `hydrateChat(newId)` async-pulls IDB rows for resume-after-reload.
- **NEVER** persist verdicts to `chat_metadata` — that would bloat chat files. The Roadmap explicitly rejected that variant.
- Pipeline writes ONE verdict per turn at commit (after `setExtensionPrompt` calls). Empty-injection turns still write a verdict (`injectedSources: []`) so consumers see "nothing this turn" instead of the prior verdict bleeding through.

**Trace shape note:** `trace.keywordMatched`, `aiSelected`, `cooldownRemoved`, `contextualGatingRemoved`, `gatedOut`, `stripDedupRemoved`, `budgetCut`, `refineKeyBlocked`, `probabilitySkipped`, `warmupFailed` now carry `vaultSource` on each entry (2026-05-22). The perEntry aggregator in `verdict-pure.js` requires this to honor the trackerKey invariant (vaultSource:title) under `multiVaultConflictResolution='all'`.

**CHARACTER_MESSAGE_RENDERED attachment:** The handler in `index.js` reads the current verdict and attaches `message.extra.deeplore_sources` only when `verdict.msgIdx === messageId && verdict.epoch === chatEpoch`. The `message.extra._deeplore_sources_tag` flag prevents double-attach on swipe.

**Where:** `src/verdict/verdict-store.js` (live), `src/verdict/verdict-pure.js` (testable helpers), `src/vault/cache.js` (shared IDB `DeepLoreEnhanced` schema v2). Consumer call sites: drawer (`drawer-render-tabs.js` / `-status.js` / `-footer.js` / `drawer.js` / `drawer-events.js`), `src/ui/cartographer.js`, `src/ui/commands-pipeline.js` (`/dle-inspect`), `src/ui/diagnostics.js`, `src/librarian/librarian-tools.js`, `src/diagnostics/flight-recorder.js`, `src/diagnostics/state-snapshot.js`. Tests: `test/verdict.test.mjs` (70 pure-helper), regression VRD-1..VRD-7.
