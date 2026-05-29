# Editable Prompts (v2.5)

Code-level internals for the editable-prompts subsystem. For user-facing docs see the wiki page (separate audience, written post-merge). For invariants and the delete cage see `docs/gotchas.md` #70.

## What it does

DLE ships **30** LLM-facing prompts as compiled-in string constants in `src/i18n/prompts/{locale}.js`. The editable-prompts feature lets users override any of them with MD files inside their Obsidian vault. Runtime reads vault file → falls back to compiled-in dict at the user's chosen `aiPromptLocale`.

The 30 keys are everything `en.js` exports except `__meta` (`KNOWN_PROMPT_KEYS = Object.keys(PromptsEn).filter(k => k !== '__meta' && k !== 'default')`, `prompt-validators.js:37-39`). They split into two groups via `classifyPromptKey()` (`src/ui/prompts-tab.js:214-218` — substantive iff key does NOT start with `AGENTIC_`, **except** `AGENTIC_ROLE_SECTION` which is forced substantive):
- **Substantive (12)** — the 3 `EMMA_*_GREETING` keys, `LIBRARIAN_PRIMER`, `LIBRARIAN_FIRSTRUN_QA_SCRIPT`, `AGENTIC_ROLE_SECTION`, `AI_SEARCH_SYSTEM_PROMPT`, `AI_NOTEPAD_PROMPT`, `SCRIBE_PROMPT`, `AUTO_SUGGEST_PROMPT`, `OPTIMIZE_KEYS_PROMPT`, `SUMMARIZE_PROMPT`. Multi-line prose, real tuning surface.
- **Agentic fragments (18)** — `AGENTIC_FENCE_*` headers (7), `AGENTIC_TOOL_*` descriptions (4), `AGENTIC_TOOLS_INTRO`, `AGENTIC_WORKFLOW*` step labels (5), `AGENTIC_IMPORTANT_FINAL`. Short, structural. Collapsible by default in the UI. (`AGENTIC_ROLE_SECTION` is the lone `AGENTIC_*` key NOT counted here.)

> Counts verified 2026-05-28 via `Object.keys(PromptsEn)` against `en.js`: 30 keys, 12 substantive, 18 fragments. The grid headings render these counts live (`prompts-tab.js:263,268`).

## File layout

```
src/prompts/
├── deprecated-keys.js       — Allowlist for keys removed in later versions
├── prompt-validators.js     — L1+L2 of the delete cage (pure, no I/O)
├── prompt-store-pure.js     — Pure helpers: parse, validate (R1+R2+R3), status, hash, normalize, buildOverlay
├── prompt-store.js          — Runtime cache + getPrompt() + resolvePromptOrOverride() + boot loader
└── prompt-api.js            — Obsidian REST helpers + DLE_DELETE_PRIMITIVE (L3-L6)

src/ui/prompts-tab.js        — Settings popup Prompts tab (handlers, status grid, bulk-delete)

src/i18n/prompts/{locale}.js — Canonical prompt dicts (en is canonical; 6 machine-translated)

test/prompts-delete-safety.test.mjs — 225 assertions for the cage
test/prompts-store.test.mjs         — 269 assertions for resolver + overlay + status
test/prompts-api.test.mjs           — 40 assertions for L4 pure + L6 structural
```

`verifyPromptFileForDeletion(rawContent, validatedStem)` is a thin wrapper over `validatePromptShape(parsed, null, validatedStem)` — same R1+R2 rules, R3 (placeholder parity) skipped because the delete-cage path doesn't trust the runtime cache.

## Vault file format

```markdown
---
key: SCRIBE_PROMPT
locale: en
source_hash: 251_abc_def
placeholders: |
  ${0} = tool count (number)
  ${1} = plural suffix ("" or "s")
---

Summarize this roleplay session segment. Write in past tense, third person.

Cover:
- Key events and plot developments...
```

Frontmatter fields:
- `key` — must match the filename stem and a known prompt key. Verified at boot (R1) and at delete pre-flight (L4).
- `locale` — author stamp. Not enforced at read time; the runtime resolver uses the user's `aiPromptLocale` setting, not this field.
- `source_hash` — hash of the dict value at export time. Powers stale-default detection.
- `placeholders` — advisory block scalar. The validator extracts actual `${N}` markers from the body, not this field.

`buildPromptFileContent()` in `prompt-store-pure.js` serializes; `parsePromptFile()` reverses. Round-trip test in `test/prompts-store.test.mjs` confirms byte-equivalence for every canonical key.

## Resolution flow

```
getPrompt(key)             // sync, called inside agentic loops + fence builders
  → promptCache.get(key)   // populated at boot
    → fallback: PromptsEn[key]
    → fallback: '' + console.warn
```

`loadPrompts(locale, connection)` builds the cache:

```
loadPrompts(locale, connection?)
  → getAiPromptDictForLocale(locale)  // canonical: { dict, resolvedLocale }, EN fallback
  → if connection:
      → listPromptsFolder()           // REST: GET /vault/<prefix>/
      → Promise.all(fetchPromptFile)  // REST: GET /vault/<prefix>/<stem>.md, in parallel
  → buildPromptOverlay(localeDict, overrides, KNOWN_KEYS, EnDict)
      → per key: parse → validate → success uses vault body; failure falls back + records error
  → promptCache.clear() / .set()
  → return { loaded, source, vaultCount, errors, vaultListPartial }
```

Per-file fetches run via `Promise.all` so cold boot doesn't serialize ~30 independent GETs. The `obsidianFetch` circuit breaker is shared by host:port — concurrent failures still trip it together.

`reloadPrompts()` re-runs `loadPrompts()` with the saved locale and connection. UI exposes this as the "Reload prompts" button.

`resolvePromptOrOverride(key, userOverride)` is the canonical "user override → vault override → compiled-in" ladder, used by every AI caller that still honors a legacy user-prompt setting (`scribePrompt`, `aiSearchSystemPrompt`, `autoSuggestPrompt`, `optimizeKeysPrompt`, `summarySystemPrompt`, `aiNotepadPrompt`).

## Status state machine

Q11 A+. See `docs/gotchas.md` #70 for the 4-state table.

Hash computation uses `simpleHash` from `core/utils.js` (not cryptographic; just stable). Both sides of every comparison go through `normalizePromptBody()` first — strips the leading blank line and trailing whitespace that `buildPromptFileContent()` adds via its shim. Without normalization, a freshly exported file would immediately register as `customized` purely from formatting.

## Settings UI

**Prompts tab** (between Features and System; commit 5):
- Language dropdown writes `aiPromptLocale`. Change triggers confirm-and-overwrite-all if vault overrides exist (Q3).
- Folder path field writes `promptsFolderPath`. Sanitized through `sanitizePromptsFolderPath()` on change; reverts to default with toastr warning if input is unsafe.
- **Export Prompts to Vault** — writes all 30 prompts (`exportAllPrompts()` iterates `KNOWN_PROMPT_KEYS`, `prompts-tab.js:110-129`) via `writePromptFile()`. Confirms before clobbering existing overrides. The status line shows the live count (`Exporting ${KNOWN_PROMPT_KEYS.size} prompts…`, `prompts-tab.js:475`).
- **Reload Prompts** — re-runs `loadPrompts()` to pick up vault edits.
- **Reset All Prompts** — iterates `KNOWN_PROMPT_KEYS` through `deletePromptFile()`. Every delete passes the six-layer cage.
- **Status grid** (commit 6) — per-row source, status badge, error indicator, action buttons. Substantive prompts shown by default; agentic fragments in a collapsible `<details>`.

Per-row actions:
- compiled-in → **Export this one** (write canonical → file)
- vault + `stale_default` → **Update** (rewrite with current canonical) + **Revert**
- vault + other → **Revert** (delete file)

**Reset all settings** (commit 14): if vault overrides exist, a second confirm asks whether to delete them too. Same cage path as Reset All Prompts. Otherwise vault files survive a settings reset by design (user-owned data, like vault entries).

## Boot integration

`index.js` init:
```js
loadSettingsUI();
bindSettingsEvents(buildIndex);
registerSlashCommands();
setupSyncPolling(buildIndex, buildIndexWithReuse);

// Boot-time prompt cache load. One-liner — wiring lives in prompt-store.
await loadPromptsForBoot(getSettings());
```

`loadPromptsForBoot(settings)` (in `prompt-store.js`) builds the connection from `buildPromptsConnectionFromSettings`, calls `loadPrompts`, and swallows failures. Without a connection, the cache holds only compiled-in dict — runtime is byte-identical to pre-feature behavior.

`buildPromptsConnectionFromSettings(settings)` is the canonical connection-shape helper. The Settings popup's `buildPromptsConnection(settings)` (in `prompts-tab.js`) is a thin UI wrapper that calls `getPrimaryVault` first so it can honor the legacy "primary or default" selection rule; both ultimately produce the same `{ host, port, apiKey, prefix, useHttps }` shape.

## Migration

The 18 inline `AGENTIC_*` fragments + the substantive defaults previously held copies of these strings in:
- `src/librarian/librarian-prompts.js` (Emma greetings + primer + QA script)
- `src/librarian/agentic-messages.js` (agentic loop role/fence/tool/workflow fragments)
- `src/ai/ai.js` + `src/ui/settings-ui.js` (AI search system prompt fallback)
- `index.js` + `src/librarian/agentic-messages.js` (AI Notepad fallback)
- `src/ai/scribe.js` (Scribe summarizer fallback)
- `src/ai/auto-suggest.js` (Auto-Suggest fallback)
- `src/ui/popups.js` (Optimize Keys fallback)
- `src/ai/summarize.js` (`/dle-summarize-range` fallback)

All call sites now resolve through `resolvePromptOrOverride(KEY, userOverride)` (for keys with a legacy user-prompt setting) or `getPrompt(KEY)` (for keys without). The `DEFAULT_*_PROMPT` consts were removed from `settings.js` and feature modules.

The only difference between the inline strings and the EN dict values was CRLF (Windows) vs LF line endings — semantically identical for LLMs.

## See also

- `docs/gotchas.md` #70 — cage layers, structural test, placeholder contract, status machine
- `docs/state-and-lifecycle.md` — Editable Prompts State table, boot order
- `src/i18n/prompts/en.js` — canonical EN dict, single source of truth for the key list
