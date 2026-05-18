# Mobile Feature Parity — To-Do List

> Tracks remaining work to bring the mobile drawer to full parity with the desktop drawer.
> Based on a side-by-side audit of `drawer.html` vs `src/mobile/mobile-shell.js` (2026-05-14).
>
> **Related specs:**
> - `docs/superpowers/specs/2026-05-05-mobile-hybrid-shell-design.md` — original mobile shell design
> - `docs/superpowers/specs/2026-05-11-mobile-status-tray-and-tab-parity-design.md` — status tray + Browse parity
> - `docs/superpowers/specs/2026-05-12-mobile-injection-tab-design.md` — Injection tab redesign
>
> **Testing:** Each item should be verified on a real mobile device, not just Playwright.
> Pull the latest commit, refresh SillyTavern, and visually confirm before marking done.

---

## Done

- [x] **Mobile shell** — hybrid dock + drill-in pattern, floating dock, bottom sheet
- [x] **Status Tray** — expandable metrics: Budget, Entries, Context, AI stats, Health (with progress bars)
- [x] **Home view** — Status/Vault/Injected/Gaps pills, 4 nav buttons (Injection, Browse, Librarian, Tools)
- [x] **Injection tab** — 3-way filter (injected/filtered/all), entry cards with match badges + tokens, Entry Timers collapsible, Obsidian/Browse action links, Full View icon button
- [x] **Browse tab** — search bar, status/tag/folder/sort filters, quick filters (Since last gen, Never injected), expandable entry cards with Pin/Block/Copy/Open, Full View icon button
- [x] **Theme-aware CSS** — all mobile elements use `--SmartTheme*` variables
- [x] **FAB glass orb** — draggable floating action button replaces old dock bar, edge snap, input-area boundary clamping, keyboard-aware repositioning, injection count badge
- [x] **Copy Titles button** — clipboard icon in Injection tab header copies injected entry titles

---

## Browse — Polish

- [ ] **Search syntax help popover** — current "?" shows a plain one-liner; desktop shows a rich popover with `tag:wizard`, `folder:Locations`, `key:apple`, `summary:"old gods"`, `field:era=medieval` examples. Match the desktop format with theme-aware styling.

---

## Quick Actions (Home View)

Desktop has 7 quick-action buttons always visible in Zone 1. Mobile has none on the home view — some are buried in Tools.

- [ ] **Refresh** — currently only in Tools; surface on home or status tray
- [ ] **Reroll Lore** — clear AI search cache, re-select from scratch
- [ ] **Skip Librarian** — skip Librarian tools for next generation
- [ ] **Scribe** — run Session Scribe (AI summarizes conversation to Obsidian)
- [ ] **New Entry (+)** — create new lore entry
- [ ] **Librarian Chat** — open Librarian chat
- [ ] **Graph** — currently only in Tools; surface on home or quick actions

> **Design decision needed:** How to surface these without cluttering. Options: quick-action row on home, inside expanded status tray, or "More actions" overflow.

---

## Filters (Gating) Tab — Missing Entirely

Desktop has a dedicated Filters tab for contextual gating. Mobile has nothing.

- [ ] **Add Filters tab/view** to mobile nav buttons
- [ ] **Folder filter** — select folders + chip display for active filters
- [ ] **Custom gating fields** — dynamic field rows based on `fieldDefinitions`
- [ ] **Clear all filters** button
- [ ] **Manage fields** button (gear icon)
- [ ] **Active gating filters display** on home view (desktop shows this in Zone 1 status area)

> **Design decision needed:** Full drill-in view like Browse/Injection, or a simpler compact layout since gating fields are mostly toggles/selects?

---

## Librarian Tab — Currently a Bare Stub

Desktop has sub-tabs, sorting, bulk selection, and action buttons. Mobile just shows 6 gaps in a plain list.

- [ ] **Flags / Activity sub-tabs** — radio toggle like desktop
- [ ] **Sort selector** — Newest / Frequency / Urgency
- [ ] **Select all + bulk actions** — checkboxes with Open / Mark Done / Remove
- [ ] **New Entry button** — create vault entry from scratch
- [ ] **Vault Review button** — AI-guided review of vault
- [ ] **Proper entry cards** — match desktop row format with actions
- [ ] **Empty state** — "No lore gaps recorded yet" with New Entry + Vault Review buttons

---

## Tools Tab — Currently a Skeleton (4 of 16)

Desktop has 5 groups with 16 actions. Mobile has 4 actions + Refresh + Mode toggle.

### Inspect (1 of 4 done)
- [x] Health Check
- [ ] **Inspect** — inspect last lore selection (what matched and why)
- [ ] **Status** — full system status
- [ ] **Simulate** — simulate what entries would match

### Notebooks & History (0 of 3)
- [ ] **Author Notebook** — persistent scratchpad for this chat
- [ ] **AI Notepad** — session notes written by AI via `dle-notes` tags
- [ ] **Scribe History** — view Scribe history

### AI Utilities (0 of 3)
- [ ] **AI Review** — review AI search decisions
- [ ] **Summarize** — generate entry summaries via AI
- [ ] **Optimize Keys** — optimize entry keywords

### Vault Ops (2 of 4 done)
- [x] Graph
- [x] Refresh
- [ ] **Import World Info** — import WI entries from SillyTavern to Obsidian
- [ ] **Pins/Blocks** — view pins and blocks for this chat

### Get Help (1 of 2 done)
- [x] Setup
- [ ] **Help** — help and documentation

---

## Graph — Needs Mobile Version

Desktop has a full popup graph visualization. Obsidian has a working mobile graph view that DLE recreates.

- [ ] **Mobile graph view** — touch-friendly graph visualization (pan/zoom/tap nodes)
- [ ] **Graph nav integration** — accessible from Tools and/or quick actions

> **Design decision needed:** Inline in the mobile sheet (limited space) or full-screen overlay? Obsidian uses full-screen on mobile — likely the right call here too.

---

## Footer / Activity

Desktop Zone 3 has context bar, Recent Activity, health icons, and AI stats. The Status Tray already covers most of this, but one piece is still missing.

- [ ] **Recent Activity feed** — collapsible list of recent pipeline runs

> **Note:** Health icons, AI stats, and context bar are already covered by Status Tray metrics. Only Recent Activity is truly missing.

---

## Injection Tab — Complete ✓

All Injection tab parity items are done.

---

## Summary

| Area | Done | Remaining |
|------|------|-----------|
| Injection | 7 | 0 |
| Browse | 6 | 1 |
| Quick Actions | 0 | 7 |
| Filters (Gating) | 0 | 6 |
| Librarian | 0 | 7 |
| Tools | 4 | 12 |
| Graph | 0 | 2 |
| Footer/Activity | 0 | 1 |
| Infrastructure | 1 | 0 |
| **Total** | **18** | **35** |
