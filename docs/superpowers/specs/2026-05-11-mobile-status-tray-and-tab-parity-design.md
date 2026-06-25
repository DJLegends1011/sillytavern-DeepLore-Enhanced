# DeepLore Mobile Status Tray And Tab Parity Design

## Goal

Continue the mobile hybrid shell by making it useful as a phone-native DeepLore surface, not only a shortcut launcher. The next phase has two parts:

- Add an expandable status tray so budget, entry, context, health, and AI stats remain available without dominating chat.
- Expand mobile drill-ins, starting with Browse, so they preserve the core desktop workflows in a layout that works on a narrow touchscreen.

## Source Decisions

- User selected the visual mockup option **B. Expandable Status Tray** from `.superpowers/brainstorm/codex-1778482136/content/stats-placement.html`.
- User screenshots showed the desktop Browse tab has search, syntax help, filters, quick filters, sort, entry status, and row actions, while mobile Browse currently shows only a short card list and a button to open the full Browse view.
- The existing mobile shell design remains **Hybrid Dock + Drill-In**. This phase improves local drill-ins before falling back to desktop popups.

## Status Tray

The mobile dock stays compact. The status tray lives inside the mobile sheet, directly under the header on Home and available from Tools when the user wants details.

Collapsed state:

- Shows one compact row with status, injected entries, and the strongest warning if present.
- Avoids taking over the first viewport when the user is just opening DeepLore quickly.
- Surfaces important alerts even while collapsed: no index, vault offline/degraded, active generation, high budget usage, or AI circuit failure.

Expanded state:

- Shows a compact stat grid:
  - Lore budget used versus configured budget.
  - Entry count used versus max entries.
  - Context used versus max context when available.
  - AI search calls, cached hits, and total AI tokens.
  - Vault/cache/pipeline health status.
- Uses existing state and helper logic where possible instead of inventing a second stats source.
- Can be toggled with a touch-friendly button and should remember only session state for now.

## Mobile Browse Parity

Mobile Browse should become a real working view. It should not copy the desktop virtual table one-for-one, because that table depends on horizontal density and tiny row actions.

The first Browse parity pass includes:

- Search input with the same query semantics as desktop:
  - bare tokens match title and keys
  - `tag:`, `folder:`, `key:`, `summary:`, and `field:name=value`
- Search help affordance with concise syntax examples.
- Filter controls for status, tag, folder, and sort.
- Quick filters for "Since last gen" and "Never injected".
- Result count summary when filters are active.
- Entry cards that show:
  - title
  - keywords or `(constant)`
  - vault/folder
  - priority or CONST
  - injected count when present
  - injected/pinned/blocked state
- Row actions as icon buttons: expand preview, pin/unpin, block/unblock, copy title, and open in Obsidian when possible.
- Expanded card preview with summary/content snippet, token count, custom fields, related entries, and Obsidian link.
- Empty states for no index and no matching filters, including a clear-filters action.

Browse filtering should be factored into mobile-testable pure helpers where practical so mobile and desktop do not drift.

## Other Drill-Ins

After Browse, the same phone-native parity approach should be applied incrementally:

- Why: keep injected/filtered/both filters, reasons, matched keys, and navigation into Browse.
- Librarian: keep flag/activity split, useful sorting, selection/bulk handling only if it remains ergonomic.
- Tools: keep command-backed actions, mobile mode controls, status tray details, and reset-position controls once drag placement lands.
- Filters/Gating: likely needs its own dedicated pass because it has editing workflows, chips, and impact counts.

Each drill-in should graduate from "peek list" to "common workflow surface" before replacing its desktop popup fallback.

## Layout Requirements

- The sheet remains bounded by mobile viewport height and scrolls internally.
- Controls use touch-friendly targets, with icon buttons for dense actions.
- Search and filters should wrap into stacked rows instead of creating horizontal overflow.
- Result cards should favor scannability over large marketing-style cards.
- The mobile dock and status tray must not block SillyTavern's message input or Android/iOS safe areas.

## State And Data Flow

The mobile shell continues to read existing DeepLore state. New derived mobile snapshot fields may include:

- `budgetUsed`, `budgetLimit`, `entriesLimit`, and budget warning level from the last pipeline trace and settings.
- `contextUsed`, `contextLimit`, `responseReserve`, and librarian extra tokens from drawer footer state where available.
- `aiSearchStats`, `lastHealthResult`, `indexTimestamp`, and circuit state for compact health metrics.
- Browse filter state owned by the mobile shell, separate from desktop drawer state unless a shared pure helper is extracted.

## Error Handling

- If a mobile command fails, the sheet shows a visible alert and stays open.
- If a filter produces no results, show the active filter summary and a clear action.
- If mobile Browse cannot derive a filter option, omit that option instead of showing a broken select.
- If Obsidian links cannot open in the browser context, show the same warning behavior used by desktop.

## Testing Strategy

Use test-first implementation.

Unit tests in `test/mobile-ui.test.mjs` should cover:

- Status tray collapsed and expanded rendering.
- Budget, entries, context, health, and AI stat formatting.
- Browse search semantics, status/tag/folder filters, quick filters, and sort order.
- Browse card actions rendering with pinned, blocked, injected, constant, and normal entries.
- Browse empty states and clear-filter behavior.
- CSS contracts for status tray, compact controls, card bounds, and no horizontal overflow.

Browser testing should cover the clean clone at `http://127.0.0.1:8002/`:

- Chromium Pixel viewport screenshots for Home with collapsed and expanded status tray.
- Chromium Pixel Browse flow: search, filter, quick filter, expand entry, pin/block/copy controls where possible.
- WebKit iPhone viewport screenshots for Home and Browse.
- Existing Tools/Home smoke tests should continue to pass.

## Out Of Scope For This Phase

- Rebuilding Graph as native mobile.
- Full mobile parity for every tab in one commit.
- Persisting mobile Browse filters across sessions.
- Replacing mature desktop popups entirely.
- Real Obsidian writes during mobile browser tests.

## Self-Review

- No unresolved placeholders remain.
- The scope is focused on the next mobile phase: status tray plus Browse-first tab parity.
- Desktop drawer behavior remains preserved.
- The design allows incremental implementation and browser verification while the user tests on an actual phone.
