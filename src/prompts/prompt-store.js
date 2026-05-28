/**
 * DeepLore Enhanced — Runtime prompt resolver + cache.
 *
 * Two-layer resolution:
 *   1. In-memory `promptCache` Map (populated at boot from vault override
 *      files + compiled-in dict, refreshed by `reloadPrompts()`).
 *   2. Compiled-in canonical dict at the current `aiPromptLocale` (fallback
 *      when vault file missing or invalid).
 *
 * `getPrompt(key)` is **synchronous** by design: it must be callable inside
 * tight loops (agentic loop, fence builders) without await overhead. The
 * cache is preloaded at boot, so every lookup is a Map hit.
 *
 * Vault override wiring lands in Commit 4. This commit ships the resolver
 * with only the compiled-in dict in the cache — runtime behavior matches
 * pre-feature exactly until the override layer activates.
 */

import * as PromptsEn from '../i18n/prompts/en.js';
import { resolveLocale } from '../i18n/i18n-pure.js';
import {
    buildPromptOverlay,
    normalizePromptBody,
    promptHash,
    computePromptStatus,
} from './prompt-store-pure.js';
import { KNOWN_PROMPT_KEYS, sanitizePromptsFolderPath } from './prompt-validators.js';
import {
    listPromptsFolder,
    fetchPromptFile,
    DLE_PROMPTS_DEFAULT_DIR,
} from './prompt-api.js';

/**
 * Dynamically import the AI prompt dict for a given locale.
 * Falls back to the EN dict on import failure (locale missing or syntax error).
 *
 * Kept local to this module so unit tests can run under Node — the live
 * loader in `src/i18n/i18n.js` imports ST runtime modules via a relative
 * path that resolves only inside SillyTavern, breaking node-side tests.
 *
 * @param {string | null | undefined} locale
 * @returns {Promise<object>}
 */
async function loadAiPromptDict(locale) {
    const target = resolveLocale(locale || 'en');
    try {
        return await import(`../i18n/prompts/${target}.js`);
    } catch (err) {
        console.warn(`[DLE prompts] AI prompt dict for "${target}" missing, falling back to en:`, err);
        return PromptsEn;
    }
}

/**
 * In-memory cache. Map<key, string>. Populated by `loadPrompts()` at boot
 * and rebuilt by `reloadPrompts()` on user click.
 *
 * Keys are prompt names (`'SCRIBE_PROMPT'`). Values are the resolved string
 * to return from `getPrompt()`.
 *
 * @type {Map<string, string>}
 */
const promptCache = new Map();

/**
 * Per-key metadata for the Prompts tab status grid. Map<key, metadata>.
 *
 *   source:        'vault' | 'compiled-in'
 *   bodyHash:      promptHash of the resolved value
 *   sourceHash:    frontmatter source_hash from vault file (null if no override)
 *   canonicalHash: promptHash of the compiled-in dict value at current locale
 *   status:        result of computePromptStatus(...)
 *   error:         present if the override file was invalid (status fell back)
 *
 * @type {Map<string, object>}
 */
const promptMeta = new Map();

let _currentLocale = 'en';
let _loaded = false;

/**
 * Last-seen list of validation errors from `loadPrompts`. UI surfaces this
 * via toastr/Prompts tab.
 *
 * @type {Array<{ key: string, reason: string }>}
 */
let _lastLoadErrors = [];

/**
 * Last connection params used by loadPrompts. Reload re-uses them.
 *
 * @type {object | null}
 */
let _lastConnection = null;

/**
 * Resolve a prompt by key.
 *
 * Lookup order:
 *   1. promptCache Map — hot path, sync, populated at boot.
 *   2. compiled-in dict at `_currentLocale` (fallback).
 *   3. compiled-in EN dict (fallback of fallback).
 *   4. empty string + console warning (orphan key).
 *
 * @param {string} key
 * @returns {string}
 */
export function getPrompt(key) {
    if (typeof key !== 'string' || key === '') {
        console.warn('[DLE prompts] getPrompt called with invalid key:', key);
        return '';
    }
    if (promptCache.has(key)) {
        return promptCache.get(key);
    }
    // Fallback path — cache miss. Happens before loadPrompts() runs, or for
    // keys not in the canonical dict (shouldn't happen in normal use).
    const enValue = PromptsEn[key];
    if (typeof enValue === 'string') {
        return enValue;
    }
    console.warn(`[DLE prompts] unknown key: ${key}`);
    return '';
}

/**
 * Load prompts into the cache.
 *
 * Two-stage flow:
 *   1. Compiled-in dict at `locale` → baseline cache + canonical hashes.
 *   2. If `connection` is provided, fetch every override file from the vault
 *      prompts folder, run each through `buildPromptOverlay`, and replace the
 *      cache entries whose overrides validate. Failed overrides remain on the
 *      compiled-in fallback and get reported via `_lastLoadErrors`.
 *
 * Safe to call multiple times. Each call rebuilds the cache from scratch.
 *
 * @param {string} [locale] - aiPromptLocale value. Empty/null = follow UI locale.
 * @param {object | null} [connection] - Vault connection params:
 *   { host, port, apiKey, prefix, useHttps }.
 *   If omitted or null, compiled-in only.
 * @returns {Promise<{ loaded: number, source: 'compiled-in' | 'vault', vaultCount: number, errors: Array<{ key: string, reason: string }> }>}
 */
export async function loadPrompts(locale, connection) {
    const dict = await loadAiPromptDict(locale);
    _currentLocale = (dict && dict.__meta && dict.__meta.locale) || 'en';
    _lastConnection = connection || null;

    // Stage 1 — fetch vault overrides (if connection provided)
    const overrides = new Map();
    let vaultListPartial = false;
    if (connection && connection.host && connection.port && connection.apiKey) {
        const sanitizedPrefix = sanitizePromptsFolderPath(connection.prefix) || DLE_PROMPTS_DEFAULT_DIR;
        const listResult = await listPromptsFolder(
            connection.host,
            connection.port,
            connection.apiKey,
            sanitizedPrefix,
            !!connection.useHttps,
        );
        if (listResult.ok) {
            for (const filename of listResult.files) {
                if (!filename.endsWith('.md')) continue;
                const stem = filename.replace(/\.md$/, '');
                if (!KNOWN_PROMPT_KEYS.has(stem)) continue; // skip unknown files
                const fetchResult = await fetchPromptFile(
                    connection.host,
                    connection.port,
                    connection.apiKey,
                    sanitizedPrefix,
                    stem,
                    !!connection.useHttps,
                );
                if (fetchResult.ok) {
                    overrides.set(stem, fetchResult.content);
                } else if (fetchResult.error !== 'not_found') {
                    console.warn(`[DLE prompts] fetch failed for ${stem}: ${fetchResult.error}`);
                }
            }
        } else {
            vaultListPartial = true;
            console.warn(`[DLE prompts] listPromptsFolder failed: ${listResult.error}`);
        }
    }

    // Stage 2 — pure overlay merge
    const { resolved, meta, errors } = buildPromptOverlay(dict, overrides, KNOWN_PROMPT_KEYS, PromptsEn);

    promptCache.clear();
    promptMeta.clear();
    let loaded = 0;
    let vaultCount = 0;
    for (const [key, value] of resolved) {
        promptCache.set(key, value);
        loaded++;
    }
    for (const [key, m] of meta) {
        promptMeta.set(key, m);
        if (m.source === 'vault') vaultCount++;
    }
    _lastLoadErrors = errors;
    _loaded = true;
    return {
        loaded,
        source: vaultCount > 0 ? 'vault' : 'compiled-in',
        vaultCount,
        errors,
        vaultListPartial,
    };
}

/**
 * Reload prompts. Wrapper that re-runs `loadPrompts()` with the current locale.
 * In Commit 4 this also re-reads the vault folder.
 *
 * @returns {Promise<{ loaded: number, source: string }>}
 */
export async function reloadPrompts() {
    return loadPrompts(_currentLocale, _lastConnection);
}

/**
 * Snapshot the last batch of override-load errors. The Prompts tab UI surfaces
 * these via per-row indicators + a top-level toastr after `loadPrompts`.
 *
 * @returns {Array<{ key: string, reason: string }>}
 */
export function getLastLoadErrors() {
    return _lastLoadErrors.slice();
}

/**
 * Snapshot the per-key status grid. Used by the Prompts tab UI.
 *
 * @returns {Array<{ key: string, source: string, status: string, error: string | null }>}
 */
export function getPromptStatusGrid() {
    const rows = [];
    for (const key of KNOWN_PROMPT_KEYS) {
        const meta = promptMeta.get(key);
        if (!meta) {
            rows.push({ key, source: 'missing', status: 'missing', error: null });
        } else {
            rows.push({
                key,
                source: meta.source,
                status: meta.status,
                error: meta.error,
            });
        }
    }
    return rows;
}

/**
 * Test-only — reset internal state. Called by unit tests between cases.
 *
 * @returns {void}
 */
export function _resetPromptStoreForTests() {
    promptCache.clear();
    promptMeta.clear();
    _currentLocale = 'en';
    _loaded = false;
    _lastLoadErrors = [];
    _lastConnection = null;
}

/**
 * Test-only — inspect whether boot loader has run.
 *
 * @returns {boolean}
 */
export function _isLoadedForTests() {
    return _loaded;
}

/**
 * Test-only — read a meta entry directly.
 *
 * @param {string} key
 * @returns {object | undefined}
 */
export function _getMetaForTests(key) {
    return promptMeta.get(key);
}
