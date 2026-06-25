/**
 * DeepLore mobile i18n adapter.
 *
 * Pure/mobile-safe wrapper around the v2.5 i18n helpers. In headless tests, no
 * helpers are configured, so callers get their English fallback immediately.
 */

let translateHelper = null;
let formatHelper = null;

function fallbackText(fallback, key = '') {
    if (fallback !== undefined && fallback !== null) return String(fallback);
    return String(key || '');
}

function interpolate(template, ...args) {
    return fallbackText(template).replace(/\$\{(\d+)\}/g, (_match, index) => {
        const value = args[Number(index)];
        return value === undefined || value === null ? '' : String(value);
    });
}

function usableFormattedValue(value, key) {
    if (typeof value !== 'string') return false;
    if (value === key) return false;
    // Test doubles and missing-key formatters often echo the key as a prefix.
    // Treat that as "formatter not usable" and fall back to the English template.
    if (key && value.startsWith(`${key}:`)) return false;
    return true;
}

export function configureMobileI18n(options = {}) {
    translateHelper = typeof options.translate === 'function' ? options.translate : null;
    formatHelper = typeof options.format === 'function' ? options.format : null;
}

export function resetMobileI18n() {
    translateHelper = null;
    formatHelper = null;
}

export function mt(key, fallback) {
    if (translateHelper) {
        try {
            const translated = translateHelper(key, fallback);
            if (typeof translated === 'string' && translated !== key) return translated;
        } catch {
            // Fall through to English fallback.
        }
    }
    return fallbackText(fallback, key);
}

export function mtf(key, fallback, ...args) {
    if (formatHelper) {
        try {
            const formatted = formatHelper(key, ...args);
            if (usableFormattedValue(formatted, key)) return formatted;
        } catch {
            // Fall through to English fallback interpolation.
        }
        return interpolate(fallback, ...args);
    }
    return interpolate(mt(key, fallback), ...args);
}
