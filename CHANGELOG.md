# Changelog

All notable changes to DeepLore are documented here. This file follows
[Keep a Changelog](https://keepachangelog.com/) conventions.

> **Older releases** (`1.0.0-beta` and all pre-1.0 `ALPHA` builds) live in
> **[CHANGELOG-archive.md](CHANGELOG-archive.md)**.

---

## [2.6.0] - Unreleased

> A focused interface release: a deep UI/UX polish pass on every surface, a round of bug-fixes for the regressions that polish introduced, and a structural rework of the graph legend, setup wizard, Librarian Flags list, Browse rows, import recovery, and the pipeline toast. No pipeline-behavior changes — this is about making what DLE already does legible, accessible, and calm. The broader settings-popup redesign (information architecture, Reference tab, design-system) was intentionally held back for a dedicated settings overhaul.

### Added

#### Graph view

- **Single docked legend panel** — the two former graph legends (edge-type toggles and the node color key) are merged into ONE panel anchored top-left over the canvas. The color key used to live in the bottom node-info bar and got overwritten the moment you hovered a node; it now stays put while you explore, refreshing only when you change color mode. The whole graph view is localized across all 7 locales (the ST-free pure render/analysis/dag/health modules localize through runtime helper functions injected by `graph.js` rather than importing the i18n layer, so the Node test suites still run).

#### Setup Wizard

- **Welcome is now a decision-fork** — instead of a wall of prose, the first page offers three choice cards for the three lowest-friction first paths: load the demo vault, connect Obsidian, or import a lorebook. Picking one routes you straight to the relevant step.
- **Vault scanner wired in and localized** — the connection-scan helper is now reachable from the wizard and fully translated.
- **Skip / resume** — closing the wizard before finishing now persists a skip sentinel and stops it auto-relaunching every load; an explicit "Finish later" affordance pauses it on purpose, and a manual relaunch resumes on the step you left. Completing it clears the sentinel so a future re-run starts clean.
- **Accessibility** — advancing a step moves keyboard focus to the now-active step and announces "Step N of M: <title>" through a polite live region for screen-reader users.

#### Librarian (drawer)

- **Contextual bulk-action bar** — the Flags list's selection controls (the bare ×/Invert buttons plus the separate, usually-disabled action row) collapse into one bar that reveals Open / Done / Remove alongside Invert / Clear only when something is selected. The legacy action row is retired (force-hidden) but kept in the DOM for back-compat, and the `d` / `Delete` keyboard shortcuts are now scoped to the visible bar so they can't double-fire against the hidden buttons.
- **Gap rows gain an expand chevron and a one-line "Reason" teaser** — a preview of why the gap was flagged shows collapsed; the full reason and meta still render on expand.

#### Import

- **Recovery table for failed/skipped entries** — the flat error list after a World-Info import is replaced by a per-entry reconciliation table that classifies each failure (transient / capacity / convert / vault / unknown), shows whether a retry is worth attempting, and offers per-entry Retry plus Retry-all.

#### Vault cache (Issue #39)

- **`/dle-clear` and a Clear Cache button that actually clears** — clearing the vault cache is now wipe-and-stop: it empties the IndexedDB cache AND the live in-memory index (Browse visibly empties, derived search/graph state resets) without re-fetching, so an intentionally emptied Obsidian vault finally stays empty. The old button only cleared IndexedDB — the live index survived and the next rebuild quietly resurrected and re-cached every entry. The transient-blip safety net (a vault that momentarily returns 0 files still keeps its prior entries) is unchanged; clearing is the deliberate override for it. Run `/dle-refresh` afterwards to re-index. While an index build is running the clear refuses with a "wait for it to finish" toast. If the browser blocks the database wipe, the clear reports it honestly — error toast with retry guidance, the live index stays cleared — instead of toasting success; and a clear can no longer be silently undone by an in-flight cache save or boot hydration racing it. Also scrubbed the phantom `/dle-force-refresh` and `/dle-rebuild` commands from error toasts and settings copy — only `/dle-refresh` was ever registered.

#### Pipeline status

- **Elapsed-time heartbeat and Cancel on the "Consulting vault…" toast** — during the indeterminate AI phases (selection, Librarian search/flag) the toast now ticks a `(Ns)` elapsed counter and shows a Cancel button that aborts the in-flight generation through the canonical Stop path (`GENERATION_STOPPED`), so a slow model run never feels stuck. Determinate fast runs stay uncluttered.

#### Toasts

- **Unified `notify` toast facade** — `src/toast-dedup.js` now exports `notify` (with `notify.info/success/warning/error` helpers) that standardizes severity routing, shares the legacy 10s dedup window, and supports click-to-copy error bodies and action buttons. Adoption is partial by design: the first tranche routed the high-value `classifyError` and vault/import/AI failure sites through it; transient info/success toasts stay raw. See `docs/gotchas.md` #92.

#### Onboarding & empty states

- **Decision-aware Browse / Injection empty states** — pre-setup empty states show a full connect/keyword/setup guide with "Open Setup Wizard" and "Import from World Info" buttons (the slash command is demoted to a hint); a vault that's connected-but-idle gets a calm one-liner with a jump-to-Browse link instead of being told to "connect a vault."
- **Expand-all / collapse-all toggle** for Browse folder grouping, and unit-aware folder count chips ("N entries" / "X / Y selected") that echo the tri-state checkbox.

### Changed

- **Footer health icons reframed as a clickable "diagnostics dock"** — the five icons (vault / connection / pipeline / cache / AI) are now a labeled dock; framing only, the click handlers are unchanged.
- **Browse per-row actions fold into a hover-reveal kebab** — pin / block / copy now live behind a `⋮` menu so rows read calm by default; status readouts stay visible and pin/block-active rows force the cluster open. The kebab toggles a class on the live DOM node only and never mutates the render-derived row model (gotcha #13).
- **Drawer overlay/full-width mode is now a dual trigger** — it engages on a genuinely narrow viewport (`window.innerWidth`) in addition to the existing wide-chat-width trigger, so phones finally get the overlay drawer. This is the drawer-overlay half of Issue #39; the settings-popup mobile-scroll half is deferred. See `docs/gotchas.md` #93.
- **Cartographer "Why?" (injected-sources) modal fully localized** — strings, rejection-group labels, and the AI-notes section now translate; remaining inline styles moved to theme tokens.
- **Reference tab and `/dle` command palette localized** — every command description and section header now carries a translatable key (with the English text as the byte-identical fallback), and the stale static Reference grid was deleted in favor of the single `DLE_COMMANDS` render path.
- **`/dle-lint` popup, index-build warning toast, and lint fix-it hints localized and styled** — lint codes route through their locale keys, the build-summary toast surfaces skipped/warning counts with a click-through to `/dle-lint`, and fix-it hints render real inline-code instead of literal backticks.

#### Interface, motion & accessibility

- **The whole interface moved onto DLE's motion + type tokens** — ~55 transitions migrated from raw durations to the fast/base/slow duration tokens with the signature easing curves (previously defined but unused), half-finished hover transitions (color snapping while opacity glided) completed, and the chat-injected Librarian widget's parallel `mainFontSize` type scale folded into the shared em scale. A deliberate monospace contract (`--dle-font-mono`) now governs every code/command/token surface.
- **Reduced-motion is now honored properly, not faked** — empty states animate in and out via `@starting-style` instead of snapping; infinite "attention" animations are fully DISABLED under `prefers-reduced-motion` (they were previously clamped to near-zero, which flashed); and where an element genuinely needs to signal "still working," a consistent slow stepped opacity pulse stands in for the motion that can't run. The goo-spinner itself stops its physics loop and freezes to a settled gel under reduced motion, and live-updates when you toggle the OS preference.
- **Touch and pointer hardening** — `(pointer: coarse)` lifts tap targets to the 44px minimum, modal min-heights clamp to the viewport so footers stay reachable on short/landscape phones, the drawer contains over-scroll instead of chaining into the chat behind it, and the tab bar becomes a single-row horizontal scroller on narrow widths.
- **Theming and contrast** — a unified high-contrast `--dle-focus` ring token, contrast-safe `-fg` foreground variants split from fill colors, a shared `--dle-cat-*` category palette so graph tooltip badges stay distinct, theme-relative temperature (COLD/HOT) tints that adapt to light themes, accent-themed range sliders and checkboxes, and an end to double-dimmed muted text.
- **Number inputs clamp to their min/max on commit** — typed out-of-range values are corrected on blur (with a brief flash) instead of persisting silently; bounded numeric fields no longer stretch full-width, and gated controls dim their whole row, not just the box.
- **Iconography unified** — one canonical refresh glyph (`fa-arrows-rotate`, `fa-sync` retired), `fa-diagram-project` reserved for Graph only, every decorative icon hidden from screen readers, and the three retired Wave-I mascot SVGs moved out of the shipped `assets/`.
- **Pipeline status toast rebalanced** — trimmed back from its oversized Wave-I styling, separated from the chat background in light themes (was always lightening), given a branded accent bar, and the health badges promoted from tiny corner glyphs to legible status chips.
- **Drawer status row decoupled** — long localized phase strings now ellipsize instead of shoving the stats around mid-generation; idle vs. active reads from a stopped/desaturated dot and muted label rather than a barely-perceptible spinner-speed difference; and cold-start stats show content-shaped skeletons instead of a dim "…".

### Fixed

This release's polish pass introduced a handful of regressions, all caught by a follow-up adversarial bug-hunt (25 confirmed findings, 3 refuted) and fixed before merge:

- **Pipeline toast could be yanked away mid-generation** (TOAST-1, high) — the immediate-removal path armed an unconditional 500ms fallback `remove()` with no stored handle; if a new generation resurrected the same toast node inside that window, the stale timer removed the now-live toast. The fallback timer is now stored and cleared on resurrection (and a leaked `animationend` listener on the same path was closed).
- **Circuit-breaker "back online" toast lost on 6 of 7 recovery paths** (STATE-R1-01 / SYNC-AI-1) — only the AI-search site announced recovery, but any background feature (scribe, summarize, auto-suggest, Librarian, commands) could win the half-open probe and silently consume the surfaced flag. Recovery now announces from a caller-agnostic circuit-state observer, so it fires once per degrade→recover cycle regardless of which feature recovered.
- **Graph gravity setting silently corrupted on edit** (SUI-1) — the new number-clamp snapped typed values to a `min`-based step grid, rewriting the documented default `11.0` to `11.1` on blur. Step-snapping was removed from the clamp entirely; it now only clamps to min/max (the browser spinner already honors `step`).
- **Rule Builder clobbered a divergent context key on the first name keystroke** (RB-MANUAL-DESYNC-1) — a custom field whose context key was deliberately unlinked from its name re-opened looking linked, so editing the name overwrote the saved gating key. The link state is now computed from `contextKey === name` on load and the "manual" flag is initialized for divergent rows.
- **Two CSS regressions on real themes** — the Browse "cold" temperature tint scaled backwards (coldest entries got the faintest cue; now scaled by coldness with a visible floor), and the Librarian count badge forced white text on a raw theme-color fill that could be unreadable on light themes.
- **goo-spinner stopped responding to live OS reduced-motion toggles after re-parenting** (GOO-1) — `disconnectedCallback` removed the `matchMedia` listener but left the handler reference truthy, so the reconnect guard never re-registered against the fresh media-query object. The handler reference is now nulled on disconnect.
- **Capture-phase graph Escape handler swallowed context-menu Escape in focus mode** (graph-esc-1) — pressing Esc to dismiss an open node context menu also destroyed the entire focus tree; the handler now bails when the menu is open.
- **Smaller R1-introduced fixes** — first pipeline phase label flashed English under non-English locales (one-time), idle goo-spinner divided by zero on its ring rotation and kept a perpetual rAF loop running, the cold-waiting status label left a stale aria-label, `/dle-analytics` showed raw `vaultSource:title` tracker keys in the Entry column, the surfaced flag could be set when a trip toast was suppressed, and several pieces of dead code (orphan `data-stat="tokens"` write, unreachable `gap-search` activity branches, `.dle-skeleton-mode` / `--dle-temp-hue` dead CSS) were cleaned up.
- **Drawer phase progression now announced to screen readers** (html-1) — removing the nested live regions left phase changes silent; the renderer announces each phase transition through the dedicated polite live region, matching what its own comment promised.
- **Multi-vault collision in the Browse expand handler** — the click-to-expand path resolved entries by bare title, colliding across vaults; it now uses the same `trackerKey = vaultSource:title` resolver as the renderer (gotcha #50).

A release-readiness audit also fixed a batch of long-standing bugs:

- **The shareable diagnostics report no longer leaks private lore** — health-check issues (entry titles, keywords, vault names, Librarian queries), probability-skipped entries, and vault names/hosts from settings are now pseudonymized with the same `<title-N>`/`<vault-N>` aliases as the pipeline trace — and Librarian session stats are no longer over-redacted into a fabricated "0 searches, 0 flags".
- **Lore entries skipped by a probability roll during fuzzy (BM25) matching are now visible in `/dle-why`** and the Why? tab instead of vanishing silently; recursion-matched entries blocked by warmup are reported too. All four match paths now share one runtime-gate helper, so the diagnostics can't drift apart again.
- **Entries restored from a corrupted cache no longer outrank freshly parsed entries** — the cache backfill now uses the same priority default (100) as the parser.
- **A single corrupt value inside a cached entry's keys/tags/links no longer silently disables vault cache hydration for the whole vault** — bad elements are repaired or dropped during validation.
- **Drawer tabs (Why?, Browse) and the footer activity feed no longer render blank** after the drawer is torn down and re-created (e.g. extension reload).
- **The status spinner now fully stops when idle** — the outer ring kept animating invisibly in the background, wasting CPU/GPU while parked.
- **A literal `</entry>` inside an entry summary or title can no longer break out of the AI selection manifest** and inject instructions into the lore-selection prompt (applies to both the AI search manifest and the Librarian's related-entries listing).
- **Multi-vault conflict resolution (`first`/`last`/`merge`) no longer silently deletes same-titled entries that live in the *same* vault** — resolution now applies across vaults only.
- **The import recovery table no longer guesses why an entry failed** — each failed entry now carries its real failure type straight from the importer (connection, name clash, bad data, write failed) instead of keyword-matching the error text, so a network hiccup whose message happened to contain words like "attempts exceeded" can no longer show up as a "name clash" with the wrong retry advice. Retry also re-imports the original entries directly, so it works even for rows whose filenames couldn't be reconstructed.

### i18n

- **191 new UI strings** added across the polish and structural passes, and **all 7 locales brought to full key parity** (the machine-translated locales were re-synced from the canonical English; `__meta.total_keys` corrected from its stale value). Several orphan locale keys removed uniformly across all 7 files to preserve key-set parity. Final count for this release: **2,574 keys × 7 locales** (the `/dle-clear` additions included).

---

## [2.5.1] - 2026-06-27

### Fixed

- **Librarian now works through NanoGPT, AI21, Pollinations, and Moonshot.** These four chat-completion sources were wrongly listed as not supporting tool/function calling, so the Librarian was silently disabled for any connection routed through them — no matter the model, preset, or connection profile, the source gate tripped before the model check ever ran. All four are tool-capable per SillyTavern's own tool-calling source list, so the entries were stale; only `perplexity` remains gated. Reasoning-only models (deepseek-reasoner, o1, `*-r1`, etc.) are still gated separately. Surfaced by a NanoGPT user whose function calling never fired regardless of what they changed.

---

## [2.5.0] - 2026-06-20

> Six-locale UI, single source of truth for pipeline verdicts, Custom Proxy retirement, editable AI prompts, new graph layouts + vault health, and a wide reliability sweep.

### Added

#### Internationalization (7 locales)

- **7 locales out of the box** — English (canonical) plus German, Spanish, French, Japanese, Simplified Chinese, Russian. UI strings (~2306 keys) and AI prompts (30 modules) both translated. Coverage: 95.8–97.3% UI per locale, 100% AI prompts. Hooks ST's built-in `addLocaleData()` + `data-i18n` MutationObserver — no custom layer.
- **AI prompt locale is a separate axis** — defaults to follow UI locale, can be pinned to English if you don't trust machine translations to preserve LLM behavior. Setting: `aiPromptLocale`.
- **Placeholder validator with unique-index semantics** — `${0}` and `${1}` indexed only; re-references like `${0} ... ${0}` count as one index so translators can match grammatical agreement (ES adjective/noun, etc.) without tripping validation.

#### Editable AI prompts

- **Prompts tab** — a new top-level settings tab (between Features and System) for viewing and overriding DLE's built-in AI prompts. Per-row revert / export / update, a status grid, plus tab-wide Export, Reload, and Reset-All actions. Prompt overrides live in your Obsidian vault under `promptsFolderPath`, resolved through a vault override layer with a multi-layer delete safety cage. Confirmation prompts guard export and language-change operations before clobbering existing vault overrides.

#### World Info import — full ST field parity

- **WI import: full ST World Info field parity** — every WI field now has a documented home (see `docs/gotchas.md` #69 for the contract). Companion-extension API additions: `convertWiEntry` return now carries `title` + `_emPosition`; `upsertConvertedEntry` returns a new `report` object + can return `action: 'em-skipped'` for Example Messages entries when `wiImportEmHandling === 'skip'`. Existing destructuring patterns (`{filename, content}` etc.) keep working — additive only.
  - **Native (DLE acts on):** `disable` → `enabled: false` (pre-fix disabled WI entries silently imported as active — the most damaging silent downgrade in the importer), `excludeRecursion`, `role` (Wave 1), plus `selective_logic` with all 4 modes enforced by new `applySelectiveLogic` gate (`and_any`, `and_all`, `not_all`, `not_any` — Wave 3), plus Example Messages positions 5/6 with `## Example Dialogue` subheader handling and configurable skip-on-import (Wave 4).
  - **Round-trip preserved** (snake_case frontmatter, surfaced by `/dle-lint` as new `W_WI_ROUND_TRIP` code): `vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, plus 6 `match_*` scan-source toggles (Wave 2).
  - **Structured import report popup** replaces the old success/warning toast — shows per-field counts, EM handling breakdown, friendly EM explainer with one-click "Skip on future imports" button that flips the `wiImportEmHandling` setting (Wave 5).

#### Graph view modes

- **Layout selector in the graph toolbar** — a new "Layout" dropdown beside "Color:". Force-directed stays the default; positions morph (no teleport) when you switch.
- **Layered DAG view** — a directed dependency layout over `requires` + `cascade` edges: cycle-break → longest-path layering → arrowheads, so you can read what pulls in what at a glance. Double-click-to-focus is gated off in DAG; Reset always returns to Force.
- **Vault Health / World Doctor** — a structural problem report surfaced as a side panel with graph highlighting: broken references (`requires`/`excludes`/`cascade` pointing at a title no entry has), contradictory gating (an entry that both requires and excludes the same target), circular `requires` (including via cascade), and orphans. Severity-ranked (breaks-silently / won't-fire / quality).
- **Force-directed layout unchanged** — default on open, with saved-layout restore and reveal animation exactly as before; the new modes are purely additive.

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
- **Per-connection Test button** — every AI feature's connection config gets a Test button that fires a real probe and reports back with an ST-style green/red toast, so you can verify a profile before relying on it.

#### Interface, accessibility & onboarding

- **Why? tab redesign** — a verdict funnel header with a KEY › AI breadcrumb and source-vault chip, pipeline-ordered rejection groups, hover/focus-reveal Fix-It pins (pin or block an entry right where it was dropped), and a **live budget pressure meter** showing pre-truncation context pressure before anything gets cut.
- **New goo-spinner everywhere** — replaces every old spinner (status dot, toasts, empty states, refresh buttons, setup wizard), accent-colored and dark/light aware. The pipeline status toast is larger and cross-fades between phases instead of restarting its spinner each time.
- **Accessibility hardening** — high-contrast (`forced-colors`) support across tabs, radios, toggles, and browse rows; arrow-key navigation on radio groups; press feedback on every control; `prefers-reduced-motion` honored throughout, with `role=status` / `aria-live` on the pipeline toast.
- **Onboarding remediation** — connection failures over plain HTTP now open the guided checklist instead of dead-ending; a no-Connection-Profiles state explains how to create one (with a Keywords-Only escape hatch) in both the setup wizard and settings.
- **Drawer clarity pass** — calmer header bars, a footer that only turns red on real problems, canonical pipeline phase labels, and clearer mode/outcome wording.
- **Actionable AI-error toasts** — parse / shape / empty-result failures now tell you the next step, translated 1:1 across all 7 locales.
- **ST-native theming** — DLE themes entirely through ST `--SmartTheme*` / `--dle-*` tokens (via `color-mix`), tracking your ST theme in dark and light.
- **Drawer render performance** — heavy drawer tabs no longer repaint while the drawer is closed; Browse repaint is hash-guarded against redundant work.

### Changed

- **`librarianPerMessageActivity` now defaults ON** — Librarian gaps clear at generation start and persist across swipes, and per-message dropdown data is kept. Existing users who had explicitly turned it off keep their setting.

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
- **Release-day audit sweeps** — two independent passes (a verification audit of a prior sweep + a fresh full-codebase audit) fixed **87 bugs: 6 high, 31 medium, 50 low** (91 findings triaged; 5 reports verified as non-issues). Highlights: a diagnostics-privacy cluster (the shareable export no longer leaks AI prose, prompt/preset settings, sub-32-char header secrets, or `user:pass@` URL credentials); Librarian provider-routing fixes that resolve the gate, provider format, and tool-choice from the configured Librarian profile instead of ST's global connection (mixed-provider multi-turn no longer breaks); a swipe-indexing fix (injected sources attach to the right message and per-swipe injection counts stop drifting); and a `priority: 0` falsy-coalesce class fix (highest-priority entries were silently demoted to the default at every sort/write site).
- **Install path resolved at runtime** — DLE now derives its own extension folder from the module URL instead of a hardcoded name, so locale, icon, and template loading keep working regardless of what the install folder is called (and stay correct through a future repo/folder rename).

### Tests

- **Queue-based async runner** for the integration suite — no more flaky ordering on slow CI.
- **VRD-1..VRD-12 regression guards** for the Verdict refactor, including Wave C P1 prune sampling and bounded-cursor invariants.
- **PERF-P2-1..PERF-P2-5** for the exemption-policy cache.
- **i18n parity tests** across all 6 translations: key-count match, key-set match, placeholder preservation, AI prompt-module export contract.
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
