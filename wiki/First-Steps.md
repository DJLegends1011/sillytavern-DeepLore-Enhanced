# First steps

You've installed DeepLore and connected your vault ([[Quick Start]]). This page walks through building a useful starter vault, picking the right pipeline mode, and tuning matching for your workflow.

## Pick a pipeline mode

DLE has three modes. The setup wizard sets one for you; you can change it any time in **Settings → Matching**.

| Mode | How it works | Cost | Best for |
|------|--------------|------|----------|
| **Keywords only** | Scans recent chat messages for keywords from your entries | Free | Small vaults (under 50 entries), no AI provider configured |
| **Two-stage** | Keywords pre-filter, then AI search ranks the candidates against summaries | ~1 extra provider call per turn | The default. Medium and large vaults (50+ entries) |
| **AI only** | AI search reads the entire vault manifest each turn | Higher: full manifest tokens per call | Small vaults where you want context-only matching, no keywords needed |

Two-stage is the recommended default. Keyword-only is fine while you're learning the system; switch to two-stage once you have ~30+ entries and the keyword cast net starts missing things.

## Write your first entries

A useful starter vault has 3 to 5 entries covering the kinds of things your story leans on. Examples:

### A character entry

```yaml
---
tags: [lorebook]
keys: [Eris, the Spymaster]
priority: 20
summary: "Eris, the protagonist's spymaster and closest enforcer. Select when espionage, intelligence, interrogation, or loyalty comes up."
---
```

- **Priority 20** marks an inner-circle character (lower number = higher priority)
- Keys cover both the name and the role title

### A location entry

```yaml
---
tags: [lorebook]
keys: [The Crimson Den, tavern, underground bar]
priority: 50
summary: "An underground tavern serving as a neutral meeting ground. Select when taverns, drinking, underground dealings, or nightlife come up."
---
```

- **Priority 50** is the standard middle priority
- Keys cover both the proper name and generic terms that should trigger it

### A lore-concept entry

```yaml
---
tags: [lorebook]
keys: [bloodbond, blood bond, feeding dependency]
priority: 35
summary: "The biological dependency created when a vampire feeds from a mortal. Select when feeding, biting, addiction, or chattel dynamics come up."
---
```

- **Priority 35** for core worldbuilding
- Multiple keyword variants catch different phrasings

## Constants, bootstrap, and seed entries

Tag combinations control when entries fire:

- **Regular entries** (just the `lorebook` tag): inject only when keywords match (or when AI search picks them in two-stage mode)
- **Constants** (add `lorebook-always`): always inject on every generation. Use for core world rules, persistent character sheets, writing instructions
- **Bootstrap entries** (add `lorebook-bootstrap`): force-inject when chat is short (first few messages), then revert to regular matching once chat history grows
- **Seed entries** (add `lorebook-seed`): sent to AI search as story context on new chats, never injected into the writing AI

Keep constants minimal. Every constant spends context budget on every generation.

## Tune scan depth and budget

### Scan depth

How many recent chat messages DLE scans for keywords:

- **2 to 3:** matches recent conversation only. Responsive but narrow
- **4 to 6:** the default. Good balance
- **8 to 10:** broader matching, may pull in less relevant entries
- **0:** disables keyword scanning entirely. Use only with AI-only mode

### Token budget

Maximum tokens DLE can inject per generation:

- **1000 to 2000:** conservative, good for smaller contexts
- **3000 to 5000:** balanced, works for most setups
- **Unlimited:** DLE uses as much as it needs. Watch your overall context usage

Start with scan depth 4 and budget 3000, then adjust based on `/dle-inspect` output.

## Enable AI search

When you're ready to switch from keywords-only to two-stage:

1. Go to **Settings → Matching → Search Mode** and select **Two-Stage**
2. In **Settings → Connection → AI Connections**, select or create a SillyTavern Connection Manager profile for AI search, pointed at a fast, cheap model (Haiku, GPT-4o-mini, or any local model that handles structured output well)
3. Run `/dle-status`. It should show "AI search: enabled"

> [!NOTE]
> AI features use SillyTavern Connection Manager profiles. The old Custom Proxy mode was removed in v2.5 — if an old config still has it selected, the health check flags it and points you to pick a profile.

AI search earns its keep when your vault is large or entries have nuanced triggers that keywords can't capture. Example from the README: a scene about "the consequences of breaking an oath" pulls in your Bloodchain entry without the word "Bloodchain" appearing.

## Audit entry quality

Run `/dle-health` regularly. It checks for:

- Missing or empty keywords
- Duplicate keywords across entries
- Missing summaries (AI search needs them)
- Oversized entries (may dominate your budget)
- Broken wikilinks
- Configuration issues

Aim for grade A or A+.

## Verify what's injecting

Three diagnostics show what the pipeline picked:

1. **`/dle-inspect`:** shows the last pipeline trace. What matched, why, and what was injected
2. **Context Cartographer** (book icon on AI messages): shows the per-message source list with token counts
3. **`/dle-simulate`:** replays the entire chat showing which entries activate at each message

## Common early mistakes

| Mistake | Fix |
|---------|-----|
| Too many constants | Keep constants under 5 to 10. Use keywords for everything else |
| Keywords too generic | "the", "and", "said" match everything. Use specific terms |
| Keywords too specific | "Lord Vexathorn the Undying" won't match "Vexathorn". Add aliases |
| No summaries | AI search needs summaries to work. Write one for every entry |
| Oversized entries (5000+ tokens) | Split into smaller focused entries or use scan-depth overrides |
| Every entry at priority 50 | Use the full range: 20 (critical), 35 (core), 50 (standard), 60+ (flavor) |

## Next steps

- Read [[Features]] for the full feature reference
- Check [[AI Search]] for advanced AI configuration
- See [[Writing Vault Entries]] for the complete frontmatter reference
- Browse [[Slash Commands]] for every available command
- If something breaks, check [[Troubleshooting]]
