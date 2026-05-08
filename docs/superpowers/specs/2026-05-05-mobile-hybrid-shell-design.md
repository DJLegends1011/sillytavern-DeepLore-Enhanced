# DeepLore Mobile Hybrid Shell Design

## Goal

Build DeepLore's mobile experience as a separate responsive shell that activates by pixel width, keeps the desktop drawer untouched, and follows the selected brainstorm direction: **C. Hybrid Dock + Drill-In**.

## Source Decisions

- Brainstorm artifact: `.superpowers/brainstorm/15680-1777886675/content/mobile-shell-options.html`
- Recorded choice: `.superpowers/brainstorm/15680-1777886675/state/events` shows repeated `"choice":"hybrid"` clicks.
- Selected shape: compact chat overlay for live status and quick actions, with full-screen drill-in pages for Browse, Librarian, Graph, and Settings.
- CharacterLibrary reference pattern: use `768px` as the mobile breakpoint and load/activate mobile UI only when the viewport matches mobile width.

## Activation Model

The mobile shell activates from a mobile detector centered on pixel width:

- `viewportWidth <= 768` enables mobile shell.
- SillyTavern's own mobile flag also enables it.
- Coarse pointer devices up to `1024px` enable it for small tablets.
- `localStorage.dleMobileUiForce === "1"` forces it on.
- `localStorage.dleMobileUiDisabled === "1"` disables it and wins over force.

The existing desktop drawer remains mounted for desktop layouts. When mobile shell is active, `body.dle-mobile-ui-active #deeplore-drawer` stays hidden so the user does not get two DeepLore surfaces.

## Mobile UI Shape

The first usable mobile shell should be hybrid, not a full rewrite of every DeepLore popup:

- A fixed compact dock floats above SillyTavern's message input.
- Tapping the dock opens a bottom sheet over chat.
- The sheet home view shows status, vault count, injected-source count, gap count, and four drill-in buttons.
- Local drill-ins render inside the sheet for:
  - Home
  - Why
  - Browse
  - Librarian
  - Tools
- Tool actions that already have mature desktop popups use slash commands for now:
  - Health: `/dle-health`
  - Filters/context state: `/dle-context-state`
  - Graph: `/dle-graph`
  - Setup: `/dle-setup`
  - Full Why: `/dle-why`
  - Full Browse: `/dle-browse`

This gives mobile users a fast overlay for common context checks while preserving the current full feature surfaces.

## Layout Requirements

- Dock must stay above ST's mobile input bar and respect safe-area insets.
- Sheet must use `max-height` based on `dvh`, internal scrolling, and no nested card-in-card layout.
- Tap targets must be at least `40px`, preferably `44px`, except small purely decorative counters.
- Text must truncate or wrap inside containers without horizontal overflow.
- Full-screen drill-in pages are allowed in a later phase, but this plan should keep initial drill-ins as sheet views unless a command opens an existing popup.

## State And Data Flow

The mobile shell reads existing DeepLore state from `src/state.js`:

- `vaultIndex`
- `indexing`
- `indexEverLoaded`
- `generationLock`
- `lastInjectionSources`
- `loreGaps`
- `pipelinePhase`

The shell subscribes to existing state events and re-renders itself on relevant updates. It does not own vault or pipeline data.

## Preference Controls

The initial code already supports localStorage flags, but the mobile UI still needs visible controls:

- Add a small mode control in the mobile Tools view.
- Modes: Auto, Force Mobile, Disable Mobile.
- Auto clears both localStorage flags.
- Force sets `dleMobileUiForce=1` and clears disable.
- Disable sets `dleMobileUiDisabled=1` and clears force, then hides mobile UI after render.

## Error Handling

- If SillyTavern command execution is unavailable, show a visible mobile error message instead of only logging a warning.
- If refresh/index build is triggered and `buildIndex` throws or rejects, show a visible mobile error message and keep the sheet open.
- Empty states should be explicit:
  - Why: no lore injected yet.
  - Browse: no entries loaded.
  - Librarian: no open gaps.

## Testing Strategy

Extend `test/mobile-ui.test.mjs` with unit-style contracts for:

- Pixel-width activation and force/disable precedence.
- Rendered dock and sheet states.
- Drill-in views for Why, Browse, Librarian, and Tools.
- Preference control rendering and storage-key names.
- Command buttons carrying the correct slash commands.
- CSS contracts for mobile dock placement, bottom sheet max height, safe-area spacing, and drawer hiding.

Use the clean test clone at `http://127.0.0.1:8002/` for browser verification:

- Sync extension into `public/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced`.
- Use Playwright Chromium Pixel 5 screenshots for shell open/home/drill-in/tools states.
- Use WebKit iPhone screenshot for at least dock and home sheet sanity.

## Out Of Scope For This Plan

- Rebuilding Graph as a native mobile canvas view.
- Rebuilding every desktop popup as a native mobile page.
- Changing desktop drawer behavior.
- Persisting mobile UI settings into DeepLore extension settings instead of localStorage.
- Real Obsidian or AI integration during mobile shell visual tests.

## Self-Review

- No unresolved placeholders remain.
- The scope is one subsystem: mobile hybrid shell activation and first usable sheet/drill-in experience.
- Existing desktop behavior is explicitly preserved.
- The plan can be tested without real Obsidian or AI by using rendered HTML tests and the clean SillyTavern clone.
