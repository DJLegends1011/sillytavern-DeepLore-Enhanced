/**
 * DeepLore Enhanced — Audit-Fix Librarian Tests
 *
 * Guards three hot-path Librarian fixes that derive decisions from the RESOLVED
 * DLE Librarian profile instead of ST's GLOBAL connection state:
 *
 *   P1-5  isToolCallingSupported() — gate on the resolved Librarian profileId +
 *         the profile's chat_completion_source, not global selectedProfile /
 *         oai_settings.chat_completion_source.
 *   P1-6  getProviderFormat() — derive the message format from the resolved
 *         Librarian profile's source, not the global; agentic-loop must thread
 *         the resolved connConfig into the frozen format.
 *   P3-1  Emma's session (librarian-session.js sendMessage) — wrap the raw callAI
 *         with the SAME circuit-breaker pattern as scribe (tryAcquireHalfOpenProbe
 *         → recordAiSuccess / isExcludedFromBreaker-gated recordAiFailure).
 *
 * NOTE: src/librarian/agentic-api.js and librarian-session.js cannot be imported
 * in plain Node — they statically import ST's shared.js / openai.js / script.js /
 * extensions.js. Following the established suite convention (see regression.test.mjs
 * AGENTIC-API section), the pure decision logic is reconstructed inline as exact
 * mirrors of the production helpers, and the production source is additionally
 * asserted via snippet regexes so the mirrors stay honest and the fixes can't
 * silently regress back to reading global state.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    assert, assertEqual, assertNull, assertMatch,
    test, section, summary,
} from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src', 'librarian');
const apiSrc = readFileSync(join(SRC, 'agentic-api.js'), 'utf8');
const loopSrc = readFileSync(join(SRC, 'agentic-loop.js'), 'utf8');
const sessionSrc = readFileSync(join(SRC, 'librarian-session.js'), 'utf8');

console.log('DeepLore Enhanced — Audit-Fix Librarian Tests');
console.log('P1-5 tool-gate, P1-6 provider-format, P3-1 Emma breaker.\n');

// ============================================================================
// Shared inline mirrors of production pure helpers (agentic-api.js)
// ============================================================================

// Exact mirror of CONNECT_API_MAP chat-completion entries (ST slash-commands.js).
// For chat-completion profiles the entry is { selected:'openai', source:<cc_source> }.
const CONNECT_API_MAP = {
    claude: { selected: 'openai', source: 'claude' },
    openai: { selected: 'openai', source: 'openai' },
    oai: { selected: 'openai', source: 'openai' },          // alias
    google: { selected: 'openai', source: 'makersuite' },   // alias
    makersuite: { selected: 'openai', source: 'makersuite' },
    vertexai: { selected: 'openai', source: 'vertexai' },
    openrouter: { selected: 'openai', source: 'openrouter' },
    perplexity: { selected: 'openai', source: 'perplexity' }, // no-tools source
    // text-completion profile — no chat_completion_source
    koboldcpp: { selected: 'textgenerationwebui', type: 'koboldcpp' },
};

const NO_TOOLS_SOURCES = new Set([
    'ai21', 'perplexity', 'nanogpt', 'pollinations', 'moonshot',
]);

const NO_TOOLS_MODELS = [
    /^deepseek-reasoner/i, /^deepseek\/.*r1/i, /-r1(-|$|:)/i,
    /^o1(-|$)/i, /^openai\/o1/i, /^anthropic\/.*-thinking/i,
];
function isReasoningOnlyModel(model) {
    if (!model || typeof model !== 'string') return false;
    return NO_TOOLS_MODELS.some(re => re.test(model));
}

// Mirror: _chatCompletionSourceFromApiMapEntry
function chatCompletionSourceFromApiMapEntry(apiMapEntry) {
    if (!apiMapEntry || apiMapEntry.selected !== 'openai') return null;
    return apiMapEntry.source || null;
}

// Mirror: _providerFormatForSource
function providerFormatForSource(source) {
    if (source === 'claude') return 'claude';
    if (source === 'makersuite' || source === 'vertexai') return 'google';
    return 'openai';
}

// Mirror: getResolvedLibrarianSource — `env` injects the ST surfaces.
//   env.getProfile(id) -> profile|undefined   (CMRS profile lookup)
//   env.globalSource    -> oai_settings.chat_completion_source (fallback only)
function getResolvedLibrarianSource(connConfig, env) {
    if (connConfig.mode === 'proxy') return null;
    try {
        const profileId = connConfig.profileId;
        if (profileId) {
            const profile = env.getProfile?.(profileId);
            if (profile?.api) {
                const source = chatCompletionSourceFromApiMapEntry(CONNECT_API_MAP[profile.api]);
                if (source) return source;
            }
        }
    } catch { /* noop */ }
    return env.globalSource || null;
}

// Mirror: getResolvedModel (profile-first, global fallback)
function getResolvedModel(connConfig, env) {
    if (connConfig.mode === 'proxy') return '';
    try {
        const profileId = connConfig.profileId;
        if (profileId) {
            const profile = env.getProfile?.(profileId);
            if (profile?.model) return profile.model;
        }
    } catch { /* noop */ }
    return env.globalModel || '';
}

// Mirror: isToolCallingSupported (P1-5). `env` adds mainApi.
function isToolCallingSupported(model, connConfig, env) {
    if (connConfig.mode === 'proxy') return false;
    if (env.mainApi !== 'openai') return false;
    if (connConfig.mode === 'profile') {
        if (!connConfig.profileId) return false;
    }
    const source = getResolvedLibrarianSource(connConfig, env);
    if (!source) return false;
    if (NO_TOOLS_SOURCES.has(source)) return false;
    const resolvedModel = model || getResolvedModel(connConfig, env);
    if (resolvedModel && isReasoningOnlyModel(resolvedModel)) return false;
    return true;
}

// Mirror: getProviderFormat (P1-6).
function getProviderFormat(connConfig, env) {
    if (connConfig.mode === 'proxy') return null;
    return providerFormatForSource(getResolvedLibrarianSource(connConfig, env));
}

// ── Test env factory ──
function makeEnv({ profiles = {}, globalSource = null, globalModel = '', mainApi = 'openai' } = {}) {
    return {
        getProfile: (id) => profiles[id],
        globalSource,
        globalModel,
        mainApi,
    };
}

// ============================================================================
// P1-5 — isToolCallingSupported gates on RESOLVED Librarian profile
// ============================================================================

section('P1-5 — tool-calling gate uses resolved Librarian profile, not global');

test('P1-5-1: configured Librarian profile + EMPTY global selectedProfile -> TRUE (was wrongly false)', () => {
    // The bug: old code returned false because ctx.connectionManager.selectedProfile
    // (global) was empty, even though the Librarian profile is fully configured.
    const env = makeEnv({
        profiles: { 'lib-claude': { api: 'claude', model: 'claude-sonnet-4-5' } },
        globalSource: null,   // global selectedProfile/source empty
        globalModel: '',
        mainApi: 'openai',
    });
    const connConfig = { mode: 'profile', profileId: 'lib-claude' };
    assertEqual(isToolCallingSupported(null, connConfig, env), true,
        'configured Librarian profile must enable tools even with empty global state');
});

test('P1-5-2: global tool-capable source + Librarian profile -> NO-TOOLS source -> FALSE (was wrongly true)', () => {
    // The bug: old code read the GLOBAL source ('claude', tool-capable) and passed,
    // ignoring that the Librarian profile points at perplexity (no tools).
    const env = makeEnv({
        profiles: { 'lib-pplx': { api: 'perplexity', model: 'sonar' } },
        globalSource: 'claude', // global is tool-capable — must NOT be consulted
        mainApi: 'openai',
    });
    const connConfig = { mode: 'profile', profileId: 'lib-pplx' };
    assertEqual(isToolCallingSupported(null, connConfig, env), false,
        'Librarian profile on a no-tools source must disable tools despite global being capable');
});

test('P1-5-3: profile mode with UNSET Librarian profileId -> FALSE', () => {
    const env = makeEnv({ globalSource: 'claude', mainApi: 'openai' });
    const connConfig = { mode: 'profile', profileId: '' };
    assertEqual(isToolCallingSupported(null, connConfig, env), false,
        'profile mode without a profileId cannot support tools');
});

test('P1-5-4: source gate + model gate answer about the SAME profile', () => {
    // Librarian profile is openrouter (tool-capable source) but routes a reasoning-only
    // model. Both gates must read THIS profile: source passes, model gate fails -> FALSE.
    const env = makeEnv({
        profiles: { 'lib-or': { api: 'openrouter', model: 'openai/o1-preview' } },
        globalSource: 'openai',  // different global — must be ignored
        globalModel: 'gpt-4o',   // tool-capable global model — must be ignored
        mainApi: 'openai',
    });
    const connConfig = { mode: 'profile', profileId: 'lib-or' };
    assertEqual(isToolCallingSupported(null, connConfig, env), false,
        'reasoning-only model on the resolved profile must fail the model gate');
});

test('P1-5-5: openrouter Claude profile -> TRUE (tool-capable source, normal model)', () => {
    const env = makeEnv({
        profiles: { 'lib-or': { api: 'openrouter', model: 'anthropic/claude-3.5-sonnet' } },
        mainApi: 'openai',
    });
    const connConfig = { mode: 'profile', profileId: 'lib-or' };
    assertEqual(isToolCallingSupported(null, connConfig, env), true,
        'openrouter Claude relay with a normal model supports tools');
});

test('P1-5-6: proxy mode -> FALSE (dead-headed)', () => {
    const env = makeEnv({ globalSource: 'claude', mainApi: 'openai' });
    assertEqual(isToolCallingSupported(null, { mode: 'proxy', profileId: 'x' }, env), false,
        'proxy mode is dead-headed -> no tools');
});

test('P1-5-7: main_api !== openai -> FALSE', () => {
    const env = makeEnv({
        profiles: { lib: { api: 'claude', model: 'claude-sonnet-4-5' } },
        mainApi: 'textgenerationwebui',
    });
    assertEqual(isToolCallingSupported(null, { mode: 'profile', profileId: 'lib' }, env), false,
        'non-chat-completion main_api cannot tool-call via this path');
});

test('P1-5-8: text-completion Librarian profile with NO global -> FALSE (null source)', () => {
    // koboldcpp profile has no chat_completion_source. With no global fallback
    // either, getResolvedLibrarianSource returns null -> gate fails.
    const env = makeEnv({
        profiles: { lib: { api: 'koboldcpp', model: 'whatever' } },
        globalSource: null,
        mainApi: 'openai',
    });
    assertEqual(isToolCallingSupported(null, { mode: 'profile', profileId: 'lib' }, env), false,
        'a text-completion profile with no global source yields null -> no tools');
});

test('P1-5-9: text-completion Librarian profile FALLS BACK to global source (mirrors getResolvedModel)', () => {
    // When the Librarian profile cannot supply a chat-completion source,
    // getResolvedLibrarianSource intentionally falls back to the global source —
    // the SAME fallback getResolvedModel uses — rather than guessing. Documents
    // the contract so it isn't mistaken for a bug.
    const env = makeEnv({
        profiles: { lib: { api: 'koboldcpp', model: 'whatever' } },
        globalSource: 'claude', // active connection is the real one used here
        mainApi: 'openai',
    });
    assertEqual(getResolvedLibrarianSource({ mode: 'profile', profileId: 'lib' }, env), 'claude',
        'falls back to global source when the profile has no chat-completion source');
});

// ============================================================================
// P1-6 — getProviderFormat / source derivation from resolved profile
// ============================================================================

section('P1-6 — provider format derived from resolved Librarian profile');

test('P1-6-1: Librarian -> Claude profile, global -> OpenAI => format "claude"', () => {
    const env = makeEnv({
        profiles: { 'lib-claude': { api: 'claude', model: 'claude-sonnet-4-5' } },
        globalSource: 'openai', // global is OpenAI — the bug returned 'openai'
    });
    assertEqual(getProviderFormat({ mode: 'profile', profileId: 'lib-claude' }, env), 'claude',
        'Claude Librarian profile must build Claude-shaped messages regardless of global');
});

test('P1-6-2: Librarian -> OpenAI profile, global -> Claude => format "openai"', () => {
    const env = makeEnv({
        profiles: { 'lib-oai': { api: 'openai', model: 'gpt-4o' } },
        globalSource: 'claude', // global is Claude — the bug returned 'claude'
    });
    assertEqual(getProviderFormat({ mode: 'profile', profileId: 'lib-oai' }, env), 'openai',
        'OpenAI Librarian profile must build OpenAI-shaped messages regardless of global');
});

test('P1-6-3: Librarian -> Google (makersuite) profile => format "google"', () => {
    const env = makeEnv({
        profiles: { 'lib-g': { api: 'makersuite', model: 'gemini-2.5-pro' } },
        globalSource: 'openai',
    });
    assertEqual(getProviderFormat({ mode: 'profile', profileId: 'lib-g' }, env), 'google',
        'makersuite profile -> google format');
});

test('P1-6-4: vertexai profile => format "google"', () => {
    const env = makeEnv({ profiles: { lib: { api: 'vertexai', model: 'gemini-2.5-pro' } } });
    assertEqual(getProviderFormat({ mode: 'profile', profileId: 'lib' }, env), 'google',
        'vertexai profile -> google format');
});

test('P1-6-5: google alias (api:"google") resolves to makersuite -> "google"', () => {
    const env = makeEnv({ profiles: { lib: { api: 'google', model: 'gemini-2.5-pro' } } });
    assertEqual(getProviderFormat({ mode: 'profile', profileId: 'lib' }, env), 'google',
        'the "google" CONNECT_API_MAP alias maps to makersuite source -> google format');
});

test('P1-6-6: proxy mode => null format', () => {
    const env = makeEnv({ globalSource: 'claude' });
    assertNull(getProviderFormat({ mode: 'proxy', profileId: 'x' }, env),
        'proxy mode returns null format');
});

test('P1-6-7: unresolvable Librarian profile falls back to global source', () => {
    // No matching profile -> getResolvedLibrarianSource falls back to env.globalSource.
    const env = makeEnv({ profiles: {}, globalSource: 'claude' });
    assertEqual(getProviderFormat({ mode: 'profile', profileId: 'missing' }, env), 'claude',
        'fallback to global source when the Librarian profile cannot be resolved');
});

section('P1-6 — pure source/format helper unit coverage');

test('P1-6-8: _chatCompletionSourceFromApiMapEntry returns source for chat-completion entries', () => {
    assertEqual(chatCompletionSourceFromApiMapEntry({ selected: 'openai', source: 'claude' }), 'claude', 'claude entry');
    assertEqual(chatCompletionSourceFromApiMapEntry({ selected: 'openai', source: 'openrouter' }), 'openrouter', 'openrouter entry');
});

test('P1-6-9: _chatCompletionSourceFromApiMapEntry returns null for text-completion / missing', () => {
    assertNull(chatCompletionSourceFromApiMapEntry({ selected: 'textgenerationwebui', type: 'koboldcpp' }), 'text-completion -> null');
    assertNull(chatCompletionSourceFromApiMapEntry(undefined), 'undefined entry -> null');
    assertNull(chatCompletionSourceFromApiMapEntry({ selected: 'openai' }), 'openai entry w/o source -> null');
});

test('P1-6-10: _providerFormatForSource mapping is exhaustive', () => {
    assertEqual(providerFormatForSource('claude'), 'claude', 'claude');
    assertEqual(providerFormatForSource('makersuite'), 'google', 'makersuite');
    assertEqual(providerFormatForSource('vertexai'), 'google', 'vertexai');
    assertEqual(providerFormatForSource('openai'), 'openai', 'openai');
    assertEqual(providerFormatForSource('openrouter'), 'openai', 'openrouter parses OpenAI-shape');
    assertEqual(providerFormatForSource(null), 'openai', 'null defaults to openai');
});

// ============================================================================
// Source-snippet regression guards (mirrors must match production intent)
// ============================================================================

section('SRC-GUARD — production wrappers reference resolved profile, not global');

test('SRC-1: getResolvedLibrarianSource exists and uses CONNECT_API_MAP + getProfile', () => {
    assertMatch(apiSrc, /export function getResolvedLibrarianSource\(connConfig\)/,
        'getResolvedLibrarianSource must be exported');
    assertMatch(apiSrc, /getProfile\?\.\(profileId\)/,
        'must look up the CMRS profile by the resolved profileId');
    assertMatch(apiSrc, /_chatCompletionSourceFromApiMapEntry\(CONNECT_API_MAP\?\.\[profile\.api\]\)/,
        'must map profile.api through CONNECT_API_MAP to the cc source');
});

test('SRC-2: isToolCallingSupported gates on resolved profileId + getResolvedLibrarianSource', () => {
    const fn = apiSrc.slice(apiSrc.indexOf('export function isToolCallingSupported'),
        apiSrc.indexOf('export function getProviderFormat'));
    assertMatch(fn, /getResolvedLibrarianSource\(resolved\)/,
        'P1-5: source gate must read the resolved Librarian profile');
    assertMatch(fn, /if \(!resolved\.profileId\) return false/,
        'P1-5: profile-mode gate must check resolved.profileId, not global selectedProfile');
    assert(!/oai_settings\?\.chat_completion_source/.test(fn),
        'P1-5: must NOT read global oai_settings.chat_completion_source directly');
    // Active code (not comments) must not gate on the global selectedProfile.
    // Strip line-comments before checking so the explanatory comment naming the
    // removed behavior doesn't trip the guard.
    const fnCode = fn.replace(/\/\/[^\n]*/g, '');
    assert(!/extensionSettings\?\.connectionManager\?\.selectedProfile/.test(fnCode)
        && !/ctx\?\.extensionSettings/.test(fnCode),
        'P1-5: active code must NOT reach into global connectionManager.selectedProfile via getContext');
    assert(!/getContext\(\)/.test(fnCode),
        'P1-5: active code must NOT call getContext() (it pulled global connection state)');
});

test('SRC-3: getProviderFormat derives format from resolved profile source', () => {
    const fn = apiSrc.slice(apiSrc.indexOf('export function getProviderFormat'),
        apiSrc.indexOf('export function isUnderlyingClaude'));
    assertMatch(fn, /_providerFormatForSource\(getResolvedLibrarianSource\(resolved\)\)/,
        'P1-6: format must be derived from the resolved Librarian profile source');
    assert(!/oai_settings\?\.chat_completion_source/.test(fn),
        'P1-6: must NOT read global oai_settings.chat_completion_source directly');
});

test('SRC-4: agentic-loop threads resolved connConfig into the frozen provider format', () => {
    assertMatch(loopSrc, /const connConfig = _resolveLibrarianConnConfig\(\);/,
        'loop must resolve the Librarian connConfig once');
    assertMatch(loopSrc, /_resolveProviderFormat\(connConfig\)/,
        'loop must thread connConfig into the frozen format (runAgenticLoop)');
    assertMatch(loopSrc, /_resolveProviderFormat\(_resolveLibrarianConnConfig\(\)\)/,
        '_runFlagIteration must also derive format from the Librarian connConfig');
    assertMatch(loopSrc, /function _resolveProviderFormat\(connConfig\)/,
        '_resolveProviderFormat must accept a connConfig arg');
    // Stub-safety: both helpers must access agentic-api off the namespace, not
    // named bindings (the loop test stub omits these exports).
    assertMatch(loopSrc, /agenticApi\.getProviderFormat/, 'getProviderFormat accessed via namespace');
    assertMatch(loopSrc, /agenticApi\.resolveLibrarianConnConfig/, 'resolveLibrarianConnConfig accessed via namespace');
});

// ============================================================================
// P3-1 — Emma session shares the circuit breaker (mirror scribe pattern)
// ============================================================================

section('P3-1 — Emma session circuit-breaker integration');

// Minimal breaker mirror — same observable contract as state.js for this test:
// tryAcquireHalfOpenProbe gates entry; recordAiSuccess clears; recordAiFailure
// trips after 2; excluded errors release the probe and don't trip.
function makeBreaker() {
    let open = false, failures = 0, probe = false;
    const THRESHOLD = 2;
    return {
        isOpen: () => open,
        tryAcquire() { if (open) return false; probe = true; return true; },
        recordSuccess() { probe = false; failures = 0; open = false; },
        recordFailure() { probe = false; failures++; if (failures >= THRESHOLD) open = true; },
        release() { probe = false; },
        _probe: () => probe,
    };
}

// Mirror of the P3-1 acquire/record skeleton wrapped around Emma's callAI.
// isExcluded mirrors isExcludedFromBreaker for the relevant cases.
function isExcluded(err) {
    if (err?.throttled || err?.timedOut || err?.userAborted) return true;
    if (err?.name === 'AbortError') return true;
    if (err?.status === 401 || err?.status === 403 || err?.status === 429) return true;
    return false;
}

async function emmaCallWithBreaker(breaker, callAI) {
    if (!breaker.tryAcquire()) {
        return { skipped: true, reason: 'circuit_open' };
    }
    try {
        const result = await callAI();
        breaker.recordSuccess();
        return { ok: true, result };
    } catch (err) {
        if (!isExcluded(err)) breaker.recordFailure(); else breaker.release();
        return { ok: false, err };
    }
}

test('P3-1-1: open breaker -> Emma call is SKIPPED (not issued)', async () => {
    const breaker = makeBreaker();
    breaker.recordFailure(); breaker.recordFailure(); // trip it
    assert(breaker.isOpen(), 'breaker should be open after 2 failures');
    let called = false;
    const out = await emmaCallWithBreaker(breaker, async () => { called = true; return 'x'; });
    assert(out.skipped === true, 'call must be skipped while breaker open');
    assert(called === false, 'callAI must NOT be invoked while breaker open');
});

test('P3-1-2: success records success (clears any prior failure)', async () => {
    const breaker = makeBreaker();
    breaker.recordFailure(); // 1 failure, not yet open
    const out = await emmaCallWithBreaker(breaker, async () => 'prose');
    assert(out.ok === true, 'call should succeed');
    assert(!breaker.isOpen(), 'breaker stays closed');
    assert(breaker._probe() === false, 'probe cleared on success');
});

test('P3-1-3: two consecutive unclassified failures TRIP the breaker', async () => {
    const breaker = makeBreaker();
    const boom = new Error('500 internal'); // unclassified -> trips
    await emmaCallWithBreaker(breaker, async () => { throw boom; });
    assert(!breaker.isOpen(), 'one failure must not open the breaker');
    await emmaCallWithBreaker(breaker, async () => { throw boom; });
    assert(breaker.isOpen(), 'second consecutive failure opens the breaker');
});

test('P3-1-4: excluded errors (401/abort/timeout/429) do NOT trip; probe released', async () => {
    for (const err of [
        Object.assign(new Error('unauthorized'), { status: 401 }),
        Object.assign(new Error('rate'), { status: 429 }),
        Object.assign(new Error('aborted'), { name: 'AbortError', userAborted: true }),
        Object.assign(new Error('slow'), { timedOut: true }),
    ]) {
        const breaker = makeBreaker();
        await emmaCallWithBreaker(breaker, async () => { throw err; });
        await emmaCallWithBreaker(breaker, async () => { throw err; });
        assert(!breaker.isOpen(), `excluded error (${err.status || err.name || 'timeout'}) must not trip the breaker`);
        assert(breaker._probe() === false, 'probe must be released on excluded error');
    }
});

section('P3-1 — production source guards (librarian-session.js)');

test('P3-1-SRC-1: sendMessage imports the breaker helpers from state.js', () => {
    assertMatch(sessionSrc, /tryAcquireHalfOpenProbe,\s*recordAiSuccess,\s*recordAiFailure,\s*releaseHalfOpenProbe/,
        'breaker helpers must be imported from state.js');
    assertMatch(sessionSrc, /isExcludedFromBreaker/, 'isExcludedFromBreaker must be imported');
});

test('P3-1-SRC-2: probe acquired before the call, success recorded, failure routed through classifier', () => {
    // Window the AI-call region of sendMessage.
    const start = sessionSrc.indexOf("result = await callAI(systemPrompt, messageToSend");
    assert(start > -1, 'callAI site must exist');
    const win = sessionSrc.slice(start - 800, start + 1400);
    assertMatch(win, /if \(!tryAcquireHalfOpenProbe\(\)\)/,
        'must mutation-gate with tryAcquireHalfOpenProbe before the call');
    assertMatch(win, /recordAiSuccess\(\)/, 'must record success after a successful call');
    assertMatch(win, /if \(!isExcludedFromBreaker\(err\)\) recordAiFailure\(\); else releaseHalfOpenProbe\(\)/,
        'failure path must route the trip decision through isExcludedFromBreaker (matches scribe)');
});

test('P3-1-SRC-3: false "lower layers record breaker state" comment is removed/corrected', () => {
    // The old comment falsely claimed callViaProfile/callViaProxy already called
    // recordAiFailure(). It must no longer assert that.
    assert(!/already called recordAiFailure\(\)/.test(sessionSrc),
        'the false "already called recordAiFailure()" claim must be removed');
    assertMatch(sessionSrc, /The breaker is now recorded\s*\n\s*\/\/ ABOVE \(P3-1\)/,
        'comment must reflect that the breaker is now recorded in this layer');
});

await summary('Audit-Fix Librarian Tests');
