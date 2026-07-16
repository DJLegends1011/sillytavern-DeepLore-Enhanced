# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this branch is

Fork of **pixelnull/sillytavern-DeepLore** (SillyTavern extension: Obsidian vault as an AI-powered lorebook). Branch **`mobile-drawer-mode`** (based on upstream `staging`, v2.6.2) **completes the maintainer's own mobile work** (Issue #39, v2.6.0): instead of building a rival mobile surface, it fixes and compacts the existing desktop drawer/popups for phone-sized viewports, in upstream's own design language, with the explicit goal of being **upstream-PR-able**.

- **origin**: `DJLegends1011/sillytavern-DeepLore-Enhanced` (this fork)
- **upstream**: `pixelnull/sillytavern-DeepLore` (`main` = releases, `staging` = active dev; sync this branch from staging)
- **Push immediately after committing** — the user tests from GitHub on a real mobile device. After any code change, report whether work is uncommitted, committed, or pushed (see AGENTS.md).
- Sibling branch `codex-mobile-hybrid-shell` is the older approach (separate FAB + glass overlay shell, `src/mobile/`). It is parked, not merged here. Reference it for: richer mobile *detection* logic (ST mobile flag + viewport ≤768 + coarse pointer ≤1024, force/disable localStorage escape hatches) and a working single-scroller overlay pattern. Do not port its parallel renderers.

## Mission: what's broken on phones (verified live, 2026-07-15/16)

Upstream's v2.6.0 phone answer is `dle-overlay-mode` — the desktop drawer as a fixed overlay at viewport ≤768px (`src/drawer/drawer.js` `updateOverlayMode` ~line 272, `OVERLAY_VIEWPORT_WIDTH_PX` in `src/drawer/drawer-state.js`, CSS block `style.css` ~2579–2620). It works but is unfinished:

1. **Nested scrollbars, no gesture support.** Up to **3 independent vertical scrollers** stacked (measured on Filters tab: `#deeplore-panel.dle-overlay-mode` → `.scrollableInner.dle-drawer-inner` → `.dle-gating-fields-container`; Browse = 2 via `.dle-browse-list`). No `-webkit-overflow-scrolling: touch` anywhere; scroll-chaining is inconsistent (`.dle-drawer-inner` chains with `auto`, inner containers trap with `contain`). Fix = single-scroller architecture: in overlay mode make `.dle-drawer-inner` a non-scrolling bounded flex column (`flex:1; min-height:0; overflow:hidden`), keep `.dle-tab-panel` (style.css ~1270) as the one scroller, drop inner `max-height` caps; Browse is the exception — its virtualized `.dle-browse-list` must own scroll internally, so it gets a height floor (min(50dvh,400px)) while the panel scrolls the chrome above it. Exactly one scroller per tab, with `touch-action: pan-y`, `overscroll-behavior: contain`, `-webkit-overflow-scrolling: touch`.
2. **Toasts don't fire on mobile.** Diagnostics-dock clicks (lore-selection checkmarks, AI-search bot icon) show toasts on desktop but nothing on mobile — likely the v2.6.0 `notify` facade or toastr positioning/z-index vs the overlay. Also the session stats row clips at phone width ("0 calls  0 cached  0 tokens" loses "0 tokens").
3. **Desktop furniture needs compaction.** Header icons as small as 17×20px (target: ≥40px), tab strip can overflow narrow viewports (verify per width — at 375px the last tab clips; on a ~412px device all 4 tabs + Librarian book icon fit), Browse's two-per-row filter dropdowns, awkward Filters rows (Era "+"), and the **settings popup**, which the maintainer explicitly left "desktop-first for now" — this branch takes it on. Same for Graph and Librarian panels at phone size.
4. **Glass theme = optional, later.** The glass look from the shell branch may return as an opt-in CSS skin. It is not the architecture.

Design contract: a `dle-mobile-mode` (name TBD in spec) class driven by an `isMobileMode()` check, with compact CSS under that class using **upstream's `--dle-*` tokens only** (`style.css` `:root` 6–135: type scale tracks ST's font-scale slider, spacing, radius, motion, focus rings). No new design language.

## Commands

```bash
npm test                 # unit suite (test/unit.mjs)
npm run test:all         # full suite CI runs
npm run test:<name>      # single suite — see package.json scripts
npm run lint             # eslint (CI: test:all + lint on pushes/PRs to main and staging)
```

No build step — plain ES modules loaded by SillyTavern. Edit, reload ST, live. Tests run in Node, zero deps (harness mocks jQuery/toastr/ST globals). This branch has **no** `test:mobile` (that suite belongs to the shell branch); add drawer-mode tests to the existing suites or a new `test/` file wired into `test:all`.

## Architecture — read the internals docs first

`docs/README.md` routes into code-level internals docs. **Always read `docs/gotchas.md` before modifying pipeline, state, or lifecycle code** — gotcha numbers are a stable, append-only contract (referenced from code and `test/regression.test.mjs`). Gotcha #103 covers the v2.6.0 settings-popup tab aliasing.

- `index.js` — entry point; mounts drawer; `onGenerate` pipeline hook
- `src/drawer/` — the drawer UI (5 tabs) **← main worksite**, esp. `drawer.js` (overlay mode, listeners) and `drawer-state.js` (constants)
- `style.css` — single stylesheet; tokens at top, drawer sections, `.dle-overlay-mode` block ~2579
- `settings-popup.html` + `src/ui/settings-ui.js` — settings popup (compaction target)
- `src/verdict/`, `src/state.js` — verdict store / reactive state; `core/`, `src/pipeline/`, `src/vault/`, `src/ai/`, `src/librarian/` — pipeline internals (mostly out of scope here)

## Upstream-PR discipline (branch-critical)

- Match the maintainer's current style: jQuery DOM patterns in drawer code, `--dle-*` tokens in CSS, `dle-*` class names, `notify` facade for toasts, `t()`/`data-i18n` for strings.
- **i18n**: upstream requires full 7-locale key parity (`test:i18n` asserts counts). New UI strings need keys in **all 7** `locales/dle.*.json` files + the `total_keys` recount, or the suite fails. (No `dle_mobile_` fallback-prefix exemption here — that's a shell-branch mechanism.)
- Animations: gate with `@media (prefers-reduced-motion: reduce)` **only** — never `body.no_animation`/`reduced-motion` classes (stock ST sets them even when unchecked; guards silently kill animations on real devices).
- Fixed overlays need explicit `100vh`/`100dvh` heights — ST transforms `<html>`, so `inset: 0` alone collapses.
- Glass/blur surfaces need a denser-tint fallback under `body.no-blur` and `@supports not (backdrop-filter: ...)`.
- Keep diffs surgical and per-concern — this branch wants to become a clean upstream PR (or a short series: scroll fix, toast fix, compaction, settings).

## Merge/sync gotchas

- **`.gitignore` is a whitelist** (`*` then `!` entries). New root files are silently ignored until whitelisted — CLAUDE.md/AGENTS.md are whitelisted on this branch; keep them out of any upstream PR diff.
- Recurring conflicts vs staging: `style.css` (both sides append at EOF — union), `test/i18n.test.mjs` key-count assertion + `dle.en.json` `total_keys` (recount).
- `progress.md` is a local scratch handoff — intentionally untracked, don't commit it.

## Browser testing

User's live ST: `http://127.0.0.1:8001` (real usage; a CharacterLibrary AIO extension is co-installed there and hides `#top-settings-holder` at narrow widths — the drawer toggle can vanish on phones, worth knowing when testing). Clean Playwright clone (sync target, port 8002):

```powershell
$source = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced'
$target = 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced'
robocopy $source $target /MIR /XD .git .superpowers node_modules /XF progress.md
```

Device targets: Chromium Pixel 5, WebKit iPhone 14 (WebKit-on-Windows can't synthesize TouchEvent — verify swipes on Chromium). Real-device checks happen from GitHub on the user's phone (~412px CSS width) — hence push-after-commit.
