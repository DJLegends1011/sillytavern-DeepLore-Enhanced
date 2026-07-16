# Overlay Drawer Single-Scroller + Touch Gestures — Design

**Branch:** `mobile-drawer-mode` · **Phase ① of the mobile-drawer series** (see CLAUDE.md)
**Date:** 2026-07-16 · **Status:** approved approach A (pure CSS), pending spec review

## Problem

Upstream v2.6.0's `dle-overlay-mode` (drawer as fixed overlay, engaged at viewport ≤768px or wide `chat_width`; `src/drawer/drawer.js` `updateOverlayMode` ~272) stacks up to **three independent vertical scrollers** and has no touch affordances. Measured live (ST 1.18.0, DLE 2.6.2, 375×812):

| Tab | Scrollers | Chain |
|---|---|---|
| Filters | 3 — `#deeplore-panel.dle-overlay-mode` → `.scrollableInner.dle-drawer-inner` → `.dle-gating-fields-container` | panel `contain` / inner `auto` / gating `contain` — inconsistent |
| Browse | 2 — panel → `.dle-drawer-inner` (plus `.dle-browse-list` when content exceeds) | — |
| Injection | 1 — `.dle-drawer-inner` | — |

No element sets `-webkit-overflow-scrolling: touch`; drags either chain into ST's chat or dead-stop depending on which region is under the finger. Root cause: the overlay-mode CSS block (`style.css` ~2579–2620) fixes the panel's position/height but never re-establishes the bounded flex chain that desktop side-panel mode gets from `#deeplore-panel.openDrawer`'s explicit height — so ST's `.scrollableInner` default `overflow-y: auto` engages, and the intended single scroller `.dle-tab-panel` (`style.css` ~1270) becomes one of several.

## Goals / non-goals

**Goals**
1. Exactly **one** vertical scroller per tab in overlay mode, on every tab.
2. Native touch scrolling: momentum/fling, vertical pan never eaten, no scroll-chaining into the chat behind the overlay.
3. Touch devices show no scrollbar rail — gesture is the affordance. Mouse-driven overlay (wide `chat_width` on desktop) keeps its scrollbar.
4. Surgical, upstream-PR-able diff: CSS only, scoped entirely under `.dle-overlay-mode`; no JS, no DOM changes, no new strings (no i18n impact).

**Non-goals (later phases)**
- `isMobileMode()` / `dle-mobile-mode` class (phase ③ compaction).
- Swipe navigation (tab-to-tab swipes, swipe-to-dismiss) — JS, later phase.
- Toast fix, stats-row clipping, general compaction, settings popup, graph/librarian panels, optional glass skin.
- Desktop inline (non-overlay) drawer behavior — untouched.

## Design

All rules scoped to `#deeplore-panel.dle-overlay-mode`, appended to the existing overlay-mode block in `style.css` (~2579–2620). Follow upstream comment style; reference this rationale briefly.

### 1. Bound the flex chain; retire scroller #1

```css
#deeplore-panel.dle-overlay-mode { display: flex; flex-direction: column; }
#deeplore-panel.dle-overlay-mode .dle-drawer-inner {
    flex: 1;
    min-height: 0;
    overflow: hidden;          /* neutralize ST .scrollableInner default */
    display: flex;
    flex-direction: column;
}
```

`.dle-zone-tabs { flex: 1; min-height: 0 }` (existing, ~1180) now resolves against a bounded parent, so the tab zone fills the panel and `.dle-tab-panel` becomes the genuine overflow boundary. The footer (`#dle-drawer-footer`, moved outside `.dle-drawer-inner` by `drawer.js` ~216) stays pinned as the last flex child of the panel.

### 2. One scroller per tab; retire scroller #3

```css
/* .dle-tab-panel (~1270) already has overflow-y:auto + overscroll-behavior:contain */
#deeplore-panel.dle-overlay-mode .dle-tab-panel {
    -webkit-overflow-scrolling: touch;
}
#deeplore-panel.dle-overlay-mode .dle-gating-fields-container {
    max-height: none;          /* was min(320px, 40dvh) — the Filters inner box */
    overflow: visible;
}
```

Filters fields now scroll with the tab instead of inside a capped box.

### 3. Browse uses the same tab-panel scroller

`.dle-browse-list` is a virtualized positioning surface, but it must not be a second scroll viewport. The Browse tab panel owns the gesture and moves the search/filter chrome and virtual rows together:

```css
#deeplore-panel.dle-overlay-mode .dle-tab-panel {
    overflow-y: auto;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
}
#deeplore-panel.dle-overlay-mode .dle-browse-list {
    flex: 0 0 auto;
    overflow: visible;
}
```

The list's inline `min-height` represents the full virtual content. Overlay viewport math selects `.dle-tab-panel[data-tab="browse"]`; inline desktop continues selecting the branch's existing `.dle-drawer-inner` viewport. The scroll listener and filter reset target both owners so crossing the responsive breakpoint cannot leave stale state.

Invariant in overlay mode: every active tab has exactly one vertical scroller: its `.dle-tab-panel`.
### 4. Gesture correctness

```css
#deeplore-panel.dle-overlay-mode { touch-action: pan-y; }
```

Vertical pans always scroll; the browser never stalls disambiguating. Horizontal gestures stay available for ST/browser (and future swipe-nav). `overscroll-behavior: contain` on the active scroller (already present on `.dle-tab-panel`; added to `.dle-browse-list`) stops chain-scrolling into the chat.

### 5. Touch devices: gesture replaces the scrollbar

```css
@media (pointer: coarse) {
    #deeplore-panel.dle-overlay-mode .dle-tab-panel,
    #deeplore-panel.dle-overlay-mode .dle-browse-list {
        scrollbar-width: none;             /* Firefox */
    }
    #deeplore-panel.dle-overlay-mode .dle-tab-panel::-webkit-scrollbar,
    #deeplore-panel.dle-overlay-mode .dle-browse-list::-webkit-scrollbar {
        display: none;                     /* Blink/WebKit */
    }
}
```

Scoped by pointer type, not viewport: a desktop user who triggers overlay mode via wide `chat_width` keeps the scrollbar; a phone/tablet gets the native rail-less feel.

## Testing

**Static regression test** — new `test/overlay-scroll.test.mjs`, wired into `test:all` (follow the existing zero-dep node test pattern). Reads `style.css` and asserts the invariants so future upstream merges can't silently drop them:
- overlay block sets `overflow: hidden` on `.dle-drawer-inner`;
- gating container cap is lifted under overlay mode;
- browse tab-panel yields overflow while `.dle-browse-list` keeps it;
- `touch-action: pan-y` present; coarse-pointer scrollbar-hiding block present.

**Live verification** — on the port-8002 Playwright clone at 375×812 and 412×915 (Chromium; WebKit-on-Windows can't synthesize TouchEvent):
- Scroller count per tab via the audit's measurement (`scrollHeight > clientHeight + 2` && computed `overflow-y` auto/scroll inside `#deeplore-panel`): expect **1 on every tab** (Filters was 3, Browse 2).
- Footer visible and pinned; header not scrolled away; no horizontal overflow.
- Desktop 1280×800: inline drawer unchanged; overlay-via-chat_width still shows scrollbar (fine pointer).

**Real device** — push, then user checks on phone (~412px): fling momentum, no rail, no scroll dead-stops on Filters, Browse list scrolls smoothly.

## Risks

- **Filters visual change in desktop overlay:** the gating fields box no longer self-scrolls (it grows; the tab scrolls). Intended, but visible in wide-`chat_width` overlay too. Acceptable — single-scroller is the correct behavior there as well.
- **Sticky/absolutely-positioned descendants** relying on the old inner scroll geometry would misbehave — none known; live verification on all 5 tabs will catch it.
- **Upstream merge conflicts:** changes append inside/near the overlay block other work also touches; the static test pins the invariants.
