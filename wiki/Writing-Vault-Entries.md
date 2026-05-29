# Writing Vault Entries

This is the hub for authoring lorebook entries in your Obsidian vault. Start here, then jump to the page you need.

## How it works

1. You write notes in Obsidian with YAML frontmatter
2. Notes tagged with `#lorebook` are indexed as lorebook entries
3. The `keys` field lists keywords. When those keywords appear in recent chat messages, the entry is injected into the AI prompt
4. With [[AI Search]] enabled, a `summary` field helps the AI decide when to select the entry even without exact keyword matches

That's it. Tag it, give it keywords, write your lore.

The absolute minimum is a tag and some content:

```markdown
---
tags:
  - lorebook
keys:
  - Silver Keep
---

# Silver Keep

A crumbling fortress on the northern ridge, now home to bandits and bad memories.
```

When "Silver Keep" appears in chat, this content gets injected. Everything else is optional and exists to give you finer control.

## Where to go next

- **[[Vault Entry Templates]]** — Complete, copy-paste-ready notes for every entry type: characters, locations, lore, organizations, story arcs, constants, seeds, bootstraps, and more. The fastest way to start writing.
- **[[Frontmatter Fields]]** — The complete field reference: every YAML field, its type, default, and meaning; priority guidelines; the special `#lorebook-*` tags; and the recommended content structure (meta-blocks, hiding content from the AI).
- **[[Advanced Entry Gating]]** — Conditional control over *when* an entry fires: `requires`/`excludes`, `cooldown`/`warmup`/`probability`, `refine_keys`/`selective_logic`, `cascade_links`, contextual gating, and macro-based `outlet` injection.
- **[[Custom Fields]]** — Define your own contextual gating fields beyond the four defaults.
- **[[For World Info Users]]** — If you imported a SillyTavern World Info book, this explains the extra frontmatter fields your entries may carry.

## What each AI sees

Your vault entry is used by two different AIs that see very different things. Understanding the difference helps you write better entries and summaries.

### The selection AI (AI Search manifest)

The selection AI **never sees your full entry**. It sees a compact one-line manifest entry and uses it to decide whether your entry is relevant to the current conversation:

```xml
<entry name="Valen Ashwick">
Valen Ashwick (285tok) → Ashwick Estate, Ironveil Guild, Sera Thornwick, Korrath
Rogue spellsword and former member of the Ironveil Guild. Select when melee combat,
dual-wielding, shadow magic, guild politics, or the Ashwick bloodline comes up.
Close ally of Sera and rival of Korrath.
</entry>
```

| Part | Source | Purpose |
|------|--------|---------|
| `Valen Ashwick` | Entry title | Identifies the entry |
| `(285tok)` | Estimated from content length | Helps the AI consider token budget |
| `→ Ashwick Estate, ...` | Extracted from `[[wikilinks]]` in content | Shows relationships to other entries |
| Summary text | `summary` frontmatter field | Tells the AI *when* to select this entry |

If an entry has no `summary` field, the content is truncated to ~600 characters instead. Writing good summaries matters: the selection AI's only context for your entry is this compact view.

An entry without a summary or wikilinks gets an even simpler manifest line:

```xml
<entry name="Silver Keep">
Silver Keep (25tok)
A crumbling fortress on the northern ridge, now home to bandits and bad memories.
</entry>
```

### The writing AI (injected context)

When an entry is selected, the writing AI sees your **cleaned content** wrapped in the injection template (default: `<Title>content</Title>`). Several things are automatically stripped before injection:

```xml
<Valen Ashwick>
A disgraced spellsword who left the Ironveil Guild after discovering their
true purpose. Now works as a mercenary, haunted by the magic branded into
his blood.

[Species: Half-elf | Role: Spellsword, mercenary | Aliases: the Duskblade | ...]

## Background
Valen grew up on the Ashwick Estate, trained from childhood in both blade
and spell...

## Relationships
- Sera Thornwick -- Closest ally...
- Korrath -- Former Guild partner turned hunter...

## Combat Style
Valen fights with twin short swords and weaves shadow magic between strikes...
</Valen Ashwick>
```

Notice what changed compared to the raw Obsidian note:
- The **first H1 heading** (`# Valen Ashwick`) is stripped. It's redundant with the XML wrapper title.
- **Wikilinks** are converted to plain text: `[[Sera Thornwick]]` becomes `Sera Thornwick`, `[[Link|Display]]` becomes `Display`.
- **HTML div tags** are stripped (the content inside is kept, so meta-blocks still work).
- **Image embeds** (`![[image.png]]`, `![alt](url)`) are removed.
- **Obsidian comments** (`%%...%%`) are removed.

| What's included | What's NOT included |
|-----------------|---------------------|
| Everything after the frontmatter `---` | YAML frontmatter (`keys`, `priority`, `summary`, `requires`, etc.) |
| Full prose, meta-blocks, all headings except H1 | The first H1 heading (used as title in the XML wrapper) |
| Wikilink text (converted to plain text) | Wikilink brackets and image embeds |
| Content outside exclusion zones | `%%deeplore-exclude%%` regions (see [[Frontmatter Fields#hiding-content-from-the-writing-ai|Hiding content]]) |

The `summary` is for the selection AI. The content is for the writing AI. Two purposes, two surfaces. Write each accordingly. See [[Frontmatter Fields#writing-good-summaries|Writing good summaries]] for how to write summaries that actually help the selection AI.

## Tips

- **Start simple.** A tag and some keywords is enough. Add fields as you need them.
- **Keywords are case-insensitive by default.** "Valen", "valen", and "VALEN" all match. You can change this in [[Settings Reference]].
- **Use wikilinks.** When entry A links to entry B with `[[Entry B]]`, recursive scanning can pull in related entries automatically.
- **Test with Context Cartographer.** After generating a message, check what was injected and why. See [[Features]] for details.
- **Summaries are for the search AI, not the writing AI.** Don't put character descriptions in summaries. Put *when to select this entry* in summaries.
- **Priority matters for constants too.** Even always-send entries use priority to determine injection order.
- **Don't over-tag.** An entry only needs `#lorebook`. Add special tags (`#lorebook-always`, etc.) only when you specifically need that behavior.
- **Run `/dle-lint` after authoring.** Catches common frontmatter footguns (case-wrong field names, comma-string `keys`, quoted numerics, missing fences) at once.
