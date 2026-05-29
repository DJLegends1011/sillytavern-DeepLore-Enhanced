# Slash Commands

DeepLore registers more than 40 slash commands in SillyTavern. Type them in the chat input, or open the `/dle` palette and search.

> [!NOTE]
> ST's built-in `/help slash` auto-discovers DLE commands from the `helpString` each one registers, so the in-app help stays current with the code. A couple of commands (`/dle-summarize-range`, `/dle-summarize-rollback`) are registered but intentionally left off the `/dle` palette to keep it focused — they still work and show up in `/help slash`.

## Command palette

### `/dle`
Open the command palette: a searchable popup of every DLE command. Type to filter, click to run.

---

## Vault management

### `/dle-refresh` (alias: `/dle-r`)
Rebuild the vault index from Obsidian. Clears the cache timestamp and re-fetches every entry.

**When to use:** after editing entries in Obsidian, instead of waiting for the cache TTL or auto-sync to pick the change up.

---

### `/dle-browse` (alias: `/dle-b`)
Open the entry browser: a searchable, filterable popup of every indexed entry.

**When to use:** quick review without switching to Obsidian. Browse titles, keywords, priorities, and token sizes.

---

### `/dle-import [folder]`
Import a SillyTavern World Info JSON into the vault. The popup accepts three input methods: pick an existing ST lorebook from a dropdown, browse to a local `.json` file, or paste JSON directly. Pass a folder name to drop the entries into a vault subfolder, e.g. `/dle-import Imported`.

**Notes:**
- Validates JSON before import. Files over 10 MB prompt for confirmation.
- Warns if any entries have neither content nor keys.
- Optionally generates AI summaries for the imported entries (requires AI search to be configured).
- Surfaces a one-shot warning that ST's "Order" semantics flip in DLE: lower priority means higher precedence.

---

### `/dle-graph` (alias: `/dle-g`)
Visualize entry relationships as an interactive force-directed graph. Nodes are entries, edges are wikilinks, requires/excludes, and cascade links. Drag, zoom, pan.

**When to use:** explore the relationship structure. Identify clusters, orphans, dependency chains.

---

### `/dle-cache-info`
Show vault cache status: cached entry count, cache age, browser storage usage (IndexedDB), index load time. Includes a button to clear the cache.

---

### `/dle-status`
Show connection info, entry counts, AI search stats, and cache status in a popup.

**Includes:**
- Enabled vaults with port numbers
- Lorebook tag, always-send tag, never-insert tag, seed tag, bootstrap tag
- Indexed entry counts (total, constants, seeds, bootstrap, guides, estimated tokens)
- Token budget and max-entry caps
- Recursive scan settings
- Cache age and TTL
- AI search state and session call/cache/token totals
- Custom field definitions
- Active folder filter (if any)
- Auto-sync interval

---

## Pipeline inspection

### `/dle-why` (alias: `/dle-context`)
Run the pipeline against the current chat without generating a message, then show what would inject right now.

**Notes:**
- If AI search is on, this makes a real API call and uses tokens. A confirmation dialog appears first.
- Runs full keyword matching, AI search, gating, contextual gating, and cooldowns.
- Results render in the Context Cartographer popup.

---

### `/dle-inspect` (alias: `/dle-i`)
Show a detailed trace of the last generation pipeline.

**Includes:**
- Pipeline mode (two-stage, ai-only, keywords-only)
- Per-stage timing breakdown
- Keyword matches with the specific keyword that fired
- AI selections with confidence and reason
- BM25 fuzzy search stats
- Contextual gating removals with per-field mismatch detail
- Cooldown removals, warmup failures, refine-key blocks
- Strip-dedup removals (already in recent context)
- Probability skips with the rolled value
- Budget/max cuts
- Folder filter info

**When to use:** debug why an entry was or was not injected in the last generation.

---

### `/dle-simulate`
Replay the current chat history step by step, showing which entries activate and deactivate at each message.

**Notes:**
- Uses keyword matching only (no AI search, no probability/warmup/cooldown) for a deterministic view.
- Per-entry scan-depth overrides are respected.
- Most useful after a conversation has some length.

---

### `/dle-analytics`
Show entry usage analytics. Table sorted by injection count: entry name, match count, injection count, last-used timestamp. Includes a Never Injected section for dead-entry detection. When the Librarian is enabled, also lists Librarian totals (searches, flags, entries written/updated) and the top unmet queries.

---

### `/dle-health` (alias: `/dle-h`)
Run 30+ health checks on vault entries and settings. Results group by category in a popup, with errors expanded by default.

**Categories:**
- Multi-vault config and API key validation
- Settings (scan depth, AI mode, leftover Custom Proxy mode from before v2.5, budget, cache TTL, index staleness)
- Entry config (duplicate titles, empty keys, empty content, orphaned references, oversized entries, missing summaries)
- Gating (circular requires, unresolved wikilinks, conflicting overrides)
- AI search (entries without summaries)
- Keywords (short keywords, duplicates across entries)
- Size (constants exceeding budget, oversized seeds)
- Injection (depth/role overrides without `in_chat`)
- Entry behavior (cooldown on constants, warmup unlikely to trigger, bootstrap with no keys, probability zero)

**When to use:** after adding or modifying entries, or when injection behavior surprises you. See [[Features#Entry Health Check]].

---

### `/dle-lint` (alias: `/dle-l`)
Show parser warnings and skipped entries from the last vault index build. Use this when the index build toast mentions warnings or skips.

---

### `/dle-diagnostics` (alias: `/dle-diag`)
Export an anonymized diagnostic report (`.md`) plus a private connections-reference file. The report packages settings, recent pipeline traces from the flight recorder, console/network/error ring buffers, and AI call history. Sensitive values are redacted with stable per-export pseudonyms. See [[Inspection and Diagnostics#Diagnostics export]] for what is in and out.

**When to use:** filing a bug report or asking for help. Open the file and verify the privacy section before sharing.

---

### `/dle-debug [on|off]`
Toggle debug logging. With no argument, flips the current setting. Debug mode echoes interceptor output to a `[DLE-DBG]` console group and enables prompt-replay capture in the AI prompt buffer.

---

### `/dle-logs [count]`
Show the most recent DLE console log entries (default 50, max 500). Drains the console ring buffer and filters for `[DLE]` lines. Includes a copy-to-clipboard button.

---

## AI features

### `/dle-newlore` (alias: `/dle-suggest`)
Analyze the current chat for characters, locations, items, concepts, or events that lack a vault entry, then suggest new entries.

**Output:** popup with each suggestion (title, type, keywords, summary, content preview). Accept writes the entry to Obsidian with proper frontmatter. Reject dismisses it.

**Notes:**
- Works on demand; Auto Lorebook does not need to be enabled.
- Filters out titles that already exist (case-insensitive).
- Uses the Auto Lorebook connection settings.

---

### `/dle-optimize-keys <entry name>`
AI suggests better keywords for the named entry, considering content, summary, and current keys. Suggestions appear in a popup; you apply them in Obsidian.

**Example:** `/dle-optimize-keys Valen Ashwick`

Uses the AI search connection.

---

### `/dle-summarize`
Generate AI search summaries for entries that lack one. Each summary is presented in a review popup before writing back to Obsidian frontmatter. A button on the review popup aborts the remaining queue.

---

### `/dle-summarize-range <range>`
AI-summarize a range of chat messages, hide the originals, and prepend the summary in their place. Returns a summary ID you can use to undo.

**Range syntax:**
- `5-15` summarize messages 5 through 15
- `10-` from message 10 to the end
- `-8` the last 8 messages
- `7` just message 7

The success toast includes the summary ID and the rollback command to undo it. Uses the Optimize Keys connection settings and the dedicated summary prompt/budgets (System tab is not where these live — see the `summarySystemPrompt`/`summaryMaxTokens`/`summaryTimeout` keys).

---

### `/dle-summarize-rollback [id|all]`
Undo a `/dle-summarize-range` operation: restore the hidden messages and remove the summary message.

**Usage:**
- `/dle-summarize-rollback <id>` roll back one summary (the ID from the summarize toast)
- `/dle-summarize-rollback` or `/dle-summarize-rollback all` roll back every summary in this chat

The argument autocompletes with the summaries present in the current chat.

---

### `/dle-review [question]`
Send the entire vault to the AI for review. Posts the vault as a visible user message and triggers a normal generation.

**Usage:**
- `/dle-review` general review
- `/dle-review What inconsistencies do you see?` ask a specific question

**Notes:**
- The review message stays in chat history. Delete it or start a new chat afterward if you do not want it influencing later turns.
- Response token limit comes from the "Review Response Tokens" setting (0 = auto).
- Confirms before sending and shows entry count plus estimated tokens.

---

### `/dle-scribe [focus]`
Write a session summary note to the configured Session Scribe folder.

**Usage:**
- `/dle-scribe` summarize the full session
- `/dle-scribe What happened with the sword?` summarize with a focus topic

**Notes:**
- Works on demand. Session Scribe does not need to be enabled in settings.
- Auto-scribe also runs every N messages when enabled (tracks chat position).
- Writes a timestamped markdown note via the Scribe connection.

---

### `/dle-scribe-history`
Browse all session notes from the configured scribe folder. Notes sort newest first, with character name and timestamp. Click a note to expand the full body.

Requires a configured scribe folder. Fetches notes from Obsidian's REST API.

---

### `/dle-librarian [gap <id> | review | audit]`
Open the Librarian. The Librarian helps you author vault entries from gaps the writing AI flagged during chat.

**Usage:**
- `/dle-librarian` open a new Librarian session
- `/dle-librarian gap <id>` open Emma on a specific gap
- `/dle-librarian review` start a guided gap review
- `/dle-librarian audit` start a vault audit session

**Notes:**
- Requires the Librarian to be enabled in settings.
- Uses the Librarian connection (independent from AI search).

---

## Author tools

### `/dle-notebook`
Open the Author's Notebook editor for the current chat. Content is injected as a system message every generation when Author's Notebook is enabled. See [[Features#Author's Notebook]].

---

### `/dle-ai-notepad [clear]`
View or clear the AI Notepad for the current chat.

**Usage:**
- `/dle-ai-notepad` open the popup with all accumulated AI notes
- `/dle-ai-notepad clear` clear all AI notes for this chat

**How it works:** when AI Notepad is enabled, the writing AI is instructed to append session notes inside `<dle-notes></dle-notes>` tags. DLE strips the tags from the visible chat, stores the notes per-chat, and reinjects them into later messages so the AI keeps continuity.

Per-message AI notes also surface in the Context Cartographer popup.

---

## Per-chat overrides

### `/dle-pin <entry name>`
Pin an entry so it always injects in the current chat, regardless of keywords or AI selection. Stored in `chat_metadata.deeplore_pins`. Pinning an entry that is currently blocked moves it from the block list to the pin list.

---

### `/dle-unpin <entry name>`
Remove a pin from the current chat.

---

### `/dle-block <entry name>`
Block an entry from injecting in the current chat. Stored in `chat_metadata.deeplore_blocks`. Blocking an entry that is currently pinned moves it from the pin list to the block list.

---

### `/dle-unblock <entry name>`
Remove a block from the current chat.

---

### `/dle-pins`
Show all pinned and blocked entries for the current chat. See [[Features#Per-Chat Pin/Block]].

---

## Contextual gating

### `/dle-set-field <field_name> [value]`
Set a custom gating field value. Works with built-in fields (`era`, `location`, `scene_type`, `character_present`) and any user-defined field from `field-definitions.yaml`.

**Usage:**
- `/dle-set-field weather stormy` set directly
- `/dle-set-field weather` open a browse-and-select popup of values found in the vault

For multi fields, comma-separated values are accepted: `/dle-set-field character_present Eris, Valen`.

---

### `/dle-clear-field <field_name>`
Clear a custom gating field, removing it from the active context (e.g. `/dle-clear-field weather`).

---

### `/dle-set-era [era]` (alias: `/dle-era`)
Set the active era for contextual gating (e.g. `/dle-set-era pre-war`). With no argument, opens a browse-and-select popup showing every era value in the vault with entry counts.

If the value matches no entries, the popup lists available eras.

---

### `/dle-set-location [location]` (alias: `/dle-loc`)
Set the active location for contextual gating (e.g. `/dle-set-location The Docks`). With no argument, opens a browse-and-select popup with entry counts.

---

### `/dle-set-scene [scene type]`
Set the active scene type for contextual gating (e.g. `/dle-set-scene combat`). With no argument, opens a browse-and-select popup with entry counts.

---

### `/dle-set-characters <names>`
Set present characters for contextual gating (comma-separated, e.g. `/dle-set-characters Valen, Sera`). With no argument, opens a multi-select popup; toggle characters and the change applies when you close the popup.

---

### `/dle-context-state` (alias: `/dle-ctx`)
Show the current contextual gating state for every defined field (built-in and custom).

---

### `/dle-clear-all-context` (alias: `/dle-reset-context`)
Clear every active gating field at once: era, location, scene type, characters, and all custom fields.

**When to use:** quick reset between scenes or arcs, instead of clearing each field one by one.

---

### `/dle-set-folder [path...]` (alias: `/dle-folder`)
Filter entries by Obsidian folder path. Only entries in the selected folders are eligible for injection.

**Usage:**
- `/dle-set-folder Characters/NPCs` set one folder
- `/dle-set-folder "World Lore" Characters` multiple folders, quote paths with spaces
- `/dle-set-folder` open a selection popup with checkbox toggles per folder

Validates folder paths against the indexed list and warns about unknown ones.

---

### `/dle-clear-folder`
Clear the folder filter, allowing entries from every folder again.

---

## Setup

### `/dle-setup`
Run the guided setup wizard: connect the Obsidian vault, configure the lorebook tag, pick a search mode, and so on. AI search connections are configured separately in the settings panel (Connection → AI Connections; pick a Connection Profile). See [[Installation]].

---

## Quick reference

| Command | Description |
|---------|-------------|
| `/dle` | Command palette |
| `/dle-refresh` (`/dle-r`) | Rebuild vault index |
| `/dle-status` | Connection and index status |
| `/dle-why` (`/dle-context`) | Preview what would inject now |
| `/dle-inspect` (`/dle-i`) | Show last pipeline trace |
| `/dle-simulate` | Replay chat showing entry activation |
| `/dle-browse` (`/dle-b`) | Browse all indexed entries |
| `/dle-import [folder]` | Import ST World Info JSON |
| `/dle-graph` (`/dle-g`) | Visualize entry relationships |
| `/dle-analytics` | Entry usage statistics |
| `/dle-health` (`/dle-h`) | Run 30+ vault health checks |
| `/dle-lint` (`/dle-l`) | Parser warnings from last index build |
| `/dle-diagnostics` (`/dle-diag`) | Export diagnostic report |
| `/dle-debug [on\|off]` | Toggle debug logging |
| `/dle-logs [count]` | Recent DLE console entries |
| `/dle-cache-info` | Vault cache status and storage |
| `/dle-notebook` | Open Author's Notebook editor |
| `/dle-ai-notepad [clear]` | View or clear AI Notepad |
| `/dle-newlore` (`/dle-suggest`) | AI suggests new entries |
| `/dle-optimize-keys <name>` | AI suggests better keywords |
| `/dle-summarize` | Generate missing summaries |
| `/dle-summarize-range <range>` | AI-summarize a chat range, hide originals |
| `/dle-summarize-rollback [id\|all]` | Undo a summarize-range operation |
| `/dle-review [question]` | Send vault to AI for review |
| `/dle-scribe [focus]` | Write session note to Obsidian |
| `/dle-scribe-history` | Browse session notes |
| `/dle-librarian [gap <id> \| review \| audit]` | Open the Librarian |
| `/dle-pin <name>` | Pin entry for this chat |
| `/dle-unpin <name>` | Remove a pin |
| `/dle-block <name>` | Block entry for this chat |
| `/dle-unblock <name>` | Remove a block |
| `/dle-pins` | List pins and blocks |
| `/dle-set-field <name> [value]` | Set any gating field |
| `/dle-clear-field <name>` | Clear a gating field |
| `/dle-set-era [era]` (`/dle-era`) | Set active era |
| `/dle-set-location [location]` (`/dle-loc`) | Set active location |
| `/dle-set-scene [scene type]` | Set active scene type |
| `/dle-set-characters <names>` | Set present characters |
| `/dle-context-state` (`/dle-ctx`) | Show all gating fields |
| `/dle-clear-all-context` (`/dle-reset-context`) | Clear all gating filters |
| `/dle-set-folder [path...]` (`/dle-folder`) | Filter by Obsidian folder |
| `/dle-clear-folder` | Clear folder filter |
| `/dle-setup` | Run setup wizard |
