import { readFileSync } from 'node:fs';
import { assert, assertEqual, test, summary } from './helpers.mjs';
import { configureMobileI18n, mt, mtf, resetMobileI18n } from '../src/mobile/mobile-i18n.js';

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
        for (const match of source.matchAll(/mtf?\(['"](dle_mobile_[^'"]+)/g)) keys.add(match[1]);
    }
    const dict = JSON.parse(readFileSync(new URL('../locales/dle.en.json', import.meta.url), 'utf8'));
    for (const key of keys) assert(Object.hasOwn(dict, key), `missing English key: ${key}`);
});

summary('Mobile i18n tests');
