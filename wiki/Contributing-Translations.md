# Contributing Translations

DeepLore ships UI strings and AI prompts in 7 languages. **English (`en`) is the canonical source.** The other six — Spanish (`es-es`), French (`fr-fr`), German (`de-de`), Japanese (`ja-jp`), Simplified Chinese (`zh-cn`), Russian (`ru-ru`) — are machine-translated by Claude Opus (95.8-97.3% UI coverage per locale, 100% AI-prompt coverage), then refined by the community.

> **Help wanted.** If you're a native or fluent speaker of any of the six target languages, your refinements make DLE feel like home for thousands of users. No coding required — just edit JSON or JavaScript and open a PR.

---

## What's Translated

Two files per locale:

| Path | What's in it | Format |
|---|---|---|
| `locales/dle.{lang}.json` | UI strings: buttons, labels, tooltips, toasts, popups, slash-command help, drawer text, settings | JSON key-value (~2250 keys) |
| `src/i18n/prompts/{lang}.js` | LLM-facing prompts: Librarian (Emma), AI search, Scribe, Auto-Suggest, Optimize Keys, Notepad, Summarize | JavaScript exports |

**What's NOT translated:**
- Vault entry content (user's own files in Obsidian — your language)
- Code, log output, error stack traces (developer-facing)
- Identifiers, settings keys, file paths (must match across locales)

---

## How to Refine a Translation

### Quick path (UI string)

1. Open `locales/dle.{your-lang}.json` on GitHub (or fork + clone).
2. Find a key whose translation feels off. Adjust the value. **Leave the key name verbatim.**
3. Save the file, commit, open a PR.

That's it. Even one improved string helps.

### Quick path (AI prompt)

1. Open `src/i18n/prompts/{your-lang}.js`.
2. Edit any `export const NAME = "..."` value.
3. **Keep all `${0}`, `${1}` placeholders verbatim** — they're substituted at runtime with dynamic values like character names or counts.
4. **Keep `{{maxEntries}}` and other `{{...}}` tokens verbatim** — same reason.
5. **Keep HTML tags verbatim** — `<dle-notes>`, `<dle_*_NONCE>`, `<entry>`, etc.

### What "right" looks like

- **Tone matches English source.** Terse English → terse translation. Friendly English → friendly translation.
- **Length is similar.** Don't pad. Don't over-shorten. UI space is tight.
- **Tech terms stay readable.** "lorebook", "vault", "prompt", "AI" can stay in English if that reads more naturally for your audience than a forced native word — but use established translations where they exist.
- **Don't translate identifiers.** Settings keys like `lorebook-guide`, tool names like `update_draft`, and `<dle-notes>` tags are part of the runtime contract — translating them breaks behavior.

---

## Placeholder Cheat Sheet

| Source | Meaning | Rule |
|---|---|---|
| `${0}`, `${1}`, `${2}` | Positional template args | Keep verbatim; order can shift if your language requires |
| `{{maxEntries}}` | Settings/template token | Keep verbatim |
| `<dle-notes>...</dle-notes>` | DLE-reserved HTML tag | Keep verbatim |
| `<dle_*_NONCE>` | Prompt-injection security fence | Keep verbatim |
| `<entry name="X">` | XML container in AI prompts | Keep verbatim |
| `lorebook-guide`, `update_draft` | Identifiers | Keep verbatim |

**Word order can change.** Spanish/French/German/Japanese/Chinese/Russian all have different sentence ordering than English. If a translation reads more naturally with `${1}` before `${0}`, that's fine — the placeholder index stays attached to its original semantic role.

Example: English `"Vault: ${0} (${1} entries)"` → Japanese `"${1}件のエントリー：${0}"` is valid.

---

## What's Already Machine-Translated

Every translation file has a `__meta` header:

```json
{
  "__meta": {
    "locale": "es-es",
    "canonical": false,
    "machine_translated": true,
    "translator_model": "claude-opus",
    "generated": "2026-05-22",
    "source": "dle.en.json",
    "total_keys": 2254,
    "notes": "Translated by Claude Opus — full UI coverage. Community refinements welcome via PR."
  },
  ...
}
```

**`machine_translated: true`** means a human hasn't reviewed every string. Your job: flip this flag to `false` per string (or for the whole file) as you confirm each translation reads naturally.

We don't track per-string review status in the file itself — git history is the source of truth. When you change a string in a PR, that string is "reviewed."

---

## Process — PR Checklist

When you open a PR with translation refinements:

- [ ] Title format: `i18n({lang}): refine N strings in {feature}` — e.g. `i18n(es-es): refine 12 strings in drawer`
- [ ] Body includes:
  - Which file(s) changed
  - Sample before/after for 1-2 of the most-noticed changes
  - Any context for word choices that might surprise a non-speaker
- [ ] Verify placeholders match source (`${0}`, `{{maxEntries}}`, `<dle-*>` tags)
- [ ] No changes to `locales/dle.en.json` or `src/i18n/prompts/en.js` (those are English-canonical and managed upstream)
- [ ] No changes to identifier strings (`lorebook-guide`, `update_draft`, etc.)

Run before pushing:

```bash
npm run test:i18n
```

This validates dict shape, checks every locale has the same key set as the English canonical, and confirms placeholder structure (`${0}` indices, `{{...}}` tokens, `<dle-*>` tags) is preserved between source and each translation. A placeholder count mismatch fails the suite.

---

## Issue Templates

If you spot a bad translation but don't have time to PR a fix, open an issue using the **"Translation Feedback"** issue template (New Issue → Translation Feedback; it auto-applies the `i18n`, `translation`, and `help wanted` labels). The template prompts for:

- Locale code (`es-es`, `fr-fr`, etc.)
- Key name (e.g. `dle_drawer_tab_browse`, or an AI-prompt export like `EMMA_FIRSTRUN_GREETING`)
- Current translation
- Suggested translation
- Why (formality, register, technical accuracy, tone)

We'll triage and roll your suggestion into the next refinement PR.

---

## For Maintainers — How to Add a New Locale

1. Add the language code to `SUPPORTED_LOCALES` in `src/i18n/i18n-pure.js`.
2. Run the machine-translation pipeline (or hand-translate the EN canonical):
   - `locales/dle.{newlang}.json` from `locales/dle.en.json`
   - `src/i18n/prompts/{newlang}.js` from `src/i18n/prompts/en.js`
3. Confirm ST supports the locale code (check `public/locales/lang.json` in the ST repo).
4. Add `npm run test:i18n` placeholder coverage for the new locale.
5. Update this page's locale list.

---

## License

Translations are MIT-licensed, same as the rest of DLE. By submitting a PR you confirm your contribution is your own work or properly attributed.
