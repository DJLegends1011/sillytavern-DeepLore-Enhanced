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

summary('Mobile Verdict adapter tests');
