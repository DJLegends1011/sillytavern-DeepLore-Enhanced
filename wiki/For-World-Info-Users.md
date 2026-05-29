# For World Info Users

If you already use SillyTavern's built-in World Info (WI) lorebook, most concepts transfer directly to DeepLore. A few fields renamed, two behave differently enough to bite you, and a handful of WI features aren't yet implemented. This page is the field-by-field cheat sheet.

**Core difference:** WI is a JSON file edited through ST's UI. DeepLore is a folder of Markdown notes in an [Obsidian](https://obsidian.md/) vault, indexed through the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. See [[Installation]] for vault setup; this page assumes you already have a vault working.

---

## Field mapping cheat sheet

**v2.5 update:** DeepLore now imports every ST WI field. Some land natively (DLE acts on them), some round-trip into the vault for visibility via `/dle-lint` without enforcement. See [[#Importing your World Info JSON]] below for what each tier means.

| World Info field | DeepLore equivalent | Notes |
|---|---|---|
| `key` (primary keys) | `keys:` (YAML list) | One trigger keyword per list item. Comma-string format from older ST exports auto-splits on import. See [[Frontmatter Fields]]. |
| `keysecondary` (secondary keys) | `refine_keys:` | Gating mode set by `selective_logic`. Default `and_any` matches WI's default. |
| `comment` (entry name) | The note's filename and `# Title` | DeepLore uses the Obsidian note title as the entry title. Falls back to the first key if `comment` is empty. |
| `content` | Everything below the frontmatter fence | Plain Markdown body. |
| `constant` (always inject) | The `lorebook-always` tag | See [[Glossary#Constant]]. |
| `order` | `priority:` | **Semantic flip. See gotcha 1 below.** |
| `position` (7 ST positions) | `position:` (`before` / `after` / `in_chat`) | Lossy collapse. Original ST value preserved as `# original_st_position: N` YAML comment. EM positions 5/6 get special handling — see [[#Example Messages handling (v2.5)]] below. |
| `depth` | `depth:` | Used when `position: in_chat`. |
| `role` | `role:` (`system` / `user` / `assistant`) | **v2.5: now native on import.** Maps ST integer enum (0/1/2) to symbolic name. |
| `probability` | `probability:` | Auto-rescaled on import (0-100 to 0.0-1.0). See gotcha 2 below for the manual-authoring footgun. |
| `scanDepth` (per-entry override) | `scanDepth:` | Chat messages to scan for this entry's keys. |
| `excludeRecursion` | `excludeRecursion:` | **v2.5: now native on import.** Honored by the recursion pass. |
| `disable` | `enabled: false` | **v2.5: now native on import.** Pre-v2.5 disabled WI entries silently imported as active — most damaging silent downgrade in the importer, fixed. |
| `selectiveLogic` (AND_ALL / NOT_ALL / NOT_ANY) | `selective_logic:` (all 4 modes) | **v2.5: now native on import.** All four modes enforced by `applySelectiveLogic` gate in the primary keyword + recursion paths. BM25 fuzzy still bypasses refine keys (intentional — TF-IDF is content-wide). |
| `sticky` (stay active N messages) | `sticky:` | Round-trip only. Preserved as frontmatter, flagged `W_NOT_IMPLEMENTED` by `/dle-lint`. Roadmap: BUG-047. |
| `delay` | `delay:` | Round-trip only. Roadmap: BUG-048. |
| `group` / `groupWeight` | `group:` / `group_weight:` | Round-trip only. Roadmap: BUG-052. |
| `vectorized` | `vectorized:` | **v2.5: round-trip preservation.** DLE has no vector backend; flagged `W_WI_ROUND_TRIP` for visibility. |
| `caseSensitive` / `matchWholeWords` (per-entry) | `case_sensitive:` / `match_whole_words:` | **v2.5: round-trip preservation.** DLE has global toggles only — per-entry overrides preserved as frontmatter for visibility, not enforced. |
| `useProbability` / `preventRecursion` / `delayUntilRecursion` / `groupOverride` / `useGroupScoring` / `automationId` / `addMemo` / `displayIndex` | `use_probability:` / `prevent_recursion:` / `delay_until_recursion:` / `group_override:` / `use_group_scoring:` / `automation_id:` / `add_memo:` / `display_index:` | **v2.5: round-trip preservation.** No DLE equivalent. Preserved as frontmatter so authors can see what ST configured. |
| `matchPersonaDescription` + 5 sibling scan-source toggles | `match_persona_description:` etc. | **v2.5: round-trip preservation.** DLE scans chat only. |
| Regex key (`/pattern/flags`) | **Not yet supported** | Treated as literal string. Roadmap: BUG-045. |

---

## Two gotchas that bite

### 1. Priority is inverted

In **World Info**, a higher `order` number means the entry appears **first** in the injected block.

In **DeepLore**, a **lower** `priority` number means the entry is **more important** and wins budget and ordering decisions.

```
WI:  order: 100   →  shows up first
DLE: priority: 10 →  shows up first
```

`/dle-import` keeps your numbers as-is, so the sort order flips after import. The post-import report popup calls this out as one of the items needing manual review. Re-priority your imported entries. See [[Frontmatter Fields]] for guidance on choosing values.

### 2. Probability is a fraction in DeepLore

In **World Info**, `probability: 50` means "50% chance."

In **DeepLore**, `probability` is a 0.0 to 1.0 fraction. `probability: 0.5` means 50%.

`/dle-import` rescales the field automatically. Imported entries arrive with `probability: 0.50`. The footgun is **hand-authored** entries: if you write `probability: 50` in YAML directly, DeepLore evaluates `50 > 1.0` and the gate always passes (no random branch). Roadmap item BUG-099 will reject or rescale out-of-range values; until then, write fractions.

---

## DeepLore-only concepts (no WI equivalent)

These don't exist in WI. Skim once so you know they're there:

- **Seed entries** (`lorebook-seed`): content sent to the AI search stage as story context on new chats. Force-injected into the writing AI prompt as well. See [[Glossary#Seed Entry]].
- **Bootstrap entries** (`lorebook-bootstrap`): force-inject when chat is short (default: 3 or fewer messages), then become regular triggered entries. See [[Glossary#Bootstrap Entry]].
- **Guide entries** (`lorebook-guide`): Librarian-only writing and style guides. Never reach the writing AI through any path. See [[AI-Powered Tools#Librarian]].
- **`summary` field**: tells AI search *when* to pick this entry. Required for AI search to work well. See [[Frontmatter Fields]].
- **Contextual gating**: `era`, `location`, `scene_type`, `character_present`, plus your own custom fields filter entries by story state. See [[Custom Fields]].
- **`requires` / `excludes`**: entry-title graph gating. `requires: [Bloodchain]` means "only inject me if Bloodchain was also selected." See [[Entry Matching and Behavior]].
- **`cooldown` / `warmup`**: per-entry timing gates. See [[Entry Matching and Behavior]].
- **`outlet`**: macro-based injection via `{{outlet::name}}` instead of positional. See [[Injection and Context Control]].

---

## Importing your World Info JSON

DeepLore ships an importer that converts WI JSON into Markdown notes with proper frontmatter. Three input methods: the dropdown (lists existing ST lorebooks), a local file browser, or paste-text into the textarea.

**Steps:**

1. Export your WI book from SillyTavern (or copy the character card with embedded WI).
2. In chat, run `/dle-import [folder]`. A folder argument writes there; without one, entries land in the vault root.
3. In the popup: select the lorebook from the dropdown, browse a JSON file, or paste JSON text.
4. The importer creates one `.md` file per entry with frontmatter filled in. Duplicate filenames get a `_imported` suffix; nothing is silently overwritten.
5. After import, if AI search is enabled, the importer offers to generate AI summaries for each new entry (replacing the `"Imported from SillyTavern World Info"` placeholder).

**v2.5: every WI field now lands.** Three tiers:

1. **Native** — DLE acts on the field directly: `key`, `keysecondary`, `comment`, `content`, `constant`, `order`→`priority`, `position` (with EM handling — see below), `depth`, `probability`, `scanDepth`, `disable`→`enabled:false`, `excludeRecursion`, `role`, `selectiveLogic` (all 4 modes).
2. **Round-trip preserved** — landed in vault frontmatter as snake_case, flagged by `/dle-lint` (`W_NOT_IMPLEMENTED` for planned-to-implement fields like `sticky`/`delay`/`group*`, `W_WI_ROUND_TRIP` for "DLE intentionally ignores"): `vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, the 6 `match_*` scan-source toggles, plus the modern ST fields `triggers`, `ignore_budget`, `character_filter`, and `decorators`.
3. **Still needs manual review** (true semantic gaps DLE can't auto-fix):
   - `priority` (semantic flip; the import report calls it out)
   - Regex keys (treated as literal strings — Roadmap BUG-045)

The post-import popup (v2.5) shows per-field counts so you can see what landed where. See [[Setup and Import#ST lorebook import bridge]] for the popup reference.

### Example Messages handling (v2.5)

ST positions 5 (`before_example_messages`) and 6 (`after_example_messages`) inject sample dialogue lines adjacent to your chat's example messages. DeepLore has no equivalent slot, so:

- **Default (`append`)** — convert to normal vault entry. Map injection position to `before` (pos 5) or `after` (pos 6). Prepend `## Example Dialogue\n\n` to the body so the sample lines read as flavor content inside the entry when the LLM sees it. Markdown subheader — ST does NOT parse it.
- **Alternative (`skip`)** — drop these entries entirely on import.

Most users find a single short flavor quote inside the parent character entry is enough to teach an LLM the voice; the EM slot is often noise once the model has the character description. The post-import popup explains this and offers a one-click "Skip Example Messages on future imports" button that flips the setting. Already-imported EM entries stay in the vault — `/dle-delete` them by name if you want them gone.

Override the default in `Settings → DeepLore Enhanced → Matching → Import`, or per-call via `options.emHandling: 'append' | 'skip'` for companion-extension integrations.

---

## Running WI and DeepLore side by side

DeepLore does not disable SillyTavern's built-in World Info. With both active, DeepLore's entries inject via the extension prompt channel and WI entries inject via the standard WI channel. They co-exist; they don't talk to each other.

**Recommended:** pick one. Either migrate fully to DeepLore, or keep using WI. Running both doubles your maintenance and can double-inject entries. The `/dle-import` bridge is built to make the full migration painless.
