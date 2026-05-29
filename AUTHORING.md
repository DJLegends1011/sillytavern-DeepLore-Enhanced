# Writing New Vault Entries

## Frontmatter Template
Only **required** fields: `tags` (must include lorebook tag) and `keys`. All else optional.

```yaml
---
tags:
  - category/subcategory
  - lorebook           # required — this is what makes it a lorebook entry
keys:
  - Primary Name
  - alias1
  - trigger keyword
priority: 50          # lower = higher priority (20=inner circle, 35=core lore, 60=secondary); default when omitted is 100
summary: "Truncated to ~600 chars in the AI search manifest. Written for AI selection, not for the writing AI. See below."
enabled: true         # set to false to skip this entry entirely
# Optional metadata (not parsed by the pipeline, for vault organization only):
# fileClass: character|location|lore|organization
# type: character|location|lore|organization|story
# status: active
---
```

Optional lorebook fields: `requires`, `excludes`, `position`, `depth`, `role`, `scanDepth`, `excludeRecursion`, `outlet`, `graph`. Entries tagged `lorebook-always` = constants (always injected); `constant: true` in frontmatter is the equivalent — it's the *only* one of the special behaviors with a frontmatter boolean. `lorebook-never` = excluded. `lorebook-seed` content force-injected into writing AI prompt AND prepended as story context in AI search prompt on new chats. `lorebook-bootstrap` force-injects when chat at or below `newChatThreshold` (default 3, uses `<=`). `lorebook-guide` = Librarian-only writing guides — never reach writing AI via any path. `enabled: false` skips entry entirely. `outlet` (string) enables macro-based injection via `{{outlet::name}}` instead of positional. `graph: false` excludes from relationship graph.

> **`seed`, `bootstrap`, and `guide` are tag-only.** There is *no* `seed: true` / `bootstrap: true` / `guide: true` frontmatter field — writing one does nothing. Apply the behavior by adding the matching tag (`lorebook-seed`, `lorebook-bootstrap`, `lorebook-guide`) to your `tags` list. Only `constant` has both a tag (`lorebook-always`) and a frontmatter boolean.

Full frontmatter field reference (including `guide`, `cooldown`, `warmup`, `probability`, `refine_keys`, `cascade_links`, gating fields, etc.) in table in `CLAUDE.md` next to this file.

### Field name casing — the one footgun to memorize
YAML keys are case-sensitive, and DLE's parser does **not** normalize casing for you. Worse, the canonical field names are *not* uniformly one style — they're split:

- **camelCase:** `scanDepth`, `excludeRecursion`
- **snake_case:** `scene_type`, `character_present`, `refine_keys`, `cascade_links`, `selective_logic`
- **lowercase (single word):** `keys`, `priority`, `tags`, `requires`, `excludes`, `position`, `depth`, `role`, `cooldown`, `warmup`, `probability`, `summary`, `graph`, `enabled`, `constant`, `outlet`

Write `scan_depth` or `excludeRecursion` as `exclude_recursion` and the field is silently ignored (treated as an unknown field). Write `sceneType` instead of `scene_type` and your gating field won't register. When in doubt, copy the exact spelling from the reference table in `CLAUDE.md` — don't guess from the surrounding fields' style.

## Summary Field Guidelines
`summary` used ONLY in AI search manifest — helps Haiku decide whether to select entry. NOT injected into writing AI context (full content handles that). Truncated to ~600 chars in manifest (configurable via `aiSearchManifestSummaryLength`, default 600) — not hard authoring limit, beyond that silently cut.

Write summaries answering:
1. **What is this?** — Category, role, core identity (1 sentence)
2. **When should it be selected?** — Situations, triggers, relevant topics (1–2 sentences)
3. **Key relationships** — Connected entries (brief, if important)

Do NOT include: physical descriptions, atmospheric prose, info only useful after injection.

Example (character): "Eris's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, Raven's network, and territory enforcement."

Example (lore): "The biological dependency created when a vampire feeds from a mortal — same mechanism as Bloodchain via saliva. Select when feeding, biting, addiction, venom, feeding sites (Khal/neck, Rhyn/wrist, Thae/thigh), or chattel dynamics come up. Scales with vampire age."

## Common Mistakes
Easy-to-hit frontmatter footguns. Each produces a warning in `/dle-lint` when `lenientAuthoring` is on, silent skip/drop when off. Diagnose single entry via `/dle-inspect` (see `diagnoseEntry()` in `src/ui/diagnostics.js`).

**Field-name case.** YAML keys are case-sensitive, and the canonical names are a *mix* of styles (see "Field name casing" above). Capitalizing a lowercase field, or using the wrong style on a multi-word field, silently drops it.
```yaml
# WRONG
Keys:            # capital K — ignored
  - foo
Priority: 50     # capital P — ignored, falls back to default 100
scan_depth: 2    # snake_case — wrong; the field is scanDepth (camelCase)
sceneType: [day] # camelCase — wrong; the gating field is scene_type (snake_case)

# RIGHT
keys:
  - foo
priority: 50
scanDepth: 2
scene_type: [day]
```

**`keys` as comma-string instead of list.** A quoted comma-string is one key, not many.
```yaml
# WRONG — treated as single key "foo, bar, baz"
keys: "foo, bar, baz"

# RIGHT
keys:
  - foo
  - bar
  - baz
```

**Numeric fields quoted as strings.** YAML `"3"` is a string, not a number; silently fails type check.
```yaml
# WRONG
priority: "3"
probability: "0.5"

# RIGHT
priority: 3
probability: 0.5
```

**`cooldown` / `warmup` of `0` (or negative) does nothing.** These gates only engage when the value is **greater than 0**. `cooldown: 0` is treated as "no cooldown," not "skip zero generations." Same for `warmup`. If you meant to disable the gate, just omit the field.
```yaml
# NO-OP — same as omitting the field
cooldown: 0
warmup: 0

# ACTIVE — skip 2 generations after firing / require 2 hits before firing
cooldown: 2
warmup: 2
```

**`probability` outside 0–1 is silently clamped.** `probability` is a fraction (0.0–1.0), not a percentage. `probability: 50` is clamped to `1` (always fires), not "50%." Use `0.5` for a 50% chance.
```yaml
# WRONG — clamped to 1.0 (always)
probability: 50

# RIGHT — 50% chance
probability: 0.5
```

**Missing `lorebook` tag.** Without it, entry is skipped during indexing (no warning by default). Surfaced in the post-index summary toast.
```yaml
# WRONG — indexed but never injected
tags:
  - characters

# RIGHT
tags:
  - characters
  - lorebook
```

**Missing frontmatter fences.** File with no `---` block is skipped entirely.
```markdown
# WRONG — no fences, no frontmatter, silent skip
keys: [foo]

# RIGHT
---
tags: [lorebook]
keys: [foo]
---
```

**Typo'd `requires` / `excludes`.** These must match entry titles exactly (case-sensitive). Typos silently drop the gate.
```yaml
# WRONG — typo drops the requires gate entirely
requires:
  - Bloodchian

# RIGHT
requires:
  - Bloodchain
```

Run `/dle-lint` after authoring to catch all of these at once.

## Content Structure
```markdown
# Entry Title

One-paragraph introduction — what this is, in narrative prose.

<div class="meta-block">
[Field1: value | Field2: value | ...]
</div>

Remaining prose sections with full lore content.
Use [[wikilinks]] to cross-reference other entries.
```

## Meta-block Fields by Type
- **Characters:** Species, Role, Callsign, Aliases, Height, Build, Hair, Eyes, Skin, Features, Apparent Age, True Age, Origin, Foreblood, Personality, Speech, Wants, Fears, Powers, Limits, Items, Secret
- **Locations:** Category, Owner, District, Access, Atmosphere, Function, Layout, Rules, Security, Regulars
- **Lore:** Category, Scope, Danger, Who Knows, Triggers, Consequences, Related, Enforcement, Misconceptions
- **Organizations:** Category, Owner, Run By, Public Face, True Purpose, Visibility, Scope, Staff, Key People, Value, Vulnerabilities

## WI Import Parity (v2.5)

If you imported a SillyTavern World Info book via `/dle-import`, your entries may carry extra frontmatter fields that DLE itself doesn't act on. They're preserved so `/dle-lint` surfaces them and you can decide whether to keep them. Remove the lines you don't want — DLE won't notice either way.

**Fields DLE acts on natively** (you can author these by hand too):

| Field | Effect |
|-------|--------|
| `enabled: false` | Skip the entry entirely. Authoring shortcut for "disabled WI entries." |
| `excludeRecursion: true` | Don't scan this entry's content during the recursive matching pass. |
| `role: system\|user\|assistant` | For `position: in_chat`, sets the chat-message role of the injection. |
| `selective_logic: and_any\|and_all\|not_all\|not_any` | Refine-key gating mode. `and_any` (default) = ≥1 refine key must match. `and_all` = all must match. `not_all` = at least one must miss (full match blocks). `not_any` = zero matches (any hit blocks). Empty `refine_keys` passes for all 4 modes. |

**Fields preserved for round-trip readability only** (DLE ignores; `/dle-lint` flags with `W_WI_ROUND_TRIP` so you can find them):

`vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, plus 6 ST-specific scan-source toggles (`match_persona_description`, `match_character_description`, `match_character_personality`, `match_character_depth_prompt`, `match_scenario`, `match_creator_notes`).

**Fields preserved with implementation planned** (`W_NOT_IMPLEMENTED` lint code, has a BUG number for tracking):

`sticky` (BUG-047), `delay` (BUG-048), `group` / `group_weight` (BUG-052).

**Example Messages entries** (ST positions 5 / 6) get a `## Example Dialogue` subheader prepended to the body on import — DLE has no EM injection slot, so the sample lines land as flavor content inside the entry body. Most users find a single short flavor quote per character entry is enough to teach the LLM the voice. The post-import popup offers a one-click "Skip Example Messages on future imports" toggle.

## Vault Folder Structure
Each entry's folder path extracted from filename (not frontmatter), used for folder-based filtering. Organize into subfolders (e.g., `Characters/`, `Locations/`, `Lore/`) enables per-folder filtering in UI and via `/dle-folder` command.