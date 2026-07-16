/**
 * Overlay-mode single-scroller invariants (Issue #39, overlay single-scroller).
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

const testDir = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (...parts) => readFileSync(join(testDir, '..', ...parts), 'utf8');
const css = readRepoFile('style.css');
const drawerState = readRepoFile('src', 'drawer', 'drawer-state.js');
const drawerEvents = readRepoFile('src', 'drawer', 'drawer-events.js');
const drawerJs = readRepoFile('src', 'drawer', 'drawer.js');
const drawerRenderTabs = readRepoFile('src', 'drawer', 'drawer-render-tabs.js');

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
test('overlay mode never overrides SillyTavern closedDrawer display state', () => {
    assert(!blockHas('#deeplore-panel.dle-overlay-mode', 'display:\\s*(?:flex|block|grid)'),
        'overlay selector must not force display; closedDrawer owns visibility');
});

section('overlay-mode: close button follows the canonical toggle path');

test('close button delegates to drawer-toggle click handling', () => {
    const closeStart = drawerJs.indexOf("$drawer.find('#dle-drawer-close').on('click'");
    const closeEnd = drawerJs.indexOf('\n    });', closeStart) + '\n    });'.length;
    const closeSource = drawerJs.slice(closeStart, closeEnd);
    assert(closeStart >= 0 && closeSource.includes("$drawer.find('.drawer-toggle').trigger('click')"),
        'close button must use the canonical toggle handler so ARIA and overlay cleanup stay synchronized');
    assert(!closeSource.includes('doNavbarIconClick.call'),
        'close button must not bypass the drawer-toggle click handler');
});

section('overlay-mode: one scroller per tab');

test('tab panel is the single scroller and gets touch momentum', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel', '-webkit-overflow-scrolling:\\s*touch'),
        'overlay .dle-tab-panel must set -webkit-overflow-scrolling: touch');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel', 'touch-action:\\s*pan-y'),
        'overlay .dle-tab-panel must accept vertical touch gestures');
});

test('Filters inner cap is lifted in overlay mode (scroller #3 retired)', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-gating-fields-container', 'max-height:\\s*none'),
        'overlay .dle-gating-fields-container must lift the max-height cap');
});

test('Browse runtime: tab panel owns scroll and virtual list flows inside it', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel', 'overflow-y:\\s*auto'),
        'overlay Browse tab panel must own vertical scroll');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-browse-list', 'overflow:\\s*visible'),
        'overlay Browse list must not create a nested scroll viewport');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-browse-list', 'flex:\\s*0\\s+0\\s+auto'),
        'overlay Browse list must preserve its virtual min-height in panel flow');
    assert(drawerState.includes('BROWSE_OVERLAY_SCROLL_SELECTOR')
        && drawerState.includes('BROWSE_INLINE_SCROLL_SELECTOR')
        && drawerState.includes('BROWSE_SCROLL_TARGETS')
        && drawerState.includes("BROWSE_INLINE_SCROLL_SELECTOR = '.dle-drawer-inner'"),
    'drawer-state must define both responsive scroll owners and the shared binding selector');
    assert(drawerRenderTabs.includes("hasClass('dle-overlay-mode')")
        && drawerRenderTabs.includes('BROWSE_OVERLAY_SCROLL_SELECTOR')
        && drawerRenderTabs.includes('BROWSE_INLINE_SCROLL_SELECTOR'),
    'Browse viewport math must choose the tab panel only in overlay mode');
    assert(drawerRenderTabs.includes('$drawer.find(BROWSE_SCROLL_TARGETS)'),
        'Browse filter reset must clear both responsive scroll owners');
    const wireStart = drawerEvents.indexOf('export function wireBrowseTab');
    const wireEnd = drawerEvents.indexOf('\nexport function', wireStart + 1);
    const wireSource = drawerEvents.slice(wireStart, wireEnd);
    assert(wireSource.includes('$drawer.find(BROWSE_SCROLL_TARGETS)'),
        'Browse scroll listener must bind both responsive owners through the shared selector');
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

test('base .dle-browse-list remains scroll-capable for the inline layout', () => {
    assert(blockHas('.dle-browse-list', 'overflow-y:\\s*auto'),
        'base .dle-browse-list must keep overflow-y: auto');
    assert(blockHas('.dle-browse-list', 'overscroll-behavior:\\s*contain'),
        'base .dle-browse-list must keep overscroll-behavior: contain');
});

await summary('Overlay Single-Scroller Tests');
