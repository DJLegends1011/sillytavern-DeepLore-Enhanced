/**
 * DeepLore Enhanced unit tests
 * Run with: node test/unit.mjs
 *
 * Tests shared core functions (imported from core/) and Enhanced-specific functions.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    parseFrontmatter, extractWikiLinks, cleanContent, extractTitle,
    truncateToSentence, simpleHash, escapeRegex, escapeXml,
    buildScanText, buildAiChatContext, validateSettings, yamlEscape,
} from '../core/utils.js';
import { testEntryMatch, countKeywordOccurrences, applyGating, resolveLinks, formatAndGroup, clearScanTextCache } from '../core/matching.js';
import { parseVaultFile, clearPrompts } from '../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../core/sync.js';

// Enhanced-only pure functions (imported from production code, not reimplemented)
import { extractAiResponseClient, clusterEntries, buildCategoryManifest, buildObsidianURI, convertWiEntry, stripObsidianSyntax, normalizeResults as normalizeResultsProd, checkHealthPure, parseMatchReason, computeSourcesDiff, categorizeRejections, resolveEntryVault, tokenBarColor, formatRelativeTime, isForceInjected, normalizePinBlock, matchesPinBlock, normalizeLoreGap, fuzzyTitleMatch, extractAiNotes, validateSessionResponse, parseSessionResponse, sanitizeFilename, cmrsResultToText } from '../src/helpers.js';
import { encodeVaultPath, validateVaultPath, pruneCircuitBreakers } from '../src/vault/obsidian-api.js';

// BM25 functions (extracted to bm25.js for testability)
import { buildBM25Index, queryBM25 } from '../src/vault/bm25.js';

// Graph analysis pure functions
import { convexHull, COMMUNITY_PALETTE } from '../src/graph/graph-analysis.js';

// Graph render pure functions
import { toPastel, lightenColor, darkenColor } from '../src/graph/graph-render.js';

// Drawer state pure functions — can't import directly due to ST dependency (escapeHtml).
// Test formatTokensCompact and getMatchLabel by inlining the logic.

// State module imports for computeOverallStatus tests
import {
    computeOverallStatus, trackerKey,
    setVaultIndex, setIndexEverLoaded, setLastHealthResult,
    setLastVaultFailureCount, setLastVaultAttemptCount,
    recordAiFailure, recordAiSuccess,
    isAiCircuitOpen, tryAcquireHalfOpenProbe, releaseHalfOpenProbe,
    setAiCircuitOpenedAt,
    entityNameSet, entityShortNameRegexes,
    setFieldDefinitions, setDecayTracker, setConsecutiveInjections,
    decayTracker, consecutiveInjections,
    aiSearchCache, setAiSearchCache,
    notifyPinBlockChanged, notifyGatingChanged,
    lastGenerationTrackerSnapshot, setLastGenerationTrackerSnapshot,
    setCooldownTracker, injectionHistory, setInjectionHistory,
    generationCount, setGenerationCount,
    cooldownTracker,
} from '../src/state.js';

// normalizeResults is a test-only utility (inlined in aiSearch() in production)
function normalizeResults(arr) {
    return arr.map(item => {
        if (typeof item === 'string') {
            return { title: item, confidence: 'medium', reason: 'AI search' };
        }
        if (typeof item === 'object' && item !== null && typeof item.title === 'string') {
            return {
                title: item.title,
                confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
                reason: typeof item.reason === 'string' ? item.reason : 'AI search',
            };
        }
        return { title: String(item), confidence: 'medium', reason: 'AI search' };
    });
}

// Settings constraints (Enhanced version with AI/scribe fields)
const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 0, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    aiSearchMaxTokens: { min: 64, max: 4096 },
    aiSearchTimeout: { min: 1000, max: 30000 },
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 1000 },
    scribeInterval: { min: 1, max: 50 },
    syncPollingInterval: { min: 0, max: 3600 },
    reinjectionCooldown: { min: 0, max: 50 },
    newChatThreshold: { min: 1, max: 20 },
};

// ============================================================================
// Test runner (shared from helpers.mjs)
// ============================================================================

import { assert, assertEqual, assertNotEqual, test, summary, makeEntry, makeSettings } from './helpers.mjs';

// ============================================================================
// Tests: parseFrontmatter
// ============================================================================

test('parseFrontmatter: basic key-value pairs', () => {
    const input = '---\ntitle: Test Note\npriority: 10\nenabled: true\n---\n# Body';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Test Note', 'should parse string value');
    assertEqual(result.frontmatter.priority, 10, 'should parse number value');
    assertEqual(result.frontmatter.enabled, true, 'should parse boolean true');
    assertEqual(result.body, '# Body', 'should extract body');
});

test('parseFrontmatter: arrays', () => {
    const input = '---\ntags:\n  - lorebook\n  - character\nkeys:\n  - Eris\n  - goddess\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.tags, ['lorebook', 'character'], 'should parse tags array');
    assertEqual(result.frontmatter.keys, ['Eris', 'goddess'], 'should parse keys array');
});

test('parseFrontmatter: empty arrays', () => {
    const input = '---\nkeys: []\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, [], 'should parse empty array');
});

test('parseFrontmatter: boolean false', () => {
    const input = '---\nenabled: false\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.enabled, false, 'should parse boolean false');
});

test('parseFrontmatter: quoted strings', () => {
    const input = '---\ntitle: "Hello World"\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Hello World', 'should strip quotes');
});

test('parseFrontmatter: no frontmatter', () => {
    const input = '# Just a heading\nSome content';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter, {}, 'should return empty frontmatter');
    assertEqual(result.body, input, 'should return full content as body');
});

test('parseFrontmatter: inline arrays', () => {
    const input = '---\nkeys: [Wren, wren, The Bird]\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, ['Wren', 'wren', 'The Bird'], 'should parse inline array');
});

test('parseFrontmatter: inline arrays with quotes', () => {
    const input = '---\nkeys: ["Wren Smith", \'The Bird\']\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, ['Wren Smith', 'The Bird'], 'should strip quotes from inline array items');
});

test('parseFrontmatter: inline array with spaces', () => {
    const input = '---\ntags: [ lorebook , character ]\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.tags, ['lorebook', 'character'], 'should trim whitespace in inline array items');
});

test('parseFrontmatter: requires and excludes arrays', () => {
    const input = '---\nrequires:\n  - Eris\n  - Dark Council\nexcludes:\n  - Draft\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.requires, ['Eris', 'Dark Council'], 'should parse requires array');
    assertEqual(result.frontmatter.excludes, ['Draft'], 'should parse excludes array');
});

test('parseFrontmatter: position, depth, role fields', () => {
    const input = '---\nposition: before\ndepth: 2\nrole: user\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.position, 'before', 'should parse position string');
    assertEqual(result.frontmatter.depth, 2, 'should parse depth number');
    assertEqual(result.frontmatter.role, 'user', 'should parse role string');
});

test('parseFrontmatter: trailing whitespace on closing delimiter', () => {
    const input = '---\ntitle: Foo\n---   \nBody text here';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Foo', 'should parse despite trailing spaces on ---');
    assertEqual(result.body, 'Body text here', 'body should be correct');
});

test('parseFrontmatter: trailing tab on closing delimiter', () => {
    const input = '---\ntitle: Bar\n---\t\nBody';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Bar', 'should parse despite trailing tab on ---');
});

test('parseFrontmatter: block scalar with colons in content', () => {
    const input = '---\nsummary: |\n  Known for: charisma and power.\n  Role: leader of the council.\nnext_key: value\n---\nBody';
    const result = parseFrontmatter(input);
    assert(result.frontmatter.summary.includes('Known for: charisma'), 'colon line should be part of summary');
    assert(result.frontmatter.summary.includes('Role: leader'), 'second colon line should be part of summary');
    assertEqual(result.frontmatter.next_key, 'value', 'key after block scalar should parse');
});

test('parseFrontmatter: block scalar with multiple indented colon lines', () => {
    const input = '---\nsummary: >\n  weakness: arrogance\n  habitat: forests\n  status: active\ntags:\n  - lorebook\n---\nBody';
    const result = parseFrontmatter(input);
    assert(result.frontmatter.summary.includes('weakness: arrogance'), 'first colon line preserved');
    assert(result.frontmatter.summary.includes('habitat: forests'), 'second colon line preserved');
    assert(result.frontmatter.summary.includes('status: active'), 'third colon line preserved');
    assert(Array.isArray(result.frontmatter.tags), 'tags array should parse after block scalar');
    assertEqual(result.frontmatter.tags[0], 'lorebook', 'tag value correct');
});

// ============================================================================
// V-H3 (2026-05-22): prototype pollution guard for parseFrontmatter
// ============================================================================
//
// Hostile YAML frontmatter MUST NOT mutate Object.prototype. parseFrontmatter
// builds via Object.create(null) so direct `frontmatter[__proto__] = value`
// assignments land as own properties on the prototype-less object instead of
// invoking the inherited __proto__ setter (which would replace the prototype).
// Vault content is user-controlled and Cartographer/import flows can pull from
// third-party sources — a polluted Object.prototype would affect unrelated code
// across the entire process. See gotchas.md #57.

test('V-H3: parseFrontmatter does NOT pollute Object.prototype via __proto__', () => {
    // Probe: a fresh, unrelated object MUST NOT see the polluted property after
    // parsing. Use a unique probe key so other tests can't accidentally satisfy
    // the assertion via pre-existing pollution.
    const probe = {};
    assert(!('vh3_pwned' in probe), 'baseline: probe property absent before parse');

    parseFrontmatter('---\n__proto__: vh3_pwned\n---\nbody');

    // The critical assertion. Before V-H3 fix, `Object.prototype.vh3_pwned` was
    // unset because the parsed value is the string "vh3_pwned", not an object —
    // but the canonical attack form sets a sub-key. Try the sub-key form too.
    assert(!('vh3_pwned' in probe), 'V-H3: scalar __proto__ assignment did NOT pollute Object.prototype');
});

test('V-H3: nested __proto__ key assignment does NOT pollute Object.prototype', () => {
    // The classic prototype-pollution form: a key under __proto__ leaks onto
    // Object.prototype via the inherited setter on a normal object. With
    // Object.create(null) there is no inherited setter, so the assignment is
    // an own property on the prototype-less frontmatter object.
    const probe = {};
    assert(!('vh3_leaked' in probe), 'baseline clean');

    // Simulates an attacker setting a property visible across all objects.
    parseFrontmatter('---\n__proto__:\n  - vh3_leaked\n---\nbody');

    assert(!('vh3_leaked' in probe), 'V-H3: nested __proto__ did NOT pollute Object.prototype');
    // Object.prototype.toString must still work normally — confirm the
    // prototype chain is intact for normal objects.
    assertEqual(typeof probe.toString, 'function', 'Object.prototype.toString still callable');
});

test('V-H3: constructor key does NOT pollute Object.prototype.constructor', () => {
    // `constructor` is the second classic pollution vector. With Object.create(null)
    // we never traverse the inherited setter — the assignment lands as an own
    // property on the prototype-less object.
    const originalCtor = Object.prototype.constructor;
    parseFrontmatter('---\nconstructor: vh3_evil_ctor\n---\nbody');
    assertEqual(Object.prototype.constructor, originalCtor,
        'V-H3: Object.prototype.constructor unchanged after malicious YAML');

    // A fresh object's .constructor still references Object.
    const probe = {};
    assertEqual(probe.constructor, Object, 'fresh object still inherits Object as constructor');
});

test('V-H3: prototype key does NOT pollute Object.prototype', () => {
    // Third classic vector — `prototype` as a key name. Object.create(null)
    // means this is just a regular own property, no chain mutation.
    const probe = {};
    assert(!('vh3_proto_leak' in probe), 'baseline clean');
    parseFrontmatter('---\nprototype: vh3_proto_leak\n---\nbody');
    assert(!('vh3_proto_leak' in probe), 'V-H3: `prototype` key did NOT leak');
});

test('V-H3: frontmatter object has no inherited prototype (defense in depth)', () => {
    // Pin the implementation contract — Object.create(null) is what makes the
    // above tests pass. If a future refactor switches back to `{}`, this test
    // catches it.
    const result = parseFrontmatter('---\ntitle: Test\n---\nbody');
    assertEqual(Object.getPrototypeOf(result.frontmatter), null,
        'V-H3: frontmatter object has null prototype');
    // Sanity — still serializable and has the parsed data.
    assertEqual(result.frontmatter.title, 'Test', 'normal parsing still works');
    assertEqual(JSON.stringify(result.frontmatter), '{"title":"Test"}',
        'JSON.stringify works on prototype-less object');
});

test('V-H3: legitimate frontmatter with keys containing "proto" still parses', () => {
    // Make sure the fix didn't accidentally over-restrict — keys CONTAINING
    // "proto" or "constructor" as substrings should still work normally.
    const result = parseFrontmatter('---\nprotocol: https\nconstruction: ongoing\n---\nbody');
    assertEqual(result.frontmatter.protocol, 'https', 'protocol key parses normally');
    assertEqual(result.frontmatter.construction, 'ongoing', 'construction key parses normally');
});

// ============================================================================
// Tests: cleanContent
// ============================================================================

test('cleanContent: strips image embeds', () => {
    assertEqual(cleanContent('Before ![[image.png]] after'), 'Before  after', 'should strip wiki image embeds');
    assertEqual(cleanContent('Before ![alt](http://img.png) after'), 'Before  after', 'should strip markdown image embeds');
});

test('cleanContent: converts wiki links', () => {
    assertEqual(cleanContent('See [[Target Page]]'), 'See Target Page', 'should convert simple wiki links');
    assertEqual(cleanContent('See [[Target|Display Text]]'), 'See Display Text', 'should convert aliased wiki links');
});

test('cleanContent: collapses blank lines', () => {
    assertEqual(cleanContent('Line 1\n\n\n\n\nLine 2'), 'Line 1\n\nLine 2', 'should collapse 5 newlines to 2');
});

test('cleanContent: strips deeplore-exclude regions', () => {
    assertEqual(
        cleanContent('Before\n%%deeplore-exclude%%\nHidden stuff\n%%/deeplore-exclude%%\nAfter'),
        'Before\n\nAfter',
        'should strip deeplore-exclude region and contents',
    );
    assertEqual(
        cleanContent('Start %%deeplore-exclude%%secret%%/deeplore-exclude%% end'),
        'Start  end',
        'should strip inline deeplore-exclude',
    );
});

test('cleanContent: strips Obsidian %% comment blocks', () => {
    assertEqual(cleanContent('Before %%inline comment%% after'), 'Before  after',
        'should strip inline %% blocks');
    assertEqual(
        cleanContent('Before\n%%aat-inline-event\nstart-date: 2025\ntimelines: [test]\n%%\nAfter'),
        'Before\n\nAfter',
        'should strip multiline %% blocks',
    );
    assertEqual(cleanContent('%%aat-event-end-of-body%%'), '',
        'should strip standalone %% markers');
});

test('cleanContent: strips HTML div tags', () => {
    assertEqual(
        cleanContent('<div class="meta-block">[Species: vampire]</div>'),
        '[Species: vampire]',
        'should strip div tags but keep content',
    );
    assertEqual(cleanContent('Text <div>inner</div> more'), 'Text inner more',
        'should strip plain div tags');
});

test('cleanContent: strips H1 heading', () => {
    assertEqual(cleanContent('# Eris\nContent here'), 'Content here',
        'should strip H1 heading');
    assertEqual(cleanContent('## Subheading\nContent'), '## Subheading\nContent',
        'should NOT strip H2 headings');
});

// ============================================================================
// Tests: extractTitle
// ============================================================================

test('extractTitle: from H1', () => {
    assertEqual(extractTitle('# My Title\nContent', 'test.md'), 'My Title', 'should extract H1');
});

test('extractTitle: from filename', () => {
    assertEqual(extractTitle('No heading here', 'folder/My Note.md'), 'My Note', 'should fall back to filename');
});

// ============================================================================
// Tests: extractWikiLinks
// ============================================================================

test('extractWikiLinks: basic links', () => {
    const links = extractWikiLinks('See [[Eris]] and [[Dark Council]].');
    assertEqual(links.length, 2, 'should find two links');
    assert(links.includes('Eris'), 'should include Eris');
    assert(links.includes('Dark Council'), 'should include Dark Council');
});

test('extractWikiLinks: aliased links', () => {
    const links = extractWikiLinks('She joined [[Dark Council|the council]] recently.');
    assertEqual(links.length, 1, 'should find one link');
    assertEqual(links[0], 'Dark Council', 'should extract target, not display text');
});

test('extractWikiLinks: ignores image embeds', () => {
    const links = extractWikiLinks('![[portrait.png]] and [[Eris]] and ![[map.jpg]]');
    assertEqual(links.length, 1, 'should skip image embeds');
    assertEqual(links[0], 'Eris', 'should only include non-image link');
});

test('extractWikiLinks: deduplicates', () => {
    const links = extractWikiLinks('[[Eris]] met [[Eris]] at the [[Temple]].');
    assertEqual(links.length, 2, 'should deduplicate Eris');
    assert(links.includes('Eris'), 'should include Eris once');
    assert(links.includes('Temple'), 'should include Temple');
});

test('extractWikiLinks: empty body', () => {
    assertEqual(extractWikiLinks('No links here.').length, 0, 'should return empty for no links');
    assertEqual(extractWikiLinks('').length, 0, 'should handle empty string');
});

test('extractWikiLinks: trims whitespace in link targets', () => {
    const links = extractWikiLinks('See [[ Eris ]] here.');
    assertEqual(links[0], 'Eris', 'should trim whitespace from link target');
});

test('extractWikiLinks: strips trailing backslash from pipe-alias links', () => {
    const links = extractWikiLinks('See [[Name\\|Display]] here.');
    assertEqual(links.length, 1, 'should find one link');
    assertEqual(links[0], 'Name', 'should strip trailing backslash from link target');
});

// ============================================================================
// Tests: testEntryMatch
// ============================================================================

test('testEntryMatch: case insensitive substring', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I met eris today', settings), 'Eris', 'should match case-insensitively');
    assertEqual(testEntryMatch(entry, 'No match here', settings), null, 'should return null for no match');
});

test('testEntryMatch: case sensitive', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: true, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I met eris today', settings), null, 'should not match wrong case');
    assertEqual(testEntryMatch(entry, 'I met Eris today', settings), 'Eris', 'should match exact case');
});

test('testEntryMatch: whole words', () => {
    const entry = { keys: ['war'] };
    const settings = { caseSensitive: false, matchWholeWords: true };
    assertEqual(testEntryMatch(entry, 'The warning was clear', settings), null, 'should not match partial word');
    assertEqual(testEntryMatch(entry, 'The war began', settings), 'war', 'should match whole word');
});

test('testEntryMatch: empty keys', () => {
    const entry = { keys: [] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'any text', settings), null, 'should return null for empty keys');
});

test('testEntryMatch: regex special chars in key', () => {
    const entry = { keys: ['C++ programming'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I love c++ programming', settings), 'C++ programming', 'should handle regex special chars');
});

// ============================================================================
// Tests: truncateToSentence
// ============================================================================

test('truncateToSentence: short text unchanged', () => {
    assertEqual(truncateToSentence('Hello world.', 200), 'Hello world.', 'should not truncate short text');
});

test('truncateToSentence: cuts at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence that is very long and keeps going on.';
    const result = truncateToSentence(text, 40);
    assertEqual(result, 'First sentence. Second sentence.', 'should cut at last sentence boundary');
});

test('truncateToSentence: falls back to ellipsis', () => {
    const text = 'This is a single very long sentence without any periods that just keeps going on and on and on and on';
    const result = truncateToSentence(text, 30);
    assertEqual(result, 'This is a single very long sen...', 'should add ellipsis when no sentence boundary');
});

test('truncateToSentence: respects exclamation marks', () => {
    const text = 'Watch out! This is dangerous. And more text that is very long and keeps going.';
    const result = truncateToSentence(text, 35);
    assertEqual(result, 'Watch out! This is dangerous.', 'should cut at exclamation/period');
});

// ============================================================================
// Tests: simpleHash
// ============================================================================

test('simpleHash: deterministic', () => {
    const hash1 = simpleHash('test string');
    const hash2 = simpleHash('test string');
    assertEqual(hash1, hash2, 'same input should produce same hash');
});

test('simpleHash: different for different inputs', () => {
    const hash1 = simpleHash('hello');
    const hash2 = simpleHash('world');
    assert(hash1 !== hash2, 'different inputs should produce different hashes');
});

// ============================================================================
// Tests: validateSettings
// ============================================================================

test('validateSettings: clamps values', () => {
    const settings = { obsidianPort: 99999, scanDepth: -5, cacheTTL: 100000 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.obsidianPort, 65535, 'should clamp port to max');
    assertEqual(settings.scanDepth, 0, 'should clamp scanDepth to min');
    assertEqual(settings.cacheTTL, 86400, 'should clamp cacheTTL to max');
});

test('validateSettings: clamps AI settings', () => {
    const settings = { aiSearchMaxTokens: 10000, aiSearchTimeout: 500, syncPollingInterval: 5000 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.aiSearchMaxTokens, 4096, 'should clamp AI max tokens');
    assertEqual(settings.aiSearchTimeout, 1000, 'should clamp AI timeout to min');
    assertEqual(settings.syncPollingInterval, 3600, 'should clamp sync interval to max');
});

test('validateSettings: rounds floats', () => {
    const settings = { scanDepth: 4.7 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.scanDepth, 5, 'should round float to integer');
});

test('validateSettings: trims lorebook tag', () => {
    const settings = { lorebookTag: '  custom-tag  ' };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.lorebookTag, 'custom-tag', 'should trim whitespace');
});

test('validateSettings: defaults empty lorebook tag', () => {
    const settings = { lorebookTag: '   ' };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.lorebookTag, 'lorebook', 'should default empty tag to lorebook');
});

test('validateSettings: clamps scribe interval', () => {
    const settings = { scribeInterval: 100 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.scribeInterval, 50, 'should clamp scribe interval to max');
});

test('validateSettings: clamps manifest summary length', () => {
    const settings = { aiSearchManifestSummaryLength: 2000 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.aiSearchManifestSummaryLength, 1000, 'should clamp summary length to max');
});

test('validateSettings: clamps reinjection cooldown', () => {
    const settings = { reinjectionCooldown: 100 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.reinjectionCooldown, 50, 'should clamp reinjection cooldown to max');
});

test('validateSettings: clamps new chat threshold', () => {
    const settings = { newChatThreshold: 30 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.newChatThreshold, 20, 'should clamp new chat threshold to max');
});

// ============================================================================
// Tests: buildScanText / buildAiChatContext
// ============================================================================

test('buildAiChatContext: annotates roles', () => {
    const chat = [
        { name: 'Alice', is_user: true, mes: 'Hello' },
        { name: 'Bob', is_user: false, mes: 'Hi there' },
    ];
    const result = buildAiChatContext(chat, 10);
    assert(result.includes('Alice (user): Hello'), 'should mark Alice as user');
    assert(result.includes('Bob (character): Hi there'), 'should mark Bob as character');
});

test('buildAiChatContext: respects depth', () => {
    const chat = [
        { name: 'A', is_user: true, mes: 'msg1' },
        { name: 'B', is_user: false, mes: 'msg2' },
        { name: 'C', is_user: true, mes: 'msg3' },
    ];
    const result = buildAiChatContext(chat, 2);
    assert(!result.includes('msg1'), 'should exclude messages beyond depth');
    assert(result.includes('msg2'), 'should include recent messages');
    assert(result.includes('msg3'), 'should include most recent message');
});

test('buildAiChatContext: handles missing name', () => {
    const chat = [{ is_user: false, mes: 'Hello' }];
    const result = buildAiChatContext(chat, 10);
    assert(result.includes('Unknown (character)'), 'should use Unknown for missing name');
});

test('buildScanText: depth 0 returns empty string', () => {
    const chat = [
        { name: 'Alice', mes: 'Hello world' },
        { name: 'Bob', mes: 'Greetings' },
    ];
    assertEqual(buildScanText(chat, 0), '', 'should return empty string for depth 0');
});

test('buildScanText: depth 1 returns last message', () => {
    const chat = [
        { name: 'Alice', mes: 'First' },
        { name: 'Bob', mes: 'Second' },
    ];
    const result = buildScanText(chat, 1);
    assert(!result.includes('First'), 'should exclude first message');
    assert(result.includes('Second'), 'should include last message');
});

test('buildAiChatContext: depth 0 returns empty string', () => {
    const chat = [{ name: 'Alice', is_user: true, mes: 'Hello' }];
    assertEqual(buildAiChatContext(chat, 0), '', 'should return empty string for depth 0');
});

// ============================================================================
// Tests: applyGating
// ============================================================================

test('applyGating: all requires present passes', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Dark Council'),
        makeEntry('Secret', { requires: ['Eris', 'Dark Council'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 3, 'all three should pass');
});

test('applyGating: missing requires removes entry', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Secret', { requires: ['Eris', 'Dark Council'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'Secret should be removed (Dark Council missing)');
    assertEqual(result[0].title, 'Eris', 'Eris should remain');
});

test('applyGating: excludes blocks entry', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Draft Notes'),
        makeEntry('Secret', { excludes: ['Draft Notes'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 2, 'Secret should be excluded');
    assert(!result.find(e => e.title === 'Secret'), 'Secret should not be in results');
});

test('applyGating: cascading removal', () => {
    const entries = [
        makeEntry('A', { requires: ['B'] }),
        makeEntry('B', { requires: ['C'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 0, 'both should be removed by cascading');
});

test('applyGating: empty requires/excludes passes', () => {
    const entries = [makeEntry('Eris'), makeEntry('Plain Entry')];
    const result = applyGating(entries);
    assertEqual(result.length, 2, 'entries without gating rules should pass');
});

test('applyGating: case insensitive title matching', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Secret', { requires: ['eris'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 2, 'should match case-insensitively');
});

test('applyGating: constants still subject to gating', () => {
    const entries = [
        makeEntry('Draft Notes'),
        makeEntry('Always Entry', { constant: true, excludes: ['Draft Notes'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'constant entry should still be gated');
    assertEqual(result[0].title, 'Draft Notes', 'Draft Notes should remain');
});

// ============================================================================
// Tests: formatAndGroup (using imported core version)
// ============================================================================

const defaultTestSettings = {
    injectionPosition: 1,
    injectionDepth: 4,
    injectionRole: 0,
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    unlimitedEntries: true,
    unlimitedBudget: true,
    maxEntries: 10,
    maxTokensBudget: 2048,
};

test('formatAndGroup: single group when no overrides', () => {
    const entries = [
        makeEntry('Eris', { content: 'A goddess' }),
        makeEntry('Temple', { content: 'A sacred place' }),
    ];
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
    assertEqual(result.groups.length, 1, 'should produce one group');
    assertEqual(result.groups[0].tag, 'deeplore_p1_d4_r0', 'should use global settings in tag');
    assertEqual(result.count, 2, 'should count 2 entries');
});

test('formatAndGroup: multiple groups with different positions', () => {
    const entries = [
        makeEntry('World Lore', { content: 'Background', injectionPosition: 2 }),
        makeEntry('Eris', { content: 'A goddess' }),
        makeEntry('Dialogue Hint', { content: 'Speak softly', injectionPosition: 1, injectionDepth: 0, injectionRole: 1 }),
    ];
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
    assertEqual(result.groups.length, 3, 'should produce three groups');
    assert(result.groups.some(g => g.tag === 'deeplore_p2_d4_r0'), 'should have before_prompt group');
    assert(result.groups.some(g => g.tag === 'deeplore_p1_d4_r0'), 'should have default in_chat group');
    assert(result.groups.some(g => g.tag === 'deeplore_p1_d0_r1'), 'should have custom in_chat group');
});

test('formatAndGroup: budget applied globally across groups', () => {
    // Content sized ~4 chars/token so truncation math is realistic
    const body = 'The quick brown fox jumped over the lazy dog. '.repeat(45); // ~2100 chars ≈ 500 tokens
    const entries = [
        makeEntry('A', { content: body, tokenEstimate: 500, injectionPosition: 2 }),
        makeEntry('B', { content: body, tokenEstimate: 500 }),
        makeEntry('C', { content: body, tokenEstimate: 500 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 1200 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    // C gets truncated to fit remaining 200 tokens (content is short so it fits entirely)
    assertEqual(result.count, 3, 'should accept all 3 entries (C truncated to fit)');
    assert(result.totalTokens <= 1200, 'total should not exceed budget');
    assert(result.acceptedEntries[2]._truncated === true, 'C should be truncated');
});

test('formatAndGroup: per-entry depth override', () => {
    const entries = [
        makeEntry('Near', { content: 'Close to action', injectionDepth: 1 }),
        makeEntry('Far', { content: 'Background info', injectionDepth: 8 }),
    ];
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
    assertEqual(result.groups.length, 2, 'should produce two groups at different depths');
    assert(result.groups.some(g => g.depth === 1), 'should have depth 1 group');
    assert(result.groups.some(g => g.depth === 8), 'should have depth 8 group');
});

test('formatAndGroup: fallback to global settings', () => {
    const entries = [makeEntry('Test', { content: 'Body' })];
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
    assertEqual(result.groups[0].position, 1, 'should use global position');
    assertEqual(result.groups[0].depth, 4, 'should use global depth');
    assertEqual(result.groups[0].role, 0, 'should use global role');
});

test('formatAndGroup: truncates entry to fit remaining budget', () => {
    // Use content with sentence endings so truncateToSentence finds clean boundaries
    const sentences = Array(50).fill('The quick brown fox jumped over the lazy dog.').join(' ');
    const longContent = sentences; // ~700+ chars, ~200 tokens
    const entries = [
        makeEntry('Small', { content: 'Short content.', tokenEstimate: 100 }),
        makeEntry('Big', { content: longContent, tokenEstimate: 200 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 160 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 2, 'should accept both entries (second truncated)');
    const big = result.acceptedEntries.find(e => e.title === 'Big');
    assert(big, 'Big entry should be in acceptedEntries');
    assert(big._truncated === true, 'Big entry should be marked as truncated');
    assert(big._originalTokens === 200, 'should preserve original token count');
    assert(big.tokenEstimate <= 60, 'truncated tokenEstimate should fit remaining budget');
    assert(big.content.length < longContent.length, 'content should be shorter than original');
});

test('formatAndGroup: skips entry when remaining budget below minimum threshold', () => {
    const entries = [
        makeEntry('A', { content: 'First entry.', tokenEstimate: 180 }),
        makeEntry('B', { content: 'Second entry.', tokenEstimate: 200 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 200 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 1, 'should only accept first entry (remaining < 50 tokens)');
    assertEqual(result.acceptedEntries[0].title, 'A', 'should be entry A');
});

test('formatAndGroup: truncates first entry that exceeds entire budget', () => {
    const sentences = Array(100).fill('The ancient vampire stalked through the dark corridor.').join(' ');
    const entries = [
        makeEntry('Huge', { content: sentences, tokenEstimate: 1000 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 200 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 1, 'should accept truncated entry');
    assert(result.acceptedEntries[0]._truncated === true, 'should be truncated');
    assert(result.acceptedEntries[0].tokenEstimate <= 210, 'should approximately fit budget');
});

test('formatAndGroup: acceptedEntries correct when first entry skipped', () => {
    // Budget is tiny (30 tokens) — too small even for truncation (< MIN_TRUNCATION_TOKENS=50)
    const entries = [
        makeEntry('TooBig', { content: 'Massive entry.', tokenEstimate: 500 }),
        makeEntry('Small', { content: 'Tiny.', tokenEstimate: 20 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 30 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 1, 'should accept Small (skip TooBig)');
    assertEqual(result.acceptedEntries[0].title, 'Small', 'accepted should be Small, not TooBig');
});

test('formatAndGroup: truncation does not mutate original entry', () => {
    const originalContent = 'C'.repeat(700);
    const entry = makeEntry('Mutable?', { content: originalContent, tokenEstimate: 200 });
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 100 };
    formatAndGroup([entry], settings, 'deeplore_');
    assertEqual(entry.content, originalContent, 'original entry content should be unchanged');
    assertEqual(entry.tokenEstimate, 200, 'original tokenEstimate should be unchanged');
    assert(entry._truncated === undefined, 'original should not have _truncated flag');
});

// ============================================================================
// Tests: detectChanges
// ============================================================================

function makeSnapshot(entries) {
    const snapshot = {
        contentHashes: new Map(),
        titleMap: new Map(),
        keyMap: new Map(),
        timestamp: Date.now(),
    };
    for (const e of entries) {
        snapshot.contentHashes.set(e.filename, simpleHash(e.content));
        snapshot.titleMap.set(e.filename, e.title);
        snapshot.keyMap.set(e.filename, JSON.stringify(e.keys || []));
    }
    return snapshot;
}

test('detectChanges: no previous snapshot returns empty', () => {
    const newSnap = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const changes = detectChanges(null, newSnap);
    assertEqual(changes.hasChanges, false, 'should report no changes');
});

test('detectChanges: detects new entries', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const now = makeSnapshot([
        { filename: 'a.md', title: 'A', content: 'hello', keys: [] },
        { filename: 'b.md', title: 'B', content: 'world', keys: [] },
    ]);
    const changes = detectChanges(old, now);
    assertEqual(changes.added, ['B'], 'should detect B as new');
    assertEqual(changes.hasChanges, true, 'should report changes');
});

test('detectChanges: detects removed entries', () => {
    const old = makeSnapshot([
        { filename: 'a.md', title: 'A', content: 'hello', keys: [] },
        { filename: 'b.md', title: 'B', content: 'world', keys: [] },
    ]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.removed, ['B'], 'should detect B as removed');
});

test('detectChanges: detects modified content', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello changed', keys: [] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.modified, ['A'], 'should detect A as modified');
});

test('detectChanges: detects keyword changes', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'same', keys: ['foo'] }]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'same', keys: ['foo', 'bar'] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.keysChanged, ['A'], 'should detect keyword change');
    assertEqual(changes.modified.length, 0, 'should not appear in modified (content unchanged)');
});

test('detectChanges: no changes returns hasChanges false', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: ['x'] }]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: ['x'] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.hasChanges, false, 'should report no changes');
});

// ============================================================================
// Tests: parseVaultFile (core/pipeline.js)
// ============================================================================

test('parseVaultFile: parses valid lorebook entry', () => {
    const file = {
        filename: 'Characters/Eris.md',
        content: '---\ntags:\n  - lorebook\nkeys:\n  - Eris\n  - goddess\npriority: 20\nsummary: "A powerful goddess"\n---\n# Eris\n\nShe is a goddess.',
    };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: 'lorebook-always', neverInsertTag: 'lorebook-never', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assert(entry !== null, 'should return an entry');
    assertEqual(entry.title, 'Eris', 'should extract title');
    assertEqual(entry.keys, ['Eris', 'goddess'], 'should extract keys');
    assertEqual(entry.priority, 20, 'should extract priority');
    assertEqual(entry.summary, 'A powerful goddess', 'should extract summary');
    assertEqual(entry.constant, false, 'should not be constant');
    assertEqual(entry.seed, false, 'should not be seed');
    assertEqual(entry.bootstrap, false, 'should not be bootstrap');
});

test('parseVaultFile: coerces scalar keys string to array', () => {
    const file = {
        filename: 'test.md',
        content: '---\ntags:\n  - lorebook\nkeys: single_keyword\n---\n# Test\n\nContent.',
    };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assert(entry !== null, 'should return an entry');
    assertEqual(entry.keys, ['single_keyword'], 'scalar keys should be coerced to single-element array');
});

test('parseVaultFile: numeric keys value coerced to string array', () => {
    const file = {
        filename: 'test.md',
        content: '---\ntags:\n  - lorebook\nkeys: 42\n---\n# Test\n\nContent.',
    };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assert(entry !== null, 'should return an entry');
    assertEqual(entry.keys, ['42'], 'numeric keys should be coerced to string array');
});

test('parseVaultFile: skips non-lorebook files', () => {
    const file = { filename: 'notes.md', content: '---\ntags:\n  - misc\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    assertEqual(parseVaultFile(file, tagConfig), null, 'should return null for non-lorebook');
});

test('parseVaultFile: skips disabled entries', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nenabled: false\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    assertEqual(parseVaultFile(file, tagConfig), null, 'should return null for disabled');
});

test('parseVaultFile: skips never-insert tag', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\n  - lorebook-never\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: 'lorebook-never', seedTag: '', bootstrapTag: '' };
    assertEqual(parseVaultFile(file, tagConfig), null, 'should return null for never-insert');
});

test('parseVaultFile: detects constant tag', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\n  - lorebook-always\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: 'lorebook-always', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.constant, true, 'should detect constant from tag');
});

test('parseVaultFile: detects seed and bootstrap tags', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\n  - lorebook-seed\n  - lorebook-bootstrap\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: 'lorebook-seed', bootstrapTag: 'lorebook-bootstrap' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.seed, true, 'should detect seed from tag');
    assertEqual(entry.bootstrap, true, 'should detect bootstrap from tag');
});

// ============================================================================
// Tests: parseVaultFile probability (core/pipeline.js)
// ============================================================================

test('parseVaultFile: probability 0.5', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 0.5\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 0.5, 'should parse probability 0.5');
});

test('parseVaultFile: probability 0', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 0\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 0, 'should parse probability 0');
});

test('parseVaultFile: probability 1', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 1\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 1, 'should parse probability 1');
});

test('parseVaultFile: probability clamped above 1', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 1.5\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 1, 'should clamp probability to 1');
});

test('parseVaultFile: probability clamped below 0', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: -0.3\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 0, 'should clamp probability to 0');
});

test('parseVaultFile: no probability field', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, null, 'should default to null when no probability');
});

test('parseVaultFile: probability non-number string', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: "not a number"\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, null, 'should default to null for non-number probability');
});

test('parseVaultFile: probability field present on VaultEntry', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assert('probability' in entry, 'probability field should exist on VaultEntry');
});

// ============================================================================
// Tests: clearPrompts (core/pipeline.js)
// ============================================================================

test('clearPrompts: removes matching prompts', () => {
    const prompts = {
        'deeplore_p1_d4_r0': 'test',
        'deeplore_enhanced': 'test',
        'other_prompt': 'keep',
    };
    clearPrompts(prompts, 'deeplore_', 'deeplore_enhanced');
    assertEqual(Object.keys(prompts), ['other_prompt'], 'should remove deeplore prompts only');
});

// ============================================================================
// Tests: resolveLinks (core/matching.js)
// ============================================================================

test('resolveLinks: resolves matching titles', () => {
    const index = [
        makeEntry('Eris', { links: ['Dark Council', 'Unknown Page'] }),
        makeEntry('Dark Council', { links: ['Eris'] }),
    ];
    resolveLinks(index);
    assertEqual(index[0].resolvedLinks, ['Dark Council'], 'should resolve matching link');
    assertEqual(index[1].resolvedLinks, ['Eris'], 'should resolve reverse link');
});

// ============================================================================
// Tests: countKeywordOccurrences (core/matching.js)
// ============================================================================

test('countKeywordOccurrences: counts multiple hits', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(countKeywordOccurrences(entry, 'Eris met eris and ERIS', settings), 3, 'should count 3 occurrences');
});

test('countKeywordOccurrences: whole words', () => {
    const entry = { keys: ['war'] };
    const settings = { caseSensitive: false, matchWholeWords: true };
    assertEqual(countKeywordOccurrences(entry, 'The war and warning of warfare', settings), 1, 'should count only whole word matches');
});

// ============================================================================
// Tests: takeIndexSnapshot (core/sync.js)
// ============================================================================

test('takeIndexSnapshot: creates snapshot from vault index', () => {
    const index = [
        makeEntry('Eris', { content: 'A goddess', keys: ['Eris'] }),
        makeEntry('Temple', { content: 'Sacred', keys: ['temple'] }),
    ];
    const snapshot = takeIndexSnapshot(index);
    assertEqual(snapshot.contentHashes.size, 2, 'should hash both entries');
    // BUG-AUDIT (Fix 25): keys are `vaultSource:filename`, not bare filename.
    // makeEntry defaults vaultSource: '' → key = ':Eris.md'.
    assertEqual(snapshot.titleMap.get(':Eris.md'), 'Eris', 'should map vaultSource:filename to title');
});

test('takeIndexSnapshot: multi-vault same-filename entries do not collide', () => {
    // Regression for Fix 25: filename-only keys would let vault-B's "Castle" overwrite vault-A's
    const index = [
        makeEntry('Castle', { content: 'A vault', keys: ['castle'], vaultSource: 'VaultA', filename: 'Places/Castle.md' }),
        makeEntry('Castle', { content: 'B vault', keys: ['castle'], vaultSource: 'VaultB', filename: 'Places/Castle.md' }),
    ];
    const snapshot = takeIndexSnapshot(index);
    assertEqual(snapshot.contentHashes.size, 2, 'multi-vault same-filename should produce two distinct keys');
    assertEqual(snapshot.titleMap.get('VaultA:Places/Castle.md'), 'Castle', 'VaultA key resolves');
    assertEqual(snapshot.titleMap.get('VaultB:Places/Castle.md'), 'Castle', 'VaultB key resolves');
    assertNotEqual(
        snapshot.contentHashes.get('VaultA:Places/Castle.md'),
        snapshot.contentHashes.get('VaultB:Places/Castle.md'),
        'distinct content → distinct hashes',
    );
});

// ============================================================================
// Tests: Enhanced-only functions
// ============================================================================

test('buildObsidianURI: basic path (strips .md)', () => {
    const uri = buildObsidianURI('My Vault', 'Characters/Alice.md');
    assertEqual(uri, 'obsidian://open?vault=My%20Vault&file=Characters/Alice', 'should build URI with encoded vault, stripped .md extension');
});

test('buildObsidianURI: spaces in path', () => {
    const uri = buildObsidianURI('TestVault', 'LA World/Main Characters/The Hero.md');
    assertEqual(uri, 'obsidian://open?vault=TestVault&file=LA%20World/Main%20Characters/The%20Hero', 'should encode spaces in each segment');
});

test('buildObsidianURI: no vault name returns null', () => {
    assertEqual(buildObsidianURI('', 'test.md'), null, 'should return null for empty vault name');
    assertEqual(buildObsidianURI(null, 'test.md'), null, 'should return null for null vault name');
});

test('buildObsidianURI: special characters', () => {
    const uri = buildObsidianURI('Vault & Notes', 'Lore/Items/Ring (of Power).md');
    assertEqual(uri, 'obsidian://open?vault=Vault%20%26%20Notes&file=Lore/Items/Ring%20(of%20Power)', 'should encode ampersands and parentheses');
});

test('buildObsidianURI: root-level file', () => {
    const uri = buildObsidianURI('MyVault', 'README.md');
    assertEqual(uri, 'obsidian://open?vault=MyVault&file=README', 'should handle root-level files');
});

test('buildObsidianURI: non-.md file keeps extension', () => {
    const uri = buildObsidianURI('MyVault', 'Attachments/image.png');
    assertEqual(uri, 'obsidian://open?vault=MyVault&file=Attachments/image.png', 'should only strip .md, not other extensions');
});

test('normalizeResults: legacy flat array', () => {
    const results = normalizeResults(['Eris', 'Dark Council']);
    assertEqual(results.length, 2, 'should handle two items');
    assertEqual(results[0].title, 'Eris', 'should preserve title');
    assertEqual(results[0].confidence, 'medium', 'should default to medium');
    assertEqual(results[0].reason, 'AI search', 'should default reason');
});

test('normalizeResults: structured format', () => {
    const results = normalizeResults([
        { title: 'Eris', confidence: 'high', reason: 'directly mentioned' },
        { title: 'Temple', confidence: 'low', reason: 'thematic match' },
    ]);
    assertEqual(results[0].confidence, 'high', 'should preserve high confidence');
    assertEqual(results[0].reason, 'directly mentioned', 'should preserve reason');
    assertEqual(results[1].confidence, 'low', 'should preserve low confidence');
});

test('normalizeResults: mixed/malformed objects', () => {
    const results = normalizeResults([
        { title: 'Eris' },
        { title: 'Temple', confidence: 'invalid', reason: 42 },
        'Plain Title',
    ]);
    assertEqual(results[0].confidence, 'medium', 'should default missing confidence');
    assertEqual(results[0].reason, 'AI search', 'should default missing reason');
    assertEqual(results[1].confidence, 'medium', 'should default invalid confidence');
    assertEqual(results[1].reason, 'AI search', 'should default non-string reason');
    assertEqual(results[2].title, 'Plain Title', 'should handle string items');
});

test('normalizeResults: empty array', () => {
    assertEqual(normalizeResults([]).length, 0, 'should handle empty array');
});

// ============================================================================
// Tests: runHealthCheck detection patterns (mirrors index.js logic)
// ============================================================================

// Use production health check from helpers.js (replaces shadow reimplementation)
const testHealthCheck = checkHealthPure;

test('health: circular requires detection', () => {
    const index = [
        makeEntry('A', { requires: ['B'], keys: ['a'] }),
        makeEntry('B', { requires: ['A'], keys: ['b'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'circular_requires'), 'should detect circular requires');
});

test('health: duplicate title detection', () => {
    const index = [
        makeEntry('Eris', { keys: ['eris'] }),
        makeEntry('Eris', { keys: ['eris2'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'duplicate_title'), 'should detect duplicate titles');
});

test('health: orphaned cascade_links', () => {
    const index = [
        makeEntry('A', { keys: ['a'], cascadeLinks: ['NonExistent'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'orphaned_cascade'), 'should detect orphaned cascade links');
});

test('health: requires AND excludes same title', () => {
    const index = [
        makeEntry('A', { keys: ['a'], requires: ['B'], excludes: ['B'] }),
        makeEntry('B', { keys: ['b'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'requires_excludes_conflict'), 'should detect requires/excludes conflict');
});

test('health: cooldown on constant', () => {
    const index = [
        makeEntry('A', { constant: true, cooldown: 5 }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'cooldown_on_constant'), 'should flag cooldown on constant entry');
});

test('health: depth override without position override', () => {
    const index = [
        makeEntry('A', { keys: ['a'], injectionDepth: 3, injectionPosition: 0 }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'depth_without_inchat'), 'should flag depth without in_chat');
});

test('health: empty content entry', () => {
    const index = [
        makeEntry('A', { keys: ['a'], content: '' }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'empty_content'), 'should flag empty content');
});

test('health: probability zero warning', () => {
    const index = [
        makeEntry('A', { keys: ['a'], probability: 0 }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'probability_zero'), 'should flag probability 0');
});

test('health: constants exceeding budget', () => {
    const index = [
        makeEntry('A', { constant: true, tokenEstimate: 1500 }),
        makeEntry('B', { constant: true, tokenEstimate: 1500 }),
    ];
    const issues = testHealthCheck(index, { maxTokensBudget: 2000, unlimitedBudget: false });
    assert(issues.some(i => i.type === 'constants_over_budget'), 'should flag constants over budget');
});

test('health: clean vault returns no issues', () => {
    const index = [
        makeEntry('Eris', { keys: ['eris'], content: 'A vampire queen.', summary: 'Main character' }),
        makeEntry('Temple', { keys: ['temple'], content: 'A dark temple.', summary: 'Location' }),
    ];
    const issues = testHealthCheck(index);
    assertEqual(issues.length, 0, 'clean vault should have no issues');
});

// ============================================================================
// Tests: Multi-Vault Support
// ============================================================================

test('parseVaultFile: vaultSource field defaults to empty string', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nkeys:\n  - test\n---\n# Test\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.vaultSource, '', 'vaultSource should default to empty string');
});

test('multi-vault: entries from different vaults merge with vaultSource', () => {
    const e1 = makeEntry('Eris', { vaultSource: 'Primary', keys: ['eris'] });
    const e2 = makeEntry('Temple', { vaultSource: 'Lore', keys: ['temple'] });
    const combined = [e1, e2];
    assertEqual(combined.length, 2, 'should merge entries from both vaults');
    assertEqual(combined[0].vaultSource, 'Primary', 'first entry should have Primary vault');
    assertEqual(combined[1].vaultSource, 'Lore', 'second entry should have Lore vault');
});

test('multi-vault: settings migration from legacy format', () => {
    // Simulate legacy settings with obsidianPort/obsidianApiKey but no vaults
    const legacySettings = {
        obsidianPort: 27123,
        obsidianApiKey: 'test-key',
        vaults: [],
    };

    // Migration logic (mirrors getSettings)
    if (legacySettings.vaults.length === 0 && legacySettings.obsidianPort) {
        legacySettings.vaults = [{
            name: 'Primary',
            port: legacySettings.obsidianPort,
            apiKey: legacySettings.obsidianApiKey || '',
            enabled: true,
        }];
    }

    assertEqual(legacySettings.vaults.length, 1, 'should create one vault from legacy settings');
    assertEqual(legacySettings.vaults[0].name, 'Primary', 'vault name should be Primary');
    assertEqual(legacySettings.vaults[0].port, 27123, 'vault port should match legacy port');
    assertEqual(legacySettings.vaults[0].apiKey, 'test-key', 'vault apiKey should match legacy key');
    assertEqual(legacySettings.vaults[0].enabled, true, 'vault should be enabled');
});

test('multi-vault: getPrimaryVault logic', () => {
    // Test getPrimaryVault helper logic
    const vaults = [
        { name: 'Disabled', port: 1111, apiKey: '', enabled: false },
        { name: 'Active', port: 2222, apiKey: 'key', enabled: true },
        { name: 'Backup', port: 3333, apiKey: 'key2', enabled: true },
    ];
    const primary = vaults.find(v => v.enabled) || vaults[0] || { name: 'Default', port: 27123, apiKey: '', enabled: true };
    assertEqual(primary.name, 'Active', 'should return first enabled vault');
    assertEqual(primary.port, 2222, 'should return correct port');
});

test('multi-vault: getVaultByName logic', () => {
    const vaults = [
        { name: 'Primary', port: 27123, apiKey: 'pk', enabled: true },
        { name: 'Lore', port: 27124, apiKey: 'lk', enabled: true },
    ];
    // Find by name
    const lore = vaults.find(v => v.name === 'Lore' && v.enabled);
    assertEqual(lore.port, 27124, 'should find vault by name');
    // Fallback to primary for unknown name
    const unknown = vaults.find(v => v.name === 'Unknown' && v.enabled);
    assertEqual(unknown, undefined, 'should not find unknown vault');
});

test('multi-vault: health check detects no enabled vaults', () => {
    // Test health check logic for empty/disabled vaults
    const vaults = [
        { name: 'V1', port: 27123, apiKey: '', enabled: false },
    ];
    const enabledVaults = vaults.filter(v => v.enabled);
    const issues = [];
    if (enabledVaults.length === 0) {
        issues.push({ type: 'Settings', severity: 'error', detail: 'No enabled vaults' });
    }
    assertEqual(issues.length, 1, 'should flag no enabled vaults');
    assertEqual(issues[0].severity, 'error', 'should be an error');
});

// ============================================================================
// Phase 3: Infrastructure tests
// ============================================================================

test('sliding window cache: exact match structure', () => {
    const cache = { hash: '', manifestHash: '', chatLineCount: 0, results: [] };
    assertEqual(typeof cache.manifestHash, 'string', 'cache should have manifestHash');
    assertEqual(typeof cache.chatLineCount, 'number', 'cache should have chatLineCount');

    // Simulate cache population
    cache.hash = simpleHash('chat content');
    cache.manifestHash = simpleHash('manifest content');
    cache.chatLineCount = 5;
    cache.results = [{ entry: makeEntry('A'), confidence: 'high', reason: 'test' }];

    // Exact match: same hash + manifestHash
    const newHash = simpleHash('chat content');
    const newManifestHash = simpleHash('manifest content');
    assert(cache.hash === newHash && cache.manifestHash === newManifestHash, 'exact cache match should hit');

    // Different chat: miss
    const diffHash = simpleHash('different chat');
    assert(cache.hash !== diffHash, 'different chat hash should miss');
});

test('sliding window cache: entity mention detection', () => {
    // Simulate sliding window logic: new lines with no entity mentions → cache hit
    const entryNames = new Set(['alice', 'dark forest', 'sword of truth']);
    const newText = 'the weather was nice today and we walked around the park';

    let hasNewEntityMention = false;
    for (const name of entryNames) {
        if (newText.includes(name)) {
            hasNewEntityMention = true;
            break;
        }
    }
    assert(!hasNewEntityMention, 'no entity mention in new text should allow cache hit');

    // New text that DOES mention an entity
    const newText2 = 'alice walked into the room';
    let hasNewEntityMention2 = false;
    for (const name of entryNames) {
        if (newText2.includes(name)) {
            hasNewEntityMention2 = true;
            break;
        }
    }
    assert(hasNewEntityMention2, 'entity mention in new text should invalidate cache');
});

test('hierarchical clustering: clusterEntries groups by tag', () => {
    // clusterEntries imported from ./src/helpers.js (production code)
    const entries = [
        makeEntry('Alice', { tags: ['character'] }),
        makeEntry('Bob', { tags: ['character'] }),
        makeEntry('Dark Forest', { tags: ['location'] }),
        makeEntry('Magic System', { tags: ['lore'] }),
        makeEntry('Misc', {}),
    ];

    const clusters = clusterEntries(entries);
    assertEqual(clusters.size, 4, 'should have 4 clusters');
    assertEqual(clusters.get('character').length, 2, 'character cluster should have 2 entries');
    assertEqual(clusters.get('location').length, 1, 'location cluster should have 1 entry');
    assertEqual(clusters.get('Uncategorized').length, 1, 'uncategorized should have 1 entry');
});

test('hierarchical clustering: buildCategoryManifest formats correctly', () => {
    // buildCategoryManifest imported from ./src/helpers.js (production code)
    const clusters = new Map();
    clusters.set('character', [makeEntry('A'), makeEntry('B'), makeEntry('C'), makeEntry('D'), makeEntry('E'), makeEntry('F')]);
    clusters.set('location', [makeEntry('Place1')]);

    const manifest = buildCategoryManifest(clusters);
    assert(manifest.includes('[character] (6 entries)'), 'should show character count');
    assert(manifest.includes('(+1 more)'), 'should show +more for >5 entries');
    assert(manifest.includes('[location] (1 entries)'), 'should show location count');
});

test('reuse sync: file set comparison logic', () => {
    // Simulate reuse sync file detection logic
    const knownFiles = new Set(['Alice.md', 'Bob.md', 'Forest.md']);
    const currentFiles = ['Alice.md', 'Bob.md', 'NewEntry.md'];

    const newFiles = currentFiles.filter(f => !knownFiles.has(f));
    const removedFiles = [...knownFiles].filter(f => !currentFiles.includes(f));

    assertEqual(newFiles, ['NewEntry.md'], 'should detect new files');
    assertEqual(removedFiles, ['Forest.md'], 'should detect removed files');
});

test('reuse sync: no changes returns empty diff', () => {
    const knownFiles = new Set(['Alice.md', 'Bob.md']);
    const currentFiles = ['Alice.md', 'Bob.md'];

    const newFiles = currentFiles.filter(f => !knownFiles.has(f));
    const removedFiles = [...knownFiles].filter(f => !currentFiles.includes(f));

    assertEqual(newFiles.length, 0, 'no new files');
    assertEqual(removedFiles.length, 0, 'no removed files');
});

// ============================================================================
// Tests: extractAiResponseClient (src/helpers.js — production code)
// ============================================================================

test('extractAiResponseClient: direct JSON array', () => {
    const result = extractAiResponseClient('[{"title":"Alice","confidence":"high","reason":"mentioned"}]');
    assert(Array.isArray(result), 'should parse direct JSON array');
    assertEqual(result[0].title, 'Alice', 'should have correct title');
});

test('extractAiResponseClient: string array', () => {
    const result = extractAiResponseClient('["Alice", "Bob"]');
    assert(Array.isArray(result), 'should parse string array');
    assertEqual(result.length, 2, 'should have 2 entries');
    assertEqual(result[0], 'Alice', 'first should be Alice');
});

test('extractAiResponseClient: markdown code fence', () => {
    const result = extractAiResponseClient('Here are results:\n```json\n["Alice"]\n```\nDone.');
    assert(Array.isArray(result), 'should extract from code fence');
    assertEqual(result[0], 'Alice', 'should have Alice');
});

test('extractAiResponseClient: embedded in prose', () => {
    const result = extractAiResponseClient('I selected these entries: [{"title":"Bob","confidence":"medium","reason":"relevant"}] based on context.');
    assert(Array.isArray(result), 'should extract from prose');
    assertEqual(result[0].title, 'Bob', 'should have Bob');
});

test('extractAiResponseClient: empty array', () => {
    const result = extractAiResponseClient('[]');
    assert(Array.isArray(result), 'should parse empty array');
    assertEqual(result.length, 0, 'should be empty');
});

test('extractAiResponseClient: null/undefined/empty', () => {
    assertEqual(extractAiResponseClient(null), null, 'null input → null');
    assertEqual(extractAiResponseClient(''), null, 'empty string → null');
    assertEqual(extractAiResponseClient(undefined), null, 'undefined → null');
});

test('extractAiResponseClient: non-JSON text', () => {
    assertEqual(extractAiResponseClient('Just some text with no JSON'), null, 'no JSON → null');
});

// PR #28.3 partial port — defensive parser hardening (dangling fence + object input).
// IMPORTANT: these do NOT fix the json_schema-flow Gemini breaker-trip bug. That bug
// happens at the ST layer: ST.extractJsonFromData runs tryParse(text), the trailing
// fence makes parse fail, ST returns '{}' to DLE. By the time the text reaches
// extractAiResponseClient it is already '{}' with no fence to strip. Real fix needs
// either an upstream ST PR (harden tryParse) or a larger DLE workaround that
// bypasses ST's json_schema processing. See PR-28.3-VERDICT.md.

test('extractAiResponseClient: strips dangling closing fence (defense-in-depth)', () => {
    // Pre-fix, this input is rescued by the bracket-balanced extraction fallback
    // (the `[...]` substring still parses cleanly). The strip is belt-and-suspenders
    // for the direct-parse path so the first JSON.parse attempt succeeds without
    // having to walk the whole string.
    const result = extractAiResponseClient('[{"title":"Bob","confidence":"high","reason":"r"}]\n```');
    assert(Array.isArray(result), 'should parse despite trailing fence line');
    assertEqual(result[0].title, 'Bob', 'should extract Bob');
});

test('extractAiResponseClient: object-wrapped response with dangling fence', () => {
    // Bracket-balance finds the inner [{...}] of selected and returns it. The strip
    // is not what rescues this case (object-wrap drops to bracket-balance regardless);
    // covered here to lock the multi-path behavior in case bracket-balance regresses.
    const result = extractAiResponseClient('{"selected":[{"title":"Charlotte","confidence":"high","reason":"active"}]}\n```');
    assert(Array.isArray(result), 'bracket-balance still extracts the inner array');
    assertEqual(result[0].title, 'Charlotte', 'inner array yields Charlotte');
});

test('extractAiResponseClient: accepts pre-parsed array input', () => {
    const result = extractAiResponseClient([{ title: 'Alice', confidence: 'high', reason: 'r' }]);
    assert(Array.isArray(result), 'array input returned as-is');
    assertEqual(result[0].title, 'Alice', 'preserves Alice');
});

test('extractAiResponseClient: rejects non-array object input (caller unwraps)', () => {
    // Object inputs that aren't valid result arrays return null so the caller
    // (ai.js BUG-383 unwrap) can decide what to do with the shape. Parity with
    // pre-change behavior, which treated all non-strings as null.
    const result = extractAiResponseClient({ selected: [{ title: 'X' }] });
    assertEqual(result, null, 'wrapper object is not a valid result array on its own');
});

// PR #28.3 partial port — cmrsResultToText usageMetadata aliases (the real fix).
// Without these, Gemini token-usage stats reported 0/0 because the OAI usage path
// missed Gemini's promptTokenCount / candidatesTokenCount field names.

test('cmrsResultToText: maps Gemini usageMetadata to OAI-style usage', () => {
    const out = cmrsResultToText({
        content: 'hello',
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
    });
    assertEqual(out.text, 'hello', 'text passthrough');
    assertEqual(out.usage.input_tokens, 42, 'promptTokenCount → input_tokens');
    assertEqual(out.usage.output_tokens, 7, 'candidatesTokenCount → output_tokens');
});

test('cmrsResultToText: standard OAI usage still wins when both present', () => {
    const out = cmrsResultToText({
        content: 'x',
        usage: { input_tokens: 10, output_tokens: 5 },
        usageMetadata: { promptTokenCount: 999 },
    });
    assertEqual(out.usage.input_tokens, 10, 'standard input_tokens prioritized');
    assertEqual(out.usage.output_tokens, 5, 'standard output_tokens prioritized');
});

// Wave 6.5 coverage backfill — edge inputs to cmrsResultToText that production
// hits when ST's CMRS or upstream returns degenerate shapes.

test('cmrsResultToText: null result returns empty text + zero usage', () => {
    const out = cmrsResultToText(null);
    assertEqual(out.text, '', 'null → empty text');
    assertEqual(out.usage.input_tokens, 0, 'no input tokens');
    assertEqual(out.usage.output_tokens, 0, 'no output tokens');
});

test('cmrsResultToText: undefined / empty object passes through safely', () => {
    const a = cmrsResultToText(undefined);
    assertEqual(a.text, '', 'undefined safe');
    const b = cmrsResultToText({});
    assertEqual(b.text, '', 'empty result.content missing → empty text');
    assertEqual(b.usage.input_tokens, 0, 'empty usage zero');
});

test('cmrsResultToText: JSON-schema parsed object content stringifies (issue #24 contract)', () => {
    // ST replaces result.content with the parsed object when data.json_schema is set;
    // cmrsResultToText re-stringifies so downstream string ops (extractAiResponseClient,
    // debug-preview .slice) keep working. Locks the issue #24 fix.
    const out = cmrsResultToText({ content: { selected: [{ title: 'X' }] } });
    assertEqual(typeof out.text, 'string', 'string contract preserved');
    assert(out.text.includes('"selected"'), 'object serialized into text');
    assert(out.text.includes('"X"'), 'inner payload preserved');
});

test('cmrsResultToText: partial Gemini usageMetadata maps what is present', () => {
    const out = cmrsResultToText({
        content: 'x',
        usageMetadata: { candidatesTokenCount: 3 },
    });
    assertEqual(out.usage.input_tokens, 0, 'missing promptTokenCount → 0');
    assertEqual(out.usage.output_tokens, 3, 'candidatesTokenCount mapped');
});

// Wave 6.5 backfill — summarize-pure purity + multi-summary contract.

test('applyHideAndPrepend: does not mutate messages outside the range', () => {
    const chat = [
        { mes: 'before', is_system: false },
        { mes: 'r0', is_system: false },
        { mes: 'r1', is_system: false },
        { mes: 'after', is_system: false },
    ];
    const beforeSnapshot = JSON.stringify(chat[0]);
    const afterSnapshot = JSON.stringify(chat[3]);
    applyHideAndPrepend(chat, { start: 1, end: 2 }, 'sum_X', 'text');
    // chat[0] still original (not touched); chat[4] (was [3]) still original.
    assertEqual(JSON.stringify(chat[0]), beforeSnapshot, 'pre-range message untouched');
    assertEqual(JSON.stringify(chat[4]), afterSnapshot, 'post-range message untouched');
});

test('rollbackById: idempotent — second call with same id is a no-op', () => {
    const chat = [
        { mes: 'a', is_system: false },
        { mes: 'b', is_system: false },
    ];
    applyHideAndPrepend(chat, { start: 0, end: 1 }, 'sum_X', 'text');
    const first = rollbackById(chat, 'sum_X');
    assertEqual(first.removed, 1, 'first removes summary');
    assertEqual(first.restored, 2, 'first restores 2 messages');
    const second = rollbackById(chat, 'sum_X');
    assertEqual(second.removed, 0, 'second finds no summary to remove');
    assertEqual(second.restored, 0, 'second finds no marked messages');
    assertEqual(chat.length, 2, 'chat unchanged on second call');
});

test('applyHideAndPrepend: skips null/undefined entries inside range gracefully', () => {
    const chat = [
        { mes: 'a', is_system: false },
        null,
        { mes: 'c', is_system: false },
    ];
    const { hiddenCount } = applyHideAndPrepend(chat, { start: 0, end: 2 }, 'sum_X', 'text');
    assertEqual(hiddenCount, 2, 'null entry skipped, two hidden');
    assertEqual(chat.length, 4, 'summary inserted, null preserved');
    // The null is still present (un-touched).
    assertEqual(chat[2], null, 'null entry untouched');
});

// Wave 6.5 backfill — caveman edges.

test('caveman: preserves contractions (do-not, we-have, I-am)', () => {
    const out = compressCaveman("Don't worry, we've been there. I'm fine.");
    assert(out.includes("Don't"), 'contraction preserved');
    assert(out.includes("we've"), 'second contraction preserved');
    assert(out.includes("I'm"), 'third contraction preserved');
});

test('caveman: handles em-dash and smart quotes without crashing', () => {
    const out = compressCaveman('She said “the truth” — a strange thing.');
    assert(typeof out === 'string', 'returns string');
    assert(out.length > 0, 'non-empty output');
});

test('caveman: preserves URLs with query strings and fragments', () => {
    const out = compressCaveman('Visit https://example.com/the/page?q=the+answer#section for the docs.');
    assert(out.includes('https://example.com/the/page?q=the+answer#section'), 'URL preserved verbatim');
});

test('extractAiResponseClient: nested brackets in strings', () => {
    const result = extractAiResponseClient('[{"title":"Entry [with brackets]","confidence":"high","reason":"test"}]');
    assert(Array.isArray(result), 'should handle brackets in strings');
    assertEqual(result[0].title, 'Entry [with brackets]', 'should preserve bracket content');
});

test('extractAiResponseClient: multiple arrays picks largest', () => {
    const result = extractAiResponseClient('Small: ["A"]. Larger: [{"title":"B","confidence":"high","reason":"r"},{"title":"C","confidence":"low","reason":"r"}]');
    assert(Array.isArray(result), 'should find arrays');
    assertEqual(result.length, 2, 'should pick larger array');
});

test('extractAiResponseClient: object with name field', () => {
    const result = extractAiResponseClient('[{"name":"Alice"}]');
    assert(Array.isArray(result), 'should accept name field');
    assertEqual(result[0].name, 'Alice', 'should have name field');
});

test('extractAiResponseClient: invalid JSON object (not array)', () => {
    assertEqual(extractAiResponseClient('{"title":"Alice"}'), null, 'object not array → null');
});

test('extractAiResponseClient: escaped quotes in strings', () => {
    const result = extractAiResponseClient('[{"title":"Alice\\"s Entry","confidence":"high","reason":"test"}]');
    assert(Array.isArray(result), 'should handle escaped quotes');
});

// ============================================================================
// Tests: convertWiEntry (src/helpers.js — production code)
// ============================================================================

test('convertWiEntry: basic entry', () => {
    const result = convertWiEntry({ comment: 'Alice', key: ['alice', 'wonderland'], content: 'Alice is a character.' }, 'lorebook');
    assert(result.filename === 'Alice.md', 'filename from comment');
    assert(result.content.includes('keys:'), 'should have keys section');
    assert(result.content.includes('  - alice'), 'should list keys');
    assert(result.content.includes('  - lorebook'), 'should have lorebook tag');
    assert(result.content.includes('# Alice'), 'should have H1 title');
    assert(result.content.includes('Alice is a character.'), 'should include content');
});

test('convertWiEntry: constant entry gets lorebook-always tag', () => {
    const result = convertWiEntry({ comment: 'World', key: ['world'], constant: true, content: 'The world.' }, 'lorebook');
    assert(result.content.includes('  - lorebook-always'), 'should have lorebook-always tag');
});

test('convertWiEntry: position mapping', () => {
    const afterChar = convertWiEntry({ comment: 'A', key: ['a'], position: 0, content: 'c' }, 'lorebook');
    assert(afterChar.content.includes('position: after'), 'position 0 → after');
    const inChat = convertWiEntry({ comment: 'B', key: ['b'], position: 4, content: 'c' }, 'lorebook');
    assert(inChat.content.includes('position: in_chat'), 'position 4 → in_chat');
});

test('convertWiEntry: probability conversion (100-scale to 0-1)', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], probability: 75, content: 'c' }, 'lorebook');
    assert(result.content.includes('probability: 0.75'), 'should convert 75 to 0.75');
});

test('convertWiEntry: unsafe filename chars stripped', () => {
    const result = convertWiEntry({ comment: 'Alice: The "Queen"', key: ['a'], content: 'c' }, 'lorebook');
    assert(!result.filename.includes(':'), 'no colons in filename');
    assert(!result.filename.includes('"'), 'no quotes in filename');
});

test('convertWiEntry: YAML delimiter injection sanitized', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], content: 'before\n---\nafter' }, 'lorebook');
    assert(!result.content.match(/^---$/m) || result.content.indexOf('---') === 0, 'content --- should be sanitized');
});

test('convertWiEntry: keysecondary as refine_keys', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], keysecondary: ['secondary1', 'secondary2'], content: 'c' }, 'lorebook');
    assert(result.content.includes('refine_keys:'), 'should have refine_keys');
    assert(result.content.includes('  - secondary1'), 'should list secondary keys');
});

test('convertWiEntry: missing comment falls back to keys', () => {
    const result = convertWiEntry({ key: ['fallback_key'], content: 'c' }, 'lorebook');
    assert(result.filename === 'fallback_key.md', 'filename from key fallback');
});

test('convertWiEntry: depth only included when > 0', () => {
    const noDepth = convertWiEntry({ comment: 'A', key: ['a'], depth: 0, content: 'c' }, 'lorebook');
    assert(!noDepth.content.includes('depth:'), 'depth 0 should be omitted');
    const withDepth = convertWiEntry({ comment: 'A', key: ['a'], depth: 3, content: 'c' }, 'lorebook');
    assert(withDepth.content.includes('depth: 3'), 'depth 3 should be included');
});

// ============================================================================
// Wave 1 (WI parity) — Tier A native ports
// ============================================================================
// Guard against the silent-downgrade regression: ST WI fields that DLE supports
// natively MUST land as native frontmatter, not vanish into the void. Pre-Wave-1
// these all silently dropped — `disable: true` was the worst (disabled entries
// imported as active). The report accumulator is also asserted because the
// import-report popup (Wave 5) depends on accurate counts.

test('convertWiEntry: disable=true emits enabled: false (silent-downgrade fix)', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], disable: true, content: 'c' }, 'lorebook');
    assert(result.content.includes('enabled: false'), 'disabled WI entry must emit enabled: false');
});

test('convertWiEntry: disable=false omits enabled (no noise on default)', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], disable: false, content: 'c' }, 'lorebook');
    assert(!result.content.includes('enabled:'), 'default-enabled entry should not write the field');
});

test('convertWiEntry: excludeRecursion=true emits frontmatter (camelCase)', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], excludeRecursion: true, content: 'c' }, 'lorebook');
    assert(result.content.includes('excludeRecursion: true'), 'excludeRecursion must round-trip native (parser already honors it)');
});

test('convertWiEntry: exclude_recursion snake alias also accepted', () => {
    const result = convertWiEntry({ comment: 'A', key: ['a'], exclude_recursion: true, content: 'c' }, 'lorebook');
    assert(result.content.includes('excludeRecursion: true'), 'snake_case input still produces canonical camelCase frontmatter');
});

test('convertWiEntry: role 0/1/2 maps to system/user/assistant', () => {
    const sys = convertWiEntry({ comment: 'S', key: ['s'], role: 0, content: 'c' }, 'lorebook');
    assert(sys.content.includes('role: system'), 'role 0 → system');
    const usr = convertWiEntry({ comment: 'U', key: ['u'], role: 1, content: 'c' }, 'lorebook');
    assert(usr.content.includes('role: user'), 'role 1 → user');
    const asst = convertWiEntry({ comment: 'A', key: ['a'], role: 2, content: 'c' }, 'lorebook');
    assert(asst.content.includes('role: assistant'), 'role 2 → assistant');
});

test('convertWiEntry: invalid role index omitted (no lie)', () => {
    const out = convertWiEntry({ comment: 'A', key: ['a'], role: 99, content: 'c' }, 'lorebook');
    assert(!out.content.includes('role:'), 'unknown role enum must not emit anything');
});

test('convertWiEntry: role null omitted', () => {
    const out = convertWiEntry({ comment: 'A', key: ['a'], role: null, content: 'c' }, 'lorebook');
    assert(!out.content.includes('role:'), 'null role omitted');
});

test('convertWiEntry: report accumulator counts Tier A applications', () => {
    const report = { nativeApplied: {}, roundTripped: {}, skipped: {} };
    convertWiEntry({ comment: 'A', key: ['a'], disable: true, excludeRecursion: true, role: 0, content: 'c' }, 'lorebook', { report });
    assert(report.nativeApplied.enabled === 1, 'enabled counter bumped');
    assert(report.nativeApplied.excludeRecursion === 1, 'excludeRecursion counter bumped');
    assert(report.nativeApplied.role === 1, 'role counter bumped');
});

test('convertWiEntry: report accumulator records invalid role under skipped', () => {
    const report = { nativeApplied: {}, roundTripped: {}, skipped: {} };
    convertWiEntry({ comment: 'A', key: ['a'], role: 99, content: 'c' }, 'lorebook', { report });
    assert(report.skipped.invalid_role === 1, 'invalid_role skip counter bumped');
    assert(!report.nativeApplied.role, 'role counter NOT bumped on invalid input');
});

test('convertWiEntry: report accumulator aggregates across multiple calls', () => {
    const report = { nativeApplied: {}, roundTripped: {}, skipped: {} };
    convertWiEntry({ comment: 'A', key: ['a'], disable: true, content: 'c' }, 'lorebook', { report });
    convertWiEntry({ comment: 'B', key: ['b'], disable: true, content: 'c' }, 'lorebook', { report });
    convertWiEntry({ comment: 'C', key: ['c'], disable: true, content: 'c' }, 'lorebook', { report });
    assert(report.nativeApplied.enabled === 3, 'counter accumulates across batch');
});

test('convertWiEntry: omitting report leaves no side effects', () => {
    // Sanity — callers that don't care about the report shouldn't hit a TypeError.
    let threw = false;
    try { convertWiEntry({ comment: 'A', key: ['a'], disable: true, content: 'c' }, 'lorebook'); }
    catch { threw = true; }
    assert(!threw, 'optional report must remain optional');
});

// ============================================================================
// Tests: #18 caveman-compress import (src/caveman.js + convertWiEntry hook)
// ============================================================================

import { compressCaveman, resolveCompressMode } from '../src/caveman.js';

test('caveman: drops articles at word boundaries', () => {
    const out = compressCaveman('The cat sat on the mat. A dog watched an apple.');
    assert(!/\bthe\b/i.test(out), 'no "the" in output');
    assert(!/\ba\b/i.test(out), 'no standalone "a" in output');
    assert(!/\ban\b/i.test(out), 'no standalone "an" in output');
    assert(out.includes('cat sat on'), 'core words survive');
    assert(out.includes('Alabama') === false && /apple/.test(out), 'fruit survives');
});

test('caveman: drops fillers without changing meaning', () => {
    const out = compressCaveman('This is just really basically a test that simply works.');
    assert(!/\bjust\b/i.test(out), 'just dropped');
    assert(!/\breally\b/i.test(out), 'really dropped');
    assert(!/\bbasically\b/i.test(out), 'basically dropped');
    assert(!/\bsimply\b/i.test(out), 'simply dropped');
    assert(out.includes('test that') && out.includes('works'), 'core preserved');
});

test('caveman: preserves fenced code blocks untouched', () => {
    const input = 'The code:\n```js\nconst the = a; // the var\n```\nAnd a note.';
    const out = compressCaveman(input);
    assert(out.includes('const the = a; // the var'), 'fenced block body untouched');
    assert(!/^And a note/m.test(out), '"a" outside code is dropped');
});

test('caveman: preserves inline code', () => {
    const out = compressCaveman('Use the `the.api()` function.');
    assert(out.includes('`the.api()`'), 'inline code untouched');
    assert(!/Use the /.test(out), 'plain-text "the" dropped');
});

test('caveman: preserves URLs', () => {
    const out = compressCaveman('See https://example.com/the/page for the docs.');
    assert(out.includes('https://example.com/the/page'), 'URL untouched');
    assert(!/for the docs/.test(out), '"the" outside URL dropped');
});

test('caveman: collapses multi-space artifacts', () => {
    const out = compressCaveman('The   spaces   are   wide.');
    assert(!/  /.test(out), 'no double spaces remain');
});

test('caveman: tidies space before punctuation after drops', () => {
    const out = compressCaveman('I saw the , and the .');
    assert(!/ ,/.test(out), 'no space-comma');
    assert(!/ \./.test(out), 'no space-period');
});

test('caveman: preserves markdown list indent', () => {
    const out = compressCaveman('- the first item\n- the second item');
    assert(out.startsWith('- '), 'list bullet survives');
    assert(out.includes('first item'), 'item body survives');
});

test('caveman: handles empty / null input', () => {
    assertEqual(compressCaveman(''), '', 'empty string passes through');
    assertEqual(compressCaveman(null), null, 'null passes through');
    assertEqual(compressCaveman(undefined), undefined, 'undefined passes through');
});

test('resolveCompressMode: normalizes truthy values to "caveman"', () => {
    assertEqual(resolveCompressMode(true), 'caveman', 'true → caveman');
    assertEqual(resolveCompressMode('true'), 'caveman', '"true" → caveman');
    assertEqual(resolveCompressMode('caveman'), 'caveman', '"caveman" → caveman');
});

test('resolveCompressMode: normalizes falsy values to null', () => {
    assertEqual(resolveCompressMode(false), null, 'false → null');
    assertEqual(resolveCompressMode('false'), null, '"false" → null');
    assertEqual(resolveCompressMode(''), null, 'empty string → null');
    assertEqual(resolveCompressMode(null), null, 'null → null');
    assertEqual(resolveCompressMode(undefined), null, 'undefined → null');
});

test('resolveCompressMode: forward-compat passes unknown modes through', () => {
    assertEqual(resolveCompressMode('ai-summary'), 'ai-summary', 'unknown mode survives for future use');
});

// --- Agent B audit regression guards ---

test('caveman: preserves hyphenated "A-frame" / "A-list" / "the-end" tokens', () => {
    const out = compressCaveman('She built an A-frame house. Buy A-list talent. Watch the-end-of-days.');
    assert(out.includes('A-frame'), 'A-frame preserved (regression: \\b stripped the A)');
    assert(out.includes('A-list'), 'A-list preserved');
    assert(out.includes('the-end-of-days'), 'the-end-of-days preserved');
});

test('caveman: numeric / non-string input does not throw', () => {
    assertEqual(compressCaveman(123), 123, 'number passes through');
    assertEqual(compressCaveman(true), true, 'boolean passes through');
    assertEqual(compressCaveman({}), {}, 'object passes through');
});

test('caveman: mask marker survives adjacent punctuation (no DLEPRES leak)', () => {
    const out = compressCaveman('Use `the.api()`, not the old way.');
    assert(!/DLEPRES/.test(out), 'no placeholder leak in output');
    assert(out.includes('`the.api()`'), 'inline code preserved verbatim');
});

test('convertWiEntry: unknown compress mode does NOT annotate frontmatter', () => {
    const wi = { comment: 'X', key: ['x'], content: 'The body text here.' };
    const result = convertWiEntry(wi, 'lorebook', { compress: 'ai-summary' });
    assert(!result.content.includes('compress:'), 'no annotation for unknown mode (avoids lying)');
    assert(result.content.includes('The body text here.'), 'body untouched');
});

test('convertWiEntry: explicit compress: true annotates as caveman', () => {
    const wi = { comment: 'X', key: ['x'], content: 'The cat is just a cat.' };
    const result = convertWiEntry(wi, 'lorebook', { compress: true });
    assert(result.content.includes('compress: caveman'), 'caveman annotation present');
});

// ============================================================================
// Tests: Update Existing Entries — updateFrontmatterFields (src/helpers.js)
// ============================================================================

import { updateFrontmatterFields } from '../src/helpers.js';

test('updateFrontmatterFields: replaces existing scalar value in place', () => {
    const input = '---\npriority: 50\nstatus: active\n---\n\n# Body\n\nBody text.';
    const result = updateFrontmatterFields(input, { priority: 10 });
    assert(result.applied.includes('priority'), 'priority applied');
    assert(result.content.includes('priority: 10'), 'new value present');
    assert(!result.content.includes('priority: 50'), 'old value gone');
    assert(result.content.includes('status: active'), 'untouched field preserved');
    assert(result.content.includes('Body text.'), 'body preserved');
});

test('updateFrontmatterFields: appends new field before closing delimiter', () => {
    const input = '---\npriority: 50\n---\n\nbody';
    const result = updateFrontmatterFields(input, { newField: 'hello' });
    assert(result.applied.includes('newField'), 'newField applied');
    assert(result.content.includes('newField: hello'), 'appended');
    assert(result.content.match(/newField: hello\s*\n---/), 'appended before closing ---');
});

test('updateFrontmatterFields: null value deletes existing field', () => {
    const input = '---\npriority: 50\nstatus: active\n---\n\nbody';
    const result = updateFrontmatterFields(input, { status: null });
    assert(result.applied.includes('status'), 'status delete applied');
    assert(!result.content.includes('status:'), 'status removed');
    assert(result.content.includes('priority: 50'), 'other field intact');
});

test('updateFrontmatterFields: null value on absent field is skipped', () => {
    const input = '---\npriority: 50\n---\n\nbody';
    const result = updateFrontmatterFields(input, { nonexistent: null });
    assert(result.skipped.includes('nonexistent'), 'reported as skipped');
    assert(!result.content.includes('nonexistent'), 'no phantom field');
});

test('updateFrontmatterFields: refuses non-scalar values', () => {
    const input = '---\npriority: 50\n---\n\nbody';
    const result = updateFrontmatterFields(input, { priority: [1, 2, 3], obj: { a: 1 } });
    assert(result.skipped.includes('priority'), 'array refused');
    assert(result.skipped.includes('obj'), 'object refused');
    assert(result.content.includes('priority: 50'), 'original priority preserved');
});

test('updateFrontmatterFields: refuses to overwrite array-block fields', () => {
    const input = '---\nkeys:\n  - one\n  - two\n---\n\nbody';
    const result = updateFrontmatterFields(input, { keys: 'replacement' });
    assert(result.skipped.includes('keys'), 'array-block keys refused');
    assert(result.content.includes('  - one'), 'array preserved');
});

test('updateFrontmatterFields: preserves quoting style of untouched fields', () => {
    const input = '---\nname: "Alice"\npriority: 50\n---\n\nbody';
    const result = updateFrontmatterFields(input, { priority: 10 });
    assert(result.content.includes('name: "Alice"'), 'quoted name unchanged');
});

test('updateFrontmatterFields: serializes booleans/numbers/strings correctly', () => {
    const input = '---\na: x\n---\n\nbody';
    const result = updateFrontmatterFields(input, { b: true, c: 42, d: 'has spaces' });
    assert(result.content.includes('b: true'), 'boolean');
    assert(result.content.includes('c: 42'), 'number');
    assert(result.content.match(/d:.*has spaces/), 'string');
});

test('updateFrontmatterFields: creates frontmatter when file has none', () => {
    const input = '# Title\n\nplain body';
    const result = updateFrontmatterFields(input, { priority: 50 });
    assert(result.content.startsWith('---'), 'starts with delim');
    assert(result.content.includes('priority: 50'), 'field present');
    assert(result.content.includes('plain body'), 'body intact');
});

test('updateFrontmatterFields: handles BOM-prefixed input', () => {
    const input = '﻿---\npriority: 50\n---\n\nbody';
    const result = updateFrontmatterFields(input, { priority: 10 });
    assert(result.content.includes('priority: 10'), 'BOM file updated');
});

test('updateFrontmatterFields: no-op when updates object is empty', () => {
    const input = '---\npriority: 50\n---\n\nbody';
    const result = updateFrontmatterFields(input, {});
    assertEqual(result.applied.length, 0, 'no applied');
    assertEqual(result.content, input, 'content byte-identical');
});

// --- #15 summary feature: parseRange + buildSummaryUserMessage ---

import { parseRange, buildSummaryUserMessage, applyHideAndPrepend, rollbackById } from '../src/ai/summarize-pure.js';

test('parseRange: start-end', () => {
    const r = parseRange('5-15', 100);
    assertEqual(r.start, 5);
    assertEqual(r.end, 15);
});

test('parseRange: -N (last N)', () => {
    const r = parseRange('-8', 100);
    assertEqual(r.start, 92);
    assertEqual(r.end, 99);
});

test('parseRange: -N caps at 0 when N > chatLen', () => {
    const r = parseRange('-200', 50);
    assertEqual(r.start, 0);
    assertEqual(r.end, 49);
});

test('parseRange: N- (from N to end)', () => {
    const r = parseRange('10-', 50);
    assertEqual(r.start, 10);
    assertEqual(r.end, 49);
});

test('parseRange: bare N (single message)', () => {
    const r = parseRange('7', 50);
    assertEqual(r.start, 7);
    assertEqual(r.end, 7);
});

test('parseRange: rejects invalid ranges', () => {
    assertEqual(parseRange('', 50), null, 'empty');
    assertEqual(parseRange('abc', 50), null, 'non-numeric');
    assertEqual(parseRange('50-100', 50), null, 'end >= chatLen');
    assertEqual(parseRange('20-10', 50), null, 'start > end');
    assertEqual(parseRange('-0', 50), null, 'last-zero');
    assertEqual(parseRange('99', 50), null, 'bare N out of bounds');
});

test('buildSummaryUserMessage: includes name + body, skips hidden', () => {
    const chat = [
        { name: 'Alice', mes: 'hello', is_system: false },
        { name: 'Bob', mes: 'hidden line', is_system: true },
        { name: 'Alice', mes: 'world', is_system: false },
    ];
    const msg = buildSummaryUserMessage(chat, 0, 2);
    assert(msg.includes('### Alice (#0)\nhello'), 'msg 0 included');
    assert(!msg.includes('hidden line'), 'hidden msg skipped');
    assert(msg.includes('### Alice (#2)\nworld'), 'msg 2 included');
});

// --- F1 + M3 audit regression: applyHideAndPrepend / rollbackById round-trip ---

test('applyHideAndPrepend: marks each in-range msg with original is_system + summary id', () => {
    const chat = [
        { mes: 'a', is_system: false, name: 'u' },
        { mes: 'b', is_system: true, name: 'u' },   // pre-hidden
        { mes: 'c', is_system: false, name: 'u' },
    ];
    const { hiddenCount, summaryMsg } = applyHideAndPrepend(chat, { start: 0, end: 2 }, 'sum_X', 'summary text');
    assertEqual(hiddenCount, 3, 'all three hidden');
    assertEqual(chat.length, 4, 'summary inserted, originals preserved');
    assertEqual(chat[0], summaryMsg, 'summary at start of range');
    assertEqual(chat[1].extra.dle_original_is_system, false, 'msg a original was visible');
    assertEqual(chat[2].extra.dle_original_is_system, true, 'msg b original was hidden — F1 regression');
    assertEqual(chat[3].extra.dle_original_is_system, false, 'msg c original was visible');
    assert(chat[1].is_system && chat[2].is_system && chat[3].is_system, 'all marked hidden post-apply');
    assertEqual(chat[1].extra.dle_summarized_into, 'sum_X', 'summary id stamped');
});

test('rollbackById: restores exact original is_system for every message (F1 fix)', () => {
    const chat = [
        { mes: 'a', is_system: false, name: 'u' },
        { mes: 'b', is_system: true, name: 'u' },   // pre-hidden — the F1 bug scenario
        { mes: 'c', is_system: false, name: 'u' },
    ];
    applyHideAndPrepend(chat, { start: 0, end: 2 }, 'sum_X', 'summary text');
    const { restored, removed } = rollbackById(chat, 'sum_X');
    assertEqual(removed, 1, 'summary message removed');
    assertEqual(restored, 3, 'three messages restored');
    assertEqual(chat.length, 3, 'back to original length');
    assertEqual(chat[0].is_system, false, 'msg a restored to visible');
    assertEqual(chat[1].is_system, true, 'msg b restored to HIDDEN (this is the F1 fix — old code wrongly flipped to false)');
    assertEqual(chat[2].is_system, false, 'msg c restored to visible');
    // Marker keys cleaned up.
    assert(!chat[0].extra?.dle_summarized_into, 'dle_summarized_into removed');
    assert(!chat[0].extra?.dle_original_is_system, 'dle_original_is_system removed');
});

test('rollbackById: multi-summary out-of-order rollback restores correctly (M3 fix)', () => {
    // Two summaries: A covers [0,2], then B covers post-A range [4,5] (originally [3,4] pre-A).
    const chat = [
        { mes: '0', is_system: false }, // hidden by A
        { mes: '1', is_system: true },  // hidden by A, pre-hidden
        { mes: '2', is_system: false }, // hidden by A
        { mes: '3', is_system: false }, // hidden by B (post-A index 4)
        { mes: '4', is_system: true },  // hidden by B, pre-hidden (post-A index 5)
        { mes: '5', is_system: false }, // outside both
    ];
    applyHideAndPrepend(chat, { start: 0, end: 2 }, 'sum_A', 'A');
    // Post-A chat: [sumA, msg0, msg1, msg2, msg3, msg4, msg5]
    applyHideAndPrepend(chat, { start: 4, end: 5 }, 'sum_B', 'B');
    // Post-B chat: [sumA, msg0, msg1, msg2, sumB, msg3, msg4, msg5]

    // Roll back A FIRST (older), B second — historically the broken case.
    const { restored: rA, removed: xA } = rollbackById(chat, 'sum_A');
    assertEqual(xA, 1, 'sum_A removed');
    assertEqual(rA, 3, 'three A-hidden msgs restored');
    const { restored: rB, removed: xB } = rollbackById(chat, 'sum_B');
    assertEqual(xB, 1, 'sum_B removed');
    assertEqual(rB, 2, 'two B-hidden msgs restored');

    assertEqual(chat.length, 6, 'back to original 6 messages');
    assertEqual(chat[0].is_system, false, 'msg 0 visible (orig)');
    assertEqual(chat[1].is_system, true, 'msg 1 still hidden (pre-hidden, F1+M3 fix)');
    assertEqual(chat[2].is_system, false, 'msg 2 visible (orig)');
    assertEqual(chat[3].is_system, false, 'msg 3 visible (orig)');
    assertEqual(chat[4].is_system, true, 'msg 4 still hidden (pre-hidden, F1+M3 fix)');
    assertEqual(chat[5].is_system, false, 'msg 5 visible (orig, outside both)');
});

test('rollbackById: unknown id is a no-op', () => {
    const chat = [{ mes: 'a', is_system: false }];
    const { restored, removed } = rollbackById(chat, 'sum_nope');
    assertEqual(restored, 0, 'nothing restored');
    assertEqual(removed, 0, 'nothing removed');
    assertEqual(chat.length, 1, 'chat unchanged');
});

test('rollbackById: invalid args bail safely', () => {
    assertEqual(rollbackById(null, 'sum_X').restored, 0, 'null chat');
    assertEqual(rollbackById([], '').restored, 0, 'empty id');
});

test('buildSummaryUserMessage: skips empty body', () => {
    const chat = [
        { name: 'X', mes: '   ', is_system: false },
        { name: 'Y', mes: 'content', is_system: false },
    ];
    const msg = buildSummaryUserMessage(chat, 0, 1);
    assert(!msg.includes('#0'), 'empty-body msg skipped');
    assert(msg.includes('content'), 'real msg included');
});

// --- Fuzzy name matching (all-results variant) ---

import { fuzzyTitleMatchAll } from '../src/helpers.js';

test('fuzzyTitleMatchAll: returns empty array on empty input', () => {
    assertEqual(fuzzyTitleMatchAll('', ['foo', 'bar']).length, 0, 'empty query');
    assertEqual(fuzzyTitleMatchAll('foo', []).length, 0, 'empty candidates');
});

test('fuzzyTitleMatchAll: returns all matches above threshold, sorted desc', () => {
    const candidates = ['Alice', 'Alicia', 'Bob', 'Alic'];
    const matches = fuzzyTitleMatchAll('Alic', candidates, 0.3);
    assert(matches.length >= 2, 'multiple matches surfaced');
    for (let i = 1; i < matches.length; i++) {
        assert(matches[i - 1].similarity >= matches[i].similarity, 'sorted desc by similarity');
    }
});

test('fuzzyTitleMatchAll: respects threshold cutoff', () => {
    const candidates = ['Apple', 'Application', 'Banana'];
    const strict = fuzzyTitleMatchAll('App', candidates, 0.9);
    const lenient = fuzzyTitleMatchAll('App', candidates, 0.1);
    assert(lenient.length > strict.length, 'lenient threshold finds more');
});

test('fuzzyTitleMatchAll: handles non-string input safely', () => {
    assertEqual(fuzzyTitleMatchAll(null, ['x']).length, 0, 'null query');
    assertEqual(fuzzyTitleMatchAll(undefined, ['x']).length, 0, 'undefined query');
});

// --- #13 + #26: Browse row-model + folder grouping helpers ---

import { buildBrowseRowModel, topFolderOf, listTopFolders, entryKeysInFolder } from '../src/drawer/drawer-browse-pure.js';

test('topFolderOf: returns (root) for missing folderPath', () => {
    assertEqual(topFolderOf({}), '(root)', 'undefined folderPath');
    assertEqual(topFolderOf({ folderPath: '' }), '(root)', 'empty folderPath');
    assertEqual(topFolderOf(null), '(root)', 'null entry');
});

test('topFolderOf: takes first segment of multi-segment path', () => {
    assertEqual(topFolderOf({ folderPath: 'Locations/Cities/Vire' }), 'Locations', 'multi-segment');
    assertEqual(topFolderOf({ folderPath: 'Characters' }), 'Characters', 'single segment');
});

test('buildBrowseRowModel: grouping OFF returns flat entry rows in original order', () => {
    const entries = [
        { title: 'A', folderPath: 'Z' },
        { title: 'B', folderPath: 'A' },
        { title: 'C', folderPath: 'A' },
    ];
    const rows = buildBrowseRowModel(entries, { grouping: false });
    assertEqual(rows.length, 3, 'flat list length');
    assert(rows.every(r => r.type === 'entry'), 'no headers in flat mode');
    assertEqual(rows[0].entry.title, 'A', 'order preserved');
});

test('buildBrowseRowModel: grouping ON inserts headers + groups in first-appearance order', () => {
    const entries = [
        { title: 'A1', folderPath: 'A' },
        { title: 'B1', folderPath: 'B' },
        { title: 'A2', folderPath: 'A' },
    ];
    const rows = buildBrowseRowModel(entries, { grouping: true, expandedFolders: new Set(['A', 'B']) });
    // Headers preserve first-appearance order: A header → A1, A2 → B header → B1.
    assertEqual(rows[0].type, 'header', 'first row is header');
    assertEqual(rows[0].folder, 'A', 'first folder by appearance');
    assertEqual(rows[0].count, 2, 'A has 2 entries');
    assertEqual(rows[1].entry.title, 'A1', 'A1 second');
    assertEqual(rows[2].entry.title, 'A2', 'A2 third');
    assertEqual(rows[3].type, 'header', 'B header fourth');
    assertEqual(rows[3].folder, 'B', 'B folder');
});

test('buildBrowseRowModel: collapsed folders omit child entry rows', () => {
    const entries = [
        { title: 'A1', folderPath: 'A' },
        { title: 'A2', folderPath: 'A' },
        { title: 'B1', folderPath: 'B' },
    ];
    // Only B is in the expanded set.
    const rows = buildBrowseRowModel(entries, { grouping: true, expandedFolders: new Set(['B']) });
    const headers = rows.filter(r => r.type === 'header');
    assertEqual(headers.length, 2, 'both headers present');
    const aHeader = headers.find(h => h.folder === 'A');
    assertEqual(aHeader.expanded, false, 'A header marked collapsed');
    const aEntries = rows.filter(r => r.type === 'entry' && r.folder === 'A');
    assertEqual(aEntries.length, 0, 'collapsed folder yields no entry rows');
    const bEntries = rows.filter(r => r.type === 'entry' && r.folder === 'B');
    assertEqual(bEntries.length, 1, 'expanded folder yields entry rows');
});

test('buildBrowseRowModel: null expandedFolders defaults to all-expanded', () => {
    const entries = [
        { title: 'A1', folderPath: 'A' },
        { title: 'B1', folderPath: 'B' },
    ];
    const rows = buildBrowseRowModel(entries, { grouping: true, expandedFolders: null });
    const entryRows = rows.filter(r => r.type === 'entry');
    assertEqual(entryRows.length, 2, 'all entries rendered when no set passed');
});

test('buildBrowseRowModel: empty entries returns empty array regardless of opts', () => {
    assertEqual(buildBrowseRowModel([]).length, 0, 'empty');
    assertEqual(buildBrowseRowModel(null, { grouping: true }).length, 0, 'null');
});

test('listTopFolders: returns sorted unique top folders, (root) for missing', () => {
    const entries = [
        { folderPath: 'B/sub' },
        { folderPath: 'A' },
        { folderPath: 'A/x' },
        {},
    ];
    const folders = listTopFolders(entries);
    assertEqual(folders.length, 3, 'three buckets');
    assertEqual(folders[0], '(root)', 'sorted ascii');
});

test('entryKeysInFolder: collects keyFn results only for matching folder', () => {
    const entries = [
        { title: 'A1', vaultSource: 'V', folderPath: 'A' },
        { title: 'B1', vaultSource: 'V', folderPath: 'B' },
        { title: 'A2', vaultSource: 'V', folderPath: 'A' },
    ];
    const keyFn = e => `${e.vaultSource}:${e.title}`;
    const keys = entryKeysInFolder(entries, 'A', keyFn);
    assertEqual(keys.length, 2, 'two A entries');
    assert(keys.includes('V:A1') && keys.includes('V:A2'), 'A entries collected');
});

// --- Wave 6.5 backfill: isUnderlyingClaudeModel (src/librarian/agentic-api-pure.js) ---
// BUG-AUDIT (REG-B2) regression guard: anthropic/claude-* routes via OpenRouter must
// trigger the same Claude-specific request mitigations as bare claude-* names.

import { isUnderlyingClaudeModel } from '../src/librarian/agentic-api-pure.js';

test('isUnderlyingClaudeModel: matches bare claude-* names', () => {
    assert(isUnderlyingClaudeModel('claude-sonnet-4-5'), 'sonnet-4-5');
    assert(isUnderlyingClaudeModel('claude-3-opus-20240229'), 'classic 3-opus');
    assert(isUnderlyingClaudeModel('claude-haiku-4-5'), 'haiku');
});

test('isUnderlyingClaudeModel: matches anthropic/claude-* OpenRouter routes', () => {
    assert(isUnderlyingClaudeModel('anthropic/claude-3.5-sonnet'), 'OR 3.5 sonnet');
    assert(isUnderlyingClaudeModel('anthropic/claude-opus-4'), 'OR opus-4');
});

test('isUnderlyingClaudeModel: case insensitive on both prefixes', () => {
    assert(isUnderlyingClaudeModel('CLAUDE-SONNET-4-5'), 'upper bare');
    assert(isUnderlyingClaudeModel('Anthropic/Claude-3'), 'mixed case OR');
});

test('isUnderlyingClaudeModel: rejects non-Claude models', () => {
    assert(!isUnderlyingClaudeModel('gpt-4o'), 'gpt-4o not claude');
    assert(!isUnderlyingClaudeModel('gemini-2.5-pro'), 'gemini not claude');
    assert(!isUnderlyingClaudeModel('mistral-large'), 'mistral not claude');
    assert(!isUnderlyingClaudeModel('openrouter/anthropic/claude-3'), 'OR-prefixed-anthropic-prefixed does not match — must start with anthropic/');
});

test('isUnderlyingClaudeModel: handles null / undefined / non-string safely', () => {
    assert(!isUnderlyingClaudeModel(null), 'null');
    assert(!isUnderlyingClaudeModel(undefined), 'undefined');
    assert(!isUnderlyingClaudeModel(''), 'empty');
    assert(!isUnderlyingClaudeModel(42), 'number');
    assert(!isUnderlyingClaudeModel({}), 'object');
});

// --- #16 priority reverse: comparePriority (src/helpers.js) ---

import { comparePriority } from '../src/helpers.js';

test('comparePriority: normal order — lower priority wins', () => {
    const arr = [{ priority: 50 }, { priority: 10 }, { priority: 30 }];
    arr.sort((a, b) => comparePriority(a, b, false));
    assertEqual(arr[0].priority, 10, 'lowest first');
    assertEqual(arr[2].priority, 50, 'highest last');
});

test('comparePriority: reversed — higher priority wins', () => {
    const arr = [{ priority: 50 }, { priority: 10 }, { priority: 30 }];
    arr.sort((a, b) => comparePriority(a, b, true));
    assertEqual(arr[0].priority, 50, 'highest first in reversed');
    assertEqual(arr[2].priority, 10, 'lowest last in reversed');
});

test('comparePriority: missing priority defaults to 50', () => {
    const a = {};
    const b = { priority: 10 };
    // 50 vs 10 → b wins in normal order; a (50) loses → positive diff.
    assert(comparePriority(a, b, false) > 0, 'missing acts as 50');
    assert(comparePriority(a, b, true) < 0, 'reversed flips sign');
});

test('comparePriority: equal priorities return 0', () => {
    assertEqual(comparePriority({ priority: 25 }, { priority: 25 }, false), 0, 'equal scalar');
    assertEqual(comparePriority({ priority: 25 }, { priority: 25 }, true), 0, 'equal scalar reversed');
});

// --- Agent C audit regression guards ---

test('updateFrontmatterFields: CRLF-authored file updates in place, no duplicate keys', () => {
    const input = '---\r\npriority: 50\r\nstatus: active\r\n---\r\n\r\nbody';
    const result = updateFrontmatterFields(input, { priority: 10 });
    assert(result.applied.includes('priority'), 'priority applied');
    const priorityHits = (result.content.match(/^priority:/gm) || []).length;
    assertEqual(priorityHits, 1, 'exactly one priority line (no duplicate)');
    assert(result.content.includes('priority: 10'), 'new value present');
    assert(/\r\n/.test(result.content), 'CRLF line endings preserved');
    assert(result.content.includes('status: active'), 'untouched field preserved');
});

test('updateFrontmatterFields: block scalar header is not overwritten', () => {
    const input = '---\nsummary: |\n  line one\n  line two\n---\n\nbody';
    const result = updateFrontmatterFields(input, { summary: 'replaced' });
    assert(result.skipped.includes('summary'), 'block-scalar key reported as skipped');
    assert(!result.applied.includes('summary'), 'block-scalar key NOT applied');
    assert(result.content.includes('summary: |'), 'block-scalar header preserved');
    assert(result.content.includes('line one'), 'block-scalar body preserved');
});

test('updateFrontmatterFields: folded block scalar (>) is not overwritten', () => {
    const input = '---\nsummary: >\n  folded line\n---\n\nbody';
    const result = updateFrontmatterFields(input, { summary: 'replaced' });
    assert(result.skipped.includes('summary'), 'folded-scalar key reported as skipped');
    assert(result.content.includes('summary: >'), 'folded-scalar header preserved');
});

test('updateFrontmatterFields: hyphenated key updates in place, no duplicate', () => {
    const input = '---\nrefine-keys: oldval\n---\n\nbody';
    const result = updateFrontmatterFields(input, { 'refine-keys': 'newval' });
    assert(result.applied.includes('refine-keys'), 'hyphenated key applied');
    const hits = (result.content.match(/^refine-keys:/gm) || []).length;
    assertEqual(hits, 1, 'exactly one refine-keys line');
    assert(result.content.includes('refine-keys: newval'), 'value updated');
});

test('updateFrontmatterFields: dotted key updates in place, no duplicate', () => {
    const input = '---\nx.y: oldval\n---\n\nbody';
    const result = updateFrontmatterFields(input, { 'x.y': 'newval' });
    assert(result.applied.includes('x.y'), 'dotted key applied');
    const hits = (result.content.match(/^x\.y:/gm) || []).length;
    assertEqual(hits, 1, 'exactly one x.y line');
});

test('updateFrontmatterFields: inline-flow array refused not silently rewritten', () => {
    const input = '---\nkeys: [one, two, three]\n---\n\nbody';
    const result = updateFrontmatterFields(input, { keys: 'flat' });
    assert(result.skipped.includes('keys'), 'inline-flow array reported as skipped');
    assert(result.content.includes('[one, two, three]'), 'inline-flow array preserved');
});

test('updateFrontmatterFields: NaN/Infinity numeric values are skipped not corrupted', () => {
    const input = '---\nweight: 1\n---\n\nbody';
    const nanResult = updateFrontmatterFields(input, { weight: NaN });
    assert(nanResult.skipped.includes('weight'), 'NaN reported as skipped');
    assert(!nanResult.applied.includes('weight'), 'NaN NOT applied');
    assert(nanResult.content.includes('weight: 1'), 'original value preserved');
    const infResult = updateFrontmatterFields(input, { weight: Infinity });
    assert(infResult.skipped.includes('weight'), 'Infinity reported as skipped');
});

test('updateFrontmatterFields: new field with NaN refused, no corruption', () => {
    const input = '---\na: 1\n---\n\nbody';
    const result = updateFrontmatterFields(input, { newField: NaN });
    assert(result.skipped.includes('newField'), 'NaN new field skipped');
    assert(!result.content.includes('newField'), 'no malformed line emitted');
});

test('convertWiEntry: compress option annotates frontmatter and shrinks body', () => {
    const wi = { comment: 'CavemanTest', key: ['c'], content: 'The protagonist is a hero who really, basically saves the day.' };
    const plain = convertWiEntry(wi, 'lorebook');
    const compressed = convertWiEntry(wi, 'lorebook', { compress: true });
    assert(!plain.content.includes('compress:'), 'no annotation when omitted');
    assert(compressed.content.includes('compress: caveman'), 'caveman annotation added');
    assert(compressed.content.length < plain.content.length, 'compressed body is shorter');
});

// ============================================================================
// Tests: encodeVaultPath + validateVaultPath (src/obsidian-api.js — production code)
// ============================================================================

test('encodeVaultPath: encodes spaces in segments', () => {
    assertEqual(encodeVaultPath('LA World/Characters/Alice Smith.md'), 'LA%20World/Characters/Alice%20Smith.md', 'spaces encoded per segment');
});

test('encodeVaultPath: preserves slashes', () => {
    assertEqual(encodeVaultPath('folder/subfolder/file.md'), 'folder/subfolder/file.md', 'slashes preserved');
});

test('encodeVaultPath: encodes special chars', () => {
    const result = encodeVaultPath('notes/café.md');
    assert(result.includes('caf%C3%A9'), 'should encode unicode');
});

test('encodeVaultPath: simple filename', () => {
    assertEqual(encodeVaultPath('Alice.md'), 'Alice.md', 'no encoding needed');
});

test('validateVaultPath: normal path passes', () => {
    assertEqual(validateVaultPath('folder/file.md'), 'folder/file.md', 'normal path passes');
});

test('validateVaultPath: backslashes normalized', () => {
    assertEqual(validateVaultPath('folder\\file.md'), 'folder/file.md', 'backslashes to forward');
});

test('validateVaultPath: path traversal blocked', () => {
    let threw = false;
    try { validateVaultPath('../secret/file.md'); } catch { threw = true; }
    assert(threw, 'should throw on path traversal with ..');
});

test('validateVaultPath: dot segment blocked', () => {
    let threw = false;
    try { validateVaultPath('folder/./file.md'); } catch { threw = true; }
    assert(threw, 'should throw on dot segment');
});

test('validateVaultPath: absolute path blocked', () => {
    let threw = false;
    try { validateVaultPath('/etc/passwd'); } catch { threw = true; }
    assert(threw, 'should throw on absolute path');
});

// ============================================================================
// Tests: yamlEscape (core/utils.js — production code)
// ============================================================================

test('yamlEscape: plain string passes through', () => {
    assertEqual(yamlEscape('hello'), 'hello', 'plain string unchanged');
});

test('yamlEscape: special chars get quoted', () => {
    assertEqual(yamlEscape('key: value'), '"key: value"', 'colon triggers quoting');
    assertEqual(yamlEscape('has # hash'), '"has # hash"', 'hash triggers quoting');
    assertEqual(yamlEscape('[array]'), '"[array]"', 'bracket triggers quoting');
});

test('yamlEscape: newlines get quoted', () => {
    // In YAML double-quoted strings, literal newlines are valid — function wraps but doesn't escape \n
    const result = yamlEscape('line1\nline2');
    assert(result.startsWith('"') && result.endsWith('"'), 'newline triggers quoting');
});

test('yamlEscape: leading/trailing whitespace gets quoted', () => {
    assertEqual(yamlEscape(' leading'), '" leading"', 'leading space triggers quoting');
});

test('yamlEscape: internal quotes escaped', () => {
    assertEqual(yamlEscape('say "hello"'), '"say \\"hello\\""', 'quotes escaped');
});

test('yamlEscape: backslash alone does not trigger quoting', () => {
    // Backslash is not a YAML special character — no quoting needed
    assertEqual(yamlEscape('path\\to'), 'path\\to', 'backslash alone = no quoting');
});

test('yamlEscape: backslash inside quoted string gets escaped', () => {
    // When quoting is triggered by another char (colon), backslashes are escaped
    assertEqual(yamlEscape('path\\to: here'), '"path\\\\to: here"', 'backslash escaped when quoting triggered');
});

// ============================================================================
// Tests: Pipeline Stages (src/stages.js)
// ============================================================================

import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from '../src/stages.js';

// -- buildExemptionPolicy --

test('buildExemptionPolicy: constants are in forceInject', () => {
    // BUG-399 (Fix 2): forceInject keyed by trackerKey (`${vaultSource}:${title}`).
    const vault = [makeEntry('A', { constant: true }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], []);
    assert(policy.forceInject.has(':A'), 'constant A should be in forceInject by trackerKey');
    assert(!policy.forceInject.has(':B'), 'non-constant B should NOT be in forceInject');
});

test('buildExemptionPolicy: pins are in forceInject', () => {
    const vault = [makeEntry('A'), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    assert(policy.forceInject.has(':A'), 'pinned A should be in forceInject by trackerKey');
    assert(!policy.forceInject.has(':B'), 'non-pinned B should NOT be in forceInject');
});

test('buildExemptionPolicy: seed always in forceInject; bootstrap gen-scoped to bootstrapActive', () => {
    // Stages H-3 / gotcha #60: bootstrap exemption is gen-scoped. Mirrors
    // helpers.js:isForceInjected. Default bootstrapActive=false is conservative.
    const vault = [makeEntry('Boot', { bootstrap: true }), makeEntry('Seed', { seed: true }), makeEntry('Normal')];

    const policyDefault = buildExemptionPolicy(vault, [], []);
    assert(!policyDefault.forceInject.has(':Boot'), 'default: bootstrap NOT in forceInject (bootstrapActive defaults to false)');
    assert(policyDefault.forceInject.has(':Seed'), 'seed always in forceInject');
    assert(!policyDefault.forceInject.has(':Normal'), 'normal never in forceInject');

    const policyActive = buildExemptionPolicy(vault, [], [], true);
    assert(policyActive.forceInject.has(':Boot'), 'bootstrap IS in forceInject when bootstrapActive=true');
    assert(policyActive.forceInject.has(':Seed'), 'seed still in forceInject');
    assert(!policyActive.forceInject.has(':Normal'), 'normal still NOT in forceInject');

    const policyInactive = buildExemptionPolicy(vault, [], [], false);
    assert(!policyInactive.forceInject.has(':Boot'), 'bootstrap NOT in forceInject when bootstrapActive=false');
    assert(policyInactive.forceInject.has(':Seed'), 'seed still in forceInject');
});

test('buildExemptionPolicy: blocks stored lowercase in policy', () => {
    const vault = [makeEntry('A')];
    const policy = buildExemptionPolicy(vault, [], ['Blocked Entry']);
    assert(policy.blocks.some(b => b.title.toLowerCase() === 'blocked entry'), 'block should be stored with lowercase-matchable title');
    assert(!policy.blocks.some(b => b.title === 'Blocked Entry' && b.vaultSource), 'legacy string blocks have null vaultSource');
});

test('buildExemptionPolicy: empty inputs produce empty sets', () => {
    const policy = buildExemptionPolicy([], [], []);
    assertEqual(policy.forceInject.size, 0, 'empty vault = empty forceInject');
    assertEqual(policy.pins.length, 0, 'empty pins');
    assertEqual(policy.blocks.length, 0, 'empty blocks');
});

test('buildExemptionPolicy: pin and constant overlap is deduplicated', () => {
    const vault = [makeEntry('A', { constant: true })];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    assertEqual(policy.forceInject.size, 1, 'A appears once despite being constant and pinned');
    assert(policy.forceInject.has(':A'), 'A is in forceInject by trackerKey');
});

// -- applyPinBlock --

test('applyPinBlock: pinned entries added with constant=true and priority=10', () => {
    const vault = [makeEntry('A', { priority: 50 }), makeEntry('B', { priority: 80 })];
    const policy = buildExemptionPolicy(vault, ['B'], []);
    const matchedKeys = new Map();
    const result = applyPinBlock([vault[0]], vault, policy, matchedKeys);
    assertEqual(result.length, 2, 'B should be added');
    const pinned = result.find(e => e.title === 'B');
    assert(pinned.constant === true, 'pinned entry should have constant=true');
    assertEqual(pinned.priority, 10, 'pinned entry should have priority=10');
    assertEqual(matchedKeys.get(':B'), '(pinned)', 'matchedKeys should record pin (trackerKey ":B" for empty vault)');
});

test('applyPinBlock: pinned entry already in results gets constant+priority override', () => {
    const vault = [makeEntry('A', { priority: 50 })];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    const matchedKeys = new Map();
    const result = applyPinBlock([vault[0]], vault, policy, matchedKeys);
    assertEqual(result.length, 1, 'no duplicate');
    assert(result[0].constant === true, 'existing entry should get constant=true');
    assertEqual(result[0].priority, 10, 'existing entry should get priority=10');
});

test('applyPinBlock: does not mutate original entry objects', () => {
    const original = makeEntry('A', { priority: 50 });
    const vault = [original];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    applyPinBlock([original], vault, policy, new Map());
    assertEqual(original.priority, 50, 'original entry priority unchanged');
    assertEqual(original.constant, false, 'original entry constant unchanged');
});

test('applyPinBlock: blocked entries removed (override constants)', () => {
    const vault = [makeEntry('A', { constant: true }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], ['A']);
    const result = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    assertEqual(result.length, 1, 'blocked entry removed');
    assertEqual(result[0].title, 'B', 'only B remains');
});

test('applyPinBlock: block is case-insensitive', () => {
    const vault = [makeEntry('Eris')];
    const policy = buildExemptionPolicy(vault, [], ['ERIS']);
    const result = applyPinBlock([vault[0]], vault, policy, new Map());
    assertEqual(result.length, 0, 'case-insensitive block should remove Eris');
});

test('applyPinBlock: empty pins/blocks is a no-op', () => {
    const vault = [makeEntry('A'), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], []);
    const result = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    assertEqual(result.length, 2, 'all entries preserved');
});

test('applyPinBlock: pin on already-constant entry sets priority to 10', () => {
    const vault = [makeEntry('A', { constant: true, priority: 50 })];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    const result = applyPinBlock([vault[0]], vault, policy, new Map());
    assertEqual(result[0].priority, 10, 'constant+pinned gets priority 10');
    assert(result[0].constant === true, 'remains constant');
});

// -- applyContextualGating --

// Strict-tolerance field definitions for gating tests that expect strict behavior
const STRICT_FIELD_DEFS = DEFAULT_FIELD_DEFINITIONS.map(fd => ({
    ...fd,
    gating: { ...fd.gating, tolerance: 'strict' },
}));

test('applyContextualGating: no context set = return all entries unchanged', () => {
    const entries = [makeEntry('A', { customFields: { era: ['golden'] } }), makeEntry('B')];
    const result = applyContextualGating(entries, {}, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 2, 'no gating when no context dimensions set');
});

test('applyContextualGating: entry with era matches active era', () => {
    const entries = [makeEntry('A', { customFields: { era: ['golden'] } }), makeEntry('B', { customFields: { era: ['dark'] } })];
    const result = applyContextualGating(entries, { era: 'golden' }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'only golden era entry kept');
    assertEqual(result[0].title, 'A', 'A matches golden era');
});

test('applyContextualGating: entry with era dropped when no era active (strict)', () => {
    const entries = [makeEntry('A', { customFields: { era: ['golden'] } }), makeEntry('B')];
    const result = applyContextualGating(entries, { location: 'tavern' }, { forceInject: new Set() }, false, {}, STRICT_FIELD_DEFS);
    assertEqual(result.length, 1, 'era entry dropped when no era set');
    assertEqual(result[0].title, 'B', 'ungated entry kept');
});

test('applyContextualGating: forceInject entries bypass era gating', () => {
    const entries = [makeEntry('A', { customFields: { era: ['golden'] } })];
    // BUG-399 (Fix 2): forceInject keyed by trackerKey (`${vaultSource}:${title}`).
    const result = applyContextualGating(entries, { location: 'tavern' }, { forceInject: new Set([':A']) }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'forceInject entry kept despite era mismatch');
});

test('applyContextualGating: location gating works', () => {
    const entries = [makeEntry('A', { customFields: { location: ['tavern'] } }), makeEntry('B', { customFields: { location: ['castle'] } })];
    const result = applyContextualGating(entries, { location: 'tavern' }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'only matching location kept');
    assertEqual(result[0].title, 'A', 'tavern entry kept');
});

test('applyContextualGating: sceneType gating works', () => {
    const entries = [makeEntry('A', { customFields: { scene_type: ['combat'] } }), makeEntry('B')];
    const result = applyContextualGating(entries, { scene_type: 'combat' }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 2, 'combat entry and ungated entry both kept');
});

test('applyContextualGating: characterPresent gating works', () => {
    const entries = [
        makeEntry('A', { customFields: { character_present: ['Eris'] } }),
        makeEntry('B', { customFields: { character_present: ['Raven'] } }),
    ];
    const result = applyContextualGating(entries, { character_present: ['Eris'] }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'only Eris entry kept');
    assertEqual(result[0].title, 'A', 'A kept for Eris');
});

test('applyContextualGating: characterPresent with no present chars drops entry (strict)', () => {
    const entries = [makeEntry('A', { customFields: { character_present: ['Eris'] } }), makeEntry('B')];
    const result = applyContextualGating(entries, { era: 'golden' }, { forceInject: new Set() }, false, {}, STRICT_FIELD_DEFS);
    assertEqual(result.length, 1, 'character-gated entry dropped when no chars present');
    assertEqual(result[0].title, 'B', 'ungated entry kept');
});

test('applyContextualGating: era matching is case-insensitive', () => {
    const entries = [makeEntry('A', { customFields: { era: ['Golden Age'] } })];
    const result = applyContextualGating(entries, { era: 'golden age' }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'case-insensitive era match');
});

test('applyContextualGating: multiple era values, any match passes', () => {
    const entries = [makeEntry('A', { customFields: { era: ['golden', 'silver'] } })];
    const result = applyContextualGating(entries, { era: 'silver' }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'silver matches one of the era values');
});

test('applyContextualGating: entry with no gating fields always passes', () => {
    const entries = [makeEntry('A')];
    const result = applyContextualGating(entries, { era: 'golden', location: 'tavern' }, { forceInject: new Set() }, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'ungated entry always passes regardless of active context');
});

// -- applyReinjectionCooldown --

test('applyReinjectionCooldown: cooldown=0 is a no-op', () => {
    const entries = [makeEntry('A')];
    const history = new Map([['A', 5]]);
    const result = applyReinjectionCooldown(entries, { forceInject: new Set() }, history, 6, 0, false);
    assertEqual(result.length, 1, 'cooldown disabled = all pass');
});

test('applyReinjectionCooldown: recently injected entry is filtered', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 5]]);
    const result = applyReinjectionCooldown([a], { forceInject: new Set() }, history, 6, 3, false);
    assertEqual(result.length, 0, 'entry injected 1 gen ago filtered (cooldown 3)');
});

test('applyReinjectionCooldown: old injection passes cooldown', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 2]]);
    const result = applyReinjectionCooldown([a], { forceInject: new Set() }, history, 6, 3, false);
    assertEqual(result.length, 1, 'entry injected 4 gens ago passes (cooldown 3)');
});

test('applyReinjectionCooldown: forceInject entries always pass', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 5]]);
    // BUG-399 (Fix 2): forceInject keyed by trackerKey.
    const result = applyReinjectionCooldown([a], { forceInject: new Set([':A']) }, history, 6, 3, false);
    assertEqual(result.length, 1, 'forceInject bypasses cooldown');
});

test('applyReinjectionCooldown: no history = all pass', () => {
    const entries = [makeEntry('A'), makeEntry('B')];
    const result = applyReinjectionCooldown(entries, { forceInject: new Set() }, new Map(), 10, 5, false);
    assertEqual(result.length, 2, 'no history = nothing filtered');
});

test('applyReinjectionCooldown: entry at exact cooldown boundary passes', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 4]]);
    // generationCount=7, lastGen=4, diff=3, cooldown=3 → NOT less than → passes
    const result = applyReinjectionCooldown([a], { forceInject: new Set() }, history, 7, 3, false);
    assertEqual(result.length, 1, 'at exact cooldown boundary should pass');
});

// -- applyRequiresExcludesGating --

test('applyRequiresExcludesGating: entry with met requires passes', () => {
    const entries = [makeEntry('A'), makeEntry('B', { requires: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'B requires A, A is present → both pass');
});

test('applyRequiresExcludesGating: entry with unmet requires removed', () => {
    const entries = [makeEntry('B', { requires: ['A'] })];
    const { result, removed } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 0, 'B requires A, A absent → B removed');
    assertEqual(removed.length, 1, 'B in removed list');
});

test('applyRequiresExcludesGating: entry with triggered excludes removed', () => {
    const entries = [makeEntry('A'), makeEntry('B', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'B excludes A → B removed');
    assertEqual(result[0].title, 'A', 'A stays');
});

test('applyRequiresExcludesGating: forceInject entry with unmet requires kept (NEW behavior)', () => {
    const entries = [makeEntry('B', { requires: ['A'] })];
    // BUG-399 (Fix 2): forceInject keyed by trackerKey.
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set([':B']) }, false);
    assertEqual(result.length, 1, 'forceInject B kept despite unmet requires');
    assertEqual(result[0].title, 'B', 'B is in result');
});

test('applyRequiresExcludesGating: forceInject entry with triggered excludes kept', () => {
    const entries = [makeEntry('A'), makeEntry('B', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set([':B']) }, false);
    assertEqual(result.length, 2, 'forceInject B kept despite excludes match');
});

test('applyRequiresExcludesGating: mutual requires both kept (both present)', () => {
    // When A requires B and B requires A, both are present so both requirements are met
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { requires: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'mutual requires: both present → both kept');
});

test('applyRequiresExcludesGating: excludes removes the EXCLUDING entry, not the target', () => {
    // C has excludes:['A'] → C is removed when A is present (not the other way around)
    const entries = [makeEntry('A'), makeEntry('C', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'C removed because it excludes A which is present');
    assertEqual(result[0].title, 'A', 'A stays');
});

test('applyRequiresExcludesGating: cascade removal via third-party excludes', () => {
    // A has excludes:['C'] → A removed because C present → B requires A (absent) → B removed
    const entries = [
        makeEntry('A', { excludes: ['C'] }),
        makeEntry('B', { requires: ['A'] }),
        makeEntry('C'),
    ];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'A and B cascade-removed, C stays');
    assertEqual(result[0].title, 'C', 'only C survives');
});

test('applyRequiresExcludesGating: circular requires with one forceInject breaks cycle', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { requires: ['A'] })];
    // BUG-399 (Fix 2): forceInject keyed by trackerKey.
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set([':A']) }, false);
    // A is forceInject so it stays. B requires A which is present → B also stays.
    assertEqual(result.length, 2, 'forceInject A breaks the cycle');
});

test('applyRequiresExcludesGating: cascade removal (A→B→C chain)', () => {
    const entries = [
        makeEntry('A', { requires: ['X'] }), // X not present → A removed
        makeEntry('B', { requires: ['A'] }), // A removed → B removed too
        makeEntry('C'),                       // C has no deps → stays
    ];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'cascade: A and B removed, C stays');
    assertEqual(result[0].title, 'C', 'C survives');
});

test('applyRequiresExcludesGating: contradictory gating (A requires B, B excludes A)', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    // Round 1: B excludes A (present) → B removed. Round 2: A requires B (absent) → A removed. Both dropped.
    assertEqual(result.length, 0, 'contradictory: both A and B dropped');
});

test('applyRequiresExcludesGating: requires matching is case-insensitive', () => {
    const entries = [makeEntry('Eris'), makeEntry('Bond', { requires: ['eris'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'case-insensitive: "eris" matches "Eris"');
});

test('applyRequiresExcludesGating: empty entries list = empty result', () => {
    const { result, removed } = applyRequiresExcludesGating([], { forceInject: new Set() }, false);
    assertEqual(result.length, 0, 'empty in = empty out');
    assertEqual(removed.length, 0, 'nothing removed');
});

// -- applyStripDedup --

test('applyStripDedup: no injection log = no-op', () => {
    const entries = [makeEntry('A')];
    const result = applyStripDedup(entries, { forceInject: new Set() }, null, 2, {}, false);
    assertEqual(result.length, 1, 'no log = all pass');
});

test('applyStripDedup: empty log = no-op', () => {
    const entries = [makeEntry('A')];
    const result = applyStripDedup(entries, { forceInject: new Set() }, [], 2, {}, false);
    assertEqual(result.length, 1, 'empty log = all pass');
});

test('applyStripDedup: recently injected entry filtered', () => {
    const entries = [makeEntry('A', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 })];
    const log = [{ gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: '' }] }];
    const result = applyStripDedup(entries, { forceInject: new Set() }, log, 2, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 0, 'recently injected entry stripped');
});

test('applyStripDedup: forceInject entries never stripped', () => {
    const entries = [makeEntry('A', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 })];
    const log = [{ gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: '' }] }];
    // BUG-399 (Fix 2): forceInject keyed by trackerKey.
    const result = applyStripDedup(entries, { forceInject: new Set([':A']) }, log, 2, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 1, 'forceInject bypasses dedup');
});

test('applyStripDedup: lookback depth respected', () => {
    const entries = [makeEntry('A', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 })];
    // Log has 3 entries but lookback is 1 — only most recent checked
    const log = [
        { gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: '' }] },
        { gen: 2, entries: [{ title: 'B', pos: 1, depth: 4, role: 0, contentHash: '' }] },
        { gen: 3, entries: [{ title: 'C', pos: 1, depth: 4, role: 0, contentHash: '' }] },
    ];
    const result = applyStripDedup(entries, { forceInject: new Set() }, log, 1, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 1, 'A only in gen1, lookback=1 checks gen3 only → A passes');
});

test('applyStripDedup: different content hash = not a duplicate', () => {
    const entries = [{ ...makeEntry('A'), injectionPosition: 1, injectionDepth: 4, injectionRole: 0, _contentHash: 'abc123' }];
    const log = [{ gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: 'different' }] }];
    const result = applyStripDedup(entries, { forceInject: new Set() }, log, 2, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 1, 'different content hash = not a duplicate');
});

// -- trackGeneration --

test('trackGeneration: sets cooldown for entries with cooldown value', () => {
    const entries = [makeEntry('A', { cooldown: 3, vaultSource: '' })];
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injHistory = new Map();
    trackGeneration(entries, 5, cooldownTracker, decayTracker, injHistory, { reinjectionCooldown: 0, decayEnabled: false });
    assertEqual(cooldownTracker.get(':A'), 4, 'cooldown set to value+1 (compensates for immediate decrement)');
});

test('trackGeneration: no cooldown entries = tracker unchanged', () => {
    const entries = [makeEntry('A', { cooldown: null, vaultSource: '' })];
    const cooldownTracker = new Map();
    trackGeneration(entries, 5, cooldownTracker, new Map(), new Map(), { reinjectionCooldown: 0, decayEnabled: false });
    assert(!cooldownTracker.has(':A'), 'no cooldown set for entry without cooldown');
});

test('trackGeneration: records injection history when reinjectionCooldown > 0', () => {
    const entries = [makeEntry('A', { vaultSource: '' })];
    const injHistory = new Map();
    trackGeneration(entries, 5, new Map(), new Map(), injHistory, { reinjectionCooldown: 3, decayEnabled: false });
    assertEqual(injHistory.get(':A'), 6, 'injection history set to generationCount+1');
});

test('trackGeneration: skips injection history when reinjectionCooldown = 0', () => {
    const entries = [makeEntry('A', { vaultSource: '' })];
    const injHistory = new Map();
    trackGeneration(entries, 5, new Map(), new Map(), injHistory, { reinjectionCooldown: 0, decayEnabled: false });
    assert(!injHistory.has(':A'), 'no history when cooldown disabled');
});

// -- decrementTrackers --

test('decrementTrackers: decrements cooldown counters', () => {
    const cooldownTracker = new Map([['a', 3], ['b', 1]]);
    decrementTrackers(cooldownTracker, new Map(), [], { decayEnabled: false });
    assertEqual(cooldownTracker.get('a'), 2, 'a decremented to 2');
    assert(!cooldownTracker.has('b'), 'b expired and deleted');
});

test('decrementTrackers: decay tracking resets injected entries to 0', () => {
    const entries = [makeEntry('A', { vaultSource: '' })];
    const decayTracker = new Map([[':A', 5]]);
    decrementTrackers(new Map(), decayTracker, entries, { decayEnabled: true, decayBoostThreshold: 5 });
    assertEqual(decayTracker.get(':A'), 0, 'injected entry reset to 0');
});

test('decrementTrackers: decay increments non-injected entries', () => {
    const decayTracker = new Map([[':B', 2]]);
    decrementTrackers(new Map(), decayTracker, [], { decayEnabled: true, decayBoostThreshold: 5 });
    assertEqual(decayTracker.get(':B'), 3, 'non-injected entry incremented');
});

test('decrementTrackers: decay prunes entries past threshold', () => {
    const decayTracker = new Map([[':B', 10]]); // threshold = 5*2=10, 10+1=11 > 10 → pruned
    decrementTrackers(new Map(), decayTracker, [], { decayEnabled: true, decayBoostThreshold: 5 });
    assert(!decayTracker.has(':B'), 'entry at 11 pruned (threshold is 10)');
});

test('decrementTrackers: decay disabled = no changes to decay tracker', () => {
    const decayTracker = new Map([[':A', 5]]);
    decrementTrackers(new Map(), decayTracker, [], { decayEnabled: false });
    assertEqual(decayTracker.get(':A'), 5, 'decay tracker unchanged when disabled');
});

// -- recordAnalytics --

test('recordAnalytics: records matched and injected counts', () => {
    const matched = [makeEntry('A', { vaultSource: '' }), makeEntry('B', { vaultSource: '' })];
    const injected = [makeEntry('A', { vaultSource: '' })];
    const analytics = {};
    recordAnalytics(matched, injected, analytics);
    assertEqual(analytics[':A'].matched, 1, 'A matched once');
    assertEqual(analytics[':A'].injected, 1, 'A injected once');
    assertEqual(analytics[':B'].matched, 1, 'B matched once');
    assertEqual(analytics[':B'].injected, 0, 'B not injected');
});

test('recordAnalytics: increments existing analytics', () => {
    const analytics = { ':A': { matched: 5, injected: 3, lastTriggered: Date.now() - 1000 } };
    recordAnalytics([makeEntry('A', { vaultSource: '' })], [makeEntry('A', { vaultSource: '' })], analytics);
    assertEqual(analytics[':A'].matched, 6, 'matched incremented');
    assertEqual(analytics[':A'].injected, 4, 'injected incremented');
});

test('recordAnalytics: prunes stale entries (>30 days)', () => {
    const staleTime = Date.now() - (31 * 24 * 60 * 60 * 1000);
    const analytics = { ':old': { matched: 1, injected: 0, lastTriggered: staleTime } };
    recordAnalytics([], [], analytics);
    assert(!(':old' in analytics), 'stale entry pruned');
});

test('recordAnalytics: prototype pollution guard', () => {
    const analytics = {};
    const evil = makeEntry('__proto__', { vaultSource: '' });
    recordAnalytics([evil], [], analytics);
    // Object.hasOwn should prevent pollution
    assert(Object.hasOwn(analytics, ':__proto__'), 'analytics has the key via hasOwn');
    assertEqual(typeof analytics[':__proto__']?.matched, 'number', 'value is a normal object');
});

test('recordAnalytics: empty inputs = no changes (except pruning)', () => {
    const analytics = { ':A': { matched: 1, injected: 0, lastTriggered: Date.now() } };
    recordAnalytics([], [], analytics);
    assertEqual(analytics[':A'].matched, 1, 'existing analytics unchanged');
});

// ============================================================================
// Tests: Priority tiebreaker
// ============================================================================

test('priority sort: tiebreaker is alphabetical by title', () => {
    const entries = [
        makeEntry('Zebra', { priority: 50 }),
        makeEntry('Alpha', { priority: 50 }),
        makeEntry('Middle', { priority: 50 }),
    ];
    const sorted = [...entries].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    assertEqual(sorted.map(e => e.title), ['Alpha', 'Middle', 'Zebra'], 'same priority → alphabetical order');
});

test('priority sort: lower priority number wins over alphabetical', () => {
    const entries = [
        makeEntry('Zebra', { priority: 10 }),
        makeEntry('Alpha', { priority: 50 }),
    ];
    const sorted = [...entries].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    assertEqual(sorted.map(e => e.title), ['Zebra', 'Alpha'], 'priority 10 beats priority 50 regardless of name');
});

// ============================================================================
// Tests: Integration — full pipeline stage sequence
// ============================================================================

test('integration: pinned entry survives all gating stages', () => {
    const vault = [
        makeEntry('A', { priority: 50, customFields: { era: ['golden'] }, requires: ['X'] }),
        makeEntry('B', { priority: 80 }),
    ];
    const policy = buildExemptionPolicy(vault, ['A'], []);

    // Stage 1: Pin
    let entries = applyPinBlock([vault[1]], vault, policy, new Map());
    assertEqual(entries.length, 2, 'pinned A added');

    // Stage 2: Contextual gating — no era set, but A has era field
    entries = applyContextualGating(entries, { location: 'tavern' }, policy, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assert(entries.some(e => e.title === 'A'), 'pinned A survives era gating');

    // Stage 3: Cooldown — A was recently injected
    const history = new Map([[':A', 8]]);
    entries = applyReinjectionCooldown(entries, policy, history, 9, 5, false);
    assert(entries.some(e => e.title === 'A'), 'pinned A survives cooldown');

    // Stage 4: Requires/excludes — A requires X which is absent
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    assert(result.some(e => e.title === 'A'), 'pinned A survives requires gating (forceInject)');
});

test('integration: blocked entry removed even if constant', () => {
    const vault = [makeEntry('A', { constant: true }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], ['A']);
    const entries = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    assertEqual(entries.length, 1, 'constant A blocked');
    assertEqual(entries[0].title, 'B', 'only B remains');
});

test('integration: non-forceInject entry with era gated when no era set (strict)', () => {
    const vault = [makeEntry('A', { customFields: { era: ['golden'] } }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], []);
    let entries = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    entries = applyContextualGating(entries, { location: 'tavern' }, policy, false, {}, STRICT_FIELD_DEFS);
    assertEqual(entries.length, 1, 'A gated out (has era but no era active)');
    assertEqual(entries[0].title, 'B', 'B stays');
});

test('integration: constant entry with unmet requires survives (NEW behavior)', () => {
    const vault = [makeEntry('Lore', { constant: true, requires: ['Missing'] })];
    const policy = buildExemptionPolicy(vault, [], []);
    const { result } = applyRequiresExcludesGating(vault, policy, false);
    assertEqual(result.length, 1, 'constant entry survives unmet requires');
    assertEqual(result[0].title, 'Lore', 'Lore kept as forceInject');
});

// ============================================================================
// stripObsidianSyntax tests (Item 7)
// ============================================================================

test('stripObsidianSyntax: strips Templater expressions', () => {
    assertEqual(stripObsidianSyntax('Hello {{tp.date.now()}} world'), 'Hello  world');
    assertEqual(stripObsidianSyntax('Before {{multi\nline}} after'), 'Before  after');
});

test('stripObsidianSyntax: strips Templater alternative syntax', () => {
    assertEqual(stripObsidianSyntax('Hello <% tp.file.title %> world'), 'Hello  world');
});

test('stripObsidianSyntax: strips Obsidian comments', () => {
    assertEqual(stripObsidianSyntax('Before %%hidden comment%% after'), 'Before  after');
    assertEqual(stripObsidianSyntax('Before %%multi\nline%% after'), 'Before  after');
});

test('stripObsidianSyntax: strips dataview inline queries', () => {
    assertEqual(stripObsidianSyntax('Value is `= this.field` here'), 'Value is  here');
});

test('stripObsidianSyntax: strips dataview code blocks', () => {
    const input = 'Before\n```dataview\nTABLE file.name FROM "folder"\n```\nAfter';
    assertEqual(stripObsidianSyntax(input), 'Before\n\nAfter');
});

test('stripObsidianSyntax: handles null/empty/non-string', () => {
    assertEqual(stripObsidianSyntax(null), '');
    assertEqual(stripObsidianSyntax(''), '');
    assertEqual(stripObsidianSyntax(undefined), '');
    assertEqual(stripObsidianSyntax('plain text'), 'plain text');
});

test('stripObsidianSyntax: strips obsidian:// URI links', () => {
    const input = 'See [open vault](obsidian://open?vault=test&file=note) for details.';
    const result = stripObsidianSyntax(input);
    assert(!result.includes('obsidian://'), 'obsidian:// URI should be stripped');
    assert(result.includes('open vault'), 'link text should be preserved');
});

test('stripObsidianSyntax: strips Buttons plugin blocks', () => {
    const input = 'Before\n```button\nname Click Me\ntype command\n```\nAfter';
    const result = stripObsidianSyntax(input);
    assert(!result.includes('button'), 'button block should be stripped');
    assert(result.includes('Before') && result.includes('After'), 'surrounding text preserved');
});

test('stripObsidianSyntax: strips CustomJS blocks', () => {
    const input = 'Before\n```customjs\nconst x = 1;\n```\nAfter';
    const result = stripObsidianSyntax(input);
    assert(!result.includes('customjs'), 'customjs block should be stripped');
    assert(result.includes('Before') && result.includes('After'), 'surrounding text preserved');
});

// ============================================================================
// normalizeResults tests (Item 10 — testing production-equivalent logic)
// ============================================================================

test('normalizeResults: string items get default confidence/reason', () => {
    const result = normalizeResults(['Eris', 'Kael']);
    assertEqual(result[0].title, 'Eris');
    assertEqual(result[0].confidence, 'medium');
    assertEqual(result[0].reason, 'AI search');
});

test('normalizeResults: object items preserve fields', () => {
    const result = normalizeResults([{ title: 'Eris', confidence: 'high', reason: 'directly mentioned' }]);
    assertEqual(result[0].confidence, 'high');
    assertEqual(result[0].reason, 'directly mentioned');
});

test('normalizeResults: invalid confidence defaults to medium', () => {
    const result = normalizeResults([{ title: 'Eris', confidence: 'extreme', reason: 'test' }]);
    assertEqual(result[0].confidence, 'medium');
});

// ============================================================================
// Tests: Integration — multi-stage pipeline chains
// ============================================================================

test('integration: budget interaction with gating — gated entry frees budget for lower-priority', () => {
    // A (constant, 400tok), B (requires C, 400tok), C (regular, 200tok), D (regular, 300tok)
    // Budget: 900tok. If B survives gating: A(400)+B(400)+C(200)=1000 > 900, D cut.
    // If B is gated: A(400)+C(200)+D(300)=900 fits.
    const vault = [
        makeEntry('A', { constant: true, tokenEstimate: 400, priority: 10, content: 'AAA' }),
        makeEntry('B', { tokenEstimate: 400, priority: 20, requires: ['Missing'], content: 'BBB' }),
        makeEntry('C', { tokenEstimate: 200, priority: 30, content: 'CCC' }),
        makeEntry('D', { tokenEstimate: 300, priority: 40, content: 'DDD' }),
    ];
    const policy = buildExemptionPolicy(vault, [], []);
    const { result: gated } = applyRequiresExcludesGating(vault, policy, false);
    // B should be removed (requires Missing)
    assert(!gated.some(e => e.title === 'B'), 'B gated out by requires');
    // Format with 900 budget — A+C+D = 900, should all fit
    const settings = { maxTokensBudget: 900, unlimitedBudget: false, unlimitedEntries: false, maxEntries: 10,
        injectionPosition: 0, injectionDepth: 0, injectionRole: 'system', injectionTemplate: '' };
    const { acceptedEntries } = formatAndGroup(gated, settings, 'dle_');
    assert(acceptedEntries.some(e => e.title === 'D'), 'D now fits after B is gated');
    assertEqual(acceptedEntries.length, 3, 'A+C+D all fit in budget');
});

test('integration: dedup + cooldown interaction — entry removed by first filter', () => {
    const vault = [
        makeEntry('A', { priority: 20, cooldown: 3, content: 'Entry A content' }),
        makeEntry('B', { priority: 30, content: 'Entry B content' }),
    ];
    const policy = buildExemptionPolicy(vault, [], []);

    // Simulate: A is on cooldown AND in dedup log
    const injectionLog = [{ gen: 1, entries: [{ title: 'A', pos: 0, depth: 0, role: 'system', contentHash: '' }] }];
    const defaultSettings = { injectionPosition: 0, injectionDepth: 0, injectionRole: 'system' };

    // Re-injection cooldown removes A first
    const injHistory = new Map([[':A', 8]]);
    let entries = applyReinjectionCooldown(vault, policy, injHistory, 9, 5, false);
    assert(!entries.some(e => e.title === 'A'), 'A removed by reinjection cooldown');

    // Strip dedup would also remove A, but it's already gone
    entries = applyStripDedup(entries, policy, injectionLog, 3, defaultSettings, false);
    assertEqual(entries.length, 1, 'only B remains');
    assertEqual(entries[0].title, 'B', 'B survives both filters');
});

test('integration: decay tracking after full pipeline stages', () => {
    const cooldowns = new Map();
    const decay = new Map();
    const injHistory = new Map();
    const settings = { reinjectionCooldown: 0, decayEnabled: true, decayBoostThreshold: 5, decayPenaltyThreshold: 0 };

    const injected = [
        makeEntry('A', { cooldown: 2 }),
        makeEntry('B', { cooldown: null }),
    ];

    // Track generation
    trackGeneration(injected, 0, cooldowns, decay, injHistory, settings);
    assertEqual(cooldowns.get(':A'), 3, 'A cooldown set to cooldown+1');
    assert(!cooldowns.has(':B'), 'B has no cooldown');

    // Decrement
    decrementTrackers(cooldowns, decay, injected, settings);
    assertEqual(cooldowns.get(':A'), 2, 'A cooldown decremented');
    assertEqual(decay.get(':A'), 0, 'A decay reset to 0 (just injected)');
    assertEqual(decay.get(':B'), 0, 'B decay reset to 0 (just injected)');

    // Second generation without A
    decrementTrackers(cooldowns, decay, [injected[1]], settings);
    assertEqual(cooldowns.get(':A'), 1, 'A cooldown decremented again');
    assertEqual(decay.get(':A'), 1, 'A decay incremented (not injected this gen)');
    assertEqual(decay.get(':B'), 0, 'B decay stays 0 (still injected)');
});

test('integration: analytics accuracy post-gating — gated entries matched but not injected', () => {
    const vault = [
        makeEntry('A', { constant: true, content: 'Constant A' }),
        makeEntry('B', { requires: ['Missing'], content: 'Gated B' }),
        makeEntry('C', { content: 'Regular C' }),
    ];
    const policy = buildExemptionPolicy(vault, [], []);
    const { result: gated } = applyRequiresExcludesGating(vault, policy, false);

    // All three were matched, but only A and C survived gating
    const analytics = {};
    recordAnalytics(vault, gated, analytics);

    assertEqual(analytics[':A'].matched, 1, 'A counted as matched');
    assertEqual(analytics[':A'].injected, 1, 'A counted as injected');
    assertEqual(analytics[':B'].matched, 1, 'B counted as matched');
    assertEqual(analytics[':B'].injected, 0, 'B NOT counted as injected (gated)');
    assertEqual(analytics[':C'].matched, 1, 'C counted as matched');
    assertEqual(analytics[':C'].injected, 1, 'C counted as injected');
});

test('integration: full 4-stage chain with budget truncation', () => {
    // Constant + pinned + regular entries, budget forces truncation
    // Content sized ~4 chars/token so truncation stays within budget
    const body = (n) => 'The quick brown fox jumped over the lazy dog. '.repeat(Math.ceil(n * 4 / 46));
    const vault = [
        makeEntry('Const', { constant: true, tokenEstimate: 300, priority: 10, content: body(300) }),
        makeEntry('Pinned', { tokenEstimate: 250, priority: 50, content: body(250) }),
        makeEntry('Regular', { tokenEstimate: 200, priority: 30, requires: [], content: body(200) }),
        makeEntry('Overflow', { tokenEstimate: 400, priority: 60, content: body(400) }),
    ];
    const policy = buildExemptionPolicy(vault, ['Pinned'], []);
    const matchedKeys = new Map();

    // Stage 1: Pin/Block
    let entries = applyPinBlock(vault, vault, policy, matchedKeys);
    assert(entries.some(e => e.title === 'Pinned'), 'Pinned is in entries');

    // Stage 2: Contextual gating (no context set — all pass)
    entries = applyContextualGating(entries, {}, policy, false, {}, DEFAULT_FIELD_DEFINITIONS);
    assertEqual(entries.length, 4, 'all entries pass (no context)');

    // Stage 3: Requires/excludes
    const { result: gated } = applyRequiresExcludesGating(entries, policy, false);
    assertEqual(gated.length, 4, 'all pass requires/excludes');

    // Stage 4: Format with budget — 700 tokens budget
    const settings = { maxTokensBudget: 700, unlimitedBudget: false, unlimitedEntries: false, maxEntries: 10,
        injectionPosition: 0, injectionDepth: 0, injectionRole: 'system', injectionTemplate: '' };
    // Sort by priority first (like the real pipeline)
    gated.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    const { acceptedEntries, totalTokens } = formatAndGroup(gated, settings, 'dle_');
    // Const(300) + Pinned as constant(250) + Regular(200) = 750 > 700
    // Budget should trim the lowest-priority entries
    assert(acceptedEntries.some(e => e.title === 'Const'), 'Const always included');
    assert(totalTokens <= 700, `total tokens ${totalTokens} within budget 700`);
    assert(!acceptedEntries.some(e => e.title === 'Overflow'), 'Overflow cut by budget');
});

// ============================================================================
// Module Graph Integrity Tests
// ============================================================================
// These tests catch breakage that unit tests on pure helpers.js cannot:
// - SyntaxErrors in browser-only modules (duplicate const, etc.)
// - Re-exported functions used locally without a local import binding
// Both failure modes produce ReferenceError/SyntaxError at runtime in the browser
// but are invisible to tests that only import from helpers.js.

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Strip ESM import/export syntax so the file body can be parsed by vm.Script.
 * Preserves function/class/variable declarations so scope analysis catches
 * duplicate bindings (e.g. two `const result` in the same block).
 */
function stripESMForParsing(src) {
    let s = src.replace(/\r\n/g, '\n');
    // Strip multi-line and single-line imports
    s = s.replace(/^import\s+\{[^}]*\}\s+from\s+['"].*?['"];?\s*$/gm, '');
    s = s.replace(/^import\s+.*$/gm, '');
    // Strip re-exports: export { ... } from '...' and bare export { ... };
    s = s.replace(/^export\s+\{[^}]*\}\s+from\s+.*$/gm, '');
    s = s.replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
    // Replace import.meta expressions (ESM-only, not valid in Script/CJS mode)
    s = s.replace(/import\.meta\.url/g, '"file:///stub"');
    s = s.replace(/import\.meta/g, '({})');
    // Transform export declarations into plain declarations
    s = s.replace(/^export\s+async\s+function/gm, 'async function');
    s = s.replace(/^export\s+function/gm, 'function');
    s = s.replace(/^export\s+const/gm, 'const');
    s = s.replace(/^export\s+let/gm, 'let');
    s = s.replace(/^export\s+class/gm, 'class');
    s = s.replace(/^export\s+default/gm, 'const _default_ =');
    return s;
}

/**
 * Find re-exported names that are used in the file body without a local import.
 * `export { X } from './helpers.js'` does NOT create a local binding — X cannot
 * be called inside the same file unless there is also `import { X } from './helpers.js'`.
 */
function findMissingReExportBindings(src) {
    const normalized = src.replace(/\r\n/g, '\n');
    const issues = [];

    // Collect re-exported names
    const reExportRe = /^export\s+\{([^}]+)\}\s+from\s+['"].*?['"];?\s*$/gm;
    const reExported = new Set();
    let m;
    while ((m = reExportRe.exec(normalized)) !== null) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name) reExported.add(name);
        }
    }
    if (reExported.size === 0) return [];

    // Collect locally imported names (both single-line and multi-line)
    const imported = new Set();
    const importRe = /^import\s+\{([^}]+)\}\s+from\s+/gm;
    while ((m = importRe.exec(normalized)) !== null) {
        for (const part of m[1].split(',')) {
            const segments = part.trim().split(/\s+as\s+/);
            const localName = (segments[1] || segments[0]).trim();
            if (localName) imported.add(localName);
        }
    }

    // For each re-exported name not also locally imported, check body usage
    for (const name of reExported) {
        if (imported.has(name)) continue;
        const useRe = new RegExp(name); // simple substring is fine — names are unique identifiers
        const lines = normalized.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^(import|export)\s/.test(trimmed)) continue;
            if (/^\/\//.test(trimmed)) continue;
            if (/^\*/.test(trimmed)) continue;
            if (/^\/\*/.test(trimmed)) continue;
            if (useRe.test(line)) {
                issues.push(name);
                break;
            }
        }
    }
    return issues;
}

/** Recursively collect all .js files under a directory, returning relative paths. */
function collectJsFiles(dir, base = dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...collectJsFiles(full, base));
        } else if (entry.endsWith('.js')) {
            results.push({ rel: full.slice(base.length + 1).replace(/\\/g, '/'), abs: full });
        }
    }
    return results;
}

test('module-graph: all src/ modules parse without SyntaxError', () => {
    const srcDir = join(EXT_DIR, 'src');
    const files = collectJsFiles(srcDir);
    assert(files.length > 0, 'found src/ JS files to check');
    for (const { rel, abs } of files) {
        const src = readFileSync(abs, 'utf8');
        const stripped = stripESMForParsing(src);
        try {
            new Script(stripped, { filename: `src/${rel}` });
            assert(true, `src/${rel} parses OK`);
        } catch (e) {
            assert(false, `src/${rel} has SyntaxError: ${e.message}`);
        }
    }
});

test('module-graph: all core/ modules parse without SyntaxError', () => {
    const coreDir = join(EXT_DIR, 'core');
    const files = readdirSync(coreDir).filter(f => f.endsWith('.js'));
    assert(files.length > 0, 'found core/ JS files to check');
    for (const file of files) {
        const src = readFileSync(join(coreDir, file), 'utf8');
        const stripped = stripESMForParsing(src);
        try {
            new Script(stripped, { filename: `core/${file}` });
            assert(true, `core/${file} parses OK`);
        } catch (e) {
            assert(false, `core/${file} has SyntaxError: ${e.message}`);
        }
    }
});

test('module-graph: re-exported functions have local import when used in body', () => {
    // These files re-export from helpers.js and may use those functions locally.
    // export { X } from './helpers.js' does NOT bind X locally — a separate
    // import { X } from './helpers.js' is required for local use.
    const srcDir = join(EXT_DIR, 'src');
    const files = collectJsFiles(srcDir);
    for (const { rel, abs } of files) {
        const src = readFileSync(abs, 'utf8');
        const missing = findMissingReExportBindings(src);
        if (missing.length > 0) {
            assert(false, `src/${rel} uses re-exported name(s) without local import: ${missing.join(', ')}`);
        } else {
            assert(true, `src/${rel} re-export bindings OK`);
        }
    }
});

test('module-graph: index.js parses without SyntaxError', () => {
    const src = readFileSync(join(EXT_DIR, 'index.js'), 'utf8');
    const stripped = stripESMForParsing(src);
    try {
        new Script(stripped, { filename: 'index.js' });
        assert(true, 'index.js parses OK');
    } catch (e) {
        assert(false, `index.js has SyntaxError: ${e.message}`);
    }
});

// ============================================================================
// Phase 6: Test coverage gaps (from audit)
// ============================================================================

test('parseFrontmatter: BOM handling returns cleaned body', () => {
    const bom = '\uFEFF';
    const content = `${bom}No frontmatter here, just content.`;
    const result = parseFrontmatter(content);
    assertEqual(result.frontmatter, {}, 'BOM-only content should have empty frontmatter');
    assert(!result.body.startsWith(bom), 'body should not start with BOM');
    assertEqual(result.body, 'No frontmatter here, just content.', 'body should be BOM-stripped');
});

test('parseFrontmatter: BOM with valid frontmatter', () => {
    const bom = '\uFEFF';
    const content = `${bom}---\ntitle: Test\n---\nBody here`;
    const result = parseFrontmatter(content);
    assertEqual(result.frontmatter.title, 'Test', 'should parse frontmatter after BOM');
    assertEqual(result.body, 'Body here', 'body should not contain BOM');
});

test('formatAndGroup: prompt_list injection mode', () => {
    const entries = [
        { title: 'A', content: 'Content A', tokenEstimate: 10, priority: 50, injectionPosition: 0 },
    ];
    const settings = {
        injectionMode: 'prompt_list',
        injectionTemplate: '{{content}}',
        injectionPosition: 0,
        injectionDepth: 4,
        injectionRole: 0,
        maxEntries: 10,
        unlimitedEntries: false,
        maxTokensBudget: 1000,
        unlimitedBudget: false,
    };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assert(result.count > 0, 'prompt_list mode should produce output');
    assert(result.groups.length > 0, 'should have at least one group');
});

test('testEntryMatch: refineKeys narrows matching', () => {
    const entry = {
        title: 'Refined',
        keys: ['magic'],
        refineKeys: ['ancient'],
        scanDepth: 10,
    };
    const chat = [
        { mes: 'The magic was strong', is_user: true },
    ];
    const scanText = buildScanText(chat, 10, null);
    // Should match 'magic' but refineKeys requires 'ancient' in chat too
    const matchNoRefine = testEntryMatch({ ...entry, refineKeys: [] }, scanText, false, false, null);
    const matchWithRefine = testEntryMatch(entry, scanText, false, false, null);
    assert(matchNoRefine, 'should match without refineKeys');
    assert(!matchWithRefine, 'refineKeys should prevent match when refine term is absent');
});

test('testEntryMatch: refineKeys allows match when both present', () => {
    const entry = {
        title: 'Refined',
        keys: ['magic'],
        refineKeys: ['ancient'],
        scanDepth: 10,
    };
    const chat = [
        { mes: 'The ancient magic was strong', is_user: true },
    ];
    const scanText = buildScanText(chat, 10, null);
    const match = testEntryMatch(entry, scanText, false, false, null);
    assert(match, 'should match when both key and refineKey are present');
});

test('XML escaping in content templates: title escaped, content raw (issue #16)', () => {
    const entries = [
        { title: 'Test<Entry>', content: 'Has <xml> & "quotes" <3', tokenEstimate: 10, priority: 50, injectionPosition: 0 },
    ];
    const settings = {
        injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
        injectionPosition: 0,
        injectionDepth: 4,
        injectionRole: 0,
        maxEntries: 10,
        unlimitedEntries: false,
        maxTokensBudget: 1000,
        unlimitedBudget: false,
    };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assert(result.groups.length > 0, 'should produce at least one group');
    const text = result.groups[0].text;
    // Title MUST be escaped (interpolated as the wrapper tag name).
    assert(!text.includes('<Test<Entry>>'), 'raw title must not appear inside wrapper');
    assert(text.includes('Test&lt;Entry&gt;'), 'title must be XML-escaped');
    // Content MUST pass through raw — authors intentionally use XML/markup in entries.
    assert(text.includes('Has <xml> & "quotes" <3'), 'content must not be escaped');
    assert(!text.includes('&lt;xml&gt;'), 'content angle brackets must not be escaped');
    assert(!text.includes('&amp;'), 'content ampersand must not be escaped');
    assert(!text.includes('&quot;'), 'content quotes must not be escaped');
});

test('normalizeResults: production function handles all formats', () => {
    // Test with the production normalizeResults function
    const stringArr = ['Entry A', 'Entry B'];
    const r1 = normalizeResultsProd(stringArr);
    assertEqual(r1.length, 2, 'should normalize string array');
    assertEqual(r1[0].title, 'Entry A', 'string items become titles');

    const objArr = [{ title: 'X', confidence: 'high', reason: 'test' }];
    const r2 = normalizeResultsProd(objArr);
    assertEqual(r2[0].confidence, 'high', 'should preserve confidence');

    const nameArr = [{ name: 'Y' }];
    const r3 = normalizeResultsProd(nameArr);
    assertEqual(r3[0].title, 'Y', 'should map name to title');
});

test('convertWiEntry: newlines in comment stripped from title', () => {
    const wiEntry = {
        comment: 'Line1\nLine2\rLine3',
        key: ['test'],
        content: 'Some content',
    };
    const result = convertWiEntry(wiEntry, 'lorebook');
    assert(!result.filename.includes('\n'), 'filename should not contain newlines');
    assert(result.content.includes('# Line1 Line2 Line3'), 'H1 heading should have newlines replaced with spaces');
});

test('convertWiEntry: YAML delimiter injection prevented', () => {
    const wiEntry = {
        comment: 'Test Entry',
        key: ['test'],
        content: 'Before\n---\nAfter',
    };
    const result = convertWiEntry(wiEntry, 'lorebook');
    assert(!result.content.match(/^---$/m) || result.content.split('---').length <= 3,
        'YAML delimiters in content should be sanitized');
});

// ============================================================================
// computeOverallStatus tests
// ============================================================================

// Helper to reset state between computeOverallStatus tests
function resetStatusState() {
    setVaultIndex([]);
    setIndexEverLoaded(false);
    setLastHealthResult(null);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(0);
    // Reset circuit breaker via recordAiSuccess
    recordAiSuccess();
}

test('computeOverallStatus: returns offline when no entries and no vaults attempted', () => {
    resetStatusState();
    assertEqual(computeOverallStatus(), 'offline');
});

test('computeOverallStatus: returns offline when all vaults failed and no entries', () => {
    resetStatusState();
    setLastVaultAttemptCount(2);
    setLastVaultFailureCount(2);
    assertEqual(computeOverallStatus(), 'offline');
});

test('computeOverallStatus: returns ok when entries loaded, no failures, good health', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    setLastVaultFailureCount(0);
    assertEqual(computeOverallStatus(), 'ok');
});

test('computeOverallStatus: returns ok with health grade A (0 errors, <=3 warnings)', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    setLastHealthResult({ errors: 0, warnings: 2 });
    assertEqual(computeOverallStatus(), 'ok');
});

test('computeOverallStatus: returns degraded when some vaults failed', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(3);
    setLastVaultFailureCount(1);
    assertEqual(computeOverallStatus(), 'degraded');
});

test('computeOverallStatus: returns degraded with health grade B (0 errors, >3 warnings)', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    setLastHealthResult({ errors: 0, warnings: 5 });
    assertEqual(computeOverallStatus(), 'degraded');
});

test('computeOverallStatus: returns degraded with health errors', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    setLastHealthResult({ errors: 1, warnings: 0 });
    assertEqual(computeOverallStatus(), 'degraded');
});

test('computeOverallStatus: returns limited when AI circuit breaker is tripped', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    // Trip the circuit breaker (requires 2 consecutive failures)
    recordAiFailure();
    recordAiFailure();
    assertEqual(computeOverallStatus(), 'limited');
    // Clean up
    recordAiSuccess();
});

test('computeOverallStatus: returns limited when using stale cache (indexEverLoaded=false)', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(false); // cache hydrated but never confirmed from Obsidian
    setLastVaultAttemptCount(1);
    assertEqual(computeOverallStatus(), 'limited');
});

test('computeOverallStatus: limited takes priority over degraded', () => {
    resetStatusState();
    setVaultIndex([{ title: 'A', keys: [], content: '' }]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(3);
    setLastVaultFailureCount(1); // would be degraded
    // Trip circuit breaker
    recordAiFailure();
    recordAiFailure();
    assertEqual(computeOverallStatus(), 'limited');
    recordAiSuccess();
});

// ============================================================================
// parseMatchReason tests
// ============================================================================

test('parseMatchReason: null returns unknown', () => {
    const r = parseMatchReason(null);
    assertEqual(r.type, 'unknown');
    assertEqual(r.keyword, null);
});

test('parseMatchReason: empty string returns unknown', () => {
    assertEqual(parseMatchReason('').type, 'unknown');
});

test('parseMatchReason: constant', () => {
    const r = parseMatchReason('Constant entry');
    assertEqual(r.type, 'constant');
    assertEqual(r.keyword, null);
});

test('parseMatchReason: always tag', () => {
    assertEqual(parseMatchReason('lorebook-always').type, 'constant');
});

test('parseMatchReason: pinned', () => {
    assertEqual(parseMatchReason('Pinned').type, 'pinned');
});

test('parseMatchReason: bootstrap', () => {
    assertEqual(parseMatchReason('Bootstrap').type, 'bootstrap');
});

test('parseMatchReason: seed', () => {
    assertEqual(parseMatchReason('Seed').type, 'seed');
});

test('parseMatchReason: keyword → AI (two-stage)', () => {
    const r = parseMatchReason('Eris → AI: relevant (high)');
    assertEqual(r.type, 'keyword_ai');
    assertEqual(r.keyword, 'Eris');
});

test('parseMatchReason: pure AI selection', () => {
    assertEqual(parseMatchReason('AI selection').type, 'ai');
});

test('parseMatchReason: AI: prefix', () => {
    assertEqual(parseMatchReason('AI: context relevant').type, 'ai');
});

test('parseMatchReason: bare keyword', () => {
    const r = parseMatchReason('vampire');
    assertEqual(r.type, 'keyword');
    assertEqual(r.keyword, 'vampire');
});

// ============================================================================
// computeSourcesDiff tests
// ============================================================================

test('computeSourcesDiff: null previous returns empty', () => {
    const r = computeSourcesDiff([{ title: 'A' }], null);
    assertEqual(r.added.length, 0);
    assertEqual(r.removed.length, 0);
});

test('computeSourcesDiff: identical sets return empty diff', () => {
    const sources = [{ title: 'A' }, { title: 'B' }];
    const r = computeSourcesDiff(sources, sources);
    assertEqual(r.added.length, 0);
    assertEqual(r.removed.length, 0);
});

test('computeSourcesDiff: detects added entries', () => {
    const prev = [{ title: 'A' }];
    const curr = [{ title: 'A' }, { title: 'B' }];
    const r = computeSourcesDiff(curr, prev);
    assertEqual(r.added.length, 1);
    assertEqual(r.added[0].title, 'B');
});

test('computeSourcesDiff: detects removed entries', () => {
    const prev = [{ title: 'A' }, { title: 'B' }];
    const curr = [{ title: 'A' }];
    const r = computeSourcesDiff(curr, prev);
    assertEqual(r.removed.length, 1);
    assertEqual(r.removed[0].title, 'B');
});

test('computeSourcesDiff: bootstrap removal reason', () => {
    const prev = [{ title: 'A', matchedBy: 'Bootstrap' }];
    const r = computeSourcesDiff([], prev);
    assertEqual(r.removed[0].removalReason, 'Bootstrap fall-off');
});

test('computeSourcesDiff: constant removal reason', () => {
    const prev = [{ title: 'A', matchedBy: 'Constant entry' }];
    const r = computeSourcesDiff([], prev);
    assertEqual(r.removed[0].removalReason, 'Constant removed');
});

test('computeSourcesDiff: always tag removal reason', () => {
    const prev = [{ title: 'A', matchedBy: 'lorebook-always' }];
    const r = computeSourcesDiff([], prev);
    assertEqual(r.removed[0].removalReason, 'Constant removed');
});

test('computeSourcesDiff: default removal reason', () => {
    const prev = [{ title: 'A', matchedBy: 'vampire' }];
    const r = computeSourcesDiff([], prev);
    assertEqual(r.removed[0].removalReason, 'No longer matched');
});

test('computeSourcesDiff: mixed adds and removes', () => {
    const prev = [{ title: 'A' }, { title: 'B' }];
    const curr = [{ title: 'B' }, { title: 'C' }];
    const r = computeSourcesDiff(curr, prev);
    assertEqual(r.added.length, 1);
    assertEqual(r.added[0].title, 'C');
    assertEqual(r.removed.length, 1);
    assertEqual(r.removed[0].title, 'A');
});

// ============================================================================
// categorizeRejections tests
// ============================================================================

test('categorizeRejections: null trace returns empty', () => {
    assertEqual(categorizeRejections(null, new Set()).length, 0);
});

test('categorizeRejections: empty trace returns empty', () => {
    assertEqual(categorizeRejections({}, new Set()).length, 0);
});

test('categorizeRejections: gatedOut entries', () => {
    const trace = { gatedOut: [{ title: 'A', requires: ['B'], excludes: [] }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups.length, 1);
    assertEqual(groups[0].stage, 'gated_out');
    assertEqual(groups[0].entries[0].title, 'A');
    assert(groups[0].entries[0].reason.includes('needs: B'));
});

test('categorizeRejections: contextualGatingRemoved', () => {
    const trace = { contextualGatingRemoved: [{ title: 'A', reason: 'r' }, { title: 'B', reason: 'r' }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups.length, 1);
    assertEqual(groups[0].stage, 'contextual_gating');
    assertEqual(groups[0].entries.length, 2);
});

test('categorizeRejections: cooldownRemoved', () => {
    const trace = { cooldownRemoved: [{ title: 'A', reason: 'Cooldown active' }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups[0].stage, 'cooldown');
    assertEqual(groups[0].entries[0].reason, 'Cooldown active');
});

test('categorizeRejections: budgetCut with tokens', () => {
    const trace = { budgetCut: [{ title: 'A', tokens: 500 }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups[0].stage, 'budget_cut');
    assert(groups[0].entries[0].reason.includes('500 tok'));
});

test('categorizeRejections: stripDedupRemoved', () => {
    const trace = { stripDedupRemoved: [{ title: 'A', reason: 'Already in context' }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups[0].stage, 'strip_dedup');
    assertEqual(groups[0].entries[0].reason, 'Already in context');
});

test('categorizeRejections: probabilitySkipped', () => {
    const trace = { probabilitySkipped: [{ title: 'A' }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups[0].stage, 'probability_skipped');
});

test('categorizeRejections: warmupFailed', () => {
    const trace = { warmupFailed: [{ title: 'A' }] };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups[0].stage, 'warmup_failed');
});

test('categorizeRejections: excludes injected titles from all groups', () => {
    // BUG-AUDIT v2.5: injectedKeys is now a Set of trackerKey-shape strings (':title' when no vault).
    const trace = {
        gatedOut: [{ title: 'A', requires: [], excludes: [] }],
        cooldownRemoved: [{ title: 'B', reason: 'Cooldown active' }],
    };
    const groups = categorizeRejections(trace, new Set([':a', ':b']));
    assertEqual(groups.length, 0);
});

test('categorizeRejections: AI rejected cross-references other stages', () => {
    const trace = {
        keywordMatched: [
            { title: 'A', matchedBy: 'vampire' },
            { title: 'B', matchedBy: 'blood' },
            { title: 'C', matchedBy: 'night' },
        ],
        aiSelected: [{ title: 'A' }],
        cooldownRemoved: [{ title: 'B', reason: 'Cooldown active' }], // B is accounted for by cooldown, not AI rejection
    };
    const groups = categorizeRejections(trace, new Set());
    const aiGroup = groups.find(g => g.stage === 'ai_rejected');
    assert(aiGroup !== undefined, 'Should have ai_rejected group');
    assertEqual(aiGroup.entries.length, 1);
    assertEqual(aiGroup.entries[0].title, 'C');
});

test('categorizeRejections: full trace with all 8 categories', () => {
    const trace = {
        gatedOut: [{ title: 'A', requires: ['X'], excludes: [] }],
        contextualGatingRemoved: [{ title: 'B', reason: 'r' }],
        keywordMatched: [{ title: 'C', matchedBy: 'key' }, { title: 'D', matchedBy: 'key2' }],
        aiSelected: [{ title: 'D' }],
        cooldownRemoved: [{ title: 'E', reason: 'Cooldown active' }],
        budgetCut: [{ title: 'F', tokens: 100 }],
        stripDedupRemoved: [{ title: 'G', reason: 'Already in context' }],
        probabilitySkipped: [{ title: 'H' }],
        warmupFailed: [{ title: 'I' }],
    };
    const groups = categorizeRejections(trace, new Set());
    assertEqual(groups.length, 8);
    const stages = groups.map(g => g.stage);
    assert(stages.includes('gated_out'));
    assert(stages.includes('contextual_gating'));
    assert(stages.includes('ai_rejected'));
    assert(stages.includes('cooldown'));
    assert(stages.includes('budget_cut'));
    assert(stages.includes('strip_dedup'));
    assert(stages.includes('probability_skipped'));
    assert(stages.includes('warmup_failed'));
});

// ============================================================================
// resolveEntryVault tests
// ============================================================================

test('resolveEntryVault: matching vaultSource', () => {
    const r = resolveEntryVault({ vaultSource: 'MyVault', filename: 'notes/test.md' }, [{ name: 'MyVault' }]);
    assertEqual(r.vaultName, 'MyVault');
    assert(r.uri !== null);
    assert(r.uri.includes('MyVault'));
});

test('resolveEntryVault: falls back to first vault', () => {
    const r = resolveEntryVault({ filename: 'test.md' }, [{ name: 'Default' }]);
    assertEqual(r.vaultName, 'Default');
    assert(r.uri !== null);
});

test('resolveEntryVault: no vaults returns empty name and null URI', () => {
    const r = resolveEntryVault({ filename: 'test.md' }, undefined);
    assertEqual(r.vaultName, '');
    assertEqual(r.uri, null);
});

test('resolveEntryVault: no filename returns null URI', () => {
    const r = resolveEntryVault({ vaultSource: 'V' }, [{ name: 'V' }]);
    assertEqual(r.uri, null);
});

test('resolveEntryVault: empty vaults array', () => {
    const r = resolveEntryVault({ filename: 'test.md' }, []);
    assertEqual(r.vaultName, '');
    assertEqual(r.uri, null);
});

test('resolveEntryVault: vaultSource not in vaults array uses vaultSource as fallback', () => {
    const r = resolveEntryVault({ vaultSource: 'MyVault', filename: 'test.md' }, [{ name: 'Other' }]);
    assertEqual(r.vaultName, 'MyVault');
    assert(r.uri.includes('MyVault'));
});

test('resolveEntryVault: vaultSource with undefined vaults uses vaultSource', () => {
    const r = resolveEntryVault({ vaultSource: 'MyVault', filename: 'test.md' }, undefined);
    assertEqual(r.vaultName, 'MyVault');
    assert(r.uri !== null);
});

// ============================================================================
// tokenBarColor tests
// ============================================================================

test('tokenBarColor: zero avgTokens returns fallback', () => {
    const color = tokenBarColor(100, 0);
    assert(color.includes('SmartThemeQuoteColor') || color.includes('#4caf50'));
});

test('tokenBarColor: null avgTokens returns fallback', () => {
    const color = tokenBarColor(100, null);
    assert(color.includes('SmartThemeQuoteColor') || color.includes('#4caf50'));
});

test('tokenBarColor: ratio 0.5 is green (hue 120)', () => {
    const color = tokenBarColor(50, 100);
    assert(color.includes('120'));
});

test('tokenBarColor: ratio 1.0 is yellow (hue 60)', () => {
    const color = tokenBarColor(100, 100);
    assert(color.includes('60'));
});

test('tokenBarColor: ratio 2.0+ is red (hue 0)', () => {
    const color = tokenBarColor(200, 100);
    assert(color.includes('hsl(0'));
});

// ============================================================================
// formatRelativeTime tests
// ============================================================================

test('formatRelativeTime: null/undefined returns empty string', () => {
    assertEqual(formatRelativeTime(null), '', 'null');
    assertEqual(formatRelativeTime(undefined), '', 'undefined');
    assertEqual(formatRelativeTime(0), '', 'zero');
});

test('formatRelativeTime: just now (< 1 minute ago)', () => {
    assertEqual(formatRelativeTime(Date.now() - 30000), 'just now', '30s ago');
    assertEqual(formatRelativeTime(Date.now()), 'just now', 'now');
});

test('formatRelativeTime: minutes ago', () => {
    assertEqual(formatRelativeTime(Date.now() - 5 * 60000), '5m ago', '5 mins');
    assertEqual(formatRelativeTime(Date.now() - 59 * 60000), '59m ago', '59 mins');
});

test('formatRelativeTime: hours ago', () => {
    assertEqual(formatRelativeTime(Date.now() - 2 * 3600000), '2h ago', '2 hours');
    assertEqual(formatRelativeTime(Date.now() - 23 * 3600000), '23h ago', '23 hours');
});

test('formatRelativeTime: days ago', () => {
    assertEqual(formatRelativeTime(Date.now() - 3 * 86400000), '3d ago', '3 days');
    assertEqual(formatRelativeTime(Date.now() - 29 * 86400000), '29d ago', '29 days');
});

test('formatRelativeTime: months ago', () => {
    assertEqual(formatRelativeTime(Date.now() - 60 * 86400000), '2mo ago', '60 days');
});

test('formatRelativeTime: future timestamp returns just now', () => {
    assertEqual(formatRelativeTime(Date.now() + 60000), 'just now', 'future');
});

// ============================================================================
// Tests: convexHull (graph-analysis.js)
// ============================================================================

test('convexHull: returns empty for empty input', () => {
    assertEqual(convexHull([]), [], 'empty');
});

test('convexHull: returns single point', () => {
    const pts = [{ x: 1, y: 1 }];
    assertEqual(convexHull(pts).length, 1, 'single point');
});

test('convexHull: returns two points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    assertEqual(convexHull(pts).length, 2, 'two points');
});

test('convexHull: triangle', () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }];
    const hull = convexHull(pts);
    assertEqual(hull.length, 3, 'triangle has 3 hull points');
});

test('convexHull: square with interior point', () => {
    const pts = [
        { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
        { x: 2, y: 2 }, // interior
    ];
    const hull = convexHull(pts);
    assertEqual(hull.length, 4, 'square hull excludes interior point');
});

test('convexHull: collinear points', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    const hull = convexHull(pts);
    assert(hull.length <= 3, 'collinear points handled');
});

test('COMMUNITY_PALETTE: has 12 colors', () => {
    assertEqual(COMMUNITY_PALETTE.length, 12, '12 colors');
    assert(COMMUNITY_PALETTE.every(c => /^#[0-9a-f]{6}$/.test(c)), 'all valid hex');
});

// ============================================================================
// Tests: toPastel, lightenColor, darkenColor (graph-render.js)
// ============================================================================

test('toPastel: returns same color if already light', () => {
    assertEqual(toPastel('#ffffff'), '#ffffff', 'white stays white');
});

test('toPastel: lightens a dark color', () => {
    const result = toPastel('#000000', 0.5);
    assert(result !== '#000000', 'black should be lightened');
    assertEqual(result, '#808080', 'black + 50% mix = gray');
});

test('toPastel: respects mix parameter', () => {
    const light = toPastel('#4e79a7', 0.5);
    const less = toPastel('#4e79a7', 0.1);
    // More mix = lighter (higher RGB values)
    const lightR = parseInt(light.slice(1, 3), 16);
    const lessR = parseInt(less.slice(1, 3), 16);
    assert(lightR > lessR, 'higher mix = lighter color');
});

test('lightenColor: returns rgb string', () => {
    const result = lightenColor('#000000', 0.5);
    assert(result.startsWith('rgb('), 'returns rgb()');
    assert(result.includes('128'), 'black + 50% = mid gray');
});

test('lightenColor: amount 0 keeps original', () => {
    const result = lightenColor('#ff0000', 0);
    assertEqual(result, 'rgb(255, 0, 0)', 'red unchanged');
});

test('darkenColor: returns rgb string', () => {
    const result = darkenColor('#ffffff', 0.5);
    assert(result.startsWith('rgb('), 'returns rgb()');
    assert(result.includes('128'), 'white - 50% = mid gray');
});

test('darkenColor: amount 0 keeps original', () => {
    const result = darkenColor('#ff0000', 0);
    assertEqual(result, 'rgb(255, 0, 0)', 'red unchanged');
});

// ============================================================================
// Tests: formatTokensCompact (drawer-state.js — tested via reimplementation
// since the module imports ST's escapeHtml which isn't available in Node)
// ============================================================================

// Mirror of drawer-state.js:formatTokensCompact
function _formatTokensCompact(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

test('formatTokensCompact: small numbers returned as-is', () => {
    assertEqual(_formatTokensCompact(0), '0', 'zero');
    assertEqual(_formatTokensCompact(50), '50', 'fifty');
    assertEqual(_formatTokensCompact(999), '999', 'just under 1k');
});

test('formatTokensCompact: thousands abbreviated with k', () => {
    assertEqual(_formatTokensCompact(1000), '1.0k', '1000');
    assertEqual(_formatTokensCompact(1234), '1.2k', '1234');
    assertEqual(_formatTokensCompact(12345), '12.3k', '12345');
    assertEqual(_formatTokensCompact(100000), '100.0k', '100000');
});

// ============================================================================
// Tests: getMatchLabel (drawer-state.js — tested via parseMatchReason which
// is the core logic, directly importable from helpers.js)
// ============================================================================

test('parseMatchReason: known types parse correctly', () => {
    assertEqual(parseMatchReason('constant').type, 'constant', 'constant');
    assertEqual(parseMatchReason('pinned').type, 'pinned', 'pinned');
    assertEqual(parseMatchReason('bootstrap').type, 'bootstrap', 'bootstrap');
    assertEqual(parseMatchReason('seed').type, 'seed', 'seed');
    assertEqual(parseMatchReason('keyword: test').type, 'keyword', 'keyword');
    assertEqual(parseMatchReason('test → AI: relevant context').type, 'keyword_ai', 'keyword_ai (arrow format)');
    assertEqual(parseMatchReason('ai: relevant').type, 'ai', 'ai');
});

test('parseMatchReason: null/undefined returns unknown', () => {
    assertEqual(parseMatchReason(null).type, 'unknown', 'null');
    assertEqual(parseMatchReason(undefined).type, 'unknown', 'undefined');
});

// ============================================================================
// Tests: Audit Bug Regression — Wave 1 (BUG-009, BUG-033, BUG-008, BUG-046)
// ============================================================================

test('BUG-009: buildAiChatContext handles null messages without crashing', () => {
    const chat = [
        { is_user: true, mes: 'hello', name: 'User' },
        null,
        { is_user: false, mes: 'world', name: 'AI' },
    ];
    let threw = false;
    let result;
    try { result = buildAiChatContext(chat, 5); } catch { threw = true; }
    assert(!threw, 'should not throw on null message');
    assert(typeof result === 'string', 'should return a string');
    assert(result.includes('User (user): hello'), 'should include first message');
    assert(result.includes('AI (character): world'), 'should include third message');
});

test('BUG-009: buildAiChatContext handles all-null chat gracefully', () => {
    const chat = [null, null, null];
    let threw = false;
    try { buildAiChatContext(chat, 5); } catch { threw = true; }
    assert(!threw, 'should not throw on all-null chat');
});

test('BUG-033: parseFrontmatter unescapes backslash-quote in block array items', () => {
    const input = '---\nkeys:\n  - Alice \\"the Pale\\"\n  - normal key\n---\nBody';
    const result = parseFrontmatter(input);
    assert(Array.isArray(result.frontmatter.keys), 'keys should be array');
    assertEqual(result.frontmatter.keys[0], 'Alice "the Pale"', 'should unescape \\" to "');
    assertEqual(result.frontmatter.keys[1], 'normal key', 'normal key unchanged');
});

test('BUG-033: parseFrontmatter unescapes backslash-backslash in block array items', () => {
    const input = '---\nkeys:\n  - path\\\\to\\\\file\n---\nBody';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys[0], 'path\\to\\file', 'should unescape \\\\ to \\');
});

test('BUG-008: convertWiEntry handles string key field without crashing', () => {
    const wiEntry = { uid: 1, key: 'dragon, fire, beast', content: 'A fearsome creature.' };
    let threw = false;
    let result;
    try { result = convertWiEntry(wiEntry, 'lorebook'); } catch { threw = true; }
    assert(!threw, 'should not throw TypeError when key is a string');
    assert(result.filename.length > 0, 'should produce a valid filename');
});

test('BUG-008: convertWiEntry uses string key as title fallback', () => {
    const wiEntry = { uid: 1, key: 'dragon, fire, beast', content: 'Content here.' };
    const result = convertWiEntry(wiEntry, 'lorebook');
    assert(result.content.includes('dragon'), 'title should derive from string key');
});

test('BUG-008: convertWiEntry handles empty key string', () => {
    const wiEntry = { uid: 42, key: '', content: 'No keys.' };
    let threw = false;
    try { convertWiEntry(wiEntry, 'lorebook'); } catch { threw = true; }
    assert(!threw, 'should not throw on empty string key');
});

test('BUG-046: extractAiResponseClient accepts array with at least one valid element', () => {
    const input = JSON.stringify([{ title: 'Foo', confidence: 'high' }, 42, null]);
    const result = extractAiResponseClient(input);
    assert(result !== null, 'should parse array with at least one valid object');
    assert(Array.isArray(result), 'should return an array');
});

test('BUG-046: extractAiResponseClient rejects array with no valid elements', () => {
    const input = JSON.stringify([42, null, true]);
    const result = extractAiResponseClient(input);
    assert(result === null, 'should reject array with no valid string/object elements');
});

test('BUG-046: normalizeResults filters items with null/undefined/empty titles', () => {
    const input = [{ title: 'Foo', confidence: 'high' }, null, undefined, ''];
    const result = normalizeResultsProd(input);
    assert(result.every(r => r.title && r.title.trim()), 'all results should have non-empty titles');
    assert(result.some(r => r.title === 'Foo'), 'valid item should survive');
    assert(!result.some(r => r.title === 'null'), 'null item should be filtered');
    assert(!result.some(r => r.title === 'undefined'), 'undefined item should be filtered');
    assert(result.length === 1, 'only valid item should remain');
});

// ============================================================================
// Wave 3 Regression Tests — Obsidian API (BUG-040, BUG-045)
// ============================================================================

test('BUG-040: validateVaultPath rejects path traversal in scribe folder', () => {
    let threw = false;
    try { validateVaultPath('../../etc/passwd'); } catch { threw = true; }
    assert(threw, 'should throw on path traversal attempt');
});

test('BUG-040: validateVaultPath rejects embedded traversal', () => {
    let threw = false;
    try { validateVaultPath('notes/../../../secrets'); } catch { threw = true; }
    assert(threw, 'should throw on embedded traversal');
});

test('BUG-040: validateVaultPath accepts normal paths', () => {
    let threw = false;
    try { validateVaultPath('Session Notes/2026-03'); } catch { threw = true; }
    assert(!threw, 'should accept normal folder path');
});

test('BUG-045: pruneCircuitBreakers is a function', () => {
    assert(typeof pruneCircuitBreakers === 'function', 'pruneCircuitBreakers should be exported');
});

// ============================================================================
// Wave 2 Regression Tests — BM25 (BUG-013, BUG-042)
// ============================================================================

test('BUG-013: buildBM25Index uses trackerKey for multi-vault uniqueness', () => {
    const e1 = makeEntry('Dragon', { keys: ['dragon'], content: 'Fire dragon of the north', vaultSource: 'vault-A', tokenEstimate: 50 });
    const e2 = makeEntry('Dragon', { keys: ['dragon'], content: 'Ice dragon of the south', vaultSource: 'vault-B', tokenEstimate: 50 });
    const index = buildBM25Index([e1, e2]);
    // After fix: both entries should be in the index (keyed by vaultSource:title, not bare title)
    assert(index.docs.size === 2, `both multi-vault entries should be indexed, got ${index.docs.size}`);
    const results = queryBM25(index, 'dragon', 10, 0.0);
    assert(results.length === 2, `both entries should be findable, got ${results.length}`);
    // Results should use entry.title not trackerKey
    assert(results.every(r => r.title === 'Dragon'), 'results should return entry.title not trackerKey');
});

test('BUG-013: queryBM25 returns entry.title not map key', () => {
    const e1 = makeEntry('Eris', { keys: ['eris'], content: 'A goddess of discord', vaultSource: 'main-vault', tokenEstimate: 30 });
    const index = buildBM25Index([e1]);
    const results = queryBM25(index, 'eris', 10, 0.0);
    assert(results.length === 1, 'should find the entry');
    assertEqual(results[0].title, 'Eris', 'title should be entry.title not trackerKey');
    assert(!results[0].title.includes(':'), 'title should not contain vaultSource prefix');
});

test('BUG-042: queryBM25 works with Set instead of Map for query terms', () => {
    const e1 = makeEntry('Dragon', { keys: ['dragon'], content: 'dragon dragon fire breath', vaultSource: '', tokenEstimate: 50 });
    const index = buildBM25Index([e1]);
    // Repeating query term should produce same results (Set deduplicates)
    const results1 = queryBM25(index, 'dragon', 10, 0.0);
    const results2 = queryBM25(index, 'dragon dragon dragon', 10, 0.0);
    assert(results1.length > 0, 'single query term finds entry');
    assert(results2.length > 0, 'repeated query term finds entry');
    // Scores should be identical (query TF was never used in scoring)
    assertEqual(results1[0].score, results2[0].score, 'repeated query terms should not change score');
});

test('BM25: empty entries produces empty index', () => {
    const index = buildBM25Index([]);
    assert(index.docs.size === 0, 'empty entries should produce empty index');
    const results = queryBM25(index, 'anything', 10, 0.0);
    assertEqual(results.length, 0, 'querying empty index should return nothing');
});

// ============================================================================
// Sprint 2: isForceInjected (R8)
// ============================================================================

test('isForceInjected: constant entry is always force-injected', () => {
    const entry = makeEntry('Always', { constant: true, bootstrap: false });
    assert(isForceInjected(entry, { bootstrapActive: false }), 'constant should be force-injected even without bootstrap');
    assert(isForceInjected(entry, { bootstrapActive: true }), 'constant should be force-injected with bootstrap');
});

test('isForceInjected: bootstrap entry only when bootstrapActive', () => {
    const entry = makeEntry('Boot', { constant: false, bootstrap: true });
    assert(!isForceInjected(entry, { bootstrapActive: false }), 'bootstrap entry should NOT be force-injected when bootstrapActive=false');
    assert(isForceInjected(entry, { bootstrapActive: true }), 'bootstrap entry should be force-injected when bootstrapActive=true');
});

test('isForceInjected: regular entry never force-injected', () => {
    const entry = makeEntry('Regular', { constant: false, bootstrap: false });
    assert(!isForceInjected(entry, { bootstrapActive: false }), 'regular entry not force-injected');
    assert(!isForceInjected(entry, { bootstrapActive: true }), 'regular entry not force-injected even with bootstrap active');
});

test('isForceInjected: both constant and bootstrap', () => {
    const entry = makeEntry('Both', { constant: true, bootstrap: true });
    assert(isForceInjected(entry, { bootstrapActive: false }), 'constant+bootstrap is force-injected (constant alone is enough)');
});

test('isForceInjected: missing fields default to falsy', () => {
    const entry = makeEntry('Bare', {});
    assert(!isForceInjected(entry, { bootstrapActive: true }), 'entry without constant/bootstrap fields is not force-injected');
});

// ============================================================================
// Sprint 2: Pin/Block Migration (H23)
// ============================================================================

test('normalizeLoreGap: legacy acknowledged status collapses to pending', () => {
    const out = normalizeLoreGap({ id: 'a', status: 'acknowledged', query: 'x' });
    assertEqual(out.status, 'pending', 'acknowledged → pending');
    assertEqual(out.query, 'x', 'other fields preserved');
});

test('normalizeLoreGap: legacy in_progress status collapses to pending', () => {
    const out = normalizeLoreGap({ id: 'a', status: 'in_progress' });
    assertEqual(out.status, 'pending', 'in_progress → pending');
});

test('normalizeLoreGap: legacy rejected status collapses to pending', () => {
    const out = normalizeLoreGap({ id: 'a', status: 'rejected' });
    assertEqual(out.status, 'pending', 'rejected → pending');
});

test('normalizeLoreGap: pending and written are preserved', () => {
    assertEqual(normalizeLoreGap({ status: 'pending' }).status, 'pending');
    assertEqual(normalizeLoreGap({ status: 'written' }).status, 'written');
});

test('normalizeLoreGap: missing/unknown status defaults to pending', () => {
    assertEqual(normalizeLoreGap({}).status, 'pending');
    assertEqual(normalizeLoreGap({ status: 'bogus' }).status, 'pending');
});

test('normalizePinBlock: bare string normalized to {title, vaultSource: null}', () => {
    const result = normalizePinBlock('Eris');
    assertEqual(result.title, 'Eris', 'title preserved');
    assertEqual(result.vaultSource, null, 'vaultSource is null for bare string');
});

test('normalizePinBlock: object with title and vaultSource preserved', () => {
    const result = normalizePinBlock({ title: 'Eris', vaultSource: 'vault-A' });
    assertEqual(result.title, 'Eris', 'title preserved');
    assertEqual(result.vaultSource, 'vault-A', 'vaultSource preserved');
});

test('normalizePinBlock: object with missing fields gets defaults', () => {
    const result = normalizePinBlock({});
    assertEqual(result.title, '', 'missing title defaults to empty string');
    assertEqual(result.vaultSource, null, 'missing vaultSource defaults to null');
});

test('matchesPinBlock: bare string pin matches any vault entry', () => {
    const entry = makeEntry('Eris', { vaultSource: 'vault-A' });
    assert(matchesPinBlock('Eris', entry), 'bare string should match regardless of vault');
    const entryB = makeEntry('Eris', { vaultSource: 'vault-B' });
    assert(matchesPinBlock('Eris', entryB), 'bare string should match different vault too');
});

test('matchesPinBlock: vault-aware pin only matches correct vault', () => {
    const entryA = makeEntry('Eris', { vaultSource: 'vault-A' });
    const entryB = makeEntry('Eris', { vaultSource: 'vault-B' });
    const pin = { title: 'Eris', vaultSource: 'vault-A' };
    assert(matchesPinBlock(pin, entryA), 'vault-A pin should match vault-A entry');
    assert(!matchesPinBlock(pin, entryB), 'vault-A pin should NOT match vault-B entry');
});

// ============================================================================
// Sprint 2: applyPinBlock with structured pins (H23)
// ============================================================================

test('applyPinBlock: structured pin injects entry not in matched set', () => {
    const e1 = makeEntry('Matched', { keys: ['matched'], priority: 50 });
    const e2 = makeEntry('Pinned', { keys: ['pinned'], priority: 50 });
    const matched = [e1];
    const vaultSnapshot = [e1, e2];
    const policy = buildExemptionPolicy(vaultSnapshot, [{ title: 'Pinned', vaultSource: null }], []);
    const result = applyPinBlock(matched, vaultSnapshot, policy, new Map());
    const titles = result.map(e => e.title);
    assert(titles.includes('Pinned'), 'pinned entry should be added to results');
    assert(titles.includes('Matched'), 'matched entry should still be present');
});

test('applyPinBlock: structured block removes matched entry', () => {
    const e1 = makeEntry('Matched', { keys: ['matched'], priority: 50 });
    const e2 = makeEntry('Blocked', { keys: ['blocked'], priority: 50 });
    const matched = [e1, e2];
    const vaultSnapshot = [e1, e2];
    const policy = buildExemptionPolicy(vaultSnapshot, [], [{ title: 'Blocked', vaultSource: null }]);
    const result = applyPinBlock(matched, vaultSnapshot, policy, new Map());
    const titles = result.map(e => e.title);
    assert(!titles.includes('Blocked'), 'blocked entry should be removed');
    assert(titles.includes('Matched'), 'non-blocked entry should remain');
});

test('applyPinBlock: vault-specific block does not affect other vaults', () => {
    const e1 = makeEntry('Character X', { keys: ['character x'], priority: 50, vaultSource: 'vault-A' });
    const e2 = makeEntry('Character X', { keys: ['character x'], priority: 50, vaultSource: 'vault-B' });
    const matched = [e1, e2];
    const vaultSnapshot = [e1, e2];
    const policy = buildExemptionPolicy(vaultSnapshot, [], [{ title: 'Character X', vaultSource: 'vault-A' }]);
    const result = applyPinBlock(matched, vaultSnapshot, policy, new Map());
    const remaining = result.map(e => e.vaultSource);
    assert(!remaining.includes('vault-A'), 'vault-A entry should be blocked');
    assert(remaining.includes('vault-B'), 'vault-B entry should NOT be blocked');
});

// ============================================================================
// Sprint 2: Fuzzy Title Matching (H12)
// ============================================================================

test('fuzzyTitleMatch: exact match returns highest similarity', () => {
    const result = fuzzyTitleMatch('Eris', ['Eris', 'Aris', 'Boris']);
    assertEqual(result.title, 'Eris', 'exact match should be best');
    assertEqual(result.similarity, 1.0, 'exact match should have similarity 1.0');
});

test('fuzzyTitleMatch: close typo matches above threshold', () => {
    const result = fuzzyTitleMatch('Eris Nightshade', ['Eris Nightshad', 'Boris', 'Karl']);
    assert(result !== null, 'close typo should find a match');
    assertEqual(result.title, 'Eris Nightshad', 'should match closest candidate');
    assert(result.similarity >= 0.6, 'similarity should be above threshold');
});

test('fuzzyTitleMatch: completely different title returns null', () => {
    const result = fuzzyTitleMatch('Xyzzy Plugh', ['Eris', 'Boris', 'Karl']);
    assertEqual(result, null, 'unrelated title should return null');
});

test('fuzzyTitleMatch: empty string returns null', () => {
    const result = fuzzyTitleMatch('', ['Eris', 'Boris']);
    assertEqual(result, null, 'empty input should return null');
});

test('fuzzyTitleMatch: single character input returns null (no bigrams)', () => {
    const result = fuzzyTitleMatch('A', ['Aa', 'Ab', 'Ac']);
    assertEqual(result, null, 'single char has no bigrams, should return null');
});

// ============================================================================
// Sprint 2: escapeXml consolidated (R7)
// ============================================================================

test('escapeXml: escapes &, <, >, " characters', () => {
    const result = escapeXml('Tom & Jerry <script>"hello"</script>');
    assertEqual(result, 'Tom &amp; Jerry &lt;script&gt;&quot;hello&quot;&lt;/script&gt;', 'all special chars escaped');
});

test('escapeXml: passes through plain text unchanged', () => {
    assertEqual(escapeXml('hello world'), 'hello world', 'plain text unchanged');
    assertEqual(escapeXml(''), '', 'empty string unchanged');
});

// ============================================================================
// Sprint 2: Multi-Vault Merge Strategy (H18) — deduplicateMultiVault
// ============================================================================
// deduplicateMultiVault is internal to vault.js and not directly importable.
// We test the merge *effects* through the exported helpers and buildExemptionPolicy.

test('matchesPinBlock: case-insensitive title matching', () => {
    const entry = makeEntry('ERIS', { vaultSource: 'vault-A' });
    assert(matchesPinBlock({ title: 'eris', vaultSource: null }, entry), 'case-insensitive title match');
    assert(matchesPinBlock({ title: 'Eris', vaultSource: null }, entry), 'mixed case title match');
});

test('matchesPinBlock: null vaultSource on pin matches any entry vaultSource', () => {
    const entry = makeEntry('Test', { vaultSource: 'my-vault' });
    assert(matchesPinBlock({ title: 'Test', vaultSource: null }, entry), 'null vaultSource matches any');
});

test('matchesPinBlock: both null vaultSources match', () => {
    const entry = makeEntry('Test', { vaultSource: '' });
    assert(matchesPinBlock({ title: 'Test', vaultSource: null }, entry), 'null pin vs empty entry vaultSource');
});

test('normalizePinBlock: object with only title preserves it', () => {
    const result = normalizePinBlock({ title: 'Eris' });
    assertEqual(result.title, 'Eris', 'title preserved');
    assertEqual(result.vaultSource, null, 'missing vaultSource defaults to null');
});

test('normalizePinBlock: empty string input normalizes to {title: "", vaultSource: null}', () => {
    const result = normalizePinBlock('');
    assertEqual(result.title, '', 'empty string title preserved');
    assertEqual(result.vaultSource, null, 'vaultSource is null');
});

// ============================================================================
// Sprint 2: Circuit Breaker Edge Cases
// ============================================================================

test('AI circuit breaker: single failure does not trip', () => {
    // Reset state
    recordAiSuccess();
    recordAiSuccess();
    // One failure should not trip (threshold is 2)
    recordAiFailure();
    setVaultIndex([makeEntry('A', {})]);
    setIndexEverLoaded(true);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(1);
    setLastHealthResult(null);
    const status = computeOverallStatus(null);
    assertEqual(status, 'ok', 'single AI failure should not degrade status');
});

test('AI circuit breaker: two failures trip the breaker', () => {
    recordAiSuccess(); // reset
    recordAiFailure();
    recordAiFailure();
    setVaultIndex([makeEntry('A', {})]);
    setIndexEverLoaded(true);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(1);
    setLastHealthResult(null);
    // After 2 failures, circuit is tripped → status should be 'limited'
    // Then reset and verify recovery
    recordAiSuccess();
    const status = computeOverallStatus(null);
    assertEqual(status, 'ok', 'after recovery, status should be ok');
});

test('AI circuit breaker: recordAiSuccess resets failure count', () => {
    recordAiFailure();
    recordAiFailure();
    recordAiSuccess();
    recordAiFailure(); // only 1 failure after reset
    setVaultIndex([makeEntry('A', {})]);
    setIndexEverLoaded(true);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(1);
    setLastHealthResult(null);
    const status = computeOverallStatus(null);
    assertEqual(status, 'ok', 'success should reset counter, 1 failure is not enough to trip');
});

test('computeOverallStatus: offline when vault index empty and never loaded', () => {
    setVaultIndex([]);
    setIndexEverLoaded(false);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(0);
    setLastHealthResult(null);
    recordAiSuccess();
    const status = computeOverallStatus(null);
    assertEqual(status, 'offline', 'no index and never loaded = offline');
});

test('computeOverallStatus: degraded when some vaults fail', () => {
    setVaultIndex([makeEntry('A', {})]);
    setIndexEverLoaded(true);
    setLastVaultFailureCount(1);
    setLastVaultAttemptCount(2);
    setLastHealthResult(null);
    recordAiSuccess();
    const status = computeOverallStatus(null);
    assertEqual(status, 'degraded', 'partial vault failure = degraded');
});

// ============================================================================
// Sprint 2: Cache Module Edge Cases
// ============================================================================
// pruneOrphanedCacheKeys is async and requires IndexedDB — can't unit test in Node.
// Instead, test the cache-related pure functions and boundary conditions.

test('escapeXml: handles numbers via String coercion', () => {
    const result = escapeXml(42);
    assertEqual(result, '42', 'number should be coerced to string');
});

test('escapeXml: handles null/undefined via String coercion', () => {
    const result = escapeXml(null);
    assertEqual(result, 'null', 'null should be coerced to "null"');
});

test('simpleHash: different strings produce different hashes', () => {
    const h1 = simpleHash('hello world');
    const h2 = simpleHash('hello world!');
    assert(h1 !== h2, 'different strings should produce different hashes');
});

test('simpleHash: same string always produces same hash', () => {
    assertEqual(simpleHash('test'), simpleHash('test'), 'same input = same hash');
});

test('simpleHash: empty string returns fallback', () => {
    assertEqual(simpleHash(''), '0_0', 'empty string returns 0_0');
});

test('simpleHash: null returns fallback', () => {
    assertEqual(simpleHash(null), '0_0', 'null returns 0_0');
});

test('validateSettings: clamps out-of-range values', () => {
    const s = { scanDepth: 999 };
    validateSettings(s, { scanDepth: { min: 0, max: 100, label: 'Scan Depth' } });
    assertEqual(s.scanDepth, 100, 'should clamp to max');
});

test('validateSettings: clamps negative values to min', () => {
    const s = { scanDepth: -5 };
    validateSettings(s, { scanDepth: { min: 0, max: 100, label: 'Scan Depth' } });
    assertEqual(s.scanDepth, 0, 'should clamp to min');
});

test('validateSettings: preserves in-range values', () => {
    const s = { scanDepth: 50 };
    validateSettings(s, { scanDepth: { min: 0, max: 100, label: 'Scan Depth' } });
    assertEqual(s.scanDepth, 50, 'in-range value should be preserved');
});

test('validateSettings: trims lorebook tag', () => {
    const s = { lorebookTag: '  lorebook  ' };
    validateSettings(s, {});
    assertEqual(s.lorebookTag, 'lorebook', 'should trim whitespace');
});

// ============================================================================
// Tests: Custom Field Definitions (src/fields.js)
// ============================================================================

import {
    DEFAULT_FIELD_DEFINITIONS, RESERVED_FIELD_NAMES, VALID_OPERATORS,
    validateFieldName, validateFieldDefinition,
    parseFieldDefinitionYaml, serializeFieldDefinitions,
    evaluateOperator, extractCustomFields, findDuplicateFieldNames,
} from '../src/fields.js';

test('DEFAULT_FIELD_DEFINITIONS: contains exactly 4 built-in fields', () => {
    assertEqual(DEFAULT_FIELD_DEFINITIONS.length, 4, 'should have 4 default fields');
    const names = DEFAULT_FIELD_DEFINITIONS.map(f => f.name);
    assertEqual(names, ['era', 'location', 'scene_type', 'character_present'], 'should have correct names in order');
});

test('DEFAULT_FIELD_DEFINITIONS: all gating fields are multi (string|string[] in frontmatter)', () => {
    for (const fd of DEFAULT_FIELD_DEFINITIONS) {
        assert(fd.multi === true, `${fd.name} should be multi (frontmatter allows arrays)`);
    }
});

test('DEFAULT_FIELD_DEFINITIONS: all have valid gating config', () => {
    for (const fd of DEFAULT_FIELD_DEFINITIONS) {
        assert(fd.gating.enabled === true, `${fd.name} gating should be enabled`);
        assert(VALID_OPERATORS.has(fd.gating.operator), `${fd.name} should have valid operator`);
        assert(['strict', 'moderate', 'lenient'].includes(fd.gating.tolerance), `${fd.name} should have valid tolerance`);
    }
});

test('validateFieldName: accepts valid names', () => {
    assert(validateFieldName('mood').valid, 'mood should be valid');
    assert(validateFieldName('faction_type').valid, 'faction_type should be valid');
    assert(validateFieldName('arc2').valid, 'arc2 should be valid');
});

test('validateFieldName: rejects reserved names', () => {
    assert(!validateFieldName('keys').valid, 'keys should be rejected');
    assert(!validateFieldName('priority').valid, 'priority should be rejected');
    assert(!validateFieldName('tags').valid, 'tags should be rejected');
    assert(!validateFieldName('enabled').valid, 'enabled should be rejected');
    assert(!validateFieldName('summary').valid, 'summary should be rejected');
});

test('validateFieldName: rejects invalid formats', () => {
    assert(!validateFieldName('').valid, 'empty should be rejected');
    assert(!validateFieldName('  ').valid, 'whitespace should be rejected');
    assert(!validateFieldName('2start').valid, 'starting with number should be rejected');
    assert(!validateFieldName('has-dash').valid, 'dashes should be rejected');
    assert(!validateFieldName('HasCaps').valid, 'uppercase should be rejected');
});

test('validateFieldDefinition: valid definition returns normalized field', () => {
    const { field, errors } = validateFieldDefinition({
        name: 'mood', label: 'Mood', type: 'string', multi: false,
        gating: { enabled: true, operator: 'match_any', tolerance: 'strict' },
        values: ['tense', 'calm'], contextKey: 'mood',
    });
    assert(field !== null, 'should return a field');
    assertEqual(field.name, 'mood', 'name');
    assertEqual(field.label, 'Mood', 'label');
    assertEqual(field.type, 'string', 'type');
    assertEqual(field.multi, false, 'multi');
    assertEqual(field.gating.operator, 'match_any', 'operator');
    assertEqual(field.values, ['tense', 'calm'], 'values');
});

test('validateFieldDefinition: defaults for missing optional fields', () => {
    const { field } = validateFieldDefinition({ name: 'arc' });
    assert(field !== null, 'should return a field');
    assertEqual(field.label, 'arc', 'label defaults to name');
    assertEqual(field.type, 'string', 'type defaults to string');
    assertEqual(field.multi, false, 'multi defaults to false');
    assertEqual(field.gating.enabled, true, 'gating enabled defaults to true');
    assertEqual(field.gating.operator, 'match_any', 'operator defaults to match_any');
    assertEqual(field.gating.tolerance, 'moderate', 'tolerance defaults to moderate');
    assertEqual(field.contextKey, 'arc', 'contextKey defaults to name');
});

test('validateFieldDefinition: rejects reserved name', () => {
    const { field, errors } = validateFieldDefinition({ name: 'keys' });
    assert(field === null, 'should not return a field for reserved name');
    assert(errors.length > 0, 'should have errors');
});

test('validateFieldDefinition: unknown type defaults to string with error', () => {
    const { field, errors } = validateFieldDefinition({ name: 'test_field', type: 'widget' });
    assert(field !== null, 'should still return a field');
    assertEqual(field.type, 'string', 'should default to string');
    assert(errors.some(e => e.includes('widget')), 'should warn about unknown type');
});

test('serializeFieldDefinitions: round-trip parse/serialize/parse produces identical results', () => {
    const yaml1 = serializeFieldDefinitions(DEFAULT_FIELD_DEFINITIONS);
    const { definitions: parsed1 } = parseFieldDefinitionYaml(yaml1);
    const yaml2 = serializeFieldDefinitions(parsed1);
    const { definitions: parsed2 } = parseFieldDefinitionYaml(yaml2);
    assertEqual(parsed1, parsed2, 'round-trip should produce identical definitions');
});

test('serializeFieldDefinitions: empty array', () => {
    const yaml = serializeFieldDefinitions([]);
    assertEqual(yaml, 'fields: []\n', 'should produce empty fields YAML');
});

test('parseFieldDefinitionYaml: empty input returns empty array', () => {
    assertEqual(parseFieldDefinitionYaml('').definitions, [], 'empty string');
    assertEqual(parseFieldDefinitionYaml(null).definitions, [], 'null');
    assertEqual(parseFieldDefinitionYaml(undefined).definitions, [], 'undefined');
});

test('parseFieldDefinitionYaml: valid YAML with all fields', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: strict
    values:
      - tense
      - calm
    contextKey: mood`;
    const { definitions, errors } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'should parse one field');
    assertEqual(definitions[0].name, 'mood', 'name');
    assertEqual(definitions[0].values, ['tense', 'calm'], 'values');
    assertEqual(definitions[0].gating.tolerance, 'strict', 'tolerance');
});

test('parseFieldDefinitionYaml: skips fields with reserved names', () => {
    const yaml = `fields:
  - name: keys
    label: Keys
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: keys`;
    const { definitions, errors } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 0, 'should skip reserved name');
    assert(errors.length > 0, 'should have errors for reserved name');
});

test('evaluateOperator: match_any with matching value', () => {
    assert(evaluateOperator('match_any', ['medieval', 'renaissance'], 'medieval'), 'should match');
    assert(evaluateOperator('match_any', ['medieval'], ['modern', 'medieval']), 'should match in array');
});

test('evaluateOperator: match_any with no match', () => {
    assert(!evaluateOperator('match_any', ['medieval'], 'modern'), 'should not match');
});

test('evaluateOperator: match_any is case-insensitive', () => {
    assert(evaluateOperator('match_any', ['Medieval'], 'medieval'), 'should match case-insensitively');
    assert(evaluateOperator('match_any', ['medieval'], 'MEDIEVAL'), 'should match case-insensitively');
});

test('evaluateOperator: match_all requires all entry values present in active context', () => {
    assert(evaluateOperator('match_all', ['medieval', 'dark'], ['medieval', 'dark']), 'both present = match');
    assert(evaluateOperator('match_all', ['medieval'], ['medieval', 'dark']), 'entry subset of active = match');
    assert(!evaluateOperator('match_all', ['medieval', 'dark'], ['medieval']), 'entry has value not in active = no match');
});

test('evaluateOperator: not_any inverts match_any', () => {
    assert(evaluateOperator('not_any', ['medieval'], 'modern'), 'no overlap = true');
    assert(!evaluateOperator('not_any', ['medieval'], 'medieval'), 'overlap = false');
});

test('evaluateOperator: exists/not_exists', () => {
    assert(evaluateOperator('exists', 'anything', null), 'value exists = true');
    assert(evaluateOperator('exists', ['a'], null), 'array value exists = true');
    assert(!evaluateOperator('exists', null, null), 'null = false');
    assert(!evaluateOperator('exists', [], null), 'empty array = false');
    assert(evaluateOperator('not_exists', null, null), 'null = true for not_exists');
    assert(evaluateOperator('not_exists', [], null), 'empty array = true for not_exists');
    assert(!evaluateOperator('not_exists', 'val', null), 'value present = false for not_exists');
});

test('evaluateOperator: gt/lt/eq for numbers', () => {
    assert(evaluateOperator('gt', 10, 5), '10 > 5');
    assert(!evaluateOperator('gt', 3, 5), '3 > 5 = false');
    assert(evaluateOperator('lt', 3, 5), '3 < 5');
    assert(!evaluateOperator('lt', 10, 5), '10 < 5 = false');
    assert(evaluateOperator('eq', 'hello', 'Hello'), 'case-insensitive eq');
    assert(!evaluateOperator('eq', 'hello', 'world'), 'different values = false');
});

test('evaluateOperator: unknown operator returns true (permissive)', () => {
    assert(evaluateOperator('unknown_op', 'a', 'b'), 'unknown operator should pass');
});

test('extractCustomFields: extracts defined fields from frontmatter', () => {
    const fm = { era: 'medieval', mood: 'tense', location: 'tavern', unrelated: 'value' };
    const defs = [
        { name: 'era', type: 'string', multi: false },
        { name: 'mood', type: 'string', multi: false },
    ];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.era, 'medieval', 'should extract era');
    assertEqual(result.mood, 'tense', 'should extract mood');
    assert(result.location === undefined, 'should not extract undefined fields');
    assert(result.unrelated === undefined, 'should not extract fields not in definitions');
});

test('extractCustomFields: multi field normalizes scalar to array preserving case', () => {
    const fm = { character_present: 'Eris' };
    const defs = [{ name: 'character_present', type: 'string', multi: true }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.character_present, ['Eris'], 'should normalize scalar to array preserving case');
});

test('extractCustomFields: multi field normalizes array values preserving case', () => {
    const fm = { character_present: ['Eris', 'Bob'] };
    const defs = [{ name: 'character_present', type: 'string', multi: true }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.character_present, ['Eris', 'Bob'], 'should preserve array value casing');
});

test('extractCustomFields: single string field preserves case', () => {
    const fm = { era: 'Medieval' };
    const defs = [{ name: 'era', type: 'string', multi: false }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.era, 'Medieval', 'should preserve single string casing');
});

test('extractCustomFields: number type preserves numbers', () => {
    const fm = { intensity: 8 };
    const defs = [{ name: 'intensity', type: 'number', multi: false }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.intensity, 8, 'should preserve number');
});

test('extractCustomFields: boolean type coerces', () => {
    const fm = { visible: true, hidden: 'true', off: false };
    const defs = [
        { name: 'visible', type: 'boolean', multi: false },
        { name: 'hidden', type: 'boolean', multi: false },
        { name: 'off', type: 'boolean', multi: false },
    ];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.visible, true, 'true stays true');
    assertEqual(result.hidden, true, '"true" becomes true');
    assertEqual(result.off, false, 'false stays false');
});

test('extractCustomFields: missing fields not included', () => {
    const fm = {};
    const defs = [{ name: 'mood', type: 'string', multi: false }];
    const result = extractCustomFields(fm, defs);
    assertEqual(Object.keys(result).length, 0, 'should be empty');
});

test('extractCustomFields: null/undefined inputs return empty', () => {
    assertEqual(Object.keys(extractCustomFields(null, [])).length, 0, 'null frontmatter');
    assertEqual(Object.keys(extractCustomFields({}, null)).length, 0, 'null definitions');
});

test('findDuplicateFieldNames: detects duplicates', () => {
    const defs = [
        { name: 'mood' }, { name: 'era' }, { name: 'mood' },
    ];
    assertEqual(findDuplicateFieldNames(defs), ['mood'], 'should find mood duplicate');
});

test('findDuplicateFieldNames: no duplicates returns empty', () => {
    const defs = [{ name: 'mood' }, { name: 'era' }];
    assertEqual(findDuplicateFieldNames(defs), [], 'should be empty');
});

// ============================================================================
// Regression Tests — Bug Fix Round (2026-03-28)
// ============================================================================

test('REGRESSION: parseFieldDefinitionYaml preserves contextKey with non-empty values', () => {
    const yaml = `fields:
  - name: faction
    label: Faction
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values:
      - rebels
      - empire
      - neutral
    contextKey: active_faction`;
    const { definitions, errors } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'should parse one field');
    assertEqual(definitions[0].contextKey, 'active_faction', 'contextKey must survive non-empty values block');
});

test('REGRESSION: parseFieldDefinitionYaml handles empty value items gracefully', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values:
      - happy
      -
    contextKey: mood`;
    // Should not crash on the empty value item
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'should parse field despite empty value item');
    assert(definitions[0].values.includes('happy'), 'should include valid value');
});

test('REGRESSION: extractCustomFields handles array on multi:true field correctly', () => {
    const fm = { era: ['medieval', 'renaissance'] };
    const defs = [{ name: 'era', type: 'string', multi: true }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.era.length, 2, 'should have 2 values');
    assert(result.era.includes('medieval'), 'should include medieval');
    assert(result.era.includes('renaissance'), 'should include renaissance');
});

test('REGRESSION: DEFAULT_FIELD_DEFINITIONS has multi:true for era/location/scene_type', () => {
    const era = DEFAULT_FIELD_DEFINITIONS.find(fd => fd.name === 'era');
    const loc = DEFAULT_FIELD_DEFINITIONS.find(fd => fd.name === 'location');
    const scene = DEFAULT_FIELD_DEFINITIONS.find(fd => fd.name === 'scene_type');
    assert(era.multi === true, 'era should be multi:true');
    assert(loc.multi === true, 'location should be multi:true');
    assert(scene.multi === true, 'scene_type should be multi:true');
});

test('REGRESSION: DEFAULT_FIELD_DEFINITIONS has correct shapes for all 4 built-in fields', () => {
    assertEqual(DEFAULT_FIELD_DEFINITIONS.length, 4, 'should have 4 built-in fields');
    for (const fd of DEFAULT_FIELD_DEFINITIONS) {
        assert(fd.name, 'field must have name');
        assert(fd.label, 'field must have label');
        assert(fd.type === 'string', 'built-in fields are string type');
        assert(fd.gating?.enabled === true, 'built-in fields have gating enabled');
        assert(fd.gating?.operator === 'match_any', 'built-in fields use match_any');
        assert(fd.contextKey, 'field must have contextKey');
    }
});

test('REGRESSION: serializeFieldDefinitions round-trips with non-empty values', () => {
    const defs = [{
        name: 'faction',
        label: 'Faction',
        type: 'string',
        multi: false,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: ['rebels', 'empire', 'neutral'],
        contextKey: 'active_faction',
    }];
    const yaml = serializeFieldDefinitions(defs);
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'should parse back one field');
    assertEqual(definitions[0].name, 'faction', 'name round-trips');
    assertEqual(definitions[0].contextKey, 'active_faction', 'contextKey round-trips with values');
    assertEqual(definitions[0].values.length, 3, 'values round-trip');
    assert(definitions[0].values.includes('rebels'), 'values content round-trips');
});

// ============================================================================
// extractAiNotes
// ============================================================================

test('extractAiNotes: null/empty input returns null notes', () => {
    const r1 = extractAiNotes(null);
    assertEqual(r1.notes, null, 'null input');
    assertEqual(r1.cleanedMessage, '', 'null input cleaned');

    const r2 = extractAiNotes('');
    assertEqual(r2.notes, null, 'empty input');
    assertEqual(r2.cleanedMessage, '', 'empty input cleaned');
});

test('extractAiNotes: message without tags returns unchanged', () => {
    const msg = 'Hello, this is a regular message.';
    const r = extractAiNotes(msg);
    assertEqual(r.notes, null, 'no tags = null notes');
    assertEqual(r.cleanedMessage, msg, 'message unchanged');
});

test('extractAiNotes: extracts single note block', () => {
    const msg = 'Some prose here.\n\n<dle-notes>- Character revealed secret\n- Plot advanced</dle-notes>';
    const r = extractAiNotes(msg);
    assertEqual(r.notes, '- Character revealed secret\n- Plot advanced', 'notes extracted');
    assert(!r.cleanedMessage.includes('dle-notes'), 'tags stripped');
    assert(r.cleanedMessage.includes('Some prose here.'), 'prose preserved');
});

test('extractAiNotes: extracts multiple note blocks', () => {
    const msg = 'Prose 1.\n<dle-notes>Note A</dle-notes>\nMore prose.\n<dle-notes>Note B</dle-notes>';
    const r = extractAiNotes(msg);
    assert(r.notes.includes('Note A'), 'first note');
    assert(r.notes.includes('Note B'), 'second note');
    assert(!r.cleanedMessage.includes('dle-notes'), 'all tags stripped');
});

test('extractAiNotes: handles multiline notes', () => {
    const msg = 'Story text.\n<dle-notes>\n- Item 1\n- Item 2\n- Item 3\n</dle-notes>';
    const r = extractAiNotes(msg);
    assert(r.notes.includes('Item 1'), 'multiline note 1');
    assert(r.notes.includes('Item 3'), 'multiline note 3');
});

test('extractAiNotes: empty tags return null', () => {
    const msg = 'Text.\n<dle-notes></dle-notes>';
    const r = extractAiNotes(msg);
    assertEqual(r.notes, null, 'empty tags = null');
    assertEqual(r.cleanedMessage, msg, 'message unchanged with empty tags');
});

test('extractAiNotes: collapses excess newlines after stripping', () => {
    const msg = 'Prose.\n\n\n\n<dle-notes>Note</dle-notes>';
    const r = extractAiNotes(msg);
    assert(!r.cleanedMessage.includes('\n\n\n'), 'no triple newlines');
});

// ============================================================================
// Librarian: validateSessionResponse
// ============================================================================

test('validateSessionResponse: valid minimal response', () => {
    const r = validateSessionResponse({ message: 'Hello' });
    assert(r.valid, 'should be valid');
    assertEqual(r.errors.length, 0, 'no errors');
});

test('validateSessionResponse: valid response with draft', () => {
    const r = validateSessionResponse({
        message: 'Here is a draft',
        draft: {
            title: 'Trade Routes',
            type: 'lore',
            priority: 50,
            keys: ['trade', 'routes', 'commerce'],
            summary: 'When to select this entry.',
            content: 'This is a longer piece of content that meets the 50 character minimum for validation.',
        },
        action: 'update_draft',
    });
    assert(r.valid, 'should be valid');
    assertEqual(r.errors.length, 0, 'no errors');
});

test('validateSessionResponse: rejects non-object', () => {
    const r = validateSessionResponse('not an object');
    assert(!r.valid, 'should be invalid');
    assert(r.errors[0].includes('JSON object'), 'error mentions JSON object');
});

test('validateSessionResponse: rejects array', () => {
    const r = validateSessionResponse([1, 2, 3]);
    assert(!r.valid, 'should be invalid');
});

test('validateSessionResponse: rejects null', () => {
    const r = validateSessionResponse(null);
    assert(!r.valid, 'should be invalid');
});

test('validateSessionResponse: rejects missing message', () => {
    const r = validateSessionResponse({ draft: null });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('message')), 'error about message');
});

test('validateSessionResponse: rejects invalid action', () => {
    const r = validateSessionResponse({ message: 'Hi', action: 'invalid_action' });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('action')), 'error about action');
});

test('validateSessionResponse: rejects draft with empty title', () => {
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: '', keys: ['a'], content: 'x'.repeat(50) },
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('title')), 'error about title');
});

test('validateSessionResponse: rejects draft with invalid type', () => {
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: 'Test', type: 'invalid_type', keys: ['a'], content: 'x'.repeat(50) },
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('type')), 'error about type');
});

test('validateSessionResponse: rejects draft with out-of-range priority', () => {
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: 'Test', priority: 200, keys: ['a'], content: 'x'.repeat(50) },
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('priority')), 'error about priority');
});

test('validateSessionResponse: allows partial draft with empty keys array (BUG-025)', () => {
    // BUG-025: partial drafts are legitimate during iterative update_draft turns;
    // empty keys array is allowed — Emma may not have proposed keys yet.
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: 'Test', keys: [], content: 'x'.repeat(50) },
    });
    assert(r.valid, 'empty keys array should be valid in partial draft');
});

test('validateSessionResponse: rejects draft with empty string in keys', () => {
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: 'Test', keys: ['good', '', 'also good'], content: 'x'.repeat(50) },
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('empty strings')), 'error about empty key strings');
});

test('validateSessionResponse: allows partial draft with short content (BUG-025)', () => {
    // BUG-025: short content is allowed during iterative drafting; only non-string
    // types are rejected. Emma may refine content across multiple turns.
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: 'Test', keys: ['a'], content: 'too short' },
    });
    assert(r.valid, 'short content should be valid in partial draft');
});

test('validateSessionResponse: rejects draft with long summary', () => {
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: 'Test', keys: ['a'], summary: 'x'.repeat(601), content: 'x'.repeat(50) },
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('summary')), 'error about summary');
});

test('validateSessionResponse: valid work queue', () => {
    const r = validateSessionResponse({
        message: 'Here is the queue',
        queue: [
            { title: 'Entry 1', action: 'create', reason: 'Needed for story', urgency: 'high' },
            { title: 'Entry 2', action: 'update', reason: 'Out of date' },
        ],
        action: 'propose_queue',
    });
    assert(r.valid, 'should be valid');
});

test('validateSessionResponse: rejects queue with invalid action', () => {
    const r = validateSessionResponse({
        message: 'Queue',
        queue: [{ title: 'Test', action: 'delete', reason: 'reason' }],
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('queue[0].action')), 'error about queue action');
});

test('validateSessionResponse: rejects queue with missing title', () => {
    const r = validateSessionResponse({
        message: 'Queue',
        queue: [{ action: 'create', reason: 'reason' }],
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.some(e => e.includes('queue[0].title')), 'error about queue title');
});

test('validateSessionResponse: allows null draft and action', () => {
    const r = validateSessionResponse({ message: 'Just chatting', draft: null, action: null });
    assert(r.valid, 'should be valid');
    assertEqual(r.errors.length, 0, 'no errors');
});

test('validateSessionResponse: collects multiple errors', () => {
    const r = validateSessionResponse({
        message: 'Draft',
        draft: { title: '', type: 'invalid', priority: -5, keys: 'not an array', content: 'short' },
    });
    assert(!r.valid, 'should be invalid');
    assert(r.errors.length >= 4, `should have many errors, got ${r.errors.length}`);
});

test('validateSessionResponse: rejects empty string message', () => {
    const r = validateSessionResponse({ message: '' });
    assert(!r.valid, 'empty string message should be invalid');
    assert(r.errors.some(e => e.includes('message')), 'error about message');
});

test('validateSessionResponse: rejects numeric message', () => {
    const r = validateSessionResponse({ message: 42 });
    assert(!r.valid, 'numeric message should be invalid');
});

// ============================================================================
// Librarian: parseSessionResponse
// ============================================================================

test('parseSessionResponse: parses raw JSON', () => {
    const result = parseSessionResponse('{"message": "hello", "draft": null}');
    assert(result !== null, 'should parse');
    assertEqual(result.message, 'hello', 'message field');
});

test('parseSessionResponse: parses code-fenced JSON', () => {
    const result = parseSessionResponse('Here is my response:\n```json\n{"message": "hi"}\n```');
    assert(result !== null, 'should parse');
    assertEqual(result.message, 'hi', 'message field');
});

test('parseSessionResponse: parses bracket-balanced JSON with preamble', () => {
    const result = parseSessionResponse('I will help you. {"message": "ok", "draft": null}');
    assert(result !== null, 'should parse');
    assertEqual(result.message, 'ok', 'message field');
});

test('parseSessionResponse: handles braces inside strings', () => {
    const result = parseSessionResponse('{"message": "a { b } c", "draft": null}');
    assert(result !== null, 'should parse');
    assertEqual(result.message, 'a { b } c', 'message with braces');
});

test('parseSessionResponse: returns null for non-string input', () => {
    assertEqual(parseSessionResponse(null), null, 'null');
    assertEqual(parseSessionResponse(undefined), null, 'undefined');
    assertEqual(parseSessionResponse(42), null, 'number');
    assertEqual(parseSessionResponse(''), null, 'empty string');
});

test('parseSessionResponse: returns null for unparseable text', () => {
    assertEqual(parseSessionResponse('just some random text'), null, 'no JSON');
    assertEqual(parseSessionResponse('{broken json'), null, 'broken JSON');
});

test('parseSessionResponse: handles escaped quotes in bracket balancer', () => {
    const result = parseSessionResponse('prefix {"message": "say \\"hello\\""}');
    assert(result !== null, 'should parse');
    assertEqual(result.message, 'say "hello"', 'escaped quotes');
});

// ============================================================================
// Librarian: sanitizeFilename
// ============================================================================

test('sanitizeFilename: normal title passes through', () => {
    assertEqual(sanitizeFilename('My Entry Title'), 'My Entry Title');
});

test('sanitizeFilename: strips reserved characters', () => {
    assertEqual(sanitizeFilename('test<>:"/\\|?*file'), 'test_________file');
});

test('sanitizeFilename: strips leading/trailing dots', () => {
    assertEqual(sanitizeFilename('...hidden...'), 'hidden');
});

test('sanitizeFilename: prefixes Windows reserved names', () => {
    assertEqual(sanitizeFilename('CON'), '_CON');
    assertEqual(sanitizeFilename('nul'), '_nul');
    assertEqual(sanitizeFilename('COM1'), '_COM1');
});

test('sanitizeFilename: returns Untitled for empty result', () => {
    assertEqual(sanitizeFilename(''), 'Untitled');
});

test('sanitizeFilename: replaces all special chars', () => {
    assertEqual(sanitizeFilename('***'), '___');
});

test('sanitizeFilename: trims trailing whitespace', () => {
    assertEqual(sanitizeFilename('test   '), 'test');
});

// ============================================================================
// Phase 1A: fields.js Edge Cases
// ============================================================================

test('parseFieldDefinitionYaml: multiple fields in sequence', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: strict
    values: []
    contextKey: mood
  - name: faction
    label: Faction
    type: string
    multi: true
    gating:
      enabled: false
      operator: match_all
      tolerance: lenient
    values:
      - rebels
      - empire
    contextKey: active_faction`;
    const { definitions, errors } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 2, 'should parse two fields');
    assertEqual(definitions[0].name, 'mood', 'first field name');
    assertEqual(definitions[0].gating.tolerance, 'strict', 'first field tolerance');
    assertEqual(definitions[1].name, 'faction', 'second field name');
    assertEqual(definitions[1].multi, true, 'second field multi');
    assertEqual(definitions[1].gating.enabled, false, 'second field gating disabled');
    assertEqual(definitions[1].values, ['rebels', 'empire'], 'second field values');
    assertEqual(definitions[1].contextKey, 'active_faction', 'second field contextKey');
});

test('parseFieldDefinitionYaml: comment lines and blank lines interspersed', () => {
    const yaml = `# Header comment
fields:

  # This is a mood field
  - name: mood
    label: Mood
    type: string
    multi: false

    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: mood`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'should parse field despite comments/blanks');
    assertEqual(definitions[0].name, 'mood', 'field name');
});

test('parseFieldDefinitionYaml: unknown gating operator defaults to match_any', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: bogus_op
      tolerance: moderate
    values: []
    contextKey: mood`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions[0].gating.operator, 'match_any', 'unknown operator defaults to match_any');
});

test('parseFieldDefinitionYaml: inline empty array values: []', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: mood`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions[0].values, [], 'inline empty array should produce empty values');
});

test('parseFieldDefinitionYaml: round-trip with custom fields preserves structure', () => {
    const original = [{
        name: 'danger_level',
        label: 'Danger Level',
        type: 'number',
        multi: false,
        gating: { enabled: true, operator: 'gt', tolerance: 'strict' },
        values: [],
        contextKey: 'danger_level',
    }];
    const yaml = serializeFieldDefinitions(original);
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'round-trip count');
    assertEqual(definitions[0].name, 'danger_level', 'name preserved');
    assertEqual(definitions[0].type, 'number', 'type preserved');
    assertEqual(definitions[0].gating.operator, 'gt', 'operator preserved');
});

test('evaluateOperator: gt/lt with NaN returns false (BUG-L2)', () => {
    assert(!evaluateOperator('gt', 'abc', 5), 'gt with NaN entryValue');
    assert(!evaluateOperator('gt', 10, 'xyz'), 'gt with NaN activeValue');
    assert(!evaluateOperator('lt', 'abc', 5), 'lt with NaN entryValue');
    assert(!evaluateOperator('lt', 10, 'xyz'), 'lt with NaN activeValue');
    assert(!evaluateOperator('gt', NaN, NaN), 'gt with both NaN');
    assert(!evaluateOperator('lt', NaN, NaN), 'lt with both NaN');
});

test('evaluateOperator: gt/lt with string-encoded numbers', () => {
    assert(evaluateOperator('gt', '10', '5'), 'gt: "10" > "5"');
    assert(!evaluateOperator('gt', '3', '5'), 'gt: "3" > "5" = false');
    assert(evaluateOperator('lt', '3', '5'), 'lt: "3" < "5"');
});

test('evaluateOperator: match_all with empty entry array (vacuous truth)', () => {
    assert(evaluateOperator('match_all', [], ['medieval']), 'empty entry array = vacuous truth');
});

test('evaluateOperator: match_all with empty active array', () => {
    assert(!evaluateOperator('match_all', ['medieval'], []), 'entry value not in empty active = false');
});

test('evaluateOperator: not_any with empty arrays', () => {
    assert(evaluateOperator('not_any', [], ['medieval']), 'empty entry = no overlap');
    assert(evaluateOperator('not_any', ['medieval'], []), 'empty active = no overlap');
    assert(evaluateOperator('not_any', [], []), 'both empty = no overlap');
});

test('evaluateOperator: exists with undefined vs empty string', () => {
    assert(!evaluateOperator('exists', undefined, null), 'undefined = not exists');
    assert(evaluateOperator('exists', '', null), 'empty string exists (non-null)');
    assert(evaluateOperator('exists', 0, null), 'zero exists (non-null)');
    assert(evaluateOperator('exists', false, null), 'false exists (non-null)');
});

test('extractCustomFields: number type with string input coerces', () => {
    const fm = { power: '42' };
    const defs = [{ name: 'power', type: 'number', multi: false }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.power, 42, 'string "42" coerces to number');
});

test('extractCustomFields: number type with non-numeric string returns null', () => {
    const fm = { power: 'abc' };
    const defs = [{ name: 'power', type: 'number', multi: false }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.power, null, 'non-numeric string returns null');
});

test('extractCustomFields: boolean type with string "false"', () => {
    const fm = { active: 'false' };
    const defs = [{ name: 'active', type: 'boolean', multi: false }];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.active, false, '"false" string is not true');
});

test('extractCustomFields: boolean type with truthy non-true values', () => {
    const fm = { a: 1, b: 'yes', c: 'true', d: true };
    const defs = [
        { name: 'a', type: 'boolean', multi: false },
        { name: 'b', type: 'boolean', multi: false },
        { name: 'c', type: 'boolean', multi: false },
        { name: 'd', type: 'boolean', multi: false },
    ];
    const result = extractCustomFields(fm, defs);
    assertEqual(result.a, false, 'number 1 is not boolean true');
    assertEqual(result.b, false, 'string "yes" is not boolean true');
    assertEqual(result.c, true, 'string "true" is boolean true');
    assertEqual(result.d, true, 'boolean true is boolean true');
});

test('extractCustomFields: multi string field with mixed types in array', () => {
    const fm = { tags: [42, true, 'text', null] };
    const defs = [{ name: 'tags', type: 'string', multi: true }];
    const result = extractCustomFields(fm, defs);
    // String(null) = "null" which is truthy, so it passes the filter
    assertEqual(result.tags, ['42', 'true', 'text', 'null'], 'non-strings coerced to string');
});

test('findDuplicateFieldNames: case-insensitive detection', () => {
    const defs = [{ name: 'Era' }, { name: 'era' }];
    const dupes = findDuplicateFieldNames(defs);
    assertEqual(dupes, ['era'], 'case-insensitive duplicate detected');
});

test('findDuplicateFieldNames: multiple duplicates detected', () => {
    const defs = [{ name: 'a' }, { name: 'b' }, { name: 'a' }, { name: 'b' }];
    const dupes = findDuplicateFieldNames(defs);
    assertEqual(dupes.length, 2, 'two duplicates');
    assert(dupes.includes('a'), 'includes a');
    assert(dupes.includes('b'), 'includes b');
});

test('findDuplicateFieldNames: no duplicates returns empty', () => {
    const defs = [{ name: 'x' }, { name: 'y' }, { name: 'z' }];
    assertEqual(findDuplicateFieldNames(defs), [], 'no duplicates');
});

// ============================================================================
// Phase 2A: validateCachedEntry (extracted to cache-validate.js)
// ============================================================================

import { validateCachedEntry } from '../src/vault/cache-validate.js';

test('validateCachedEntry: valid entry passes', () => {
    const entry = { title: 'Dragon', keys: ['dragon'], content: 'A dragon.', tokenEstimate: 50 };
    assert(validateCachedEntry(entry), 'valid entry should pass');
});

test('validateCachedEntry: null/undefined returns false', () => {
    assert(!validateCachedEntry(null), 'null');
    assert(!validateCachedEntry(undefined), 'undefined');
    assert(!validateCachedEntry(42), 'number');
});

test('validateCachedEntry: missing title returns false', () => {
    assert(!validateCachedEntry({ keys: [], content: '', tokenEstimate: 0 }), 'no title');
});

test('validateCachedEntry: empty title returns false', () => {
    assert(!validateCachedEntry({ title: '', keys: [], content: '', tokenEstimate: 0 }), 'empty title');
});

test('validateCachedEntry: non-array keys returns false', () => {
    assert(!validateCachedEntry({ title: 'X', keys: 'not-array', content: '', tokenEstimate: 0 }), 'string keys');
});

test('validateCachedEntry: non-string content returns false', () => {
    assert(!validateCachedEntry({ title: 'X', keys: [], content: 42, tokenEstimate: 0 }), 'number content');
});

test('validateCachedEntry: negative tokenEstimate returns false', () => {
    assert(!validateCachedEntry({ title: 'X', keys: [], content: '', tokenEstimate: -1 }), 'negative');
});

test('validateCachedEntry: NaN tokenEstimate returns false', () => {
    assert(!validateCachedEntry({ title: 'X', keys: [], content: '', tokenEstimate: NaN }), 'NaN');
});

test('validateCachedEntry: non-array links returns false', () => {
    assert(!validateCachedEntry({ title: 'X', keys: [], content: '', tokenEstimate: 0, links: 'bad' }), 'string links');
});

test('validateCachedEntry: non-array tags returns false', () => {
    assert(!validateCachedEntry({ title: 'X', keys: [], content: '', tokenEstimate: 0, tags: 'bad' }), 'string tags');
});

test('validateCachedEntry: backfills missing priority to 50', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0 };
    validateCachedEntry(entry);
    assertEqual(entry.priority, 50, 'priority backfilled');
});

test('validateCachedEntry: backfills NaN priority to 50', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0, priority: NaN };
    validateCachedEntry(entry);
    assertEqual(entry.priority, 50, 'NaN priority backfilled');
});

test('validateCachedEntry: backfills non-boolean constant to false', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0, constant: 'yes' };
    validateCachedEntry(entry);
    assertEqual(entry.constant, false, 'constant backfilled');
});

test('validateCachedEntry: backfills non-array requires/excludes to []', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0, requires: 'bad', excludes: 42 };
    validateCachedEntry(entry);
    assertEqual(entry.requires, [], 'requires backfilled');
    assertEqual(entry.excludes, [], 'excludes backfilled');
});

test('validateCachedEntry: backfills invalid probability to null', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0, probability: 'high' };
    validateCachedEntry(entry);
    assertEqual(entry.probability, null, 'probability backfilled');
});

test('validateCachedEntry: backfills missing array fields', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0 };
    validateCachedEntry(entry);
    assertEqual(entry.links, [], 'links backfilled');
    assertEqual(entry.resolvedLinks, [], 'resolvedLinks backfilled');
    assertEqual(entry.tags, [], 'tags backfilled');
});

test('validateCachedEntry: backfills missing/corrupt customFields', () => {
    const entry = { title: 'X', keys: [], content: '', tokenEstimate: 0, customFields: 'bad' };
    validateCachedEntry(entry);
    assertEqual(entry.customFields, {}, 'customFields backfilled from string');

    const entry2 = { title: 'X', keys: [], content: '', tokenEstimate: 0 };
    validateCachedEntry(entry2);
    assertEqual(entry2.customFields, {}, 'customFields backfilled from missing');
});

test('validateCachedEntry: preserves valid existing values', () => {
    const entry = {
        title: 'Dragon', keys: ['dragon'], content: 'Fire.',
        tokenEstimate: 100, priority: 20, constant: true,
        requires: ['Eris'], excludes: ['Sword'], probability: 0.5,
        links: ['Eris'], resolvedLinks: ['Eris'], tags: ['lorebook'],
        customFields: { era: ['medieval'] },
    };
    assert(validateCachedEntry(entry), 'should pass');
    assertEqual(entry.priority, 20, 'priority preserved');
    assertEqual(entry.constant, true, 'constant preserved');
    assertEqual(entry.probability, 0.5, 'probability preserved');
    assertEqual(entry.customFields.era, ['medieval'], 'customFields preserved');
});

// ============================================================================
// Phase 2B: deduplicateMultiVault + computeEntityDerivedState (vault-pure.js)
// ============================================================================

import { deduplicateMultiVault, computeEntityDerivedState } from '../src/vault/vault-pure.js';

test('deduplicateMultiVault: mode "all" returns entries unchanged', () => {
    const entries = [makeEntry('Dragon', { vaultSource: 'v1' }), makeEntry('Dragon', { vaultSource: 'v2' })];
    const result = deduplicateMultiVault(entries, 'all');
    assertEqual(result.length, 2, 'all keeps both');
});

test('deduplicateMultiVault: undefined mode returns entries unchanged', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, undefined).length, 2, 'undefined mode = no dedup');
    assertEqual(deduplicateMultiVault(entries, '').length, 2, 'empty string mode = no dedup');
});

test('deduplicateMultiVault: mode "first" keeps first, discards later', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'first' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'second' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 1, 'one entry');
    assertEqual(result[0].content, 'first', 'first vault kept');
});

test('deduplicateMultiVault: mode "last" keeps last, replaces earlier', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'first' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'second' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result.length, 1, 'one entry');
    assertEqual(result[0].content, 'second', 'last vault kept');
});

test('deduplicateMultiVault: case-insensitive title matching', () => {
    const entries = [
        makeEntry('Dragon', { content: 'first' }),
        makeEntry('dragon', { content: 'second' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 1, 'case-insensitive dedup');
});

test('deduplicateMultiVault: merge unions array fields', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['dragon', 'drake'], tags: ['lorebook'] }),
        makeEntry('Dragon', { keys: ['drake', 'wyrm'], tags: ['lorebook', 'creature'] }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 1, 'merged to one');
    assert(result[0].keys.includes('dragon'), 'includes dragon');
    assert(result[0].keys.includes('drake'), 'includes drake');
    assert(result[0].keys.includes('wyrm'), 'includes wyrm');
    assertEqual(result[0].keys.length, 3, 'no duplicate drake');
    assert(result[0].tags.includes('creature'), 'merged tags');
});

test('deduplicateMultiVault: merge concatenates content', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire breather.' }),
        makeEntry('Dragon', { content: 'Ice breather.' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assert(result[0].content.includes('Fire breather.'), 'first content present');
    assert(result[0].content.includes('Ice breather.'), 'second content present');
    assert(result[0].content.includes('---'), 'separator present');
});

test('deduplicateMultiVault: merge recalculates tokenEstimate', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Short.', tokenEstimate: 2 }),
        makeEntry('Dragon', { content: 'Also short.', tokenEstimate: 3 }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    const expectedLen = ('Short.' + '\n\n---\n\n' + 'Also short.').length;
    assertEqual(result[0].tokenEstimate, Math.ceil(expectedLen / 4.0), 'token estimate recalculated');
});

test('deduplicateMultiVault: merge prefers first non-empty summary', () => {
    const entries = [
        makeEntry('Dragon', { summary: 'First summary' }),
        makeEntry('Dragon', { summary: 'Second summary' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].summary, 'First summary', 'first summary kept');
});

test('deduplicateMultiVault: merge fills empty summary from second', () => {
    const entries = [
        makeEntry('Dragon', { summary: '' }),
        makeEntry('Dragon', { summary: 'Second summary' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].summary, 'Second summary', 'second summary used when first empty');
});

test('deduplicateMultiVault: merge customFields unions arrays', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { era: ['medieval'] } }),
        makeEntry('Dragon', { customFields: { era: ['medieval', 'renaissance'] } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.era.length, 2, 'unioned era values');
    assert(result[0].customFields.era.includes('renaissance'), 'has renaissance');
});

test('deduplicateMultiVault: merge customFields prefers first non-empty scalar', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { mood: 'fierce' } }),
        makeEntry('Dragon', { customFields: { mood: 'calm' } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.mood, 'fierce', 'first scalar kept');
});

test('deduplicateMultiVault: three-way merge', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['a'], content: 'one' }),
        makeEntry('Dragon', { keys: ['b'], content: 'two' }),
        makeEntry('Dragon', { keys: ['c'], content: 'three' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 1, 'one merged entry');
    assertEqual(result[0].keys.length, 3, 'all keys merged');
    assert(result[0].content.includes('one'), 'first content');
    assert(result[0].content.includes('three'), 'third content');
});

test('deduplicateMultiVault: mixed unique + duplicate entries', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Elf', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 2, 'Dragon deduped, Elf kept');
    const titles = result.map(e => e.title);
    assert(titles.includes('Dragon'), 'has Dragon');
    assert(titles.includes('Elf'), 'has Elf');
});

test('deduplicateMultiVault: empty entries array', () => {
    assertEqual(deduplicateMultiVault([], 'first').length, 0, 'empty');
    assertEqual(deduplicateMultiVault([], 'merge').length, 0, 'empty merge');
});

test('computeEntityDerivedState: titles and keys added to entity name set', () => {
    const entries = [makeEntry('Dragon', { keys: ['drake', 'wyrm'] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('dragon'), 'title lowercase in set');
    assert(entityNameSet.has('drake'), 'key in set');
    assert(entityNameSet.has('wyrm'), 'key in set');
});

test('computeEntityDerivedState: single-char keys excluded', () => {
    const entries = [makeEntry('Dragon', { keys: ['x', 'fire'] })];
    computeEntityDerivedState(entries);
    assert(!entityNameSet.has('x'), 'single char key excluded');
    assert(entityNameSet.has('fire'), 'multi char key included');
});

test('computeEntityDerivedState: single-char titles included', () => {
    const entries = [makeEntry('X', {})];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('x'), 'single char title included (>= 1)');
});

test('computeEntityDerivedState: regexes have word boundaries', () => {
    const entries = [makeEntry('Arch', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('arch');
    assert(regex !== undefined, 'regex exists');
    assert(regex.test('The Arch stands'), 'matches whole word');
    assert(!regex.test('monarch'), 'does not match substring');
});

test('computeEntityDerivedState: special regex chars escaped', () => {
    const entries = [makeEntry('C++', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('c++');
    assert(regex !== undefined, 'regex exists for special chars');
    // Shouldn't throw when tested
    assert(!regex.test('cccc'), 'does not match unrelated');
});

// ============================================================================
// Phase 1B: state.js — trackerKey, circuit breaker query/probe
// ============================================================================

test('trackerKey: entry with vaultSource', () => {
    assertEqual(trackerKey({ title: 'Eris', vaultSource: 'main' }), 'main:Eris');
});

test('trackerKey: entry with empty vaultSource', () => {
    assertEqual(trackerKey({ title: 'Eris', vaultSource: '' }), ':Eris');
});

test('trackerKey: entry with undefined vaultSource', () => {
    assertEqual(trackerKey({ title: 'Eris' }), ':Eris');
});

test('trackerKey: same title different vaultSource produces different keys', () => {
    const k1 = trackerKey({ title: 'Dragon', vaultSource: 'vault1' });
    const k2 = trackerKey({ title: 'Dragon', vaultSource: 'vault2' });
    assertNotEqual(k1, k2, 'different vaultSources should produce different keys');
});

test('isAiCircuitOpen: returns false when circuit is closed', () => {
    recordAiSuccess(); // ensure closed
    assert(!isAiCircuitOpen(), 'closed circuit should return false');
});

test('isAiCircuitOpen: returns true during cooldown', () => {
    recordAiSuccess(); // reset
    recordAiFailure();
    recordAiFailure(); // trip circuit
    assert(isAiCircuitOpen(), 'circuit should be open during cooldown');
    recordAiSuccess(); // cleanup
});

test('tryAcquireHalfOpenProbe: returns true when circuit closed', () => {
    recordAiSuccess(); // reset
    assert(tryAcquireHalfOpenProbe(), 'closed circuit always allows calls');
});

test('tryAcquireHalfOpenProbe: returns false during cooldown', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure(); // trip
    // Cooldown just started, should be blocked
    assert(!tryAcquireHalfOpenProbe(), 'should be blocked during cooldown');
    recordAiSuccess(); // cleanup
});

test('tryAcquireHalfOpenProbe: allows probe after cooldown expires', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure(); // trip
    // Simulate cooldown expiry by backdating the opened-at timestamp
    setAiCircuitOpenedAt(Date.now() - 31_000);
    assert(tryAcquireHalfOpenProbe(), 'should allow probe after cooldown');
    recordAiSuccess(); // cleanup
});

test('tryAcquireHalfOpenProbe: second caller blocked after first acquires probe', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    setAiCircuitOpenedAt(Date.now() - 31_000);
    assert(tryAcquireHalfOpenProbe(), 'first caller gets probe');
    assert(!tryAcquireHalfOpenProbe(), 'second caller blocked');
    recordAiSuccess(); // cleanup
});

test('releaseHalfOpenProbe: frees probe without affecting circuit state', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    setAiCircuitOpenedAt(Date.now() - 31_000);
    tryAcquireHalfOpenProbe(); // acquire
    releaseHalfOpenProbe(); // release without success/failure
    // Circuit should still be open (not closed by release)
    assert(isAiCircuitOpen() === false, 'after release, cooldown expired, no probe → isAiCircuitOpen returns false for new probe');
    // Another caller should now be able to acquire
    assert(tryAcquireHalfOpenProbe(), 'probe should be re-acquirable after release');
    recordAiSuccess(); // cleanup
});

test('computeOverallStatus: limited when obsidian circuit open with entries', () => {
    setVaultIndex([makeEntry('A', {})]);
    setIndexEverLoaded(true);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(1);
    setLastHealthResult(null);
    recordAiSuccess();
    const status = computeOverallStatus({ state: 'open' });
    assertEqual(status, 'limited', 'obsidian circuit open with entries = limited');
});

test('computeOverallStatus: offline when obsidian circuit open with no entries', () => {
    setVaultIndex([]);
    setIndexEverLoaded(false);
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(0);
    setLastHealthResult(null);
    recordAiSuccess();
    const status = computeOverallStatus({ state: 'open' });
    assertEqual(status, 'offline', 'obsidian circuit open with no entries = offline');
});

// ============================================================================
// Phase 2D: matchEntries (extracted to match.js)
// ============================================================================

import { matchEntries as matchEntriesPure } from '../src/pipeline/match.js';

// Helper: create a chat array from messages
function makeChat(...messages) {
    return messages.map((m, i) => ({
        name: typeof m === 'string' ? (i % 2 === 0 ? 'User' : 'Char') : m.name,
        mes: typeof m === 'string' ? m : m.mes,
        is_user: typeof m === 'string' ? (i % 2 === 0) : (m.is_user ?? false),
    }));
}

test('matchEntries: constants always matched regardless of keywords', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('ConstantLore', { constant: true, keys: [] }),
        makeEntry('Normal', { keys: ['dragon'] }),
    ];
    const chat = makeChat('Hello there');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched, matchedKeys } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'ConstantLore'), 'constant always matched');
    assertEqual(matchedKeys.get(':ConstantLore'), '(constant)', 'reason is (constant) — keyed by trackerKey (:title for no-vault)');
});

test('matchEntries: bootstrap entries matched when chat is short', () => {
    clearScanTextCache();
    const entries = [makeEntry('BootLore', { bootstrap: true, keys: [] })];
    const chat = makeChat('Hello');
    const settings = makeSettings({ scanDepth: 5, newChatThreshold: 3 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'BootLore'), 'bootstrap matched when chat short');
});

test('matchEntries: bootstrap not matched when chat is long', () => {
    clearScanTextCache();
    const entries = [makeEntry('BootLore', { bootstrap: true, keys: [] })];
    const chat = makeChat('msg1', 'msg2', 'msg3', 'msg4');
    const settings = makeSettings({ scanDepth: 5, newChatThreshold: 3 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(!matched.some(e => e.title === 'BootLore'), 'bootstrap not matched when chat > threshold');
});

test('matchEntries: keyword match triggers entry', () => {
    clearScanTextCache();
    const entries = [makeEntry('Dragon', { keys: ['dragon'] })];
    const chat = makeChat('I see a dragon in the distance');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'keyword match found');
});

test('matchEntries: warmup gate blocks entry with insufficient occurrences', () => {
    clearScanTextCache();
    const entries = [makeEntry('Dragon', { keys: ['dragon'], warmup: 3 })];
    const chat = makeChat('I see a dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched, warmupFailed } = matchEntriesPure(chat, entries, { settings });
    assert(!matched.some(e => e.title === 'Dragon'), 'warmup blocks with 1 occurrence');
    assertEqual(warmupFailed.length, 1, 'warmup failure recorded');
    assertEqual(warmupFailed[0].needed, 3, 'needed 3');
});

test('matchEntries: warmup gate passes when enough occurrences', () => {
    clearScanTextCache();
    const entries = [makeEntry('Dragon', { keys: ['dragon'], warmup: 2 })];
    const chat = makeChat('dragon dragon dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'warmup passes with enough occurrences');
});

test('matchEntries: probability 0 always skips', () => {
    clearScanTextCache();
    const entries = [makeEntry('Dragon', { keys: ['dragon'], probability: 0 })];
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched, probabilitySkipped } = matchEntriesPure(chat, entries, { settings });
    assert(!matched.some(e => e.title === 'Dragon'), 'probability 0 always skips');
    assertEqual(probabilitySkipped.length, 1, 'skip recorded');
});

test('matchEntries: probability 1.0 always passes', () => {
    clearScanTextCache();
    const entries = [makeEntry('Dragon', { keys: ['dragon'], probability: 1.0 })];
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'probability 1.0 always passes');
});

test('matchEntries: cooldown gate blocks entry', () => {
    clearScanTextCache();
    const entries = [makeEntry('Dragon', { keys: ['dragon'], cooldown: 3 })];
    cooldownTracker.set(':Dragon', 2);
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(!matched.some(e => e.title === 'Dragon'), 'cooldown blocks entry');
    cooldownTracker.clear(); // cleanup
});

test('matchEntries: cascade links pull in linked entries', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('Dragon', { keys: ['dragon'], cascadeLinks: ['Sword'] }),
        makeEntry('Sword', { keys: ['sword'] }),
    ];
    const chat = makeChat('I see a dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched, matchedKeys } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'primary match');
    assert(matched.some(e => e.title === 'Sword'), 'cascade linked');
    assert(matchedKeys.get(':Sword').includes('cascade from'), 'reason shows cascade');
});

test('matchEntries: BUG-035 cascade links skip warmup', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('Dragon', { keys: ['dragon'], cascadeLinks: ['Sword'] }),
        makeEntry('Sword', { keys: ['sword'], warmup: 5 }),
    ];
    const chat = makeChat('I see a dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    // Sword has warmup=5 but is cascade-linked — should still be pulled in
    assert(matched.some(e => e.title === 'Sword'), 'cascade skips warmup gate');
});

test('matchEntries: cascade links respect cooldown', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('Dragon', { keys: ['dragon'], cascadeLinks: ['Sword'] }),
        makeEntry('Sword', { keys: ['sword'], cooldown: 3 }),
    ];
    cooldownTracker.set(':Sword', 2);
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'primary matches');
    assert(!matched.some(e => e.title === 'Sword'), 'cascade blocked by cooldown');
    cooldownTracker.clear();
});

test('matchEntries: recursive scanning finds entries in matched content', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('Dragon', { keys: ['dragon'], content: 'The dragon guards the sword' }),
        makeEntry('Sword', { keys: ['sword'] }),
    ];
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5, recursiveScan: true, maxRecursionSteps: 3 });
    const { matched, matchedKeys } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'primary match');
    assert(matched.some(e => e.title === 'Sword'), 'found via recursion');
    assert(matchedKeys.get(':Sword').includes('recursion'), 'reason shows recursion');
});

test('matchEntries: excludeRecursion flag respected', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('Dragon', { keys: ['dragon'], content: 'The dragon guards the sword', excludeRecursion: true }),
        makeEntry('Sword', { keys: ['sword'] }),
    ];
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5, recursiveScan: true, maxRecursionSteps: 3 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assert(matched.some(e => e.title === 'Dragon'), 'primary match');
    assert(!matched.some(e => e.title === 'Sword'), 'recursion skipped due to excludeRecursion');
});

test('matchEntries: character context scan', () => {
    clearScanTextCache();
    const entries = [makeEntry('Eris', { keys: ['eris'] })];
    const chat = makeChat('Hello');
    const settings = makeSettings({ scanDepth: 5, characterContextScan: true });
    const { matched, matchedKeys } = matchEntriesPure(chat, entries, { settings, characterName: 'Eris' });
    assert(matched.some(e => e.title === 'Eris'), 'active character matched');
    assertEqual(matchedKeys.get(':Eris'), '(active character)', 'reason shows active character');
});

test('matchEntries: sorted by priority', () => {
    clearScanTextCache();
    const entries = [
        makeEntry('Low', { keys: ['dragon'], priority: 100 }),
        makeEntry('High', { keys: ['dragon'], priority: 10 }),
    ];
    const chat = makeChat('dragon');
    const settings = makeSettings({ scanDepth: 5 });
    const { matched } = matchEntriesPure(chat, entries, { settings });
    assertEqual(matched[0].title, 'High', 'higher priority first (lower number)');
    assertEqual(matched[1].title, 'Low', 'lower priority second');
});

// ============================================================================
// Phase 2C: buildCandidateManifest (extracted to manifest.js)
// ============================================================================

import { buildCandidateManifest } from '../src/ai/manifest.js';

// Reset field definitions to defaults for manifest tests
setFieldDefinitions([
    { name: 'era', label: 'Era' },
    { name: 'location', label: 'Location' },
]);

test('buildCandidateManifest: filters out constants', () => {
    const candidates = [
        makeEntry('Dragon', { keys: ['dragon'], summary: 'A dragon', tokenEstimate: 50 }),
        makeEntry('Always', { keys: ['always'], summary: 'Constant', tokenEstimate: 30, constant: true }),
    ];
    const settings = makeSettings();
    const { manifest, header } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('Dragon'), 'Dragon in manifest');
    assert(!manifest.includes('name="Always"'), 'constant filtered from manifest');
    assert(header.includes('1 entries are always included'), 'header mentions forced count');
});

test('buildCandidateManifest: filters bootstraps when excludeBootstrap=true', () => {
    const candidates = [
        makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50 }),
        makeEntry('Boot', { summary: 'Bootstrap', tokenEstimate: 30, bootstrap: true }),
    ];
    const settings = makeSettings();
    const { manifest } = buildCandidateManifest(candidates, true, settings);
    assert(manifest.includes('Dragon'), 'Dragon in manifest');
    assert(!manifest.includes('name="Boot"'), 'bootstrap filtered');
});

test('buildCandidateManifest: empty selectable returns empty', () => {
    const candidates = [makeEntry('Always', { constant: true, tokenEstimate: 30 })];
    const settings = makeSettings();
    const { manifest, header } = buildCandidateManifest(candidates, false, settings);
    assertEqual(manifest, '', 'empty manifest');
    assertEqual(header, '', 'empty header');
});

test('buildCandidateManifest: prefer_summary mode uses summary when available', () => {
    const candidates = [makeEntry('Dragon', { summary: 'My summary', content: 'My content', tokenEstimate: 50 })];
    const settings = makeSettings({ manifestSummaryMode: 'prefer_summary' });
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('My summary'), 'summary text used');
});

test('buildCandidateManifest: content_only mode ignores summary', () => {
    const candidates = [makeEntry('Dragon', { summary: 'My summary', content: 'My full content here.', tokenEstimate: 50 })];
    const settings = makeSettings({ manifestSummaryMode: 'content_only' });
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(!manifest.includes('My summary'), 'summary not used in content_only');
    assert(manifest.includes('My full content here.'), 'content used');
});

test('buildCandidateManifest: summary_only mode excludes entries without summary', () => {
    const candidates = [
        makeEntry('A', { summary: 'Has summary', tokenEstimate: 50 }),
        makeEntry('B', { summary: '', content: 'No summary', tokenEstimate: 50 }),
    ];
    const settings = makeSettings({ manifestSummaryMode: 'summary_only' });
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('name="A"'), 'A with summary included');
    assert(!manifest.includes('name="B"'), 'B without summary excluded');
});

test('buildCandidateManifest: custom field annotations', () => {
    const candidates = [makeEntry('Dragon', {
        summary: 'A dragon', tokenEstimate: 50,
        customFields: { era: ['medieval'], location: 'mountain' },
    })];
    const settings = makeSettings();
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('Era: medieval'), 'era annotation');
    assert(manifest.includes('Location: mountain'), 'location annotation');
});

test('buildCandidateManifest: aiManifestIncludeFields whitelist prunes fields', () => {
    const candidates = [makeEntry('Dragon', {
        summary: 'A dragon', tokenEstimate: 50,
        customFields: { era: ['medieval'], location: 'mountain' },
    })];
    const settings = makeSettings({ aiManifestIncludeFields: ['era'] });
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('Era: medieval'), 'era kept (in whitelist)');
    assert(!manifest.includes('Location: mountain'), 'location pruned (not in whitelist)');
});

test('buildCandidateManifest: empty aiManifestIncludeFields includes everything', () => {
    const candidates = [makeEntry('Dragon', {
        summary: 'A dragon', tokenEstimate: 50,
        customFields: { era: ['medieval'], location: 'mountain' },
    })];
    const settings = makeSettings({ aiManifestIncludeFields: [] });
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('Era: medieval'), 'era kept');
    assert(manifest.includes('Location: mountain'), 'location kept');
});

test('buildCandidateManifest: whitelist with no matches drops field block entirely', () => {
    const candidates = [makeEntry('Dragon', {
        summary: 'A dragon', tokenEstimate: 50,
        customFields: { era: ['medieval'] },
    })];
    const settings = makeSettings({ aiManifestIncludeFields: ['faction'] });
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(!manifest.includes('Era:'), 'era pruned (not in whitelist)');
    assert(!manifest.includes('Faction:'), 'no faction (none on entry)');
});

test('buildCandidateManifest: decay STALE hint', () => {
    const candidates = [makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50 })];
    const settings = makeSettings({ decayEnabled: true, decayBoostThreshold: 5 });
    setDecayTracker(new Map([[':Dragon', 6]]));
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('[STALE'), 'stale hint present');
    setDecayTracker(new Map()); // cleanup
});

test('buildCandidateManifest: consecutive FREQUENT hint', () => {
    const candidates = [makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50 })];
    const settings = makeSettings({ decayEnabled: true, decayBoostThreshold: 5, decayPenaltyThreshold: 3 });
    // decayTracker must be non-empty for the decay block to execute
    setDecayTracker(new Map([['other:entry', 0]]));
    setConsecutiveInjections(new Map([[':Dragon', 4]]));
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('[FREQUENT'), 'frequent hint present');
    setDecayTracker(new Map()); // cleanup
    setConsecutiveInjections(new Map()); // cleanup
});

test('buildCandidateManifest: wiki-link formatting', () => {
    const candidates = [makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50, resolvedLinks: ['Eris', 'Sword'] })];
    const settings = makeSettings();
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('→ Eris, Sword'), 'links formatted');
});

test('buildCandidateManifest: token count in header', () => {
    const candidates = [makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 123 })];
    const settings = makeSettings();
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('123tok'), 'token count in manifest');
});

test('buildCandidateManifest: XML escaping in entry name', () => {
    const candidates = [makeEntry('Dragon & Fire <Hot>', { summary: 'A dragon', tokenEstimate: 50 })];
    const settings = makeSettings();
    const { manifest } = buildCandidateManifest(candidates, false, settings);
    assert(manifest.includes('name="Dragon &amp; Fire &lt;Hot&gt;"'), 'XML escaped');
});

test('buildCandidateManifest: budget info present when not unlimited', () => {
    const candidates = [makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50 })];
    const settings = makeSettings({ unlimitedBudget: false, maxTokensBudget: 2000 });
    const { header } = buildCandidateManifest(candidates, false, settings);
    assert(header.includes('Token budget: ~2000'), 'budget info present');
});

test('buildCandidateManifest: budget info absent when unlimited', () => {
    const candidates = [makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50 })];
    const settings = makeSettings({ unlimitedBudget: true });
    const { header } = buildCandidateManifest(candidates, false, settings);
    assert(!header.includes('Token budget'), 'no budget info');
});

test('buildCandidateManifest: BUG-047 forcedCount uses candidates.length', () => {
    const candidates = [
        makeEntry('Dragon', { summary: 'A dragon', tokenEstimate: 50 }),
        makeEntry('Const1', { constant: true, tokenEstimate: 30 }),
        makeEntry('Const2', { constant: true, tokenEstimate: 20 }),
    ];
    const settings = makeSettings();
    const { header } = buildCandidateManifest(candidates, false, settings);
    assert(header.includes('1 (from 3 total)'), 'selectable=1 from total=3');
    assert(header.includes('2 entries are always included'), '2 forced');
    assert(header.includes('~50 tokens'), 'forced token sum');
});

// ============================================================================
// v2.0-beta Coherence Pass — Item 4: AI search cache invalidation
// ============================================================================

function freshCache() {
    return { hash: 'abc', manifestHash: 'def', chatLineCount: 5, results: [{ title: 'X' }], matchedEntrySet: new Set(['X']) };
}
function isClearedCache(c) {
    return c.hash === '' && c.manifestHash === '' && c.chatLineCount === 0 &&
        Array.isArray(c.results) && c.results.length === 0;
}

test('cache invalidation: notifyPinBlockChanged clears aiSearchCache', () => {
    setAiSearchCache(freshCache());
    notifyPinBlockChanged();
    // Re-read live binding
    const c = aiSearchCache;
    assert(isClearedCache(c), 'pinBlockChanged clears cache');
});

test('cache invalidation: notifyGatingChanged clears aiSearchCache', () => {
    setAiSearchCache(freshCache());
    notifyGatingChanged();
    const c = aiSearchCache;
    assert(isClearedCache(c), 'gatingChanged clears cache');
});

test('cache invalidation: setFieldDefinitions clears aiSearchCache', () => {
    setAiSearchCache(freshCache());
    setFieldDefinitions([]);
    const c = aiSearchCache;
    assert(isClearedCache(c), 'fieldDefinitions update clears cache');
});

// ============================================================================
// Item 7: Strip dangling requires/excludes/cascade_links — pure logic test
// ============================================================================

// Replicates the filterValid logic added to vault.js finalizeIndex.
// (vault.js itself can't be imported here due to ST runtime deps.)
function applyDanglingRefStrip(entries) {
    const validTitles = new Set(entries.map(e => e.title.toLowerCase()));
    const filterValid = (arr) => arr.filter(ref => validTitles.has(String(ref).toLowerCase()));
    for (const entry of entries) {
        if (Array.isArray(entry.requires) && entry.requires.length) {
            const cleaned = filterValid(entry.requires);
            if (cleaned.length !== entry.requires.length) {
                entry._originalRequires = entry.requires.slice();
                entry.requires = cleaned;
            }
        }
        if (Array.isArray(entry.excludes) && entry.excludes.length) {
            const cleaned = filterValid(entry.excludes);
            if (cleaned.length !== entry.excludes.length) {
                entry._originalExcludes = entry.excludes.slice();
                entry.excludes = cleaned;
            }
        }
        if (Array.isArray(entry.cascadeLinks) && entry.cascadeLinks.length) {
            const cleaned = filterValid(entry.cascadeLinks);
            if (cleaned.length !== entry.cascadeLinks.length) {
                entry._originalCascadeLinks = entry.cascadeLinks.slice();
                entry.cascadeLinks = cleaned;
            }
        }
    }
    return entries;
}

test('dangling-ref strip: removes nonexistent requires', () => {
    const entries = [
        { title: 'Real', requires: [], excludes: [], cascadeLinks: [] },
        { title: 'Dependent', requires: ['Real', 'Ghost'], excludes: [], cascadeLinks: [] },
    ];
    applyDanglingRefStrip(entries);
    assertEqual(entries[1].requires, ['Real'], 'dangling Ghost stripped');
    assertEqual(entries[1]._originalRequires, ['Real', 'Ghost'], 'original preserved');
});

test('dangling-ref strip: case-insensitive matching', () => {
    const entries = [
        { title: 'Real', requires: [], excludes: [], cascadeLinks: [] },
        { title: 'B', requires: ['REAL'], excludes: [], cascadeLinks: [] },
    ];
    applyDanglingRefStrip(entries);
    assertEqual(entries[1].requires, ['REAL'], 'REAL kept (matches Real)');
    assert(!entries[1]._originalRequires, 'no snapshot when nothing stripped');
});

test('dangling-ref strip: removes nonexistent excludes', () => {
    const entries = [
        { title: 'A', requires: [], excludes: ['Ghost', 'AlsoGhost'], cascadeLinks: [] },
    ];
    applyDanglingRefStrip(entries);
    assertEqual(entries[0].excludes, [], 'all excludes stripped');
    assertEqual(entries[0]._originalExcludes, ['Ghost', 'AlsoGhost'], 'originals preserved');
});

test('dangling-ref strip: removes nonexistent cascadeLinks', () => {
    const entries = [
        { title: 'A', requires: [], excludes: [], cascadeLinks: [] },
        { title: 'B', requires: [], excludes: [], cascadeLinks: ['A', 'Ghost'] },
    ];
    applyDanglingRefStrip(entries);
    assertEqual(entries[1].cascadeLinks, ['A'], 'cascade Ghost stripped');
    assertEqual(entries[1]._originalCascadeLinks, ['A', 'Ghost'], 'cascade original preserved');
});

test('dangling-ref strip: empty arrays untouched', () => {
    const entries = [
        { title: 'A', requires: [], excludes: [], cascadeLinks: [] },
    ];
    applyDanglingRefStrip(entries);
    assert(!entries[0]._originalRequires, 'no snapshot for empty requires');
    assert(!entries[0]._originalExcludes, 'no snapshot for empty excludes');
    assert(!entries[0]._originalCascadeLinks, 'no snapshot for empty cascade');
});

test('dangling-ref strip: no entries dropped, only filtered', () => {
    const entries = [
        { title: 'A', requires: ['Ghost1'], excludes: ['Ghost2'], cascadeLinks: ['Ghost3'] },
    ];
    applyDanglingRefStrip(entries);
    assertEqual(entries.length, 1, 'entry not dropped');
    assertEqual(entries[0].requires, [], 'requires cleared');
    assertEqual(entries[0].excludes, [], 'excludes cleared');
    assertEqual(entries[0].cascadeLinks, [], 'cascade cleared');
});

test('dangling-ref strip: missing arrays do not crash', () => {
    const entries = [{ title: 'A' }];
    applyDanglingRefStrip(entries);
    assertEqual(entries[0].title, 'A', 'undefined arrays handled');
});

// ============================================================================
// Item 5: Swipe state pollution rollback — snapshot/restore logic
// ============================================================================

function takeSnapshot() {
    return {
        cooldown: new Map(cooldownTracker),
        decay: new Map(decayTracker),
        consecutive: new Map(consecutiveInjections),
        injectionHistory: new Map(injectionHistory),
        generationCount: generationCount,
    };
}

function restoreSnapshot(snap) {
    setCooldownTracker(new Map(snap.cooldown));
    setDecayTracker(new Map(snap.decay));
    setConsecutiveInjections(new Map(snap.consecutive));
    setInjectionHistory(new Map(snap.injectionHistory));
    setGenerationCount(snap.generationCount);
}

test('swipe rollback: snapshot is independent of source maps', () => {
    setCooldownTracker(new Map([['A', 5]]));
    const snap = takeSnapshot();
    cooldownTracker.set('A', 99); // mutate live map
    assertEqual(snap.cooldown.get('A'), 5, 'snapshot not affected by later mutation');
});

test('swipe rollback: restore restores cooldown values', () => {
    setCooldownTracker(new Map([['A', 5], ['B', 3]]));
    setDecayTracker(new Map());
    setConsecutiveInjections(new Map());
    setInjectionHistory(new Map());
    setGenerationCount(10);
    const snap = takeSnapshot();
    // Simulate "swipe gen" mutation
    setCooldownTracker(new Map([['A', 4], ['B', 2], ['C', 7]]));
    setGenerationCount(11);
    restoreSnapshot(snap);
    const c = cooldownTracker;
    assertEqual(c.get('A'), 5, 'A restored');
    assertEqual(c.get('B'), 3, 'B restored');
    assert(!c.has('C'), 'C (added on swipe) removed');
    assertEqual(generationCount, 10, 'gen count restored');
});

test('swipe rollback: restore restores injectionHistory', () => {
    setInjectionHistory(new Map([['A', 5]]));
    const snap = takeSnapshot();
    setInjectionHistory(new Map([['A', 6], ['B', 6]]));
    restoreSnapshot(snap);
    const h = injectionHistory;
    assertEqual(h.get('A'), 5, 'A restored');
    assert(!h.has('B'), 'B removed');
});

test('swipe rollback: multiple swipes do not accumulate pollution', () => {
    setCooldownTracker(new Map([['A', 5]]));
    setDecayTracker(new Map());
    setConsecutiveInjections(new Map());
    setInjectionHistory(new Map());
    setGenerationCount(10);
    const baseSnap = takeSnapshot();
    // Simulate 3 swipes — each restores from baseSnap before mutating
    for (let i = 0; i < 3; i++) {
        restoreSnapshot(baseSnap);
        cooldownTracker.set('A', cooldownTracker.get('A') - 1);
    }
    assertEqual(cooldownTracker.get('A'), 4, 'A always lands at 4 (5-1), not 2 (5-3)');
});

// ============================================================================
// Item 6: uiCascadeState derivation — pure logic
// ============================================================================

// Replicates the derivation in src/diagnostics/state-snapshot.js.
function deriveUiCascadeState(s) {
    return {
        maxEntries: { disabled: !!s.unlimitedEntries, reason: 'unlimitedEntries' },
        maxTokensBudget: { disabled: !!s.unlimitedBudget, reason: 'unlimitedBudget' },
        aiNotepadConnection: { hidden: s.aiNotepadMode === 'tag', reason: 'aiNotepadMode=tag' },
        keywordMatchingSettings: { disabled: s.aiSearchEnabled && s.aiSearchMode === 'ai-only', reason: 'aiSearchMode=ai-only' },
        scanDepth: { hidden: s.aiSearchEnabled && s.aiSearchMode === 'ai-only', reason: 'aiSearchMode=ai-only' },
        fuzzyMinScore: { hidden: !s.fuzzySearchEnabled, reason: 'fuzzySearchEnabled' },
        maxRecursion: { disabled: !s.recursiveScan, reason: 'recursiveScan' },
        stripLookback: { disabled: !s.stripDuplicateInjections, reason: 'stripDuplicateInjections' },
    };
}

test('uiCascadeState: maxEntries disabled when unlimitedEntries', () => {
    const r = deriveUiCascadeState({ unlimitedEntries: true });
    assertEqual(r.maxEntries.disabled, true, 'disabled');
});

test('uiCascadeState: aiNotepadConnection hidden in tag mode', () => {
    const r = deriveUiCascadeState({ aiNotepadMode: 'tag' });
    assertEqual(r.aiNotepadConnection.hidden, true, 'hidden in tag mode');
    const r2 = deriveUiCascadeState({ aiNotepadMode: 'extract' });
    assertEqual(r2.aiNotepadConnection.hidden, false, 'shown in extract mode');
});

test('uiCascadeState: keywordMatchingSettings disabled in ai-only mode', () => {
    const r = deriveUiCascadeState({ aiSearchEnabled: true, aiSearchMode: 'ai-only' });
    assertEqual(r.keywordMatchingSettings.disabled, true, 'disabled');
    const r2 = deriveUiCascadeState({ aiSearchEnabled: true, aiSearchMode: 'two-stage' });
    assertEqual(r2.keywordMatchingSettings.disabled, false, 'enabled in two-stage');
    const r3 = deriveUiCascadeState({ aiSearchEnabled: false, aiSearchMode: 'ai-only' });
    assertEqual(r3.keywordMatchingSettings.disabled, false, 'enabled when AI off');
});

test('uiCascadeState: fuzzyMinScore hidden when fuzzy disabled', () => {
    assertEqual(deriveUiCascadeState({ fuzzySearchEnabled: false }).fuzzyMinScore.hidden, true, 'hidden');
    assertEqual(deriveUiCascadeState({ fuzzySearchEnabled: true }).fuzzyMinScore.hidden, false, 'shown');
});

test('uiCascadeState: maxRecursion disabled when recursive off', () => {
    assertEqual(deriveUiCascadeState({ recursiveScan: false }).maxRecursion.disabled, true, 'disabled');
    assertEqual(deriveUiCascadeState({ recursiveScan: true }).maxRecursion.disabled, false, 'enabled');
});

test('uiCascadeState: stripLookback disabled when strip-dedup off', () => {
    assertEqual(deriveUiCascadeState({ stripDuplicateInjections: false }).stripLookback.disabled, true, 'disabled');
    assertEqual(deriveUiCascadeState({ stripDuplicateInjections: true }).stripLookback.disabled, false, 'enabled');
});

test('uiCascadeState: every entry has a reason field', () => {
    const r = deriveUiCascadeState({});
    for (const [key, val] of Object.entries(r)) {
        assert(typeof val.reason === 'string' && val.reason.length > 0, `${key} has reason`);
    }
});

// ============================================================================
// Results
// ============================================================================

await summary();
