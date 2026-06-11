# DeepLore Enhanced

SillyTavern extension that uses Obsidian vaults as an AI-powered lorebook system. Keywords + AI-assisted lore retrieval, drawer UI, diagnostics, librarian flows, and soon mobile UI.

## Quick Start

```bash
npm run test:mobile    # mobile UI tests (fast, run after any mobile change)
npm run test:all       # full suite (unit, integration, contracts, fields, stages, diagnostics, vault, regression, mobile, imports)
npm run lint           # eslint
```

## Architecture

### Desktop Drawer
- `drawer.html` — HTML template (3 zones: status, tabs, footer)
- `src/drawer/drawer.js` — main drawer controller
- `src/drawer/drawer-events.js` — event handlers
- `src/drawer/drawer-render-status.js` — status zone rendering
- `src/drawer/drawer-render-tabs.js` — tab content (Injection, Browse, Gating, Tools)
- `src/drawer/drawer-render-librarian.js` — Librarian tab
- `src/drawer/drawer-render-footer.js` — footer (context bar, activity, health icons)
- `src/drawer/drawer-state.js` — drawer state management

Desktop has 5 tabs: Injection, Browse, Filters (gating), Librarian, Tools.

### Other Desktop UIs (not in the drawer)
Beyond the drawer, several desktop features open as popups/dialogs that will also need mobile-friendly treatment:
- Graph view — relationship visualization between entries
- Settings menu — extension configuration
- Setup Wizard — guided onboarding (already has some mobile responsiveness)
- Full View popups — expanded Injection, Browse, Filters views launched via slash commands

### Mobile Shell
- `src/mobile/mobile-shell.js` — controller, rendering, click handlers, mobile activation
- `src/mobile/mobile-fab.js` — draggable glass-orb FAB: touch drag, edge snap, position persistence (`dleMobileFabPosition` in localStorage), badge updates
- `src/mobile/mobile-stats.js` — pure helpers for status tray stat derivation
- `src/mobile/mobile-browse.js` — pure helpers for Browse filtering, options, row metadata
- `src/mobile/mobile-injection.js` — pure helpers for Injection tab (filter logic, entry rows, timers)

Mobile uses a hybrid FAB + drill-in pattern: the draggable FAB is the sole entry point (the old dock button was removed), opening a bottom sheet for local views; slash commands cover mature desktop tools when that's the better surface (`/dle-health`, `/dle-context-state`, `/dle-graph`, `/dle-setup`, `/dle-why`, `/dle-browse`).

Mobile activation: SillyTavern mobile flag, viewport <= 768px, coarse pointer <= 1024px, or localStorage overrides — `dleMobileUiForce = "1"` forces it on, `dleMobileUiDisabled = "1"` disables it and wins over force.

### Core Systems
- `src/state.js` — reactive state (vault index, injection sources, pipeline trace, etc.)
- `src/helpers.js` — shared utilities (Obsidian URI builder, pin/block normalization, etc.)
- `src/vault/obsidian-api.js` — Obsidian vault communication
- `index.js` — extension entry point, mounts drawer and mobile shell

## Conventions

- **ES modules** throughout (`"type": "module"` in package.json)
- **No build step** — runs directly in the browser via SillyTavern's extension loader
- **Mobile helpers are pure functions** — no DOM access, no side effects, easily unit-testable
- **Mobile rendering uses innerHTML replacement** — not DOM manipulation like desktop
- **CSS class naming**: desktop uses `dle-*`, mobile uses `dle-mobile-*` with view-specific prefixes (e.g. `dle-mobile-browse-*`, `dle-mobile-injection-*`)
- **HTML data attributes** for event delegation: `data-dle-mobile-action`, `data-dle-mobile-view`, `data-dle-mobile-command`, etc.
- **Escape all dynamic content** with `escapeHtml()` before inserting into templates
- Mobile work must not break desktop drawer behavior
- When mobile UI is active, desktop drawer stays hidden (no two DeepLore surfaces)

## Testing

Tests live in `test/` as `.mjs` files. Mobile tests are in `test/mobile-ui.test.mjs` and `test/mobile-fab.test.mjs` (both run by `npm run test:mobile`).

Mobile test patterns:
- Pure helper tests: normalization, filtering, row building, edge cases
- Render contract tests: verify HTML output contains expected elements (headers, buttons, cards, empty states)
- Always run `npm run test:mobile` after any mobile change
- Run `npm run test:all` before claiming work is complete

## Browser Testing

For visual/browser testing, sync into the clean SillyTavern test clone:

```powershell
$source = 'C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced'
$target = 'C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced'
robocopy $source $target /MIR /XD .git .superpowers node_modules /XF progress.md
```

Test URL: `http://127.0.0.1:8002/`

Playwright is in the clean clone, not this repo. Device targets: Chromium Pixel 5, WebKit iPhone 14.

## Current Work

Active branch: `codex-mobile-hybrid-shell` — mobile UI parity initiative.

Mobile tabs status:
- **Injection**: being redesigned (spec: `docs/superpowers/specs/2026-05-12-mobile-injection-tab-design.md`)
- **Browse**: functional with search, filters, cards, actions
- **Librarian**: proof-of-concept stub
- **Filters (gating)**: not yet implemented in mobile
- **Tools**: skeleton (4 of 16+ desktop tools)

Visual direction: glassmorphic redesign (spec: `docs/superpowers/specs/2026-05-14-mobile-glassmorphic-redesign.md`) — the FAB glass orb came from this.

Related specs/plans in `docs/superpowers/`.

## Gotchas

- `AGENT.md` is a synced copy of this file (Codex reads it). After editing `CLAUDE.md`, copy it over `AGENT.md` so both agents see the same context.
- Plan-doc checkbox state in `docs/superpowers/plans/` can lag behind the code — trust source and tests over plan markdown.
- `progress.md` is a local scratch handoff: intentionally untracked, excluded from the robocopy sync, and usually should not be committed.
