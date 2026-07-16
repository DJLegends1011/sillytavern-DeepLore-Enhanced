# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Fork of **pixelnull/sillytavern-DeepLore** (a SillyTavern extension that uses an Obsidian vault as an AI-powered lorebook: keyword matching + AI retrieval). This fork ("DeepLore Enhanced") adds a **mobile hybrid shell UI** on the long-running branch `codex-mobile-hybrid-shell`.

- **origin**: `DJLegends1011/sillytavern-DeepLore-Enhanced` (this fork)
- **upstream**: `pixelnull/sillytavern-DeepLore` (source; `main` = releases, `staging` = active dev)
- The feature branch syncs from **staging**. Use the `/update-dle-mobile-shell` command to sync after upstream releases (it documents the recurring merge conflicts and their resolutions).
- **Push immediately after committing** — the user tests from GitHub on a real mobile device, not locally. After any code change, report whether the work is uncommitted, committed, or pushed (see AGENTS.md).

## Commands

```bash
npm test                 # unit suite only (test/unit.mjs)
npm run test:all         # full suite CI runs (unit, integration, mobile, i18n, imports, ...)
npm run test:mobile      # mobile UI tests — run after any mobile change
npm run test:<name>      # single suite, e.g. test:i18n, test:vault — see package.json scripts
npm run test:imports     # verify imports after moving/renaming files
npm run lint             # eslint (CI runs test:all + lint on pushes/PRs to main and staging)
```

No build step — plain ES modules loaded directly by SillyTavern. Edit, reload ST, change is live. Tests run in Node with zero dependencies (harness mocks jQuery/toastr/ST globals).

## Architecture — read the internals docs first

`docs/README.md` is a routing table into code-level internals docs (generation pipeline, state/lifecycle, vault/indexing, AI subsystem, librarian, stages/gating, editable prompts). **Always read `docs/gotchas.md` before modifying pipeline, state, or lifecycle code** — every numbered gotcha there caused a real regression, and the numbers are a stable contract (referenced from code comments and `test/regression.test.mjs`; append-only, never renumber).

Big picture:
- `index.js` — extension entry point; mounts the desktop drawer and mobile shell; owns `onGenerate` pipeline hook
- `core/` — shared pure utilities (vault-file parsing, keyword matching, sync diffing); owned by this repo (subtree history is dead)
- `src/pipeline/`, `src/stages.js` — retrieval pipeline: keyword match → hierarchical pre-filter → AI search → gating → cooldown/dedup/budget → inject
- `src/vault/` — Obsidian fetch, index build/cache, BM25
- `src/ai/` — AI search, connection routing, circuit breaker
- `src/librarian/` — "Emma" agentic librarian loop and tools
- `src/state.js`, `src/verdict/` — reactive state and the verdict store
- `src/drawer/` — desktop drawer UI (5 tabs: Injection, Browse, Filters, Librarian, Tools)
- `src/mobile/` — **this fork's main work**: FAB glass orb + full-screen glass overlay shell
- `src/ui/` — settings UI, setup wizard, slash commands, popups

### Mobile shell (fork-specific)

- `mobile-shell.js` (controller/render/handlers), `mobile-fab.js` (draggable glass-orb FAB, position in localStorage `dleMobileFabPosition`), `mobile-overlay.js` (overlay chrome + swipe math), `mobile-state.js` (state factory/tab model), plus pure helper modules per tab (`mobile-browse.js`, `mobile-injection.js`, `mobile-stats.js`, `mobile-verdict.js`, `mobile-i18n.js`)
- Pattern: FAB is the sole entry point → full-screen glass overlay with drill-in views; mature desktop tools stay on slash commands (`/dle-health`, `/dle-graph`, `/dle-setup`, ...)
- Activation: ST mobile flag, viewport ≤768px, or coarse pointer ≤1024px; localStorage `dleMobileUiForce = "1"` forces on, `dleMobileUiDisabled = "1"` wins over force
- When mobile UI is active the desktop drawer is hidden — never two DeepLore surfaces
- Upstream v2.6.0 gave the desktop drawer its own narrow-viewport **overlay mode** (`dle-overlay-mode`, ≤768px — same breakpoint, see `src/drawer/drawer.js` + `OVERLAY_VIEWPORT_WIDTH_PX`). It's the desktop drawer as a fixed overlay, not a rival mobile shell; it's what users get when they set the Mobile UI escape hatch (settings System panel) to "Off"
- Mobile pure helpers have no DOM access; mobile rendering is innerHTML replacement (unlike desktop's DOM manipulation)
- CSS: desktop `dle-*`, mobile `dle-mobile-*` with view prefixes; event delegation via `data-dle-mobile-*` attributes; escape dynamic content with `escapeHtml()`
- Runtime data comes from the current-chat `VerdictStore`; Obsidian actions launch through `openObsidianUri`
- Mobile work must not break the desktop drawer; run `npm run test:mobile` after any mobile change, `npm run test:all` before claiming done

## i18n rules (fork-critical)

- New mobile copy is added as **canonical English keys only** (`dle_mobile_*` in `locales/dle.en.json`). Translations are owned by the upstream maintainer — `dle_mobile_` is in `ENGLISH_FALLBACK_ONLY_PREFIXES` in `test/i18n.test.mjs`, so mobile keys are excluded from translation-parity tests.
- `locales/dle.en.json` `__meta.total_keys` is informational but keep it accurate: upstream's canonical count + this branch's mobile keys (recount with a quick Node one-liner after merges).

## Merge/sync gotchas

- The `.gitignore` is a whitelist (`*` then `!` entries). New root files are silently ignored until whitelisted — this is how the fork's previous CLAUDE.md got lost in the v2.5 migration.
- Recurring conflicts when merging staging: `style.css` (both sides append at EOF — union), `test/i18n.test.mjs` key-count assertion (take staging's canonical number), `dle.en.json` `total_keys` (recount). Details in `/update-dle-mobile-shell`.

## Fork-specific gotchas

- Stock SillyTavern puts `no_animation` and `reduced-motion` classes on `<body>` even when those settings are unchecked. Never guard DLE animations with those body classes (silently kills them on real devices) — use `@media (prefers-reduced-motion: reduce)` only.
- ST transforms `<html>` (fixed-position containing block has computed height 0), so fixed overlays need explicit `100vh`/`100dvh` heights — `inset: 0` alone collapses.
- ST's no-blur setting kills `backdrop-filter` at runtime — glass surfaces need the denser-tint fallback under `body.no-blur` / `@supports not (backdrop-filter: ...)`.
- `progress.md` is a local scratch handoff — intentionally untracked, don't commit it.
- Plan/spec docs in `docs/superpowers/` can lag behind code — trust source and tests over plan markdown.

## Browser testing

Sync into the clean SillyTavern test clone (Playwright lives there, not here):

```powershell
$source = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced'
$target = 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced'
robocopy $source $target /MIR /XD .git .superpowers node_modules /XF progress.md
```

Test URL: `http://127.0.0.1:8002/`. Device targets: Chromium Pixel 5, WebKit iPhone 14 (WebKit-on-Windows can't synthesize TouchEvent — verify swipes on Chromium).
