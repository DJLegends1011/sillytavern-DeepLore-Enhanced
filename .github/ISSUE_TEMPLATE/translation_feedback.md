---
name: Translation Feedback
about: Report a bad/awkward translation or suggest a better one
title: 'i18n({locale}): {short description}'
labels: i18n, translation, help wanted
assignees: ''
---

<!-- See https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/wiki/Contributing-Translations for context. -->

## Locale
<!-- One of: es-es, fr-fr, de-de, ja-jp, zh-cn -->

## Key
<!-- The i18n key name from locales/dle.{locale}.json or src/i18n/prompts/{locale}.js -->
<!-- e.g. dle_drawer_tab_browse, EMMA_FIRSTRUN_GREETING -->

## Current translation
```
(paste current value)
```

## Suggested translation
```
(paste your suggested value)
```

## Why
<!-- Tone, register, technical accuracy, idiom, formality, gender, etc.
     A short explanation helps the reviewer pick the right replacement. -->

## Optional context

- Does this string have placeholders (`${0}`, `{{maxEntries}}`)? If yes, did you preserve them in the suggested translation?
- Is this part of UI (button/label/toast) or an AI prompt (sent to the LLM)?
- Are you a native speaker, fluent learner, or both?

---

**Don't have time to PR a fix?** Just file this issue — we'll roll it into the next refinement PR. Thanks for helping make DLE feel native to your language.
