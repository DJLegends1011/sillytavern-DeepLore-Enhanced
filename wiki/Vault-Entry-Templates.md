# Vault Entry Templates

Every template below is a complete Obsidian note. Copy it into a new file, change the values, and you're done. For what each field means see [[Frontmatter Fields]]; for the gating concepts (requires/excludes, cooldown, refine keys, etc.) see [[Advanced Entry Gating]]. New to authoring? Start at [[Writing Vault Entries]].

---

## 1. Minimum viable entry

The simplest possible entry: a tag, a keyword, and some content.

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

That's a valid entry. When "Silver Keep" appears in chat, this content gets injected.

---

## 2. Character

A full character entry with all commonly used fields.

```markdown
---
# -- Required --
tags:
  - lorebook
keys:
  - Valen
  - Valen Ashwick
  - the Duskblade

# -- Recommended --
priority: 35
summary: "Rogue spellsword and former member of the Ironveil Guild. Select when melee combat, dual-wielding, shadow magic, guild politics, or the Ashwick bloodline comes up. Close ally of Sera and rival of Korrath."

# -- Optional --
requires: []
excludes: []
---

# Valen Ashwick

A disgraced spellsword who left the [[Ironveil Guild]] after discovering their true purpose. Now works as a mercenary, haunted by the magic branded into his blood.

<div class="meta-block">
[Species: Half-elf | Role: Spellsword, mercenary | Aliases: the Duskblade | Height: 6'1" | Build: Lean, athletic | Hair: Black, shoulder-length | Eyes: Amber with faint glow | Skin: Olive, scarred forearms | Features: Guild brand on left wrist (burned but visible) | Apparent Age: Late 20s | True Age: 34 | Origin: Ashwick Estate, Greymarch | Personality: Guarded, sardonic, fiercely loyal once earned | Speech: Clipped, dry humor, avoids titles | Wants: Clear his family name | Fears: Becoming what the Guild made him | Powers: Shadow-step (short-range teleport), blade enhancement | Limits: Shadow magic drains stamina rapidly, useless in bright light | Items: Twin short swords (Dusk and Dawn), enchanted leather coat | Secret: The Guild brand slowly turns its bearers into living weapons]
</div>

## Background

Valen grew up on the [[Ashwick Estate]], trained from childhood in both blade and spell. He joined the [[Ironveil Guild]] at 19, believing them to be an elite mercenary company. He discovered they were binding members' souls to fuel a collective weapon -- the brand on his wrist is the first stage.

He deserted five years ago. The Guild wants him back, dead or alive.

## Relationships

- **[[Sera Thornwick]]** -- Closest ally. She helped him escape the Guild. He trusts her completely.
- **[[Korrath]]** -- Former Guild partner turned hunter. Korrath took the brand willingly and considers Valen a traitor.
- **[[Ironveil Guild]]** -- His former organization. They send hunters after him periodically.

## Combat Style

Valen fights with twin short swords and weaves shadow magic between strikes. He can shadow-step behind opponents but each use costs significant stamina. In prolonged fights, he relies increasingly on pure swordwork.
```

---

## 3. Location

A tavern, dungeon, city, or any place.

```markdown
---
tags:
  - lorebook
keys:
  - The Drowned Lantern
  - Drowned Lantern
  - the tavern

priority: 50
summary: "Underground tavern in the Docks district, neutral ground for criminals and adventurers. Select when characters are drinking, meeting contacts, gathering rumors, or visiting the Docks. Owned by Maren Blacktide."
---

# The Drowned Lantern

A half-sunken tavern built into the old sea wall of the Docks district. The lower floor floods at high tide, which the regulars consider a feature, not a bug.

<div class="meta-block">
[Category: Tavern | Owner: [[Maren Blacktide]] | District: The Docks | Access: Public, but newcomers get watched | Atmosphere: Smoky, damp, lantern-lit, loud at night | Function: Neutral meeting ground, black market contacts | Layout: Upper bar (dry), lower bar (floods at high tide), back rooms for private deals | Rules: No killing inside, disputes settled by Maren | Security: Two bouncers, Maren herself, and a rumored sea creature in the flooded basement | Regulars: Smugglers, off-duty guards, bounty hunters, [[Valen Ashwick]]]
</div>

## Description

The entrance is a rusted iron door set into the sea wall, marked only by a lantern wrapped in green glass. Steps lead down into a long, vaulted room that smells of brine and pipe smoke. The upper bar sits on a stone platform; the lower bar is three steps down and ankle-deep in seawater during high tide.

Maren keeps the peace with an iron voice and the threat of whatever lives beneath the floorboards. Fights happen outside or not at all.

## Notable Features

- **The Tide Table** -- A large round table on the lower level, partially submerged. Sitting there is a signal that you're open for business.
- **Back rooms** -- Three private rooms behind the bar. Maren charges by the hour and doesn't ask questions.
- **The basement** -- Flooded, locked, off-limits. Something moves down there. Maren feeds it.
```

---

## 4. Lore / world-building concept

For magic systems, political structures, historical events, or any world-building concept.

```markdown
---
tags:
  - lorebook
keys:
  - soulbrand
  - soul brand
  - branded
  - Guild brand

priority: 35
summary: "Magical branding ritual used by the Ironveil Guild to bind members' souls into a collective weapon. Select when the Guild, magical binding, soul magic, Valen's brand, or forced servitude comes up. Core lore for Guild-related plotlines."
---

# The Soulbrand

A ritual binding developed by the [[Ironveil Guild]] that permanently links a person's soul to the Guild's collective power. The brand manifests as a black sigil on the wrist that pulses faintly in the presence of other branded members.

<div class="meta-block">
[Category: Ritual magic | Scope: Ironveil Guild members only | Danger: Lethal if removed improperly, progressive loss of autonomy | Who Knows: Guild leadership, branded members (partially), [[Valen Ashwick]] (fully) | Triggers: Proximity to other branded, extreme emotion, Guild commands | Consequences: Gradual erosion of free will at advanced stages, eventual transformation into a living weapon | Related: [[Ironveil Guild]], [[Valen Ashwick]], [[Korrath]] | Enforcement: Guild hunters track and reclaim deserters | Misconceptions: New recruits believe it's a loyalty tattoo and standard Guild tradition]
</div>

## How It Works

The brand is applied during an initiation ritual disguised as a loyalty oath. The recruit feels a burning pain and gains a faint sense of other branded members -- presented as "Guild bond." In reality, the brand siphons a small amount of soul energy continuously.

**Stage 1 (Years 1-3):** Awareness of other branded. Minor combat enhancement. No obvious downsides.
**Stage 2 (Years 3-7):** Compulsion to obey senior branded. Difficulty acting against Guild interests. Enhanced reflexes.
**Stage 3 (Years 7+):** Near-total obedience. Significant combat power. The branded becomes a weapon the Guild can activate remotely.

## Removal

No safe removal method is known. [[Valen Ashwick]] burned his brand with alchemical fire, which stopped the progression but left the sigil scarred into his skin. He still feels the pull of other branded at close range.
```

---

## 5. Organization

A guild, faction, council, or any organized group.

```markdown
---
tags:
  - lorebook
keys:
  - Ironveil Guild
  - the Guild
  - Ironveil

priority: 40
summary: "Elite mercenary company that secretly binds members' souls via the Soulbrand ritual. Select when mercenary contracts, guild politics, soul magic, Valen's past, or organized military forces come up. Antagonist faction."
---

# The Ironveil Guild

A prestigious mercenary company operating across the northern territories. Publicly, they're known for discipline, reliability, and high rates. Privately, they are building an army of soul-bound soldiers.

<div class="meta-block">
[Category: Mercenary company / secret military order | Owner: The Iron Council (three unknown figures) | Run By: Guildmaster [[Torven Kael]] | Public Face: Elite mercenaries for hire | True Purpose: Building a soul-bound army via the [[Soulbrand]] | Visibility: Well-known publicly, true purpose hidden | Scope: Northern territories, expanding south | Staff: ~200 active members, ~40 fully branded | Key People: [[Torven Kael]] (Guildmaster), [[Korrath]] (Chief Hunter), [[Valen Ashwick]] (deserter) | Value: Military contracts, political influence, growing soul-bound force | Vulnerabilities: Deserters who know the truth, the Soulbrand's instability at Stage 3]
</div>

## Structure

The Guild operates from a fortress called the Iron Bastion. Recruits train for six months before initiation (when the [[Soulbrand]] is applied). They're organized into cells of four, each led by a branded senior. The cells take contracts independently but answer to the Guildmaster.

## Public Reputation

The Guild is respected. They complete contracts reliably, don't betray employers, and keep collateral damage low. Most people consider a Guild contract expensive but worth it. No one outside suspects the Soulbrand.

## The Hunt

Deserters are the Guild's greatest liability. [[Korrath]] leads a dedicated team of hunters who track down anyone who leaves. Most deserters are brought back and pushed to Stage 3 as punishment. [[Valen Ashwick]] has evaded them for five years -- an embarrassment the Guild takes personally.
```

---

## 6. Story / plot arc

For plot events, story arcs, or narrative beats.

```markdown
---
tags:
  - lorebook
keys:
  - Ashwick conspiracy
  - Guild conspiracy
  - the truth about the Guild

priority: 45
summary: "Ongoing plot arc about Valen uncovering the full scope of the Ironveil Guild's Soulbrand program. Select when investigation, conspiracy, exposing secrets, or confronting the Guild comes up. Central story arc."
---

# The Ashwick Conspiracy

The central storyline following [[Valen Ashwick]]'s quest to expose the [[Ironveil Guild]]'s [[Soulbrand]] program and free those already branded.

## Current State

Valen knows the Soulbrand exists and how it progresses, but not how to safely remove it or who sits on the Iron Council. He's gathering allies and information while staying ahead of Guild hunters.

## Key Threads

- **The Iron Council** -- Who are the three leaders? Valen has no leads yet.
- **Safe removal** -- Is there a way to remove the brand without killing the host? The [[Arcanist's Archive]] may hold answers.
- **[[Korrath]]** -- Can he be turned, or is he too far gone at Stage 2?
- **Sera's secret** -- [[Sera Thornwick]] helped Valen escape but has never explained why she knew about the brand.

## Possible Escalation

If the Guild completes its army, they could challenge the northern lords directly. Valen estimates they need 100 Stage 3 soldiers -- they have about 40 and are accelerating recruitment.
```

---

## 7. Always-send (constant) entry

This entry is **always injected**, regardless of keywords or AI search. Use this for core world rules or setting context that should always be present.

```markdown
---
tags:
  - lorebook
  - lorebook-always

# Priority matters even for constants -- it controls injection order
priority: 10
---

# World Rules

This story is set in Greymarch, a low-fantasy setting where magic exists but is rare, feared, and poorly understood.

**Core rules:**
- Magic has a physical cost. Every spell drains the caster's stamina, health, or lifespan.
- There are no "good" or "evil" factions. Every group believes they're right.
- Death is permanent. There is no resurrection magic.
- The gods are silent. Whether they exist is debated. No divine intervention occurs.
```

Constants don't need `keys` or `summary` since they're always injected. You can still add them if you want the entry to also appear in AI search manifests. See also [Constant via frontmatter](#15-constant-via-frontmatter) below for the `constant: true` alternative.

---

## 8. Seed entry

Seed entries provide story context to the **AI search model** at the start of new chats. They help the AI understand your setting so it can make better selection decisions. Seed content is **not** injected into the writing AI.

```markdown
---
tags:
  - lorebook
  - lorebook-seed
keys:
  - Greymarch
  - the setting

priority: 15
summary: "Core setting overview for the Greymarch campaign. Seed entry -- provides context to AI search on new chats."
---

# Greymarch Setting Overview

Greymarch is a northern territory of crumbling fortresses, dense forests, and coastal cities built on trade and old grudges. Magic is rare and feared. The [[Ironveil Guild]] is the dominant military force. The noble houses are fractured and paranoid.

The story follows [[Valen Ashwick]], a deserter from the Guild who discovered they're building a soul-bound army. He's gathering allies -- [[Sera Thornwick]], information broker; and whoever he can trust -- to expose the conspiracy before the Guild's army is complete.

Key factions: [[Ironveil Guild]] (antagonist), the Northern Lords (fractured, unaware), the [[Arcanist's Archive]] (neutral scholars), and various independent operators in the [[The Drowned Lantern|Docks district]].
```

---

## 9. Bootstrap entry

Bootstrap entries are **force-injected when the chat is short** (at or below the new chat threshold, default 3 messages). After that, they become regular keyword entries. Use this for context that's essential in early messages but not needed once the conversation is established.

```markdown
---
tags:
  - lorebook
  - lorebook-bootstrap
keys:
  - Valen
  - Ashwick

priority: 20
summary: "Protagonist quick-reference. Bootstrap entry -- force-injected at chat start, then becomes keyword entry."
---

# Valen Ashwick - Quick Reference

Valen Ashwick is the protagonist. He's a half-elf spellsword, mid-30s, sardonic and guarded. He deserted the [[Ironveil Guild]] five years ago after discovering the [[Soulbrand]] program. He fights with twin short swords and shadow magic.

**Current situation:** On the run from Guild hunters. Working as a mercenary out of the [[The Drowned Lantern|Docks district]]. Trusts [[Sera Thornwick]] and almost no one else.

**Voice:** Dry humor, avoids titles, speaks in short sentences when tense. Opens up slightly around people he trusts.
```

---

## 10. Conditional gating (requires / excludes)

Use `requires` to make an entry activate only when other specific entries are also matched. Use `excludes` to block an entry when certain entries are present. See [[Advanced Entry Gating]] for the full behavior.

```markdown
---
tags:
  - lorebook
keys:
  - Valen's scar
  - brand scar
  - wrist scar

priority: 50

# This entry only activates if BOTH Valen Ashwick AND The Soulbrand
# are also matched in the same generation.
requires:
  - Valen Ashwick
  - The Soulbrand

# This entry is blocked if the following entry is matched.
# Useful for mutually exclusive states or spoiler prevention.
excludes:
  - Brand Removed

summary: "Description of Valen's burned Soulbrand scar. Only relevant when both Valen and the Soulbrand are being discussed. Select when the scar is examined, the brand's residual effects, or Valen's past with the Guild comes up."
---

# Valen's Brand Scar

The scar on Valen's left wrist is a raised, blackened sigil -- the remains of his [[Soulbrand]], burned away with alchemical fire. It still aches in the presence of branded Guild members, and faintly pulses when he uses shadow magic.

He keeps it wrapped in leather. When asked, he says it's a burn from a forge accident. [[Sera Thornwick]] is one of the few who's seen it unwrapped.
```

---

## 11. Per-entry injection override

Override where and how this specific entry is injected, regardless of global settings. See [[Settings Reference]] for the global defaults and [[Injection and Context Control]] for how positions work.

```markdown
---
tags:
  - lorebook
keys:
  - inner thoughts
  - Valen thinks
  - internal monologue

priority: 25

# Override injection position for this entry only.
# "before" = before the main prompt
# "after" = after the main prompt
# "in_chat" = inserted between chat messages at the specified depth
position: in_chat

# How many messages from the bottom to inject (only used with in_chat).
# depth: 1 = just before the last message, 2 = before the second-to-last, etc.
depth: 1

# What role the injected message appears as.
# "system" = system message (invisible to the "characters")
# "user" = appears as a user message
# "assistant" = appears as an assistant message
role: system

summary: "Valen's internal monologue style guide. Select when the scene is introspective, emotionally charged, or involves difficult decisions."
---

# Valen's Inner Voice

When writing Valen's internal thoughts, follow these guidelines:

- Short, fragmented sentences when stressed ("Not again. Not here. Move.")
- Longer, more reflective prose when safe or alone
- He mentally argues with himself, sometimes addressing his past self
- He suppresses emotion by cataloguing his surroundings ("Three exits. Two armed. The barkeep's reaching under the counter.")
- Genuine vulnerability only surfaces around [[Sera Thornwick]], and even then, reluctantly
```

---

## 12. Cooldown and warmup

**Cooldown** prevents an entry from triggering again for N generations after it fires. **Warmup** requires a keyword to appear N or more times total in the scan text before the entry triggers. See [[Advanced Entry Gating]] for details.

```markdown
---
tags:
  - lorebook
keys:
  - weather
  - rain
  - storm
  - fog

priority: 70

# After this entry triggers, skip it for the next 5 generations.
# Prevents atmospheric descriptions from repeating too often.
cooldown: 5

# The keyword must appear at least 2 times total in the scan text
# before this entry triggers. Prevents one-off mentions from pulling
# in the entry.
warmup: 2

summary: "Greymarch weather patterns and atmospheric descriptions. Select when weather, climate, travel conditions, or outdoor scenes come up. Low priority flavor entry."
---

# Greymarch Weather

The northern coast of Greymarch is defined by its weather. Fog rolls in from the sea most mornings, burning off by midday only to return at dusk. Rain is frequent -- not the dramatic downpours of the south, but a persistent, cold drizzle that soaks through everything.

**Seasonal patterns:**
- **Spring:** Dense fog, intermittent rain, muddy roads
- **Summer:** Brief and mild. The only reliable sunshine. Fog lifts by mid-morning.
- **Autumn:** Storms off the coast. Heavy wind. Ships avoid the harbor.
- **Winter:** Bitter cold, sleet, occasional snow. The Docks district floods regularly.

Locals don't comment on the weather unless it's unusually clear. Sunshine is suspicious.
```

---

## 13. Refine keys (secondary keyword filter)

`refine_keys` adds a secondary filter on top of primary keywords. By default (`selective_logic: and_any`), a primary `keys` match alone isn't enough: at least one refine key must **also** appear in the scan text. This reduces false positives for entries with common keywords. See [[Advanced Entry Gating]] for the other `selective_logic` modes.

```markdown
---
tags:
  - lorebook
keys:
  - Ironveil Guild
  - the Guild
  - Ironveil

# Primary keys match broadly. Refine keys ensure the conversation
# is actually about Guild *operations*, not just a passing mention.
refine_keys:
  - contract
  - mission
  - recruitment
  - branded
  - cell
  - hunters

priority: 40
summary: "Ironveil Guild operational details. Select when Guild missions, contracts, cell structure, or hunter operations come up."
---

# Ironveil Guild Operations

Detailed operational procedures for the Guild...
```

**How it works:** if "the Guild" appears in chat (primary match), the entry only triggers when at least one of `contract`, `mission`, `recruitment`, etc. also appears. Without refine keys, every mention of "the Guild" would pull this entry in.

---

## 14. Cascade links (auto-pull related entries)

`cascade_links` automatically pulls in other entries when the parent entry matches. No keyword check needed for the linked entries. Unlike wikilink recursion (which scans for keywords), cascade links are unconditional. See [[Advanced Entry Gating]].

```markdown
---
tags:
  - lorebook
keys:
  - Soulbrand
  - soul brand
  - branded

priority: 35

# When the Soulbrand entry matches, automatically pull in
# the removal procedure entry too -- they're always relevant together.
cascade_links: ["Soulbrand Removal", "Ironveil Guild"]

summary: "Magical branding ritual used by the Ironveil Guild. Select when the brand, soul magic, or forced servitude comes up."
---

# The Soulbrand

A ritual binding developed by the [[Ironveil Guild]]...
```

**Use cases:**
- Lore mechanics that always travel together (e.g., a blood bond entry cascading to the feeding mechanics entry)
- Locations with sub-locations (e.g., a fortress cascading to its dungeon and armory)
- Characters with dedicated lore entries (e.g., a character cascading to their unique ability entry)

---

## 15. Constant via frontmatter

Beyond the `#lorebook-always` tag, you can make an entry constant by setting `constant: true` in frontmatter. Both methods are equivalent.

```markdown
---
tags:
  - lorebook

# This entry is always injected, same as adding the lorebook-always tag.
constant: true
priority: 10
---

# World Rules

Core rules that should always be present in context...
```

**When to use which:**
- `#lorebook-always` tag: quick, visible at a glance in Obsidian's tag system
- `constant: true` field: useful when you want to keep the tags array clean or when programmatically managing entries

---

## 16. Contextual gating

Use `era`, `location`, `scene_type`, and `character_present` fields to control when an entry injects based on the current story context. Set the active context with `/dle-set-era`, `/dle-set-location`, `/dle-set-scene`, `/dle-set-characters`, or use the generic `/dle-set-field <name> [value]` command. See [[Custom Fields]] for the full schema and [[Advanced Entry Gating]] for behavior.

```markdown
---
tags:
  - lorebook
keys:
  - Docks smuggling
  - smuggler routes
  - contraband

priority: 50

# This entry only injects when:
# - The active era is "pre-war" (set via /dle-set-era pre-war)
# - The active location is "The Docks" (set via /dle-set-location The Docks)
# - The active scene type is "investigation"
# - Maren Blacktide is among the present characters
era: pre-war
location: The Docks
scene_type: investigation
character_present:
  - Maren Blacktide

summary: "Smuggling routes and contraband network in the Docks district during the pre-war era. Select when smuggling, black market, or Maren's operations come up."
---

# Docks Smuggling Network

The Docks district has been the center of Greymarch's smuggling operations for decades. [[Maren Blacktide]] controls the primary routes...
```

---

## 17. Outlet (macro-based injection)

Use the `outlet` field to inject an entry wherever you place the `{{outlet::name}}` macro instead of using positional injection. Useful for recurring lore that should appear at a specific spot in a system prompt or character card. See [[Advanced Entry Gating]].

```markdown
---
tags:
  - lorebook
keys:
  - house rules

priority: 20
outlet: house_rules
summary: "Table rules block. Injected wherever {{outlet::house_rules}} appears in the prompt."
---

# House Rules

- No metagaming.
- One swipe, then commit.
- Players narrate their own thoughts; the GM narrates the world.
```

Place `{{outlet::house_rules}}` in your system prompt, character card, or any prompt-list slot, and DLE substitutes the entry's cleaned content at that point. Outlet entries skip the normal positional injection.

---

Next: [[Frontmatter Fields]] · [[Advanced Entry Gating]] · back to [[Writing Vault Entries]]
