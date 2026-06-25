# DeepLore Mobile Injection Tab Design

## Goal

Replace the proof-of-concept mobile "Why?" view with a fully functional Injection tab that matches the desktop drawer's Injection panel in features while fitting the mobile expandable-list UX pattern.

## Source Decisions

- User selected layout option **B. Expandable List** from `.superpowers/brainstorm/1117-1778644759/content/injection-tab-mockup.html`.
- User selected implementation approach **A. Rewrite renderWhy -> renderInjection** from `.superpowers/brainstorm/1117-1778644759/content/approaches.html`.
- User confirmed: same 3-way filter toggle as desktop (Injected / Filtered / Both).
- User confirmed: all entry info (title, tokens, badges, Obsidian link, Browse arrow) but compact.
- User confirmed: filtered-out entries use the same expandable card pattern, visually muted.
- User confirmed: Entry Timers as a collapsible section (like desktop).
- User confirmed: incremental approach — Injection tab first, other tabs in later passes.

## Architecture

### New file: `src/mobile/mobile-injection.js`

Pure helper module following the `mobile-browse.js` pattern. No DOM access, no side effects. Contains:

- **`normalizeMobileInjectionState(state?)`** — returns `{ filter: 'injected'|'filtered'|'both', expandedKey: '' }` with defaults applied. Same normalization pattern as `normalizeMobileBrowseState`.

- **`splitInjectionEntries(injectedSources, pipelineTrace, filterMode)`** — returns `{ entries: [], summary: string, isFiltered: boolean }`.
  - `'injected'`: only entries from `injectedSources`.
  - `'filtered'`: only entries from `pipelineTrace.filtered` (entries considered but excluded).
  - `'both'`: all entries, with an `isFiltered` flag on each.
  - Summary string: e.g. "3 injected" or "2 filtered out" or "3 injected, 2 filtered".

- **`buildMobileInjectionRows(entries, context)`** — maps each entry into a display-ready row object:
  - `key` — unique identifier for expand/collapse state
  - `title` — entry title
  - `tokenCount` — token count (number)
  - `tokenLabel` — formatted string (e.g. "217 tok")
  - `injectionCount` — how many times injected this generation
  - `matchedBy` — reason string ("keyword match", "AI search", "pinned", "constant", etc.)
  - `isKeyword` — boolean, true if matched by keyword (drives KEY badge)
  - `filename` — Obsidian filename for deep link
  - `vaultSource` — vault name for deep link
  - `isFiltered` — boolean, true if this entry was filtered out (drives muted styling)

- **`extractTimerData(pipelineTrace)`** — extracts active cooldowns, rotation timers, and minimum trigger counts from the pipeline trace. Returns an array of `{ title, timerType, remaining, detail }` objects, or empty array if no active timers.

### Modified file: `src/mobile/mobile-shell.js`

**State changes:**
- Add to `mobileState`: `injectionFilter: 'injected'`, `injectionExpandedKey: ''`
- Rename view key `'why'` to `'injection'` in all references (local views set, commandForView, renderBody switch)
- Update Home button: label "Why?" becomes "Injection", icon stays `fa-circle-question`

**Render changes:**
- Delete `renderWhy()`.
- Add `renderInjection(snapshot, state)` that produces:

  1. **Drill header**: back arrow, "Injection" title, badge with injected count, "Full View" button (fires `/dle-why`).

  2. **3-way filter toggle**: Injected / Filtered / Both pill buttons. Active state highlighted. Clicking sets `mobileState.injectionFilter` and re-renders.

  3. **Entry list**: rendered by `buildMobileInjectionRows()`.
     - Collapsed row: expand chevron, title (bold, accent color), inline badges (Nx injection count, KEY if keyword), token count on right.
     - Expanded row: match reason text, "Open in Obsidian" link, "Go to Browse" link.
     - Injected entries: warm accent left border (orange/gold).
     - Filtered entries: same structure, muted opacity (~0.6), neutral border color.

  4. **Entry Timers**: collapsible `<details>` section at the bottom. Shows timer rows from `extractTimerData()`, or "No active timers" empty state.

  5. **Empty state**: when no pipeline has run. Same guidance text as desktop: "No entries injected yet. Send a message mentioning a keyword..."

**Click handler additions:**
- Filter toggle: `[data-dle-mobile-injection-filter]` buttons update `mobileState.injectionFilter`.
- Entry expand: `[data-dle-mobile-injection-expand]` buttons toggle `mobileState.injectionExpandedKey`.
- Obsidian link: reuses existing `openMobileBrowseObsidian()` logic (rename or extract to shared helper).
- Browse jump: sets `mobileState.view = 'browse'` (optionally pre-filtering, but not required for v1).

### Modified file: `style.css`

New selectors following `dle-mobile-injection-*` naming:

- `.dle-mobile-injection-filters` — horizontal pill toggle row
- `.dle-mobile-injection-card` — entry card (base style, reuses Browse card spacing/radius)
- `.dle-mobile-injection-card.dle-mobile-injection-filtered` — muted variant for filtered-out entries
- `.dle-mobile-injection-expanded` — expanded card state
- `.dle-mobile-injection-badge` — inline badge (injection count, KEY)
- `.dle-mobile-injection-timers` — collapsible timers section

Reuse existing mobile theme variables and patterns. No new colors beyond what the theme already defines.

## Data Flow

No new data sources. The existing `buildMobileShellSnapshot()` already provides:
- `injectedSources` — from `lastInjectionSources` / `lastPipelineTrace.injected`
- `entries` — full vault index
- Pipeline trace for match reasons and timer data

The new `mobile-injection.js` helpers derive display state from these existing snapshot fields. The snapshot may need a minor addition to surface `lastPipelineTrace.filtered` if it's not already accessible (verify during implementation).

## Testing

Add tests in `test/mobile-ui.test.mjs` following existing patterns:

- `normalizeMobileInjectionState` — defaults, partial input, invalid input
- `splitInjectionEntries` — each filter mode, empty sources, missing trace
- `buildMobileInjectionRows` — row field mapping, KEY badge logic, token formatting, filtered flag
- `extractTimerData` — with timers, without timers, malformed trace
- `renderInjection` — HTML contract tests (header present, filter buttons present, entry cards render, timers section present, empty state)
- Verify "Why?" label no longer appears anywhere in mobile output

## Scope Boundaries

This spec covers only the mobile Injection tab. The following are explicitly deferred:

- Filters (gating) tab — separate future spec
- Tools tab expansion — separate future spec
- Home screen quick actions — separate future spec
- Recent Activity feed — separate future spec
- Footer/health indicators — separate future spec
