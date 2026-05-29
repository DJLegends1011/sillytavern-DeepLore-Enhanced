# Roadmap

Possible future features for DeepLore. Nothing here is promised or on a timeline. These are ideas collected from community feedback, GitHub issues, code audits, and the developer's own plans. Some may ship soon, some may never ship, and priorities can shift.

Have a feature request? [Open a GitHub issue](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/new) with the `enhancement` label.

> [!NOTE]
> Features already shipped are documented on the [[Features]] page and in the [Changelog](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/blob/main/CHANGELOG.md).

Size estimates: **[S]** small, **[M]** medium, **[L]** large.

---

## AI and retrieval

| Feature | Size | Description |
|---------|------|-------------|
| **Hybrid Vector Pre-Filter** | L | Use ST Vector Storage embeddings for semantic retrieval alongside keyword matching. |
| **Multi-Query Decomposition** | L | Agentic retrieval: decompose chat into sub-queries by narrative element, merge results. |
| **Injection History Awareness** | S | Prepend previously-injected entries to AI search context. Deferred over re-picking bias concern; decay/freshness handles this better for now. |
| **Custom Fields in AI Manifest** | M | Send custom frontmatter field values to AI in the candidate manifest so the AI can use field metadata (era, mood, faction, etc.) as selection criteria. |
| **Stale-While-Revalidate Index** | S | Serve the stale vault index while fetching fresh data in background. |
| **DLE-Side Response Prefill** | S | Inject partial assistant content into the messages array before sending so the model picks up "continuing" instead of "starting." Breaks past refusal preambles and "Certainly, here's..." garbage without relying on platform-supplied prefill features. Tiered fallback: Anthropic native assistant prefill, then other providers' assistant-message prefill, then system prompt enforcement only. User-tunable seed string (default empty) for voice steering (`*` for action, `"` for dialogue, etc.). |
| **Librarian Tool-Call Budgets in Settings** | S | Expose `MAX_TOOL_CALLS_PER_TURN`, `MAX_VALIDATION_RETRIES`, `MAX_HISTORY_MESSAGES` as user settings. Optionally add a session-wide tool-call cap to bound abuse across many user turns. |

---

## Worldbuilding

| Feature | Size | Description |
|---------|------|-------------|
| **Continuity Watchdog** | M | AI contradiction detection: compare model responses against injected lore and flag inconsistencies. |
| **Lore Evolution via Scribe** | L | Scribe proposes vault entry updates when state-changing events happen in the story. |
| **Relationship Tracker** | M | Typed directional relationships (ally/enemy/mentor/etc.) in frontmatter, surfaced in graph and manifest. |
| **Faction Influence System** | L | Numeric influence values, inter-faction disposition maps, `/dle-factions` command. |
| **Narrative Spotlight / Scene Director** | M | Natural language spotlight conditions in frontmatter, evaluated by AI to control injection. |
| **Character Knowledge Annotations** | M | Per-character knowledge gating to prevent information leakage between characters. |
| **Procedural Lore Generation** | L | Template-based on-the-fly entry creation for uncharted territory or unexplored areas. |
| **Adaptive Injection by Pacing** | M-L | Adjust injection volume based on narrative pacing: less lore during fast action, more during exploration. |
| **Cross-Chat Continuity** | M | Import key narrative state from previous chats into new ones. |
| **Narrative Arc Templates** | L | Story arc structures with phase-dependent lore priorities (rising action gets different lore than climax). |
| **Lore Consistency Checker** | M | AI semantic contradiction detection across vault entries. |

---

## Entry matching and gating

| Feature | Size | Description |
|---------|------|-------------|
| **Inclusion Groups** | M | A `group` frontmatter field where only one entry per group injects per chat. User-creatable toggles with a panel UI to select which group member is active. |
| ~~**Outlet / outletName Support**~~ | ~~M~~ | Shipped. `outlet` frontmatter field maps entries to ST outlet names; injected via `setExtensionPrompt()` with position NONE, read via `{{outlet::key}}` macro. |
| **Fuzzy Name Matching for Commands** | S | Allow `/dle-pin`, `/dle-block`, and other entry commands to fuzzy-match titles instead of requiring exact names. |

---

## Vault and import

| Feature | Size | Description |
|---------|------|-------------|
| **Auto-Sync from ST World Info** | M | Watch a SillyTavern lorebook JSON for changes and auto-import new entries. Bridges the gap with extensions like MemoryBooks and WREC. |
| ~~**AI-Generated Summaries on Import**~~ | ~~S~~ | Shipped. `/dle-import` now offers to generate AI summaries after import, reusing the `/dle-summarize` pipeline. |
| **Update Existing Entries** | M | Dedicated function to update vault entries by modifying specific frontmatter fields while preserving the rest, rather than full file rewrites. |
| ~~**Per-Chat Vault Auto-Switching**~~ | ~~M~~ | Shipped (folder subset). Folder-based chat-specific lorebooks: `/dle-set-folder` assigns vault folders to chats, drawer gating tab shows folder chips, browse tab has folder dropdown, pipeline filters by folder prefix. Full vault auto-switching deferred. |
| **Full Bidirectional Vault Sync** | L | Full version of the lite import bridge: two-way sync between ST World Info and Obsidian vault. |
| **Wiki-Import Pipeline** | L | Crawl Fandom/MediaWiki sites, summarize pages, and create vault entries automatically. |
| **Entry Template System** | M | Type-specific templates (character, location, lore, etc.) for Auto-Suggest created entries. |
| **External Prompt Vault (Librarian-edited)** | L | Move task prompts (entry guides, house rules, scribe instructions, intro pools, validation criteria) out of JS string literals into editable markdown files under `DeepLore/Prompts/`. The Librarian popup is the primary editor: opened polymorphically against a prompt file using the same chrome it uses for lore entries (single-document, schema picked at open time, no mode toggle). Obsidian and OS file tools remain a valid file-shaped fallback. Emma's persona stays hardcoded; *only* task prompts are editable, never her voice. Phased: (1) librarian persona/guide/intros, (2) house rules + UI string injection, (3) Scribe / Auto-Suggest / AI Search prompt types in the same registry. Folder-excluded from lore index. Hardcoded fallback always preserved as a recovery floor. |
| **File-Based Version History (5-version ring)** | M | Per-file version ring stored in `DeepLore/.history/<filename>.json` (dotfolder, hidden by Obsidian's UI but visible to the REST API). Last 5 versions per edited file, ~4MB worst-case total, hard-pruned on every write. Travels with the vault, captured by git automatically when `obsidian-git` is installed, user-recoverable as plain JSON without DLE. Surfaces: History button next to Write to Vault in the Librarian popup, `/dle-history <file>` slash command, drawer Tools tab "Recently edited" list, Settings → Edit History panel, Cartographer "history available" badge on recently-edited entries. Restore loads a prior version into the editor as a draft (never overwrites directly; must go through the same Write to Vault confirm). Optional `obsidian-git` integration as a power-up: detected at startup via REST file probe, fires the plugin's "Create backup" command via the REST API commands endpoint after successful writes. Obsidian's built-in File Recovery core plugin remains the always-there third layer beneath this. |

---

## UX and visualization

| Feature | Size | Description |
|---------|------|-------------|
| **NovelAI-Style Full Context Viewer** | L | Color-coded visualization of the entire prompt showing where each piece comes from. |
| **Token Budget Visualizer** | M | Stacked bar chart of budget allocation across entry groups. |
| **Generation Timeline** | L | Recorded pipeline history in chat_metadata, persistent timeline across generations. |
| **Batch Health Fix** | L | Auto-fix buttons on health check issues instead of just reporting them. |
| ~~**Entry Clustering / Smart Grouping**~~ | ~~M~~ | Shipped in 1.0. Hierarchical pre-filter clusters by category; graph has Louvain clustering and gap analysis. |
| **Keyboard Shortcuts** | S | Ctrl+Shift+B/M/N/R for common drawer and pipeline actions. |
| **Entry Versioning / History Timeline** | M | Track changes to vault entries over time with diffs. |
| ~~**Setup Wizard AI Connection Step**~~ | ~~S~~ | Shipped in 1.0. Wizard page 5 configures the AI search connection profile. (The proxy radio is hidden as of v2.5; Connection Profiles are canonical.) |
| **`/dle-summarize` Batch UX** | M | Batch mode for generating summaries across many entries with progress tracking and abort support. |
| **`/dle-set-characters` Browse Popup** | S | Rich browse-and-select popup for the character gating command, matching the style of `/dle-set-era`. |
| **Simulation Scope Disclaimer** | S | Add a note to `/dle-simulate` output clarifying that results are approximate and may differ from real generations. |
| **`/dle-review` Chat Pollution Warning** | S | Warn users that `/dle-review` injects a system message visible to the AI, which may affect subsequent generations. |
| **`color-mix()` @supports Wrappers** | S | Wrap ~25 `color-mix()` CSS usages in `@supports` blocks for browsers that do not support it. |
| **Health Icon Colorblind Indicators** | S | Add shape-based indicators (icons, patterns) alongside color for health status, improving accessibility for colorblind users. |
| **Context Bar Hide for Non-OAI Backends** | S | Hide the context token bar in the drawer footer when using non-OpenAI backends where `CHAT_COMPLETION_PROMPT_READY` never fires. |
| ~~**Browse List Virtualization**~~ | ~~M~~ | Shipped in 1.0. Virtual scroll with 32px row height, 8-row overscan, absolute positioning. |
| **Story Timeline View** | M | Scrollable timeline of Session Scribe notes with one-click expansion to full summaries. Replaces popup-based `/dle-scribe-history` with a persistent view. |
| **Debug Mode Lite** | M | In-drawer panel showing live matching traces, pipeline decisions, and cache state, avoiding the need for browser console or `/dle-inspect`. |
| **Selectable Graph Algorithm** | M | Let users choose between different graph layout algorithms (force-directed, radial, hierarchical, etc.) for different vault structures and visualization needs. |
| **True Tool-Use Integration with Thinking Dropdown** | L | Replace the current tool-call workaround (hide intermediate messages, strip on next generation) with a proper integration where Librarian tool-use activity is presented in a collapsible thinking/reasoning dropdown on the final message, similar to how reasoning models show chain-of-thought. The dropdown would show the AI's search queries, what it found, what it flagged, and its reasoning, all in a clean UI instead of relying on ST's raw `tool_invocation` system messages. Eliminates the need to strip or hide intermediate assistant messages and system messages from tool-call rounds. |
| **Entry Studio** | M-L | In-browser entry viewer/editor with AI chat for adjusting frontmatter and content without needing Obsidian open. Preview AI-written entries before committing to vault. Conversational editing: "add era: Modern to frontmatter", "rewrite the summary". |

---

## Graph visualization (`/dle-graph`)

| Feature | Size | Description |
|---------|------|-------------|
| **Live Pipeline Trace Overlay** | M | During generation, graph nodes light up in real-time showing pipeline stages: keyword-matched = green, AI-selected = bright, budget-cut = red, gated = gray. Hover any node for full diagnosis. The missing link between `/dle-inspect` and real-time understanding. |
| **Live Generation Sync** | M | If graph popup is open during generation, animate which entries are being considered, selected, or rejected. After generation, state persists for inspection. |
| **Generation Timeline Scrubber** | L | Slider at bottom scrubs through chat history generation-by-generation. Shows which entries were active at each step. Like git blame for lore injection. |
| **Sketch & Auto-Create Mode** | L | Draw connections directly on the graph. Click empty space to create a new entry skeleton. Drag between nodes to create requires/excludes edges. Writes back to Obsidian via `writeNote()`. Turns the graph into a worldbuilding tool. |
| **Interactive HTML Export** | M | Export graph as a standalone .html file with bundled renderer, zero dependencies. Collaborators open in browser, explore vault structure without SillyTavern. |
| **AI Auto-Suggest Connections** | M | AI analyzes the manifest and suggests "these entries should be linked." One-click "Create Link" writes wikilinks to Obsidian. Surfaces hidden relationships. |
| ~~**Dead Entry Detection Cluster**~~ | ~~S~~ | Shipped in 1.0. Orphan nodes clustered in separate grid, gap analysis overlay highlights them. |
| **Budget Allocation Simulator** | M | Sidebar showing projected token cost: "If these N entries inject, tokens = X, budget remaining = Y." Drag entries into a "likely" list to plan budget before vault changes. |
| **"What If" Sandbox** | M | Toggle entries on/off and simulate what would inject. Test dependency chains before running `/dle-simulate` on a full chat. |
| **Alternative Layouts** | M | Layout dropdown: force-directed (current), family tree (character hierarchies), org chart (factions), timeline (by era field), dependency DAG (requires chains as tree). Animate transitions between layouts. |
| **Path Finding** | M | Select two nodes, highlight shortest path (BFS). Show edge types along the path. Optional: K-shortest-paths for alternatives. Answers "how does this entry unlock that entry?" |
| ~~**Neighborhood Isolation**~~ | ~~M~~ | Shipped in 1.0. Ego-centric focus mode with N-hop BFS depth, +/- controls, breadcrumb exit, camera fit. |
| **Multi-Select & Bulk Actions** | M | Shift+click to multi-select, lasso draw. Bulk pin/block, export subset, compare properties, health check selected. |
| **Node Detail Panel** | M | Click a node to open a side panel with 4 tabs: Metadata, Links (incoming/outgoing with types), Content preview, Actions (pin/block/open in Obsidian/health check). Pattern from Context Cartographer popup. |
| **Comparison / Diff Mode** | L | Side-by-side graph view after index rebuild. Nodes colored by change type: green = added, red = removed, yellow = modified. Summary: "Added: 3, Removed: 1, Modified: 5." Uses `detectChanges()` from `core/sync.js`. |
| **Per-Era Graph Views** | M | Filter graph by era (frontmatter field). Show only entries for a specific era. Cross-era edges highlighted to show historical continuity. |
| **Coverage Analysis** | M | Click an entry to show its transitive closure: which entries become reachable through cascade and require chains. Helps identify orphaned subtrees and over-connected clusters. |
| **Injection Heatmap Animation** | M | Radar sweep or pulse animation highlighting recently-injected entries. Node colors shift blue→red based on per-chat injection counts. Surfaces overused and dead entries at a glance. |
| **Graph Description Generator** | S | Generate a natural-language summary of graph structure for screen readers and documentation. "The vault contains 47 entries: 3 major hubs, 12 isolated characters, 4 dead entries..." |
| **Lens Mode** | M | Magnifying glass cursor for exploring dense regions without zooming. Circle shows zoomed detail; everything outside fades. |
| **Drag-to-Create Edges** | L | Alt+drag from node to node opens a dropdown to pick edge type (link/requires/excludes/cascade); writes to Obsidian frontmatter. Right-click edge to delete. |
| **Minimap** | S | 150x150px corner minimap showing full graph with viewport rectangle. Click to navigate. |
| **Graph popup i18n wiring** | M | The entire `/dle-graph` popup is hardcoded English — toolbar, legend, settings panel, Health panel, and the v2.5 Layout selector use zero `data-i18n` and never reference the ~150 existing `dle_graph_*` locale keys. Wire the whole popup (existing keys + new Layout/Health strings) through ST's `data-i18n` MutationObserver so all 7 locales translate it. Partial wiring (new strings only) deliberately avoided — a half-translated toolbar is worse than consistent English. Surfaced by 3-agent graph audit 2026-05-28. |

---

## Infrastructure and connectivity

| Feature | Size | Description |
|---------|------|-------------|
| **Phone/Mobile Support** | M | Use DLE when SillyTavern runs on a PC but the user accesses from a phone. Remote Obsidian support shipped; this is the remaining UX work. |
| ~~**Higher/Unlimited AI Timeout**~~ | ~~S~~ | Shipped. All timeouts raised to 999,999ms max (~16 min) to accommodate slow local LLMs and reasoning models. Defaults unchanged. Local LLM guidance in tooltips, wiki, and troubleshooting. |
| **Web Worker for Keyword Matching** | M | Offload regex matching off the main thread for vaults with 500+ entries. |
| **Pipeline Telemetry Dashboard** | M | Timing data, performance counters, and user-facing metrics for pipeline runs. |
| **Observer Unsubscribe Pattern** | M | Refactor `state.js` callback arrays to return unsubscribe functions, enabling proper cleanup if modules are ever reloaded. |
| ~~**Per-Turn Decision Record ("Verdict")**~~ | ~~M~~ | **Shipped in v2.5.** `src/verdict/verdict-store.js` is now the single source of truth for "what did DLE decide this turn" — it replaced the racing globals (`lastInjectionSources`, `lastPipelineTrace`, `previousSources`, `lastInjectionEpoch`). One authoritative per-message verdict carries `injectedSources` + full `trace` + `perEntry` + `epoch`/`msgIdx`/`chatId`. In-memory ring buffer (cap 50) spilling to per-chat IndexedDB (soft cap ~200), pruned via a sampled scan; never written to `chat_metadata`. Drawer / Cartographer / `/dle-inspect` read one consistent record; "what did DLE inject on message #47?" is now answerable across reloads and chat switches. |
| **Lens Stack Refactor** | L | Reframe the matching/gating/dedup pipeline as an ordered stack of composable "lenses." Each lens is a small pure function `(entries, context) → entries-with-verdicts` that says yes/no/boost with a reason. Pin, block, era gating, requires/excludes, cooldown, decay, dedup, AI search, fuzzy match: all become lenses with the same shape. **Why:** today's pipeline is ~10 bespoke stages, each with its own state, calling convention, and quirks; debugging "why didn't entry X show up?" requires knowing which of 10 places killed it. As a lens stack, the answer is one ordered readout. Adding a new gating rule stops requiring touching multiple files. The Injection tab and `/dle-inspect` become trivially honest; print the stack. **Catch:** real refactor, not a rename. A halfway state (some stages converted, others bespoke) is *more* complex than today, not less, so this only pays off if committed to fully. Pairs with Verdict (the verdict is what a lens stack writes). **Order of operations if pursued:** Verdict first (it is the data structure Lens writes into), then convert stages one at a time across releases, then delete the old `runPipeline` orchestrator when nothing depends on it. Likely a v0.3 or v1.0 project, not a bolt-on. Deferred from v0.2.0 coherence audit. |

---

## Integration and ecosystem

| Feature | Size | Description |
|---------|------|-------------|
| **Mirror Other Extensions** | L | Use Obsidian as unified storage for lore maintenance features from other extensions (MemoryBooks, WREC, etc.). |

---

## Project

| Item | Description |
|------|-------------|
| **Rebrand to "DeepLore"** | Drop the "Enhanced" suffix once enough features have landed. Base DeepLore is deprecated. (In progress: README, manifest, and v2 surfaces already use "DeepLore".) |

---

*Sources: Reddit ([v0.14 post](https://www.reddit.com/r/SillyTavernAI/comments/1ruxeqy/deeplore_enhanced_aipowered_lorebook_injection/), [v0.2.0 post](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/)), GitHub issues ([#3](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/3), [#5](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/5)), 5-expert code audit (2026-03-19), 8-agent comprehensive audit (2026-03-23), 5-perspective review and fixes (2026-03-23), 6-agent graph popup audit (2026-03-24).*

---

## Architectural refactor round (deferred from 2026-04-07 FATAL pass)

- **BUG-249, `ai.js` backupTimer / CMRS abort architecture.** `ConnectionManagerRequestService.sendRequest` ignores `AbortSignal`, so there is no fetch handle to cancel when the `Promise.race` timeout fires. The Phase 1 fix only stamps a `settled` flag to suppress the fake-AbortError-after-success symptom; the underlying request still runs to completion in the background. Needs an architectural pass: either route through a fetch we control, or wrap CMRS in a cancelable shim. Source: `audit/bug-hunt-2026-04-07.md#BUG-249`.

---

## WI parity gaps (from 2026-04-07 audit)

These are SillyTavern World Info features that DLE does not currently implement. They were filed as bugs in the 2026-04-07 audit but are missing features, not regressions, so they live here. Source: `audit/bug-hunt-2026-04-07.md`.

> [!NOTE]
> **v2.5 closed several of these.** The importer now reads every WI field — most land natively, the rest round-trip into the vault so nothing is silently dropped. `selectiveLogic` (all 4 modes) is now enforced natively; per-entry `caseSensitive` / `matchWholeWords` are now preserved on import (visible, not yet enforced). See [[For World Info Users]] for the full current cheat sheet. The remaining items below are genuine gaps.

| Item | Size | Source | Summary |
|------|------|--------|---------|
| **Whole-word boundary regex parity** | M | BUG-044 | DLE smart-boundary differs from ST `(?:^|\W)(...)(?:$|\W)` for `_`-prefixed keys, multi-word keys, and NFC-normalized keys. Imported WI lorebooks silently match different sets. |
| **Regex-key support** | M | BUG-045 | `/pattern/flags` keys silently treated as literal strings; WI imports lose all regex keys. |
| ~~**`selectiveLogic` modes (NOT_ALL/NOT_ANY/AND_ALL)**~~ | ~~M~~ | BUG-046 | **Shipped in v2.5.** All four modes (`and_any` / `and_all` / `not_all` / `not_any`) enforced natively by `applySelectiveLogic` on the primary keyword + recursion paths. (BM25 fuzzy still bypasses refine keys by design — see BUG-100.) |
| **Sticky timed effect** | M | BUG-047 | WI sticky (force-active for N messages after activation) not implemented. DLE drops entries after one generation regardless of sticky frontmatter. Round-trips on import, flagged `W_NOT_IMPLEMENTED`. |
| **`delay` / `delayUntilRecursion` timed effects** | M | BUG-048 | Cannot express "only on recursion >= N" or "wait until chat length >= N." Round-trips on import, flagged `W_NOT_IMPLEMENTED`. |
| **Untruncated recursion buffer** | M | BUG-049 | DLE truncates recursive scan budget to 50KB; ST never truncates. Substring may break mid-word. |
| **`preventRecursion` flag** | S | BUG-050 | No way to express "match but do not seed further recursion." Only `excludeRecursion` (skip during recursive scan) exists. Round-trips on import. |
| **Position constants ANTop/ANBottom/EMTop/EMBottom/atDepth** | M | BUG-051 | Missing position constants. `position: ANTop` etc. in vault frontmatter silently mis-injected at IN_PROMPT/IN_CHAT. (EM positions 5/6 now handled on import — see [[For World Info Users#Example Messages handling (v2.5)]].) |
| **Inclusion-group / group-scoring support** | M | BUG-052 | Common WI pattern ("pick one of N region descriptions") completely absent. Includes `useGroupScoring`, `group_weight`, `group_override`. Round-trips on import, flagged `W_NOT_IMPLEMENTED`. |
| **Subscribe to WORLDINFO_FORCE_ACTIVATE** | M | BUG-081 | Cross-extension force-injection of lore broken; "DLE replaces WI" claim leaks for any third-party extension that uses the contract. |
| **Subscribe to WORLDINFO_UPDATED** | S | BUG-082 | Hybrid vault+WI users drift silently. |
| **Persona/character/scenario/depth-prompt/creator-notes scan surfaces** | M | BUG-095 | WI books triggering off persona description / scenario silently fail. The 6 `match_*` scan-source toggles round-trip on import (preserved, not enforced). |
| **Per-entry `caseSensitive` / `matchWholeWords` enforcement** | M | BUG-096 | v2.5 preserves frontmatter `case_sensitive:` / `match_whole_words:` on import (round-trip), but matching still reads the global toggle. Per-entry enforcement is the remaining gap. |
| **Min-activations / depth-skew loop** | M | BUG-097 | Sparse-keyword vaults cannot request "advance scan depth until N activated." |
| **`@@activate` / `@@dont_activate` decorators** | S | BUG-098 | Decorator strings end up in injected content as literals. |
| **Probability validation for hand-authored entries** | S | BUG-099 | Import auto-rescales `probability: 50` → `0.50`, but hand-authored out-of-range values (`probability: 50` in YAML) still evaluate as `50 > 1.0` and always pass. Reject or rescale at load time. |
| **BM25 fuzzy results respect `refineKeys` gating** | S | BUG-100 | Fuzzy match cannot fail refine-key gating because primary+refine is not re-checked on the BM25 path (intentional today — TF-IDF is content-wide). |
