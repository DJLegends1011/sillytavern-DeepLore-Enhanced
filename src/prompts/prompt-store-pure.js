/**
 * DeepLore Enhanced — Pure helpers for the editable-prompts subsystem.
 *
 * No I/O, no module-level mutable state, no DOM or ST dependencies. Every
 * function here is straight input → output so unit tests can hammer it
 * without mocks. Runtime wrappers live in `prompt-store.js`.
 *
 * Coverage:
 *   - parsePromptFile()    — read a vault MD file into { frontmatter, body }
 *   - extractPlaceholders() — pull `${N}` markers from a prompt string
 *   - validatePromptShape() — apply Q4 strict rules: key match, no lorebook tag,
 *                             placeholder set matches canonical
 *   - computePromptStatus() — Q11 A+ 4-state status from three hashes
 *   - buildPromptFileContent() — serialize a prompt to MD with frontmatter
 *   - promptHash() — stable string hash (delegates to core simpleHash)
 */

import { parseFrontmatter, simpleHash } from '../../core/utils.js';

/**
 * Stable hash for status detection. Reuses `simpleHash` so the rest of the
 * codebase isn't fighting two hash schemes. Not cryptographic — collision
 * resistance isn't required, only stability across boots.
 *
 * @param {string} text
 * @returns {string}
 */
export function promptHash(text) {
    return simpleHash(text || '');
}

/**
 * Parse a vault prompt MD file into structured form.
 *
 * Returns `{ ok: true, frontmatter, body }` on success or
 * `{ ok: false, reason }` on parse failure.
 *
 * Parse failure cases (any of these → fall back to compiled-in per Q4):
 *   - Empty or whitespace-only input
 *   - No frontmatter block found
 *   - Frontmatter missing `key` field
 *   - Body is empty after stripping frontmatter
 *
 * @param {string} raw - File contents as read from vault.
 * @returns {{ ok: true, frontmatter: object, body: string } | { ok: false, reason: string }}
 */
export function parsePromptFile(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return { ok: false, reason: 'empty file' };
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'parseFrontmatter returned non-object' };
    }
    const { frontmatter, body } = parsed;
    // Frontmatter MUST exist — parseFrontmatter returns `{}` if no `---` block,
    // which we treat as failure (a real prompt file always has a key field).
    if (!frontmatter || Object.keys(frontmatter).length === 0) {
        return { ok: false, reason: 'missing frontmatter block' };
    }
    if (typeof frontmatter.key !== 'string' || frontmatter.key.trim() === '') {
        return { ok: false, reason: 'missing or empty frontmatter "key" field' };
    }
    if (typeof body !== 'string' || body.trim() === '') {
        return { ok: false, reason: 'empty body' };
    }
    return { ok: true, frontmatter, body };
}

/**
 * Extract the set of `${N}` placeholders from a prompt string.
 *
 * Returns a Set of strings like `"${0}"`, `"${1}"`. Catches the AGENTIC_*
 * interpolation markers used by runtime code. Two callsites consume this:
 *   1. Validator — compare vault file's set against canonical EN dict's set
 *   2. Frontmatter doc generator — auto-document placeholders on export
 *
 * Refuses to match `${name}` (alphabetic) — only numeric indices count.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractPlaceholders(text) {
    const out = new Set();
    if (typeof text !== 'string') return out;
    const re = /\$\{(\d+)\}/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        out.add(`\${${match[1]}}`);
    }
    return out;
}

/**
 * Compare two sets of placeholders for equality.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
export function placeholderSetsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) {
        if (!b.has(v)) return false;
    }
    return true;
}

/**
 * Apply Q4 strict validation rules to a parsed prompt file.
 *
 * Returns `{ ok: true }` if the file is safe to use as a runtime override,
 * or `{ ok: false, reason }` if the runtime should fall back to compiled-in.
 *
 * Rules:
 *   R1 — `frontmatter.key` must equal `expectedKey` (no key mismatch)
 *   R2 — body must not contain a `lorebook-` tag (would mean the file is a
 *        vault entry, not a prompt). This is a defense-in-depth check that
 *        also benefits Layer 4 of the delete cage.
 *   R3 — placeholders in body must exactly match canonical placeholders.
 *        Missing OR extra `${N}` markers fail.
 *
 * @param {{ frontmatter: object, body: string }} parsed
 * @param {string} canonicalBody - The compiled-in EN dict value for the same key.
 * @param {string} expectedKey
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validatePromptShape(parsed, canonicalBody, expectedKey) {
    if (!parsed || !parsed.frontmatter || typeof parsed.body !== 'string') {
        return { ok: false, reason: 'invalid parsed shape' };
    }
    // R1 — key match
    if (parsed.frontmatter.key !== expectedKey) {
        return { ok: false, reason: `frontmatter key "${parsed.frontmatter.key}" does not match expected "${expectedKey}"` };
    }
    // R2 — no lorebook tag (entry detection)
    if (/lorebook-/i.test(parsed.body)) {
        return { ok: false, reason: 'body contains "lorebook-" tag (looks like a vault entry, not a prompt)' };
    }
    // R3 — placeholder parity
    const bodyPlaceholders = extractPlaceholders(parsed.body);
    const canonicalPlaceholders = extractPlaceholders(canonicalBody);
    if (!placeholderSetsEqual(bodyPlaceholders, canonicalPlaceholders)) {
        const missing = [...canonicalPlaceholders].filter(p => !bodyPlaceholders.has(p));
        const extra = [...bodyPlaceholders].filter(p => !canonicalPlaceholders.has(p));
        const parts = [];
        if (missing.length) parts.push(`missing ${missing.join(', ')}`);
        if (extra.length) parts.push(`extra ${extra.join(', ')}`);
        return { ok: false, reason: `placeholder mismatch (${parts.join('; ')})` };
    }
    return { ok: true };
}

/**
 * Status state machine from Q11 A+.
 *
 *   body_hash      |  source_hash       | Status
 *   match source   |  match canonical   | current_default      (untouched, current)
 *   match source   |  differ canonical  | stale_default        (untouched, upstream changed)
 *   differ source  |  match canonical   | customized           (edited, baseline current)
 *   differ source  |  differ canonical  | customized_stale_baseline  (edited, baseline outdated)
 *
 * Special cases:
 *   - sourceHash missing → 'customized' if bodyHash != canonicalHash, else
 *     'current_default' (treat as if user just exported without a hash field).
 *   - bodyHash, sourceHash, canonicalHash all null → 'missing' (no vault file).
 *
 * @param {{ bodyHash: string | null, sourceHash: string | null | undefined, canonicalHash: string | null }} hashes
 * @returns {'current_default' | 'stale_default' | 'customized' | 'customized_stale_baseline' | 'missing'}
 */
export function computePromptStatus({ bodyHash, sourceHash, canonicalHash }) {
    if (bodyHash == null) return 'missing';
    if (canonicalHash == null) {
        // Canonical unknown — orphan key. Treat as customized so user sees something to act on.
        return 'customized';
    }
    if (sourceHash == null || sourceHash === '') {
        // No source_hash recorded → infer from body vs canonical comparison.
        return bodyHash === canonicalHash ? 'current_default' : 'customized';
    }
    const userEdited = bodyHash !== sourceHash;
    const upstreamMoved = sourceHash !== canonicalHash;
    if (!userEdited && !upstreamMoved) return 'current_default';
    if (!userEdited && upstreamMoved) return 'stale_default';
    if (userEdited && !upstreamMoved) return 'customized';
    return 'customized_stale_baseline';
}

/**
 * Build the MD file content for a prompt export.
 *
 * Frontmatter shape (Q3 A):
 *   - key:          prompt key
 *   - locale:       locale tag (en, es-es, etc.)
 *   - source_hash:  promptHash() of the dict value at export time
 *   - placeholders: block-scalar text documenting `${N}` markers
 *
 * Placeholder doc is auto-generated by extracting `${N}` markers from the
 * canonical body and inserting a per-marker line. If no markers, the field
 * is omitted to keep small prompts uncluttered.
 *
 * The body matches `value` byte-for-byte after the closing `---`. Caller is
 * expected to pass the dict value they want exported.
 *
 * @param {{ key: string, locale: string, value: string, placeholderDocs?: Record<string, string> }} input
 * @returns {string}
 */
export function buildPromptFileContent({ key, locale, value, placeholderDocs }) {
    if (typeof key !== 'string' || key === '') throw new Error('buildPromptFileContent: key required');
    if (typeof locale !== 'string' || locale === '') throw new Error('buildPromptFileContent: locale required');
    if (typeof value !== 'string') throw new Error('buildPromptFileContent: value must be string');

    const sourceHash = promptHash(value);
    const placeholders = extractPlaceholders(value);

    const lines = [];
    lines.push('---');
    lines.push(`key: ${key}`);
    lines.push(`locale: ${locale}`);
    lines.push(`source_hash: ${sourceHash}`);
    if (placeholders.size > 0) {
        lines.push('placeholders: |');
        const sorted = [...placeholders].sort();
        for (const p of sorted) {
            const desc = placeholderDocs && placeholderDocs[p] ? placeholderDocs[p] : '(no description available)';
            lines.push(`  ${p} = ${desc}`);
        }
    }
    lines.push('---');
    lines.push('');
    lines.push(value);
    // Ensure file ends with newline for clean diffs.
    return lines.join('\n') + (value.endsWith('\n') ? '' : '\n');
}
