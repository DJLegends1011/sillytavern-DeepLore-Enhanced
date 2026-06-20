/**
 * DeepLore — Caveman text compressor (#18).
 *
 * Pure utility for shrinking lore prose at import time. Drops words that
 * carry low information density (articles, fillers, pleasantries) without
 * changing meaning. Token reduction: typically 15-30% on descriptive prose.
 *
 * Preserves fenced code blocks, inline code, and URLs untouched so
 * stat blocks and reference links survive the pass.
 *
 * No ST imports — Node-testable. Used by convertWiEntry when the
 * `compress` import option is truthy.
 */

// Article / filler regexes use lookbehind+lookahead instead of \b so they
// don't fire on hyphenated tokens (`A-frame`, `the-end-of-days`). A bare
// `\b(?:a|an|the)\b` would strip the `A` from `A-frame` because `-` is a
// non-word char and forms a word boundary — a real data-loss bug on lore
// prose mentioning hyphenated compounds.
const ARTICLES = /(?<![\w-])(?:a|an|the)(?![\w-])/gi;
// Conservative filler list — words that are noise in descriptive text but
// don't change meaning when removed. Skip "very", "much" etc. that DO shift
// emphasis enough to matter in lore.
const FILLERS = /(?<![\w-])(?:just|really|basically|actually|simply|literally|quite)(?![\w-])/gi;
const PLEASE = /(?<![\w-])(?:please|sorry|thanks|thank you)(?![\w-])/gi;
// Pleasantries that show up in scraped wiki text.
const POLITENESS = /(?<![\w-])(?:of course|certainly|indeed|happy to)(?![\w-])/gi;

/**
 * Compress a prose body using caveman rules.
 * @param {string} text - raw markdown body
 * @returns {string} - compressed body, same length-or-shorter
 */
export function compressCaveman(text) {
    // Pass non-strings through untouched (null / undefined / number / bool).
    // The earlier `if (!text)` guard let truthy non-strings (e.g. numeric WI
    // fields) through and crashed on `.replace()`.
    if (typeof text !== 'string' || text === '') return text;

    // Per-call random tag for masked spans. Tag is alphanumeric (regex-safe,
    // no escaping needed) and unique enough per call that any well-meaning
    // whitespace cleanup, file mode conversion, or doc-driven rewrite of
    // this module can't accidentally collide with real prose or strip a
    // marker mid-flight. Previous implementation used literal NUL bytes for
    // robustness but those silently broke the moment any tool normalized
    // whitespace through the file.
    const tag = '__DLEPRES' + Math.random().toString(36).slice(2, 10).toUpperCase() + '__';
    const preserved = [];
    // Mask without surrounding spaces: the tag itself is a word-char-only token,
    // so the word-boundary lookbehind/lookahead in ARTICLES/FILLERS/etc. won't
    // match an article that ends up adjacent to a mask placeholder. Wrapping in
    // spaces caused the space-before-punctuation strip below to consume the
    // trailing space, breaking restoration when an inline-code span was followed
    // by a comma/period.
    const mask = (m) => {
        preserved.push(m);
        return `${tag}${preserved.length - 1}${tag}`;
    };
    let working = text;
    working = working.replace(/```[\s\S]*?```/g, mask);
    // L-35: preserve indented code blocks (markdown's 4-space / tab convention).
    // Mask contiguous runs of indented lines BEFORE the whitespace-collapse (line
    // ~76) and per-line leading-strip (~88) would otherwise flatten their indent
    // and demote code to prose. Masking the whole run as one opaque span keeps the
    // internal indentation byte-for-byte on restore. Conservative threshold: 4+
    // leading spaces or a tab (the same bar markdown uses) — ordinary 1–3-space
    // wrap indents and list-continuation lines are left to the existing handling.
    // Fenced blocks are already masked above, so their placeholder lines (column 0)
    // can't be re-captured here. Match each maximal run of consecutive indented
    // lines (one line minimum) with the `m` flag; trailing/internal blank lines are
    // intentionally left out of the span to keep the regex simple and predictable.
    working = working.replace(/^(?:[ ]{4,}|\t)[^\n]*(?:\n(?:[ ]{4,}|\t)[^\n]*)*/gm, mask);
    working = working.replace(/`[^`\n]+`/g, mask);
    working = working.replace(/https?:\/\/\S+/g, mask);

    working = working.replace(ARTICLES, '');
    working = working.replace(POLITENESS, '');
    working = working.replace(FILLERS, '');
    working = working.replace(PLEASE, '');

    // Collapse runs of horizontal whitespace; strip space-before-punctuation
    // left over from removed words.
    working = working.replace(/[ \t]{2,}/g, ' ');
    working = working.replace(/[ \t]+([,.;:!?])/g, '$1');
    // Tidy line-level trailing spaces left by inline removals. Preserve leading
    // indent on list/quote lines so markdown structure stays intact.
    working = working
        .split('\n')
        .map(line => {
            // Strip trailing whitespace
            line = line.replace(/[ \t]+$/, '');
            // Strip leading whitespace ONLY when the line isn't a list/quote/heading-ish
            // markdown construct (those use indent semantically).
            if (!/^\s*(?:[-*+>]|\d+\.|#|\|)/.test(line)) {
                line = line.replace(/^[ \t]+/, '');
            }
            return line;
        })
        .join('\n');
    // Collapse 3+ blank lines that may have appeared after stripping
    working = working.replace(/\n{3,}/g, '\n\n');

    // Restore masked spans. Tag is word-char-only so the boundary lookarounds
    // in the article/filler regexes treat it as opaque — no extra spacing needed.
    const restoreRe = new RegExp(tag + '(\\d+)' + tag, 'g');
    working = working.replace(restoreRe, (_, i) => preserved[Number(i)]);

    return working;
}

/**
 * Resolve a `compress` import option into a normalized mode string.
 * Accepts: `true` / 'true' / 'caveman' → 'caveman'.
 *          `false` / 'false' / '' / undefined / null → null (no compression).
 *          Unknown mode strings (e.g. 'ai-summary') return as-is so callers can
 *          distinguish "user asked for X but we don't know it" from "user didn't ask".
 *          `convertWiEntry` only annotates frontmatter when it actually applies a
 *          transform — unknown modes warn instead of silently lying.
 * @param {boolean|string|null|undefined} raw
 * @returns {'caveman'|string|null}
 */
export function resolveCompressMode(raw) {
    if (raw === true || raw === 'true') return 'caveman';
    if (typeof raw === 'string') {
        const lower = raw.toLowerCase().trim();
        if (lower === 'caveman') return 'caveman';
        if (lower === 'false' || lower === '') return null;
        return lower; // forward-compat for ai-summary etc.
    }
    if (raw == null || raw === false) return null;
    return null;
}

/**
 * The list of compress modes this build actually knows how to apply. Anything
 * outside this set is treated as "annotation only forbidden" — convertWiEntry
 * should warn rather than store a frontmatter flag that lies about transform state.
 */
export const APPLIED_COMPRESS_MODES = new Set(['caveman']);
