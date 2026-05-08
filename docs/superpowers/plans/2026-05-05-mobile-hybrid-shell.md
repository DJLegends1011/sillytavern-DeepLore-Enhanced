# Mobile Hybrid Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build DeepLore's selected hybrid mobile shell as a separate pixel-width responsive UI that leaves desktop drawer behavior untouched.

**Architecture:** Extend the existing `src/mobile/mobile-shell.js` foundation rather than creating a parallel app. Keep mobile detection, snapshot creation, HTML rendering, click handling, command dispatch, and localStorage preference handling in this focused module, with CSS contracts in `style.css` and tests in `test/mobile-ui.test.mjs`.

**Tech Stack:** SillyTavern extension JavaScript modules, vanilla DOM rendering, existing DeepLore state subscriptions, `node test/mobile-ui.test.mjs`, Playwright in the clean SillyTavern clone.

---

## File Structure

- Modify `src/mobile/mobile-shell.js`
  - Owns mobile detector, snapshot projection, rendered shell HTML, preference mode helpers, click handling, and visible mobile error state.
- Modify `style.css`
  - Owns the mobile dock/sheet presentation, safe-area placement, mobile drawer hiding, tap targets, and responsive constraints.
- Modify `test/mobile-ui.test.mjs`
  - Owns contract tests for detector, rendering, preferences, commands, and CSS.
- Modify `progress.md`
  - Local ignored breadcrumb for completed task status and verification output.
- Create temporary verification script in `C:\tmp` only when running Playwright screenshots.
  - Keeps repo clean while producing evidence images.

---

### Task 1: Lock The Detector And Preference Contract

**Files:**
- Modify: `test/mobile-ui.test.mjs`
- Modify: `src/mobile/mobile-shell.js`

- [x] **Step 1: Write failing detector/preference tests**

Add this import to `test/mobile-ui.test.mjs`:

```js
import {
    MOBILE_VIEWPORT_WIDTH,
    TOUCH_TABLET_WIDTH,
    MOBILE_FORCE_STORAGE_KEY,
    MOBILE_DISABLE_STORAGE_KEY,
} from '../src/mobile/mobile-shell.js';
```

Add this test after the existing `normalizeMobilePreference` test:

```js
test('mobile detector constants: match CharacterLibrary-width shell contract', () => {
    assertEqual(MOBILE_VIEWPORT_WIDTH, 768, 'mobile shell should key off the 768px CharacterLibrary-style breakpoint');
    assertEqual(TOUCH_TABLET_WIDTH, 1024, 'coarse pointer tablet support should stop at 1024px');
    assertEqual(MOBILE_FORCE_STORAGE_KEY, 'dleMobileUiForce', 'force key should stay stable for browser overrides');
    assertEqual(MOBILE_DISABLE_STORAGE_KEY, 'dleMobileUiDisabled', 'disable key should stay stable for browser overrides');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
FAIL: mobile detector constants...
```

because those constants are not exported yet.

- [x] **Step 3: Export detector constants**

In `src/mobile/mobile-shell.js`, replace the current constant declarations:

```js
const MOBILE_VIEWPORT_WIDTH = 768;
const TOUCH_TABLET_WIDTH = 1024;
const ROOT_ID = 'dle-mobile-root';
const FORCE_KEY = 'dleMobileUiForce';
const DISABLE_KEY = 'dleMobileUiDisabled';
```

with:

```js
export const MOBILE_VIEWPORT_WIDTH = 768;
export const TOUCH_TABLET_WIDTH = 1024;
export const MOBILE_FORCE_STORAGE_KEY = 'dleMobileUiForce';
export const MOBILE_DISABLE_STORAGE_KEY = 'dleMobileUiDisabled';

const ROOT_ID = 'dle-mobile-root';
const FORCE_KEY = MOBILE_FORCE_STORAGE_KEY;
const DISABLE_KEY = MOBILE_DISABLE_STORAGE_KEY;
```

- [x] **Step 4: Run test to verify it passes**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
Mobile UI foundation tests: 35 passed, 0 failed
```

The exact total may differ if adjacent tests were added, but failures must be `0`.

- [x] **Step 5: Commit scope later**

When the full feature slice is ready, include these files in the commit:

```powershell
git add src/mobile/mobile-shell.js test/mobile-ui.test.mjs
git commit -m "Add mobile shell detector contract"
```

---

### Task 2: Render The Hybrid Dock And Sheet States

**Files:**
- Modify: `test/mobile-ui.test.mjs`
- Modify: `src/mobile/mobile-shell.js`

- [x] **Step 1: Write failing render tests for closed/open shell**

Replace the existing `renderMobileShell: renders dock, sheet, and quick actions` test with:

```js
test('renderMobileShell: renders hybrid dock, home sheet, and quick actions', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '12 entries',
        injectedCount: 2,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, { open: true, view: 'home', mode: 'auto', errorMessage: '' });

    assertMatch(html, /id="dle-mobile-root"/, 'shell root should be rendered');
    assertMatch(html, /class="dle-mobile-dock[^"]*dle-mobile-open"/, 'dock should expose open state');
    assertMatch(html, /id="dle-mobile-sheet"/, 'bottom sheet should be rendered');
    assertMatch(html, /data-dle-mobile-view="why"/, 'why drill-in action should be rendered');
    assertMatch(html, /data-dle-mobile-view="browse"/, 'browse drill-in action should be rendered');
    assertMatch(html, /data-dle-mobile-view="librarian"/, 'librarian drill-in action should be rendered');
    assertMatch(html, /data-dle-mobile-view="tools"/, 'tools drill-in action should be rendered');
    assert(!/data-dle-mobile-view="why"[^>]*data-dle-mobile-command/.test(html), 'home Why action should drill in before opening the full popup');
});
```

Add a closed-state test:

```js
test('renderMobileShell: closed shell keeps sheet mounted and collapsed', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '0 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, { open: false, view: 'home', mode: 'auto', errorMessage: '' });

    assertMatch(html, /aria-expanded="false"/, 'dock should report closed state');
    assertMatch(html, /id="dle-mobile-sheet"/, 'sheet should remain mounted for animation and accessibility');
    assert(!/dle-mobile-sheet dle-mobile-open/.test(html), 'sheet should not have open class while closed');
});
```

- [x] **Step 2: Run test to verify it fails if state shape is incomplete**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
FAIL
```

if the current renderer does not preserve all required state/class contracts.

- [x] **Step 3: Update default mobile state shape**

In `src/mobile/mobile-shell.js`, replace:

```js
let mobileState = {
    open: false,
    view: 'home',
    active: false,
};
```

with:

```js
let mobileState = {
    open: false,
    view: 'home',
    active: false,
    mode: 'auto',
    errorMessage: '',
};
```

Replace the reset at the bottom of `destroyMobileShell()`:

```js
mobileState = { open: false, view: 'home', active: false };
```

with:

```js
mobileState = { open: false, view: 'home', active: false, mode: 'auto', errorMessage: '' };
```

- [x] **Step 4: Make renderer tolerate missing arrays**

In `renderMobileShellContents`, before returning the template, keep the current `openClass` and add:

```js
const mode = state.mode || 'auto';
const errorMessage = state.errorMessage || '';
```

Change the body line:

```js
<div class="dle-mobile-body">${renderBody(snapshot, state.view)}</div>
```

to:

```js
<div class="dle-mobile-body">
    ${errorMessage ? `<div class="dle-mobile-error" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
    ${renderBody(snapshot, state.view, mode)}
</div>
```

Change `renderBody(snapshot, view)` to:

```js
function renderBody(snapshot, view, mode = 'auto') {
    switch (view) {
        case 'why': return renderWhy(snapshot);
        case 'browse': return renderBrowse(snapshot);
        case 'librarian': return renderLibrarian(snapshot);
        case 'tools': return renderTools(mode);
        default: return renderHome(snapshot);
    }
}
```

- [x] **Step 5: Run test to verify it passes**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
0 failed
```

---

### Task 3: Add Visible Mobile Mode Controls

**Files:**
- Modify: `test/mobile-ui.test.mjs`
- Modify: `src/mobile/mobile-shell.js`

- [x] **Step 1: Write failing mode-control render test**

Add this test after the render tests:

```js
test('renderMobileShell: tools view exposes mobile mode controls', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '3 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, { open: true, view: 'tools', mode: 'forced', errorMessage: '' });

    assertMatch(html, /data-dle-mobile-mode="auto"/, 'tools should offer auto mode');
    assertMatch(html, /data-dle-mobile-mode="forced"/, 'tools should offer force mobile mode');
    assertMatch(html, /data-dle-mobile-mode="disabled"/, 'tools should offer disable mobile mode');
    assertMatch(html, /aria-pressed="true"[^>]*data-dle-mobile-mode="forced"|data-dle-mobile-mode="forced"[^>]*aria-pressed="true"/, 'current mode should be marked pressed');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
FAIL: tools should offer auto mode
```

- [x] **Step 3: Add mode helper render function**

Add this function above `renderTools()` in `src/mobile/mobile-shell.js`:

```js
function renderModeButton(label, mode, activeMode) {
    const pressed = mode === activeMode ? 'true' : 'false';
    return `
        <button class="dle-mobile-mode-btn" type="button" data-dle-mobile-mode="${escapeHtml(mode)}" aria-pressed="${pressed}">
            ${escapeHtml(label)}
        </button>
    `;
}
```

Replace `function renderTools() {` with `function renderTools(mode = 'auto') {`.

Inside `renderTools`, after the refresh button, add:

```js
        <div class="dle-mobile-mode-group" aria-label="Mobile UI mode">
            <span>Mobile UI</span>
            <div>
                ${renderModeButton('Auto', 'auto', mode)}
                ${renderModeButton('Force', 'forced', mode)}
                ${renderModeButton('Off', 'disabled', mode)}
            </div>
        </div>
```

- [x] **Step 4: Add preference state reader**

Add this function after `readMobileEnvironment()`:

```js
function readMobileMode() {
    const env = readMobileEnvironment();
    return normalizeMobilePreference({ force: env.force, disabled: env.disabled });
}
```

In `renderCurrentState()`, after `mobileState.active = active;`, add:

```js
mobileState.mode = normalizeMobilePreference({ force: env.force, disabled: env.disabled });
```

- [x] **Step 5: Run test to verify it passes**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
0 failed
```

---

### Task 4: Implement Mobile Mode Click Handling

**Files:**
- Modify: `test/mobile-ui.test.mjs`
- Modify: `src/mobile/mobile-shell.js`

- [x] **Step 1: Write failing source contract test for mode storage**

Add this test after the mode-control render test:

```js
test('mobile mode handling: writes force and disable storage keys', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /function setMobileMode\(mode\)/, 'mobile shell should have a setMobileMode helper');
    assertMatch(source, /localStorage\.setItem\(MOBILE_FORCE_STORAGE_KEY,\s*'1'\)/, 'forced mode should set force key');
    assertMatch(source, /localStorage\.setItem\(MOBILE_DISABLE_STORAGE_KEY,\s*'1'\)/, 'disabled mode should set disable key');
    assertMatch(source, /localStorage\.removeItem\(MOBILE_FORCE_STORAGE_KEY\)/, 'auto mode should clear force key');
    assertMatch(source, /localStorage\.removeItem\(MOBILE_DISABLE_STORAGE_KEY\)/, 'auto mode should clear disable key');
    assertMatch(source, /target\.closest\('\[data-dle-mobile-mode\]'\)/, 'click handler should route mode buttons');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
FAIL: mobile shell should have a setMobileMode helper
```

- [x] **Step 3: Implement storage helper**

Add this function after `readMobileMode()`:

```js
function setMobileMode(mode) {
    try {
        if (mode === 'forced') {
            localStorage.setItem(MOBILE_FORCE_STORAGE_KEY, '1');
            localStorage.removeItem(MOBILE_DISABLE_STORAGE_KEY);
            return 'forced';
        }
        if (mode === 'disabled') {
            localStorage.setItem(MOBILE_DISABLE_STORAGE_KEY, '1');
            localStorage.removeItem(MOBILE_FORCE_STORAGE_KEY);
            return 'disabled';
        }
        localStorage.removeItem(MOBILE_FORCE_STORAGE_KEY);
        localStorage.removeItem(MOBILE_DISABLE_STORAGE_KEY);
        return 'auto';
    } catch (err) {
        mobileState.errorMessage = `Could not save mobile mode: ${err.message || err}`;
        return readMobileMode();
    }
}
```

- [x] **Step 4: Route mode clicks**

In `handleMobileClick(event)`, after the action block and before refresh handling, add:

```js
    const modeEl = target.closest('[data-dle-mobile-mode]');
    if (modeEl) {
        const mode = modeEl.getAttribute('data-dle-mobile-mode') || 'auto';
        mobileState.mode = setMobileMode(mode);
        if (mobileState.mode === 'disabled') {
            mobileState.open = false;
        } else {
            mobileState.open = true;
        }
        renderCurrentState();
        return;
    }
```

- [x] **Step 5: Run test to verify it passes**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
0 failed
```

---

### Task 5: Add Visible Error Handling For Commands And Refresh

**Files:**
- Modify: `test/mobile-ui.test.mjs`
- Modify: `src/mobile/mobile-shell.js`

- [x] **Step 1: Write failing error rendering and source tests**

Add this test:

```js
test('renderMobileShell: shows mobile error alert when command or refresh fails', () => {
    const html = renderMobileShell({
        statusLabel: 'Ready',
        entriesLabel: '0 entries',
        injectedCount: 0,
        gapCount: 0,
        phaseLabel: 'idle',
        entries: [],
        injectedSources: [],
        loreGaps: [],
    }, { open: true, view: 'home', mode: 'auto', errorMessage: 'Command unavailable' });

    assertMatch(html, /class="dle-mobile-error"/, 'error banner should render');
    assertMatch(html, /role="alert"/, 'error banner should announce itself');
    assertMatch(html, /Command unavailable/, 'error message should be visible');
});
```

Add this source contract:

```js
test('mobile shell commands: set visible errors when command execution is unavailable', () => {
    const source = readFileSync(new URL('../src/mobile/mobile-shell.js', import.meta.url), 'utf8');

    assertMatch(source, /function setMobileError\(message\)/, 'mobile shell should centralize visible errors');
    assertMatch(source, /setMobileError\(`Cannot execute \$\{command\}`\)/, 'missing command context should set a visible error');
    assertMatch(source, /Promise\.resolve\(mobileShellOptions\.buildIndex\?\.\(\)\)[\s\S]*catch/m, 'refresh should catch buildIndex failures');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
FAIL
```

for missing error helper or refresh catch.

- [x] **Step 3: Add error helper**

Add this function before `executeCommand(command)`:

```js
function setMobileError(message) {
    mobileState.errorMessage = message || '';
    if (mobileState.errorMessage) mobileState.open = true;
}
```

At the top of `executeCommand(command)`, replace `if (!command) return;` with:

```js
if (!command) {
    setMobileError('No mobile command is configured for this action.');
    renderCurrentState();
    return;
}
```

In the `else` branch of `executeCommand`, replace the warning-only block:

```js
console.warn('[DLE] Cannot execute mobile command; SillyTavern context unavailable:', command);
```

with:

```js
console.warn('[DLE] Cannot execute mobile command; SillyTavern context unavailable:', command);
setMobileError(`Cannot execute ${command}`);
renderCurrentState();
```

- [x] **Step 4: Catch command and refresh failures**

In the `ctx.executeSlashCommands(command).catch(...)` handler, add:

```js
setMobileError(`Command failed: ${command}`);
renderCurrentState();
```

In the refresh click block, replace:

```js
mobileShellOptions.buildIndex?.();
```

with:

```js
Promise.resolve(mobileShellOptions.buildIndex?.()).catch(err => {
    console.error('[DLE] Mobile refresh error:', err);
    setMobileError(`Refresh failed: ${err?.message || err}`);
    renderCurrentState();
});
```

At the start of successful local navigation blocks, clear stale errors with:

```js
mobileState.errorMessage = '';
```

- [x] **Step 5: Run test to verify it passes**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
0 failed
```

---

### Task 6: Tighten Mobile CSS For Hybrid Shell

**Files:**
- Modify: `test/mobile-ui.test.mjs`
- Modify: `style.css`

- [x] **Step 1: Write failing CSS contract test**

Add this test near the existing setup wizard CSS tests:

```js
test('mobile shell CSS: positions dock and sheet safely over chat', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

    assertMatch(css, /#dle-mobile-root[\s\S]*position:\s*fixed/m, 'mobile root should be fixed over the ST viewport');
    assertMatch(css, /body\.dle-mobile-ui-active #deeplore-drawer[\s\S]*display:\s*none !important/m, 'desktop drawer should hide while mobile shell is active');
    assertMatch(css, /\.dle-mobile-dock[\s\S]*bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px\) \+ 76px\)/m, 'dock should sit above the ST input bar with safe area');
    assertMatch(css, /\.dle-mobile-sheet[\s\S]*max-height:\s*min\(78dvh,\s*620px\)/m, 'sheet should be bounded to mobile viewport height');
    assertMatch(css, /\.dle-mobile-mode-btn[\s\S]*min-height:\s*40px/m, 'mode buttons should be touch friendly');
    assertMatch(css, /\.dle-mobile-error[\s\S]*border/m, 'error banner styling should exist');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
FAIL
```

for missing mode button or error banner styling.

- [x] **Step 3: Add CSS for mode controls and errors**

In `style.css`, inside the mobile shell foundation block after `.dle-mobile-wide-action`, add:

```css
.dle-mobile-error {
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--dle-error, #ef5350) 50%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--dle-error, #ef5350) 14%, transparent);
    color: var(--SmartThemeBodyColor, #fff);
    font-size: 12px;
    line-height: 1.35;
}

.dle-mobile-mode-group {
    display: grid;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.16));
}

.dle-mobile-mode-group > span {
    color: var(--SmartThemeEmColor, #aaa);
    font-size: 12px;
}

.dle-mobile-mode-group > div {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
}

.dle-mobile-mode-btn {
    min-height: 40px;
    min-width: 0;
    border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.16));
    border-radius: 8px;
    background: color-mix(in srgb, var(--SmartThemeBodyColor, #fff) 7%, transparent);
    color: inherit;
    font-size: 12px;
    touch-action: manipulation;
}

.dle-mobile-mode-btn[aria-pressed="true"] {
    border-color: var(--SmartThemeQuoteColor, #d4a847);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor, #d4a847) 22%, transparent);
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```powershell
npm run test:mobile
```

Expected:

```text
0 failed
```

---

### Task 7: Browser Verify The Hybrid Shell In The Clean Clone

**Files:**
- Modify: `progress.md`
- Temporary: `C:\tmp\dle-mobile-shell-smoke.cjs`

- [x] **Step 1: Sync extension to clean SillyTavern clone**

Run from the extension repo:

```powershell
$src = "C:\Users\DJLegnds\Downloads\SillyTavern\extension\sillytavern-DeepLore-Enhanced"
$dst = "C:\Users\DJLegnds\Downloads\Dev projects\Extensions\base frontend\SillyTavern\public\scripts\extensions\third-party\sillytavern-DeepLore-Enhanced"
robocopy $src $dst /MIR /XD .git .superpowers node_modules /XF package-lock.json
if ($LASTEXITCODE -le 7) { exit 0 } else { exit $LASTEXITCODE }
```

Expected:

```text
FAILED    0
```

- [x] **Step 2: Create the Playwright smoke script**

Create `C:\tmp\dle-mobile-shell-smoke.cjs` with:

```js
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');

process.env.NODE_PATH = 'C:\\Users\\DJLegnds\\Downloads\\Dev projects\\Extensions\\base frontend\\SillyTavern\\node_modules';
Module._initPaths();

const { chromium, webkit, devices } = require('playwright');

const outDir = 'C:\\tmp\\dle-mobile-shell';
const url = 'http://127.0.0.1:8002/';

async function run(browserType, deviceName, label) {
    await fs.mkdir(outDir, { recursive: true });
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ ...devices[deviceName], reducedMotion: 'reduce' });
    await context.addInitScript(() => {
        localStorage.setItem('dle-wizard-completed', '1');
        localStorage.setItem('dleMobileUiForce', '1');
        localStorage.removeItem('dleMobileUiDisabled');
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.locator('#dle-mobile-root:not([hidden])').waitFor({ state: 'attached', timeout: 15000 });
    await page.screenshot({ path: path.join(outDir, `${label}-dock.png`), fullPage: false });
    await page.locator('[data-dle-mobile-action="toggle"]').click();
    await page.locator('#dle-mobile-sheet.dle-mobile-open').waitFor({ state: 'visible', timeout: 10000 });
    await page.screenshot({ path: path.join(outDir, `${label}-home.png`), fullPage: false });
    await page.locator('[data-dle-mobile-view="tools"]').click();
    await page.screenshot({ path: path.join(outDir, `${label}-tools.png`), fullPage: false });
    const result = await page.evaluate(() => {
        const root = document.querySelector('#dle-mobile-root');
        const sheet = document.querySelector('#dle-mobile-sheet');
        const dock = document.querySelector('.dle-mobile-dock');
        const drawer = document.querySelector('#deeplore-drawer');
        const rootRect = root?.getBoundingClientRect();
        const sheetRect = sheet?.getBoundingClientRect();
        const dockRect = dock?.getBoundingClientRect();
        return {
            rootVisible: !!root && !root.hidden,
            sheetVisible: !!sheetRect && sheetRect.bottom <= window.innerHeight && sheetRect.left >= 0 && sheetRect.right <= window.innerWidth,
            dockVisible: !!dockRect && dockRect.bottom <= window.innerHeight && dockRect.left >= 0 && dockRect.right <= window.innerWidth,
            drawerHidden: !drawer || getComputedStyle(drawer).display === 'none',
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            rootHeight: rootRect?.height || 0,
        };
    });
    await browser.close();
    return { label, ...result };
}

(async () => {
    const chromiumResult = await run(chromium, 'Pixel 5', 'chromium-pixel5');
    let webkitResult = null;
    try {
        webkitResult = await run(webkit, 'iPhone 14', 'webkit-iphone14');
    } catch (err) {
        webkitResult = { label: 'webkit-iphone14', error: err.message };
    }
    const report = { outDir, chromiumResult, webkitResult };
    await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
})();
```

- [x] **Step 3: Run the smoke script**

Run from the clean SillyTavern clone:

```powershell
node C:\tmp\dle-mobile-shell-smoke.cjs
```

Expected Chromium report:

```json
{
  "rootVisible": true,
  "sheetVisible": true,
  "dockVisible": true,
  "drawerHidden": true
}
```

If WebKit fails to launch in the custom harness, keep the Chromium evidence and capture a direct WebKit screenshot with:

```powershell
npx playwright screenshot --browser=webkit --device="iPhone 14" --wait-for-timeout=8000 http://127.0.0.1:8002/ C:\tmp\dle-mobile-shell\webkit-iphone14-direct.png
```

- [x] **Step 4: Update progress**

Add a line under `Latest Verification` in `progress.md`:

```markdown
- Mobile shell smoke report: `C:\tmp\dle-mobile-shell\report.json`
- Mobile shell screenshots: `C:\tmp\dle-mobile-shell\chromium-pixel5-dock.png`, `C:\tmp\dle-mobile-shell\chromium-pixel5-home.png`, `C:\tmp\dle-mobile-shell\chromium-pixel5-tools.png`
```

- [x] **Step 5: Commit scope later**

After tests and browser verification are green, commit:

```powershell
git add index.js package.json src/mobile/mobile-shell.js src/ui/setup-wizard.js style.css test/mobile-ui.test.mjs progress.md docs/superpowers/specs/2026-05-05-mobile-hybrid-shell-design.md docs/superpowers/plans/2026-05-05-mobile-hybrid-shell.md
git commit -m "Add hybrid mobile shell foundation"
```

If `progress.md` remains ignored, omit it from the commit command.

---

## Self-Review

- Spec coverage: detector constants, hybrid dock/sheet rendering, drill-ins, force/disable controls, visible errors, CSS, and browser verification each have a task.
- Placeholder scan: no task uses unresolved placeholders.
- Type consistency: mode names are `auto`, `forced`, and `disabled`; storage exports are `MOBILE_FORCE_STORAGE_KEY` and `MOBILE_DISABLE_STORAGE_KEY`; view names are `home`, `why`, `browse`, `librarian`, and `tools`.
- Scope check: plan does not rebuild Graph, settings, or all desktop popups as native mobile pages.
