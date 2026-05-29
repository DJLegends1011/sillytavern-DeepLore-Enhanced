# Frontmatter Fields

The complete reference for the YAML frontmatter at the top of every vault entry. For copy-paste examples see [[Vault Entry Templates]]; for control over *when* an entry fires see [[Advanced Entry Gating]]. New to authoring? Start at [[Writing Vault Entries]].

Every entry needs YAML frontmatter between `---` fences at the top of the file. Only `tags` (with `lorebook`) is strictly required, but you'll almost always want `keys` too.

## Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tags` | array | *(required)* | Must include `lorebook`. Can also include special tags (see below). |
| `keys` | array | `[]` | Keywords that trigger this entry when they appear in chat. |
| `priority` | number | `100` | Sort order. Lower numbers are injected first. See [priority guidelines](#priority-guidelines). |
| `summary` | string | `""` | AI selection summary (recommended under 600 chars). Used by [[AI Search]] to decide relevance. **Not injected into the writing AI.** See [Writing good summaries](#writing-good-summaries). |
| `requires` | array | `[]` | Entry titles that must ALL be matched for this entry to activate. See [[Advanced Entry Gating]]. |
| `excludes` | array | `[]` | Entry titles that, if ANY are matched, block this entry. See [[Advanced Entry Gating]]. |
| `position` | string | *(global setting)* | Override injection position: `before`, `after`, or `in_chat`. |
| `depth` | number | *(global setting)* | Override injection depth (for `in_chat` position). Clamped to 0-10000. |
| `role` | string | *(global setting)* | Override injection role: `system`, `user`, or `assistant`. |
| `scanDepth` | number | *(global setting)* | Override how many recent messages to scan for this entry's keywords. Note: camelCase, not snake_case. |
| `excludeRecursion` | boolean | `false` | If `true`, this entry is skipped during recursive link scanning. Note: camelCase, not snake_case. |
| `constant` | boolean | `false` | If `true`, this entry is always injected regardless of keywords or AI. Equivalent to the `#lorebook-always` tag. |
| `refine_keys` | array | `[]` | Secondary keywords. By default at least one refine key must **also** match (alongside a primary `keys` match) for the entry to trigger. The matching rule is set by `selective_logic`. See [[Advanced Entry Gating]]. |
| `selective_logic` | string | `and_any` | How `refine_keys` are matched: `and_any` (≥1 refine key must match), `and_all` (all must match), `not_all` (at least one must miss), `not_any` (none may match). Invalid values fall back to `and_any` and are flagged by `/dle-lint`. |
| `cascade_links` | array | `[]` | Entry titles to automatically pull in when this entry matches. Unlike wikilink recursion, cascade links are pulled unconditionally (no keyword check needed). See [[Advanced Entry Gating]]. |
| `cooldown` | number | *(none)* | After triggering, skip this entry for N generations. Only values greater than 0 take effect. |
| `warmup` | number | *(none)* | Require the keyword to appear N or more times in the scan text before triggering. Only values greater than 0 take effect. |
| `probability` | number | *(none)* | Chance of triggering when matched (0.0-1.0, clamped). Omit or set to 1.0 for always trigger. |
| `enabled` | boolean | `true` | Set to `false` to skip this entry entirely during indexing. The entry won't appear in the vault index at all. Useful for temporarily disabling an entry without removing the `#lorebook` tag. |
| `outlet` | string | *(none)* | Macro-based injection: when set, the entry is injected wherever you place the `{{outlet::name}}` macro instead of using positional injection. See [[Advanced Entry Gating]]. |
| `era` | string \| string[] | *(none)* | Contextual gating (default custom field): only inject when the active era matches one of these values. See [[Custom Fields]]. |
| `location` | string \| string[] | *(none)* | Contextual gating (default custom field): only inject when the active location matches one of these values. |
| `scene_type` | string \| string[] | *(none)* | Contextual gating (default custom field): only inject when the active scene type matches one of these values. |
| `character_present` | array | `[]` | Contextual gating (default custom field): only inject when any listed character is among the present characters. |
| *(custom fields)* | varies | *(none)* | You can define additional custom gating fields beyond the four defaults. Field definitions are stored in `DeepLore/field-definitions.yaml` in your vault and managed via the "Manage Fields" rule builder. See [[Custom Fields]]. |
| `graph` | boolean | `true` | Set to `false` to exclude this entry from the relationship graph. The entry still works normally for matching and injection. Useful for test entries, meta entries, or entries that add noise to the graph without meaningful connections. |

> [!NOTE]
> Frontmatter uses underscores for most multi-word fields (`scene_type`, `character_present`, `refine_keys`, `cascade_links`, `selective_logic`), but two fields use camelCase to match SillyTavern's World Info naming: `scanDepth` and `excludeRecursion`. Internally the snake_case fields are stored as camelCase (`sceneType`, `characterPresent`) on VaultEntry objects — use the names exactly as written in the table above in your notes.

## Priority guidelines

`priority` controls injection order (lower = injected first / higher priority). If you omit it, the parse default is `100`.

| Range | Use For | Examples |
|-------|---------|---------|
| 10-20 | Inner circle, critical context | Main character, core world rules |
| 30-40 | Core lore, major characters | Important NPCs, key locations |
| 50 | Standard entries | Most entries |
| 60-70 | Secondary, flavor | Minor characters, background details |
| 80-100 | Low priority, rare | Obscure trivia, edge cases |

## Special tags

Add these alongside `#lorebook` to change how an entry behaves:

| Tag | Behavior |
|-----|----------|
| `#lorebook` | Marks this note as a lorebook entry (required). |
| `#lorebook-always` | **Constant.** Always injected regardless of keywords or AI. Equivalent to `constant: true`. |
| `#lorebook-never` | **Excluded.** Never injected, even if keywords match. |
| `#lorebook-seed` | **Seed.** Content is sent to the AI search model as story context on new chats. Not injected into the writing AI. |
| `#lorebook-bootstrap` | **Bootstrap.** Force-injected when the chat is short (at or below the new chat threshold, default 3 messages), then becomes a regular keyword entry. |
| `#lorebook-guide` | **Guide.** Librarian-only writing/style reference. Emma fetches via `get_writing_guide`. Never reaches the writing AI through any path. |

These behaviors are tag-driven (there is no `seed:` / `bootstrap:` / `guide:` frontmatter boolean — only `constant:` has a frontmatter equivalent). Tag names are configurable in [[Settings Reference]]; the defaults above assume you haven't changed them.

> [!IMPORTANT]
> If an entry has both `#lorebook-guide` and any of `#lorebook-seed` / `#lorebook-bootstrap` / `#lorebook`, the `guide` flag wins at runtime: the entry stays Librarian-only.

## Content structure

After the frontmatter, write your entry content in regular Markdown. The recommended structure is:

```
# Entry Title

One-paragraph introduction -- what this is, in narrative prose.

<div class="meta-block">
[Field1: value | Field2: value | ...]
</div>

Remaining prose with full lore content.
Use [[wikilinks]] to cross-reference other entries.
```

The `<div class="meta-block">` is optional but recommended. It provides a compact, structured summary of key facts that the AI can parse quickly. The fields inside depend on the entry type.

Use `[[wikilinks]]` to reference other entries in your vault. DeepLore uses these links for recursive scanning. If entry A is matched and links to entry B, entry B becomes a candidate too.

### Suggested meta-block fields by type

- **Characters:** Species, Role, Callsign, Aliases, Height, Build, Hair, Eyes, Skin, Features, Apparent Age, True Age, Origin, Foreblood, Personality, Speech, Wants, Fears, Powers, Limits, Items, Secret
- **Locations:** Category, Owner, District, Access, Atmosphere, Function, Layout, Rules, Security, Regulars
- **Lore:** Category, Scope, Danger, Who Knows, Triggers, Consequences, Related, Enforcement, Misconceptions
- **Organizations:** Category, Owner, Run By, Public Face, True Purpose, Visibility, Scope, Staff, Key People, Value, Vulnerabilities

These are conventions, not enforced schemas — the meta-block is just flavor text the AI can parse. Use whatever fields make sense for your entry.

## Writing good summaries

The `summary` field is used **only** by [[AI Search]] to decide whether to select an entry. It is never injected into the writing AI's context (the full content handles that).

A good summary answers three questions:
1. **What is this?** Category, role, core identity (1 sentence)
2. **When should it be selected?** Situations, triggers, relevant topics (1-2 sentences)
3. **Key relationships.** Connected entries, if important (brief)

**Bad summary** (describes appearance, useless for selection):
> "Kael is tall with silver hair and violet eyes. He commands the shadows with an iron will and speaks in a low, measured tone."

**Good summary** (tells the AI *when* to pick this entry):
> "The protagonist's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, covert networks, and territory enforcement."

**Good summary** (lore concept):
> "The biological dependency created when a vampire feeds from a mortal. Select when feeding, biting, addiction, venom, feeding sites, or chattel dynamics come up. Scales with vampire age."

Keep summaries under 600 characters (recommended, not enforced; configurable via `aiSearchManifestSummaryLength`, default 600 — beyond that, the manifest silently truncates). Focus on *when to select*, not *what to write*. Do NOT include physical descriptions, atmospheric prose, or info only useful after injection.

## Hiding content from the writing AI

You can put information in your vault entries that **never reaches the writing AI**. Useful for author notes, organizational metadata, or reference material you want in Obsidian but not in the prompt.

**Obsidian comments (`%%...%%`):** Anything between double-percent markers is stripped. Obsidian also hides these in reading mode, so they work as true hidden comments.

```markdown
## Background

Valen grew up on the Ashwick Estate, trained from childhood.

%%
Author note: This backstory contradicts the timeline in Chapter 3.
Need to reconcile before the next arc.
%%

He joined the Ironveil Guild at 19.
```

**Exclusion zones (`%%deeplore-exclude%%...%%/deeplore-exclude%%`):** For larger blocks you want visible in Obsidian's edit mode but hidden from the writing AI. These are stripped before any other processing.

```markdown
## Relationships

- **Sera Thornwick** -- Closest ally. She helped him escape the Guild.

%%deeplore-exclude%%
### Relationship Tracker (OOC)
- Sera: Trust 8/10, growing romantic tension
- Korrath: Nemesis, but conflicted
- Guild: Active hostility
%%/deeplore-exclude%%

- **Korrath** -- Former Guild partner turned hunter.
```

Both methods are also invisible to the selection AI's manifest (summaries and content truncation happen after cleaning).

## Common mistakes

Easy-to-hit frontmatter footguns. Each produces a warning in `/dle-lint` when `lenientAuthoring` is on, and a silent skip/drop when off. Diagnose a single entry via `/dle-inspect`.

**Field-name case.** YAML keys are case-sensitive. Canonical field names are lowercase (except `scanDepth` and `excludeRecursion`, which are camelCase).
```yaml
# WRONG
Keys:
  - foo
Priority: 50

# RIGHT
keys:
  - foo
priority: 50
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

**Missing `lorebook` tag.** Without it, the entry is skipped during indexing (no warning by default). Surfaced in the post-index summary toast.
```yaml
# WRONG — indexed but never injected
tags:
  - characters

# RIGHT
tags:
  - characters
  - lorebook
```

**Missing frontmatter fences.** A file with no `---` block is skipped entirely.
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

---

Next: [[Vault Entry Templates]] · [[Advanced Entry Gating]] · back to [[Writing Vault Entries]]
