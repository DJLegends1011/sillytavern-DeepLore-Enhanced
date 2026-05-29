# Glossary

Key terms used throughout DeepLore documentation and UI.

## Core concepts

**Vault**
Your Obsidian folder of notes. DeepLore reads vault entries from here at index time. Use a dedicated lorebook vault rather than your personal Obsidian vault, since vault content is sent to your configured LLM provider during retrieval and generation.

**Vault index**
The in-memory collection of all parsed lorebook entries from your connected vaults. Rebuilt on refresh or when the cache expires. See [[Pipeline#Index Refresh]].

**Entry / vault entry**
A single Obsidian note that has been parsed into a lorebook entry. Contains frontmatter metadata (`keys`, `priority`, `summary`, etc.) and markdown content. Notes without the lorebook tag stay regular notes; only tagged notes are entries.

**Note**
Obsidian's term for any markdown file in the vault. A note becomes an entry when it carries the lorebook tag.

**Lorebook tag**
The Obsidian tag (default: `lorebook`) that marks a note for indexing. Only notes with this tag are included in the vault index. The tag name is configurable in settings.

**Constant**
An entry tagged with `lorebook-always` that is injected into every generation, regardless of keyword matches. Use sparingly; each constant consumes context budget every turn.

**Seed entry**
An entry tagged with `lorebook-seed`. Force-injected into the writing AI prompt, and prepended as story context in AI search on new chats. Helps the AI understand your world before keywords have a chance to fire.

**Bootstrap entry**
An entry tagged with `lorebook-bootstrap` that force-injects when the chat is short (below `newChatThreshold`, default 3), then becomes a regular triggered entry once the chat grows.

**Guide entry**
An entry tagged with `lorebook-guide`. A Librarian-only writing or style reference. Indexed but never reaches the writing AI through any injection path. The Librarian (Emma) fetches it via the `get_writing_guide` tool. If `lorebook-guide` and `lorebook-seed` or `lorebook-bootstrap` are both present, `guide` wins at runtime.

**`lorebook-never` tag**
Excludes an entry from the vault index entirely. Notes with this tag are skipped during parsing and never appear in matching, AI search, or any pipeline stage.

**`enabled` field**
A frontmatter field (`enabled: false`) that skips an entry entirely during parsing. Disabled entries are excluded from the vault index without removing their lorebook tag.

## Pipeline and matching

**Pipeline**
The full sequence DeepLore runs on each generation: index refresh, keyword matching, AI search, gating, formatting, injection. See [[Pipeline]] for the full flow.

**Stage**
A step in the pipeline (e.g., keyword matching, AI search, gating).

**Retrieval**
What the pipeline does. Selecting which vault entries to inject for the current turn.

**Scan depth**
How many recent chat messages DeepLore searches for keywords. Scan depth 4 means the last 4 messages are scanned.

**Keyword matching**
The first stage of entry selection. Scans recent chat messages for keywords defined in each entry's `keys` field.

**AI search**
The second stage (optional). An AI model evaluates keyword-matched candidates (or the full vault in AI-only mode) and selects the most relevant entries. See [[AI Search]].

**AI selection**
The chosen entries returned by AI search.

**Two-stage mode**
The default and recommended search mode: keywords pre-filter candidates, then an AI ranks and picks the best matches. Balances cost and quality.

**AI-only mode**
Sends the entire vault manifest to AI search every turn, skipping the keyword pre-filter. Higher token cost; useful only on small vaults or when keywords are unreliable.

**Keywords-only mode**
Disables AI search entirely. Pure keyword matching with gating and budget rules. Free to run.

**Manifest**
The compact entry list (titles, token counts, links, summaries) sent to AI search. Summaries truncate to ~600 characters by default (`aiSearchManifestSummaryLength`).

**Keyword occurrence weighting**
An optional tiebreaker that re-sorts entries within the same priority group by keyword hit count. Entries with more keyword occurrences in the scan text rank higher. Enable in [[Settings Reference|Matching & Budget settings]].

**Hierarchical pre-filter**
For large candidate sets (40+), entries cluster by category and the AI selects relevant categories first, then individual entries within them.

## Gating and filtering

**Gating**
Rules that prevent entries from being injected even after they match. Includes requires/excludes rules and contextual gating.

**Requires**
A frontmatter field listing entry titles that must ALL be matched for this entry to inject. Example: `requires: [Dark Council]` means this entry only injects if "Dark Council" is also matched.

**Excludes**
A frontmatter field listing entry titles that BLOCK this entry. If any excluded entry is matched, this entry is filtered out.

**Contextual gating**
Filtering based on narrative context using gating fields. Ships with four default fields (era, location, scene type, present characters); users can define additional custom fields via the **Manage Fields** rule builder. Field definitions are stored in `DeepLore/field-definitions.yaml` in the vault. Set fields via `/dle-set-field <name> [value]` or built-in aliases (`/dle-set-era`, `/dle-set-location`, etc.). See [[Features#Contextual Gating]].

**Pin**
A per-chat override that forces an entry to always inject, bypassing keyword matching and gating. Set via `/dle-pin <name>`.

**Block**
A per-chat override that prevents an entry from ever injecting, even if it matches. Overrides constants. Set via `/dle-block <name>`.

**Folder filter**
A per-chat restriction that limits which vault entries are considered, by filtering on folder path. Set via `/dle-set-folder` (or the drawer Filters tab). Only entries whose `folderPath` starts with one of the allowed folders are included in matching.

## Injection

**Prompt**
The full text sent to the writing AI on each generation.

**Context**
Everything the writing AI sees: the prompt plus all built-in system content. "Context window" is the literal token-budget sense.

**Injection**
The act of placing entry content into the prompt.

**Inject (verb)**
DeepLore's term of art for placing entry content in the prompt.

**Injection position**
Where in the prompt the entry content is placed: `before` (before the main prompt), `after` (after), or `in_chat` (inserted between chat messages at a specific depth).

**Injection depth**
For `in_chat` position, how many messages from the bottom the entry is inserted. Depth 0 = right before the last message.

**Injection role**
The message role used for injected content: `system`, `user`, or `assistant`.

**Token budget**
The maximum number of tokens DeepLore can inject per generation. Entries are selected by priority until the budget is exhausted.

**Prompt list mode**
An alternative injection mode where entries register as Prompt Manager entries (`deeplore_constants`, `deeplore_lore`). Users drag them to any position in the prompt order.

**Outlet**
A frontmatter field (`outlet`) that names an injection slot. Outlet entries are reachable via the `{{outlet::name}}` macro instead of being placed positionally.

## AI features

**Provider**
A company, API, or backend that hosts an LLM (Anthropic, OpenAI, OpenRouter, llama.cpp, etc.).

**Model**
A specific model from a provider (Claude Haiku, GPT-4o-mini, Llama-3-70B).

**Connection profile**
A saved SillyTavern Connection Manager profile DLE can route an AI feature to. Configures provider, model, and API key.

**Connection mode**
The choice of how a DLE feature reaches its AI. As of v2.5 the modes are: `profile` (use a saved Connection Manager profile), `inherit` (reuse the AI Search connection), and `st` (use SillyTavern's own active connection — Session Scribe and Auto Lorebook only). The old `proxy` mode was removed in v2.5; see [[Settings Reference]] for the migration. AI Search itself is profile-only.

**Connection channel**
A per-feature connection. DLE has independent channels for AI search, the Librarian, the Scribe, the Notepad, Auto Lorebook, and Optimize Keys. They do not share settings — each can override mode, profile, model, max tokens, and timeout.

**Librarian**
Two linked systems sharing the name:
1. **Generation tools.** The writing AI gets `search` and `flag` tools during generation. `search` queries the vault for entries the pipeline missed; `flag` records gaps when the writing AI reaches for lore that is not in your vault. (Each is independently gated by its own setting under the master Librarian toggle.)
2. **Emma.** A separate chat agent (opened via `/dle-librarian`, the drawer Librarian tab, or by clicking a flag) that helps you author or update vault entries from flagged gaps. Her toolset is roughly a dozen tools: `search_vault`, `get_entry`, `get_links`, `get_backlinks`, `get_full_content`, `find_similar`, `list_flags`, `list_entries`, `get_recent_chat`, `flag_entry_update`, `compare_entry_to_chat`, plus `get_writing_guide` (only when guide entries exist). Both halves require a tool-calling provider on their connection. Emma uses her own connection channel, separate from AI search.

**Emma**
The Librarian persona. She/her in user-facing copy. Opens from the drawer's Librarian tab, the `/dle-librarian` command, or by clicking a flag.

**Flag**
A record of a gap the writing AI hit during generation. Lives in the Librarian inbox until you open it (to author the entry with Emma), hide it (soft-removal; re-flagging resurfaces), or dismiss it (permanent).

**Gap**
The missing lore the flag records. The writing AI flagged the gap to the Librarian inbox.

**Session Scribe**
An AI feature that periodically summarizes the chat and writes the summary to an Obsidian note. Useful for maintaining session continuity. See [[Features#Session Scribe]].

**Author's Notebook**
A per-chat user scratchpad whose contents are injected into every generation as a system message. Use for character notes, plot reminders, or writing instructions.

**AI Notepad**
A per-chat feature for AI-extracted session notes. The writing AI emits notes inside `<dle-notes>` tags; DLE strips them from the visible chat, accumulates them per-chat in `chat_metadata`, and reinjects them into future messages as context. Two modes: tag mode (user manually tags notes) and extract mode (AI extracts automatically). Has its own connection channel and injection settings. See [[AI-Notepad]].

**Auto Lorebook**
An AI feature that analyzes the chat and suggests new lorebook entries to create in your vault.

**Context Cartographer**
A UI feature that shows which entries were injected into each AI response and why. Appears as a "Lore Sources" button on chat messages. See [[Features#Context Cartographer]].

## UI

**Drawer**
DLE's persistent side panel. Shows live pipeline feedback during chat: which entries were injected, why they matched, token usage, and vault statistics. Five tabs: Injection, Browse, Filters, Librarian, Tools. See [[Drawer]].

**Drawer tab**
One of the five panels in the drawer. Capitalized tab names verbatim: Injection tab, Browse tab, Filters tab, Librarian tab, Tools tab.

**Temperature heatmap**
Color-coded indicator in the Browse tab showing entry injection frequency relative to the vault average. Hot entries (red tint) are injected more often than average; cold entries (blue tint) are injected less often or never.

**Virtual scroll**
A rendering optimization in the Browse tab that only displays visible rows in a long list, enabling smooth handling of vaults with 100+ entries.

**Overlay mode**
A responsive layout mode where the drawer converts to a dismissible overlay on narrow screens (when chat width exceeds 60% of the viewport).

## Infrastructure

**Circuit breaker**
Automatic backoff that stops calls after repeated failures. DLE uses two: one per Obsidian vault (keyed by host:port, 2s-15s exponential backoff) and one for AI search (2 failures to trip, 30s cooldown).

**IndexedDB cache**
Browser-side persistent storage used to cache the vault index. Enables instant page load: the index hydrates from cache, then validates in the background.

**Reuse sync**
An optimization where all files are fetched from Obsidian, but unchanged entries (detected by content hash) skip re-parsing and tokenization. The savings come from avoiding the expensive parse/tokenize step, not from reducing network calls.

**Cache TTL**
Time-to-live for the vault index cache, in seconds. After this period, the index refreshes from Obsidian on the next generation.

**Chat epoch**
An internal counter that increments on every chat switch. Prevents stale data from one chat being written to another.

**Generation lock**
An exclusive lock acquired before each pipeline run, preventing concurrent pipelines from executing. Has a 30-second stale timeout for auto-recovery if a pipeline crashes.

**Epoch guard**
A race-condition guard using two epoch counters (`chatEpoch` and `generationLockEpoch`). If either changes mid-pipeline, the pipeline discards its results; they belong to a stale context.

**AI throttle**
A rate limiter enforcing a 500ms minimum delay between consecutive AI search API calls. Prevents request flooding during rapid regenerations. Throttled calls fall back to keyword results without tripping the circuit breaker.

**Sliding window cache**
A caching strategy for AI search results. Reuses cached results when the vault manifest is unchanged and new chat messages do not mention any vault entity names or keys. Regenerations and swipes always reuse cached results.

## Entry metadata

**Priority**
A number controlling injection order. Lower = higher priority. Suggested ranges: 20 (inner circle), 35 (core lore), 50 (standard), 60+ (secondary/flavor).

**Cooldown**
Generations to skip after an entry is injected. The writing AI does NOT remember lore from prior generations; during cooldown, the AI has no access to this entry's content. Use for rotating flavor entries, not for entries the AI needs consistently.

**Warmup**
Minimum keyword hit count required before an entry triggers. Checked every generation: the keyword must meet the hit count each time, not just the first. Prevents entries from activating on a single casual mention.

**Probability**
Chance (0.0 to 1.0) that a matched entry actually triggers. Use for variety; e.g., 0.5 means the entry injects ~50% of the time it matches.

**Entry decay**
Tracks how many generations pass since each entry was last injected. Stale entries get a freshness boost in the AI manifest; frequently injected entries get a penalty. Helps rotate lore naturally. See [[Features#Entry Decay & Freshness]].

**Refine keys**
A secondary AND filter (`refine_keys` in frontmatter) that requires at least one refine key to also appear in the scan text before the entry triggers. Reduces false positives for entries with common primary keywords. See [[Features#Refine Keys]].

**Cascade links**
Unconditional entry links (`cascade_links` in frontmatter). When an entry matches, all entries listed in its cascade links are pulled in without any keyword check. See [[Features#Cascade Links]].

**Fuzzy search (BM25)**
An optional supplement to keyword matching. Uses BM25/TF-IDF scoring with an inverted index to find entries with partial or approximate keyword matches. Enable in [[Settings Reference|Matching & Budget settings]].

**Wikilinks**
Obsidian-style `[[links]]` in entry content that reference other entries. DeepLore resolves these to actual entry titles for wiki-link candidate expansion in two-stage mode.

**`trackerKey`**
Internal `vaultSource:title` key used to dedupe entries across vaults. Bare titles collide in multi-vault setups; the trackerKey form does not. Surfaced only in advanced docs and diagnostics.

## Related concepts (not DLE features)

**RAG (Retrieval-Augmented Generation)**
A class of systems that uses vector embeddings to retrieve relevant documents and feed them to an LLM. DeepLore is not a vector RAG system: AI search reads compact summaries, not embeddings. The result is similar (relevant lore reaches the model) without the embedding-store infrastructure.

**World Info**
SillyTavern's built-in lorebook system. Stores entries in a JSON file and matches by exact keywords. DeepLore is an alternative lorebook that reads from your Obsidian vault and adds AI ranking; it does not require World Info to be off, but running both means double the token cost on overlapping entries.
