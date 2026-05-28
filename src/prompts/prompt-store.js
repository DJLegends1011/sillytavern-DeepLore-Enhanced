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
import { promptHash, computePromptStatus } from './prompt-store-pure.js';
import { KNOWN_PROMPT_KEYS } from './prompt-validators.js';

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
 * In this commit (cache + resolver foundation), the cache is populated from
 * the compiled-in dict at the current locale ONLY. Vault override reads
 * land in Commit 4 — at that point this function becomes async and adds
 * vault fetch + validation between the compiled-in load and the cache fill.
 *
 * Safe to call multiple times. Each call rebuilds the cache from scratch.
 *
 * @param {string} [locale] - aiPromptLocale value. Empty/null = follow UI locale.
 * @returns {Promise<{ loaded: number, source: string }>}
 */
export async function loadPrompts(locale) {
    const dict = await loadAiPromptDict(locale);
    _currentLocale = (dict && dict.__meta && dict.__meta.locale) || 'en';
    promptCache.clear();
    promptMeta.clear();
    let loaded = 0;
    for (const key of KNOWN_PROMPT_KEYS) {
        const value = (dict && typeof dict[key] === 'string') ? dict[key] : PromptsEn[key];
        if (typeof value !== 'string') continue;
        promptCache.set(key, value);
        const canonicalHash = promptHash(value);
        promptMeta.set(key, {
            source: 'compiled-in',
            bodyHash: canonicalHash,
            sourceHash: canonicalHash,
            canonicalHash,
            status: computePromptStatus({ bodyHash: canonicalHash, sourceHash: canonicalHash, canonicalHash }),
            error: null,
        });
        loaded++;
    }
    _loaded = true;
    return { loaded, source: 'compiled-in' };
}

/**
 * Reload prompts. Wrapper that re-runs `loadPrompts()` with the current locale.
 * In Commit 4 this also re-reads the vault folder.
 *
 * @returns {Promise<{ loaded: number, source: string }>}
 */
export async function reloadPrompts() {
    return loadPrompts(_currentLocale);
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
