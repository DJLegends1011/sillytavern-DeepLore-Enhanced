# Changelog

All notable changes to DeepLore Enhanced are documented here. This file follows
[Keep a Changelog](https://keepachangelog.com/) conventions.

> **Older releases** (`1.0.0-beta` and all pre-1.0 `ALPHA` builds) live in
> **[CHANGELOG-archive.md](CHANGELOG-archive.md)**.

---

## [2.5.0]

> Six-locale UI, single source of truth for pipeline verdicts, Custom Proxy retirement, editable AI prompts, and a wide reliability sweep.

### Added

#### Internationalization (6 locales)

- **6 locales out of the box** — English (canonical) plus German, Spanish, French, Japanese, Simplified Chinese. UI strings (~2100 keys) and AI prompts (30 modules) both translated. Coverage: 95.8–97.3% UI per locale, 100% AI prompts. Hooks ST's built-in `addLocaleData()` + `data-i18n` MutationObserver — no custom layer.
- **AI prompt locale is a separate axis** — defaults to follow UI locale, can be pinned to English if you don't trust machine translations to preserve LLM behavior. Setting: `aiPromptLocale`.
- **Placeholder validator with unique-index semantics** — `${0}` and `${1}` indexed only; re-references like `${0} ... ${0}` count as one index so translators can match grammatical agreement (ES adjective/noun, etc.) without tripping validation.

#### Editable AI prompts

- **Prompts tab** — a new top-level settings tab (between Features and System) for viewing and overriding DLE's built-in AI prompts. Per-row revert / export / update, a status grid, plus tab-wide Export, Reload, and Reset-All actions. Prompt overrides live in your Obsidian vault under `promptsFolderPath`, resolved through a vault override layer with a multi-layer delete safety cage. Confirmation prompts guard export and language-change operations before clobbering existing vault overrides.

#### World Info import — full ST field parity

- **WI import: full ST World Info field parity** — every WI field now has a documented home (see `docs/gotchas.md` #69 for the contract). Companion-extension API additions: `convertWiEntry` return now carries `title` + `_emPosition`; `upsertConvertedEntry` returns a new `report` object + can return `action: 'em-skipped'` for Example Messages entries when `wiImportEmHandling === 'skip'`. Existing destructuring patterns (`{filename, content}` etc.) keep working — additive only.
  - **Native (DLE acts on):** `disable` → `enabled: false` (pre-fix disabled WI entries silently imported as active — the most damaging silent downgrade in the importer), `excludeRecursion`, `role` (Wave 1), plus `selective_logic` with all 4 modes enforced by new `applySelectiveLogic` gate (`and_any`, `and_all`, `not_all`, `not_any` — Wave 3), plus Example Messages positions 5/6 with `## Example Dialogue` subheader handling and configurable skip-on-import (Wave 4).
  - **Round-trip preserved** (snake_case frontmatter, surfaced by `/dle-lint` as new `W_WI_ROUND_TRIP` code): `vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, plus 6 `match_*` scan-source toggles (Wave 2).
  - **Structured import report popup** replaces the old success/warning toast — shows per-field counts, EM handling breakdown, friendly EM explainer with one-click "Skip on future imports" button that flips the `wiImportEmHandling` setting (Wave 5).

#### Other new features

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

### Removed

- **Custom Proxy AI connection mode** — dead-headed. Connection Profile supersedes. Existing users migrated automatically with a one-shot notice popup. Code preserved for rollback (`src/ai/proxy-api.js` still present, marked `@deprecated v2.5`). `enableCorsProxy: true` is no longer required for DLE AI features. See `docs/gotchas.md` #68.

### Fixed

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
- **Audit batch** (onboarding, persistence, breaker, security, perf, correctness) — first-run wizard now imports using the live tested connection and re-verifies on Finish; empty-title entries skipped at parse; notepad + injection-log persist immediately so a fast chat switch can't drop them; verdict IDB reads scoped to the chat; circuit breaker releases the half-open probe on excluded errors; network debug buffer scrubbed on read with JWT/short-token patterns; pseudonymization replaces longest names first; embedded URL secrets stripped from connection references; lazy titleMap + requires/excludes early-out perf.

### Tests

- **Queue-based async runner** for the integration suite — no more flaky ordering on slow CI.
- **VRD-1..VRD-12 regression guards** for the Verdict refactor, including Wave C P1 prune sampling and bounded-cursor invariants.
- **PERF-P2-1..PERF-P2-5** for the exemption-policy cache.
- **i18n parity tests** across all 5 translations: key-count match, key-set match, placeholder preservation, AI prompt-module export contract.
- **WI-import parity** — full-parity fixture + 84 `wi-import.test.mjs` assertions + 6 `WI-PARITY` regression guards (Tier A native, Tier C round-trip, EM subheader, no-silent-drop contract).
- **Coverage backfill** for `cmrsResultToText` edges, `comparePriority` ([#16](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/16)), `resetAiCircuitBreaker` (PR [#28.1](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)), `summarize`, caveman extras, BUG-043 round-trip, pin invariants.

---

## [2.0.2] - 2026-04-27

> Hotfix for AI search regression on non-Claude models.

### Fixed

- **AI search no longer throws `slice is not a function` on non-Claude models** ([#24](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/24)) — ST's `custom-request.js` replaces `result.content` with a parsed object when `data.json_schema` is set on the chat-completions route. `callViaProfile` was assigning that object straight to `text`, breaking `extractAiResponseClient` and the debug-preview `.slice` for every non-Claude provider. Fix re-stringifies through a new `cmrsResultToText` helper so the string contract holds across all callers. Claude path was already skipping `json_schema` (forced tool_choice + extended thinking conflict) and is unaffected. Regression test added.

---

## [2.0.1] - 2026-04-26

> First post-release patch from open-issue triage on v2.0-beta.

### Fixed

- **Vault entry content no longer XML-escaped on injection** ([#16](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/16)) — vault content was passing through `escapeXml` in `formatAndGroup`, so any `<tag>`, `&`, or `"` reached the LLM as `&lt;tag&gt;` etc. Title escape stays (load-bearing for the `<{{title}}>` wrapper tag name). Content now passes through raw — vault authors intentionally embed XML, markdown, code samples, and ampersands. Reverts the content-side half of BUG-090. Adds gotcha #45 documenting title-only escape policy.

### Changed

- **Timeout caps raised to 999999ms (~16 min)** ([#19](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/19)) — six per-feature timeout settings (`aiSearchTimeout`, `scribeTimeout`, `autoSuggestTimeout`, `aiNotepadTimeout`, `optimizeKeysTimeout`, `librarianSessionTimeout`) had their max clamp bumped from 120000ms to 999999ms. Defaults unchanged. Slow local LLMs and reasoning models on backed-up providers can now configure higher per-feature timeouts. Wiki + Roadmap updated with footgun guidance.

---

## [2.0.0-beta] - 2026-04-26

> The Librarian update. Your lorebook grows with your story — the writing AI flags what's missing, Emma helps you write it.

### Added

#### The Librarian (Emma)

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

#### Drawer Polish

- **Toolbar buttons** -- Librarian and Graph buttons added to the drawer header toolbar for quick access.
- **Footer simplification** -- The footer now shows `totalUsed / maxContext` with a tooltip breakdown, replacing the verbose multi-line display.
- **Librarian popup** -- Unified textarea replaces the old form-field layout. Chat auto-expands as you type, and tool names are shown in plain English.

#### Performance & Indexing

- **BM25 inverted index** -- Fuzzy search now uses an inverted posting list, scoring only documents that contain query terms instead of scanning the full index.
- **Multi-vault duplicate detection** -- Vaults with overlapping entries now detect duplicates via content hashing, preventing double-injection.
- **Cache fingerprinting** -- Improved cache fingerprint logic for more reliable freshness detection across vault rebuilds.
- **HTTPS support** -- Obsidian connections now support HTTPS for remote or secured setups.

#### Settings Redesign

The settings popup has been reorganized for clarity and easier navigation.

- **About tab** -- Redesigned as the landing tab with the DLE logo, master enable toggle, social links, diagnostics panel (moved from System), and a danger zone for destructive actions.
- **Reference tab** -- The slash command quick-reference grid now lives in its own tab instead of being buried in another section.
- **Grey-out audit** -- 43 disable patterns now correctly dim dependent settings when their parent feature is off. No more editing settings for features you've disabled.

#### Diagnostics

A new diagnostics subsystem for debugging issues and filing bug reports.

- **Flight recorder** -- A ring buffer captures recent extension activity (pipeline runs, tool calls, errors) for export.
- **State snapshots** -- Capture the current extension state for debugging without restarting.
- **Diagnostics panel** -- View, export, and manage diagnostic data from the About tab in settings.
- **IP masking** -- Diagnostic exports automatically mask IP addresses, preserving the first two octets for network-level debugging while protecting your identity.

#### New Slash Command

| Command | Description |
|---------|-------------|
| `/dle-librarian` | Toggle the Librarian on/off. Use `/dle-librarian audit` to trigger a comprehensive vault review. |

#### New Frontmatter Field

| Field | Type | Description |
|-------|------|-------------|
| `guide` | boolean | Via `lorebook-guide` tag -- Librarian-only writing/style guide. Never reaches the writing AI. |

### Fixed

Fixed ~350 stability and correctness bugs across comprehensive code audits. Highlights include data integrity safeguards (multi-vault safety, cache consistency, vault sync reliability), AI selection robustness (timeout handling, search fallback logic, circuit breaker fixes), UI and state reliability (chat lifecycle resets, drawer rendering, gating field persistence, swipe/regen handling), and edge case hardening (special character support, abort/stop races, multi-vault path collisions, and more).

### Under the Hood

- 960 → 1,313 passing tests.
- New `librarian/` module directory (8 focused files).

---

> **Looking for older releases?** `1.0.0-beta` and all pre-1.0 `ALPHA` builds are
> archived in **[CHANGELOG-archive.md](CHANGELOG-archive.md)**.
