/**
 * DeepLore Enhanced — i18n HTML structural lint test.
 *
 * Guards against L1 (i18n parent-`data-i18n` destroys icon children).
 *
 * THE BUG: ST's `translateElement` translates an element whose `data-i18n`
 * value is a *plain text key* (no `[attr]` prefix) by setting the element's
 * `textContent`. Setting `textContent` DELETES all child nodes — including any
 * `<i class="fa…">` icon — on every locale, English included.
 *
 * THE INVARIANT this test enforces: no element may carry a plain text-key
 * `data-i18n` (a value whose first segment does NOT start with `[`) while it
 * ALSO contains an `<i …>` child element. The fix is the sibling-`<span>`
 * pattern: move the text key onto a `<span data-i18n="key">…</span>` child and
 * leave the `<i>` as an untouched sibling.
 *
 * SAFE (must NOT be flagged):
 *   - `data-i18n="[title]key"` / `data-i18n="[aria-label]key"` — attribute
 *     targeting writes the attribute, never textContent.
 *   - `data-i18n="dle_x;[aria-label]dle_y"` — leading segment is a text key
 *     BUT only flagged if the element also has an `<i>` child.
 *   - `data-i18n-html="key"` — separate mechanism (innerHTML), not in scope.
 *   - a text-key `data-i18n` on an element with NO `<i>` child (e.g. a plain
 *     `<span data-i18n>`, `<h2>`, `<button data-i18n>Text</button>`).
 *
 * Run: node test/i18n-html.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { test, section, summary, assert, assertEqual } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const HTML_FILES = ['drawer.html', 'setup-wizard.html', 'settings-popup.html'];

// ────────────────────────────────────────────────────────────────────────────
// Pure analysis helpers (exported-style locals so they're easy to unit-poke)
// ────────────────────────────────────────────────────────────────────────────

// Void elements never have children / a separate close tag.
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Does this `data-i18n` value contain a PLAIN TEXT KEY segment (vs. only
 * attribute-targeted segments)?
 *
 * ST's `translateElement` (public/scripts/i18n.js) splits the value on `;` and
 * processes EVERY segment: a `[attr]key` segment writes the attribute, while
 * ANY segment WITHOUT a `[attr]` prefix sets the element's `textContent`. So a
 * value like `[title]dle_x;dle_y` STILL destroys child icons (the `dle_y`
 * segment writes textContent), even though its leading segment is attr-targeted.
 * Therefore we flag if ANY non-empty segment lacks the `[attr]` prefix.
 * @param {string} value the raw data-i18n attribute value
 * @returns {boolean}
 */
function isPlainTextKey(value) {
    if (typeof value !== 'string') return false;
    return value.split(';').some(seg => {
        const s = seg.trim();
        return s !== '' && !s.startsWith('[');
    });
}

/**
 * 1-based line number for a string index.
 */
function lineAt(html, index) {
    let line = 1;
    for (let i = 0; i < index && i < html.length; i++) {
        if (html[i] === '\n') line++;
    }
    return line;
}

/**
 * Given the html and the index of the `<` that opens an element, return the
 * index just past that element's matching close tag (i.e. the end of its inner
 * content + close tag). Handles nesting of same-named tags. Returns the end of
 * the open tag for void / self-closing elements (they have no children).
 * @returns {{ tagName: string, innerStart: number, innerEnd: number, selfClosing: boolean }}
 */
function parseElement(html, openLtIndex) {
    const openTagEnd = html.indexOf('>', openLtIndex);
    if (openTagEnd === -1) {
        return { tagName: '', innerStart: openLtIndex, innerEnd: openLtIndex, selfClosing: true };
    }
    const openTag = html.slice(openLtIndex, openTagEnd + 1);
    const nameMatch = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(openTag);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';
    const selfClosing = /\/\s*>$/.test(openTag) || VOID_ELEMENTS.has(tagName);
    if (selfClosing || !tagName) {
        return { tagName, innerStart: openTagEnd + 1, innerEnd: openTagEnd + 1, selfClosing: true };
    }
    // Walk forward, tracking nesting depth of same-named tags.
    let depth = 1;
    let cursor = openTagEnd + 1;
    const innerStart = cursor;
    const openRe = new RegExp(`<\\s*${tagName}(?=[\\s/>])`, 'gi');
    const closeRe = new RegExp(`<\\s*/\\s*${tagName}\\s*>`, 'gi');
    while (depth > 0 && cursor < html.length) {
        openRe.lastIndex = cursor;
        closeRe.lastIndex = cursor;
        const nextOpen = openRe.exec(html);
        const nextClose = closeRe.exec(html);
        if (!nextClose) break; // malformed; bail
        if (nextOpen && nextOpen.index < nextClose.index) {
            // Skip nested open tag (and ensure it isn't self-closing void)
            const nestedTagEnd = html.indexOf('>', nextOpen.index);
            const nestedTag = html.slice(nextOpen.index, nestedTagEnd + 1);
            if (!/\/\s*>$/.test(nestedTag)) depth++;
            cursor = nestedTagEnd + 1;
        } else {
            depth--;
            cursor = nextClose.index + nextClose[0].length;
            if (depth === 0) {
                return { tagName, innerStart, innerEnd: nextClose.index, selfClosing: false };
            }
        }
    }
    // Unbalanced — treat remainder as inner content (defensive).
    return { tagName, innerStart, innerEnd: html.length, selfClosing: false };
}

/**
 * Scan an HTML string and return every violation: an element carrying a plain
 * text-key `data-i18n` whose inner content contains an `<i …>` child element.
 * @param {string} html
 * @param {string} fileLabel
 * @returns {Array<{file:string, line:number, key:string, tag:string}>}
 */
function findViolations(html, fileLabel) {
    const violations = [];
    // Match an opening tag that carries a data-i18n="…" attribute. We must NOT
    // match data-i18n-html (different attribute) — `data-i18n="` with the quote
    // right after the `=` excludes `data-i18n-html="`.
    const attrRe = /<[a-zA-Z][^>]*?\sdata-i18n\s*=\s*"([^"]*)"[^>]*>/g;
    let m;
    while ((m = attrRe.exec(html)) !== null) {
        const value = m[1];
        if (!isPlainTextKey(value)) continue;
        const openLt = m.index;
        const { tagName, innerStart, innerEnd, selfClosing } = parseElement(html, openLt);
        if (selfClosing) continue; // no children possible
        const inner = html.slice(innerStart, innerEnd);
        // An `<i>` *child* — opening tag `<i` followed by whitespace, `>` or `/`.
        if (/<i(?=[\s/>])/i.test(inner)) {
            violations.push({
                file: fileLabel,
                line: lineAt(html, openLt),
                key: value,
                tag: tagName,
            });
        }
    }
    return violations;
}

// ────────────────────────────────────────────────────────────────────────────
// Self-tests for the analyzer (so the lint logic itself is trustworthy)
// ────────────────────────────────────────────────────────────────────────────

section('i18n-html — analyzer self-tests');

test('isPlainTextKey distinguishes text keys from attr-targeted keys', () => {
    assert(isPlainTextKey('dle_foo'), 'bare key is a text key');
    assert(isPlainTextKey('dle_foo;[aria-label]dle_bar'), 'leading text key counts');
    assert(isPlainTextKey('[title]dle_foo;dle_bar'), 'trailing text-key segment counts (ST processes all segments)');
    assert(!isPlainTextKey('[title]dle_foo'), 'attr-targeted is not a text key');
    assert(!isPlainTextKey('[aria-label]dle_foo;[title]dle_bar'), 'all-attr is not a text key');
    assert(!isPlainTextKey(''), 'empty is not a text key');
});

test('findViolations flags an [attr];text-key combo with an <i> child', () => {
    const bad = '<button data-i18n="[title]dle_tip;dle_lbl" title="x"><i class="fa-x"></i> Label</button>';
    const v = findViolations(bad, 'inline');
    assertEqual(v.length, 1, 'trailing text-key segment destroys the icon → flagged');
});

test('findViolations flags a text-key data-i18n with an <i> child', () => {
    const bad = '<button data-i18n="dle_x"><i class="fa-solid fa-plus"></i> Text</button>';
    const v = findViolations(bad, 'inline');
    assertEqual(v.length, 1, 'one violation for icon child + text key');
    assertEqual(v[0].tag, 'button', 'button flagged');
});

test('findViolations ignores attr-targeted data-i18n even with <i> child', () => {
    const ok = '<button data-i18n="[title]dle_x" title="x"><i class="fa-solid fa-plus"></i> <span data-i18n="dle_lbl">Text</span></button>';
    const v = findViolations(ok, 'inline');
    assertEqual(v.length, 0, 'attr-targeted parent is safe; span sibling is text-only');
});

test('findViolations ignores text-key data-i18n with NO <i> child', () => {
    const ok = '<span data-i18n="dle_x">Plain Text</span>';
    const v = findViolations(ok, 'inline');
    assertEqual(v.length, 0, 'plain text element is safe');
});

test('findViolations ignores data-i18n-html', () => {
    const ok = '<li data-i18n-html="dle_x"><strong>Bold</strong> <i class="fa-solid fa-x"></i></li>';
    const v = findViolations(ok, 'inline');
    assertEqual(v.length, 0, 'data-i18n-html is a different mechanism');
});

test('findViolations handles nested same-named tags (no false close)', () => {
    const ok = '<div data-i18n="dle_x"><div>nested</div></div>';
    const v = findViolations(ok, 'inline');
    assertEqual(v.length, 0, 'no <i> child despite nesting');
    const bad = '<div data-i18n="dle_x"><div>nested</div><i class="fa-x"></i></div>';
    const v2 = findViolations(bad, 'inline');
    assertEqual(v2.length, 1, 'icon after nested div still flagged');
});

// ────────────────────────────────────────────────────────────────────────────
// The real guard: scan the shipped HTML files.
// ────────────────────────────────────────────────────────────────────────────

section('i18n-html — no icon-destroying data-i18n in shipped HTML');

let totalViolations = 0;
for (const rel of HTML_FILES) {
    const abs = join(ROOT, rel);
    const html = readFileSync(abs, 'utf8');
    const violations = findViolations(html, rel);
    totalViolations += violations.length;
    test(`${rel} — no plain text-key data-i18n on an element with an <i> child`, () => {
        if (violations.length > 0) {
            for (const v of violations) {
                console.error(`    VIOLATION ${v.file}:${v.line} <${v.tag} data-i18n="${v.key}"> has an <i> child`);
            }
        }
        assertEqual(violations.length, 0, `${rel} has ${violations.length} icon-destroying data-i18n element(s)`);
    });
}

test('total violations across all HTML files is zero', () => {
    assertEqual(totalViolations, 0, `expected 0 violations, found ${totalViolations}`);
});

await summary('i18n-html structural lint');
