/**
 * DeepLore Enhanced — i18n pure helpers.
 *
 * No ST imports. Safe to unit-test with `node test/i18n.test.mjs`.
 * The ST-integrated loader lives in `i18n.js` and re-uses these.
 */

export const SUPPORTED_LOCALES = ['en', 'es-es', 'fr-fr', 'de-de', 'ja-jp', 'zh-cn', 'ru-ru'];

/**
 * Resolve a locale request to one we ship. Falls back through:
 *   1. exact match (case-insensitive)
 *   2. base-lang match (e.g. "es" → "es-es")
 *   3. "en"
 */
export function resolveLocale(requested) {
    if (!requested) return 'en';
    const lc = String(requested).toLowerCase();
    if (SUPPORTED_LOCALES.includes(lc)) return lc;
    const base = lc.split('-')[0];
    const match = SUPPORTED_LOCALES.find(l => l === base || l.startsWith(base + '-'));
    return match || 'en';
}

/**
 * Resolve the effective AI prompt locale given a settings value, an explicit
 * override, and the UI locale. Precedence:
 *   1. settingValue if non-empty and supported
 *   2. override if provided
 *   3. uiLocale
 *   4. 'en'
 */
export function resolveAiPromptLocale({ settingValue, override, uiLocale }) {
    if (settingValue && SUPPORTED_LOCALES.includes(String(settingValue).toLowerCase())) {
        return String(settingValue).toLowerCase();
    }
    if (override && SUPPORTED_LOCALES.includes(String(override).toLowerCase())) {
        return String(override).toLowerCase();
    }
    return resolveLocale(uiLocale);
}

/**
 * Merge English base dict with a target locale dict. Target wins for every key
 * present in target; English fills any gap. Strips `__meta` from both inputs so
 * it doesn't pollute lookups.
 */
export function mergeLocaleDicts(enDict, targetDict) {
    const en = { ...(enDict || {}) };
    const tgt = { ...(targetDict || {}) };
    delete en.__meta;
    delete tgt.__meta;
    return { ...en, ...tgt };
}

/**
 * Apply ${0}, ${1} placeholder substitution. Used as a fallback when callers
 * don't go through ST's tagged-template `t``\`. Indexed only — for translator
 * compatibility (matches ST i18n convention).
 */
export function interpolate(text, ...values) {
    if (typeof text !== 'string') return text;
    return text.replace(/\$\{(\d+)\}/g, (m, idx) => {
        const i = Number(idx);
        return values[i] !== undefined ? String(values[i]) : m;
    });
}

/**
 * CLDR-aware plural selection. Translators split a plural string into `_one` /
 * `_other` keys (and, eventually, `_few` / `_many` for languages that need them);
 * this resolves the right form at runtime from `count` and the active `locale`.
 *
 * Selection: `new Intl.PluralRules(locale).select(count)` yields a CLDR category
 * (`zero/one/two/few/many/other`). We try `${baseKey}_${form}`; since only
 * `_one`/`_other` ship today, any non-`one` form (e.g. Russian `few`/`many`)
 * collapses to `${baseKey}_other`. If neither key is present we fall back to the
 * bare `baseKey` so a missing pair surfaces visibly rather than printing blank.
 *
 * `count` is interpolated as `${0}`; any extra `args` map to `${1}`, `${2}`, …
 * via the shared {@link interpolate} mechanism (indexed, translator-friendly).
 *
 * Pure — the ST-coupled wrapper in `i18n.js` binds the active merged dict + the
 * active UI locale and delegates here so this stays unit-testable without ST.
 *
 * @param {Record<string,string>} dict  Resolved (merged) locale dict.
 * @param {string} baseKey  Key prefix; `_one`/`_other` are appended.
 * @param {string} locale   BCP-47 locale code for Intl.PluralRules.
 * @param {number} count    The quantity — also interpolated as `${0}`.
 * @param {...*} args        Additional indexed interpolation args (`${1}`, …).
 * @returns {string}
 */
export function trPlural(dict, baseKey, locale, count, ...args) {
    let form = 'other';
    try {
        form = new Intl.PluralRules(locale || 'en').select(count);
    } catch {
        // Invalid/unsupported locale → safe default category.
        form = 'other';
    }
    const d = dict || {};
    const formKey = `${baseKey}_${form}`;
    const key = Object.hasOwn(d, formKey) ? formKey : `${baseKey}_other`;
    const template = Object.hasOwn(d, key) ? d[key] : baseKey;
    return interpolate(template, count, ...args);
}

/**
 * Look up a key from a dict, with optional English fallback. Used by `tr()`
 * in the live module. Returns the key itself if neither dict has it (so missing
 * keys surface visibly during dev rather than silently empty).
 */
export function lookupKey(dict, key, enFallbackDict, defaultValue) {
    if (dict && Object.hasOwn(dict, key)) return dict[key];
    if (enFallbackDict && Object.hasOwn(enFallbackDict, key)) return enFallbackDict[key];
    if (defaultValue !== undefined) return defaultValue;
    return key;
}

/**
 * Validate that a locale dict is shape-valid. Used in tests.
 * Returns array of error strings (empty = valid).
 */
export function validateLocaleDict(dict) {
    const errs = [];
    if (!dict || typeof dict !== 'object') {
        errs.push('not an object');
        return errs;
    }
    let keyCount = 0;
    for (const [k, v] of Object.entries(dict)) {
        if (k === '__meta') continue;
        keyCount++;
        if (typeof k !== 'string' || k.length === 0) {
            errs.push(`bad key: ${JSON.stringify(k)}`);
        }
        if (typeof v !== 'string') {
            errs.push(`key "${k}" value is not a string: ${typeof v}`);
        }
    }
    if (keyCount === 0) errs.push('empty dict (no non-meta keys)');
    return errs;
}

/**
 * Count placeholders in a string. Used for translation-consistency checks.
 *
 * `indexed` counts the number of distinct indices used (e.g. `${0} and ${0}` → 1).
 * ST's `t``\` tagged template allows referencing the same arg multiple times —
 * what matters for translation parity is that the SET of indices matches source.
 */
export function countPlaceholders(text) {
    if (typeof text !== 'string') return { indexed: 0, mustache: 0, html: 0 };
    const indexedMatches = text.match(/\$\{\d+\}/g) || [];
    const uniqueIndices = new Set(indexedMatches);
    const mustache = (text.match(/\{\{[a-zA-Z_]\w*\}\}/g) || []).length;
    const html = (text.match(/<\/?dle[-_]/g) || []).length;
    return { indexed: uniqueIndices.size, mustache, html };
}

/**
 * Compare placeholder structure between source and translation. Used by Wave 5
 * translation verification.
 */
export function placeholderMismatch(source, translation) {
    const a = countPlaceholders(source);
    const b = countPlaceholders(translation);
    const issues = [];
    if (a.indexed !== b.indexed) issues.push(`indexed: source=${a.indexed} vs translation=${b.indexed}`);
    if (a.mustache !== b.mustache) issues.push(`mustache: source=${a.mustache} vs translation=${b.mustache}`);
    if (a.html !== b.html) issues.push(`html: source=${a.html} vs translation=${b.html}`);
    return issues;
}
