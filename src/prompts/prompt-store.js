/**
 * DeepLore — Runtime prompt resolver + cache.
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
 * Vault override overlay is live: `loadPrompts()` fetches override files from
 * the configured prompts folder and overlays them on the compiled-in baseline;
 * `getPrompt(key)` returns the override when present, else the compiled-in dict.
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
 * Dynamically import the AI prompt dict for a given locale. Returns
 * `{ dict, resolvedLocale }`. Falls back to the EN dict + `'en'` locale on
 * import failure (locale missing or syntax error).
 *
 * Canonical entry point — re-used by the boot loader, the Settings popup
 * "Export Prompts" flow, and per-row export actions. The live loader in
 * `src/i18n/i18n.js` imports ST runtime modules via a relative path that
 * resolves only inside SillyTavern, so this helper avoids that import chain
 * to stay node-test-safe.
 *
 * @param {string | null | undefined} locale
 * @returns {Promise<{ dict: object, resolvedLocale: string }>}
 */
export async function getAiPromptDictForLocale(locale) {
    const target = resolveLocale(locale || 'en');
    try {
        const dict = await import(`../i18n/prompts/${target}.js`);
        return { dict, resolvedLocale: target };
    } catch (err) {
        console.warn(`[DLE prompts] AI prompt dict for "${target}" missing, falling back to en:`, err);
        return { dict: PromptsEn, resolvedLocale: 'en' };
    }
}

/**
 * Resolve the per-prompt value the runtime should send to the LLM, honoring
 * a user override before falling back to the editable-prompts cache.
 *
 * The user-override surface predates the v2.5 editable-prompts feature: a
 * handful of settings (`scribePrompt`, `aiSearchSystemPrompt`,
 * `autoSuggestPrompt`, `optimizeKeysPrompt`, `summarySystemPrompt`,
 * `aiNotepadPrompt`) still let the user paste an inline prompt that wins
 * over the vault override + compiled-in dict. This helper centralizes the
 * trim-or-default ladder so every caller agrees.
 *
 * @param {string} key
 * @param {string | null | undefined} userOverride
 * @returns {string}
 */
export function resolvePromptOrOverride(key, userOverride) {
    const trimmed = typeof userOverride === 'string' ? userOverride.trim() : '';
    return trimmed || getPrompt(key);
}

/**
 * Build the vault connection bundle the prompt store needs to read/write
 * override files. Returns null when no usable vault exists, so callers can
 * fall back to compiled-in only without rebuilding the shape literal.
 *
 * Canonical home for the shape — every caller (boot loader + Prompts tab)
 * routes through this single builder.
 *
 * Vault selection: `getPrimaryVault` lives in settings.js, and inlining its
 * lookup here would create a circular import (settings.js indirectly pulls
 * prompt-store via the AI subsystem). So the boot path (no resolved vault)
 * falls back to a plain "first enabled vault" scan, while UI callers that
 * already have the canonical primary-or-default vault pass it via
 * `resolvedVault` to honor the legacy selection rule. Either way the output
 * shape is identical.
 *
 * @param {object} settings
 * @param {object} [resolvedVault] - Optional pre-resolved vault (e.g. from
 *   `getPrimaryVault`). When omitted, the first enabled vault is used.
 * @returns {{ host: string, port: number, apiKey: string, prefix: string, useHttps: boolean } | null}
 */
export function buildPromptsConnectionFromSettings(settings, resolvedVault) {
    if (!settings) return null;
    let vault = resolvedVault || null;
    if (!vault) {
        const vaults = Array.isArray(settings.vaults) ? settings.vaults : [];
        vault = vaults.find(v => v && v.enabled) || null;
    }
    if (!vault || !vault.enabled || !vault.apiKey || !vault.port) return null;
    return {
        host: vault.host || '127.0.0.1',
        port: vault.port,
        apiKey: vault.apiKey,
        useHttps: !!vault.https,
        prefix: sanitizePromptsFolderPath(settings.promptsFolderPath) || DLE_PROMPTS_DEFAULT_DIR,
    };
}

/**
 * Boot-time entry point: load the prompt cache from `settings`, hitting the
 * primary vault if one is enabled. Failures are swallowed so a missing or
 * mis-configured vault never blocks DLE init — the Prompts tab surfaces the
 * error after the popup opens.
 *
 * One-liner orchestration helper so callers don't redefine the
 * connection-build + loadPrompts wiring.
 *
 * @param {object} settings
 * @returns {Promise<void>}
 */
export async function loadPromptsForBoot(settings) {
    try {
        const connection = buildPromptsConnectionFromSettings(settings);
        await loadPrompts(settings?.aiPromptLocale, connection);
    } catch (err) {
        console.warn('[DLE prompts] boot-time load failed:', err?.message);
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
 *   1. promptCache Map — hot path, sync, populated at boot. The cache already
 *      holds the locale-resolved value (loadPrompts merges the active locale's
 *      dict before stamping the cache), so there is no separate locale step.
 *   2. compiled-in EN dict by key (fallback for a cache miss — pre-load, or a
 *      key not yet loaded).
 *   3. empty string + console warning (orphan key — should never happen for a
 *      recognized key).
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
    const { dict, resolvedLocale } = await getAiPromptDictForLocale(locale);
    _currentLocale = resolvedLocale;
    _lastConnection = connection || null;

    // Stage 1 — fetch vault overrides (if connection provided).
    // Listing is sequential (single GET). Per-file fetches are independent —
    // run them in parallel so cold-boot doesn't pay N × RTT for ~30 known
    // prompts. The circuit breaker in `obsidianFetch` is shared by host:port
    // so concurrent failures still trip it together.
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
            const stems = listResult.files
                .filter(f => typeof f === 'string' && f.endsWith('.md'))
                .map(f => f.replace(/\.md$/, ''))
                .filter(stem => KNOWN_PROMPT_KEYS.has(stem));
            const fetches = await Promise.all(stems.map(stem =>
                fetchPromptFile(
                    connection.host,
                    connection.port,
                    connection.apiKey,
                    sanitizedPrefix,
                    stem,
                    !!connection.useHttps,
                ).then(r => ({ stem, result: r })),
            ));
            for (const { stem, result } of fetches) {
                if (result.ok) {
                    overrides.set(stem, result.content);
                } else if (result.error !== 'not_found') {
                    console.warn(`[DLE prompts] fetch failed for ${stem}: ${result.error}`);
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
 * Reload prompts: re-runs `loadPrompts()` with the current locale and last-used
 * vault connection, re-reading any override files from the prompts folder.
 *
 * @returns {Promise<{ loaded: number, source: string, vaultCount: number, errors: Array, vaultListPartial: boolean }>}
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
