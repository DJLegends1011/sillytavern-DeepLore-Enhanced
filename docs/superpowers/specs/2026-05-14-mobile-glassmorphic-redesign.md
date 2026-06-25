# Mobile Glassmorphic Redesign — Design Spec

## Goal

Replace the proof-of-concept mobile shell (fixed dock + bottom sheet + home-view drill-in) with a polished glassmorphic UI: a draggable floating action button (glass orb) that opens a full-screen frosted overlay with a persistent top tab bar. The redesign should feel native, blend with any SillyTavern theme, and make it structurally easy to implement the 37 remaining mobile parity features tracked in `docs/mobile-parity-todo.md`.

## Architecture

Split the monolithic `mobile-shell.js` (~980 lines) into focused modules by responsibility. Each module has one job and communicates through well-defined interfaces.

## Source Decisions

- **FAB style:** Glass Orb — minimal frosted 44px circle with DLE icon + injection count badge
- **Panel style:** Full-screen glass overlay — like ST's character management tab, maximum content space
- **Tab navigation:** Persistent top tab bar — Injection | Browse | Filters | Librarian | Tools — instant switching, no home screen
- **Drag behavior:** Edge snap — orb snaps to nearest left/right screen edge on release (iOS AssistiveTouch pattern)
- **Architecture:** Split by responsibility — FAB, overlay, state, coordinator, and per-view modules
- **Fallback:** Semi-transparent solid via `@supports` — no blur, just opaque SmartTheme tint color

## Glassmorphic Design System

All mobile surfaces use a shared glass aesthetic built on SillyTavern's existing theme variables. No hardcoded colors — every value chains through `--SmartTheme*` variables so it automatically matches any installed theme.

- **Glass background:** `color-mix(in srgb, var(--SmartThemeBlurTintColor) 88%, transparent)` with `backdrop-filter: blur(16px)`
- **Fallback:** `@supports not (backdrop-filter: blur(1px))` uses solid `var(--SmartThemeBlurTintColor)` at 92% opacity
- **Borders:** `1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 8%, transparent)` — subtle white lines that catch light. Active/hover states use 12%.
- **Cards:** Inner surfaces at `color-mix(in srgb, var(--SmartThemeBodyColor) 3%, transparent)` with 8% border. Just enough contrast to separate from glass background.
- **Active states:** `color-mix(in srgb, var(--SmartThemeUnderlineColor) 15%, transparent)` with matching border — uses the accent color for active tabs and selected filters
- **Shadows:** `var(--SmartThemeShadowColor)` for FAB and overlay
- **Text primary:** `var(--SmartThemeBodyColor)`
- **Text muted:** `var(--SmartThemeEmColor)`
- **Accent/badge:** `var(--SmartThemeQuoteColor)` for injection count badge, timer accents

## Module Architecture

### File Structure

| File | Responsibility | Approx Size |
|------|---------------|-------------|
| `mobile-fab.js` | Glass orb rendering, touch drag, edge snap, position persistence (localStorage), badge updates | ~150 lines |
| `mobile-overlay.js` | Full-screen overlay shell, header bar (DLE icon + status + settings gear + close), tab bar, quick-action row, open/close animations, swipe-to-dismiss | ~200 lines |
| `mobile-state.js` | Centralized state object, event bus (subscribe/notify), snapshot builder | ~150 lines |
| `mobile-shell.js` | Thin coordinator — initializes FAB + overlay, wires state subscriptions, resize/media-query detection, lifecycle (init/destroy) | ~120 lines |
| `mobile-injection.js` | (exists) Pure helpers for Injection tab rendering | ~140 lines |
| `mobile-browse.js` | (exists) Pure helpers for Browse tab rendering | ~120 lines |
| `mobile-filters.js` | **New** — Filters/Gating tab view rendering + field interactions | ~150 lines |
| `mobile-librarian.js` | **New** — Librarian tab view (flags/activity, sort, bulk actions) | ~180 lines |
| `mobile-tools.js` | **New** — Tools tab view (all 16 desktop actions in 5 groups) | ~100 lines |
| `mobile-graph.js` | **New** — Mobile graph: touch canvas, pan/zoom/pinch, tap nodes, full-screen layer | ~300+ lines |
| `mobile-stats.js` | (exists) Status stat formatting helpers | ~95 lines |

### Module Boundaries

- **FAB** knows nothing about the overlay. It fires `onTap` and `onDragEnd` events.
- **Overlay** knows nothing about tab content. It receives a `renderTab(name)` function and calls it.
- **Tab views** are pure renderers. They take a snapshot and return HTML strings. Same proven pattern as `mobile-injection.js` and `mobile-browse.js`.
- **State** is the single source of truth. All modules read from it; only event handlers write to it.
- **Graph** is a separate full-screen layer (z-index: 5003) that launches on top of the overlay. It has its own back button to return.

This means subagents can implement each tab view independently without touching the shell, FAB, or overlay code.

## FAB — Glass Orb

- **Size:** 44x44px circle, `border-radius: 50%`
- **Appearance:** Glass background + blur + subtle border. Font Awesome `fa-book-open` icon with subtle purple drop-shadow glow when entries are injected.
- **Badge:** Injection count, 18px circle, `var(--SmartThemeQuoteColor)` background, positioned top-right of orb.
- **Drag:** Touch events (`touchstart/move/end`) throttled with `requestAnimationFrame`. During drag, orb scales to 1.1x with stronger shadow.
- **Edge snap:** On `touchend`, animate to nearest left or right edge using CSS `transition`. Vertical position stays where dropped. Clamped to viewport bounds minus `env(safe-area-inset-*)`.
- **Persistence:** `{ edge: 'left'|'right', y: number }` saved to `localStorage` key `dleMobileFabPosition`.
- **Tap vs drag:** Distinguished by movement threshold of 8px. Under threshold = tap (opens overlay). Over threshold = drag.
- **Z-index:** 5001 (above ST's UI, below the overlay at 5002).
- **During overlay:** Orb fades out (`opacity: 0, pointer-events: none`) when overlay opens, fades back on close.

### FAB Testing Requirements

The FAB drag mechanics must have dedicated unit tests:

- Tap vs drag threshold detection (movement < 8px = tap, >= 8px = drag)
- Edge snap calculation (snaps to nearest left/right based on x position at release)
- Position persistence (save to and restore from localStorage)
- Badge rendering with different injection counts (0, 1, 99)
- Viewport boundary clamping (orb cannot be dragged off-screen)
- Safe area inset respect (env(safe-area-inset-*) subtracted from bounds)

## Full-Screen Glass Overlay

### Opening and Closing

- **Open animation:** Fade in + scale from 0.95 to 1.0, 200ms ease-out. Scrim fades in behind at `rgba(0,0,0,0.4)`.
- **Close triggers:** X button, swipe down from header (velocity > 300px/s or > 40% viewport dragged), or back gesture.
- **State preservation:** Active tab and scroll position are remembered when closing and reopening within the same session.

### Header Bar

Glass background surface containing:

- DLE orb icon (28px) + "DeepLore" label + status subtitle (e.g., "Ready · 3 injected")
- Settings gear button — runs `/dle-settings` to open the DLE settings panel
- Close X button

### Tab Bar

Directly under header. 5 tabs:

| Tab | Icon | Content |
|-----|------|---------|
| Injection | `fa-circle-question` | 3-way filter, entry cards, Entry Timers |
| Browse | `fa-book-open` | Search, filters, quick filters, entry cards |
| Filters | `fa-filter` | Folder filter, custom gating fields |
| Librarian | `fa-book-bookmark` | Flags/Activity, sort, bulk actions |
| Tools | `fa-toolbox` | 16 actions in 5 groups |

- Active tab: accent background + accent border
- Inactive tabs: plain muted text
- Badge dots on tabs with actionable items (e.g., Librarian flag count, active gating filters count)
- Tab switching is instant — swap rendered content, no slide animation

### Quick-Action Row

Slim horizontal row between tab bar and content area. Always visible on all tabs.

Actions (icon-only buttons, horizontally scrollable if needed):

- Refresh (`fa-sync`)
- Reroll Lore (`fa-shuffle`)
- Skip Librarian (`fa-ban`)
- Scribe (`fa-feather-pointed`)
- New Entry (`fa-plus`)
- Librarian Chat (`fa-book-bookmark`)
- Graph (`fa-diagram-project`)

### Content Area

- Scrollable, fills remaining viewport height
- Each tab view renders into this area via `renderTab(name)` returning an HTML string
- Respects `env(safe-area-inset-bottom)` for bottom padding

### Graph Special Case

Graph launches as a separate full-screen layer on top of the overlay (z-index: 5003) with its own back button. Full viewport for the canvas — Obsidian-style mobile graph with pinch-to-zoom, pan, and tap-to-focus nodes.

## To-Do List Alignment

The architecture maps directly to the 37 remaining parity items in `docs/mobile-parity-todo.md`:

| To-Do Area | Items | Module | Approach |
|------------|-------|--------|----------|
| Browse search syntax | 1 | `mobile-browse.js` | Rich popover matching desktop format, theme-aware styling |
| Quick Actions | 7 | `mobile-overlay.js` | Quick-action row below tab bar |
| Filters/Gating | 6 | `mobile-filters.js` | New module — folder chips, gating fields, clear/manage |
| Librarian | 7 | `mobile-librarian.js` | New module — sub-tabs, sort, bulk select, entry cards |
| Tools | 12 | `mobile-tools.js` | New module — 5 groups, 16 actions |
| Graph | 2 | `mobile-graph.js` | New module — touch graph, full-screen layer |
| Recent Activity | 1 | `mobile-overlay.js` | Collapsible section below quick-action row |
| Copy Titles | 1 | `mobile-injection.js` | Clipboard icon in Injection tab toolbar |

Each tab view is a pure renderer — subagents implement modules independently without touching shared code.

## Testing Strategy

### Unit Tests

- **FAB:** Drag threshold, edge snap, position persistence, badge counts, boundary clamping (see FAB Testing Requirements above)
- **Overlay:** Open/close state transitions, tab switching, header rendering, swipe-to-dismiss velocity threshold
- **Tab views:** Pure renderers tested with mock snapshots (proven pattern from existing mobile-injection.js and mobile-browse.js tests)
- **CSS contracts:** Required selectors exist in style.css for each component

### Integration Tests (Playwright)

- Pixel 5 + iPhone 14 screenshots for: idle orb, overlay open on each tab, drag orb to opposite edge, dismiss overlay
- Tab switching between all 5 tabs
- Quick-action button invocations

### Real Device Testing

Each implementation task must be verified on a real mobile device — pull the latest commit, refresh SillyTavern, and visually confirm before marking done. This is a requirement, not an afterthought. Playwright screenshots verify rendering, but real-device testing catches touch responsiveness, safe area issues, theme integration, and scroll behavior that emulators miss.

### Performance Testing

- Test `backdrop-filter: blur()` on a mid-range Android device during scroll
- Verify `@supports` fallback renders acceptably (solid tint, no blur)
- FAB drag should maintain 60fps — `requestAnimationFrame` throttle and `will-change: transform` on the orb

## Error Handling

- If a tab view throws during rendering, the overlay shows a visible error message in the content area and stays open. Other tabs remain functional.
- If FAB position data in localStorage is corrupted, fall back to default (right edge, above input bar).
- If a quick-action command fails, show an inline error toast (same as existing `setMobileError` pattern).
- If the Obsidian connection is down, graph and vault-dependent actions show appropriate disabled/warning states.

## Out of Scope

- Desktop drawer changes — the desktop UI is unchanged by this work.
- Persisting tab view scroll positions across app restarts.
- Replacing mature desktop popups (Full View buttons still open the desktop popup as a fallback).
- Real Obsidian writes during tests.
- Tablet-specific layouts (this targets phone viewports < 768px).
