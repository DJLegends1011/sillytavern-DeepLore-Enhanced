# Contributing to DeepLore

## Development Setup

1. Clone the repo into your SillyTavern `public/scripts/extensions/third-party/` directory (the standard location for manually-installed extensions; `data/default-user/extensions/` also works for a single-user install). The extension's `manifest.json` must sit at the repo root.
2. Run tests: `npm test` (unit only) or `npm run test:all` (the full suite CI runs). Individual suites are exposed as `npm run test:<name>` — see the `scripts` block in `package.json`.
3. Verify imports after moving files: `npm run test:imports`
4. Lint: `npm run lint`

No build step — DLE ships as plain ES modules, no bundler. Edit a file, reload SillyTavern, and the change is live.

## Branch Strategy

- **`main`** — stable releases
- **`staging`** — active development (PRs target here)

## The `core/` Directory

`core/` contains shared utility modules (parsing, matching, formatting). It was historically shared with the original standalone `sillytavern-DeepLore` extension via git subtree, but that project is deprecated. `core/` is now owned entirely by DeepLore.

## Running Tests

Tests run in Node.js with no dependencies — just `node test/unit.mjs`. The test harness mocks SillyTavern globals (jQuery, toastr, etc.) so pure logic can be tested outside the browser.

## Tests

New code should include tests. Add unit tests in `test/unit.mjs` for any new pure functions or logic changes (or the matching feature-specific suite — `test/fields.test.mjs`, `test/vault.test.mjs`, etc.). All tests must pass before submitting a PR — CI (`.github/workflows/tests.yml`) runs `npm run test:all` followed by `npm run lint` on every push and PR to `main` and `staging`, so a red suite blocks the merge.

### Translations

Translation refinements have their own contributor guide — see [Contributing Translations](https://github.com/pixelnull/sillytavern-DeepLore/wiki/Contributing-Translations) (or `wiki/Contributing-Translations.md`). UI strings live in `locales/dle.{lang}.json`; AI prompts in `src/i18n/prompts/{lang}.js`. English is canonical; never edit `dle.en.json` / `prompts/en.js` in a translation PR. Run `npm run test:i18n` before pushing.

## Source Directory Structure

Code lives in two top-level directories:

- `core/` — pure, ST-free, Node-testable logic. `pipeline.js` holds `parseVaultFile` (the Markdown+YAML frontmatter parser — the authoritative entry-shape contract), `matching.js` (keyword/BM25/selective-logic), `sync.js`, `utils.js`. See "The `core/` Directory" above.
- `src/` — everything else, organized by feature area:
  - `pipeline/` — the generation-time pipeline (`pipeline.js` runs the stages; `match.js` does keyword/BM25 matching at runtime). Note: vault-file *parsing* lives in `core/pipeline.js`, not here.
  - `drawer/` — drawer UI panel and entry browser
  - `graph/` — relationship graph visualization
  - `librarian/` — Librarian AI assistant (Emma), agentic loop, tool definitions
  - `diagnostics/` — health check and debug utilities
  - `vault/` — Obsidian vault connection and sync
  - `ai/` — AI search, scribe, auto-suggest
  - `verdict/` — the Verdict store (per-turn decision record + IDB spill)
  - `i18n/` — localization: pure helpers, the ST-integrated loader, and `prompts/{lang}.js` AI-prompt dicts (UI strings live in `locales/dle.{lang}.json`)
  - `prompts/` — editable-prompt store + API
  - `ui/` — shared UI components and settings panels

## Code Style

- ES modules (`import`/`export`), no bundler
- 4-space indentation, LF line endings
- No TypeScript — use JSDoc annotations for type hints
- Prefer editing existing files over creating new ones
