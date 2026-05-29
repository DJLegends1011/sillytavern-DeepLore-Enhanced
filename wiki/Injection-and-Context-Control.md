# Injection and context control

How and where entries land in the prompt, and the per-chat overrides that let you steer what gets injected on this chat without touching frontmatter.

For the upstream stages that decide which entries reach injection, see [[Pipeline]] and [[Entry Matching and Behavior]].

---

## Per-entry injection position

Entries can override the global injection position via frontmatter:

| Field | Values | Description |
|-------|--------|-------------|
| `position` | `before`, `after`, `in_chat` | Where to inject |
| `depth` | number | Chat depth (for `in_chat`) |
| `role` | `system`, `user`, `assistant` | Message role (for `in_chat`) |

Entries are grouped by their effective position (global default or override). Each group is injected separately via `setExtensionPrompt`.

**Example:** most lore at depth 4 as system messages, but a character's dialogue hints at depth 1 as user messages.

See [[Writing Vault Entries]] for templates.

---

## Prompt Manager integration

Set **Injection Mode** to **Prompt List** to register DLE's injections as named entries in SillyTavern's Prompt Manager. This lets you drag them to any position in the prompt order: before character definition, after Author's Note, between example messages, wherever.

**How it works:**

1. Switch injection mode to "Prompt List" in DLE settings.
2. Generate at least once so the entries appear.
3. Open the Prompt Manager and find `deeplore_constants` and `deeplore_lore`.
4. Drag them to your desired position, or switch to Absolute mode with a custom depth.

**Notes:**

- Requires a Chat Completion API (OpenAI-compatible).
- Per-entry frontmatter overrides with custom position/depth still create separate injection groups.
- The `deeplore_notebook` (Author's Notebook) and `deeplore_ai_notepad` (AI Notepad) entries also appear in the Prompt Manager when those features are enabled, so you can position them independently.

---

## Author's Notebook

A persistent per-chat scratchpad injected into every generation. Use it for author notes, scene direction, tone guidance, or anything you want the writing AI to always see for this specific chat.

**How it works:**

1. Open the notebook via `/dle-notebook` or the "Open Notebook" button in settings.
2. Write any text. It's saved per-chat in `chat_metadata`.
3. The notebook content is injected into every generation as a separate prompt, independent of the entry pipeline.

**Setup:**

1. Enable "Enable Author's Notebook" in [[Settings Reference|Author's Notebook settings]].
2. Choose injection position (Before Main Prompt, After Main Prompt, or In-chat at depth).
3. Open the editor and start writing.

**Notes:**

- Notebook content is stored in `chat_metadata.deeplore_notebook` and persists across sessions for that chat.
- Injection is independent of the lorebook pipeline. The notebook always injects when enabled, regardless of entry matching.
- Has its own position, depth, and role settings separate from the main lorebook injection.

---

## Per-chat pin/block

Pin entries to always inject, or block entries from injecting, on a per-chat basis. Pins and blocks are stored in `chat_metadata` and survive page reloads.

**Commands:**

- `/dle-pin <entry name>`: pin an entry (always inject in this chat).
- `/dle-unpin <entry name>`: remove a pin.
- `/dle-block <entry name>`: block an entry (never inject in this chat).
- `/dle-unblock <entry name>`: remove a block.
- `/dle-pins`: show all pins and blocks for the current chat.

**How it works:**

- Pinned entries are force-injected like constants, regardless of keywords or AI selection. They get `priority=10` to give them the best shot at surviving budget truncation.
- Blocked entries are removed from the pipeline before injection, regardless of matches. Blocks override constants: a blocked constant is removed.
- Pins and blocks apply after the main pipeline runs but before formatting.

**UI access:** the [[Drawer]] Browse tab has inline pin/block buttons on each entry. No slash commands needed. Per-chat injection counts are displayed as badges on each entry.

---

## Contextual gating

Filter entries based on the current story context using gating fields in frontmatter. DLE ships with four default fields (`era`, `location`, `scene_type`, `character_present`). You can define additional custom fields via the rule builder, accessible from the [[Drawer]] Filters tab toolbar (gear icon) or the "Edit Fields" button in the Settings popup.

**Default frontmatter fields:**

| Field | Type | Description |
|-------|------|-------------|
| `era` | string \| string[] | Entry only injects when the active era matches any value |
| `location` | string \| string[] | Entry only injects when the active location matches any value |
| `scene_type` | string \| string[] | Entry only injects when the active scene type matches any value |
| `character_present` | string[] | Entry only injects when any listed character is present |

Custom fields work the same way: add the field name to your entry's frontmatter with one or more values, then set the active value via `/dle-set-field`. Field definitions are stored in `DeepLore/field-definitions.yaml` in your vault. Each field definition specifies a type (`string`, `number`, `boolean`), a multi-value flag, a gating operator (`match_any`, `match_all`, `not_any`, `exists`, `not_exists`, `eq`, `gt`, `lt`), and a tolerance level (`strict`, `moderate`, `lenient`).

**Tolerance** controls what happens when an entry has a value for a field but the active context doesn't:

- **Strict:** entry is blocked (out of context).
- **Moderate:** entry passes through.
- **Lenient:** like moderate, plus `match_any` and `match_all` non-matches also pass. Precision operators (`eq`, `gt`, `lt`, `not_any`) always filter.

**Commands:**

- `/dle-set-field <name> [value]`: set any gating field (built-in or custom). With no value, opens a browse-and-select popup.
- `/dle-clear-field <name>`: clear a gating field from the active context.
- `/dle-set-era [era]`: alias for `/dle-set-field era`. With no argument, opens a browse-and-select popup.
- `/dle-set-location [location]`: alias for `/dle-set-field location`. With no argument, shows a browse-and-select popup.
- `/dle-set-scene [type]`: alias for `/dle-set-field scene_type`. With no argument, shows a browse-and-select popup.
- `/dle-set-characters <names>`: alias for `/dle-set-field character_present`. Comma-separated list.
- `/dle-context-state`: show all active gating fields (built-in and custom).

**Notes:**

- Context state is stored per-chat in `chat_metadata.deeplore_context`.
- Entries without contextual fields are unaffected (always pass through).
- Partial matches work: an entry with only `era` set is filtered only on era, regardless of other fields.
- Custom fields appear automatically in the [[Drawer]] Browse tab as filter dropdowns and in the Filters tab with status dots and impact counts.
- The relationship graph can color nodes by any custom gating field.
- Force-injected entries (constants, seeds, bootstraps, pins) are exempt from contextual gating.

---

## Per-chat folder filter

Restrict injection to entries from specific vault folders. When a folder filter is active, only entries whose vault folder path matches the filter are eligible for injection. Useful for vaults organized by storyline, setting, or campaign.

**Commands:**

- `/dle-set-folder [path]`: set the folder filter. With no argument, opens a browse-and-select popup showing all folders in the vault.
- `/dle-clear-folder`: clear the folder filter so entries from all folders pass.

**How it works:**

- Folder filtering runs as both a pre-filter (before AI search, so the AI doesn't waste selections on filtered entries) and a post-filter (after selection, as the authoritative gate).
- Constants, seeds, bootstrap entries, and pinned entries are exempt.
- The filter is stored per-chat in `chat_metadata.deeplore_folder_filter`.
- Multiple folders can be selected. The filter uses OR logic: entries from any selected folder pass.
- Subfolder matching: an entry under `Lore/Magic/Schools` matches a filter for `Lore/Magic`.

---

## Confidence-gated budget

AI search over-requests entries (2x your configured max), then sorts results by confidence tier (high, medium, low) before applying the budget cap. High-confidence picks are prioritized. When the budget is tight, the most relevant entries make the cut.

**How it works:**

1. The AI is asked to select up to 2x your maxEntries setting.
2. Results are sorted: high confidence first, then medium, then low.
3. The budget and max entries caps are applied to this sorted list.
4. Low-confidence picks are the first to be cut when the budget is tight.

The AI gets room to suggest marginal entries without displacing clearly relevant ones.
