/**
 * DeepLore Enhanced — SillyTavern Lorebook Import Bridge (Lite)
 * Converts ST World Info JSON entries into Obsidian vault notes with frontmatter.
 */
import { writeNote, obsidianFetch, encodeVaultPath } from './obsidian-api.js';
import { getSettings, getPrimaryVault, resolveWriteVault } from '../../settings.js';
import { convertWiEntry } from '../helpers.js';
import { classifyDedupProbe } from './vault-pure.js';

const MAX_DEDUP_ATTEMPTS = 20;

/**
 * Resolve a target path that doesn't collide with an existing vault file by
 * appending `_imported`, `_imported_2`, … until a 404 is found (or attempts
 * run out). Returns the unique path or null when the dedup check times out,
 * the cap is reached, or a network error makes the check unverifiable.
 *
 * V-C2: A network error during an existence check used to return the
 * candidate path "assume free" — but if the file ACTUALLY existed, the
 * caller would then writeNote over it, silently overwriting vault content.
 * That's the exact opposite of what the dedup helper is supposed to do.
 * Return null so callers fail loud and skip the file.
 *
 * @param {object} vault - {host, port, apiKey, https}
 * @param {string} filename - desired base filename (e.g. "Foo.md")
 * @param {string} folder - target folder, may be ''
 * @returns {Promise<string|null>}
 */
async function _findUniquePath(vault, filename, folder) {
    const base = filename.replace(/\.md$/, '');
    let suffix = '_imported';
    let attempt = 1;
    while (attempt <= MAX_DEDUP_ATTEMPTS) {
        const candidateFilename = `${base}${suffix}.md`;
        const candidatePath = folder ? `${folder}/${candidateFilename}` : candidateFilename;
        let probe = null;
        let probeErr = null;
        try {
            probe = await obsidianFetch({
                host: vault.host,
                port: vault.port,
                apiKey: vault.apiKey,
                https: !!vault.https,
                path: `/vault/${encodeVaultPath(candidatePath)}`,
                accept: 'text/markdown',
            });
        } catch (err) {
            probeErr = err;
        }
        // V-C2: classifyDedupProbe is the single source of truth for accept/taken/
        // inconclusive. Non-Abort errors used to return the candidate "assume free"
        // here, causing silent overwrites when a real file existed but the check
        // glitched. The classifier returns {accept:false, taken:false} for any
        // error (Abort or otherwise) — caller fails loud.
        const verdict = classifyDedupProbe(probe, probeErr);
        if (verdict.taken) {
            attempt++;
            suffix = `_imported_${attempt}`;
            continue;
        }
        if (!verdict.accept) {
            if (probeErr) {
                console.warn(`[DLE Import] _findUniquePath: existence check for "${candidatePath}" failed (${probeErr.name || 'Error'}): ${probeErr.message}`);
            }
            return null;
        }
        return candidatePath;
    }
    return null;
}

/**
 * Import an array of ST World Info entries into the Obsidian vault.
 * @param {object[]} entries - Array of ST WI entry objects
 * @param {string} folder - Target folder in the vault
 * @param {function} [onProgress] - Optional callback(imported, total) for progress updates
 * @param {object} [options]
 * @param {boolean|string} [options.compress] - #18: caveman-compress each entry's body
 *   before write. Defaults to `settings.importCompressByDefault`.
 * @returns {Promise<{ imported: number, failed: number, errors: string[] }>}
 */
export async function importEntries(entries, folder, onProgress, options = {}) {
    const settings = getSettings();
    const vault = getPrimaryVault(settings);
    const lorebookTag = settings.lorebookTag;
    const compress = options.compress ?? settings.importCompressByDefault;

    let imported = 0;
    let failed = 0;
    const errors = [];

    let renamed = 0;
    for (const wiEntry of entries) {
        try {
            const { filename, content } = convertWiEntry(wiEntry, lorebookTag, { compress });
            let fullPath = folder ? `${folder}/${filename}` : filename;

            // Check existence to avoid silent overwrites.
            try {
                const checkResult = await obsidianFetch({
                    host: vault.host,
                    port: vault.port,
                    apiKey: vault.apiKey,
                    https: !!vault.https,
                    path: `/vault/${encodeVaultPath(fullPath)}`,
                    accept: 'text/markdown',
                });
                if (checkResult.status === 200) {
                    const candidatePath = await _findUniquePath(vault, filename, folder);
                    if (!candidatePath) {
                        // V-C2: covers abort, network error, AND cap exhausted.
                        errors.push(`${filename}: skipped — dedup check failed (network error, aborted, or exceeded ${MAX_DEDUP_ATTEMPTS} attempts)`);
                        failed++;
                        continue;
                    }
                    fullPath = candidatePath;
                    renamed++;
                }
            } catch (existErr) {
                // obsidianFetch returns {status, data} for all HTTP responses including 404,
                // so a thrown error is always a network/timeout problem.
                console.warn(`[DLE Import] Network error checking existence of "${fullPath}":`, existErr.message);
                errors.push(`${filename}: skipped — could not verify existence (${existErr.message})`);
                failed++;
                continue;
            }

            const result = await writeNote(vault.host, vault.port, vault.apiKey, fullPath, content, !!vault.https);
            if (result.ok) {
                imported++;
            } else {
                failed++;
                errors.push(`${filename}: ${result.error}`);
            }
        } catch (err) {
            failed++;
            errors.push(`Entry: ${err.message}`);
        }
        if (onProgress) onProgress(imported + failed, entries.length);
    }

    return { imported, failed, renamed, errors };
}

/**
 * PR #28.2 — Single-entry convert-and-upsert for companion-extension integration.
 * Converts one ST World Info entry to vault markdown and writes it according to
 * the requested collision policy. Companion extensions that want to push a single
 * entry (one suggestion, one quick-import) can call this without running the full
 * batch `importEntries` flow.
 *
 * @param {object} wiEntry - one ST WI entry
 * @param {string} folder - target folder in the vault (empty = root)
 * @param {object} [options]
 * @param {object} [options.vault] - explicit {host, port, apiKey, https} override.
 *   Defaults to the user's configured autoSuggest vault (`resolveWriteVault('autoSuggest')`)
 *   since single-entry upserts are the same write-shape as auto-lorebook.
 * @param {'rename'|'replace'|'skip'} [options.policy='rename'] - what to do on collision.
 *   'rename' = append _imported / _imported_N suffix; 'replace' = overwrite the existing
 *   file; 'skip' = bail with action: 'skipped'.
 * @param {boolean|string} [options.compress] - #18: caveman-compress the body before
 *   write. Defaults to `settings.importCompressByDefault`.
 * @returns {Promise<{ ok: boolean, action: 'created'|'replaced'|'renamed'|'skipped'|null, path: string, error?: string }>}
 */
export async function upsertConvertedEntry(wiEntry, folder, options = {}) {
    const { vault, policy = 'rename' } = options;
    const settings = getSettings();
    const targetVault = vault || resolveWriteVault('autoSuggest', settings);
    if (!targetVault?.host || !targetVault?.port || !targetVault?.apiKey) {
        return { ok: false, action: null, path: '', error: 'No vault configured (host/port/apiKey missing)' };
    }
    const compress = options.compress ?? settings.importCompressByDefault;

    let filename, content;
    try {
        ({ filename, content } = convertWiEntry(wiEntry, settings.lorebookTag, { compress }));
    } catch (err) {
        return { ok: false, action: null, path: '', error: `convert failed: ${err.message}` };
    }

    let fullPath = folder ? `${folder}/${filename}` : filename;
    let existed = false;
    try {
        const check = await obsidianFetch({
            host: targetVault.host,
            port: targetVault.port,
            apiKey: targetVault.apiKey,
            https: !!targetVault.https,
            path: `/vault/${encodeVaultPath(fullPath)}`,
            accept: 'text/markdown',
        });
        existed = check.status === 200;
    } catch (err) {
        return { ok: false, action: null, path: fullPath, error: `existence check failed: ${err.message}` };
    }

    if (existed) {
        if (policy === 'skip') return { ok: true, action: 'skipped', path: fullPath };
        if (policy === 'rename') {
            const candidatePath = await _findUniquePath(targetVault, filename, folder);
            if (!candidatePath) {
                // V-C2: covers abort, network error, AND cap exhausted.
                return { ok: false, action: null, path: fullPath, error: `dedup check failed (network error, aborted, or exceeded ${MAX_DEDUP_ATTEMPTS} attempts)` };
            }
            fullPath = candidatePath;
        }
        // policy === 'replace' falls through — writeNote overwrites.
    }

    const result = await writeNote(targetVault.host, targetVault.port, targetVault.apiKey, fullPath, content, !!targetVault.https);
    if (!result.ok) {
        return { ok: false, action: null, path: fullPath, error: result.error };
    }
    const action = existed ? (policy === 'replace' ? 'replaced' : 'renamed') : 'created';
    return { ok: true, action, path: fullPath };
}

/**
 * Parse ST World Info JSON (handles both export format and embedded character card format).
 * @param {string} jsonText - Raw JSON text
 * @returns {{ entries: object[], source: string }}
 */
export function parseWorldInfoJson(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
    } catch (e) {
        throw new Error('Invalid World Info JSON: ' + e.message);
    }

    const filterValid = (arr) => arr.filter(e => e && typeof e === 'object' && !Array.isArray(e));

    // Direct WI export { entries: { 0: {...}, 1: {...} } }
    if (data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
        const entries = filterValid(Object.values(data.entries));
        return { entries, source: data.originalData?.name || 'World Info' };
    }

    if (Array.isArray(data)) {
        return { entries: filterValid(data), source: 'World Info Array' };
    }

    // V2 character card with embedded WI
    if (data.data?.character_book?.entries) {
        const raw = Array.isArray(data.data.character_book.entries)
            ? data.data.character_book.entries
            : Object.values(data.data.character_book.entries);
        const entries = filterValid(raw);
        return { entries, source: data.data?.name || 'Character Card' };
    }

    throw new Error('Unrecognized World Info format. Expected ST WI export JSON or V2 character card.');
}
