# Overlay Drawer Single-Scroller + Touch Gestures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Amendment (2026-07-16, post-field-test):** Task 2's Browse rule (`[data-tab="browse"] { overflow:hidden }`) was superseded by commit 53796a2 — tall chrome crushed the zero-min-height list on real phones. Shipped design: browse panel keeps scroll; list floored at `min(50dvh, 400px)`. See spec §3 (design of record).

**Goal:** In `dle-overlay-mode`, collapse the 3-deep nested scrollers to exactly one touch-correct scroller per tab, with scrollbars hidden on touch devices.

**Architecture:** Pure CSS appended to the existing `.dle-overlay-mode` block in `style.css` — re-establish the bounded flex chain the desktop side-panel gets from its explicit height, neutralize ST's `.scrollableInner` default scroll, keep `.dle-tab-panel` as the single scroller (Browse's virtualized list is the one exception), and add `touch-action` / momentum / coarse-pointer scrollbar hiding. A static regression test pins the invariants so upstream merges can't silently drop them.

**Tech Stack:** Plain CSS (no build step); zero-dep Node test harness (`test/helpers.mjs` — `test`/`section`/`summary`, `await summary()` exits 1 on failure).

**Spec:** `docs/superpowers/specs/2026-07-16-overlay-single-scroller-design.md`

## Global Constraints

- CSS only — no JS, no DOM/markup changes, no new user-facing strings (⇒ no i18n changes).
- Everything scoped under `#deeplore-panel.dle-overlay-mode` (plus one `@media (pointer: coarse)` block using the same scope). Desktop inline drawer must be untouched.
- Upstream style: `--dle-*` tokens where values are needed, upstream comment voice, reference Issue #39.
- Never gate on `body.no_animation` / `body.reduced-motion`; `@media (prefers-reduced-motion: reduce)` only (not needed in this plan — no animations).
- CSS comments inside the new rules must not contain `{` or `}` (the regression test scans blocks with `[^}]*`).
- Commit ⇒ push immediately (user tests from GitHub on a real phone). Branch: `mobile-drawer-mode`.

---

### Task 1: Static regression test (RED)

**Files:**
- Create: `test/overlay-scroll.test.mjs`
- Modify: `package.json:35` (`test:all` chain) and the scripts list (add `test:overlay-scroll`)

**Interfaces:**
- Consumes: `test/helpers.mjs` exports `test(name, fn)`, `section(name)`, `summary(label)` (async, must be awaited at top level), `assert(condition, message)`.
- Produces: `npm run test:overlay-scroll` — the gate Task 2 turns green.

- [ ] **Step 1: Write the failing test**

Create `test/overlay-scroll.test.mjs`:

```js
/**
 * Overlay-mode single-scroller invariants (Issue #39, mobile-drawer-mode phase 1).
 *
 * In dle-overlay-mode the drawer is a fixed overlay; without these rules the
 * flex chain is unbounded and up to THREE nested vertical scrollers stack
 * (panel → .dle-drawer-inner → per-tab list), with no touch momentum.
 * These are static CSS assertions so an upstream merge that rewrites the
 * overlay block can't silently reintroduce the nesting.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, section, summary, assert } from './helpers.mjs';

const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');

/**
 * True if any block whose selector ENDS exactly at `selector` (only
 * whitespace before the brace) contains `decl`. The strict \s*\{ anchor
 * stops a descendant block from satisfying an assertion aimed at its
 * parent (e.g. `...dle-overlay-mode .dle-drawer-inner` must not satisfy
 * a check against `...dle-overlay-mode`).
 */
function blockHas(selector, decl) {
    const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${sel}\\s*\\{[^}]*${decl}`, 'm');
    return re.test(css);
}

section('overlay-mode: flex chain bounded, scroller #1 retired');

test('.dle-drawer-inner is a non-scrolling bounded flex column in overlay mode', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-drawer-inner', 'overflow:\\s*hidden'),
        'overlay .dle-drawer-inner must set overflow: hidden (kills ST .scrollableInner default scroll)');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-drawer-inner', 'min-height:\\s*0'),
        'overlay .dle-drawer-inner must set min-height: 0');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-drawer-inner', 'flex-direction:\\s*column'),
        'overlay .dle-drawer-inner must be a flex column');
});

test('overlay panel is a flex column with pan-y touch-action', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode', 'flex-direction:\\s*column'),
        'overlay panel must stack children as a flex column');
    assert(blockHas('#deeplore-panel.dle-overlay-mode', 'touch-action:\\s*pan-y'),
        'overlay panel must declare touch-action: pan-y');
});

section('overlay-mode: one scroller per tab');

test('tab panel is the single scroller and gets touch momentum', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel', '-webkit-overflow-scrolling:\\s*touch'),
        'overlay .dle-tab-panel must set -webkit-overflow-scrolling: touch');
});

test('Filters inner cap is lifted in overlay mode (scroller #3 retired)', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-gating-fields-container', 'max-height:\\s*none'),
        'overlay .dle-gating-fields-container must lift the max-height cap');
});

test('Browse: tab panel yields, virtualized list owns scroll', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel[data-tab="browse"]', 'overflow:\\s*hidden'),
        'overlay browse tab panel must set overflow: hidden');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-browse-list', '-webkit-overflow-scrolling:\\s*touch'),
        'overlay .dle-browse-list must set -webkit-overflow-scrolling: touch');
});

section('overlay-mode: coarse-pointer scrollbar hiding');

test('touch devices hide scrollbar rails; gesture is the affordance', () => {
    assert(/@media \(pointer:\s*coarse\)[\s\S]{0,600}scrollbar-width:\s*none/.test(css),
        'coarse-pointer media block must set scrollbar-width: none');
    assert(/@media \(pointer:\s*coarse\)[\s\S]{0,900}::-webkit-scrollbar[^{]*\{[^}]*display:\s*none/.test(css),
        'coarse-pointer media block must hide ::-webkit-scrollbar');
});

section('upstream base invariants this fix depends on');

test('base .dle-tab-panel still scrolls and contains overscroll', () => {
    assert(blockHas('.dle-tab-panel', 'overflow-y:\\s*auto'),
        'base .dle-tab-panel must keep overflow-y: auto');
    assert(blockHas('.dle-tab-panel', 'overscroll-behavior:\\s*contain'),
        'base .dle-tab-panel must keep overscroll-behavior: contain');
});

test('base .dle-browse-list still owns virtual scroll with contained overscroll', () => {
    assert(blockHas('.dle-browse-list', 'overflow-y:\\s*auto'),
        'base .dle-browse-list must keep overflow-y: auto');
    assert(blockHas('.dle-browse-list', 'overscroll-behavior:\\s*contain'),
        'base .dle-browse-list must keep overscroll-behavior: contain');
});

await summary('Overlay Single-Scroller Tests');
```

- [ ] **Step 2: Wire the script into package.json**

In `package.json` scripts, add (keep the existing style — no trailing comma issues):

```json
"test:overlay-scroll": "node test/overlay-scroll.test.mjs",
```

and append to the END of the `test:all` chain (line ~35):

```
&& node test/overlay-scroll.test.mjs
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:overlay-scroll`
Expected: FAIL — the five overlay-mode sections fail (no such rules exist yet); the two "upstream base invariants" tests PASS (those rules exist at `style.css` ~1270 and ~1974). Exit code 1.

Do NOT commit yet — a red test on this branch would break `test:all` for the user's phone pulls. Task 2 commits test + CSS together.

---

### Task 2: Overlay-mode CSS (GREEN) + full verification + commit

**Files:**
- Modify: `style.css` — append immediately after the `@media (prefers-reduced-motion: reduce)` block that darkens `#deeplore-panel.dle-overlay-mode::before` (~line 2620), i.e. just before the `/* --- Empty states` comment.
- (Test and package.json from Task 1 are committed here too.)

**Interfaces:**
- Consumes: existing rules — `.dle-tab-panel` (~1270: `overflow-y:auto; overscroll-behavior:contain; flex:1; min-height:0`), `.dle-zone-tabs` (~1180: `flex:1; min-height:0`), `.dle-gating-fields-container` (~2268: `max-height:min(320px,40dvh)`), `.dle-browse-list` (~1974: virtualized, `overflow-y:auto; overscroll-behavior:contain`), tab panels carry `data-tab` (`drawer.html:139,199,312,344,408`).
- Produces: the CSS block below — selectors exactly as written (the Task 1 test greps them verbatim).

- [ ] **Step 1: Append the CSS block to style.css**

```css
/* Issue #39 (single-scroller pass) — the overlay panel is fixed and height-
   bounded, but the flex chain below it was never re-established, so ST's
   .scrollableInner default of overflow-y auto engaged and up to THREE nested
   scrollers stacked (panel, drawer-inner, per-tab list) with no touch
   momentum. Rebuild the chain so exactly ONE element scrolls per tab and make
   that scroller touch-correct. Scoped to overlay mode only. */
#deeplore-panel.dle-overlay-mode {
    display: flex;
    flex-direction: column;
    /* Vertical pans always scroll — never stall in gesture disambiguation.
       Horizontal gestures stay available to ST and future swipe-nav. */
    touch-action: pan-y;
}
#deeplore-panel.dle-overlay-mode .dle-drawer-inner {
    /* Neutralize ST .scrollableInner's own scroll — scroller 1 of 3 — and
       give .dle-zone-tabs, which is flex 1 with min-height 0, a bounded flex
       parent so the tab panel becomes the real overflow boundary. */
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
#deeplore-panel.dle-overlay-mode .dle-tab-panel {
    /* The single content scroller — overflow-y auto and overscroll-behavior
       contain come from the base rule; add iOS momentum. */
    -webkit-overflow-scrolling: touch;
}
#deeplore-panel.dle-overlay-mode .dle-gating-fields-container {
    /* BUG-210's viewport cap created scroller 3 of 3 on the Filters tab. In
       overlay mode the tab panel owns scrolling, so let fields flow at
       natural height and scroll with the tab. */
    max-height: none;
    overflow: visible;
}
/* Browse is the one exception: .dle-browse-list is a virtual-scroll container
   and must own its scroll, so the tab panel yields — exactly one scroller
   remains on every tab. */
#deeplore-panel.dle-overlay-mode .dle-tab-panel[data-tab="browse"] {
    overflow: hidden;
}
#deeplore-panel.dle-overlay-mode .dle-browse-list {
    -webkit-overflow-scrolling: touch;
}
/* Touch devices: gesture is the affordance — hide the rails. Scoped by
   pointer type rather than viewport so a desktop overlay triggered by wide
   chat_width keeps its scrollbar. */
@media (pointer: coarse) {
    #deeplore-panel.dle-overlay-mode .dle-tab-panel,
    #deeplore-panel.dle-overlay-mode .dle-browse-list {
        scrollbar-width: none;
    }
    #deeplore-panel.dle-overlay-mode .dle-tab-panel::-webkit-scrollbar,
    #deeplore-panel.dle-overlay-mode .dle-browse-list::-webkit-scrollbar {
        display: none;
    }
}
```

- [ ] **Step 2: Run the new test — verify it passes**

Run: `npm run test:overlay-scroll`
Expected: `Overlay Single-Scroller Tests: 8 passed, 0 failed (8 total)`, exit 0.

- [ ] **Step 3: CSS sanity — brace balance**

Run (Git Bash): `node -e "const c=require('fs').readFileSync('style.css','utf8');const o=(c.match(/{/g)||[]).length,x=(c.match(/}/g)||[]).length;console.log(o,x);process.exit(o===x?0:1)"`
Expected: two equal numbers, exit 0.

- [ ] **Step 4: Full suite + lint**

Run: `npm run test:all && npm run lint`
Expected: every suite green (the chain now ends with the overlay test), lint clean. If lint flags `-webkit-overflow-scrolling`, it's stylelint-free repo (eslint only, JS) — no CSS linting exists; any failure here is unrelated, investigate before proceeding.

- [ ] **Step 5: Commit and push**

```bash
git add style.css test/overlay-scroll.test.mjs package.json
git commit -m "fix(overlay): single scroller per tab + touch gestures in overlay mode (Issue #39)

In dle-overlay-mode the flex chain was unbounded, so ST's .scrollableInner
default scroll engaged and up to 3 vertical scrollers nested (worst: Filters —
panel > drawer-inner > gating fields box) with no touch momentum and
inconsistent scroll chaining. Bound the chain, keep .dle-tab-panel as the one
scroller (Browse's virtualized list is the exception and owns its own), add
touch-action pan-y + -webkit-overflow-scrolling, and hide scrollbar rails on
coarse pointers only. Static regression test pins the invariants.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

Expected: push succeeds to `origin/mobile-drawer-mode`.

---

### Task 3: Live verification (Playwright clone) + real-device handoff

**Files:** none (verification only).

**Interfaces:**
- Consumes: the pushed CSS; the clean ST clone served at `http://127.0.0.1:8002` (sync target below). If 8002 isn't serving, note it and hand off to the user — do NOT test against 127.0.0.1:8001 expecting the fix (that's the user's live install with its own extension copy).

- [ ] **Step 1: Sync the working tree into the clean clone**

```powershell
$source = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced'
$target = 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced'
robocopy $source $target /MIR /XD .git .superpowers node_modules /XF progress.md
```

Expected: robocopy exit code ≤ 7 (1 = files copied is success; PowerShell tool may report nonzero — that is normal for robocopy).

- [ ] **Step 2: Scroller count per tab at phone size**

In the Browser pane: navigate to `http://127.0.0.1:8002`, resize to 375×812, open the DeepLore drawer (if the top bar is hidden, this clone has no CharacterLibrary — the toggle should be visible). For EACH tab (Injection, Browse, Filters, Librarian book icon if present, Tools), run via javascript_tool:

```js
(() => {
  const els = [...document.querySelectorAll('#deeplore-panel, #deeplore-panel *')];
  const scrollers = els.filter(el => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
  });
  return scrollers.map(el => `${el.tagName}.${[...el.classList].join('.')}`);
})()
```

Expected: array length ≤ 1 on every tab (0 when content fits; the one entry on Browse is `.dle-browse-list`, elsewhere `.dle-tab-panel`). Filters was 3 pre-fix; Browse was 2.

- [ ] **Step 3: Layout spot-checks at 375×812 and 412×915**

- Footer (diagnostics dock) visible without scrolling the header away; pinned while tab content scrolls.
- No horizontal page scroll; panel width `min(380px, 90dvw)` intact.
- Filters tab: gating fields flow at natural height (no inner boxed scroll), tab scrolls as one.
- Desktop check at 1280×800: inline drawer unchanged; overlay via wide chat_width (set ST chat width slider high temporarily, then restore) still shows a scrollbar with a mouse pointer.

- [ ] **Step 4: Report and hand off to real device**

Report per-tab scroller counts and any layout deviation. Then tell the user it's pushed and ready to pull onto the phone from GitHub — fling momentum, no rails, no dead-stops on Filters are the things only a finger can truly verify.

---

## Self-review notes

- Spec §1–§5 → Task 2 Step 1 (all five rule groups present); spec testing section → Task 1 (static) + Task 3 (live); spec non-goals honored (no JS/DOM/i18n).
- Selector strings in Task 1's `blockHas` calls match Task 2's CSS verbatim (checked character-for-character, including `[data-tab="browse"]`).
- No placeholders; every step has runnable content and expected output.
