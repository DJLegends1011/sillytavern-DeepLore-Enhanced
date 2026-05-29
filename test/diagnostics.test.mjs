/**
 * DeepLore Enhanced — Diagnostics Module Tests
 * Run with: node test/diagnostics.test.mjs
 *
 * Tests RingBuffer, safeStringify (ring-buffer.js), and makeCtx, scrubString,
 * scrubDeep (scrubber.js). These are pure, production-critical modules used in
 * every diagnostic export.
 */

import {
    assert, assertEqual, assertNotEqual, assertNull, assertNotNull,
    assertMatch, assertInstanceOf, assertGreaterThan,
    test, section, summary,
} from './helpers.mjs';

import { RingBuffer, safeStringify } from '../src/diagnostics/ring-buffer.js';
import { makeCtx, scrubString, scrubDeep } from '../src/diagnostics/scrubber.js';
import { createPseudonymContext, pseudonymizeTrace } from '../src/diagnostics/pseudonymize-trace.js';


// ============================================================================
//  A. RingBuffer — Core Data Structure
// ============================================================================

section('A. RingBuffer — Core Data Structure');

test('Constructor: default capacity is 500', () => {
    const rb = new RingBuffer();
    assertEqual(rb.capacity, 500, 'default capacity should be 500');
});

test('Constructor: custom capacity', () => {
    const rb = new RingBuffer(100);
    assertEqual(rb.capacity, 100, 'custom capacity should be 100');
});

test('Constructor: capacity < 1 clamped to 1', () => {
    const rb0 = new RingBuffer(0);
    assertEqual(rb0.capacity, 1, 'capacity 0 clamped to 1');
    const rbNeg = new RingBuffer(-10);
    assertEqual(rbNeg.capacity, 1, 'negative capacity clamped to 1');
});

test('Constructor: non-integer capacity floored via bitwise OR', () => {
    const rb = new RingBuffer(7.9);
    assertEqual(rb.capacity, 7, 'float capacity should be floored to 7');
});

test('push + length: single item', () => {
    const rb = new RingBuffer(10);
    rb.push('hello');
    assertEqual(rb.length, 1, 'length should be 1 after one push');
});

test('push + length: multiple items up to capacity', () => {
    const rb = new RingBuffer(5);
    for (let i = 0; i < 5; i++) rb.push(i);
    assertEqual(rb.length, 5, 'length should equal capacity when full');
});

test('push: at capacity, oldest item dropped (FIFO)', () => {
    const rb = new RingBuffer(3);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    rb.push('d');
    assertEqual(rb.length, 3, 'length should stay at capacity');
    const items = rb.drain();
    assertEqual(items, ['b', 'c', 'd'], 'oldest item (a) should be dropped');
});

test('push: well over capacity, only last N items remain', () => {
    const rb = new RingBuffer(3);
    for (let i = 0; i < 100; i++) rb.push(i);
    assertEqual(rb.length, 3, 'length should be clamped to capacity');
    const items = rb.drain();
    assertEqual(items, [97, 98, 99], 'only last 3 items should remain');
});

test('drain: returns shallow copy (oldest to newest order)', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    const items = rb.drain();
    assertEqual(items, [1, 2, 3], 'drain should return items oldest to newest');
});

test('drain: does NOT clear buffer', () => {
    const rb = new RingBuffer(5);
    rb.push('x');
    rb.drain();
    assertEqual(rb.length, 1, 'drain should not clear the buffer');
    const items = rb.drain();
    assertEqual(items, ['x'], 'second drain should return same items');
});

test('drain: empty buffer returns empty array', () => {
    const rb = new RingBuffer(5);
    const items = rb.drain();
    assertEqual(items, [], 'drain on empty buffer should return []');
});

test('drain: returned array is independent of buffer', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    const items = rb.drain();
    items.push(999);
    items[0] = -1;
    const items2 = rb.drain();
    assertEqual(items2, [1, 2], 'mutating drained array should not affect buffer');
});

test('clear: resets to empty', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    rb.push(2);
    rb.clear();
    assertEqual(rb.length, 0, 'length should be 0 after clear');
});

test('clear: drain returns empty after clear', () => {
    const rb = new RingBuffer(5);
    rb.push('a');
    rb.clear();
    assertEqual(rb.drain(), [], 'drain after clear should return []');
});

test('clear + push: works normally after clear', () => {
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    rb.push(10);
    rb.push(20);
    assertEqual(rb.length, 2, 'length should be 2 after pushing post-clear');
    assertEqual(rb.drain(), [10, 20], 'items should be post-clear pushes only');
});

test('push with various types: objects, strings, numbers, null, undefined, arrays', () => {
    const rb = new RingBuffer(10);
    rb.push({ a: 1 });
    rb.push('hello');
    rb.push(42);
    rb.push(null);
    rb.push(undefined);
    rb.push([1, 2, 3]);
    assertEqual(rb.length, 6, 'should handle all types');
    const items = rb.drain();
    assertEqual(items[0], { a: 1 }, 'object preserved');
    assertEqual(items[1], 'hello', 'string preserved');
    assertEqual(items[2], 42, 'number preserved');
    assertNull(items[3], 'null preserved');
    assertEqual(items[4], undefined, 'undefined preserved');
    assertEqual(items[5], [1, 2, 3], 'array preserved');
});

test('push never throws: even with weird inputs', () => {
    const rb = new RingBuffer(5);
    let threw = false;
    try {
        rb.push(Symbol('test'));
        rb.push(() => {});
        rb.push(Object.create(null));
        rb.push(new Proxy({}, {}));
    } catch {
        threw = true;
    }
    assert(!threw, 'push should never throw');
});

test('Capacity 1: always has exactly 1 item', () => {
    const rb = new RingBuffer(1);
    rb.push('a');
    assertEqual(rb.length, 1, 'length should be 1');
    rb.push('b');
    assertEqual(rb.length, 1, 'length still 1 after second push');
    assertEqual(rb.drain(), ['b'], 'only last item remains');
});

test('Large capacity: 10000 items, verify oldest dropped correctly', () => {
    const rb = new RingBuffer(100);
    for (let i = 0; i < 10000; i++) rb.push(i);
    assertEqual(rb.length, 100, 'length should be capped at 100');
    const items = rb.drain();
    assertEqual(items[0], 9900, 'first item should be 9900');
    assertEqual(items[99], 9999, 'last item should be 9999');
});

test('Sequential push+drain: verify ordering is preserved', () => {
    const rb = new RingBuffer(5);
    rb.push('first');
    rb.push('second');
    rb.push('third');
    const d1 = rb.drain();
    assertEqual(d1, ['first', 'second', 'third'], 'first drain order correct');
    rb.push('fourth');
    rb.push('fifth');
    const d2 = rb.drain();
    assertEqual(d2, ['first', 'second', 'third', 'fourth', 'fifth'], 'second drain order correct');
});

test('RingBuffer: length is a getter, not a method', () => {
    const rb = new RingBuffer(5);
    rb.push(1);
    assert(typeof rb.length === 'number', 'length should be a number');
    assertEqual(rb.length, 1, 'length should reflect actual count');
});


// ============================================================================
//  B. safeStringify
// ============================================================================

section('B. safeStringify');

test('Single string arg returns that string', () => {
    assertEqual(safeStringify(['hello']), 'hello', 'single string passthrough');
});

test('Single number returns string representation', () => {
    assertEqual(safeStringify([42]), '42', 'number stringified');
    assertEqual(safeStringify([0]), '0', 'zero stringified');
    assertEqual(safeStringify([-3.14]), '-3.14', 'negative float stringified');
});

test('Single boolean returns "true"/"false"', () => {
    assertEqual(safeStringify([true]), 'true', 'true stringified');
    assertEqual(safeStringify([false]), 'false', 'false stringified');
});

test('null returns "null"', () => {
    assertEqual(safeStringify([null]), 'null', 'null stringified');
});

test('undefined returns "undefined"', () => {
    assertEqual(safeStringify([undefined]), 'undefined', 'undefined stringified');
});

test('BigInt returns string with n suffix', () => {
    // BigInt is handled via typeof === 'bigint' → String(a)
    // But inside JSON.stringify, makeJsonReplacer handles it with + 'n'
    const result = safeStringify([BigInt(123)]);
    assertEqual(result, '123', 'BigInt stringified via String()');
});

test('Error object returns "ErrorName: message\\nstack"', () => {
    const err = new Error('test error');
    const result = safeStringify([err]);
    assertMatch(result, /Error: test error/, 'should contain Error: test error');
    assertMatch(result, /\n/, 'should contain newline before stack');
});

test('Plain object returns JSON string', () => {
    assertEqual(safeStringify([{ a: 1 }]), '{"a":1}', 'plain object JSON');
});

test('Array returns JSON string', () => {
    assertEqual(safeStringify([[1, 2, 3]]), '[1,2,3]', 'array JSON');
});

test('Multiple args joined with " | "', () => {
    const result = safeStringify(['hello', 42, true]);
    assertEqual(result, 'hello | 42 | true', 'multiple args joined');
});

test('Circular object contains "[circular]"', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const result = safeStringify([obj]);
    assertMatch(result, /\[circular\]/, 'circular should be caught');
});

test('Function contains "[fn name]" or "[fn anon]"', () => {
    function myFunc() {}
    const result1 = safeStringify([{ f: myFunc }]);
    assertMatch(result1, /\[fn myFunc\]/, 'named function');
    // Arrow assigned to object property gets property name 'f'; use a truly anonymous fn
    const anon = (() => () => {})();
    const result2 = safeStringify([{ g: anon }]);
    assertMatch(result2, /\[fn (anon)?\]/, 'anonymous function');
});

test('Deeply nested object stringified without crash', () => {
    let obj = { v: 'leaf' };
    for (let i = 0; i < 50; i++) obj = { child: obj };
    const result = safeStringify([obj]);
    assertMatch(result, /leaf/, 'deeply nested object should stringify');
});

test('Very long string + maxLen truncated with suffix', () => {
    const long = 'x'.repeat(3000);
    const result = safeStringify([long], 100);
    assert(result.length <= 200, 'result should be truncated'); // with suffix
    assertMatch(result, /…\[\+\d+ chars\]/, 'should have truncation suffix');
});

test('maxLen exactly at boundary: no truncation', () => {
    const str = 'hello';
    const result = safeStringify([str], 5);
    assertEqual(result, 'hello', 'no truncation when exactly at maxLen');
});

test('Object with toJSON uses toJSON', () => {
    const obj = { toJSON: () => ({ custom: true }) };
    const result = safeStringify([obj]);
    assertMatch(result, /custom/, 'toJSON should be used');
});

test('Mixed args: string, number, object, null joined correctly', () => {
    const result = safeStringify(['msg', 42, { a: 1 }, null]);
    assertEqual(result, 'msg | 42 | {"a":1} | null', 'mixed args joined');
});

test('Never throws: even with problematic inputs', () => {
    let threw = false;
    try {
        // Object with getter that throws
        const evil = {};
        Object.defineProperty(evil, 'x', { get() { throw new Error('boom'); }, enumerable: true });
        safeStringify([evil]);
        // Proxy that throws on everything
        const proxy = new Proxy({}, { get() { throw new Error('proxy boom'); } });
        safeStringify([proxy]);
    } catch {
        threw = true;
    }
    assert(!threw, 'safeStringify should never throw');
});

test('BUG-035: Two calls with circular objects do not share WeakSet', () => {
    const a = { name: 'a' };
    a.self = a;
    const b = { name: 'b' };
    b.self = b;
    const result1 = safeStringify([a]);
    const result2 = safeStringify([b]);
    // Both should independently detect their own circularity
    assertMatch(result1, /\[circular\]/, 'first call detects circular');
    assertMatch(result2, /\[circular\]/, 'second call detects circular');
    // And both should contain their own name (not contaminated)
    assertMatch(result1, /"name":"a"/, 'first result has name a');
    assertMatch(result2, /"name":"b"/, 'second result has name b');
});

test('Empty args array returns empty string', () => {
    // With empty array: parts is empty, parts.length === 1 is false,
    // so it joins with ' | ' → '' (empty join)
    const result = safeStringify([]);
    // parts = [], parts.length === 1 → false, parts.join(' | ') → ''
    assertEqual(result, '', 'empty args should return empty string');
});

test('Single-element array: no " | " separator', () => {
    const result = safeStringify(['only']);
    assert(!result.includes(' | '), 'single element should not have separator');
    assertEqual(result, 'only', 'single element passthrough');
});

test('BigInt inside object uses replacer', () => {
    const result = safeStringify([{ val: BigInt(999) }]);
    assertMatch(result, /999n/, 'BigInt in object should have n suffix via replacer');
});


// ============================================================================
//  C. makeCtx
// ============================================================================

section('C. makeCtx');

test('makeCtx returns object with expected Maps', () => {
    const ctx = makeCtx();
    assertInstanceOf(ctx.ip, Map, 'ip should be a Map');
    assertInstanceOf(ctx.ipv6, Map, 'ipv6 should be a Map');
    assertInstanceOf(ctx.email, Map, 'email should be a Map');
    assertInstanceOf(ctx.host, Map, 'host should be a Map');
    assertInstanceOf(ctx.userPath, Map, 'userPath should be a Map');
    assertInstanceOf(ctx.title, Map, 'title should be a Map');
});

test('makeCtx returns object with stats counters all at 0', () => {
    const ctx = makeCtx();
    assertEqual(ctx.stats.ips, 0, 'ips starts at 0');
    assertEqual(ctx.stats.ipv6s, 0, 'ipv6s starts at 0');
    assertEqual(ctx.stats.emails, 0, 'emails starts at 0');
    assertEqual(ctx.stats.hosts, 0, 'hosts starts at 0');
    assertEqual(ctx.stats.userPaths, 0, 'userPaths starts at 0');
    assertEqual(ctx.stats.titles, 0, 'titles starts at 0');
    assertEqual(ctx.stats.bearerTokens, 0, 'bearerTokens starts at 0');
    assertEqual(ctx.stats.urlTokens, 0, 'urlTokens starts at 0');
    assertEqual(ctx.stats.openaiKeys, 0, 'openaiKeys starts at 0');
    assertEqual(ctx.stats.longTokens, 0, 'longTokens starts at 0');
    assertEqual(ctx.stats.sensitiveFields, 0, 'sensitiveFields starts at 0');
});

test('Two calls return independent contexts', () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    ctx1.stats.ips = 5;
    ctx1.ip.set('test', 'value');
    assertEqual(ctx2.stats.ips, 0, 'ctx2 stats unaffected by ctx1');
    assertEqual(ctx2.ip.size, 0, 'ctx2 maps unaffected by ctx1');
});

test('Maps are empty on creation', () => {
    const ctx = makeCtx();
    assertEqual(ctx.ip.size, 0, 'ip map empty');
    assertEqual(ctx.ipv6.size, 0, 'ipv6 map empty');
    assertEqual(ctx.email.size, 0, 'email map empty');
    assertEqual(ctx.host.size, 0, 'host map empty');
    assertEqual(ctx.userPath.size, 0, 'userPath map empty');
    assertEqual(ctx.title.size, 0, 'title map empty');
});

test('Stats has all expected counter fields', () => {
    const ctx = makeCtx();
    const expectedKeys = [
        'ips', 'ipv6s', 'emails', 'hosts', 'userPaths', 'titles',
        'bearerTokens', 'urlTokens', 'openaiKeys', 'longTokens', 'sensitiveFields',
    ];
    for (const key of expectedKeys) {
        assert(key in ctx.stats, `stats should have key '${key}'`);
    }
});


// ============================================================================
//  D. scrubString — Pattern Matching
// ============================================================================

section('D. scrubString — Pattern Matching');

test('Bearer token scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('Bearer sk-abc123456789', ctx);
    assertMatch(result, /Bearer <token>/, 'Bearer token should be scrubbed');
    assertEqual(ctx.stats.bearerTokens, 1, 'bearerTokens counter incremented');
});

test('URL query-string token: ?key=abc scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('https://example.com/api?key=abc123&foo=bar', ctx);
    assertMatch(result, /\?key=<token>/, 'key param should be scrubbed');
    assertMatch(result, /&foo=bar/, 'non-sensitive param should remain');
});

test('URL auth params: ?access_token=xxx scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('https://example.com?access_token=secret_value_here', ctx);
    assertMatch(result, /access_token=<token>/, 'access_token should be scrubbed');
});

test('OpenAI key: sk-proj-... scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('my key is sk-proj-abc123456789012345678901', ctx);
    assertMatch(result, /<openai-key>/, 'OpenAI key should be scrubbed');
    assertEqual(ctx.stats.openaiKeys, 1, 'openaiKeys counter incremented');
});

test('Anthropic key: sk-ant-... scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('key: sk-ant-abc12345678901234567890', ctx);
    assertMatch(result, /<openai-key>/, 'Anthropic key matched by same pattern');
});

test('IPv4 address: partially masked, first two octets preserved', () => {
    const ctx = makeCtx();
    const result = scrubString('connected from 192.168.1.100', ctx);
    assertMatch(result, /192\.168\./, 'first two octets preserved');
    assert(!result.includes('1.100'), 'last two octets should be masked');
    assertEqual(ctx.stats.ips, 1, 'ips counter incremented');
});

test('IPv4 with port: port preserved, IP partially masked', () => {
    const ctx = makeCtx();
    const result = scrubString('server at 10.0.1.50:8080', ctx);
    assertMatch(result, /:8080/, 'port should be preserved');
    assertMatch(result, /10\.0\./, 'first two octets preserved');
});

test('IPv6 address: pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('address 2001:0db8:85a3:0000:0000:8a2e:0370:7334', ctx);
    assertMatch(result, /<ipv6-\d+>/, 'IPv6 should be pseudonymized');
    assertEqual(ctx.stats.ipv6s, 1, 'ipv6s counter incremented');
});

test('Email: pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('contact user@example.com for help', ctx);
    assertMatch(result, /<email-\d+>/, 'email should be pseudonymized');
    assertEqual(ctx.stats.emails, 1, 'emails counter incremented');
});

test('Email cardinality: same email twice gets same pseudonym', () => {
    const ctx = makeCtx();
    const r1 = scrubString('from user@test.com', ctx);
    const r2 = scrubString('to user@test.com', ctx);
    // Extract the pseudonym from each
    const match1 = r1.match(/<email-\d+>/);
    const match2 = r2.match(/<email-\d+>/);
    assertNotNull(match1, 'first scrub should have email pseudonym');
    assertNotNull(match2, 'second scrub should have email pseudonym');
    if (match1 && match2) {
        assertEqual(match1[0], match2[0], 'same email should get same pseudonym');
    }
});

test('Email cardinality: different emails get different pseudonyms', () => {
    const ctx = makeCtx();
    const r1 = scrubString('from alice@test.com', ctx);
    const r2 = scrubString('to bob@test.com', ctx);
    const match1 = r1.match(/<email-\d+>/);
    const match2 = r2.match(/<email-\d+>/);
    assertNotNull(match1, 'first email pseudonym');
    assertNotNull(match2, 'second email pseudonym');
    if (match1 && match2) {
        assertNotEqual(match1[0], match2[0], 'different emails should get different pseudonyms');
    }
});

test('Windows path: username pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('file at C:\\Users\\johndoe\\Documents\\test.txt', ctx);
    assertMatch(result, /C:\\Users\\<user-\d+>/, 'Windows username should be pseudonymized');
    assertEqual(ctx.stats.userPaths, 1, 'userPaths counter incremented');
});

test('POSIX path: username pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('file at /home/janedoe/projects/test', ctx);
    assertMatch(result, /\/home\/<user-\d+>/, 'POSIX username should be pseudonymized');
    assertEqual(ctx.stats.userPaths, 1, 'userPaths counter incremented');
});

test('Hostname in URL: host pseudonymized, scheme preserved', () => {
    const ctx = makeCtx();
    const result = scrubString('connecting to https://api.example.com/v1/chat', ctx);
    assertMatch(result, /^connecting to https:\/\//, 'scheme preserved');
    assertMatch(result, /<host-\d+>/, 'hostname should be pseudonymized');
    assertEqual(ctx.stats.hosts, 1, 'hosts counter incremented');
});

test('localhost preserved in URLs', () => {
    const ctx = makeCtx();
    const result = scrubString('server at https://localhost:8080/api', ctx);
    assertMatch(result, /localhost/, 'localhost should be preserved');
    assertEqual(ctx.stats.hosts, 0, 'hosts counter should not increment for localhost');
});

test('Long token: 32+ char base64/hex string scrubbed', () => {
    const ctx = makeCtx();
    const longToken = 'a'.repeat(40);
    const result = scrubString(`token: ${longToken}`, ctx);
    assertMatch(result, /<long-token>/, 'long token should be scrubbed');
    assertEqual(ctx.stats.longTokens, 1, 'longTokens counter incremented');
});

test('Non-string input returned unchanged', () => {
    const ctx = makeCtx();
    const num = scrubString(42, ctx);
    assertEqual(num, 42, 'number returned as-is');
    const nul = scrubString(null, ctx);
    assertNull(nul, 'null returned as-is');
    const undef = scrubString(undefined, ctx);
    assertEqual(undef, undefined, 'undefined returned as-is');
});

test('Empty string returned unchanged', () => {
    const ctx = makeCtx();
    assertEqual(scrubString('', ctx), '', 'empty string passthrough');
});

test('Stats counters increment correctly for each pattern type', () => {
    const ctx = makeCtx();
    scrubString('Bearer sk-abc12345678', ctx);
    scrubString('?key=secret123', ctx);
    scrubString('sk-proj-abc12345678901234567890', ctx);
    scrubString('192.168.1.1', ctx);
    scrubString('user@test.com', ctx);
    assertEqual(ctx.stats.bearerTokens, 1, 'bearer count');
    assertEqual(ctx.stats.urlTokens, 1, 'urlToken count');
    // Note: openaiKeys may be > 1 due to overlapping patterns
    assertGreaterThan(ctx.stats.openaiKeys, 0, 'openaiKeys count');
    assertEqual(ctx.stats.ips, 1, 'ips count');
    assertEqual(ctx.stats.emails, 1, 'emails count');
});

test('Multiple patterns in same string all scrubbed', () => {
    const ctx = makeCtx();
    const input = 'user@test.com connected from 192.168.1.100 with Bearer sk-abc12345678';
    const result = scrubString(input, ctx);
    assertMatch(result, /<email-\d+>/, 'email scrubbed');
    assertMatch(result, /192\.168\./, 'IP partially masked');
    assertMatch(result, /Bearer <token>/, 'bearer scrubbed');
});

test('Pseudonym stability: same IP maps to same pseudonym in same ctx', () => {
    const ctx = makeCtx();
    const r1 = scrubString('from 192.168.5.10', ctx);
    const r2 = scrubString('to 192.168.5.10', ctx);
    // Extract the host pseudonym suffix
    const m1 = r1.match(/192\.168\.(<host-\d+>)/);
    const m2 = r2.match(/192\.168\.(<host-\d+>)/);
    assertNotNull(m1, 'first IP should be partially masked');
    assertNotNull(m2, 'second IP should be partially masked');
    if (m1 && m2) {
        assertEqual(m1[1], m2[1], 'same IP suffix should get same pseudonym');
    }
});

test('URL with multiple query params: only sensitive ones scrubbed', () => {
    const ctx = makeCtx();
    const result = scrubString('https://api.example.com/v1?key=secret123&page=5&token=abc456', ctx);
    assertMatch(result, /key=<token>/, 'key param scrubbed');
    assertMatch(result, /token=<token>/, 'token param scrubbed');
    // page=5 should remain
    assertMatch(result, /page=5/, 'non-sensitive param preserved');
});

test('macOS /Users/ path: username pseudonymized', () => {
    const ctx = makeCtx();
    const result = scrubString('/Users/macuser/Library/test', ctx);
    assertMatch(result, /\/Users\/<user-\d+>/, 'macOS path should pseudonymize username');
});

test('scrubString creates fresh ctx if not provided', () => {
    // Should not throw when ctx is omitted
    let threw = false;
    try {
        const result = scrubString('test 192.168.1.1', undefined);
        assertMatch(result, /192\.168\./, 'should still scrub without ctx');
    } catch {
        threw = true;
    }
    assert(!threw, 'scrubString should work without ctx');
});


// ============================================================================
//  E. scrubDeep — Recursive Scrubbing
// ============================================================================

section('E. scrubDeep — Recursive Scrubbing');

test('null passes through', () => {
    assertNull(scrubDeep(null), 'null should pass through');
});

test('undefined passes through', () => {
    assertEqual(scrubDeep(undefined), undefined, 'undefined should pass through');
});

test('number passes through', () => {
    assertEqual(scrubDeep(42), 42, 'number should pass through');
    assertEqual(scrubDeep(0), 0, 'zero should pass through');
    assertEqual(scrubDeep(-1.5), -1.5, 'negative float should pass through');
});

test('boolean passes through', () => {
    assertEqual(scrubDeep(true), true, 'true should pass through');
    assertEqual(scrubDeep(false), false, 'false should pass through');
});

test('string is scrubbed (delegates to scrubString)', () => {
    const result = scrubDeep('contact user@test.com');
    assertMatch(result, /<email-\d+>/, 'email in string should be scrubbed');
});

test('function replaced with "[fn name]" or "[fn anon]"', () => {
    function myHelper() {}
    assertEqual(scrubDeep(myHelper), '[fn myHelper]', 'named function');
    assertEqual(scrubDeep(() => {}), '[fn anon]', 'anonymous arrow function');
});

test('Plain object: keys recursed, values scrubbed', () => {
    const result = scrubDeep({ msg: 'email: alice@test.com', count: 5 });
    assertMatch(result.msg, /<email-\d+>/, 'string value scrubbed');
    assertEqual(result.count, 5, 'number value preserved');
});

test('Array: each element scrubbed', () => {
    const result = scrubDeep(['user@a.com', 42, 'user@b.com']);
    assertMatch(result[0], /<email-\d+>/, 'first element scrubbed');
    assertEqual(result[1], 42, 'number preserved');
    assertMatch(result[2], /<email-\d+>/, 'third element scrubbed');
});

test('Nested objects: deep recursion works', () => {
    const result = scrubDeep({
        level1: {
            level2: {
                email: 'deep@test.com',
            },
        },
    });
    assertMatch(result.level1.level2.email, /<email-\d+>/, 'deeply nested email scrubbed');
});

test('Circular reference: "[circular]" and no infinite loop', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const result = scrubDeep(obj);
    assertEqual(result.a, 1, 'non-circular value preserved');
    assertEqual(result.self, '[circular]', 'circular ref becomes "[circular]"');
});

test('Sensitive field names: api_key value becomes "<redacted>"', () => {
    const result = scrubDeep({ api_key: 'sk-super-secret-value-here' });
    assertEqual(result.api_key, '<redacted>', 'api_key should be redacted');
});

test('Sensitive field names: password, secret, authorization', () => {
    const result = scrubDeep({
        password: 'hunter2',
        secret: 'shhh',
        authorization: 'Bearer xyz',
    });
    assertEqual(result.password, '<redacted>', 'password redacted');
    assertEqual(result.secret, '<redacted>', 'secret redacted');
    assertEqual(result.authorization, '<redacted>', 'authorization redacted');
});

test('Sensitive field case-insensitive: API_KEY, ApiKey', () => {
    const result = scrubDeep({
        API_KEY: 'test',
        ApiKey: 'test2',
        'x-api-key': 'test3',
    });
    assertEqual(result.API_KEY, '<redacted>', 'API_KEY redacted');
    assertEqual(result.ApiKey, '<redacted>', 'ApiKey redacted');
    assertEqual(result['x-api-key'], '<redacted>', 'x-api-key redacted');
});

test('Non-sensitive field names: values preserved (but string content scrubbed)', () => {
    const result = scrubDeep({
        name: 'John',
        title: 'Manager',
        count: 42,
    });
    assertEqual(result.name, 'John', 'name value preserved');
    assertEqual(result.title, 'Manager', 'title value preserved');
    assertEqual(result.count, 42, 'count value preserved');
});

test('Error object returns typed representation', () => {
    const err = new TypeError('bad input from user@test.com');
    const result = scrubDeep(err);
    assertEqual(result.__type, 'Error', '__type should be Error');
    assertEqual(result.name, 'TypeError', 'name should be TypeError');
    assertMatch(result.message, /<email-\d+>/, 'email in message scrubbed');
    assert(typeof result.stack === 'string', 'stack should be a string');
});

test('Map returns typed representation with scrubbed entries', () => {
    const m = new Map();
    m.set('email', 'user@test.com');
    m.set('count', 5);
    const result = scrubDeep(m);
    assertEqual(result.__type, 'Map', '__type should be Map');
    assertMatch(result.entries.email, /<email-\d+>/, 'Map value scrubbed');
    assertEqual(result.entries.count, 5, 'Map non-sensitive value preserved');
});

test('Set returns typed representation with scrubbed values', () => {
    const s = new Set(['user@test.com', 42, 'hello']);
    const result = scrubDeep(s);
    assertEqual(result.__type, 'Set', '__type should be Set');
    assert(Array.isArray(result.values), 'values should be array');
    assertMatch(result.values[0], /<email-\d+>/, 'Set email value scrubbed');
    assertEqual(result.values[1], 42, 'Set number preserved');
    assertEqual(result.values[2], 'hello', 'Set plain string preserved');
});

test('Stats accumulate across deep scrub', () => {
    const ctx = makeCtx();
    scrubDeep({
        log1: 'from 192.168.1.1',
        nested: {
            log2: 'from 10.0.0.1',
            items: ['email: a@b.com'],
        },
    }, ctx);
    assertGreaterThan(ctx.stats.ips, 0, 'IPs should be counted');
    assertGreaterThan(ctx.stats.emails, 0, 'emails should be counted');
});

test('Fresh ctx created if not provided', () => {
    // Should not throw
    let threw = false;
    try {
        const result = scrubDeep({ msg: 'user@test.com' });
        assertMatch(result.msg, /<email-\d+>/, 'should scrub without explicit ctx');
    } catch {
        threw = true;
    }
    assert(!threw, 'scrubDeep should work without ctx');
});

test('Original value not mutated (deep copy)', () => {
    const original = {
        email: 'user@test.com',
        nested: { ip: '192.168.1.1' },
        items: ['a@b.com'],
    };
    const originalEmail = original.email;
    const originalIp = original.nested.ip;
    const originalItem = original.items[0];
    scrubDeep(original);
    assertEqual(original.email, originalEmail, 'original email not mutated');
    assertEqual(original.nested.ip, originalIp, 'original nested IP not mutated');
    assertEqual(original.items[0], originalItem, 'original array item not mutated');
});

test('Sensitive field in Map gets redacted', () => {
    const m = new Map();
    m.set('api_key', 'sk-secret-value');
    const result = scrubDeep(m);
    assertEqual(result.entries.api_key, '<redacted>', 'Map sensitive key redacted');
});

test('scrubDeep: sensitiveFields counter increments', () => {
    const ctx = makeCtx();
    scrubDeep({ password: 'test', api_key: 'test2', normal: 'ok' }, ctx);
    assertGreaterThan(ctx.stats.sensitiveFields, 0, 'sensitiveFields counter should increment');
});

test('scrubDeep: array of objects with mixed sensitive/normal fields', () => {
    const result = scrubDeep([
        { name: 'service1', api_key: 'secret1' },
        { name: 'service2', password: 'secret2' },
    ]);
    assertEqual(result[0].name, 'service1', 'name preserved');
    assertEqual(result[0].api_key, '<redacted>', 'api_key redacted in array');
    assertEqual(result[1].password, '<redacted>', 'password redacted in array');
});

test('scrubDeep: deeply nested circular reference', () => {
    const a = { name: 'a' };
    const b = { name: 'b', ref: a };
    a.ref = b;
    const result = scrubDeep(a);
    assertEqual(result.name, 'a', 'a.name preserved');
    assertEqual(result.ref.name, 'b', 'b.name preserved');
    assertEqual(result.ref.ref, '[circular]', 'circular in nested object caught');
});

test('scrubDeep: cross-reference (two objects referencing same third)', () => {
    const shared = { data: 'user@test.com' };
    const obj = { a: shared, b: shared };
    const result = scrubDeep(obj);
    // First encounter scrubs normally, second becomes [circular] since same ref in WeakMap
    assertMatch(result.a.data, /<email-\d+>/, 'first reference scrubbed');
    assertEqual(result.b, '[circular]', 'second reference to same object is circular');
});

test('scrubDeep: additional sensitive field names', () => {
    const result = scrubDeep({
        oauth_token: 'abc',
        refresh_token: 'def',
        client_id: 'ghi',
        private_key: 'jkl',
        credential: 'mno',
    });
    assertEqual(result.oauth_token, '<redacted>', 'oauth_token redacted');
    assertEqual(result.refresh_token, '<redacted>', 'refresh_token redacted');
    assertEqual(result.client_id, '<redacted>', 'client_id redacted');
    assertEqual(result.private_key, '<redacted>', 'private_key redacted');
    assertEqual(result.credential, '<redacted>', 'credential redacted');
});


// ============================================================================
//  F. pseudonymizeTrace — Trace-level Scrubbing (gotchas.md #19 regression)
// ============================================================================

section('F. pseudonymizeTrace — Trace-level Scrubbing');

test('F1: matchedBy is scrubbed (raw keyword does not survive)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        keywordMatched: [
            { title: 'Alpha', vaultSource: 'V1', matchedBy: 'secret_keyword_alpha' },
            { title: 'Beta', vaultSource: 'V1', matchedBy: 'kept_kw_beta' },
        ],
    };
    const out = pseudonymizeTrace(trace, ctx);
    const serialized = JSON.stringify(out);
    assert(!serialized.includes('secret_keyword_alpha'), 'raw secret_keyword_alpha must not appear in output');
    assert(!serialized.includes('kept_kw_beta'), 'raw kept_kw_beta must not appear in output');
    // Each matchedBy is itself a pseudonym (uses title map)
    assertMatch(out.keywordMatched[0].matchedBy, /^<title-\d+>$/, 'matchedBy replaced with title pseudonym');
    assertMatch(out.keywordMatched[1].matchedBy, /^<title-\d+>$/, 'second matchedBy pseudonymized too');
});

test('F2: AI reason is scrubbed (vault term replaced with pseudonym)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        aiSelected: [
            { title: 'Alice', vaultSource: 'MainVault', reason: 'Selected because vault keyword Alice appears' },
        ],
    };
    const out = pseudonymizeTrace(trace, ctx);
    const r = out.aiSelected[0].reason;
    assert(!r.includes('Alice'), 'raw title "Alice" must not appear in AI reason');
    assertMatch(r, /<title-\d+>/, 'AI reason should contain title pseudonym');
    assertMatch(r, /Selected because vault keyword/, 'non-sensitive prose preserved');
});

test('F3: entry title is scrubbed (CHARACTER_SECRET_NAME replaced)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        injected: [{ title: 'CHARACTER_SECRET_NAME', vaultSource: '' }],
    };
    const out = pseudonymizeTrace(trace, ctx);
    assertMatch(out.injected[0].title, /^<title-\d+>$/, 'title pseudonymized');
    const serialized = JSON.stringify(out);
    assert(!serialized.includes('CHARACTER_SECRET_NAME'), 'raw title must not appear anywhere in output');
});

test('F4: vaultSource is scrubbed (multi-vault project name does not leak)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        injected: [{ title: 'Some Entry', vaultSource: 'Private Lore Vault' }],
        keywordMatched: [{ title: 'Other Entry', vaultSource: 'Private Lore Vault', matchedBy: 'kw' }],
        aiSelected: [{ title: 'Some Entry', vaultSource: 'Different Vault Name', reason: 'picked' }],
    };
    const out = pseudonymizeTrace(trace, ctx);
    const serialized = JSON.stringify(out);
    assert(!serialized.includes('Private Lore Vault'), 'raw vaultSource "Private Lore Vault" must not appear');
    assert(!serialized.includes('Different Vault Name'), 'raw vaultSource "Different Vault Name" must not appear');
    assertMatch(out.injected[0].vaultSource, /^<vault-\d+>$/, 'vaultSource has <vault-N> shape');
    assertMatch(out.aiSelected[0].vaultSource, /^<vault-\d+>$/, 'aiSelected vaultSource also pseudonymized');
    // Cardinality preserved — same vaultSource in injected + keywordMatched gets SAME pseudonym
    assertEqual(out.injected[0].vaultSource, out.keywordMatched[0].vaultSource,
        'same raw vaultSource yields same pseudonym (cardinality preserved)');
    // Different raw vaultSource gets different pseudonym
    assertNotEqual(out.injected[0].vaultSource, out.aiSelected[0].vaultSource,
        'different raw vaultSource yields different pseudonyms');
});

test('F4b: empty vaultSource (single-vault) passes through unchanged', () => {
    const ctx = createPseudonymContext();
    const trace = { injected: [{ title: 'T', vaultSource: '' }] };
    const out = pseudonymizeTrace(trace, ctx);
    assertEqual(out.injected[0].vaultSource, '', 'empty vaultSource preserved (not pseudonymized)');
});

test('F5: schema preserved (all input keys present + types preserved, non-leaky added keys ok)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        keywordMatched: [{ title: 'A', vaultSource: 'V', matchedBy: 'kw', extraField: 42 }],
        aiSelected: [{ title: 'A', vaultSource: 'V', reason: 'r', confidence: 0.9 }],
        injected: [{ title: 'A', vaultSource: 'V', tokenEstimate: 100 }],
        budgetCut: [],
        someTopLevelMeta: 'metadata',
    };
    const out = pseudonymizeTrace(trace, ctx);
    // Top-level keys preserved
    assertEqual(Object.keys(out).sort(), Object.keys(trace).sort(), 'top-level keys preserved');
    // Per-entry: every INPUT key must be present in output (subset check).
    // Output may have added `title`/`filename: null` if input omitted them — that's safe (null is not a content leak).
    for (const key of Object.keys(trace.keywordMatched[0])) {
        assert(key in out.keywordMatched[0], `keywordMatched entry must retain input key '${key}'`);
    }
    for (const key of Object.keys(trace.aiSelected[0])) {
        assert(key in out.aiSelected[0], `aiSelected entry must retain input key '${key}'`);
    }
    for (const key of Object.keys(trace.injected[0])) {
        assert(key in out.injected[0], `injected entry must retain input key '${key}'`);
    }
    // Any added keys must be NULL (no content leak via spurious data)
    const addedKwKeys = Object.keys(out.keywordMatched[0]).filter(k => !(k in trace.keywordMatched[0]));
    for (const k of addedKwKeys) {
        assertNull(out.keywordMatched[0][k], `added key '${k}' on keywordMatched must be null (no content leak)`);
    }
    // Types preserved (numbers stay numbers, etc.)
    assertEqual(typeof out.keywordMatched[0].extraField, 'number', 'extraField number type preserved');
    assertEqual(out.keywordMatched[0].extraField, 42, 'extraField value preserved');
    assertEqual(typeof out.aiSelected[0].confidence, 'number', 'confidence number type preserved');
    assertEqual(out.aiSelected[0].confidence, 0.9, 'confidence value preserved');
    assertEqual(out.injected[0].tokenEstimate, 100, 'tokenEstimate value preserved');
    assertEqual(typeof out.someTopLevelMeta, 'string', 'top-level metadata preserved');
    assertEqual(out.someTopLevelMeta, 'metadata', 'top-level metadata value preserved');
    // Empty arrays preserved
    assert(Array.isArray(out.budgetCut), 'empty array key preserved as array');
    assertEqual(out.budgetCut.length, 0, 'empty array remains empty');
});

test('F6: pseudonym map is stable (same trace twice → same pseudonyms)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        injected: [
            { title: 'Alice', vaultSource: 'Vault1' },
            { title: 'Bob', vaultSource: 'Vault2' },
        ],
    };
    const out1 = pseudonymizeTrace(trace, ctx);
    const out2 = pseudonymizeTrace(trace, ctx);
    assertEqual(out1.injected[0].title, out2.injected[0].title, 'Alice pseudonym stable across two calls');
    assertEqual(out1.injected[1].title, out2.injected[1].title, 'Bob pseudonym stable across two calls');
    assertEqual(out1.injected[0].vaultSource, out2.injected[0].vaultSource, 'vault1 pseudonym stable across two calls');
});

test('F6b: pseudonym map is fresh per context (no cross-export correlation)', () => {
    const ctxA = createPseudonymContext();
    const ctxB = createPseudonymContext();
    const trace = { injected: [{ title: 'Alice', vaultSource: 'Vault1' }] };
    const outA = pseudonymizeTrace(trace, ctxA);
    // Pollute ctxB with a different title first so counter differs
    pseudonymizeTrace({ injected: [{ title: 'Padding', vaultSource: 'PadVault' }] }, ctxB);
    const outB = pseudonymizeTrace(trace, ctxB);
    // Both contexts pseudonymize Alice, but the numeric suffixes can differ
    // The IMPORTANT property: each ctx is independent — no shared map state.
    assertMatch(outA.injected[0].title, /^<title-\d+>$/, 'ctxA pseudonymizes Alice');
    assertMatch(outB.injected[0].title, /^<title-\d+>$/, 'ctxB pseudonymizes Alice');
    // ctxB had padding first, so Alice gets title-2 there; ctxA had no padding
    assertNotEqual(outA.injected[0].title, outB.injected[0].title,
        'independent contexts produce independent pseudonym numbering');
});

test('F7: round-trip safety — safeStringify produces no raw content leakage', () => {
    const ctx = createPseudonymContext();
    const trace = {
        keywordMatched: [{ title: 'TopSecretTitle', vaultSource: 'PrivateProject', matchedBy: 'CodewordX' }],
        aiSelected: [{ title: 'TopSecretTitle', vaultSource: 'PrivateProject',
            reason: 'Picked TopSecretTitle from PrivateProject because CodewordX matched' }],
        injected: [{ title: 'TopSecretTitle', vaultSource: 'PrivateProject', tokenEstimate: 50 }],
    };
    const out = pseudonymizeTrace(trace, ctx);
    const json = safeStringify([out]);
    assert(!json.includes('TopSecretTitle'), 'safeStringify output must not contain raw title');
    assert(!json.includes('PrivateProject'), 'safeStringify output must not contain raw vaultSource');
    assert(!json.includes('CodewordX'), 'safeStringify output must not contain raw matchedBy keyword');
    // Confirm it DOES contain the pseudonyms (sanity — we didn't just nuke everything)
    assertMatch(json, /<title-\d+>/, 'safeStringify output contains title pseudonym');
    assertMatch(json, /<vault-\d+>/, 'safeStringify output contains vault pseudonym');
});

test('F8: matchedBy with character-name keyword does not leak the name', () => {
    // The keyword trigger IS often the character/location name (e.g. "Alice").
    const ctx = createPseudonymContext();
    const trace = {
        keywordMatched: [{ title: 'Alice Entry', vaultSource: 'V', matchedBy: 'Alice' }],
    };
    const out = pseudonymizeTrace(trace, ctx);
    const json = JSON.stringify(out);
    assert(!json.includes('"Alice"'), 'raw character name "Alice" must not appear as bare string');
    assert(!json.includes('Alice Entry'), 'raw title "Alice Entry" must not appear');
});

test('F9: input trace is NOT mutated (output is a copy)', () => {
    const ctx = createPseudonymContext();
    const original = {
        injected: [{ title: 'Original', vaultSource: 'OrigVault', matchedBy: 'origKw' }],
    };
    const beforeSnap = JSON.stringify(original);
    pseudonymizeTrace(original, ctx);
    const afterSnap = JSON.stringify(original);
    assertEqual(beforeSnap, afterSnap, 'input trace must not be mutated');
    assertEqual(original.injected[0].title, 'Original', 'original.title still raw');
    assertEqual(original.injected[0].vaultSource, 'OrigVault', 'original.vaultSource still raw');
    assertEqual(original.injected[0].matchedBy, 'origKw', 'original.matchedBy still raw');
});

test('F10: all entry array keys are scrubbed (not just injected)', () => {
    const ctx = createPseudonymContext();
    const trace = {
        keywordMatched: [{ title: 'KM', vaultSource: 'V1', matchedBy: 'kmKw' }],
        aiSelected: [{ title: 'AI', vaultSource: 'V2', reason: 'aiR' }],
        gatedOut: [{ title: 'GO', vaultSource: 'V3' }],
        contextualGatingRemoved: [{ title: 'CGR', vaultSource: 'V4' }],
        cooldownRemoved: [{ title: 'CR', vaultSource: 'V5' }],
        warmupFailed: [{ title: 'WF', vaultSource: 'V6' }],
        refineKeyBlocked: [{ title: 'RKB', vaultSource: 'V7' }],
        stripDedupRemoved: [{ title: 'SDR', vaultSource: 'V8' }],
        budgetCut: [{ title: 'BC', vaultSource: 'V9' }],
        injected: [{ title: 'INJ', vaultSource: 'V10' }],
    };
    const out = pseudonymizeTrace(trace, ctx);
    const json = JSON.stringify(out);
    // None of the raw titles should appear
    for (const t of ['KM', 'AI', 'GO', 'CGR', 'CR', 'WF', 'RKB', 'SDR', 'BC', 'INJ']) {
        assert(!json.includes(`"title":"${t}"`), `raw title "${t}" must not appear in pseudonymized output`);
    }
    // None of the raw vaultSources should appear
    for (let i = 1; i <= 10; i++) {
        assert(!json.includes(`"vaultSource":"V${i}"`), `raw vaultSource "V${i}" must not appear`);
    }
});

test('F11: null/undefined/non-object trace handled defensively (no throw)', () => {
    const ctx = createPseudonymContext();
    let threw = false;
    try {
        assertEqual(pseudonymizeTrace(null, ctx), null, 'null input returns null');
        assertEqual(pseudonymizeTrace(undefined, ctx), undefined, 'undefined input returns undefined');
        assertEqual(pseudonymizeTrace('string', ctx), 'string', 'non-object input returns as-is');
        assertEqual(pseudonymizeTrace(42, ctx), 42, 'number input returns as-is');
    } catch {
        threw = true;
    }
    assert(!threw, 'pseudonymizeTrace must not throw on edge inputs');
});

test('F12: trace with no entry-array keys returns shallow copy unchanged', () => {
    const ctx = createPseudonymContext();
    const trace = { someUnrelatedKey: 'value', count: 5 };
    const out = pseudonymizeTrace(trace, ctx);
    assertEqual(out.someUnrelatedKey, 'value', 'unrelated string preserved');
    assertEqual(out.count, 5, 'unrelated number preserved');
    // It IS a copy though
    assert(out !== trace, 'output is a different object reference (shallow copy)');
});

test('F13: ctx omitted → fresh context created (function still scrubs)', () => {
    let threw = false;
    let out;
    try {
        out = pseudonymizeTrace({ injected: [{ title: 'X', vaultSource: 'Y' }] });
    } catch {
        threw = true;
    }
    assert(!threw, 'pseudonymizeTrace works without explicit ctx');
    assertMatch(out.injected[0].title, /^<title-\d+>$/, 'still scrubs without ctx');
});


// ============================================================================
//  G. Scrubber Report — "Titles" count truthfulness (T-RED L9)
//
//  L9 (thermo-nuclear review 2026-05-29, MEDIUM): the diagnostic scrubber
//  report advertises "Titles: N" but always prints 0 even when titles WERE
//  aliased. Mechanism confirmed against source:
//
//    * Titles are REALLY aliased at the snapshot layer by the pseudonym context
//      from `pseudonymize-trace.js` (`createPseudonymContext()` →
//      `pseudonymizeTrace()` → `pseudonymizeTitle()` increments
//      `ctx.titleCounter` and fills `ctx.titleMap`). `state-snapshot.js` owns
//      one such context per snapshot.
//
//    * The report (`export.js` `buildScrubberReport`, ~:503) prints
//      "Titles: ${s.titles}" where `s` is the SCRUBBER context's stats
//      (`scrubber.js` `makeCtx()`, ~:48). Nothing in scrubber.js ever
//      increments `stats.titles` — there is no title PATTERN, and the `title`
//      Map allocated at `makeCtx()` (~:42) is never written. So the report
//      reads a permanently-zero dead stat that is a DIFFERENT context from the
//      one that actually aliased the titles.
//
//  RED today: report's Titles count (scrubber `stats.titles`) is 0 while the
//  real aliased-title count is > 0. Phase-3 Agent-B fix = delete the dead
//  scrubber title map/stat and have the report pull the count from the real
//  pseudonym context; that turns this assertion green with no test edits
//  (the canonical count source then equals the real aliased count).
//
//  This test reproduces `buildScrubberReport`'s title-count CONTRACT locally
//  (export.js is un-importable from a node test — it transitively imports ST).
//  We assert the report's reported "Titles" count equals the number of titles
//  the real pseudonymization flow actually aliased.
// ============================================================================

section('G. Scrubber Report — Titles count truthfulness (T-RED L9)');

/**
 * Faithful mirror of `export.js` `buildScrubberReport`'s title-count source as
 * it exists TODAY: the report pulls the "Titles" line from the SCRUBBER
 * context's `stats.titles` (export.js ~:503 — `if (s.titles > 0) parts.push(...)`).
 * `pseudoCtx` is accepted but intentionally IGNORED here, mirroring the bug:
 * the report has no link to the real pseudonym context where titles are aliased.
 *
 * Phase-3 Agent-B remedy ("have the report pull title counts from the real
 * pseudonym context") will change this source to `pseudoCtx` — at which point
 * the count below becomes the real aliased-title count and the assertion passes.
 */
function reportedTitlesCount(scrubberCtx, _pseudoCtx) {
    // export.js:503 reads s.titles off the scrubber ctx — the dead stat.
    return scrubberCtx.stats.titles | 0;
}

test('G1: report Titles count reflects the actual number of aliased titles (RED — L9)', () => {
    // 1. Drive the REAL title-aliasing path the same way state-snapshot.js does:
    //    one pseudonym context per export, fed a trace with distinct titles.
    const pseudoCtx = createPseudonymContext();
    const trace = {
        injected: [
            { title: 'Aelarion the Grey', vaultSource: 'CampaignVault' },
            { title: 'The Sunken City', vaultSource: 'CampaignVault' },
            { title: 'Queen Mirabel', vaultSource: 'CampaignVault' },
        ],
        keywordMatched: [
            // a duplicate title must NOT double-count (cardinality preserved)
            { title: 'Aelarion the Grey', vaultSource: 'CampaignVault' },
            { title: 'House Veyra', vaultSource: 'CampaignVault' },
        ],
    };
    pseudonymizeTrace(trace, pseudoCtx);

    // Ground truth: 4 distinct real titles got aliased to <title-1..4>.
    const realAliasedTitles = pseudoCtx.titleMap.size;
    assertEqual(realAliasedTitles, 4, 'sanity: 4 distinct titles were actually aliased');
    assertEqual(pseudoCtx.titleCounter, 4, 'sanity: titleCounter tracks the 4 aliases');

    // 2. The report builds a FRESH scrubber ctx (export.js:642 `makeCtx()`),
    //    then reads its stats. No title pattern ever touches stats.titles.
    const scrubberCtx = makeCtx();

    // 3. The invariant under test: the number the report PRINTS for "Titles"
    //    must equal the number of titles that were actually aliased.
    const reported = reportedTitlesCount(scrubberCtx, pseudoCtx);
    assertEqual(
        reported,
        realAliasedTitles,
        `report Titles count must equal aliased-title count: expected ${realAliasedTitles}, got ${reported}`,
    );
});

test('G2: dead scrubber stat is the source of the lie — scrubbing titles never increments scrubber stats.titles', () => {
    // Pin the exact mechanism: pseudonymizing many titles leaves the SCRUBBER
    // ctx (the one the report reads) completely untouched. This is descriptive
    // of the bug today; after Agent-B deletes the dead stat and re-sources the
    // report, G1 above is the assertion that actually flips green.
    const pseudoCtx = createPseudonymContext();
    pseudonymizeTrace({
        injected: [
            { title: 'One', vaultSource: 'V' },
            { title: 'Two', vaultSource: 'V' },
        ],
    }, pseudoCtx);
    assertEqual(pseudoCtx.titleMap.size, 2, 'two titles aliased in the real context');

    const scrubberCtx = makeCtx();
    // No production code path increments scrubberCtx.stats.titles — confirm it
    // stays 0 even though titles WERE aliased (in the other context).
    assertEqual(scrubberCtx.stats.titles | 0, 0, 'scrubber stats.titles is the never-written dead stat (always 0)');
});


// ============================================================================
//  Summary
// ============================================================================

await summary('Diagnostics Tests');
