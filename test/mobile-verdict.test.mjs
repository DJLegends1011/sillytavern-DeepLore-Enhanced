import { assert, assertEqual, test, summary } from './helpers.mjs';
import {
    normalizeMobileVerdict,
    readMobileVerdict,
    subscribeMobileVerdict,
} from '../src/mobile/mobile-verdict.js';

test('normalizeMobileVerdict: maps current Verdict sources and trace', () => {
    const trace = { gatedOut: [{ title: 'Filtered' }] };
    const result = normalizeMobileVerdict({
        chatId: 'chat-a',
        msgIdx: 7,
        injectedSources: [{ title: 'Injected' }],
        trace,
    });
    assertEqual(result.chatId, 'chat-a');
    assertEqual(result.msgIdx, 7);
    assertEqual(result.injectedSources[0].title, 'Injected');
    assert(result.trace === trace, 'trace identity should be preserved');
});

test('normalizeMobileVerdict: missing Verdict becomes an empty generation', () => {
    const result = normalizeMobileVerdict(null);
    assertEqual(result.chatId, null);
    assertEqual(result.msgIdx, -1);
    assertEqual(result.injectedSources.length, 0);
    assertEqual(result.trace, null);
});

test('readMobileVerdict: reads the provider and contains provider failures', () => {
    assertEqual(readMobileVerdict(() => ({ injectedSources: [{ title: 'A' }] })).injectedSources.length, 1);
    assertEqual(readMobileVerdict(() => { throw new Error('stale chat'); }).injectedSources.length, 0);
});

test('subscribeMobileVerdict: returns the provider cleanup', () => {
    let subscribed = false;
    let cleaned = false;
    const cleanup = subscribeMobileVerdict((callback) => {
        subscribed = typeof callback === 'function';
        return () => { cleaned = true; };
    }, () => {});
    assert(subscribed, 'callback should be subscribed');
    cleanup();
    assert(cleaned, 'provider cleanup should run');
});

test('subscribeMobileVerdict: contains provider setup failures', () => {
    let cleanup;
    let threw = false;
    try {
        cleanup = subscribeMobileVerdict(() => { throw new Error('provider unavailable'); }, () => {});
    } catch {
        threw = true;
    }
    assert(!threw, 'provider setup failure should not escape');
    assert(typeof cleanup === 'function', 'setup failure should return a cleanup function');
});

test('subscribeMobileVerdict: contains provider cleanup failures', () => {
    const cleanup = subscribeMobileVerdict(() => () => { throw new Error('cleanup failed'); }, () => {});
    let threw = false;
    try {
        cleanup();
    } catch {
        threw = true;
    }
    assert(!threw, 'provider cleanup failure should not escape');
});

test('subscribeMobileVerdict: cleanup is idempotent', () => {
    let cleanupCalls = 0;
    const cleanup = subscribeMobileVerdict(() => () => { cleanupCalls++; }, () => {});
    cleanup();
    cleanup();
    assertEqual(cleanupCalls, 1, 'provider cleanup should run only once');
});

summary('Mobile Verdict adapter tests');
