# Librarian Subsystem Internals

Code-level reference for the Librarian tool-calling subsystem. Intended for Claude Code
to avoid regressions when modifying Librarian-related code.

Source files:
- `src/librarian/agentic-api.js` -- provider detection, CMRS wrapper + proxy path (`callWithTools`), response parsing (4 formats)
- `src/librarian/agentic-loop.js` -- state machine: SEARCH -> FLAG -> DONE
- `src/librarian/agentic-messages.js` -- system prompt builder, chat message assembly
- `src/librarian/librarian-tools.js` -- `searchLoreAction`, `flagLoreAction`, gap persistence
- `src/librarian/librarian-ui.js` -- per-message dropdown injection
- `src/librarian/librarian-session.js` -- Emma conversation engine, session persistence
- `src/librarian/librarian-chat-tools.js` -- tools available inside Emma's conversation loop
- `src/librarian/librarian-prompts.js` -- bootstrap system prompts for guide-mode sessions
- `src/librarian/librarian-review.js` -- two-panel popup UI (editor + chat)
- `src/librarian/visibility.js` -- show/hide all Librarian surfaces
- `index.js` -- agentic loop dispatch in `onGenerate`, event handlers: `MESSAGE_SWIPED`, `CHAT_CHANGED`
- `src/state.js` -- state variables (including `setGenerationLockTimestamp` for keepalive)

---

## 1. Agentic Loop Architecture

DLE owns the entire tool-calling loop. No ST ToolManager, no intermediate system messages, no splicing.

### Dispatch (index.js, after pipeline commit)

After the pipeline commits lore via `setExtensionPrompt` and `_updatePipelineStatus('Generating...')`:

1. Guard: `settings.librarianEnabled && isToolCallingSupported()`
2. `abort()` — prevents ST from generating (the interceptor's abort callback)
3. `setSendButtonState(true)` + `deactivateSendButtons()` — C1: re-entrancy guard (abort re-enables send via `unblockGeneration`)
4. Build messages: `buildChatMessages(chatMessages, pipelineContext, injectedTitles, settings)` — 9-section system prompt + chat history
5. `runAgenticLoop(options)` — core state machine (onProse callback → `saveReply` during loop)
6. On success: `saveReply` handles `chat.push`, `addOneMessage`, disk save. Post-loop: emit `MESSAGE_RECEIVED` + `CHARACTER_MESSAGE_RENDERED`
7. Finally: `setSendButtonState(false)` + `activateSendButtons()`, emit `GENERATION_ENDED`, return (don't fall through to ST generation)

If `isToolCallingSupported()` is false, falls through to ST's normal generation path. A `dedupWarning` fires at runtime when `librarianEnabled && !isToolCallingSupported()` to warn the user that function calling is required.

### State Machine (agentic-loop.js)

```
SEARCH phase:
  Available tools: search + write (search capped by maxSearches)
  write() call → captures prose → transitions to FLAG phase

FLAG phase:
  Available tools: flag (capped at MAX_FLAG_CALLS = 5)
  AI ends turn (no tool calls) → DONE

DONE:
  Return { prose, toolActivity, usage }
```

Constants: `MAX_ITERATIONS = 15`, `MAX_FLAG_CALLS = 5`.

### Tool Definitions (agentic-loop.js)

Three tools in OpenAI function calling format:

| Tool | Phase | Purpose |
|---|---|---|
| `search` | SEARCH | BM25 vault search (delegates to `searchLoreAction`) |
| `write` | SEARCH | Submit final prose response — triggers SEARCH->FLAG transition |
| `flag` | FLAG | Flag lore gaps/updates (delegates to `flagLoreAction`) |

`write` is always available in SEARCH phase. When it is the only tool left (search limit reached), the system prompt instructs the AI to call it — no `toolChoice` forcing needed (see H1 comment in `agentic-loop.js`, inside the main iteration loop: `toolChoice` is always `'auto'`).

### Provider Format Handling (agentic-api.js)

> **DEPRECATED v2.5**: Custom Proxy mode dead-headed. Dispatch throws. Connection Profile is canonical. See gotcha #68.

`callWithTools()` dispatches based on the Librarian's resolved connection mode (`resolveConnectionConfig('librarian')`):
- **Proxy mode** (`mode === 'proxy'`) **— DEPRECATED v2.5**: previously called `callWithToolsViaProxy()` which sent directly to an Anthropic-compatible proxy (e.g. claude-code-proxy) via ST's CORS bridge. Tools were converted from OpenAI to Anthropic format (`toAnthropicTools`). Messages with `role: 'system'` were extracted into the `system` field. Response was raw Anthropic JSON — existing parsers handle it natively. Code paths preserved for rollback; dispatch now throws in production.
- **Profile mode** (default and only supported path as of v2.5): wraps `ConnectionManagerRequestService.sendRequest()` using the Librarian's configured profile (`connConfig.profileId`, resolved from `librarianProfileId` or the inherited aiSearch profile). Does NOT silently fall back to ST's globally-active profile — if Librarian's profile is unset, `callWithTools()` throws a hard "Librarian needs a profile in AI Connections settings." error so the user fixes it rather than getting silent active-profile inheritance (#27 sym 2).

`isToolCallingSupported()` returns `true` in proxy mode (Anthropic API always supports tools). `getProviderFormat()` returns `'claude'` in proxy mode. `getActiveMaxTokens()` uses the Librarian's configured `maxTokens` in proxy mode. (All proxy-mode helpers DEPRECATED v2.5 — preserved for rollback only.)

Four provider response formats are handled:

| Provider | Detection | Tool call location | Text location |
|---|---|---|---|
| Claude | `chat_completion_source === 'claude'` | `data.content[].type === 'tool_use'` | `data.content[].type === 'text'` |
| Google (Gemini/Vertex) | `makersuite` or `vertexai` | `data.responseContent.parts[].functionCall` | `data.responseContent.parts[].text` |
| OpenAI-compatible | default | `data.choices[0].message.tool_calls` | `data.choices[0].message.content` |
| Cohere | (via OpenAI path) | `data.message.tool_calls` | `data.message.content[0].text` |

`isToolCallingSupported(model?)` returns false for `main_api !== 'openai'`, sources in `NO_TOOLS_SOURCES` (ai21, perplexity, nanogpt, pollinations, moonshot), OR resolved model in `NO_TOOLS_MODELS` (reasoning-only models that silently fail tool calls — `deepseek-reasoner`, `^o[1-9]`, `*-r1`, `openai/o[1-9]`, `anthropic/*-thinking`). When omitted, `model` is resolved via `getResolvedModel()` (CMRS profile model first, then `oai_settings.{source}_model`). Reasoning-only model rejection emits a distinct `dedupWarning` keyed `librarian_no_tools_reasoner` so the user sees model-specific guidance rather than generic provider-doesn't-support guidance.

Google Gemini `tool_choice` normalization (G6): string values mapped to `{ mode: 'AUTO'|'ANY'|'NONE' }`.

**Multi-turn message-shape contract.** Response parsing uses provider-native shapes (table above), but multi-turn messages pushed BACK into the conversation MUST be OpenAI shape for ALL profile-mode formats — including Google. ST's `convertGooglePrompt` only reads `message.content` from input messages and ignores any pre-built `parts` array (verified ST staging 2026-04-24). `buildAssistantMessage()` and `buildToolResults()` emit OpenAI-shape (`{role:'assistant', content, tool_calls:[{id, type:'function', function:{name, arguments}}]}` and `{role:'tool', tool_call_id, content}`) for `format === 'google'`; ST translates per-provider downstream. The synthetic id stamped by `parseToolCalls()` onto `responseContent.parts[i]._dleSyntheticId` carries through `buildAssistantMessage` → `buildToolResults` so ST's internal `toolNameMap` resolves `functionResponse.name` correctly. See gotcha #41 for the full round-trip contract.

### Message Assembly (agentic-messages.js)

`buildChatMessages()` produces a `[{role, content}]` array:

1. System message: 9-section prompt (role, character context, pipeline lore, injected title list, notebook, notepad, scribe summary, tool instructions, custom prompt)
2. Chat history: last 40 non-system messages from `chat[]`, strict role alternation enforced, last message must be `user`

`buildToolResults()` handles provider-native format (C4): Claude requires all `tool_result` blocks in ONE user message; Google uses `functionResponse` parts; OpenAI/Cohere use separate `tool` role messages.

### Key Guards

- **Epoch guards:** Checked at top of every iteration: `epoch !== chatEpoch || lockEpoch !== generationLockEpoch` → break
- **Abort signal:** Checked at top of every iteration → throws `AbortError`
- **C9 keepalive:** `setGenerationLockTimestamp(Date.now())` before every API call and before tool processing, preventing the 30s stale-lock detector from force-releasing mid-loop
- **C1 re-entrancy:** `setSendButtonState(true)` after `abort()` (which calls `unblockGeneration`), restored in finally
- **H4 double-write guard:** `writeDone` flag prevents multiple `write()` calls

### Logging

- **`agentic-loop.js`:** `pushEvent` fires on loop start and completion (with `exitReason` and iteration counter). An always-on summary log line is emitted on completion regardless of debug mode.
- **`librarian-tools.js`:** `searchLoreAction` and `flagLoreAction` have debug-gated logging for query counts, BM25 hit counts, and epoch guard checks.
- **`librarian-chat-tools.js`:** `executeToolCall` is wrapped with per-call timing. `toolFlagEntryUpdate` has always-on logging (not debug-gated) since flag writes are infrequent and diagnostically important.

---

## 2. Search Action

**File:** `src/librarian/librarian-tools.js: searchLoreAction()`

### `searchLoreAction(args) -> Promise<{ text: string, titles: string[] }>`

**Input shape:**
```js
{ queries: string[] }   // preferred
{ query: string }        // legacy fallback -- coerced to [query]
```
Queries are trimmed, filtered, capped to 4 (in `searchLoreAction()` input normalization).

**Flow:**

1. Guard: `loreGapSearchCount >= settings.librarianMaxSearches` returns limit message.
2. Increment `loreGapSearchCount` IMMEDIATELY (in `searchLoreAction()`, right after the max-searches guard) -- before any await -- to prevent race when AI sends multiple concurrent search_lore calls.
3. Await `buildPromise` if vault index still loading.
4. BM25 search via `queryBM25(fuzzySearchIndex, query, librarianMaxResults, fuzzySearchMinScore)`.
5. Filter out already-injected titles (from `getCurrentVerdict()?.injectedSources` — verdict store) and `guide` entries (in `searchLoreAction()` per-query BM25 hit filter).
6. Select single best hit (highest BM25 score across all queries), return full content.
7. Resolve up to 3 linked entries from best hit's `resolvedLinks` -- manifest/summary format only.
8. Report other match counts across remaining queries.

**Return shape (CRIT-LIB-2, 2026-05-22):**
```js
{
  text:   string,    // Markdown payload for the LLM (### Title\n{content} + manifest + counts)
  titles: string[],  // Authoritative matched entry titles (best hit + linked)
  toString():    string,  // Returns .text — keeps string-coercion call sites working
  [Symbol.toPrimitive](): string,  // Same
}
```
**Consumer contract:** callers that need the matched-entry list (e.g. `agentic-loop.js` Activity dropdown) MUST read `.titles` directly. NEVER regex `### (.+)` headings out of `.text` — vault content is freeform Markdown and entries routinely have their own `### Section` subheadings; regex-extraction inflates counts and pollutes the dropdown with section names that aren't entries. The string-coercion overrides exist for backward compatibility with legacy call sites that template-interpolated the result. Error/empty-result paths return `{ text: '<message>', titles: [] }`. See `docs/gotchas.md` #66.

**Side effects:**

| Side effect | Target | Condition |
|---|---|---|
| Gap record creation | `loreGaps` via `persistGaps()` | No-result queries only |
| Gap record removal | `loreGaps` via `persistGaps()` | Query now has results but had a prior gap |
| `sessionActivityLog.push(logEntry)` | Module-local array | Always |
| Analytics | `settings.analyticsData._librarian.totalGapSearches` | Always |
| Stats | `librarianSessionStats`, `librarianChatStats` | Always |

**Log entry shape:**
```js
{ type: 'search', query: string, resultCount: number, resultTitles: string[],
  tokens: number, timestamp: number, generation: number }
```

### Token estimation (BUG-AUDIT-H19)

Uses accumulated `totalTokens` from real `entry.tokenEstimate` values. Falls back to `resultText.length / 4` only if `totalTokens` is 0 (in `searchLoreAction()` `estimatedTokens` computation).

---

## 3. Flag Action

**File:** `src/librarian/librarian-tools.js: flagLoreAction()`

### `flagLoreAction(args) -> Promise<string>`

**Input shape:**
```js
{ title: string, reason: string, urgency?: 'low'|'medium'|'high',
  flag_type?: 'gap'|'update', entry_title?: string }
```

**Flow:**

1. Validate `title` and `reason` are non-empty.
2. Default `urgency` to `'medium'`, `flag_type` to `'gap'`.
3. Call `findSimilarGap(loreGaps, title, 'flag', flagType)` for overlap detection.
4. If overlapping gap found: merge (increment frequency, escalate urgency if higher, append reason). Also `clearHiddenSilently()` to resurface hidden gaps.
5. If new: create gap record with `gapId()`, `type: 'flag'`, `subtype: flagType`.
6. Persist via `persistGaps(updatedGaps)` (guarded by `epoch === chatEpoch`).

**Gap record shape (flag):**
```js
{ id, type: 'flag', subtype: 'gap'|'update', entryTitle, query: title,
  reason, createdAt, timestamp, generation, status: 'pending',
  frequency: 1, urgency, hadResults: false, resultTitles: null }
```

**Side effects:** Same pattern as searchLoreAction -- pushes to `sessionActivityLog` with epoch guards. Tokens estimated at 10 (minimal overhead).

**Return text:** Includes instructions to not acknowledge the flag and continue.

### Overlap detection: `findSimilarGap()`

**File:** `src/librarian/librarian-tools.js: findSimilarGap()`

Tokenizes both queries via `tokenize()` (from BM25 module), computes Jaccard-like overlap ratio: `overlap / max(newSet.size, existingSet.size)`. Threshold: **>0.6** (60%). Only compares gaps with matching `type` and optionally `subtype`.

**Gotcha:** Uses `>` not `>=`, so exactly 60% overlap does NOT merge.

---

## 4. Tool Call Persistence

Tool call data (search and flag activity records) is stored on `message.extra.deeplore_tool_calls` (per-message), NOT in `chat_metadata`. This is different from `deeplore_lore_gaps` which is in `chat_metadata`.

In the agentic loop, tool activity is returned as `result.toolActivity` and stored directly on the message object during construction in `onGenerate`. No intermediate buffer or GENERATION_ENDED consolidation needed -- the loop completes before the message is created.

### Search-result push contract

Only successful searches (`titleMatches.length > 0`) push a `'search'` record onto `toolActivity` in `agentic-loop.js`. No-result searches do NOT create a dropdown record — they create a gap record via `searchLoreAction()` instead. An empty `resultTitles` array would render an empty dropdown row, which the UI would otherwise display as a misleading "search ran, found nothing" entry that looks like a successful search with zero hits. Gap records carry the same query/timestamp data and are surfaced via the gap UI instead.

---

## 6. Librarian Session

**File:** `src/librarian/librarian-session.js`

### Session persistence

**Moved from localStorage to `chat_metadata`** (BUG-043). Key: `deeplore_librarian_session`.

| Function | Purpose |
|---|---|
| `saveSessionState(session)` | Serializes to `chat_metadata[SESSION_METADATA_KEY]`, calls `saveMetadataDebounced()` |
| `loadSessionState()` | Reads from `chat_metadata`, falls back to legacy `localStorage` key (one-time migration) |
| `clearSessionState()` | Deletes from both `chat_metadata` and `localStorage` |
| `restoreSession(saved)` | Rebuilds `LibrarianSession` object from persisted data |

**Persisted fields:** `messages`, `draftState`, `entryPoint`, `gapRecord`, `manifest`, `chatContext`, `relatedEntries`, `workQueue`, `lastOptions` (BUG-326), `mode`, `guideBootstrap`, `savedAt`.

### Clear triggers

| Event | Handler | Effect |
|---|---|---|
| `CHAT_DELETED` | `clearLibrarianSessionState()` | Clears session from chat_metadata + localStorage |
| `GROUP_CHAT_DELETED` | `clearLibrarianSessionState()` | Same |
| `CHAT_CHANGED` | (index.js CHAT_CHANGED handler) | `clearSessionActivityLog()` (session state itself is per-chat, so it persists within the chat) |

### Session creation: `createSession(entryPoint, options)`

Entry points: `'gap'`, `'new'`, `'review'`, `'audit'`.
Modes (via `options.mode`): `'guide-firstrun'`, `'guide-adhoc'`, or `null`.

Builds: `manifest` (from `buildCandidateManifest(vaultIndex)`), `chatContext` (from `buildAiChatContext(chat, scanDepth)`), `relatedEntries` (BM25 search for gap queries).

Guide modes prepend `buildLibrarianBootstrapSystemPrompt()` (from librarian-prompts.js) and seed a greeting message.

### Agentic loop: `sendMessage(session, userMessage, options)`

Outer loop (tool_call -> re-enter AI) with inner loop (validation retries).

**Caps (all user-tunable via Librarian Advanced Budgets — defaults shown):**
- `librarianMaxValidationRetries` (default 3): inner validation-retry loop bound
- `librarianMaxToolCallsPerTurn` (default 10): per-turn search+flag cap before forced finalize
- Outer iteration cap = per-turn cap + 5 (BUG-232 safety net, derived not configured)
- `librarianSessionHistoryMessages` (default 10): Emma's own session history window for `buildUserPromptFromHistory()`
- `librarianAgenticHistoryMessages` (default 40): writing-AI grounding window in `buildChatMessages()`
- `librarianSessionToolCallCap` (default `null` = unlimited): session-wide ceiling on total search+flag calls since page load. When hit, forces finalize with a distinct session-cap nudge string. Counted off `librarianSessionStats.searchCalls + flagCalls`.

**Epoch guards (BUG-273):** Snapshots `chatEpoch` at entry. Re-checks after every `await callAI()` (both success and error paths) and at top of each loop iteration. On mismatch, restores history from snapshot and returns.

**Abort handling (BUG-237/253/303):** Snapshots `session.messages` before mutation. On abort or epoch mismatch, restores the snapshot so the session is not left with a one-sided user turn or orphan tool_results.

**Tool execution:** Calls `executeToolCall(name, args, session)` from `librarian-chat-tools.js`. These are Emma's internal tools (search_vault, get_entry, etc.), distinct from the agentic loop's tools (search, write, flag).

---

## 7. Librarian Chat Tools

**File:** `src/librarian/librarian-chat-tools.js`

These tools are available ONLY inside Emma's conversation loop (`sendMessage`). They are NOT the agentic loop's tools — they are executed locally via `executeToolCall()`.

### Tool list

| Tool | Read/Write | Notes |
|---|---|---|
| `search_vault` | Read | BM25 search, top_k up to 20, min score 0.3. Hit rows include `vaultSource` when set so the model can disambiguate (BUG-400). |
| `get_entry` | Read | Truncated preview (~2000 chars), metadata. Optional `vault_source` param (BUG-400). |
| `get_full_content` | Read + side effect | Full content (cap 16000 chars). Populates `session.draftState` automatically. Optional `vault_source` param (BUG-400). |
| `find_similar` | Read | Duplicate detection before creating new entries |
| `list_flags` | Read | Lists `loreGaps` records |
| `get_links` | Read | Outgoing `resolvedLinks` from an entry |
| `get_backlinks` | Read | All entries whose `resolvedLinks` include the target |
| `list_entries` | Read | Filter by type and/or tag |
| `get_recent_chat` | Read | Last N messages from `getContext().chat` (max 50) |
| `flag_entry_update` | **Write** | Creates a gap record in `loreGaps`/`chat_metadata`. Optional `vault_source` param; gap record carries `vaultSource` when known (BUG-400). |
| `compare_entry_to_chat` | Read | Side-by-side entry + recent chat (cap 6000 chars). Optional `vault_source` param (BUG-400). |
| `get_writing_guide` | Read | Dynamic -- only available when `lorebook-guide` entries exist in vault |

### Vault-aware `findEntry` (BUG-400 / Fix 8)

`findEntry(title, vaultSource = null)` is the internal lookup used by `get_entry`, `get_full_content`, `compare_entry_to_chat`, and `flag_entry_update`. With `multiVaultConflictResolution = 'all'` (default), duplicate-title entries from different vaults are intentionally preserved in `vaultIndex`. Without `vaultSource`, `findEntry` returns the first match (legacy behavior). With `vaultSource`, it returns only the entry whose `entry.vaultSource === vaultSource`, or `null` if none match.

Tools that take `title` also accept an optional `vault_source` arg, forwarded to `findEntry`. `search_vault` results include `vaultSource: <name>` per hit (omitted when empty for single-vault setups), so the model has the info it needs to disambiguate on follow-up calls.

Gap records persisted by `flag_entry_update` carry `vaultSource` when known. The drawer gap UI tolerates `vaultSource: undefined` for legacy gaps written before this fix.

### `get_writing_guide` tool

**File:** `src/librarian/librarian-chat-tools.js: toolGetWritingGuide()` (plus `getGuideEntries()` and `findGuideByName()` helpers)

Serves entries tagged `lorebook-guide` (entries where `entry.guide === true`). Uses kebab-case title matching. These entries are **never injected into the writing AI** through the normal pipeline -- they exist exclusively for the Librarian.

**Gotcha (BUG-325):** `get_writing_guide` is not in the static `LIBRARIAN_TOOLS` array -- it is dynamically built in `buildToolsPromptSection()` only when guide entries exist. The `default` case in `executeToolCall()` must list it explicitly in the error message.

### `buildToolsPromptSection()`

Generates the tools documentation section embedded in Emma's system prompt. Rebuilt every turn so the `get_writing_guide` enum reflects the current vault state.

---

## 8. Per-Message Activity Mode

**Setting:** `librarianPerMessageActivity` (default: `false`).

### Behavior differences

| Behavior | OFF (default) | ON |
|---|---|---|
| Gap records on gen start | Kept (accumulate) | Cleared via `persistGaps([])` (in `onGenerate()`, per-message-activity branch after lock acquisition) |
| Gap records on swipe | N/A (already accumulated) | Kept (not cleared) |
| `deeplore_tool_calls` on swipe | Deleted from `message.extra` (in `index.js` MESSAGE_SWIPED handler) | Preserved (will be replaced on next gen) |
| Dropdown DOM on swipe | Removed | Removed (DOM always cleared; data preserved for re-render) |
| Dropdown data persistence | Ephemeral (deleted on swipe) | Per-message (survives swipe) |

### Implementation details

**Gap clearing (in `onGenerate()`, per-message-activity branch after lock acquisition):**
```js
if (settings.librarianPerMessageActivity && settings.librarianEnabled) {
    persistGaps([]);
}
```
Runs inside `onGenerate()` after lock acquisition, before the pipeline runs.

**Swipe handling (in `index.js` MESSAGE_SWIPED handler):**
```js
if (!getSettings().librarianPerMessageActivity) {
    if (message.extra?.deeplore_tool_calls) {
        delete message.extra.deeplore_tool_calls;
        saveMetadataDebounced();
    }
}
removeLibrarianDropdown(messageId);  // always
```

**CHAT_CHANGED hydration (in `index.js` CHAT_CHANGED handler, Librarian hydration block):**
Regardless of this setting, `CHAT_CHANGED` always hydrates `loreGaps` from `chat_metadata.deeplore_lore_gaps` (normalizing legacy statuses), resets `loreGapSearchCount`, resets `librarianChatStats`, and clears `sessionActivityLog`.

**Dropdown re-render on chat load (in `index.js` CHAT_CHANGED handler, inside `injectAllChatLoadUI()` — Librarian dropdown injection pass):**
After migration, if `librarianEnabled && librarianShowToolCalls`, iterates all messages and calls `injectLibrarianDropdown(i, chat[i].extra.deeplore_tool_calls)` for any message that has stored tool call data.

---

## Cross-Cutting Concerns

### Gap persistence: `persistGaps(updatedGaps)`

**File:** `src/librarian/librarian-tools.js: persistGaps()`

1. Checks `getContext().chatMetadata` availability BEFORE mutating state (BUG-304).
2. Caps gap count to 200 (BUG-AUDIT-C03), evicting oldest by `createdAt`.
3. Sets `loreGaps` in state, writes `meta.deeplore_lore_gaps`.
4. Prunes orphaned IDs from `deeplore_lore_gaps_hidden` and `deeplore_lore_gaps_dismissed` sibling arrays (BUG-AUDIT-H09).
5. `saveMetadataDebounced()`.

### Gap soft-removal (two tiers)

| Tier | Array | Re-flag behavior |
|---|---|---|
| Hidden | `deeplore_lore_gaps_hidden` | Re-flag resurfaces (calls `clearHiddenSilently`) |
| Dismissed | `deeplore_lore_gaps_dismissed` | Re-flag does NOT resurface, but escalates urgency silently |

Functions: `hideGap()`, `dismissGap()`. (Un-hide/un-dismiss go through re-flag, which honors the tier's re-flag behavior above.)

### `notifyLoreGapsChanged()`

**File:** `src/state.js: notifyLoreGapsChanged()`

Callback-based observer pattern. `setLoreGaps()` calls it automatically. Also called explicitly by `searchLoreAction` and `flagLoreAction` after pushing to `sessionActivityLog` (to update the Activity sub-tab even when `persistGaps` was not called).

### Session stats vs chat stats

| Variable | Scope | Reset trigger |
|---|---|---|
| `librarianSessionStats` | Page load | Never (survives CHAT_CHANGED) |
| `librarianChatStats` | Per-chat | `CHAT_CHANGED` (in `index.js` CHAT_CHANGED handler, Librarian hydration block) |

Both track `{ searchCalls, flagCalls, estimatedExtraTokens }`.

### Connection Mode Default and Migration

**`librarianConnectionMode` now defaults to `'inherit'`** (was `'profile'`). The `inherit` mode falls back to `aiSearch` connection settings.

**Migration v2→v3** (`settingsVersion` bumped from 2 to 3): Unconfigured profile connections are auto-migrated to `inherit`. This runs in `getSettings()` when `settingsVersion < 3`.

**Onboarding validation**: When the Librarian is enabled in settings, validation checks the connection config and shows a toastr warning if function calling is not supported by the current provider/model.

**Runtime warning**: `dedupWarning` fires in `onGenerate` when `librarianEnabled && !isToolCallingSupported()`. This catches cases where the user enables the Librarian but their active connection doesn't support tool calling.

---

### Activity feed: `buildLibrarianActivityFeed()`

**File:** `src/librarian/librarian-tools.js: buildLibrarianActivityFeed()`

Merges session activity log (in-memory) with persistent gap records (loreGaps). Deduplicates by `type:query:timestamp/2000` key. Persistent search gaps are excluded (only live session searches shown). Returns newest-first array consumed by both the drawer and the popup.
