# Pipeline

DeepLore's retrieval pipeline runs on every generation. It picks which vault entries get injected into the prompt, in what order, at what depth, with what role. This page covers every stage in execution order, the three pipeline modes, and the gotchas worth knowing if you're debugging a missing or unwanted injection.

> [!NOTE]
> Default mode is two-stage: keywords narrow a candidate set, then an AI ranks the candidates against compact summaries. This adds roughly one extra provider call per turn. Switch to keywords-only if you want zero AI cost; switch to AI-only if you want the AI to see the whole vault.

## Pipeline flow

```
init()
  └─ hydrateFromCache()               First load: hydrate from IndexedDB

onGenerate(chat)
  │
  ├─ Acquire generation lock           One pipeline at a time (30s stale timeout)
  ├─ Capture epoch guards              chatEpoch + generationLockEpoch for race detection
  │
  ├─ ensureIndexFresh()               Refresh from Obsidian if cache expired
  │    └─ buildIndexWithReuse()          Fetch all, skip re-parse of unchanged, fall back to full
  │
  ├─ runPipeline(chat)                Core matching pipeline
  │    ├─ matchEntries(chat)            Keyword scan (broad pre-filter)
  │    │    ├─ buildScanText(chat)        Concatenate recent messages
  │    │    ├─ keyword matching           Check each entry's keys against scan text
  │    │    ├─ BM25 fuzzy search          Supplement with TF-IDF scored matches (if enabled)
  │    │    ├─ per-entry scanDepth        Override scan depth for specific entries
  │    │    ├─ warmup/probability/        Per-entry behavior checks
  │    │    │  cooldown checks
  │    │    ├─ cascade links              Pull in linked entries (respects cooldown + probability, not warmup)
  │    │    ├─ recursive scanning         Scan matched entry content for more triggers
  │    │    ├─ Active Character Boost     Auto-match active character's entry
  │    │    └─ keyword occurrence          Re-sort within priority group by hit count (if enabled)
  │    │       weighting
  │    │
  │    ├─ wikilink expansion            Add resolved-link targets as AI candidates
  │    ├─ contextual pre-gating         Gate entries before AI to avoid wasting selections
  │    ├─ folder pre-filter             Drop entries outside the active folder filter
  │    ├─ hierarchicalPreFilter()      For 40+ entries with 4+ categories: cluster, AI picks categories (opt-in)
  │    ├─ buildCandidateManifest()     Build compact manifest from candidates
  │    │
  │    └─ aiSearch(chat, manifest)     AI selects best from candidates
  │         ├─ throttle check            500ms minimum between API calls
  │         ├─ circuit breaker check     Skip if AI circuit is open (2 failures, 30s cooldown)
  │         ├─ sliding window cache      Reuse if manifest unchanged + no new entity mentions
  │         ├─ build AI context          Recent chat + manifest + header (+ scribe summary)
  │         ├─ call AI (Connection Profile) Send via the configured Connection Profile
  │         ├─ parse response            Extract JSON array of selections
  │         └─ confidence-gated budget   Over-request 2x, sort by confidence tier
  │
  ├─ [epoch check]                     Bail if chat changed or pipeline superseded
  │
  ├─ Apply pin/block overrides        Per-chat pins force-inject, blocks remove
  ├─ Folder filtering                 Filter by per-chat folder filter (if active)
  ├─ Contextual gating                Filter by era/location/scene/character + custom fields
  ├─ Re-injection cooldown            Skip entries injected within N generations
  ├─ applyRequiresExcludesGating()    Apply requires/excludes rules (iterative cascade)
  ├─ Strip duplicate injections       Skip entries injected in recent generations
  │
  ├─ formatAndGroup(entries)          Budget limits + injection grouping
  │    ├─ sort by priority              Lower number = higher priority
  │    ├─ apply entry limit             Max entries cap (if not unlimited)
  │    ├─ apply token budget            Max tokens cap (if not unlimited)
  │    ├─ apply injection template      Format with {{title}} and {{content}}
  │    └─ group by injection position   Separate groups for before/after/in_chat
  │
  ├─ setExtensionPrompt()            Inject each group into SillyTavern context
  ├─ Author's Notebook injection       Inject per-chat notebook (if enabled)
  ├─ AI Notepad injection              Inject AI-written session notes (if enabled)
  │
  └─ Post-processing
       ├─ trackGeneration()             Update cooldowns, warmup, decay trackers
       ├─ Record injection dedup log    Track what was injected for strip-dedup
       ├─ Per-chat injection counts     Increment per-entry counts (swipe-aware undo)
       ├─ recordAnalytics()             Persist match/injection stats (batched every 5 gens)
       └─ Context usage warning         Warn if lore exceeds 20% of context window
```

## Three pipeline modes

### Two-stage (keywords then AI)

The default. Keywords narrow the field; the AI picks the best from what survives.

```
Keywords match 20 entries  →  AI selects 8 most relevant  →  Inject 8 + constants
```

**Error fallback:** configurable via the AI Error Fallback setting (default: fall back to keyword results). Options: keyword results, constants only, constants + bootstrap, or nothing.

**Empty fallback:** configurable via the AI Empty Result Fallback setting (default: constants only). Options: constants, constants + bootstrap, keyword results, or nothing.

### AI-only (full vault)

Skips keyword matching. The entire vault manifest is sent to the AI.

```
Full vault (100 entries)  →  AI selects 10 most relevant  →  Inject 10 + constants
```

More thorough, more tokens per call. Best for vaults where keywords are sparse or unreliable.

**Error and empty fallback:** same options as two-stage mode.

### Keywords-only (AI disabled)

Pure keyword matching. No AI search.

```
Keywords match 12 entries  →  Inject 12 + constants
```

Zero API calls, zero added latency. Good for simple setups or when you want full control via keywords.

## Stage details

### Generation lock

The pipeline acquires an exclusive lock before starting. One pipeline at a time. The lock has a 30-second stale timeout: if a previous pipeline crashed or hung, the lock auto-releases so the next generation isn't blocked forever. The lock is epoch-tagged: if a new generation force-acquires a stale lock, the old pipeline detects the epoch mismatch and bails at every commit point.

### Epoch guards

Two epoch counters prevent race conditions:

- **chatEpoch**: increments on chat switch. Pipeline results from the prior chat are discarded.
- **generationLockEpoch**: increments when the lock is acquired (including force-releases). A stale pipeline that wakes up after a force-release sees the mismatch and stops.

Every `await` in the pipeline is followed by an epoch re-check.

### IndexedDB hydration

On first page load, the extension loads the vault index from IndexedDB (browser-side persistent cache). If found, the index is available immediately, no Obsidian call needed. A background validation against Obsidian runs to confirm the cache is still fresh.

### Index refresh

Before matching, the pipeline checks if the cached vault index is stale (based on Cache TTL or generation count if generation-based rebuild is configured). If expired, it tries **reuse sync** first: fetch all files, skip re-parsing entries whose content hash is unchanged. If reuse sync fails, it falls back to a full rebuild of all `#lorebook` entries from Obsidian's Local REST API.

The Obsidian connection uses a **per-vault circuit breaker**, keyed by `host:port`, with closed/open/half-open states and 2s-15s exponential backoff. After a successful build, the index is saved to IndexedDB.

### Keyword matching

1. **Build scan text:** concatenate the last N messages (Scan Depth setting, default 4).
2. **Check each entry's keys:** for every entry with `keys`, test if any keyword appears in the scan text.
   - Respects Case Sensitive and Match Whole Words settings.
   - Entries with per-entry `scanDepth` use their own message window.
   - If `refine_keys` is set, they must also satisfy the entry's `selective_logic` mode (default `and_any`: at least one refine key matches). See [[Entry Matching and Behavior#Selective logic modes]].
3. **Warmup check:** if entry has `warmup: N`, count keyword occurrences; skip if below threshold.
4. **Probability check:** if entry has `probability: N` (0.0-1.0), roll a random number; skip if roll exceeds probability. `probability: 0` never fires; no field (or `null`) always fires.
5. **Cooldown check:** if entry has per-entry `cooldown` and is currently in cooldown, skip it.
6. **Cascade links:** if matched entries have `cascade_links`, the listed entries are pulled in without keyword matching. Cascade-linked entries still respect cooldown and probability gates, but not warmup.
7. **Recursive scanning:** if enabled, scan matched entry content for keywords that trigger more entries. Repeats up to Max Recursion Steps (default 3). Newly recursed entries still pass the cooldown, probability, and warmup gates. Entries with `excludeRecursion: true` don't contribute their content to the recursion scan text.
8. **BM25 fuzzy search:** if Fuzzy Search is enabled, supplement keyword matches with BM25/TF-IDF scored results. Entries scoring above the Fuzzy Min Score threshold (default 0.5) are added to the match set, top 20 per generation. Respects the same warmup, cooldown, and probability gates as exact matches.
9. **Active Character Boost:** if enabled, auto-match the active character's entry by name or keyword even if not mentioned in chat.
10. **Constants:** entries tagged `#lorebook-always` or with `constant: true` are always included regardless of keywords.
11. **Bootstrap:** if chat length is below New Chat Threshold (default 3 messages), `#lorebook-bootstrap` entries are force-included.

### Hierarchical pre-filter

Off by default. Enable via the Hierarchical Manifest Clustering setting. When on, large candidate sets get pre-filtered by category before main AI search:

1. Group candidate entries by category (first non-infrastructure tag).
2. A lightweight AI call selects relevant categories.
3. Only entries in selected categories proceed to the main AI search.

Activates only when there are at least 40 selectable candidates and at least 4 distinct categories. After category filtering, entries whose primary keywords are explicitly mentioned in the chat are re-added (BUG-396 rescue), so high-relevance entries can't be silently dropped. If the pre-filter would remove more than 80% of candidates, it bails and uses the full manifest. The 80% threshold is tunable via the Hierarchical Aggressiveness setting.

The pre-filter has its own circuit-breaker probe slot, independent of the main AI search probe.

### AI search

See [[AI Search]] for the full mechanism. In brief:

1. Build a compact manifest from keyword-matched candidates (or full vault in AI-only mode).
2. Check the **sliding window cache:** reuse results if the manifest is unchanged and new chat messages don't mention any vault entities.
3. Send manifest plus recent chat to the AI (with Scribe summary if scribe-informed retrieval is enabled).
4. AI returns a JSON array of selected entries with confidence and reasons.
5. **Confidence-gated budget:** AI is asked for 2x your max entries. Results are sorted by confidence tier (high then medium then low) before the budget cap is applied.
6. Selections replace keyword results (not merged).

### Pin/block overrides

After the main pipeline, per-chat pins and blocks are applied:

- **Pinned entries** are force-injected like constants (sourced from `chat_metadata.deeplore_pins`). Pinned entries get `priority=10` to give them the best shot at surviving budget truncation.
- **Blocked entries** are removed regardless of matches (sourced from `chat_metadata.deeplore_blocks`). Blocks override constants: a blocked constant is removed.

### Folder filtering

If a per-chat folder filter is active (set via `/dle-set-folder`), entries whose vault folder path falls outside the filter are removed. Folder filtering runs twice: as a pre-filter inside `runPipeline` (so AI search doesn't waste selections on filtered entries), and again post-pipeline as the authoritative gate. Constants, seeds, bootstrap entries, and pinned entries are exempt.

### Contextual gating

Entries with gating frontmatter fields (`era`, `location`, `scene_type`, `character_present`, or any user-defined custom field) are filtered against the active context state stored in `chat_metadata.deeplore_context`. Custom gating fields are defined in `DeepLore/field-definitions.yaml` and support configurable types and operators. Entries without contextual fields pass through unaffected.

### Re-injection cooldown

If the global Re-injection Cooldown setting is non-zero, entries injected within the last N generations are skipped. This is distinct from per-entry `cooldown` (which is checked during keyword matching). Re-injection cooldown is a global post-selection filter. Constants and other force-injected entries are exempt.

### Requires/excludes gating

After selection, entries with `requires` and `excludes` fields are evaluated:

- **requires:** every listed entry title must be in the matched set, or this entry is removed.
- **excludes:** if any listed entry title is in the matched set, this entry is removed.
- Resolution is **iterative** (max 10 passes). Removing one entry can cascade to remove others that require it.
- **Force-injected entries** (constants, seeds, bootstraps, pins) are exempt from requires/excludes. They are never removed by these rules. They do remain in the active set, so other entries' `excludes` rules still see them.

### Strip duplicate injections

If "Strip Duplicate Injections" is enabled, entries injected in recent generations (within the lookback depth) are stripped before formatting. The dedup key is `title|position|depth|role|contentHash` so the same entry at a different depth is not considered a duplicate. Constants and other force-injected entries are exempt. Injection history is tracked per-chat in `chat_metadata.deeplore_injection_log`.

### Budget and formatting

1. Sort remaining entries by priority (lower number first).
2. Apply Max Entries cap (if Unlimited Entries is off).
3. Apply Token Budget cap (if Unlimited Token Budget is off). Entries are added in priority order until the budget is reached. The last entry to enter is truncated to the nearest sentence boundary if it doesn't fit whole. If the highest-priority entry exceeds the entire budget and cannot be meaningfully truncated, it is skipped with a debug warning.
4. Format each entry using the Injection Template (`{{title}}` and `{{content}}` macros).
5. Group entries by their effective injection position (global default or per-entry override).

### Injection

Each group is injected separately into SillyTavern via `setExtensionPrompt()`:

- **Before Main Prompt:** injected before the system prompt / story string.
- **After Main Prompt:** injected after the system prompt / story string.
- **In-chat:** injected as a message at the specified depth and role.

If **Allow World Info Scan** is enabled, ST's built-in World Info system can scan the injected lore for additional WI keyword matches.

### Author's Notebook

After lorebook entries are injected, the Author's Notebook is injected separately (if enabled). The notebook has its own injection position, depth, and role settings. It is independent of the lorebook pipeline: it always injects when enabled, regardless of entry matching.

### AI Notepad

After the Author's Notebook, the AI Notepad is injected (if enabled). This contains AI-written session notes accumulated across the chat. It has its own injection position, depth, and role settings. See [[AI Notepad]] for tag mode vs extract mode.

### Post-processing

After injection, the pipeline updates internal state:

- **Track generation:** updates per-entry cooldown timers, warmup counters, and decay trackers (staleness and frequency).
- **Injection dedup log:** records which entries were injected for the Strip Duplicate Injections feature.
- **Per-chat injection counts:** increments each injected entry's per-chat count. If a **swipe** is detected (chat length unchanged from last generation), the previous round's counts are undone first. Only the final accepted response's injections count.
- **Analytics:** persists match and injection statistics to settings. Writes are batched every 5 generations to reduce disk I/O. Stale analytics entries (older than 30 days) are pruned automatically.
- **Context usage warning:** if injected lore exceeds 20% of the context window, a warning toast appears. Throttled to avoid spam: it only re-fires when the ratio increases by more than 5%.

## Inspecting the pipeline

Use the `/dle-inspect` slash command to see a detailed trace of the last generation:

- Which entries matched by keywords (and which keywords triggered them)
- Which entries were selected by AI (with confidence and reasons)
- Which entries were injected (with token counts and truncation markers)
- Which entries were gated out by requires/excludes rules (with reasons)
- Which entries were removed by contextual gating, cooldown, strip-dedup, probability, or warmup
- Which entries were cut by budget or max-entries limits
- Whether AI fallback was used, and the pipeline mode that was active

The trace is also available as a copyable plain-text block. See [[Slash Commands]] for more details.
