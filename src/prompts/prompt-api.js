/**
 * DeepLore Enhanced — Obsidian REST API helpers for editable prompts.
 *
 * All prompt-folder I/O passes through this module. The DELETE primitive
 * lives here and is the SOLE call site in the codebase that issues
 * `method: 'DELETE'` against the Obsidian REST API. Reviewers MUST reject
 * any new DELETE elsewhere in the codebase — the `// DLE_DELETE_PRIMITIVE`
 * comment-tag marks the one legal site.
 *
 * Cage layers (re-stated for callers reading top-to-bottom):
 *   L1 — Path shape (10 sub-checks) — `validatePromptDeletePath` from prompt-validators.js
 *   L2 — Stem whitelist (KNOWN ∪ DEPRECATED) — same composite
 *   L3 — `validateVaultPath()` from obsidian-api.js (legacy traversal guard)
 *   L4 — Pre-flight HTTP GET + `verifyPromptFileForDeletion` from prompt-store-pure.js
 *   L5 — URL re-assembled internally from validated stem (caller path discarded)
 *   L6 — `deletePromptFile()` is the SOLE exported DELETE primitive
 *
 * Errors are returned via `{ ok: false, error: string }` rather than thrown,
 * so callers can surface them to the user via toastr without try/catch.
 */

import {
    obsidianFetch,
    encodeVaultPath,
    validateVaultPath,
    writeNote,
} from '../vault/obsidian-api.js';
import {
    validatePromptDeletePath,
    sanitizePromptsFolderPath,
} from './prompt-validators.js';
import { verifyPromptFileForDeletion } from './prompt-store-pure.js';

/**
 * Default folder path for prompt overrides. User-configurable via the
 * `promptsFolderPath` setting (Q2 B). Sanitized through
 * `sanitizePromptsFolderPath()` before use.
 */
export const DLE_PROMPTS_DEFAULT_DIR = 'DeepLore/prompts/';

/**
 * Maximum number of files we'll accept in a single folder listing. Defensive
 * cap against a misconfigured prompts folder being a massive directory.
 */
export const DLE_PROMPTS_LIST_LIMIT = 200;

/**
 * Maximum byte size of a prompt file. Real prompts are kilobytes; anything
 * above this is suspect.
 */
export const DLE_PROMPTS_MAX_FILE_BYTES = 100_000;

/**
 * Derive the validated `${prefix}${stem}.md` path for a key. Returns the
 * cage-validated path or an error result. Used internally by every I/O
 * function so callers never construct paths themselves.
 *
 * @param {string} prefix - Sanitized folder path ending with `/`.
 * @param {string} key - Prompt key (stem with or without `.md`).
 * @returns {{ ok: true, path: string, stem: string } | { ok: false, error: string }}
 */
function buildAndValidatePath(prefix, key) {
    if (typeof prefix !== 'string') {
        return { ok: false, error: 'prefix is not a string' };
    }
    if (typeof key !== 'string') {
        return { ok: false, error: 'key is not a string' };
    }
    const stem = key.endsWith('.md') ? key.slice(0, -3) : key;
    const path = `${prefix}${stem}.md`;
    const cageCheck = validatePromptDeletePath(path, prefix);
    if (!cageCheck.ok) {
        return { ok: false, error: `cage refused at ${cageCheck.check}: ${cageCheck.reason}` };
    }
    return { ok: true, path, stem: cageCheck.stem };
}

/**
 * Write a prompt MD file to the vault.
 *
 * Cage layers applied: L1, L2, L3.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} apiKey
 * @param {string} prefix - Sanitized prompts folder path (ending with `/`).
 * @param {string} key - Prompt key (e.g. `'SCRIBE_PROMPT'`).
 * @param {string} content - Full file content (frontmatter + body).
 * @param {boolean} [useHttps=false]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function writePromptFile(host, port, apiKey, prefix, key, content, useHttps = false) {
    const built = buildAndValidatePath(prefix, key);
    if (!built.ok) return built;
    if (typeof content !== 'string') {
        return { ok: false, error: 'content must be a string' };
    }
    if (content.length > DLE_PROMPTS_MAX_FILE_BYTES) {
        return { ok: false, error: `content too large (${content.length} > ${DLE_PROMPTS_MAX_FILE_BYTES})` };
    }
    return writeNote(host, port, apiKey, built.path, content, useHttps);
}

/**
 * Fetch a prompt MD file from the vault.
 *
 * Cage layers applied: L1, L2, L3.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} apiKey
 * @param {string} prefix
 * @param {string} key
 * @param {boolean} [useHttps=false]
 * @returns {Promise<{ ok: true, content: string } | { ok: false, error: string }>}
 */
export async function fetchPromptFile(host, port, apiKey, prefix, key, useHttps = false) {
    const built = buildAndValidatePath(prefix, key);
    if (!built.ok) return built;
    try {
        const normalizedPath = validateVaultPath(built.path);
        const result = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'GET',
            accept: 'text/markdown',
        });
        if (result.status === 200) {
            return { ok: true, content: String(result.data || '') };
        }
        if (result.status === 404) {
            return { ok: false, error: 'not_found' };
        }
        return { ok: false, error: `HTTP ${result.status}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * List MD files inside the prompts folder. Returns filenames relative to the
 * folder root (single segment, including extension). Subdirectory entries are
 * dropped — the prompts folder is intentionally flat.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} apiKey
 * @param {string} prefix - Sanitized prompts folder (ending with `/`).
 * @param {boolean} [useHttps=false]
 * @returns {Promise<{ ok: true, files: string[] } | { ok: false, error: string }>}
 */
export async function listPromptsFolder(host, port, apiKey, prefix, useHttps = false) {
    // Re-validate prefix shape — defense-in-depth even though callers should
    // have sanitized via sanitizePromptsFolderPath().
    const sanitized = sanitizePromptsFolderPath(prefix);
    if (!sanitized) {
        return { ok: false, error: 'prefix failed sanitization' };
    }
    try {
        const folderForUrl = sanitized.replace(/\/$/, '');
        const normalizedFolder = validateVaultPath(folderForUrl);
        const result = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedFolder)}/`,
            method: 'GET',
        });
        if (result.status === 404) {
            // Folder absent → no overrides. Benign, return empty list.
            return { ok: true, files: [] };
        }
        if (result.status !== 200) {
            return { ok: false, error: `HTTP ${result.status}` };
        }
        let listing;
        try {
            listing = JSON.parse(result.data);
        } catch (e) {
            return { ok: false, error: `parse error: ${e.message}` };
        }
        const all = Array.isArray(listing?.files) ? listing.files : [];
        const filesOnly = all.filter(f => typeof f === 'string' && !f.endsWith('/') && f.endsWith('.md'));
        if (filesOnly.length > DLE_PROMPTS_LIST_LIMIT) {
            return { ok: false, error: `too many files in folder (${filesOnly.length} > ${DLE_PROMPTS_LIST_LIMIT})` };
        }
        return { ok: true, files: filesOnly };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * DLE_DELETE_PRIMITIVE
 *
 * Sole exported HTTP DELETE call against the Obsidian REST API. Treats user
 * vault data as medical equipment: six orthogonal safety layers, each
 * independently sufficient to refuse.
 *
 * Layers run in this order, short-circuiting on first failure:
 *   L1 + L2 — `validatePromptDeletePath()` (composite path + whitelist check)
 *   L5      — URL re-assembled internally from validated stem; caller-supplied
 *             path is NEVER used past this point
 *   L3      — `validateVaultPath()` runs on the assembled path
 *   L4      — Pre-flight HTTP GET, frontmatter `key:` MUST match validated stem,
 *             body MUST NOT contain a `lorebook-` tag (vault-entry indicator)
 *   L6      — code-structure: this is the only function that issues DELETE;
 *             marked with the `DLE_DELETE_PRIMITIVE` comment-tag above
 *
 * Returns `{ ok: true }` on success, `{ ok: true, alreadyMissing: true }` if
 * the file was 404 (treated as benign — nothing to delete), or
 * `{ ok: false, error: string }` on any failure (cage refusal, network error,
 * non-200 DELETE response).
 *
 * @param {string} host
 * @param {number} port
 * @param {string} apiKey
 * @param {string} prefix - Sanitized prompts folder path (ending with `/`).
 * @param {string} key - Prompt key (stem only or with `.md`).
 * @param {boolean} [useHttps=false]
 * @returns {Promise<{ ok: true, alreadyMissing?: boolean } | { ok: false, error: string }>}
 */
export async function deletePromptFile(host, port, apiKey, prefix, key, useHttps = false) {
    // ── L1 + L2 ─────────────────────────────────────────────────────────────
    const built = buildAndValidatePath(prefix, key);
    if (!built.ok) return built;
    const validatedStem = built.stem;

    // ── L5: assemble the URL from the validated stem ONLY ───────────────────
    // We must NEVER trust the caller-supplied `key` past validation. From here
    // on every reference to the file derives from `validatedStem`.
    const assembledPath = `${prefix}${validatedStem}.md`;
    if (assembledPath !== built.path) {
        // Sanity check: if reassembly differs from the validated path, refuse.
        return { ok: false, error: 'cage refused at L5: reassembled path drifted from validated path' };
    }

    // ── L3: legacy traversal guard ──────────────────────────────────────────
    let normalizedPath;
    try {
        normalizedPath = validateVaultPath(assembledPath);
    } catch (err) {
        return { ok: false, error: `cage refused at L3: ${err.message}` };
    }

    // ── L4: pre-flight GET + frontmatter verification ───────────────────────
    let preflight;
    try {
        preflight = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'GET',
            accept: 'text/markdown',
        });
    } catch (err) {
        return { ok: false, error: `cage refused at L4 pre-flight: ${err.message}` };
    }
    if (preflight.status === 404) {
        // File doesn't exist → nothing to delete. Benign success.
        return { ok: true, alreadyMissing: true };
    }
    if (preflight.status !== 200) {
        return { ok: false, error: `cage refused at L4 pre-flight: HTTP ${preflight.status}` };
    }
    const verifyResult = verifyPromptFileForDeletion(String(preflight.data || ''), validatedStem);
    if (!verifyResult.ok) {
        return { ok: false, error: `cage refused at L4: ${verifyResult.reason}` };
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    try {
        const deleteResult = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'DELETE',
        });
        if (deleteResult.status === 200 || deleteResult.status === 204) {
            return { ok: true, alreadyMissing: false };
        }
        if (deleteResult.status === 404) {
            // Race: file vanished between pre-flight and delete. Still benign.
            return { ok: true, alreadyMissing: true };
        }
        return { ok: false, error: `DELETE failed: HTTP ${deleteResult.status}` };
    } catch (err) {
        return { ok: false, error: `DELETE error: ${err.message}` };
    }
}
