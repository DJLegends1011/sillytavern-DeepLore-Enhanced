# Changelog

## 2.5 (in progress)

> Six-locale UI, single source of truth for pipeline verdicts, Custom Proxy retirement, and a wide reliability sweep.

### Internationalization

- **6 locales out of the box** — English (canonical) plus German, Spanish, French, Japanese, Simplified Chinese. UI strings (~2100 keys) and AI prompts (30 modules) both translated. Coverage: 95.8–97.3% UI per locale, 100% AI prompts. Hooks ST's built-in `addLocaleData()` + `data-i18n` MutationObserver — no custom layer.
- **AI prompt locale is a separate axis** — defaults to follow UI locale, can be pinned to English if you don't trust machine translations to preserve LLM behavior. Setting: `aiPromptLocale`.
- **Placeholder validator with unique-index semantics** — `${0}` and `${1}` indexed only; re-references like `${0} ... ${0}` count as one index so translators can match grammatical agreement (ES adjective/noun, etc.) without tripping validation.

### Removed

- **Custom Proxy AI connection mode** — dead-headed. Connection Profile supersedes. Existing users migrated automatically with a one-shot notice popup. Code preserved for rollback (`src/ai/proxy-api.js` still present, marked `@deprecated v2.5`). `enableCorsProxy: true` is no longer required for DLE AI features. See `docs/gotchas.md` #68.

### New Features

- **WI import: full ST World Info field parity** — every WI field now has a documented home (see `docs/gotchas.md` #69 for the contract). Companion-extension API additions: `convertWiEntry` return now carries `title` + `_emPosition`; `upsertConvertedEntry` returns a new `report` object + can return `action: 'em-skipped'` for Example Messages entries when `wiImportEmHandling === 'skip'`. Existing destructuring patterns (`{filename, content}` etc.) keep working — additive only.
  - **Native (DLE acts on):** `disable` → `enabled: false` (pre-fix disabled WI entries silently imported as active — the most damaging silent downgrade in the importer), `excludeRecursion`, `role` (Wave 1), plus `selective_logic` with all 4 modes enforced by new `applySelectiveLogic` gate (`and_any`, `and_all`, `not_all`, `not_any` — Wave 3), plus Example Messages positions 5/6 with `## Example Dialogue` subheader handling and configurable skip-on-import (Wave 4).
  - **Round-trip preserved** (snake_case frontmatter, surfaced by `/dle-lint` as new `W_WI_ROUND_TRIP` code): `vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, plus 6 `match_*` scan-source toggles (Wave 2).
  - **Structured import report popup** replaces the old success/warning toast — shows per-field counts, EM handling breakdown, friendly EM explainer with one-click "Skip on future imports" button that flips the `wiImportEmHandling` setting (Wave 5).
- **VerdictStore** — single source of truth for "what DLE decided this turn." Replaces the racing globals `lastInjectionSources` / `lastPipelineTrace` / `previousSources` / `lastInjectionEpoch`. Ring buffer (50) + per-chat IndexedDB spill (~200) survives chat switches and page reloads. 14 call sites migrated. See `docs/gotchas.md` #46.
- **Drawer Browse: folder grouping + batch optimize** ([#13](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/13), [#26](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/26)) — collapsible folder headers, batch-select for `/dle-optimize-keys` runs.
- **Dedicated summarize feature** ([#15](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/15)) — `/dle-summarize-range` produces and inserts a summary message with one-step rollback.
- **DLE-side response prefill** — anthropic-only or all-providers, configurable. Lets you prime the writer's first tokens without leaning on profile-level prefill.
- **AI manifest field whitelist** — `aiManifestIncludeFields` prunes custom fields from the manifest sent to the selector, saving tokens on vaults with rich frontmatter.
- **Manual AI circuit-breaker reset** (PR [#28.1](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)) — drawer button to clear the tripped breaker without waiting out the 30s cooldown.
- **Fuzzy entry-name matching** for `/dle-pin`, `/dle-block`, `/dle-unpin`, `/dle-unblock`, `/dle-optimize-keys` — typos and partial titles resolve to the nearest entry.
- **Single-entry convert-and-upsert** (PR [#28.2](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)) — `upsertConvertedEntry` for companion-extension integrations. Rename / replace / skip collision policies.
- **Caveman compression at import** — `importCompressByDefault` setting + per-call override; body passed through `compressCaveman()` and frontmatter annotated `compress: caveman`. Unknown modes warn rather than lie about transform state.
- **Frontmatter surgery + priority reverse** for batch-edits across multiple entries.
- **AI Notepad polish** ([#25](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/25)) — entry-count FIFO cap, pinned entries survive the cap, manual fuzzy dedup, refuse threshold=0 / empty input (data-wipe guard).
- **Per-tool default write vault + Librarian per-write override** ([#29](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/29), [#32](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/32)) — auto-suggest, scribe, librarian can each target a different vault.
- **Librarian tool-call budgets** surfaced as user settings (previously hard-coded).

### Bug Fixes

- **Verdict refactor closes a class of pipeline-state races** — UI consumers (drawer, cartographer, `/dle-why`) now read by `(chatId, msgIdx)` instead of the most-recent global, so swipes/regens/chat-switch no longer surface stale data.
- **`trackerKey(entry)` unified across all sites** — drawer browse, librarian search, strip-dedup log, cascade titleMap, `applyPinBlock` matchedKeys, sort tiebreaks. Bare `entry.title` Map keys were colliding across vaults; reviewers should reject any new bare-title key in pipeline/drawer/librarian/ai-search. See `docs/gotchas.md` #50.
- **Bootstrap exemption now generation-scoped** — `lorebook-bootstrap` bypasses ALL gating only while `bootstrapActive === true`. Once bootstrap deactivates, bootstrap-tagged entries are gated like any other. See `docs/gotchas.md` #60.
- **Post-await epoch guards on every branch** in pipeline / stages / AI / librarian. Aborted generations no longer commit verdict, fire status, or push to chat.
- **Shared 401/429 breaker classifier** — AI and Librarian agree on which errors trip the circuit breaker.
- **Vault**: partial-fetch handling, file-overwrite guard, prototype pollution guard, rename safety, incremental reuse-sync correctness.
- **WI import dedup probe failures fail loud** (V-C2) — a network glitch during the existence check used to return "assume free" and overwrite real vault files. Now returns null and surfaces an error.
- **WI import: vault rename is destructive** (V-M5) — renaming a vault changes the `vaultSource` prefix and orphans every per-entry tracker (cooldowns, decay, pins, blocks, chat counts, analytics). Settings UI now confirms before applying. See `docs/gotchas.md` #62.
- **Strip-dedup hash always reflects pre-truncation canonical content** (M-8) — a budget cut that shrinks "Castle" still dedups against the prior full-content "Castle" log line. See `docs/gotchas.md` #65.
- **`applyStripDedup` lookbackDepth ≤ 0 is a no-op**, not "dedup against entire log" (M-4) — external callers (`/dle-why`, `matchTextForExternal`) used to silently get the whole log. Pass `Number.MAX_SAFE_INTEGER` for the old behavior. See `docs/gotchas.md` #65.
- **`hasWarmup(entry)` is the canonical warmup-gate predicate** (M-6) — all three match paths (primary keyword, recursion, BM25) now use the same helper. Diverged on NaN/0/negative/Infinity/non-number. See `docs/gotchas.md` #65.
- **Gemini token-usage aliases** ([4e94339](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/commit/4e94339)) — `usageMetadata.promptTokenCount` / `candidatesTokenCount` parsed alongside the legacy field names; defensive parser hardening across providers.
- **CMRS AbortError unwrap** (BUG-249) — ST's wrapper around aborted fetches was misclassified as a generic error and tripped the breaker. Now demoted.
- **Drawer dismiss safe inside spawned popups**, init promise latch, pipeline-status orphan guard, PM-mode registration latch, settings-popup safety.
- **Scribe**: `/dle-scribe-history` reads from the configured Scribe vault, not the primary.
- **Librarian**: resolves model from the configured profile rather than the active profile ([#27](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/27)); null/0 session-cap treated as unlimited (BUG-071).
- **Slash commands**: `unnamedArgumentList` + `enumProviders` backfilled across remaining commands (BUG-040); `/dle-librarian` autocomplete + popup-scoped pickers + prefill lifecycle fixed.
- **Summary rollback data corruption** + summarize/batch-optimize hardening.

### Tests

- **Queue-based async runner** for the integration suite — no more flaky ordering on slow CI.
- **VRD-1..VRD-12 regression guards** for the Verdict refactor, including Wave C P1 prune sampling and bounded-cursor invariants.
- **PERF-P2-1..PERF-P2-5** for the exemption-policy cache.
- **i18n parity tests** across all 5 translations: key-count match, key-set match, placeholder preservation, AI prompt-module export contract.
- **Coverage backfill** for `cmrsResultToText` edges, `comparePriority` ([#16](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/16)), `resetAiCircuitBreaker` (PR [#28.1](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)), `summarize`, caveman extras, BUG-043 round-trip, pin invariants.

Total: ~4715 assertions across 11 test files.

---

## 2.0.2 (2026-04-27)

> Hotfix for AI search regression on non-Claude models.

### Bug Fixes

- **AI search no longer throws `slice is not a function` on non-Claude models** ([#24](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/24)) — ST's `custom-request.js` replaces `result.content` with a parsed object when `data.json_schema` is set on the chat-completions route. `callViaProfile` was assigning that object straight to `text`, breaking `extractAiResponseClient` and the debug-preview `.slice` for every non-Claude provider. Fix re-stringifies through a new `cmrsResultToText` helper so the string contract holds across all callers. Claude path was already skipping `json_schema` (forced tool_choice + extended thinking conflict) and is unaffected. Regression test added.

---

## 2.0.1 (2026-04-26)

> First post-release patch from open-issue triage on v2.0-beta.

### Bug Fixes

- **Vault entry content no longer XML-escaped on injection** ([#16](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/16)) — vault content was passing through `escapeXml` in `formatAndGroup`, so any `<tag>`, `&`, or `"` reached the LLM as `&lt;tag&gt;` etc. Title escape stays (load-bearing for the `<{{title}}>` wrapper tag name). Content now passes through raw — vault authors intentionally embed XML, markdown, code samples, and ampersands. Reverts the content-side half of BUG-090. Adds gotcha #45 documenting title-only escape policy.

### Settings

- **Timeout caps raised to 999999ms (~16 min)** ([#19](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/19)) — six per-feature timeout settings (`aiSearchTimeout`, `scribeTimeout`, `autoSuggestTimeout`, `aiNotepadTimeout`, `optimizeKeysTimeout`, `librarianSessionTimeout`) had their max clamp bumped from 120000ms to 999999ms. Defaults unchanged. Slow local LLMs and reasoning models on backed-up providers can now configure higher per-feature timeouts. Wiki + Roadmap updated with footgun guidance.

---

## 2.0-beta (2026-04-26)

> The Librarian update. Your lorebook grows with your story — the writing AI flags what's missing, Emma helps you write it.

### The Librarian (Emma)

DeepLore now has Emma, your librarian. As you roleplay, the writing AI reaches for details it needs; when one isn't in your vault, it flags the gap. You open the flag, chat with Emma, and she helps you author a vault-accurate entry. Your lorebook grows alongside your story.

- **Automatic gap detection** -- As the writing AI reaches for lore that isn't in your vault, it flags the gap to a dedicated inbox. Two dismissal tiers: hide to suppress, dismiss to bury. Re-flagging a hidden gap resurfaces it.
- **Vault audits** -- `/dle-librarian audit` walks through your entire vault and flags gaps, inconsistencies, and entries that need updating.
- **Generation tools** -- Writing AI gets two tools it calls automatically mid-generation: `search` queries your vault for relevant entries, `flag` silently notes gaps and stale entries. Runs in the background when the Librarian is enabled.
- **Emma's toolset** -- In her chat session, Emma has a dozen tools: `search_vault`, `get_entry`, `get_full_content`, `find_similar`, `list_flags`, `get_links`, `get_backlinks`, `list_entries`, `get_recent_chat`, `flag_entry_update`, `compare_entry_to_chat`, and `get_writing_guide`.
- **Writing guides** -- Tag any vault entry with `lorebook-guide` to make it a Librarian-only style reference. Emma fetches these guides via `get_writing_guide` to inform her suggestions; they never reach the writing AI through any path.
- **Graph-aware search** -- Writing AI's `search` tool resolves linked entries from `resolvedLinks`, not just BM25 matches — results pull in directly-related lore automatically.
- **Behind-the-scenes UX** -- Tool calls are hidden during generation and consolidated into a single expandable dropdown on the final message. Real-time status ("Choosing Lore...", "Consulting vault...", "Generating...") shows pipeline and writing-AI tool progress, and cleans up when done.
- **Session continuity** -- Emma's chat session (messages, draft state, work queue) persists in `chat_metadata` across page reloads and chat switches. Gaps flagged by the writing AI persist separately. Pick up where you left off.
- **Librarian drawer tab** -- See your gap list, flagged entries, and session stats at a glance with quick-dismiss controls.
- **Customizable persona** -- Tweak Emma's personality and focus through an editable prompt. Make her chattier, more formal, or focused on specific aspects of your world.
- **Auto-enables function calling** -- Turning on the Librarian automatically enables function calling on your active API connection, so you don't have to hunt for the setting.

### Drawer Polish

- **Toolbar buttons** -- Librarian and Graph buttons added to the drawer header toolbar for quick access.
- **Footer simplification** -- The footer now shows `totalUsed / maxContext` with a tooltip breakdown, replacing the verbose multi-line display.
- **Librarian popup** -- Unified textarea replaces the old form-field layout. Chat auto-expands as you type, and tool names are shown in plain English.

### Performance & Indexing

- **BM25 inverted index** -- Fuzzy search now uses an inverted posting list, scoring only documents that contain query terms instead of scanning the full index.
- **Multi-vault duplicate detection** -- Vaults with overlapping entries now detect duplicates via content hashing, preventing double-injection.
- **Cache fingerprinting** -- Improved cache fingerprint logic for more reliable freshness detection across vault rebuilds.
- **HTTPS support** -- Obsidian connections now support HTTPS for remote or secured setups.

### Settings Redesign

The settings popup has been reorganized for clarity and easier navigation.

- **About tab** -- Redesigned as the landing tab with the DLE logo, master enable toggle, social links, diagnostics panel (moved from System), and a danger zone for destructive actions.
- **Reference tab** -- The slash command quick-reference grid now lives in its own tab instead of being buried in another section.
- **Grey-out audit** -- 43 disable patterns now correctly dim dependent settings when their parent feature is off. No more editing settings for features you've disabled.

### Diagnostics

A new diagnostics subsystem for debugging issues and filing bug reports.

- **Flight recorder** -- A ring buffer captures recent extension activity (pipeline runs, tool calls, errors) for export.
- **State snapshots** -- Capture the current extension state for debugging without restarting.
- **Diagnostics panel** -- View, export, and manage diagnostic data from the About tab in settings.
- **IP masking** -- Diagnostic exports automatically mask IP addresses, preserving the first two octets for network-level debugging while protecting your identity.

### New Slash Command

| Command | Description |
|---------|-------------|
| `/dle-librarian` | Toggle the Librarian on/off. Use `/dle-librarian audit` to trigger a comprehensive vault review. |

### New Frontmatter Field

| Field | Type | Description |
|-------|------|-------------|
| `guide` | boolean | Via `lorebook-guide` tag -- Librarian-only writing/style guide. Never reaches the writing AI. |

### Bug Fixes

Fixed ~350 stability and correctness bugs across comprehensive code audits. Highlights include data integrity safeguards (multi-vault safety, cache consistency, vault sync reliability), AI selection robustness (timeout handling, search fallback logic, circuit breaker fixes), UI and state reliability (chat lifecycle resets, drawer rendering, gating field persistence, swipe/regen handling), and edge case hardening (special character support, abort/stop races, multi-vault path collisions, and more).

### Under the Hood

- 960 → 1,313 passing tests.
- New `librarian/` module directory (8 focused files).

---

## 1.0.0-beta (2026-03-30)

> Feature-complete release. Combines all v0.2.0 development work with v1.0.0 stabilization.

### Custom Frontmatter Fields

Contextual gating is now fully customizable. Define your own frontmatter fields (mood, faction, time_of_day -- anything), configure gating rules, and manage everything from a visual editor. The four built-in fields (era, location, scene_type, character_present) are now just defaults.

- **Field Definition Editor** -- Visual rule builder popup (`Manage Fields` button in Gating tab or Settings) to create, edit, reorder, duplicate, and delete custom gating fields. Supports text, number, boolean, and list types with per-field gating operators (equals, contains, any_of, none_of) and tolerance levels.
- **YAML-backed definitions** -- Field definitions stored in Obsidian vault (`DeepLore/field-definitions.yaml`) and loaded on index build. Editable from the rule builder or by hand.
- **Generic commands** -- `/dle-set-field <name> [value]` and `/dle-clear-field <name>` work for any defined field, with tab-completion for field names. Legacy `/dle-set-era` etc. are now aliases.
- **Drawer integration** -- Gating tab shows status dots (set/unset), multi-value distinction, impact counts ("excluding N entries"), and an empty-state hint for new users. Manage Fields button in toolbar.
- **Browse tab filters** -- Custom field filter dropdowns appear automatically for any field with values in the vault.
- **Graph coloring** -- Color nodes by any custom field value. Legend shows field name header and "No value" swatch. Tooltip shows multi-value overflow.
- **AI manifest labels** -- Field labels (not raw names) shown in AI search manifests.
- **Inspect details** -- `/dle-inspect` shows per-field mismatch reasons for gated entries (e.g. `era: medieval ≠ renaissance`).
- **Status command** -- `/dle-status` shows custom field count and names.

### AI Notepad

- **AI-written session notes** -- The AI can maintain running notes about important story details (decisions, relationship changes, revealed secrets) using `<dle-notes>` tags. Notes are stripped from the visible chat, accumulated per-chat in `chat_metadata`, and reinjected into future messages as context.
- **Configurable injection** -- Position, depth, and role controls (same pattern as Author's Notebook). Custom instruction prompt override available.
- **Per-message tracking** -- Each message's extracted notes stored on `message.extra.deeplore_ai_notes` and visible in Context Cartographer popup.
- **`/dle-ai-notepad`** -- View/edit accumulated notes with token count, or `/dle-ai-notepad clear` to reset.

### AI Summaries on Import

- **`/dle-import` → summarize piping** -- After importing World Info entries, DLE offers to generate AI summaries for imported entries that only have placeholder text. Reuses the `/dle-summarize` pipeline.
- **Extracted `summarizeEntries()`** -- Shared function in `commands-ai.js` used by both `/dle-summarize` and the import flow.

### Local LLM Timeout Caps

- **Raised timeout limits** -- AI Search timeout cap raised from 30s → 120s. Auto-suggest timeout cap raised from 60s → 120s. Scribe was already 120s.
- **Local LLM guidance** -- Tooltip hints on all timeout inputs: "Local LLMs may need 60-120s. Cloud APIs typically respond in 5-15s."

### Live Drawer -- Performance & UX Polish

- **Smart overlay mode** -- On wide chat layouts, the drawer floats over the chat instead of squeezing it, so you never lose reading space.
- **Close button** -- Quick-dismiss button next to the lock icon.
- **Tab count badges** -- See at a glance how many entries are injected, how many are in your vault, and how many gating filters are active.
- **Gating impact counts** -- Each active filter shows how many entries it's currently blocking, so you know if your filters are too aggressive.
- **Smooth scrolling for large vaults** -- Browse tab now handles hundreds of entries without slowing down (virtual scroll rendering).
- **Click-to-expand previews** -- Click any entry in Browse to see its summary, token count, and a direct link to open it in Obsidian.
- **Responsive layout** -- Drawer adapts gracefully to narrow and short screen sizes.

### World-Building Tools

- **AI Notebook** -- A persistent per-chat scratchpad that the AI sees every turn. Jot down plot notes, character reminders, or session goals with `/dle-notebook` -- they survive reloads and stay with the chat.
- **Auto Lorebook Creation** -- AI analyzes your chat and suggests new entries for characters, locations, and concepts it notices. Review, edit, and accept -- entries are written directly to Obsidian. Use `/dle-newlore` or let it run automatically.
- **Optimize Keywords** -- `/dle-optimize-keys` asks AI to suggest better trigger keywords for any entry, so your lore fires when it should.
- **Auto-Summary Generation** -- `/dle-summarize` writes AI search summaries for entries that are missing them, improving how well the AI selects your lore.
- **Import from SillyTavern** -- `/dle-import` converts your existing SillyTavern lorebooks (World Info JSON) into Obsidian vault notes with proper frontmatter.
- **Entry Relationship Graph** -- `/dle-graph` visualizes how your entries connect -- requires, excludes, cascade links, and wiki-links -- as an interactive force-directed graph with LinLog + FA2 physics, Louvain clustering, Serrano disparity filter, ego-centric radial focus, and gap analysis overlay.

### Smarter Lore Selection

- **Roll the dice** -- New `probability` field lets entries randomly appear when matched (0.0-1.0), adding variety to your lore injection.
- **Per-chat pin & block** -- Force specific entries on or off for the current chat without editing your vault. `/dle-pin`, `/dle-block`, and friends.
- **Contextual gating** -- Filter entries by era, location, scene type, or which characters are present. Your Victorian-era lore won't leak into the sci-fi arc.
- **Entry rotation** -- Entries that haven't appeared in a while get a boost; overused entries get a penalty, keeping your lore fresh.
- **Injection deduplication** -- Skip re-injecting entries that are already in the AI's recent context, saving token budget for new lore.
- **Smarter budget management** -- Entries that don't fit the remaining budget are now trimmed to sentence boundaries instead of being dropped entirely. The AI also over-requests and picks the best matches by confidence.
- **Scribe-informed retrieval** -- Feed the Session Scribe's latest summary into AI search, so entry selection reflects what actually happened in the story.
- **Large vault support** -- Vaults with 40+ entries are automatically clustered by category for more efficient AI selection.

### Visibility & Diagnostics

- **Entry Browser** -- `/dle-browse` opens a searchable, filterable popup of all your entries with content previews, usage stats, and direct Obsidian links.
- **Activation Simulation** -- `/dle-simulate` replays your chat history step-by-step, showing exactly which entries activate or deactivate at each message.
- **"Why Not?" Diagnostics** -- Click any unmatched entry in Test Match to see exactly why it didn't fire and what to fix.
- **Enhanced Context Cartographer** -- See token usage per entry, injection positions, expandable content previews, and vault attribution for multi-vault setups.
- **Scribe Session Timeline** -- `/dle-scribe-history` fetches and displays all your session notes from Obsidian.

### Infrastructure

- **Multi-vault support** -- Connect multiple Obsidian vaults with independent settings. Entries are merged with clear vault attribution throughout the UI.
- **Zero loading delays** -- Your vault index is saved to browser storage for instant page loads. Obsidian is checked in the background to ensure freshness.
- **Smart caching** -- AI search results are cached and reused when only new chat messages are added (no vault changes), saving API calls.
- **Automatic error recovery** -- If Obsidian goes down, DeepLore automatically backs off and retries with increasing delays instead of hammering your connection.
- **Incremental sync** -- On auto-refresh, only new or changed files are downloaded instead of re-fetching everything.
- **Proxy cache optimization** -- In proxy mode, the manifest is positioned to take advantage of prompt caching on supported providers.
- **Setup Wizard** -- `/dle-setup` walks you through first-time configuration step by step.
- **Quick Actions Bar** -- One-click buttons in settings for Browse, Health, Refresh, Graph, Simulate, Analytics, and more.

### UI/UX Design Round

- **Rule builder UX** -- Double-click save guard, unsaved changes warning on close, reset confirmation dialog, field reorder (move up/down), duplicate field, scroll-to on add, delete animation, contextKey auto-link toggle, gating-disabled dimming, error field highlighting with scroll-to, specific success messages.
- **CSS foundations** -- 10 missing/incomplete CSS definitions fixed: `--dle-bg-2` variable, `.dle-gating-fields-container`, `.dle-rb-header` styling, `.dle-rb-select` theme integration, `.dle-rb-lbl` contrast fix, `.dle-rb-popup` padding, `.dle-manage-fields-btn` toolbar layout, `.dle-gating-group` hover states, chip focus-visible states.
- **Responsive** -- Rule builder adapts at 1024px and 768px breakpoints.
- **Drawer icon** -- Changed from FA scroll to inline Obsidian crystal SVG.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/dle-why` | Show why entries would/wouldn't inject (alias: `/dle-context`) |
| `/dle-browse` | Searchable entry browser with content preview |
| `/dle-graph` | Interactive entry relationship graph |
| `/dle-simulate` | Replay chat showing entry activation timeline |
| `/dle-inspect` | Detailed pipeline trace of last generation |
| `/dle-status` | Show extension status, vault stats, and active settings |
| `/dle-notebook` | Open/edit persistent per-chat AI scratchpad |
| `/dle-ai-notepad` | View or clear AI-written session notes |
| `/dle-newlore` | AI suggests new lorebook entries from chat (alias: `/dle-suggest`) |
| `/dle-optimize-keys` | AI keyword suggestions for entries |
| `/dle-summarize` | Generate AI summaries for entries without one |
| `/dle-review` | AI review of vault entry quality |
| `/dle-scribe` | Write a session summary to Obsidian on demand |
| `/dle-scribe-history` | View all session notes from Obsidian |
| `/dle-librarian` | Toggle the Librarian AI tool system on/off |
| `/dle-pin` | Pin an entry to always inject in the current chat |
| `/dle-unpin` | Remove a pin from the current chat |
| `/dle-block` | Block an entry from injecting in the current chat |
| `/dle-unblock` | Remove a block from the current chat |
| `/dle-pins` | Show all pins and blocks for the current chat |
| `/dle-set-field` | Set any custom gating field value |
| `/dle-clear-field` | Clear a custom gating field value |
| `/dle-set-era` | Alias: set active era |
| `/dle-set-location` | Alias: set active location |
| `/dle-set-scene` | Alias: set active scene type |
| `/dle-set-characters` | Alias: set present characters |
| `/dle-context-state` | Show all active gating fields |
| `/dle-set-folder` | Filter entries by vault folder path |
| `/dle-clear-folder` | Clear folder filter |
| `/dle-clear-all-context` | Clear all active gating filters at once |
| `/dle-refresh` | Refresh vault index from Obsidian |
| `/dle-import` | Import SillyTavern World Info JSON into the vault |
| `/dle-setup` | Run the first-time setup wizard |
| `/dle-health` | Audit entries for common issues (30+ checks) |
| `/dle-analytics` | Show entry usage analytics popup |
| `/dle-diagnostics` | Export diagnostics bundle (alias: `/dle-diag`) |
| `/dle-cache-info` | View vault cache status and storage info |

### New Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `probability` | number | Chance of triggering when matched (0.0-1.0, null = always) |
| `era` | string | Contextual gating -- entry only injects when the active era matches |
| `location` | string | Contextual gating -- entry only injects when the active location matches |
| `scene_type` | string | Contextual gating -- entry only injects when the active scene type matches |
| `character_present` | string[] | Contextual gating -- entry only injects when any listed character is present |
| `[custom fields]` | any | User-defined gating fields created via rule builder |

### Settings Overhaul

- **Simplified search mode** -- One dropdown to pick your search strategy: Keyword Only, Two-Stage (keywords + AI), or AI Only.
- **Organized AI features** -- AI Notebook, Session Scribe, and Auto Lorebook grouped into one collapsible section.
- **Cleaner settings** -- Power-user options hidden behind "Show Advanced" toggles (your preferences are remembered across sessions).
- **Auto-connect** -- Extension automatically connects to Obsidian on startup when enabled.
- **Helpful tooltips** -- Every setting has a descriptive tooltip explaining what it does.

### Self-Healing Diagnostics

- `/dle-health` now runs 30+ automated checks on your vault: circular dependencies, duplicate titles, conflicting rules, orphaned links, misconfigured AI settings, budget warnings, and more.
- Runs automatically on startup -- you'll see a toast if anything needs attention (silent when clean).

### Bug Fixes

Fixed ~200 bugs across all severity levels identified through a comprehensive code audit and stabilization sprint:

- **~15 critical** -- Multi-vault data loss prevention, special character corruption in AI manifests, circuit breaker mutation races, epoch guard isolation, pre-filter cascading failures, division-by-zero errors, const redeclaration SyntaxErrors, re-export ReferenceErrors, generation lock hangs, SSRF protection gaps, pinned entry flag leaks, cache hydration bypasses, silent data loss on vault writes, budget tracking via positional slice
- **~65 high** -- AI search failures, timeout semantics, cache invalidation, fuzzy warmup off-by-one, pre-filter empty results, connection manager timeouts, priority resolution for mutual excludes, case-insensitive pin/block matching, pre-filter AI stats overcounting, cross-vault fuzzy collisions, cascade warmup bypass, lenient gating tolerance, fit timer cleanup leaks, generation lock feedback, memory doubling, cascade/recursive bypass of cooldown/warmup/probability, circuit breaker state issues, delta sync vault loss, empty key matching everything, YAML corruption, sliding window cache performance, and 40+ more
- **~70 medium** -- Multi-vault field merging, storage cleanup on vault removal, cache rebuild on chat switch, double-rebuild prevention, stuck index detection, sync polling chat-switch handling, storage error surfacing, token estimate validation, YAML unescaping order, injection mode switching, auto-suggest special characters, import keyword format handling, entry truncation accuracy, pinned entry isolation, Unicode normalization, case-sensitivity fixes, CHAT_CHANGED state resets, epoch guards, DOM lifecycle issues, and 40+ more
- **~50 low** -- Falsy-zero coalescing, recursion bounds, API signatures, click delegation, tracker key mismatches, cooldown timer freeze, tag cache invalidation, prompt injection guards, regex recompilation, dead code removal, analytics pruning, prototype pollution, filename collisions, and 30+ more

### Under the Hood

- Decomposed the codebase from one massive file (4619 lines) into 21+ focused modules for better maintainability.
- 960 passing tests.

---

## 0.14.0-ALPHA

### Session Scribe Overhaul
- **Connection Manager Support** -- Session Scribe can now use saved Connection Manager profiles or a custom proxy, independent from your main AI connection. Three modes: SillyTavern (default, uses active connection), Connection Profile, or Custom Proxy.
- **Chat Position Tracking** -- Auto-scribe now tracks actual chat position (`chat.length`) instead of an internal counter. More reliable across swipes and edge cases.
- **Prior Note Context** -- Each summary receives the previous session note as context, so the AI builds on prior summaries instead of repeating content.
- **Better Default Prompt** -- New default prompt produces richer summaries: covers events, character dynamics, revelations, and state changes in past tense with specific details.
- **Configurable Message Window** -- New "Messages to Include" setting (default: 20, range: 5-100) replaces the hardcoded 20-message limit.
- **Higher Token Limit** -- Default max response tokens increased from 512 to 1024, configurable up to 4096.

### Settings
- New "Connection" radio in Session Scribe: "SillyTavern" (default), "Connection Profile", or "Custom Proxy"
- New "Connection Profile" dropdown for Scribe (independent from AI Search profile)
- New "Proxy URL", "Model Override", "Max Response Tokens", "Timeout" fields for Scribe
- New "Messages to Include" field (replaces hardcoded 20-message context window)
- Model/tokens/timeout fields hidden in SillyTavern mode for cleaner UI

### Internal
- Refactored `callViaProfile()` to accept optional `profileId` and `modelOverride` params (shared by AI Search and Scribe)
- New `callScribe()` routing function for connection mode dispatch
- New `populateScribeProfileDropdown()` and `updateScribeConnectionVisibility()` UI helpers
- Scribe proxy mode routes through ST's built-in CORS proxy (no custom server endpoint)
- `runScribe()` now uses `buildAiChatContext()` from `core/utils.js` for consistent message formatting
- Scribe profile dropdown auto-refreshes on Connection Manager profile events
- Bumped version to 0.14-ALPHA

## 0.13.0-ALPHA

### New Features
- **Connection Profile Support** -- AI search can now use saved SillyTavern Connection Manager profiles instead of requiring a separate proxy server. Select any saved profile from a dropdown in AI Search settings. All API providers supported by Connection Manager work (Anthropic, OpenAI, OpenRouter, etc.). Custom proxy mode preserved as a toggle for claude-code-proxy users.
- **Model Override** -- AI search model field is now an optional override. In profile mode, it defaults to the profile's model. In proxy mode, it defaults to claude-haiku-4-5.

### Settings
- New "Connection" radio: "Connection Profile" (default) or "Custom Proxy" in AI Search section.
- New "Connection Profile" dropdown to select a saved Connection Manager profile.
- "Model" field renamed to "Model Override" -- leave empty to auto-use profile/default model.

### Internal
- New import: `ConnectionManagerRequestService` from ST's `shared.js`
- New functions: `callViaProfile()`, `extractAiResponseClient()`, `getProfileModelHint()`, `populateProfileDropdown()`, `updateAiConnectionVisibility()`
- `aiSearch()` now routes through either `callViaProfile()` (profile mode) or server proxy (proxy mode)
- Profile dropdown auto-refreshes on Connection Manager profile events
- Bumped version to 0.13-ALPHA

## 0.12.0-ALPHA

### New Features
- **Active Character Boost** -- New `characterContextScan` setting. When enabled, automatically matches the active character's vault entry by name or keyword, ensuring their lore is available whenever they're in the conversation.
- **Pipeline Inspector** -- New `/dle-inspect` slash command. Shows a detailed trace of the last generation pipeline: keyword-matched entries with trigger keywords, AI-selected entries with confidence and reasons, fallback status, and pipeline mode.

### Internal
- 158 passing tests
- Bumped version to 0.12-ALPHA

## 0.11.0-ALPHA

### Refactor: Shared Core Extraction
- **Shared `core/` directory** -- Extracted ~800 lines of duplicated functions into 4 shared ES module files (`core/utils.js`, `core/matching.js`, `core/pipeline.js`, `core/sync.js`). Both DeepLore and DeepLore Enhanced now import from these shared modules instead of maintaining inline copies.
- **Shared `server/core/obsidian.js`** -- Extracted Obsidian REST API helpers (obsidianRequest, encodeVaultPath, listAllFiles) into a shared CommonJS module.
- **Parameterized functions** -- Functions that previously referenced module-level constants now accept them as arguments: `validateSettings(settings, constraints)`, `formatAndGroup(entries, settings, promptTagPrefix)`, `resolveLinks(vaultIndex)`, `takeIndexSnapshot(vaultIndex)`, `clearPrompts(extensionPrompts, promptTagPrefix, promptTag)`.
- **New `parseVaultFile()`** -- Replaces the ~80-line inline parsing loop in `buildIndex()` with a single shared function. Builds the full VaultEntry structure including seed/bootstrap/summary fields (base DeepLore ignores these).
- **Tests migrated to ESM** -- `tests.js` replaced by `tests.mjs` importing from `./core/` instead of duplicating functions. Enhanced: 158 tests, Base: 130 tests.
- **Sync tooling** -- New `sync-commit.ps1` script in parent directory validates core/ parity, runs tests in both repos, and commits+pushes with the same message.
- **No behavior changes** -- Pure refactor. All existing functionality preserved.

### Internal
- New shared files: `core/utils.js`, `core/matching.js`, `core/pipeline.js`, `core/sync.js`, `core/README.md`, `server/core/obsidian.js`
- Sync workflow documented in `core/README.md`
- 158 passing tests
- Bumped version to 0.11-ALPHA

## 0.10.0-ALPHA

### New Features
- **Cooldown Tags** -- Per-entry `cooldown: N` frontmatter field. After an entry triggers, it's skipped for the next N generations before becoming eligible again.
- **Warmup Tags** -- Per-entry `warmup: N` frontmatter field. An entry's keywords must appear N or more times in the scan text before it triggers for the first time.
- **Re-injection Cooldown** -- New global setting to skip re-injecting an entry for N generations after it was last injected. Helps save context by avoiding redundant lore repetition. Constants are exempt.
- **Entry Usage Analytics** -- Tracks how often each entry is matched and injected across generations. View with `/dle-analytics`. Shows a table sorted by injection count plus a "Never Injected" section for dead entry detection.
- **Entry Health Check** -- `/dle-health` audits all vault entries for common issues: empty keys on non-constant entries, orphaned requires/excludes references, oversized entries (>1500 tokens), duplicate keywords shared across entries, and missing AI selection summaries.

### Bug Fixes
- **Gating null guards** -- `applyGating()` now checks `entry.requires && entry.requires.length` before iterating, preventing errors on entries with undefined gating fields.

### Settings
- New "Re-injection Cooldown" setting in Matching section (0 = disabled, N = skip for N generations).

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `cooldown` | number | Generations to skip after triggering |
| `warmup` | number | Keyword occurrence count required before first trigger |

### New Slash Commands
| Command | Description |
|---------|-------------|
| `/dle-analytics` | Show entry usage analytics popup |
| `/dle-health` | Audit entries for common issues |

### Internal
- New function: `countKeywordOccurrences()`
- New globals: `cooldownTracker`, `generationCount`, `injectionHistory`
- Session state (cooldownTracker, injectionHistory, generationCount) resets on CHAT_CHANGED
- Analytics data persisted in `settings.analyticsData` via SillyTavern settings save
- 136 passing tests
- Bumped version to 0.10-ALPHA

## 0.94-ALPHA

### Manifest Format Optimization
- **Compressed manifest format** -- Manifest entries sent to Haiku now use a compact format: `EntryName (Ntok) → LinkedEntries` followed by the summary text. Removed redundant Keys, Tags, and labels. ~30% token reduction per manifest.
- **Increased default summary length** -- Default summary length increased from 400 to 600 characters, capturing more of each entry's structured meta-block data (Triggers, Related, Who Knows, etc.) that helps Haiku make better selections.
- **Updated AI system prompt** -- System prompt now describes the new manifest format, including how to interpret `→` links and `[bracketed]` metadata fields like Triggers and Related.
- **Summary length max increased** -- Settings slider now allows up to 1000 characters (was 800).
- **Summary frontmatter field** -- Entries can now include a `summary:` field in frontmatter, written specifically for AI selection. The manifest uses this instead of truncating entry content. Entries without a summary fall back to content truncation.

## 0.93-ALPHA

### Pipeline Overhaul: Two-Stage Keyword → AI Selection
- **Sequential pre-filter pipeline** -- Keywords now run first as a broad pre-filter (Stage 1), then only keyword-matched candidates are sent to Haiku for smart selection (Stage 2). Previously both ran in parallel with the full vault manifest sent to AI.
- **AI Search Mode setting** -- New radio toggle: "Two-Stage (keywords → AI)" for the pre-filter pipeline, or "AI Only (full vault)" for sending the entire manifest to Haiku directly. Replaces the old scanDepth=0 workaround.
- **Error-aware AI fallback** -- AI search now distinguishes errors from intentional empty results. On error, falls back to keyword results (two-stage) or full vault (ai-only). On intentional empty, keeps constants only.
- **{{maxEntries}} in system prompt** -- AI system prompt now includes the configured max entries limit so Haiku knows how many to select.
- **Removed merge step** -- `mergeResults()` deleted. AI output IS the final selection (plus constants). No more confidence-based priority offset merging.

### Settings
- New "AI Search Mode" radio (Two-Stage / AI Only) in AI Search section.
- Removed "AI Priority Offset" setting (no longer applicable without merge).

### Internal
- New function: `buildCandidateManifest()` -- builds manifest from filtered entries
- Deleted: `mergeResults()`, `buildManifest()`, `cachedManifest`/`cachedManifestHeader` globals
- `aiSearch()` signature changed: accepts candidate manifest/header, returns `{results, error}`
- `onGenerate()` rewritten for sequential pipeline with three modes
- Test Match and Preview AI Prompt handlers updated for new pipeline
- Bumped version to 0.93-ALPHA

## 0.9-ALPHA

### New Features
- **Conditional Gating (requires/excludes)** -- Entries can now declare dependencies on other entries. `requires: [Eris, Dark Council]` means ALL listed entries must be matched for this entry to inject. `excludes: [Draft Notes]` blocks this entry if ANY listed entry is matched. Gating resolves iteratively, so cascading dependencies work correctly.
- **Per-Entry Injection Position** -- Entries can override the global injection position via frontmatter: `position` (before/after/in_chat), `depth` (injection depth for in_chat), and `role` (system/user/assistant). Entries are grouped by their effective position and each group is injected separately. Entries without overrides use the global settings.
- **Vault Change Detection** -- When the index rebuilds, DeepLore now compares the new index against the previous one and reports what changed: new entries, removed entries, modified content, and changed keywords. Optional toast notifications summarize changes.
- **Auto-Sync Polling** -- New setting to automatically rebuild the index on a configurable interval (0-3600 seconds, 0 = disabled). Detects vault changes without manual refresh.

### Settings
- New "Sync Polling Interval" setting in Index & Debug section (seconds between auto-refresh, 0 to disable).
- New "Show Sync Toasts" toggle in Index & Debug section.
- Note added to Injection section about per-entry frontmatter overrides.

### New Frontmatter Fields
| Field | Type | Description |
|-------|------|-------------|
| `requires` | string[] | Entry titles that must all be matched for this entry to activate |
| `excludes` | string[] | Entry titles that, if any matched, block this entry |
| `position` | string | Injection position: `before`, `after`, or `in_chat` |
| `depth` | number | Injection depth (for `in_chat` position) |
| `role` | string | Message role: `system`, `user`, or `assistant` |

### Internal
- New functions: `applyGating()`, `clearDeeplorePrompts()`, `formatAndGroup()`, `takeIndexSnapshot()`, `detectChanges()`, `showChangesToast()`, `setupSyncPolling()`
- `formatWithBudget()` replaced by `formatAndGroup()` which returns grouped prompt data
- Pipeline now: clearPrompts → match → merge → gate → formatAndGroup → inject per group
- Added `extension_prompts` import for multi-key prompt management
- 20 new unit tests covering gating, grouping, and change detection
- Bumped version to 0.9-ALPHA

## 0.82-ALPHA

### Bugfix: AI-only mode actually works now
- **Fixed early return killing AI search** -- When keyword scan depth was set to 0, `onGenerate()` returned early before AI search could run. Removed the empty-scan-text guard so both pipelines always execute.
- **Fixed `slice(-0)` returning all messages** -- `buildScanText(chat, 0)` was evaluating `chat.slice(-0)` which returns the entire array in JavaScript. Added explicit `depth <= 0` guard to `buildScanText()` and `buildAiChatContext()` to properly return empty string.
- **Fixed per-entry scanDepth and recursion bypassing keywords-off** -- When global scan depth was 0, entries with their own `scanDepth` frontmatter still ran keyword matching, and recursive scanning still matched keywords against constant entry content. Restructured `matchEntries()` so the entire keyword matching block (initial scan + per-entry overrides + recursion) is skipped when `scanDepth` is 0. Only constants pass through.
- **Fixed `|| default` clobbering valid 0 values** -- The scan depth input handler used `Number(val) || 4`, which silently replaced 0 with 4 because 0 is falsy in JavaScript. Same issue fixed for injection depth and cache TTL. All three now use `isNaN()` checks instead.
- Bumped version to 0.82-ALPHA.

## 0.81-ALPHA

### AI Search Pipeline Overhaul
- **Richer manifest entries** -- Each entry now includes tags, wiki-link cross-references ("Links to:"), token cost, and longer summaries (400 chars, configurable up to 800). Gives the AI dramatically more context per entry.
- **Wiki-link relationship extraction** -- Links between entries (`[[Eris]]`, `[[Dark Council|the council]]`) are now extracted before content cleaning and resolved to confirmed entry titles. Included in the manifest as "Links to:" lines.
- **Structured AI responses** -- AI now returns confidence levels (high/medium/low) and reasons for each pick instead of a flat title list. Context Cartographer popup shows these reasons directly.
- **Confidence-based priority** -- High-confidence AI picks get no priority penalty (same as keyword matches), medium gets 1x offset, low gets 2x offset. Naturally pushes uncertain picks below certain ones.
- **Annotated chat context** -- Messages sent to the AI now include `(user)` / `(character)` role annotations to clarify who said what.
- **Improved system prompt** -- Ranked selection criteria, mentions relationships and token costs, asks for structured output with reasons.
- **Manifest header** -- AI receives entry count and budget context alongside the manifest.
- **Configurable summary length** -- New "Manifest Summary Length" setting (100-800 chars) in AI Search section.
- **Backward compatible** -- Legacy flat array responses still work. Old server responses with `titles` field handled gracefully alongside new `results` field.
- **AI-only mode** -- Keyword scan depth can now be set to 0 to disable keyword matching entirely, running only AI search (plus constants). The two scan depths are fully independent.

### Internal
- New functions: `extractWikiLinks()`, `resolveLinks()`, `buildAiChatContext()`
- VaultEntry now carries `links`, `resolvedLinks`, and `tags` fields
- Server: `extractJsonArray` replaced with `extractAiResponse` + `normalizeResults` supporting both formats
- Bumped version to 0.81-ALPHA

## 0.8-ALPHA

### New Features
- **Context Cartographer** -- Adds a book icon button to each AI message's action bar. Click it to see which vault entries were injected, why they matched, their priority, and token cost. Configurable Obsidian vault name enables clickable deep links that open entries directly in Obsidian.
- **Session Scribe** -- Automatically summarizes roleplay sessions and writes them to your Obsidian vault as timestamped markdown notes with frontmatter. Triggers after every N AI messages (configurable). Also available on demand via `/dle-scribe`, with optional focus topics.
- **`/dle-scribe` slash command** -- Write a session summary on demand. Optionally provide a focus topic, e.g. `/dle-scribe What happened with the sword?`
- **Obsidian write support** -- New server plugin route (`POST /write-note`) enables writing markdown notes back to the vault.

### Settings
- New "Obsidian Vault Name" field in Connection settings for deep links.
- New "Show Lore Sources Button" toggle in Injection settings.
- New "Session Scribe" settings section: enable toggle, auto-scribe interval, session folder, custom summary prompt.

### Internal
- Lore source data persisted in `message.extra.deeplore_sources` for per-message tracking across sessions.
- Bumped version to 0.8-ALPHA.

## 0.7-ALPHA

### Improvements
- **Accurate token counting** -- Uses SillyTavern's built-in tokenizer instead of the rough `length / 3.5` estimate. Token budgets and stats are now much more accurate. Falls back to estimation if the tokenizer is unavailable.
- **Better recursive scanning** -- Recursive matching now only scans content from newly matched entries each step, avoiding redundant work and preventing wasted cycles when entries reference each other.
- **Sentence-aware manifest truncation** -- AI search manifest summaries now cut at sentence boundaries instead of mid-word, giving the AI better context for entry selection.
- **Runtime settings validation** -- All numeric settings (including AI search settings) are clamped to valid ranges on load and save. Invalid values are corrected automatically.
- **Added package.json** -- Provides version tracking and repository metadata.
- **Added unit tests** -- Test coverage for frontmatter parsing, content cleaning, title extraction, keyword matching, sentence truncation, hash function, and settings validation. Run with `node tests.js`.

### Internal
- Bumped version to 0.7-ALPHA.

## 0.6-ALPHA

- Initial public release.
- Keyword-triggered lorebook injection from Obsidian vault.
- AI-powered semantic search via Claude Haiku.
- Recursive scanning, token budgets, configurable injection.
- Server installer scripts.
