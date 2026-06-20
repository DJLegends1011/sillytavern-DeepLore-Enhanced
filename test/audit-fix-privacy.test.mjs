/**
 * DeepLore Enhanced — Audit-fix privacy/security regression tests.
 * Run with: node test/audit-fix-privacy.test.mjs
 *
 * Covers the six confirmed diagnostic-export privacy + abort-routing fixes:
 *   P1-2 — AI prompt/chat bodies redacted before export (redactAiPromptEntry).
 *   P1-3 — prompt-bearing KEY redaction in scrubDeep (incl. nested promptPresets).
 *   P1-4 — JSON-ish / header-ish secret string patterns in the scrubber.
 *   A1   — URL userinfo creds stripped from shared-path snapshot URLs.
 *   P2-9 — R2 narrowed so canonical prompts (backtick mentions) pass; real
 *          `#lorebook-` hashtags / `tags:` blocks still reject.
 *   P3-6 — UI aborts route through abortWith() (source wiring guard).
 *
 * Modules that statically import ST's `script.js` (export.js, state-snapshot.js)
 * cannot be imported under bare node, so the two ST-coupled fixes (P1-2, A1) are
 * verified two ways: (1) the exact shipped pure logic is re-derived from the
 * source file and exercised, and (2) a source-text guard asserts the shipped
 * wiring/helper is present. The four pure modules are imported and exercised
 * directly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    assert, assertEqual, assertMatch,
    test, section, summary,
} from './helpers.mjs';

import { scrubString, scrubDeep } from '../src/diagnostics/scrubber.js';
import {
    containsRealLorebookTag, validatePromptShape, verifyPromptFileForDeletion,
    buildPromptFileContent,
} from '../src/prompts/prompt-store-pure.js';
import * as PromptsEn from '../src/i18n/prompts/en.js';
import { KNOWN_PROMPT_KEYS } from '../src/prompts/prompt-validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => join(__dirname, '..', 'src', rel);
const readSrc = (rel) => readFileSync(SRC(rel), 'utf8');

// ============================================================================
//  P1-4 — Scrubber catches serialized JSON / header secrets
// ============================================================================

section('P1-4 — JSON / header secret string patterns');

test('JSON "api_key" value redacted (key label kept)', () => {
    const out = scrubString('{"api_key":"abc123"}');
    assertEqual(out, '{"api_key":"<redacted>"}', 'api_key value redacted');
});

test('JSON "apikey" / "token" / "password" / "secret" / "authorization" redacted', () => {
    for (const k of ['apikey', 'token', 'password', 'secret', 'authorization']) {
        const out = scrubString(`{"${k}":"sensitive-value-here"}`);
        assert(!out.includes('sensitive-value-here'), `${k} value must be redacted`);
        assert(out.includes(`"${k}":`), `${k} key label must be kept`);
    }
});

test('JSON redaction is length-independent (short values too)', () => {
    const out = scrubString('{"token":"ab"}');
    assertEqual(out, '{"token":"<redacted>"}', 'short token still redacted');
});

test('Header X-API-Key value redacted', () => {
    const out = scrubString('X-API-Key: mysecret');
    assertEqual(out, 'X-API-Key: <redacted>', 'X-API-Key value redacted');
});

test('Header Authorization: Basic <...> redacted', () => {
    const out = scrubString('Authorization: Basic dXNlcjpwYXNz');
    assertEqual(out, 'Authorization: <redacted>', 'Basic auth redacted');
});

test('Header Authorization: Bearer <short token> redacted', () => {
    const out = scrubString('Authorization: Bearer ab');
    assert(!out.includes('Bearer ab'), 'short bearer token must be redacted');
    assertMatch(out, /^Authorization:\s*<redacted>$/, 'header value redacted to EOL');
});

test('Header Cookie / Set-Cookie value redacted', () => {
    assertEqual(scrubString('Cookie: session=abc123'), 'Cookie: <redacted>', 'Cookie redacted');
    assert(!scrubString('Set-Cookie: foo=bar; HttpOnly').includes('foo=bar'), 'Set-Cookie redacted');
});

test('Header redaction stops at newline (does not eat following lines)', () => {
    const out = scrubString('X-API-Key: secret\nKeep-This-Line: visible');
    assert(out.includes('Keep-This-Line: visible'), 'next line preserved');
    assert(!out.includes('secret'), 'secret redacted');
});

test('Non-secret JSON values are untouched', () => {
    const out = scrubString('{"model":"gpt-4","count":3}');
    assertEqual(out, '{"model":"gpt-4","count":3}', 'benign JSON preserved');
});

// ============================================================================
//  P1-3 — Prompt-bearing KEY redaction in scrubDeep
// ============================================================================

section('P1-3 — Prompt-key + promptPresets redaction');

test('Each known prompt-override key collapses to [prompt len=N]', () => {
    const keys = [
        'aiSearchSystemPrompt', 'librarianCustomSystemPrompt', 'scribePrompt',
        'autoSuggestPrompt', 'aiNotepadPrompt', 'aiNotepadExtractPrompt',
        'optimizeKeysPrompt', 'summarySystemPrompt',
    ];
    const settings = {};
    for (const k of keys) settings[k] = 'PRIVATE PROSE BODY that must not leak';
    const out = scrubDeep({ settings });
    for (const k of keys) {
        assert(!String(out.settings[k]).includes('PRIVATE PROSE'), `${k} body must not leak`);
        assertMatch(String(out.settings[k]), /^\[prompt len=\d+\]$/, `${k} → length descriptor`);
    }
});

test('Length descriptor preserves the real body length', () => {
    const body = 'x'.repeat(123);
    const out = scrubDeep({ aiSearchSystemPrompt: body });
    assertEqual(out.aiSearchSystemPrompt, '[prompt len=123]', 'length preserved in descriptor');
});

test('promptPresets: structure/keys preserved, bodies redacted', () => {
    const out = scrubDeep({
        promptPresets: {
            presetA: { name: 'Alpha', content: 'full preset body text here' },
            presetB: 'inline preset body string',
        },
    });
    // Keys survive so the diagnostic shows WHICH presets exist.
    assert('presetA' in out.promptPresets, 'preset key presetA preserved');
    assert('presetB' in out.promptPresets, 'preset key presetB preserved');
    assert('content' in out.promptPresets.presetA, 'nested key content preserved');
    // Bodies redacted.
    assert(!JSON.stringify(out.promptPresets).includes('full preset body'), 'nested body redacted');
    assert(!JSON.stringify(out.promptPresets).includes('inline preset body'), 'inline body redacted');
    assertMatch(out.promptPresets.presetA.content, /^\[prompt len=\d+\]$/, 'nested content → descriptor');
    assertMatch(out.promptPresets.presetB, /^\[prompt len=\d+\]$/, 'inline preset → descriptor');
});

test('Sensitive-key still wins over prompt-key (apiKey not treated as prompt)', () => {
    const out = scrubDeep({ aiSearchPromptApiKey: 'sk-deadbeef', scribePrompt: 'body' });
    assertEqual(out.aiSearchPromptApiKey, '<redacted>', 'api key wins → <redacted>, not prompt descriptor');
    assertMatch(out.scribePrompt, /^\[prompt len=\d+\]$/, 'plain prompt key → descriptor');
});

test('Prompt-key redaction also applies inside a Map (settings-as-Map safety)', () => {
    const m = new Map([['scribePrompt', 'secret body'], ['promptPresets', { p: 'body' }]]);
    const out = scrubDeep({ m });
    assertMatch(out.m.entries.scribePrompt, /^\[prompt len=\d+\]$/, 'Map prompt value redacted');
    assertMatch(out.m.entries.promptPresets.p, /^\[prompt len=\d+\]$/, 'Map promptPresets body redacted');
});

// ============================================================================
//  P1-2 — AI prompt/chat bodies redacted before export
// ============================================================================

section('P1-2 — redactAiPromptEntry');

// export.js statically imports ST's script.js (via state-snapshot.js) and can't
// be imported under bare node. Re-derive the exact shipped pure logic from
// source, exercise it, AND guard the shipped wiring + helper text.

function buildRedactAiPromptEntry() {
    const src = readSrc('diagnostics/export.js');
    // Extract the exact shipped function body so the test exercises real logic.
    const m = src.match(/export function redactAiPromptEntry\([\s\S]*?\n\}/);
    assert(!!m, 'redactAiPromptEntry source block found in export.js');
    // redactedLen() is referenced by the function — pull it too.
    const lenMatch = src.match(/function redactedLen\([\s\S]*?\n\}/);
    assert(!!lenMatch, 'redactedLen source block found in export.js');
    const factory = new Function(`${lenMatch[0]}\n${m[0].replace('export function', 'function')}\nreturn redactAiPromptEntry;`);
    return factory();
}

const redactAiPromptEntry = buildRedactAiPromptEntry();

test('systemPrompt / userMessage / response bodies → [redacted len=N]', () => {
    const entry = {
        t: 123, caller: 'aiSearch', model: 'claude-x', status: 'ok', durationMs: 50,
        systemPrompt: 'SYSTEM PROSE that is private',
        userMessage: 'USER CHAT BODY private',
        response: 'MODEL RESPONSE private',
        error: null,
    };
    const out = redactAiPromptEntry(entry);
    assert(!out.systemPrompt.includes('SYSTEM PROSE'), 'systemPrompt body redacted');
    assert(!out.userMessage.includes('USER CHAT'), 'userMessage body redacted');
    assert(!out.response.includes('MODEL RESPONSE'), 'response body redacted');
    assertMatch(out.systemPrompt, /^\[redacted len=\d+\]$/, 'systemPrompt descriptor');
    assertMatch(out.userMessage, /^\[redacted len=\d+\]$/, 'userMessage descriptor');
    assertMatch(out.response, /^\[redacted len=\d+\]$/, 'response descriptor');
});

test('Metadata fields preserved verbatim', () => {
    const entry = { t: 123, caller: 'scribe', model: 'm', status: 'error', durationMs: 9, error: 'boom', systemPrompt: 'x' };
    const out = redactAiPromptEntry(entry);
    assertEqual(out.t, 123, 't preserved');
    assertEqual(out.caller, 'scribe', 'caller preserved');
    assertEqual(out.model, 'm', 'model preserved');
    assertEqual(out.status, 'error', 'status preserved');
    assertEqual(out.error, 'boom', 'error preserved');
});

test('Null body (e.g. response on failed call) passes through untouched', () => {
    const out = redactAiPromptEntry({ systemPrompt: 'a', userMessage: 'b', response: null });
    assertEqual(out.response, null, 'null response stays null (no [redacted len=...])');
});

test('Shipped export.js wires the redactor over the flushed buffer', () => {
    const src = readSrc('diagnostics/export.js');
    assertMatch(src, /aiPromptBuffer\.flush\(\)\.map\(redactAiPromptEntry\)/, 'flush().map(redactAiPromptEntry) wired');
});

// ============================================================================
//  A1 — URL userinfo creds stripped from shared-path snapshot URLs
// ============================================================================

section('A1 — stripUrlSecrets on shared-path URLs');

// state-snapshot.js also imports script.js → re-derive the shipped helper.
function buildStripUrlSecrets() {
    const src = readSrc('diagnostics/state-snapshot.js');
    const m = src.match(/function stripUrlSecrets\([\s\S]*?\n\}/);
    assert(!!m, 'stripUrlSecrets source block found in state-snapshot.js');
    const factory = new Function(`${m[0]}\nreturn stripUrlSecrets;`);
    return factory();
}

const stripUrlSecrets = buildStripUrlSecrets();

test('Userinfo creds stripped from URL', () => {
    assertEqual(
        stripUrlSecrets('https://user:pass@proxy.example.com/v1'),
        'https://proxy.example.com/v1',
        '//user:pass@ removed',
    );
});

test('Token-bearing query params redacted', () => {
    const out = stripUrlSecrets('https://host/v1?api_key=abcd1234&model=x');
    assert(!out.includes('abcd1234'), 'api_key value stripped');
    assert(out.includes('model=x'), 'benign param preserved');
});

test('Plain URL (no creds) unchanged', () => {
    assertEqual(stripUrlSecrets('https://api.openai.com/v1'), 'https://api.openai.com/v1', 'plain URL untouched');
});

test('Non-string input passes through', () => {
    assertEqual(stripUrlSecrets(null), null, 'null passthrough');
    assertEqual(stripUrlSecrets(undefined), undefined, 'undefined passthrough');
});

test('Shipped state-snapshot.js wires stripUrlSecrets on both shared URL emissions', () => {
    const src = readSrc('diagnostics/state-snapshot.js');
    assertMatch(src, /'api-url':\s*stripUrlSecrets\(profile\['api-url'\]\)/, "api-url wrapped in stripUrlSecrets");
    assertMatch(src, /reverseProxy:\s*stripUrlSecrets\(oai\?\.reverse_proxy\)/, 'reverseProxy wrapped in stripUrlSecrets');
});

// ============================================================================
//  P2-9 — Canonical prompts no longer self-rejected by R2
// ============================================================================

section('P2-9 — narrowed R2 (real tag vs prose mention)');

test('Backtick / prose mention of lorebook- PASSES (not a real tag)', () => {
    assert(!containsRealLorebookTag('Use the `lorebook-guide` tag for guides.'), 'backtick mention passes');
    assert(!containsRealLorebookTag('We have a lorebook-style retrieval system.'), 'compound word passes');
    assert(!containsRealLorebookTag('the lorebook-guide entries are special'), 'bare prose passes');
});

test('Real inline #lorebook- hashtag is detected', () => {
    assert(containsRealLorebookTag('intro\n#lorebook-guide\nbody'), 'newline-prefixed hashtag detected');
    assert(containsRealLorebookTag('text #lorebook-seed more'), 'space-prefixed hashtag detected');
});

test('YAML tags: block listing a lorebook- value is detected', () => {
    assert(containsRealLorebookTag('tags: [lorebook-guide, other]'), 'inline array detected');
    assert(containsRealLorebookTag('tags:\n  - lorebook-seed\n  - misc'), 'block list detected');
    assert(containsRealLorebookTag('tags: lorebook-always'), 'single inline value detected');
});

test('A tags: block with no lorebook- value PASSES', () => {
    assert(!containsRealLorebookTag('tags:\n  - character\n  - location'), 'unrelated tags block passes');
    assert(!containsRealLorebookTag('tags: [hero, villain]'), 'unrelated inline array passes');
});

test('Both canonical Librarian prompts pass validatePromptShape (overlay)', () => {
    for (const key of ['LIBRARIAN_PRIMER', 'LIBRARIAN_FIRSTRUN_QA_SCRIPT']) {
        const body = PromptsEn[key];
        const res = validatePromptShape({ frontmatter: { key }, body }, body, key);
        assert(res.ok, `${key} must pass overlay validation (got: ${res.ok ? '' : res.reason})`);
    }
});

test('EVERY canonical prompt body passes overlay + deletion preflight', () => {
    let overlayFails = 0;
    let deleteFails = 0;
    let n = 0;
    for (const key of KNOWN_PROMPT_KEYS) {
        const body = PromptsEn[key];
        if (typeof body !== 'string') continue;
        n++;
        const overlay = validatePromptShape({ frontmatter: { key }, body }, body, key);
        if (!overlay.ok) { overlayFails++; console.error(`    overlay reject: ${key} — ${overlay.reason}`); }
        const file = buildPromptFileContent({ key, locale: 'en', value: body });
        const del = verifyPromptFileForDeletion(file, key);
        if (!del.ok) { deleteFails++; console.error(`    delete reject: ${key} — ${del.reason}`); }
    }
    assert(n >= 30, `exercised all canonical keys (got ${n})`);
    assertEqual(overlayFails, 0, 'zero canonical bodies rejected by overlay validation');
    assertEqual(deleteFails, 0, 'zero canonical bodies rejected by deletion preflight');
});

// ============================================================================
//  P3-6 — UI aborts route through abortWith()
// ============================================================================

section('P3-6 — UI aborts via abortWith()');

test('settings-ui.js imports abortWith and uses it for test-AI cancel', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'settings-ui.js'), 'utf8');
    assertMatch(src, /import\s*\{\s*abortWith\s*\}\s*from\s*'\.\.\/diagnostics\/interceptors\.js'/, 'abortWith imported');
    assertMatch(src, /abortWith\(_testAiAbortCtrl,\s*'settings:test_ai_cancel'\)/, 'test-AI cancel routes through abortWith');
    assert(!/_testAiAbortCtrl\.abort\(\)/.test(src), 'no direct _testAiAbortCtrl.abort() remains');
});

test('vault-scan-popup.js imports abortWith and uses it on popup close', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'ui', 'vault-scan-popup.js'), 'utf8');
    assertMatch(src, /import\s*\{\s*abortWith\s*\}\s*from\s*'\.\.\/diagnostics\/interceptors\.js'/, 'abortWith imported');
    assertMatch(src, /abortWith\(scanAbort,\s*'vault_scan:popup_closed'\)/, 'scan abort routes through abortWith');
    assert(!/scanAbort\.abort\(\)/.test(src), 'no direct scanAbort.abort() remains');
});

await summary('Audit-fix privacy/security tests');
