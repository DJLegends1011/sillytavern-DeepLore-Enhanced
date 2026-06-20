/**
 * DeepLore Enhanced — i18n pure-helper tests.
 *
 * Covers locale resolution, AI-prompt locale precedence, dict merge,
 * interpolation, pluralization, key lookup, dict validation, placeholder
 * counting + mismatch detection. ST-importing live loader (i18n.js) is
 * smoke-tested by index.js boot itself — not unit-tested here.
 *
 * Run: node test/i18n.test.mjs
 */

import {
    SUPPORTED_LOCALES,
    resolveLocale,
    resolveAiPromptLocale,
    mergeLocaleDicts,
    lookupKey,
    validateLocaleDict,
    countPlaceholders,
    placeholderMismatch,
} from '../src/i18n/i18n-pure.js';

import { test, section, summary, assert, assertEqual, assertArrayEquals } from './helpers.mjs';

// ════════════════════════════════════════════════════════════════════════════
section('i18n — SUPPORTED_LOCALES shape');
// ════════════════════════════════════════════════════════════════════════════

test('SUPPORTED_LOCALES has expected 7 entries', () => {
    assertEqual(SUPPORTED_LOCALES.length, 7, 'seven locales (en + 6 translations)');
    assert(SUPPORTED_LOCALES.includes('en'), 'has en');
    assert(SUPPORTED_LOCALES.includes('es-es'), 'has es-es');
    assert(SUPPORTED_LOCALES.includes('fr-fr'), 'has fr-fr');
    assert(SUPPORTED_LOCALES.includes('de-de'), 'has de-de');
    assert(SUPPORTED_LOCALES.includes('ja-jp'), 'has ja-jp');
    assert(SUPPORTED_LOCALES.includes('zh-cn'), 'has zh-cn');
    assert(SUPPORTED_LOCALES.includes('ru-ru'), 'has ru-ru');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — resolveLocale fallback chain');
// ════════════════════════════════════════════════════════════════════════════

test('exact match returns input', () => {
    assertEqual(resolveLocale('en'), 'en', 'en');
    assertEqual(resolveLocale('es-es'), 'es-es', 'es-es');
    assertEqual(resolveLocale('fr-fr'), 'fr-fr', 'fr-fr');
    assertEqual(resolveLocale('de-de'), 'de-de', 'de-de');
    assertEqual(resolveLocale('ja-jp'), 'ja-jp', 'ja-jp');
    assertEqual(resolveLocale('zh-cn'), 'zh-cn', 'zh-cn');
    assertEqual(resolveLocale('ru-ru'), 'ru-ru', 'ru-ru');
});

test('case-insensitive match', () => {
    assertEqual(resolveLocale('ES-ES'), 'es-es', 'uppercase normalized');
    assertEqual(resolveLocale('Fr-Fr'), 'fr-fr', 'mixed case normalized');
    assertEqual(resolveLocale('JA-JP'), 'ja-jp', 'JP uppercase normalized');
});

test('base-lang fallback', () => {
    assertEqual(resolveLocale('es'), 'es-es', 'es → es-es');
    assertEqual(resolveLocale('fr'), 'fr-fr', 'fr → fr-fr');
    assertEqual(resolveLocale('de'), 'de-de', 'de → de-de');
    assertEqual(resolveLocale('ja'), 'ja-jp', 'ja → ja-jp');
    assertEqual(resolveLocale('zh'), 'zh-cn', 'zh → zh-cn');
    assertEqual(resolveLocale('ru'), 'ru-ru', 'ru → ru-ru');
});

test('unsupported region falls back to en', () => {
    assertEqual(resolveLocale('pt-br'), 'en', 'pt-br → en (Portuguese unsupported)');
    assertEqual(resolveLocale('it-it'), 'en', 'it-it → en (Italian unsupported)');
    assertEqual(resolveLocale('ko-kr'), 'en', 'ko-kr → en (Korean unsupported)');
});

test('empty/null returns en', () => {
    assertEqual(resolveLocale(''), 'en', 'empty string → en');
    assertEqual(resolveLocale(null), 'en', 'null → en');
    assertEqual(resolveLocale(undefined), 'en', 'undefined → en');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — resolveAiPromptLocale precedence');
// ════════════════════════════════════════════════════════════════════════════

test('settingValue wins when supported', () => {
    assertEqual(
        resolveAiPromptLocale({ settingValue: 'en', override: 'fr-fr', uiLocale: 'es-es' }),
        'en',
        'setting overrides everything'
    );
    assertEqual(
        resolveAiPromptLocale({ settingValue: 'zh-cn', override: null, uiLocale: 'en' }),
        'zh-cn',
        'setting overrides UI'
    );
});

test('override wins when setting empty', () => {
    assertEqual(
        resolveAiPromptLocale({ settingValue: '', override: 'fr-fr', uiLocale: 'es-es' }),
        'fr-fr',
        'override beats UI when no setting'
    );
});

test('UI locale wins when neither setting nor override', () => {
    assertEqual(
        resolveAiPromptLocale({ settingValue: '', override: null, uiLocale: 'ja-jp' }),
        'ja-jp',
        'UI locale used'
    );
});

test('falls through to en when all empty/unsupported', () => {
    assertEqual(
        resolveAiPromptLocale({ settingValue: '', override: null, uiLocale: '' }),
        'en',
        'all empty → en'
    );
    assertEqual(
        resolveAiPromptLocale({ settingValue: 'pt-br', override: 'it-it', uiLocale: 'ko-kr' }),
        'en',
        'all unsupported → en'
    );
});

test('unsupported settingValue ignored, falls through', () => {
    assertEqual(
        resolveAiPromptLocale({ settingValue: 'pt-br', override: 'fr-fr', uiLocale: 'en' }),
        'fr-fr',
        'unsupported setting ignored, override wins'
    );
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — mergeLocaleDicts');
// ════════════════════════════════════════════════════════════════════════════

test('target wins over English base', () => {
    const en = { foo: 'Foo EN', bar: 'Bar EN' };
    const es = { foo: 'Foo ES' };
    const merged = mergeLocaleDicts(en, es);
    assertEqual(merged.foo, 'Foo ES', 'es overrides en');
    assertEqual(merged.bar, 'Bar EN', 'en fills gap');
});

test('strips __meta from both inputs', () => {
    const en = { __meta: { x: 1 }, foo: 'F' };
    const es = { __meta: { y: 2 }, foo: 'Fes' };
    const merged = mergeLocaleDicts(en, es);
    assert(!Object.hasOwn(merged, '__meta'), '__meta stripped');
    assertEqual(merged.foo, 'Fes', 'foo present');
});

test('null/undefined inputs return empty merge', () => {
    assertEqual(JSON.stringify(mergeLocaleDicts(null, null)), '{}', 'both null → {}');
    assertEqual(JSON.stringify(mergeLocaleDicts({ a: 1 }, null)), '{"a":1}', 'null target → en only');
    assertEqual(JSON.stringify(mergeLocaleDicts(null, { b: 2 })), '{"b":2}', 'null en → target only');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — trPlural (CLDR plural selection — L7 RED until Phase-1 wires it)');
// ════════════════════════════════════════════════════════════════════════════
//
// L7 DECISION (thermo-nuclear plan §10.1): WIRE a new `trPlural(baseKey, count, ...args)`.
// It uses `Intl.PluralRules(activeLocale).select(count)` → CLDR form, maps that form
// to a shipped key `${baseKey}_${form}` (only `_one`/`_other` ship, so any non-`one`
// form → `_other`), resolves it through `tr()`, then interpolates `count` as `${0}`.
//
// The canonical `_one`/`_other` pairs already ship in every locale, e.g.:
//   "dle_entries_stat_lore_one":   "${0} lore entry"
//   "dle_entries_stat_lore_other": "${0} lore entries"
//
// IMPORT CONSTRAINT (documented): the live `trPlural` is specced to live in
// `src/i18n/i18n.js`, which statically imports ST modules (`../../../../../i18n.js`,
// `script.js`). Those paths do NOT resolve under the node test harness — a top-level
// `import { trPlural } from '../src/i18n/i18n.js'` throws ERR_MODULE_NOT_FOUND and
// would crash THIS ENTIRE suite (taking the canonical-EN + parity tests with it).
// That is why this file (per its header) never statically imports i18n.js.
//
// So this test drives the PURE selection logic the same way the rest of the file does:
// it expects a node-importable pure plural resolver in `i18n-pure.js`. To turn this
// test GREEN, Phase-1 must (a) add exactly this pure selector to `i18n-pure.js`:
//
//     export function trPlural(dict, baseKey, locale, count, ...args)
//       → form  = new Intl.PluralRules(locale).select(count)
//       → key   = `${baseKey}_${form}` if present in dict, else `${baseKey}_other`
//       → return interpolate(dict[key] ?? baseKey, count, ...args)   // count is ${0}
//
// and (b) have the ST-coupled `trPlural` in `i18n.js` delegate to it (binding the
// active dict + active locale from `getCurrentLocale()`). This keeps the ST-free logic
// in `*-pure.js` (the established codebase pattern) and makes `trPlural` unit-testable
// without ST. The signature/order below is the contract — match it so this goes green
// with no test edits. RED today: `i18n-pure.js` exports no such fn.

test('trPlural selects _one/_other via Intl.PluralRules(en) and interpolates count', async () => {
    // Dynamic import so a missing/renamed export is a clean per-test failure, NOT a
    // file-load crash that nukes the rest of the suite.
    const pure = await import('../src/i18n/i18n-pure.js');
    const trPlural = pure.trPlural;

    assert(typeof trPlural === 'function',
        'i18n-pure.js exports a pure trPlural (RED until Phase-1 L7 wires it)');
    if (typeof trPlural !== 'function') return;  // guard so the asserts below don't throw

    // The dict the live wrapper would resolve from (here: the canonical EN pairs).
    const dict = {
        dle_entries_stat_lore_one: '${0} lore entry',
        dle_entries_stat_lore_other: '${0} lore entries',
    };

    // Pin the CLDR expectation explicitly so the contract is self-documenting.
    assertEqual(new Intl.PluralRules('en').select(1), 'one', 'en: 1 → "one" form');
    assertEqual(new Intl.PluralRules('en').select(2), 'other', 'en: 2 → "other" form');

    // count === 1 → _one form, count interpolated as ${0}
    assertEqual(
        trPlural(dict, 'dle_entries_stat_lore', 'en', 1),
        '1 lore entry',
        'count 1 → _one form with count interpolated'
    );
    // count !== 1 → _other form
    assertEqual(
        trPlural(dict, 'dle_entries_stat_lore', 'en', 2),
        '2 lore entries',
        'count 2 → _other form with count interpolated'
    );
});

test('trPlural falls back to _other for non-"one" CLDR forms (Russian few/many → _other)', async () => {
    const pure = await import('../src/i18n/i18n-pure.js');
    const trPlural = pure.trPlural;

    assert(typeof trPlural === 'function',
        'i18n-pure.js exports a pure trPlural (RED until Phase-1 L7 wires it)');
    if (typeof trPlural !== 'function') return;

    const dict = {
        dle_entries_stat_lore_one: '${0} lore entry',
        dle_entries_stat_lore_other: '${0} lore entries',
    };

    // Russian: 1 → "one", 2 → "few", 5 → "many". Only _one/_other ship, so any
    // non-"one" form must collapse to _other (plan §10.1 Russian caveat).
    assertEqual(new Intl.PluralRules('ru').select(2), 'few', 'ru: 2 → "few" form (no _few key shipped)');
    assertEqual(
        trPlural(dict, 'dle_entries_stat_lore', 'ru', 2),
        '2 lore entries',
        'ru count 2 (few) collapses to _other'
    );
    // ru count 1 → "one" → _one
    assertEqual(
        trPlural(dict, 'dle_entries_stat_lore', 'ru', 1),
        '1 lore entry',
        'ru count 1 (one) → _one'
    );
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — lookupKey');
// ════════════════════════════════════════════════════════════════════════════

test('returns value when key in dict', () => {
    assertEqual(lookupKey({ foo: 'Foo' }, 'foo', null), 'Foo', 'direct hit');
});

test('falls back to EN dict when key missing in active', () => {
    const active = { bar: 'Bar ES' };
    const en = { foo: 'Foo EN', bar: 'Bar EN' };
    assertEqual(lookupKey(active, 'foo', en), 'Foo EN', 'EN fallback hit');
});

test('returns default when both dicts miss', () => {
    assertEqual(lookupKey({}, 'missing', {}, 'fallback'), 'fallback', 'default used');
});

test('returns key itself when no default and no hit', () => {
    assertEqual(lookupKey({}, 'missing', {}), 'missing', 'key fallback');
});

test('handles null dicts gracefully', () => {
    assertEqual(lookupKey(null, 'key', null, 'def'), 'def', 'null dicts → default');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — validateLocaleDict');
// ════════════════════════════════════════════════════════════════════════════

test('valid dict has no errors', () => {
    const errs = validateLocaleDict({ foo: 'Foo', bar: 'Bar' });
    assertArrayEquals(errs, [], 'no errors on valid dict');
});

test('non-object fails', () => {
    assert(validateLocaleDict(null).length > 0, 'null fails');
    assert(validateLocaleDict('string').length > 0, 'string fails');
    assert(validateLocaleDict(123).length > 0, 'number fails');
});

test('empty dict fails', () => {
    const errs = validateLocaleDict({});
    assert(errs.some(e => e.includes('empty')), 'empty dict flagged');
});

test('non-string value fails', () => {
    const errs = validateLocaleDict({ good: 'ok', bad: 42 });
    assert(errs.some(e => e.includes('not a string')), 'numeric value flagged with type-specific reason');
});

test('__meta excluded from validation', () => {
    const errs = validateLocaleDict({ __meta: { x: 1 }, foo: 'F' });
    assertArrayEquals(errs, [], '__meta with non-string ok');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — countPlaceholders');
// ════════════════════════════════════════════════════════════════════════════

test('counts indexed placeholders (unique-index semantics)', () => {
    assertEqual(countPlaceholders('${0} ${1}').indexed, 2, '2 distinct indices');
    assertEqual(countPlaceholders('plain').indexed, 0, 'none');
    assertEqual(countPlaceholders('${0} ${0}').indexed, 1, 'duplicate same index counted once');
    assertEqual(countPlaceholders('${0} ${1} ${0}').indexed, 2, 'mixed: 2 distinct indices');
});

test('counts mustache placeholders', () => {
    assertEqual(countPlaceholders('{{maxEntries}}').mustache, 1, 'one mustache');
    assertEqual(countPlaceholders('{{a}} {{b}}').mustache, 2, 'two mustaches');
});

test('counts dle HTML tags', () => {
    const t = '<dle-notes>x</dle-notes>';
    assertEqual(countPlaceholders(t).html, 2, 'open + close counted');
});

test('non-string returns zero counts', () => {
    const c = countPlaceholders(null);
    assertEqual(c.indexed, 0, 'indexed 0');
    assertEqual(c.mustache, 0, 'mustache 0');
    assertEqual(c.html, 0, 'html 0');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — placeholderMismatch');
// ════════════════════════════════════════════════════════════════════════════

test('identical source + translation → no issues', () => {
    const issues = placeholderMismatch('Hello ${0}', 'Hola ${0}');
    assertArrayEquals(issues, [], 'matching placeholders');
});

test('missing placeholder in translation flagged', () => {
    const issues = placeholderMismatch('Hello ${0} ${1}', 'Hola ${0}');
    assert(issues.length > 0, 'mismatch detected');
    assert(issues.some(i => i.includes('indexed')), 'indexed mismatch flagged');
});

test('missing mustache flagged', () => {
    const issues = placeholderMismatch('Max {{maxEntries}}', 'Max');
    assert(issues.length > 0, 'mismatch detected');
    assert(issues.some(i => i.includes('mustache')), 'mustache mismatch flagged');
});

test('html count mismatch flagged', () => {
    const issues = placeholderMismatch('<dle-notes>x</dle-notes>', 'x');
    assert(issues.length > 0, 'mismatch detected');
    assert(issues.some(i => i.includes('html')), 'html mismatch flagged');
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — locale file sanity (canonical dle.en.json)');
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

test('locales/dle.en.json exists and parses', () => {
    let data;
    try {
        data = JSON.parse(readFileSync(resolve(repoRoot, 'locales/dle.en.json'), 'utf8'));
    } catch (e) {
        assert(false, `dle.en.json missing or invalid: ${e.message}`);
        return;
    }
    assert(data.__meta, '__meta present');
    assertEqual(data.__meta.locale, 'en', 'meta locale');
    assert(data.__meta.canonical === true, 'meta canonical=true');
    const keys = Object.keys(data).filter(k => k !== '__meta');
    assert(keys.length > 1000, `key count > 1000 (was ${keys.length})`);
});

test('every value in dle.en.json is a string', () => {
    const data = JSON.parse(readFileSync(resolve(repoRoot, 'locales/dle.en.json'), 'utf8'));
    const errs = validateLocaleDict(data);
    assertArrayEquals(errs, [], `validation errors: ${errs.slice(0, 3).join('; ')}`);
});

test('no bare {N} interpolation in dle.en.json (must be ${N})', () => {
    const data = JSON.parse(readFileSync(resolve(repoRoot, 'locales/dle.en.json'), 'utf8'));
    let violations = 0;
    for (const [k, v] of Object.entries(data)) {
        if (k === '__meta' || typeof v !== 'string') continue;
        if (/(^|[^\$])\{\d+\}/.test(v)) {
            violations++;
            if (violations <= 3) console.error(`    bare {N} in: ${k}`);
        }
    }
    assertEqual(violations, 0, `bare {N} violations (must be 0)`);
});

test('no ternary expressions leaked into values', () => {
    const data = JSON.parse(readFileSync(resolve(repoRoot, 'locales/dle.en.json'), 'utf8'));
    let leaks = 0;
    for (const [k, v] of Object.entries(data)) {
        if (k === '__meta' || typeof v !== 'string') continue;
        if (/===\s*\d.*\?/.test(v) || /\?\s*['"][^'"]*['"]\s*:/.test(v)) {
            leaks++;
            if (leaks <= 3) console.error(`    ternary leak in: ${k} = ${v.slice(0, 60)}`);
        }
    }
    assertEqual(leaks, 0, `ternary leaks (must be 0)`);
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — all 6 translation locale files exist + parse');
// ════════════════════════════════════════════════════════════════════════════

const TRANSLATION_LOCALES = ['es-es', 'fr-fr', 'de-de', 'ja-jp', 'zh-cn', 'ru-ru'];

for (const loc of TRANSLATION_LOCALES) {
    test(`locales/dle.${loc}.json exists, parses, has __meta`, () => {
        let data;
        try {
            data = JSON.parse(readFileSync(resolve(repoRoot, `locales/dle.${loc}.json`), 'utf8'));
        } catch (e) {
            assert(false, `dle.${loc}.json missing or invalid: ${e.message}`);
            return;
        }
        assert(data.__meta, '__meta present');
        assertEqual(data.__meta.locale, loc, 'meta locale matches');
        assert(data.__meta.canonical === false, 'meta canonical=false (translated)');
        assert(data.__meta.machine_translated === true, 'meta machine_translated=true');
        const keys = Object.keys(data).filter(k => k !== '__meta');
        assertEqual(keys.length, 2306, `${loc} key count matches canonical (2306)`);
    });
}

test('every translation has same key set as canonical EN', () => {
    const en = JSON.parse(readFileSync(resolve(repoRoot, 'locales/dle.en.json'), 'utf8'));
    const enKeys = new Set(Object.keys(en).filter(k => k !== '__meta'));
    for (const loc of TRANSLATION_LOCALES) {
        const data = JSON.parse(readFileSync(resolve(repoRoot, `locales/dle.${loc}.json`), 'utf8'));
        const locKeys = new Set(Object.keys(data).filter(k => k !== '__meta'));
        const missing = [...enKeys].filter(k => !locKeys.has(k));
        const extra = [...locKeys].filter(k => !enKeys.has(k));
        assertEqual(missing.length, 0, `${loc} missing ${missing.length} keys (first: ${missing[0] || 'n/a'})`);
        assertEqual(extra.length, 0, `${loc} extra ${extra.length} keys (first: ${extra[0] || 'n/a'})`);
    }
});

test('placeholders preserved across all translations', () => {
    const en = JSON.parse(readFileSync(resolve(repoRoot, 'locales/dle.en.json'), 'utf8'));
    let totalMismatches = 0;
    for (const loc of TRANSLATION_LOCALES) {
        const data = JSON.parse(readFileSync(resolve(repoRoot, `locales/dle.${loc}.json`), 'utf8'));
        for (const [k, v] of Object.entries(en)) {
            if (k === '__meta' || typeof v !== 'string') continue;
            if (!data[k] || typeof data[k] !== 'string') continue;
            if (data[k] === v) continue;  // English fallback — skip
            const issues = placeholderMismatch(v, data[k]);
            if (issues.length > 0) {
                totalMismatches++;
                if (totalMismatches <= 5) {
                    console.error(`    ${loc} key ${k}: ${issues.join(', ')}`);
                }
            }
        }
    }
    assertEqual(totalMismatches, 0, `total placeholder mismatches across translations`);
});

// ════════════════════════════════════════════════════════════════════════════
section('i18n — AI prompt locale files');
// ════════════════════════════════════════════════════════════════════════════

const REQUIRED_PROMPT_EXPORTS = [
    'EMMA_FIRSTRUN_GREETING',
    'EMMA_ADHOC_GREETING',
    'EMMA_AUDIT_GREETING',
    'LIBRARIAN_PRIMER',
    'LIBRARIAN_FIRSTRUN_QA_SCRIPT',
    'AGENTIC_ROLE_SECTION',
    'AGENTIC_TOOLS_INTRO',
    'AGENTIC_TOOL_SEARCH',
    'AGENTIC_TOOL_WRITE',
    'AGENTIC_TOOL_FLAG',
    'AI_SEARCH_SYSTEM_PROMPT',
    'AI_NOTEPAD_PROMPT',
    'SCRIBE_PROMPT',
    'AUTO_SUGGEST_PROMPT',
    'OPTIMIZE_KEYS_PROMPT',
    'SUMMARIZE_PROMPT',
    '__meta',
];

// Pre-load all prompt modules (top-level await is supported in .mjs)
const PROMPT_MODULES = {};
for (const loc of ['en', ...TRANSLATION_LOCALES]) {
    try {
        PROMPT_MODULES[loc] = await import(`../src/i18n/prompts/${loc}.js`);
    } catch (e) {
        PROMPT_MODULES[loc] = { __error: e.message };
    }
}

for (const loc of ['en', ...TRANSLATION_LOCALES]) {
    test(`src/i18n/prompts/${loc}.js has required exports`, () => {
        const mod = PROMPT_MODULES[loc];
        if (mod.__error) {
            assert(false, `prompts/${loc}.js failed to load: ${mod.__error}`);
            return;
        }
        for (const exp of REQUIRED_PROMPT_EXPORTS) {
            assert(mod[exp] !== undefined, `${loc}.js exports ${exp}`);
        }
        assertEqual(mod.__meta.locale, loc, 'meta locale matches filename');
    });
}

await summary('i18n pure helpers');
