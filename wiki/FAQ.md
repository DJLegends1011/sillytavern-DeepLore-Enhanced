# Frequently asked questions

## General

### Do I need Obsidian?
Yes. DeepLore stores lore entries as markdown files in an Obsidian vault. You also need the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and enabled in Obsidian, so DeepLore can read your vault over HTTP or HTTPS.

### Do I need AI search? Can I just use keywords?
AI search is optional. Keyword-only mode matches entries by trigger keywords in the chat and never makes an AI call. Two-stage mode adds a second pass: an AI ranks the keyword matches against entry summaries and picks the best ones. Keyword-only is free; two-stage costs roughly one extra provider call per turn.

### What AI providers work with AI search?
Any provider SillyTavern's Connection Manager supports: Anthropic, OpenAI, OpenRouter, Google, Cohere, Mistral, DeepSeek, and local backends like Oobabooga, KoboldCpp, and llama.cpp. Create a Connection Manager profile and select it in AI Search settings. (The old "Custom Proxy" mode was removed in v2.5 — Connection Profiles are now the only path.)

### What model should I use for AI search?
A fast, cheap model. AI search reads compact entry summaries and picks which ones to inject; it does not generate creative text. **Claude Haiku** and **GPT-4o-mini** are good defaults. Cost runs to a fraction of a cent per message on Haiku-class models.

### How big can my vault be?
DeepLore has been tested on 200+ entry vaults and handles them well. Vaults with 40+ entries automatically use a hierarchical pre-filter: entries cluster by category, the AI picks relevant categories, then individual entries within them. Vaults of 1000+ entries work, with slower index builds.

### Does this cost money?
Only if you use AI search or a Librarian feature. Each generation in two-stage mode makes one AI search call (sometimes two for large vaults via the hierarchical pre-filter). On Haiku-class models, that runs to a fraction of a cent per message. Keyword-only mode is free. The sliding window cache reuses recent AI search results when only new chat messages are added, cutting calls further.

### Can I use this on mobile?
If SillyTavern runs on a remote server and you access it from a mobile browser, DeepLore works as long as Obsidian is reachable from the ST host (same machine, or accessible over the network). The most common setup is a desktop running both ST and Obsidian locally.

### What is the Librarian (Emma)?
Two linked things:
- **Generation tools.** While the writing AI generates, it can call `search` to look up vault entries the pipeline missed and `flag` to record gaps when the lore it needs is not in the vault. Tool activity collapses into one expandable dropdown on the final message.
- **Emma.** A separate chat agent. You open her from the drawer's Librarian tab, from `/dle-librarian`, or by clicking a flag. She helps you author a vault entry from a flagged gap, fetches `lorebook-guide` entries for style reference, finds similar entries to dedupe against, and writes the new file to Obsidian when you confirm.

The Librarian needs a tool-calling provider (Claude, Gemini, OpenAI-compatible, Cohere). Emma uses her own connection channel, separate from AI search.

> [!IMPORTANT]
> Turning on the Librarian auto-enables function calling on the active connection profile. If you disable function calling elsewhere, tool invocations break.

## Writing entries

### How do I make an entry a lorebook entry?
Add the lorebook tag to the note's frontmatter. The default tag is `lorebook`:

```yaml
---
tags:
  - lorebook
keys:
  - trigger keyword
  - another keyword
---
```

See [Writing Vault Entries](Writing-Vault-Entries) for the full guide.

### What is the difference between constants, seed entries, and bootstrap entries?
- **Constant** (tag: `lorebook-always`): always injected, every message, regardless of keyword matches. Use for critical world rules.
- **Seed entry** (tag: `lorebook-seed`): force-injected into the writing AI prompt, and prepended as story context in AI search on new chats. Helps the AI understand your world from the start.
- **Bootstrap entry** (tag: `lorebook-bootstrap`): force-injected during the first few messages of a new chat (configurable threshold), then becomes a regular keyword-triggered entry.

### What is a guide entry?
An entry tagged `lorebook-guide` is a Librarian-only writing or style reference. Emma fetches it via the `get_writing_guide` tool when she helps you author a new entry. Guide entries are indexed but never reach the writing AI through any injection path. If `lorebook-guide` and `lorebook-seed` or `lorebook-bootstrap` are both present, `guide` wins.

### How do summaries work? Do I need them?
The `summary` frontmatter field is used **only** in AI search. It tells the AI when to pick the entry. It is not injected into the writing AI's prompt; the entry's full content handles that. In keyword-only mode, summaries are unused. In two-stage mode, entries without a summary can still be selected but accuracy is significantly worse. Run `/dle-summarize` to auto-generate summaries for entries that are missing them. Summaries truncate to ~600 characters in the manifest by default (`aiSearchManifestSummaryLength`).

### Can I organize entries in folders?
Yes. DeepLore scans your entire vault recursively for notes with the lorebook tag. Folder structure does not affect matching. Folder paths can also be used as a per-chat filter via `/dle-set-folder` to scope a chat to one part of your vault.

## Troubleshooting

### My entries are not injecting
Run `/dle-health` first. It catches most problems. Common causes:
1. Missing lorebook tag on the entry.
2. Scan depth too low (keywords are not reaching far enough back in chat).
3. Token budget full (too many entries trying to inject).
4. Gating rules blocking the entry (requires/excludes/era/location/custom field).

See [Troubleshooting](Troubleshooting) for detailed diagnostics.

### The AI keeps picking the wrong entries
- Write better `summary` fields. Describe **when** to select the entry, not what it contains.
- Increase scan depth so AI search sees more chat context.
- Switch to two-stage mode if you were in AI-only. Keyword pre-filtering shrinks the candidate set the AI has to choose from.
- Run `/dle-inspect` after a generation to see what AI search received and what it selected.

### "Open in Obsidian" links are not working
The vault connection **Name** in DLE settings must match the Obsidian vault name exactly. If that is correct, restart Obsidian. The deep-link handler can become unresponsive after long sessions or updates. See [Troubleshooting / Deep Links](Troubleshooting#deep-links-open-in-obsidian) for full steps.

### How do I see what DeepLore injected?
Three ways:
1. **Context Cartographer.** Click the lore sources button on any AI message to see exactly what was injected, why, and at what token cost.
2. **`/dle-inspect`.** Shows the full pipeline trace from the last generation.
3. **The drawer.** The Injection tab shows injected entries in real time.

### Why is the Librarian not flagging anything?
Check that:
1. The Librarian is enabled (drawer Librarian tab shows status, or run `/dle-librarian`).
2. Your active connection supports tool calling (Claude, Gemini, OpenAI-compatible, Cohere). If function calling is disabled on the profile, the writing AI cannot call `flag`.
3. The writing AI is actually reaching for missing lore. If your scenes do not call for unwritten characters, places, or rules, there are no gaps to flag.

## vs. built-in World Info

### How is this different from SillyTavern's World Info?
SillyTavern's built-in World Info matches keywords from a JSON file. DeepLore reads from your Obsidian vault and adds:
- AI ranking that catches contextual relevance the keyword pass misses.
- Obsidian as your editor: backlinks, templates, graph view, your usual workflow.
- Multi-vault support for separating worlds or campaigns.
- Per-chat overrides: pin, block, contextual gating on era, location, scene, custom fields.
- Diagnostics: relationship graph, activation simulator, the live drawer.
- The Librarian: gap-flagging during generation and Emma for authoring entries from those gaps.

### Can I import my existing SillyTavern lorebooks?
Yes. Run `/dle-import` to convert World Info JSON exports into Obsidian vault notes with proper frontmatter. It handles standard WI exports, V2 character cards, and entry arrays. As of v2.5 the importer reads **every** WI field: most land natively (keys, secondary keys, `constant`, `order`→`priority`, `position`, `depth`, `probability`, `disable`, `role`, `excludeRecursion`, and all four `selectiveLogic` modes), and the rest round-trip into the vault as frontmatter so nothing is silently dropped. After import, DLE offers to AI-generate summaries for the new entries, reusing the `/dle-summarize` pipeline. See [[For World Info Users]] for the full field-by-field cheat sheet.

### Can I use both at the same time?
You can, but it is not recommended. Both systems inject lore into the prompt, so you pay double in token budget. To migrate, import your World Info with `/dle-import` and then disable the built-in World Info on entries DLE now owns.
