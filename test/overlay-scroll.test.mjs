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

const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');

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

section('overlay-mode: one scroller per tab');

test('tab panel is the single scroller and gets touch momentum', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel', '-webkit-overflow-scrolling:\\s*touch'),
        'overlay .dle-tab-panel must set -webkit-overflow-scrolling: touch');
});

test('Filters inner cap is lifted in overlay mode (scroller #3 retired)', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-gating-fields-container', 'max-height:\\s*none'),
        'overlay .dle-gating-fields-container must lift the max-height cap');
});

test('Browse: tab panel yields, virtualized list owns scroll', () => {
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-tab-panel[data-tab="browse"]', 'overflow:\\s*hidden'),
        'overlay browse tab panel must set overflow: hidden');
    assert(blockHas('#deeplore-panel.dle-overlay-mode .dle-browse-list', '-webkit-overflow-scrolling:\\s*touch'),
        'overlay .dle-browse-list must set -webkit-overflow-scrolling: touch');
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

test('base .dle-browse-list still owns virtual scroll with contained overscroll', () => {
    assert(blockHas('.dle-browse-list', 'overflow-y:\\s*auto'),
        'base .dle-browse-list must keep overflow-y: auto');
    assert(blockHas('.dle-browse-list', 'overscroll-behavior:\\s*contain'),
        'base .dle-browse-list must keep overscroll-behavior: contain');
});

await summary('Overlay Single-Scroller Tests');
