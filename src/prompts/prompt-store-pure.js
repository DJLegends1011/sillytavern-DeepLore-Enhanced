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
 * Extract the set of placeholders from a prompt string.
 *
 * Returns a Set mixing two placeholder syntaxes:
 *   - `${N}` indexed markers (e.g. `"${0}"`, `"${1}"`) used by the AGENTIC_*
 *     interpolation runtime.
 *   - `{{name}}` mustache markers (e.g. `"{{maxEntries}}"`) used by prompts like
 *     AI_SEARCH_SYSTEM_PROMPT that get token-substituted at dispatch.
 *
 * Two callsites consume this:
 *   1. Validator — compare vault file's set against canonical EN dict's set
 *   2. Frontmatter doc generator — auto-document placeholders on export
 *
 * Refuses to match `${name}` (single-brace alphabetic) — only numeric `${N}`
 * indices and `{{mustache}}` names count.
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
    // L-32: also capture `{{name}}` mustache placeholders so R3 validation
    // catches a vault override that drops a required token (e.g. {{maxEntries}}).
    // Matches the mustache pattern in i18n-pure.js:countPlaceholders.
    const mustacheRe = /\{\{[a-zA-Z_]\w*\}\}/g;
    let mMatch;
    while ((mMatch = mustacheRe.exec(text)) !== null) {
        out.add(mMatch[0]);
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
 * Detect an ACTUAL Obsidian vault-entry `lorebook-` tag in a prompt body,
 * as opposed to a prose/backtick mention of the word.
 *
 * Returns true only for real tag forms:
 *   1. Inline hashtag at a word boundary — `#lorebook-foo` preceded by
 *      start-of-string or whitespace (Obsidian inline-tag syntax). A leading
 *      backtick (e.g. `` `lorebook-guide` ``) is NOT a hashtag, so it passes.
 *   2. A YAML `tags:` block listing a `lorebook-...` value — either an inline
 *      array (`tags: [lorebook-guide, x]`) or a list item under a `tags:` key
 *      (`tags:\n  - lorebook-guide`). This is what a pasted vault entry's
 *      frontmatter looks like.
 *
 * A bare/backticked `lorebook-guide` mention in prose returns false.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function containsRealLorebookTag(body) {
    if (typeof body !== 'string' || body === '') return false;

    // Form 1 — inline hashtag at a word boundary. `(?<!\S)` would be ideal but
    // for portability we anchor on start-of-string or a whitespace char.
    if (/(^|\s)#lorebook-/i.test(body)) return true;

    // Form 2 — YAML `tags:` block with a lorebook- value.
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Inline array on the same line: `tags: [lorebook-guide, ...]`
        const inline = /^\s*tags\s*:\s*\[([^\]]*)\]/i.exec(line);
        if (inline && /(^|[\s,'"])lorebook-/i.test(inline[1])) return true;
        // Inline single value: `tags: lorebook-guide`
        const single = /^\s*tags\s*:\s*(.+)$/i.exec(line);
        if (single && !single[1].trim().startsWith('[') && /^['"]?lorebook-/i.test(single[1].trim())) return true;
        // Block list under a `tags:` key.
        if (/^\s*tags\s*:\s*$/i.test(line)) {
            for (let j = i + 1; j < lines.length; j++) {
                const item = lines[j];
                // A `- value` list item (allow quotes).
                const li = /^\s*-\s*['"]?([^'"#\s]+)/.exec(item);
                if (li) {
                    if (/^lorebook-/i.test(li[1])) return true;
                    continue; // keep scanning list items
                }
                // Non-list-item, non-blank line ends the block.
                if (item.trim() !== '') break;
            }
        }
    }
    return false;
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
 *        Missing OR extra `${N}` markers fail. Skipped when `canonicalBody`
 *        is null (delete-cage path where we don't trust the runtime cache).
 *
 * @param {{ frontmatter: object, body: string }} parsed
 * @param {string | null} canonicalBody - The compiled-in EN dict value for
 *   the same key, or null to skip R3 (placeholder parity).
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
    // R2 — no lorebook tag (entry detection). Narrowed to a REAL Obsidian tag
    // form so a prose/backtick mention (e.g. `lorebook-guide` in documentation)
    // PASSES while an actual vault entry (which carries the tag as data) is still
    // rejected. Two forms count as a real tag:
    //   1. Inline hashtag at a word boundary: `#lorebook-...`
    //   2. A YAML `tags:` block listing a `lorebook-...` value (list item or
    //      inline array) — what a pasted vault entry's frontmatter looks like.
    if (containsRealLorebookTag(parsed.body)) {
        return { ok: false, reason: 'body contains a "lorebook-" tag (looks like a vault entry, not a prompt)' };
    }
    // R3 — placeholder parity (skipped when canonical body unavailable)
    if (canonicalBody != null) {
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
    }
    return { ok: true };
}

/**
 * Layer 4 of the delete cage — pre-flight verification of a fetched file
 * before issuing DELETE against it. Thin wrapper over `validatePromptShape`
 * with R3 (placeholder parity) skipped: we don't trust the runtime cache at
 * this point, so we only enforce R1 (frontmatter key matches validated stem)
 * and R2 (no `lorebook-` tag — vault-entry indicator).
 *
 * Called by the I/O wrapper after the HTTP GET completes, before DELETE.
 *
 * @param {string} rawContent
 * @param {string} validatedStem
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyPromptFileForDeletion(rawContent, validatedStem) {
    const parsed = parsePromptFile(rawContent);
    if (!parsed.ok) {
        return { ok: false, reason: `not a valid prompt file (${parsed.reason})` };
    }
    const result = validatePromptShape(parsed, null, validatedStem);
    if (!result.ok) {
        // Match the legacy error wording so callers/tests that grep for
        // "does not match validated stem" still get a substring hit.
        if (result.reason.startsWith('frontmatter key ')) {
            return { ok: false, reason: result.reason.replace('does not match expected', 'does not match validated stem') };
        }
    }
    return result;
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
 * Normalize a parsed body **for hashing only**.
 *
 * The frontmatter parser consumes the closing `---` and one trailing newline,
 * leaving a leading blank line in the body when the file used the canonical
 * `---\n\nBody` shape (which `buildPromptFileContent` produces). This strips
 * up to one leading newline AND all trailing whitespace so a freshly exported
 * file's body hashes identically to the canonical dict value — that's what
 * powers stable status detection (current_default vs customized).
 *
 * IMPORTANT: this is the HASH-side normalization. It is intentionally lossy
 * (trailing whitespace is discarded), so it MUST NOT be used to derive the
 * value delivered to the LLM — that would silently mutate a user's prompt.
 * Use `stripBodyShimNewline` for the runtime-delivered body, which preserves
 * trailing whitespace. See `buildPromptOverlay` for the split.
 *
 * @param {string} body
 * @returns {string}
 */
export function normalizePromptBody(body) {
    if (typeof body !== 'string') return '';
    // Strip the leading blank line that buildPromptFileContent inserts after
    // the closing `---`, and any trailing whitespace (including the trailing
    // newline that the same builder appends). This keeps hash comparison
    // stable for unedited exports while still detecting genuine content edits.
    return body.replace(/^\r?\n/, '').replace(/\s+$/, '');
}

/**
 * Strip ONLY the leading shim newline from a parsed body, preserving the body
 * otherwise byte-for-byte (including any trailing whitespace the author put
 * there on purpose).
 *
 * This is the DELIVERY-side counterpart to `normalizePromptBody`. The
 * frontmatter parser leaves one leading blank line after the closing `---`
 * for the canonical `---\n\nBody` shape; that artifact is removed here, but —
 * unlike the hash-side normalizer — trailing whitespace is left intact so the
 * runtime sends the user's prompt verbatim. The cache stores this value;
 * `bodyHash` is still derived from `normalizePromptBody` so status detection
 * is unaffected by trailing-whitespace differences.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripBodyShimNewline(body) {
    if (typeof body !== 'string') return '';
    return body.replace(/^\r?\n/, '');
}

/**
 * Pure overlay merge — given the compiled-in dict for a locale and a Map of
 * raw vault override files keyed by prompt key, produces:
 *
 *   resolved   — Map<key, string>  the string to put in the runtime cache
 *   meta       — Map<key, object>  per-key source/hash/status for the Prompts tab
 *   errors     — Array<{ key, reason }>  failed overrides (toastr surface)
 *
 * Per-key resolution:
 *   1. If `overrides.has(key)`:
 *        a. parsePromptFile → on failure, fall back to compiled-in + error.
 *        b. validatePromptShape against compiled-in canonical:
 *             - mismatch → fall back to compiled-in + error.
 *             - OK → use vault body; compute status from
 *               { bodyHash, sourceHash from frontmatter, canonicalHash }.
 *   2. Otherwise: use compiled-in value; status = current_default.
 *
 * Used by the runtime loader in `prompt-store.js` and by unit tests directly.
 *
 * @param {object} localeDict - The compiled-in dict module (e.g. PromptsEn).
 * @param {Map<string, string>} overrides - key → raw file content from vault.
 * @param {Set<string>} acceptedKeys - keys to populate (typically KNOWN_PROMPT_KEYS).
 * @param {object} enDict - The EN dict for final fallback if locale dict is missing a key.
 * @returns {{ resolved: Map<string, string>, meta: Map<string, object>, errors: Array<{ key: string, reason: string }> }}
 */
export function buildPromptOverlay(localeDict, overrides, acceptedKeys, enDict) {
    const resolved = new Map();
    const meta = new Map();
    const errors = [];

    for (const key of acceptedKeys) {
        // Compiled-in value at locale, with EN fallback.
        const localeValue = (localeDict && typeof localeDict[key] === 'string') ? localeDict[key] : null;
        const enValue = (enDict && typeof enDict[key] === 'string') ? enDict[key] : null;
        const canonicalValue = localeValue ?? enValue;
        if (canonicalValue == null) {
            // Key not in EN dict — unknown. Skip silently.
            continue;
        }
        const canonicalHash = promptHash(normalizePromptBody(canonicalValue));

        const raw = overrides.get(key);
        if (raw == null) {
            // No override — use compiled-in.
            resolved.set(key, canonicalValue);
            meta.set(key, {
                source: 'compiled-in',
                bodyHash: canonicalHash,
                sourceHash: canonicalHash,
                canonicalHash,
                status: computePromptStatus({ bodyHash: canonicalHash, sourceHash: canonicalHash, canonicalHash }),
                error: null,
            });
            continue;
        }

        // Parse the override.
        const parsed = parsePromptFile(raw);
        if (!parsed.ok) {
            resolved.set(key, canonicalValue);
            meta.set(key, {
                source: 'compiled-in',
                bodyHash: canonicalHash,
                sourceHash: canonicalHash,
                canonicalHash,
                status: computePromptStatus({ bodyHash: canonicalHash, sourceHash: canonicalHash, canonicalHash }),
                error: parsed.reason,
            });
            errors.push({ key, reason: `parse failure: ${parsed.reason}` });
            continue;
        }

        // Validate against compiled-in canonical.
        const validation = validatePromptShape(parsed, canonicalValue, key);
        if (!validation.ok) {
            resolved.set(key, canonicalValue);
            meta.set(key, {
                source: 'compiled-in',
                bodyHash: canonicalHash,
                sourceHash: canonicalHash,
                canonicalHash,
                status: computePromptStatus({ bodyHash: canonicalHash, sourceHash: canonicalHash, canonicalHash }),
                error: validation.reason,
            });
            errors.push({ key, reason: `validation failure: ${validation.reason}` });
            continue;
        }

        // Override valid — derive status from three hashes, but split hashing
        // from delivery. The hash is computed from the lossy `normalizePromptBody`
        // (trailing whitespace stripped) so an unedited export still reads as
        // current_default; the cache stores the delivery body with only the
        // leading shim newline removed, so the runtime sends the author's prompt
        // verbatim (trailing whitespace preserved). See gotcha #70 + the
        // normalizePromptBody / stripBodyShimNewline docs.
        const bodyHash = promptHash(normalizePromptBody(parsed.body));
        const deliveryBody = stripBodyShimNewline(parsed.body);
        const sourceHash = typeof parsed.frontmatter.source_hash === 'string' && parsed.frontmatter.source_hash
            ? parsed.frontmatter.source_hash
            : null;
        const status = computePromptStatus({ bodyHash, sourceHash, canonicalHash });
        resolved.set(key, deliveryBody);
        meta.set(key, {
            source: 'vault',
            bodyHash,
            sourceHash,
            canonicalHash,
            status,
            error: null,
        });
    }

    return { resolved, meta, errors };
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
