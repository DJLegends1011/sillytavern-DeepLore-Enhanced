# DeepLore Core

Shared utility modules used across DeepLore.

## Module Responsibilities

- **pipeline.js** — Parses raw vault files (frontmatter + markdown) into `VaultEntry` objects. Owns the VaultEntry/TagConfig typedefs.
- **matching.js** — Filters entries against chat text using keyword matching, gating rules, link resolution, and budget-aware formatting.
- **sync.js** — Detects vault changes by comparing index snapshots (added/removed/modified entries).
- **utils.js** — Shared parsing, escaping, text manipulation, and validation utilities used across the codebase.

## Exports

| File | Contents |
|------|----------|
| `utils.js` | parseFrontmatter, extractWikiLinks, cleanContent, extractTitle, truncateToSentence, simpleHash, escapeRegex, escapeXml, yamlEscape, buildScanText, buildAiChatContext, validateSettings, NO_ENTRIES_MSG, classifyError |
| `matching.js` | testEntryMatch, testPrimaryMatchOnly, countKeywordOccurrences, applyGating, resolveLinks, formatAndGroup, clearScanTextCache |
| `pipeline.js` | VaultEntry/TagConfig typedefs, parseVaultFile, clearPrompts |
| `sync.js` | takeIndexSnapshot, detectChanges |
