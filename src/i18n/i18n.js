/**
 * DeepLore Enhanced i18n loader
 *
 * Hooks into ST's built-in i18n system (`public/scripts/i18n.js`):
 *   - `addLocaleData(localeId, dict)`  — register extra keys for current locale
 *   - `getCurrentLocale()`             — returns active locale code (e.g. "es-es")
 *   - `t` (tagged template)            — translate with interpolation, e.g. t`Hello ${name}`
 *   - `translate(text, key?)`          — runtime lookup with English fallback
 *
 * Locale sidecars live at `locales/dle.{lang}.json`. English is canonical;
 * other languages are machine-translated and refined by the community.
 *
 * Fallback chain:
 *   1. requested locale (ST locale, or override)
 *   2. base lang (e.g. "es" if "es-es" missing)
 *   3. English (always present in code via t``/translate() default arg)
 *
 * Boot order: import this module from index.js and `await initDleI18n()` very
 * early — before any popup/HTML template render so MutationObserver picks up
 * `data-i18n` attrs as they get inserted.
 */

import { addLocaleData, getCurrentLocale, t, translate } from '../../../../../i18n.js';
import { eventSource, event_types } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import {
    SUPPORTED_LOCALES,
    resolveLocale,
    resolveAiPromptLocale,
    mergeLocaleDicts,
    lookupKey,
    interpolate,
    trPlural as trPluralPure,
} from './i18n-pure.js';

const EXTENSION_BASE = '/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced';

let _dleDict = null;          // active locale dict (post-load)
let _enFallbackDict = null;   // EN base loaded once, used for missing-key fallback
let _dleLocale = null;         // resolved locale code actually loaded
let _initPromise = null;       // dedupe concurrent init calls
let _aiPromptLocale = null;    // override for AI-facing prompts; null = follow UI locale

export { SUPPORTED_LOCALES };

/**
 * Fetch and parse a single locale JSON. Returns {} on 404/parse-error.
 */
async function loadLocaleFile(locale) {
    const url = `${EXTENSION_BASE}/locales/dle.${locale}.json`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[DLE i18n] Locale file not found: ${locale} (${res.status})`);
            return {};
        }
        const data = await res.json();
        // Strip __meta so it doesn't pollute lookups
        if (data.__meta) delete data.__meta;
        return data;
    } catch (e) {
        console.warn(`[DLE i18n] Failed to load locale ${locale}:`, e);
        return {};
    }
}

/**
 * Initialize DLE i18n. Idempotent — concurrent calls return same promise.
 *
 * - Resolves current ST locale
 * - Loads `dle.{locale}.json` (with fallback to `en`)
 * - Registers dict via ST's `addLocaleData()`
 * - Triggers `applyLocale()` indirectly through ST's MutationObserver
 */
export function initDleI18n() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const stLocale = getCurrentLocale();
        const target = resolveLocale(stLocale);

        // Always load EN as base (fallback safety net)
        const enDict = await loadLocaleFile('en');
        let activeDict = enDict;
        let activeLocale = 'en';

        if (target !== 'en') {
            const targetDict = await loadLocaleFile(target);
            // Merge: target wins, but EN fills any gaps so missing keys don't return raw key
            activeDict = mergeLocaleDicts(enDict, targetDict);
            activeLocale = target;
        }

        _dleDict = activeDict;
        _enFallbackDict = enDict;
        _dleLocale = activeLocale;

        // Register with ST. addLocaleData only writes when localeId matches current
        // ST locale — so we always register against ST's currently-loaded locale.
        // For an English-default user (`stLocale === 'en'`), ST's `localeData` is `{}`
        // and addLocaleData populates it; for non-EN, addLocaleData merges into the
        // active dict so `data-i18n` lookups see our keys.
        addLocaleData(stLocale, activeDict);
        // Boot-race guard: ST's addLocaleData silently no-ops if its own `localeData` isn't
        // loaded yet (initLocales hasn't resolved). If DLE's init wins that race the ENTIRE
        // dictionary is dropped with only a console.warn and no recovery. Re-register once at
        // APP_READY (idempotent — merges the same dict) so a lost race self-heals.
        try {
            eventSource.once(event_types.APP_READY, () => {
                try { addLocaleData(getCurrentLocale() || stLocale, activeDict); } catch { /* noop */ }
            });
        } catch { /* eventSource/APP_READY unavailable (e.g. tests) — initial call stands */ }

        console.log(`[DLE i18n] Loaded ${Object.keys(activeDict).length} keys for locale "${activeLocale}" (ST locale: "${stLocale}")`);
    })();
    return _initPromise;
}

/**
 * Synchronous lookup. Use when caller has the key (preferred for static strings).
 * Returns English fallback if key missing.
 *
 * For dynamic strings with variables, prefer `t\`Text ${var}\`` instead.
 */
export function tr(key, fallback) {
    // Defer ST `translate()` call: only invoke it if neither dict has the key, so
    // ST's missing-key tracker (trackDynamicTranslate) doesn't fire on every hit.
    const direct = lookupKey(_dleDict, key, _enFallbackDict);
    if (direct !== key) return direct;
    return fallback !== undefined ? fallback : translate(key);
}

/**
 * Interpolating lookup: `tr(key)` then `${0}`/`${1}`/… substitution. The
 * non-plural sibling of {@link trPlural} — use for any parameterized runtime
 * string that ISN'T a count (toasts, status lines, error messages):
 *
 *   trf('dle_cmd_pin_success_toast', title)   // "Pinned ${0}" → "Pinned Eris"
 *   trf('dle_err_generic', code, detail)      // "${0}: ${1}"
 *
 * Indexed placeholders only (`${0}`-based), matching ST's translator convention
 * and the shared {@link interpolate} pure helper. For "N thing(s)" strings use
 * trPlural (it owns the `_one`/`_other` split); for static strings use tr().
 *
 * @param {string} key   Locale key whose value carries `${0}`… placeholders.
 * @param {...*} args     Values for `${0}`, `${1}`, … in order.
 * @returns {string}
 */
export function trf(key, ...args) {
    return interpolate(tr(key), ...args);
}

/**
 * CLDR-aware plural lookup. Binds the active merged dict + active UI locale and
 * delegates to the pure {@link trPluralPure}. Use for any "N thing(s)" string —
 * splits into `_one`/`_other` (and future `_few`/`_many`) keys so translators
 * control plural form instead of hardcoding English `count === 1 ? '' : 's'`.
 *
 * `count` interpolates as `${0}`; extra `args` map to `${1}`, `${2}`, …
 *
 *   trPlural('dle_popup_entry_count', n)        // "1 entry" / "3 entries"
 *   trPlural('dle_activity_detail', n, toks)    // "1 entry, 12 tok" (${1}=toks)
 *
 * @param {string} baseKey  Key prefix; `_one`/`_other` are appended internally.
 * @param {number} count    Quantity, also interpolated as `${0}`.
 * @param {...*} args        Additional indexed args (`${1}`, …).
 * @returns {string}
 */
export function trPlural(baseKey, count, ...args) {
    // Pass a dict with EN gaps filled so a key missing from the active locale
    // still resolves (mirrors tr()'s _dleDict → _enFallbackDict chain). For an
    // EN user _dleDict already === _enFallbackDict, so this is a cheap merge.
    const dict = mergeLocaleDicts(_enFallbackDict, _dleDict);
    const locale = _dleLocale || resolveLocale(getCurrentLocale());
    return trPluralPure(dict, baseKey, locale, count, ...args);
}

/**
 * Inject localized HTML for elements marked `data-i18n-html="key"`.
 *
 * ST's native `data-i18n` is textContent-only (i18n.js setAttribute/textContent paths),
 * so it escapes any markup in the value. For credit lines, help text, and wizard copy
 * that legitimately contain <strong>/<a>/<code>, we use this custom attribute instead and
 * call this helper once after the template mounts. Inert to ST (it only scans data-i18n).
 * Values are trusted repo locale strings, so innerHTML is safe here. See gotchas.md #72.
 *
 * @param {Element|JQuery} [root=document] Subtree to scan (the just-mounted template root).
 */
export function applyHtmlI18n(root) {
    const el = root && root.jquery ? root[0] : (root || document);
    if (!el || !el.querySelectorAll) return;
    const nodes = [];
    if (el.matches && el.matches('[data-i18n-html]')) nodes.push(el);
    nodes.push(...el.querySelectorAll('[data-i18n-html]'));
    for (const n of nodes) {
        const key = n.getAttribute('data-i18n-html');
        if (key) n.innerHTML = tr(key);
    }
}

/**
 * Tagged template re-export so callers can `import { t } from '.../i18n.js'`.
 * Forwards to ST's `t` — interpolation uses `${0}`, `${1}`, etc. in translation.
 */
export { t, translate, getCurrentLocale };

/**
 * AI prompt locale — separate from UI locale.
 *
 * Read order:
 *   1. explicit override (via setAiPromptLocale)
 *   2. extension setting `aiPromptLocale` (set by Settings UI; null = follow UI)
 *   3. UI locale (getCurrentLocale)
 *   4. 'en'
 *
 * AI prompts are paragraphs, not key-value strings — they live in
 * `src/i18n/prompts/{locale}.js` as ES module exports. Caller does:
 *
 *   const promptModule = await getAiPromptDict();
 *   const sys = promptModule.LIBRARIAN_SYSTEM_PROMPT;
 */
export function setAiPromptLocale(locale) {
    _aiPromptLocale = locale ? resolveLocale(locale) : null;
}

export function getAiPromptLocale() {
    // 1. explicit override
    if (_aiPromptLocale) return _aiPromptLocale;
    // L-33: 2. extension setting `aiPromptLocale` (the documented read-order
    // step that was previously skipped). Guarded so a pre-init/test context
    // where settings aren't available falls through to the UI locale.
    try {
        const settingValue = getSettings()?.aiPromptLocale;
        if (settingValue && SUPPORTED_LOCALES.includes(String(settingValue).toLowerCase())) {
            return String(settingValue).toLowerCase();
        }
    } catch { /* settings unavailable — fall through to UI locale */ }
    // 3. UI locale  4. 'en' (resolveLocale defaults to 'en')
    return resolveLocale(getCurrentLocale());
}

/**
 * Resolve effective AI prompt locale given a settings value.
 * Setting is one of: null/empty (follow UI), 'en', 'es-es', 'fr-fr', etc.
 */
export function getEffectiveAiPromptLocale(settingValue) {
    return resolveAiPromptLocale({
        settingValue,
        override: _aiPromptLocale,
        uiLocale: getCurrentLocale(),
    });
}

/**
 * Dynamic import of AI prompt dict for a given locale.
 * Returns the en module on failure.
 */
export async function getAiPromptDict(locale) {
    const target = resolveLocale(locale || getAiPromptLocale());
    try {
        const mod = await import(`./prompts/${target}.js`);
        return mod;
    } catch (e) {
        console.warn(`[DLE i18n] AI prompt dict for "${target}" missing, falling back to en:`, e);
        const enMod = await import('./prompts/en.js');
        return enMod;
    }
}

/**
 * Test-only reset. Not for production code.
 */
export function _resetI18nForTests() {
    _dleDict = null;
    _enFallbackDict = null;
    _dleLocale = null;
    _initPromise = null;
    _aiPromptLocale = null;
}

/**
 * Stats for diagnostics.
 */
export function getI18nStats() {
    return {
        locale: _dleLocale,
        stLocale: getCurrentLocale(),
        keyCount: _dleDict ? Object.keys(_dleDict).length : 0,
        aiPromptLocaleOverride: _aiPromptLocale,
        supported: [...SUPPORTED_LOCALES],
    };
}
