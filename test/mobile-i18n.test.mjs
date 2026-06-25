import { readFileSync } from 'node:fs';
import { assert, assertEqual, test, summary } from './helpers.mjs';
import { configureMobileI18n, mt, mtf, resetMobileI18n } from '../src/mobile/mobile-i18n.js';
import { createMobileShell } from '../src/mobile/mobile-shell.js';

test('mobile i18n: defaults to English fallback in headless tests', () => {
    resetMobileI18n();
    assertEqual(mt('dle_mobile_tab_injection', 'Injection'), 'Injection');
    assertEqual(mtf('dle_mobile_status_subtitle', '${0} · ${1} injected', 'Ready', 2), 'Ready · 2 injected');
});

test('mobile i18n: delegates to v2.5 helpers', () => {
    configureMobileI18n({
        translate: (key) => `tr:${key}`,
        format: (key, ...args) => `${key}:${args.join('|')}`,
    });
    assertEqual(mt('dle_mobile_tab_browse', 'Browse'), 'tr:dle_mobile_tab_browse');
    assertEqual(mtf('dle_mobile_status_subtitle', '${0} · ${1} injected', 'Ready', 2), 'Ready · 2 injected');
    resetMobileI18n();
});


test('mobile i18n: no-DOM shell creation does not leak configured helpers', () => {
    resetMobileI18n();
    const shell = createMobileShell({
        translate: (key) => `leaked:${key}`,
        format: (key) => `leaked:${key}`,
    });

    assertEqual(shell, null, 'no-DOM shell creation should return null');
    assertEqual(mt('dle_mobile_tab_injection', 'Injection'), 'Injection', 'translate helper should not leak from no-DOM shell creation');
    assertEqual(mtf('dle_mobile_status_subtitle', '${0} \u00b7 ${1} injected', 'Ready', 2), 'Ready \u00b7 2 injected', 'format helper should not leak from no-DOM shell creation');
    resetMobileI18n();
});

test('mobile i18n: every referenced key exists in canonical English', () => {
    const files = [
        '../src/mobile/mobile-shell.js',
        '../src/mobile/mobile-overlay.js',
        '../src/mobile/mobile-fab.js',
        '../src/mobile/mobile-browse.js',
        '../src/mobile/mobile-injection.js',
        '../src/mobile/mobile-stats.js',
    ];
    const keys = new Set();
    for (const file of files) {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        for (const match of source.matchAll(/['"](dle_mobile_[^'"]+)['"]/g)) keys.add(match[1]);
    }
    assert(keys.has('dle_mobile_quick_refresh_label'), 'metadata labelKey references are scanned');
    assert(keys.has('dle_mobile_status_degraded'), 'tuple status label references are scanned');
    const dict = JSON.parse(readFileSync(new URL('../locales/dle.en.json', import.meta.url), 'utf8'));
    for (const key of keys) assert(Object.hasOwn(dict, key), `missing English key: ${key}`);
});

summary('Mobile i18n tests');
