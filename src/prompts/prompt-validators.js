/**
 * DeepLore — Delete cage validators for editable prompts.
 *
 * Pure functions, no I/O. Tests in `test/prompts-delete-safety.test.mjs`
 * cover every check below with dedicated TDD assertions.
 *
 * The cage protects user vault data: a bug in DLE's prompt-management code
 * must NEVER cause an unrelated vault file to be deleted. The user's vault
 * is treated like medical equipment — multiple orthogonal layers, each
 * independently sufficient to refuse.
 *
 * Layers implemented here (pure, no network):
 *   L1 — Path shape (10 sub-checks)
 *   L2 — Whitelist match (stem must be a known prompt key)
 *
 * Layers implemented at the I/O boundary (`src/vault/obsidian-api.js`):
 *   L3 — Existing `validateVaultPath()` runs first
 *   L4 — Pre-flight HTTP GET, parse frontmatter, verify `key:` matches stem,
 *        verify body contains no `lorebook-` tag (would indicate a vault entry)
 *   L5 — URL re-assembled internally from validated stem via `DLE_PROMPTS_DEFAULT_DIR`
 *   L6 — `deletePromptFile()` is the SOLE exported delete primitive
 *
 * Reviewers MUST reject any new `DELETE` HTTP call outside `deletePromptFile()`.
 * Look for the `// DLE_DELETE_PRIMITIVE` comment-tag — there should be exactly
 * one occurrence in the codebase.
 */

import * as PromptsEn from '../i18n/prompts/en.js';
import { DEPRECATED_PROMPT_KEYS } from './deprecated-keys.js';

/**
 * Set of all currently-known prompt keys, derived from the canonical EN dict.
 * Computed once at module load. Excludes the `__meta` export.
 *
 * @type {Set<string>}
 */
export const KNOWN_PROMPT_KEYS = new Set(
    Object.keys(PromptsEn).filter(k => k !== '__meta' && k !== 'default'),
);

/**
 * Union of currently-known + deprecated keys. Used by Layer 2 of the cage.
 *
 * @type {Set<string>}
 */
export const ACCEPTED_PROMPT_KEYS = new Set([
    ...KNOWN_PROMPT_KEYS,
    ...DEPRECATED_PROMPT_KEYS,
]);

/**
 * Maximum path length accepted by Layer 1 sub-check #10.
 * 200 chars is generous for `DeepLore/prompts/SCREAMING_SNAKE_CASE.md`
 * (longest real key is ~36 chars; typical prefix ~17 chars).
 */
export const MAX_PROMPT_PATH_LENGTH = 200;

/**
 * Characters that must never appear in a prompt path. URL-encoding artifacts
 * suggest the caller tried to smuggle a traversal or alternate-decode path.
 */
const FORBIDDEN_PATH_CHARS = ['%', '+', '\0'];

/**
 * Unicode lookalikes for `.` and `/` that could let traversal slip past a
 * naive ASCII-only scan. We refuse the entire char class to be safe.
 *  - U+FF0E FULLWIDTH FULL STOP `．`
 *  - U+2025 TWO DOT LEADER `‥`
 *  - U+2024 ONE DOT LEADER `․`
 *  - U+FF0F FULLWIDTH SOLIDUS `／`
 *  - U+29F8 BIG SOLIDUS `⧸`
 *  - U+2044 FRACTION SLASH `⁄`
 *  - U+2215 DIVISION SLASH `∕`
 *  - U+FE52 SMALL FULL STOP `﹒`
 */
const UNICODE_LOOKALIKES = /[．‥․／⧸⁄∕﹒]/;

/**
 * Filename stem regex — matches SCREAMING_SNAKE_CASE only.
 * Must start with uppercase letter; subsequent chars uppercase, digits, or
 * underscore. Lowercase rejected.
 */
const STEM_REGEX = /^[A-Z][A-Z0-9_]+$/;

/**
 * Result shape returned by every validator. `ok:true` means the input passed
 * THAT check. `ok:false` carries a human-readable `reason` for logging/tests.
 *
 * @typedef {{ ok: true } | { ok: false, reason: string, check: string }} ValidationResult
 */

/**
 * Layer 1 sub-check #1 — non-empty trimmed string.
 * @param {*} path
 * @returns {ValidationResult}
 */
export function checkPathIsNonEmptyString(path) {
    if (typeof path !== 'string') {
        return { ok: false, reason: 'path is not a string', check: 'L1.1' };
    }
    if (path.trim() === '') {
        return { ok: false, reason: 'path is empty or whitespace', check: 'L1.1' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #2 — starts with the configured folder prefix.
 * Prefix must be passed in and must itself end with `/`.
 * @param {string} path
 * @param {string} prefix
 * @returns {ValidationResult}
 */
export function checkPathStartsWithPrefix(path, prefix) {
    if (typeof prefix !== 'string' || prefix === '' || !prefix.endsWith('/')) {
        return { ok: false, reason: `prefix invalid (must be non-empty and end with "/", got ${JSON.stringify(prefix)})`, check: 'L1.2' };
    }
    if (!path.startsWith(prefix)) {
        return { ok: false, reason: `path does not start with prefix "${prefix}"`, check: 'L1.2' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #3 — ends with `.md`.
 * @param {string} path
 * @returns {ValidationResult}
 */
export function checkPathEndsWithMd(path) {
    if (!path.endsWith('.md')) {
        return { ok: false, reason: 'path does not end with .md', check: 'L1.3' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #4 — no `..` traversal in any form.
 * Catches raw, URL-encoded, double-encoded, and Unicode lookalikes.
 * @param {string} path
 * @returns {ValidationResult}
 */
export function checkPathHasNoTraversal(path) {
    // Raw `..`
    if (path.includes('..')) {
        return { ok: false, reason: 'path contains ".." traversal', check: 'L1.4' };
    }
    // Percent-encoded `..` (e.g. `%2e%2e`, `%2E%2E`, mixed case)
    if (/%2e%2e/i.test(path)) {
        return { ok: false, reason: 'path contains URL-encoded ".." traversal', check: 'L1.4' };
    }
    // Double-encoded `..` (e.g. `%252e%252e`)
    if (/%25/i.test(path)) {
        return { ok: false, reason: 'path contains double-URL-encoded characters (suspected ".." traversal)', check: 'L1.4' };
    }
    // Unicode dot/slash lookalikes
    if (UNICODE_LOOKALIKES.test(path)) {
        return { ok: false, reason: 'path contains Unicode lookalikes for "." or "/" (suspected traversal)', check: 'L1.4' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #5 — no `//` double-slash.
 * @param {string} path
 * @returns {ValidationResult}
 */
export function checkPathHasNoDoubleSlash(path) {
    if (path.includes('//')) {
        return { ok: false, reason: 'path contains "//" double-slash', check: 'L1.5' };
    }
    if (path.includes('\\\\')) {
        return { ok: false, reason: 'path contains "\\\\" double-backslash', check: 'L1.5' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #6 — no leading `/`, `\`, drive letter, or `~`.
 * @param {string} path
 * @returns {ValidationResult}
 */
export function checkPathHasNoAbsolutePrefix(path) {
    if (path.startsWith('/')) {
        return { ok: false, reason: 'path is absolute (starts with /)', check: 'L1.6' };
    }
    if (path.startsWith('\\')) {
        return { ok: false, reason: 'path is absolute (starts with \\)', check: 'L1.6' };
    }
    if (path.startsWith('~')) {
        return { ok: false, reason: 'path uses home-dir shortcut (starts with ~)', check: 'L1.6' };
    }
    // Windows drive letter: `C:`, `D:`, etc., upper or lower
    if (/^[A-Za-z]:/.test(path)) {
        return { ok: false, reason: 'path starts with a drive letter', check: 'L1.6' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #7 — no URL-encoding artifacts.
 * `%` and `+` are refused outright. A legitimate prompt filename never needs them.
 * @param {string} path
 * @returns {ValidationResult}
 */
export function checkPathHasNoUrlEncoding(path) {
    for (const ch of FORBIDDEN_PATH_CHARS) {
        if (path.includes(ch)) {
            return { ok: false, reason: `path contains forbidden character ${JSON.stringify(ch)}`, check: 'L1.7' };
        }
    }
    // Also block any control char (0x00–0x1F, 0x7F).
    if (/[\x00-\x1F\x7F]/.test(path)) {
        return { ok: false, reason: 'path contains control characters', check: 'L1.7' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #8 — after the prefix, single filename only.
 * No further `/` or `\` allowed past the prefix.
 * @param {string} path
 * @param {string} prefix
 * @returns {ValidationResult}
 */
export function checkPathIsFlatFile(path, prefix) {
    const tail = path.slice(prefix.length);
    if (tail.includes('/') || tail.includes('\\')) {
        return { ok: false, reason: 'path contains a subdirectory past the prompts folder', check: 'L1.8' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #9 — filename stem matches SCREAMING_SNAKE_CASE.
 * @param {string} path
 * @param {string} prefix
 * @returns {ValidationResult}
 */
export function checkPathStemShape(path, prefix) {
    const tail = path.slice(prefix.length);
    const stem = tail.replace(/\.md$/, '');
    if (!STEM_REGEX.test(stem)) {
        return { ok: false, reason: `filename stem "${stem}" does not match SCREAMING_SNAKE_CASE`, check: 'L1.9' };
    }
    return { ok: true };
}

/**
 * Layer 1 sub-check #10 — total path length within bound.
 * @param {string} path
 * @returns {ValidationResult}
 */
export function checkPathLength(path) {
    if (path.length > MAX_PROMPT_PATH_LENGTH) {
        return { ok: false, reason: `path length ${path.length} exceeds max ${MAX_PROMPT_PATH_LENGTH}`, check: 'L1.10' };
    }
    return { ok: true };
}

/**
 * Layer 2 — stem must be in the accepted-keys set.
 * @param {string} path
 * @param {string} prefix
 * @returns {ValidationResult}
 */
export function checkStemIsAcceptedKey(path, prefix) {
    const tail = path.slice(prefix.length);
    const stem = tail.replace(/\.md$/, '');
    if (!ACCEPTED_PROMPT_KEYS.has(stem)) {
        return { ok: false, reason: `stem "${stem}" is not a known or deprecated prompt key`, check: 'L2' };
    }
    return { ok: true };
}

/**
 * Sanitize a user-configured prompts folder path.
 * Returns the sanitized path with trailing `/`, or null if the input is unsafe.
 *
 * Rules:
 *  - Must be a non-empty string.
 *  - Replace backslashes with forward slashes.
 *  - Strip leading slash if present (must be relative).
 *  - Append trailing `/` if missing.
 *  - No `..`, no `//`, no URL-encoding chars, no control chars, no drive letter,
 *    no `~`, no Unicode lookalikes.
 *  - Max length 100 (reserves headroom under MAX_PROMPT_PATH_LENGTH for the
 *    filename itself).
 *
 * @param {*} raw
 * @returns {string | null}
 */
export function sanitizePromptsFolderPath(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s === '') return null;
    if (s.length > 100) return null;
    s = s.replace(/\\/g, '/');
    if (s.startsWith('/')) return null;
    if (s.startsWith('~')) return null;
    if (/^[A-Za-z]:/.test(s)) return null;
    if (s.includes('..')) return null;
    if (s.includes('//')) return null;
    if (/%2e%2e/i.test(s)) return null;
    if (/%25/i.test(s)) return null;
    if (UNICODE_LOOKALIKES.test(s)) return null;
    if (/[\x00-\x1F\x7F%+]/.test(s)) return null;
    if (!s.endsWith('/')) s += '/';
    return s;
}

/**
 * Composite cage gate — runs all pure layers (L1.1 through L1.10, then L2).
 * Returns the FIRST failure, or `{ ok: true, stem }` if all checks pass.
 *
 * Callers at the I/O boundary still must run L3 (`validateVaultPath`), L4
 * (pre-flight GET + frontmatter `key:` match + `lorebook-` tag refusal), L5
 * (re-assembled URL), and L6 (sole-primitive code structure).
 *
 * @param {string} path
 * @param {string} prefix - The sanitized prompts folder prefix (must end with /).
 * @returns {{ ok: true, stem: string } | { ok: false, reason: string, check: string }}
 */
export function validatePromptDeletePath(path, prefix) {
    const checks = [
        () => checkPathIsNonEmptyString(path),
        () => checkPathStartsWithPrefix(path, prefix),
        () => checkPathEndsWithMd(path),
        () => checkPathHasNoTraversal(path),
        () => checkPathHasNoDoubleSlash(path),
        () => checkPathHasNoAbsolutePrefix(path),
        () => checkPathHasNoUrlEncoding(path),
        () => checkPathLength(path),
        // The two checks below assume path starts with prefix; they're safe to
        // run only after the earlier ones pass, hence sequential short-circuit.
        () => checkPathIsFlatFile(path, prefix),
        () => checkPathStemShape(path, prefix),
        () => checkStemIsAcceptedKey(path, prefix),
    ];
    for (const run of checks) {
        const result = run();
        if (!result.ok) return result;
    }
    // All passed — derive stem for caller convenience.
    const stem = path.slice(prefix.length).replace(/\.md$/, '');
    return { ok: true, stem };
}
