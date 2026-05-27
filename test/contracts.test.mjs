/**
 * DeepLore Enhanced — Data Contract & Persistence Tests
 * Verifies VaultEntry shape, cache validation, settings migration,
 * pin/block normalization roundtrips, and tracker key format.
 *
 * Run with: node test/contracts.test.mjs
 */

import {
    assert, assertEqual, assertNotEqual, assertNull, assertNotNull,
    assertContains, assertMatch, assertThrows, test, section, summary,
    makeEntry, makeSettings,
} from './helpers.mjs';

import { validateCachedEntry } from '../src/vault/cache-validate.js';
import {
    normalizePinBlock, matchesPinBlock, normalizeLoreGap,
    fuzzyTitleMatch, isForceInjected, convertWiEntry,
    stripObsidianSyntax, tokenBarColor, formatRelativeTime,
    parseMatchReason, computeSourcesDiff, categorizeRejections,
    resolveEntryVault,
} from '../src/helpers.js';
import { trackerKey } from '../src/state.js';
import { parseVaultFile } from '../core/pipeline.js';
import { validateSettings } from '../core/utils.js';

// ============================================================================
// A. validateCachedEntry — Cache Shape Validation
// ============================================================================

section('A. validateCachedEntry — Cache Shape Validation');

test('A01: Valid entry passes validation', () => {
    const entry = makeEntry('Test Entry', { tokenEstimate: 50, content: 'some content', keys: ['key1'] });
    const result = validateCachedEntry(entry);
    assert(result === true, 'valid entry should return true');
});

test('A02: null input returns false', () => {
    assert(validateCachedEntry(null) === false, 'null should return false');
});

test('A03: undefined input returns false', () => {
    assert(validateCachedEntry(undefined) === false, 'undefined should return false');
});

test('A04: non-object (number) returns false', () => {
    assert(validateCachedEntry(42) === false, 'number should return false');
});

test('A05: non-object (string) returns false', () => {
    assert(validateCachedEntry('hello') === false, 'string should return false');
});

test('A06: missing title returns false', () => {
    const entry = { keys: [], content: '', tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'missing title should return false');
});

test('A07: empty string title returns false', () => {
    const entry = { title: '', keys: [], content: '', tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'empty title should return false');
});

test('A08: non-string title returns false', () => {
    const entry = { title: 123, keys: [], content: '', tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'numeric title should return false');
});

test('A09: missing keys array returns false', () => {
    const entry = { title: 'Test', content: '', tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'missing keys should return false');
});

test('A10: non-array keys returns false', () => {
    const entry = { title: 'Test', keys: 'not-array', content: '', tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'non-array keys should return false');
});

test('A11: missing content string returns false', () => {
    const entry = { title: 'Test', keys: [], tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'missing content should return false');
});

test('A12: non-string content returns false', () => {
    const entry = { title: 'Test', keys: [], content: 123, tokenEstimate: 10 };
    assert(validateCachedEntry(entry) === false, 'non-string content should return false');
});

test('A13: negative tokenEstimate returns false', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: -1 };
    assert(validateCachedEntry(entry) === false, 'negative tokenEstimate should return false');
});

test('A14: NaN tokenEstimate returns false', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: NaN };
    assert(validateCachedEntry(entry) === false, 'NaN tokenEstimate should return false');
});

test('A15: non-number tokenEstimate returns false', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 'fifty' };
    assert(validateCachedEntry(entry) === false, 'string tokenEstimate should return false');
});

test('A16: backfill missing priority to 50', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10 };
    validateCachedEntry(entry);
    assertEqual(entry.priority, 50, 'missing priority should be backfilled to 50');
});

test('A17: backfill NaN priority to 50', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, priority: NaN };
    validateCachedEntry(entry);
    assertEqual(entry.priority, 50, 'NaN priority should be backfilled to 50');
});

test('A18: backfill non-boolean constant to false', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, constant: 'yes' };
    validateCachedEntry(entry);
    assertEqual(entry.constant, false, 'non-boolean constant should be backfilled to false');
});

test('A19: backfill non-array requires to []', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, requires: 'not-array' };
    validateCachedEntry(entry);
    assertEqual(entry.requires, [], 'non-array requires should be backfilled to []');
});

test('A20: backfill non-array excludes to []', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, excludes: 42 };
    validateCachedEntry(entry);
    assertEqual(entry.excludes, [], 'non-array excludes should be backfilled to []');
});

test('A21: backfill invalid probability to null', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, probability: 'high' };
    validateCachedEntry(entry);
    assertNull(entry.probability, 'non-number probability should be backfilled to null');
});

test('A22: backfill missing links/resolvedLinks/tags to []', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10 };
    validateCachedEntry(entry);
    assertEqual(entry.links, [], 'missing links should be backfilled to []');
    assertEqual(entry.resolvedLinks, [], 'missing resolvedLinks should be backfilled to []');
    assertEqual(entry.tags, [], 'missing tags should be backfilled to []');
});

test('A23: customFields non-object reset to {}', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, customFields: 'bad' };
    validateCachedEntry(entry);
    assertEqual(entry.customFields, {}, 'non-object customFields should be reset to {}');
});

test('A24: customFields array reset to {}', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, customFields: [1, 2, 3] };
    validateCachedEntry(entry);
    assertEqual(entry.customFields, {}, 'array customFields should be reset to {}');
});

test('A25: customFields inner Map/Set dropped', () => {
    const entry = {
        title: 'Test', keys: [], content: '', tokenEstimate: 10,
        customFields: { good: 'value', bad: new Map() },
    };
    validateCachedEntry(entry);
    assertEqual(entry.customFields.good, 'value', 'valid string field should be preserved');
    assert(!('bad' in entry.customFields), 'Map field should be dropped');
});

test('A26: customFields inner array with non-primitives dropped', () => {
    const entry = {
        title: 'Test', keys: [], content: '', tokenEstimate: 10,
        customFields: { items: [1, { nested: true }, 'ok'] },
    };
    validateCachedEntry(entry);
    assert(!('items' in entry.customFields), 'array with non-primitive items should be dropped');
});

test('A27: customFields valid inner array kept', () => {
    const entry = {
        title: 'Test', keys: [], content: '', tokenEstimate: 10,
        customFields: { items: ['a', 'b', 'c'] },
    };
    validateCachedEntry(entry);
    assertEqual(entry.customFields.items, ['a', 'b', 'c'], 'valid primitive array should be kept');
});

test('A28: customFields string/number/boolean values preserved', () => {
    const entry = {
        title: 'Test', keys: [], content: '', tokenEstimate: 10,
        customFields: { str: 'hello', num: 42, bool: true },
    };
    validateCachedEntry(entry);
    assertEqual(entry.customFields.str, 'hello', 'string should be preserved');
    assertEqual(entry.customFields.num, 42, 'number should be preserved');
    assertEqual(entry.customFields.bool, true, 'boolean should be preserved');
});

test('A29: customFields null values preserved (not dropped)', () => {
    const entry = {
        title: 'Test', keys: [], content: '', tokenEstimate: 10,
        customFields: { nullable: null },
    };
    validateCachedEntry(entry);
    assert('nullable' in entry.customFields, 'null field should be preserved');
    assertNull(entry.customFields.nullable, 'null value should remain null');
});

test('A30: valid priority number is not overwritten', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, priority: 75 };
    validateCachedEntry(entry);
    assertEqual(entry.priority, 75, 'valid priority should be preserved');
});

test('A31: zero tokenEstimate is valid', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 0 };
    assert(validateCachedEntry(entry) === true, 'zero tokenEstimate should be valid');
});

test('A32: invalid links (non-array when defined) returns false', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, links: 'bad' };
    assert(validateCachedEntry(entry) === false, 'non-array links should return false');
});

test('A33: invalid tags (non-array when defined) returns false', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, tags: 42 };
    assert(validateCachedEntry(entry) === false, 'non-array tags should return false');
});

test('A34: customFields with function value dropped', () => {
    const entry = {
        title: 'Test', keys: [], content: '', tokenEstimate: 10,
        customFields: { fn: () => {}, good: 'ok' },
    };
    validateCachedEntry(entry);
    assert(!('fn' in entry.customFields), 'function field should be dropped');
    assertEqual(entry.customFields.good, 'ok', 'adjacent valid field should be preserved');
});

test('A35: valid boolean constant preserved', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, constant: true };
    validateCachedEntry(entry);
    assertEqual(entry.constant, true, 'boolean true constant should be preserved');
});

test('A36: undefined requires left undefined (not backfilled)', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10 };
    validateCachedEntry(entry);
    // requires is only backfilled if defined but non-array; undefined stays undefined
    assert(entry.requires === undefined, 'undefined requires should stay undefined');
});

test('A37: numeric probability preserved', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, probability: 0.5 };
    validateCachedEntry(entry);
    assertEqual(entry.probability, 0.5, 'numeric probability should be preserved');
});

test('A38: null probability preserved', () => {
    const entry = { title: 'Test', keys: [], content: '', tokenEstimate: 10, probability: null };
    validateCachedEntry(entry);
    assertNull(entry.probability, 'null probability should be preserved');
});

// ============================================================================
// B. Pin/Block Normalization Roundtrips
// ============================================================================

section('B. Pin/Block Normalization Roundtrips');

test('B01: bare string normalizes to {title, vaultSource: null}', () => {
    const result = normalizePinBlock('My Entry');
    assertEqual(result.title, 'My Entry', 'title should match input');
    assertNull(result.vaultSource, 'vaultSource should be null for bare string');
});

test('B02: structured {title, vaultSource} preserved', () => {
    const result = normalizePinBlock({ title: 'My Entry', vaultSource: 'MainVault' });
    assertEqual(result.title, 'My Entry', 'title should be preserved');
    assertEqual(result.vaultSource, 'MainVault', 'vaultSource should be preserved');
});

test('B03: structured with missing vaultSource normalizes to null', () => {
    const result = normalizePinBlock({ title: 'Test' });
    assertEqual(result.title, 'Test', 'title should be preserved');
    assertNull(result.vaultSource, 'missing vaultSource should be null');
});

test('B04: matchesPinBlock bare pin matches entry by title (case-insensitive)', () => {
    const entry = makeEntry('Dragon Lore', { vaultSource: 'MyVault' });
    assert(matchesPinBlock('dragon lore', entry), 'case-insensitive match should succeed');
});

test('B05: matchesPinBlock vault-qualified pin matches only correct vault', () => {
    const entry1 = makeEntry('Dragon Lore', { vaultSource: 'VaultA' });
    const entry2 = makeEntry('Dragon Lore', { vaultSource: 'VaultB' });
    assert(matchesPinBlock({ title: 'Dragon Lore', vaultSource: 'VaultA' }, entry1), 'matching vault should succeed');
    assert(!matchesPinBlock({ title: 'Dragon Lore', vaultSource: 'VaultA' }, entry2), 'different vault should fail');
});

test('B06: matchesPinBlock vault-qualified pin with null vaultSource matches any vault', () => {
    const entry = makeEntry('Dragon Lore', { vaultSource: 'AnyVault' });
    assert(matchesPinBlock({ title: 'Dragon Lore', vaultSource: null }, entry), 'null vaultSource should match any vault');
});

test('B07: matchesPinBlock title mismatch returns false', () => {
    const entry = makeEntry('Dragon Lore');
    assert(!matchesPinBlock('Elf Lore', entry), 'title mismatch should return false');
});

test('B08: normalizePinBlock structured with empty string vaultSource normalizes to null', () => {
    const result = normalizePinBlock({ title: 'Test', vaultSource: '' });
    assertNull(result.vaultSource, 'empty string vaultSource should normalize to null');
});

test('B09: normalizeLoreGap structured gap preserved', () => {
    const gap = { id: 'g1', topic: 'Magic System', status: 'pending', flaggedBy: 'ai' };
    const result = normalizeLoreGap(gap);
    assertEqual(result.status, 'pending', 'pending status should be preserved');
    assertEqual(result.topic, 'Magic System', 'topic should be preserved');
});

test('B10: normalizeLoreGap legacy status collapses to pending', () => {
    const gap = { id: 'g2', topic: 'History', status: 'acknowledged' };
    const result = normalizeLoreGap(gap);
    assertEqual(result.status, 'pending', 'acknowledged should collapse to pending');
});

test('B11: normalizeLoreGap written status preserved', () => {
    const gap = { id: 'g3', topic: 'Geography', status: 'written' };
    const result = normalizeLoreGap(gap);
    assertEqual(result.status, 'written', 'written status should be preserved');
});

test('B12: normalizeLoreGap in_progress collapses to pending', () => {
    const gap = { id: 'g4', topic: 'Culture', status: 'in_progress' };
    const result = normalizeLoreGap(gap);
    assertEqual(result.status, 'pending', 'in_progress should collapse to pending');
});

test('B13: fuzzyTitleMatch exact match', () => {
    const result = fuzzyTitleMatch('Dragon Lore', ['Dragon Lore', 'Elf History', 'Magic']);
    assertNotNull(result, 'exact match should return result');
    assertEqual(result.title, 'Dragon Lore', 'should match exact title');
    assertEqual(result.similarity, 1.0, 'exact match similarity should be 1.0');
});

test('B14: fuzzyTitleMatch case differences', () => {
    const result = fuzzyTitleMatch('dragon lore', ['Dragon Lore', 'Elf History']);
    assertNotNull(result, 'case-insensitive fuzzy match should return result');
    assertEqual(result.title, 'Dragon Lore', 'should match despite case');
});

test('B15: fuzzyTitleMatch underscores vs spaces', () => {
    const result = fuzzyTitleMatch('Dragon_Lore', ['Dragon Lore', 'Elf History']);
    assertNotNull(result, 'underscore vs space should be close enough for fuzzy match');
    assertEqual(result.title, 'Dragon Lore', 'should match despite underscore');
});

test('B16: fuzzyTitleMatch no match below threshold', () => {
    const result = fuzzyTitleMatch('ZZZZZ', ['Dragon Lore', 'Elf History']);
    assertNull(result, 'completely different title should return null');
});

// ============================================================================
// C. VaultEntry Shape Contracts via parseVaultFile
// ============================================================================

section('C. VaultEntry Shape Contracts via parseVaultFile');

const tagConfig = {
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    seedTag: 'lorebook-seed',
    bootstrapTag: 'lorebook-bootstrap',
    guideTag: 'lorebook-guide',
};

test('C01: Minimal valid entry (title from filename, lorebook tag only)', () => {
    const file = {
        filename: 'Dragon.md',
        content: '---\ntags:\n  - lorebook\n---\n\nSome dragon content.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertNotNull(entry, 'should parse valid entry');
    assertEqual(entry.title, 'Dragon', 'title should come from filename');
    assertEqual(entry.content, 'Some dragon content.', 'content should be body text');
});

test('C02: Full entry with all frontmatter fields produces correct shape', () => {
    const file = {
        filename: 'world/Dragon Lore.md',
        content: [
            '---',
            'tags:',
            '  - lorebook',
            '  - creature',
            'keys:',
            '  - dragon',
            '  - wyrm',
            'priority: 10',
            'summary: Everything about dragons',
            'position: in_chat',
            'depth: 3',
            'role: system',
            'cooldown: 2',
            'warmup: 1',
            'probability: 0.8',
            'scanDepth: 8',
            'excludeRecursion: true',
            'requires:',
            '  - Fantasy World',
            'excludes:',
            '  - Sci-Fi World',
            'refine_keys:',
            '  - fire',
            'cascade_links:',
            '  - Dragon Rider',
            'graph: false',
            '---',
            '',
            '# Dragon Lore',
            '',
            'Dragons are powerful creatures.',
        ].join('\n'),
    };
    const entry = parseVaultFile(file, tagConfig);
    assertNotNull(entry, 'should parse full entry');
    assertEqual(entry.title, 'Dragon Lore', 'title from H1');
    assertEqual(entry.keys, ['dragon', 'wyrm'], 'keys extracted');
    assertEqual(entry.priority, 10, 'priority from frontmatter');
    assertEqual(entry.summary, 'Everything about dragons', 'summary from frontmatter');
    assertEqual(entry.injectionPosition, 1, 'in_chat maps to position 1');
    assertEqual(entry.injectionDepth, 3, 'depth from frontmatter');
    assertEqual(entry.cooldown, 2, 'cooldown from frontmatter');
    assertEqual(entry.warmup, 1, 'warmup from frontmatter');
    assertEqual(entry.probability, 0.8, 'probability from frontmatter');
    assertEqual(entry.scanDepth, 8, 'scanDepth from frontmatter');
    assertEqual(entry.excludeRecursion, true, 'excludeRecursion from frontmatter');
    assertEqual(entry.requires, ['Fantasy World'], 'requires from frontmatter');
    assertEqual(entry.excludes, ['Sci-Fi World'], 'excludes from frontmatter');
    assertEqual(entry.refineKeys, ['fire'], 'refineKeys from frontmatter');
    assertEqual(entry.cascadeLinks, ['Dragon Rider'], 'cascadeLinks from frontmatter');
    assertEqual(entry.graph, false, 'graph from frontmatter');
    assertContains(entry.tags, 'creature', 'non-lorebook tags preserved');
    assert(!entry.tags.includes('lorebook'), 'lorebook tag itself should be filtered out');
    assertEqual(entry.folderPath, 'world', 'folderPath from filename');
});

test('C03: Missing keys produces empty array (not undefined)', () => {
    const file = {
        filename: 'NoKeys.md',
        content: '---\ntags:\n  - lorebook\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assert(Array.isArray(entry.keys), 'keys should be an array');
    assertEqual(entry.keys.length, 0, 'keys should be empty');
});

test('C04: Missing content produces empty string (not undefined)', () => {
    const file = {
        filename: 'Empty.md',
        content: '---\ntags:\n  - lorebook\n---\n',
    };
    const entry = parseVaultFile(file, tagConfig);
    assert(typeof entry.content === 'string', 'content should be a string');
});

test('C05: Missing priority defaults to 100', () => {
    const file = {
        filename: 'NoPriority.md',
        content: '---\ntags:\n  - lorebook\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.priority, 100, 'default priority should be 100');
});

test('C06: Tags extraction from frontmatter (lorebook tag filtered)', () => {
    const file = {
        filename: 'Tagged.md',
        content: '---\ntags:\n  - lorebook\n  - npc\n  - quest\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.tags.length, 2, 'should have 2 non-lorebook tags');
    assertContains(entry.tags, 'npc', 'npc tag present');
    assertContains(entry.tags, 'quest', 'quest tag present');
});

test('C07: Constant detection via lorebook-always tag', () => {
    const file = {
        filename: 'Constant.md',
        content: '---\ntags:\n  - lorebook\n  - lorebook-always\n---\n\nAlways inject.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.constant, true, 'lorebook-always should set constant=true');
});

test('C08: Seed detection via lorebook-seed tag', () => {
    const file = {
        filename: 'Seed.md',
        content: '---\ntags:\n  - lorebook\n  - lorebook-seed\n---\n\nSeed content.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.seed, true, 'lorebook-seed should set seed=true');
});

test('C09: Bootstrap detection via lorebook-bootstrap tag', () => {
    const file = {
        filename: 'Bootstrap.md',
        content: '---\ntags:\n  - lorebook\n  - lorebook-bootstrap\n---\n\nBootstrap content.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.bootstrap, true, 'lorebook-bootstrap should set bootstrap=true');
});

test('C10: tokenEstimate is initialized to 0 (pipeline sets it later)', () => {
    const file = {
        filename: 'Tokens.md',
        content: '---\ntags:\n  - lorebook\n---\n\nSome content here to count tokens from.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.tokenEstimate, 0, 'tokenEstimate should be 0 (set post-parse)');
});

test('C11: injectionPosition from position: before', () => {
    const file = {
        filename: 'Before.md',
        content: '---\ntags:\n  - lorebook\nposition: before\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.injectionPosition, 2, 'before maps to position 2');
});

test('C12: injectionPosition from position: after', () => {
    const file = {
        filename: 'After.md',
        content: '---\ntags:\n  - lorebook\nposition: after\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.injectionPosition, 0, 'after maps to position 0');
});

test('C13: cooldown/warmup/probability null when not in frontmatter', () => {
    const file = {
        filename: 'NoCooldown.md',
        content: '---\ntags:\n  - lorebook\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertNull(entry.cooldown, 'cooldown should be null when absent');
    assertNull(entry.warmup, 'warmup should be null when absent');
    assertNull(entry.probability, 'probability should be null when absent');
});

test('C14: Links extracted from wiki-style links in content', () => {
    const file = {
        filename: 'Linked.md',
        content: '---\ntags:\n  - lorebook\n---\n\nSee [[Dragon Rider]] and [[Magic System|Magic]].',
    };
    const entry = parseVaultFile(file, tagConfig);
    assert(Array.isArray(entry.links), 'links should be an array');
    assertContains(entry.links, 'Dragon Rider', 'should contain Dragon Rider link');
    assertContains(entry.links, 'Magic System', 'should contain Magic System link target');
});

test('C15: Summary from frontmatter', () => {
    const file = {
        filename: 'WithSummary.md',
        content: '---\ntags:\n  - lorebook\nsummary: A brief description\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.summary, 'A brief description', 'summary should come from frontmatter');
});

test('C16: Entry without lorebook tag returns null', () => {
    const file = {
        filename: 'NotLore.md',
        content: '---\ntags:\n  - random\n---\n\nNot a lorebook entry.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertNull(entry, 'entry without lorebook tag should return null');
});

test('C17: Entry with enabled: false returns null', () => {
    const file = {
        filename: 'Disabled.md',
        content: '---\ntags:\n  - lorebook\nenabled: false\n---\n\nDisabled entry.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertNull(entry, 'disabled entry should return null');
});

test('C18: resolvedLinks is always empty array from parsing', () => {
    const file = {
        filename: 'Resolved.md',
        content: '---\ntags:\n  - lorebook\n---\n\nContent with [[Link]].',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.resolvedLinks, [], 'resolvedLinks should be [] from parse (resolved later)');
});

test('C19: vaultSource defaults to empty string', () => {
    const file = {
        filename: 'VaultSource.md',
        content: '---\ntags:\n  - lorebook\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.vaultSource, '', 'vaultSource should default to empty string');
});

test('C20: probability clamped to 0-1 range', () => {
    const file = {
        filename: 'HighProb.md',
        content: '---\ntags:\n  - lorebook\nprobability: 1.5\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 1.0, 'probability > 1 should be clamped to 1.0');
});

test('C21: depth clamped to max 10000', () => {
    const file = {
        filename: 'DeepDepth.md',
        content: '---\ntags:\n  - lorebook\ndepth: 50000\nposition: in_chat\n---\n\nContent.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.injectionDepth, 10000, 'depth should be clamped to 10000');
});

test('C22: guide entry detected via lorebook-guide tag', () => {
    const file = {
        filename: 'Guide.md',
        content: '---\ntags:\n  - lorebook-guide\n---\n\nWriting guide content.',
    };
    const entry = parseVaultFile(file, tagConfig);
    assertNotNull(entry, 'guide entry should be parsed');
    assertEqual(entry.guide, true, 'guide flag should be true');
});

// ============================================================================
// D. TrackerKey Contract
// ============================================================================

section('D. TrackerKey Contract');

test('D01: trackerKey with vaultSource produces "vaultSource:title"', () => {
    const entry = makeEntry('Dragon Lore', { vaultSource: 'MainVault' });
    assertEqual(trackerKey(entry), 'MainVault:Dragon Lore', 'should produce vaultSource:title format');
});

test('D02: trackerKey without vaultSource produces ":title"', () => {
    const entry = makeEntry('Dragon Lore', { vaultSource: '' });
    assertEqual(trackerKey(entry), ':Dragon Lore', 'empty vaultSource should produce :title');
});

test('D03: trackerKey with special characters in title', () => {
    const entry = makeEntry("King's Crown: A Story", { vaultSource: 'V1' });
    assertEqual(trackerKey(entry), "V1:King's Crown: A Story", 'special chars should be preserved verbatim');
});

test('D04: two entries same title different vaultSource produce different keys', () => {
    const a = makeEntry('Dragon Lore', { vaultSource: 'VaultA' });
    const b = makeEntry('Dragon Lore', { vaultSource: 'VaultB' });
    assertNotEqual(trackerKey(a), trackerKey(b), 'different vaults should produce different keys');
});

test('D05: two entries same title same vaultSource produce same key', () => {
    const a = makeEntry('Dragon Lore', { vaultSource: 'VaultA' });
    const b = makeEntry('Dragon Lore', { vaultSource: 'VaultA' });
    assertEqual(trackerKey(a), trackerKey(b), 'same vault+title should produce same key');
});

test('D06: trackerKey used in Map correctly differentiates multi-vault entries', () => {
    const map = new Map();
    const a = makeEntry('Dragon Lore', { vaultSource: 'VaultA' });
    const b = makeEntry('Dragon Lore', { vaultSource: 'VaultB' });
    map.set(trackerKey(a), 'fromA');
    map.set(trackerKey(b), 'fromB');
    assertEqual(map.size, 2, 'map should have 2 entries for different vaults');
    assertEqual(map.get(trackerKey(a)), 'fromA', 'should retrieve correct value for VaultA');
    assertEqual(map.get(trackerKey(b)), 'fromB', 'should retrieve correct value for VaultB');
});

test('D07: trackerKey with undefined vaultSource uses empty string', () => {
    const entry = { title: 'Test', vaultSource: undefined };
    assertEqual(trackerKey(entry), ':Test', 'undefined vaultSource should fall back to empty string');
});

test('D08: trackerKey with null vaultSource uses empty string', () => {
    const entry = { title: 'Test', vaultSource: null };
    assertEqual(trackerKey(entry), ':Test', 'null vaultSource should fall back to empty string');
});

test('D09: entries with empty titles but different vaults still differ', () => {
    const a = { title: '', vaultSource: 'VaultA' };
    const b = { title: '', vaultSource: 'VaultB' };
    assertNotEqual(trackerKey(a), trackerKey(b), 'empty titles with different vaults should differ');
});

test('D10: trackerKey is consistent (idempotent)', () => {
    const entry = makeEntry('Consistent Entry', { vaultSource: 'V1' });
    const key1 = trackerKey(entry);
    const key2 = trackerKey(entry);
    assertEqual(key1, key2, 'repeated calls should produce the same key');
});

// ============================================================================
// E. Settings Validation & Migration
// ============================================================================

section('E. Settings Validation & Migration');

test('E01: validateSettings clamps below-min value to min', () => {
    const settings = { scanDepth: -5 };
    const constraints = { scanDepth: { min: 0, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, 0, 'value below min should clamp to min');
});

test('E02: validateSettings clamps above-max value to max', () => {
    const settings = { maxEntries: 9999 };
    const constraints = { maxEntries: { min: 1, max: 200, label: 'Max Entries' } };
    validateSettings(settings, constraints);
    assertEqual(settings.maxEntries, 200, 'value above max should clamp to max');
});

test('E03: validateSettings does not clamp in-range value', () => {
    const settings = { scanDepth: 10 };
    const constraints = { scanDepth: { min: 0, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, 10, 'in-range value should be preserved');
});

test('E04: validateSettings with non-number for numeric field leaves it untouched', () => {
    const settings = { scanDepth: 'not a number' };
    const constraints = { scanDepth: { min: 0, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    // validateSettings only clamps if typeof is number
    assertEqual(settings.scanDepth, 'not a number', 'non-number should be left untouched');
});

test('E05: Settings roundtrip: makeSettings() then validateSettings() keeps all fields valid', () => {
    const settings = makeSettings();
    const constraints = {
        scanDepth: { min: 0, max: 50, label: 'Scan Depth' },
        maxEntries: { min: 1, max: 200, label: 'Max Entries' },
        maxTokensBudget: { min: 100, max: 100000, label: 'Max Tokens Budget' },
    };
    const before = JSON.parse(JSON.stringify(settings));
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, before.scanDepth, 'scanDepth should be unchanged');
    assertEqual(settings.maxEntries, before.maxEntries, 'maxEntries should be unchanged');
    assertEqual(settings.maxTokensBudget, before.maxTokensBudget, 'maxTokensBudget should be unchanged');
});

test('E06: validateSettings trims lorebookTag whitespace', () => {
    const settings = { lorebookTag: '  lorebook  ' };
    validateSettings(settings, {});
    assertEqual(settings.lorebookTag, 'lorebook', 'lorebookTag should be trimmed');
});

test('E07: validateSettings replaces empty lorebookTag with "lorebook"', () => {
    const settings = { lorebookTag: '   ' };
    validateSettings(settings, {});
    assertEqual(settings.lorebookTag, 'lorebook', 'empty lorebookTag should default to "lorebook"');
});

test('E08: validateSettings rounds float to integer for integer range constraints', () => {
    const settings = { maxEntries: 15.7 };
    const constraints = { maxEntries: { min: 1, max: 200, label: 'Max Entries' } };
    validateSettings(settings, constraints);
    assertEqual(settings.maxEntries, 16, 'float should be rounded for integer range');
});

test('E09: validateSettings enum: valid value preserved', () => {
    const settings = { contextualGatingTolerance: 'strict' };
    const constraints = {
        contextualGatingTolerance: { label: 'Tolerance', enum: ['strict', 'moderate', 'lenient'] },
    };
    validateSettings(settings, constraints);
    assertEqual(settings.contextualGatingTolerance, 'strict', 'valid enum value should be preserved');
});

test('E10: validateSettings enum: invalid value reset to first allowed', () => {
    const settings = { contextualGatingTolerance: 'invalid' };
    const constraints = {
        contextualGatingTolerance: { label: 'Tolerance', enum: ['strict', 'moderate', 'lenient'] },
    };
    validateSettings(settings, constraints);
    assertEqual(settings.contextualGatingTolerance, 'strict', 'invalid enum should reset to first allowed');
});

test('E11: validateSettings enum with defaults: invalid value uses default', () => {
    const settings = { contextualGatingTolerance: 'invalid' };
    const constraints = {
        contextualGatingTolerance: { label: 'Tolerance', enum: ['strict', 'moderate', 'lenient'] },
    };
    const defaults = { contextualGatingTolerance: 'moderate' };
    validateSettings(settings, constraints, defaults);
    assertEqual(settings.contextualGatingTolerance, 'moderate', 'invalid enum with defaults should use default');
});

test('E12: validateSettings preserves float precision for float-range constraints', () => {
    const settings = { fuzzyScore: 0.75 };
    const constraints = { fuzzyScore: { min: 0.1, max: 2.0, label: 'Fuzzy Score' } };
    validateSettings(settings, constraints);
    assertEqual(settings.fuzzyScore, 0.75, 'float precision should be preserved for float ranges');
});

// ============================================================================
// F. Helper Function Contracts
// ============================================================================

section('F. Helper Function Contracts');

test('F01: isForceInjected: constant entry returns true', () => {
    const entry = makeEntry('Test', { constant: true });
    assert(isForceInjected(entry, { bootstrapActive: false }), 'constant should be force-injected');
});

test('F02: isForceInjected: seed entry returns false (not force-injected)', () => {
    const entry = makeEntry('Test', { seed: true });
    assert(!isForceInjected(entry, { bootstrapActive: false }), 'seed alone is not force-injected');
});

test('F03: isForceInjected: bootstrap with active context returns true', () => {
    const entry = makeEntry('Test', { bootstrap: true });
    assert(isForceInjected(entry, { bootstrapActive: true }), 'bootstrap + active context should be force-injected');
});

test('F04: isForceInjected: bootstrap with inactive context returns false', () => {
    const entry = makeEntry('Test', { bootstrap: true });
    assert(!isForceInjected(entry, { bootstrapActive: false }), 'bootstrap + inactive context should not be force-injected');
});

test('F05: isForceInjected: normal entry returns false', () => {
    const entry = makeEntry('Test');
    assert(!isForceInjected(entry, { bootstrapActive: false }), 'normal entry should not be force-injected');
});

test('F06: convertWiEntry produces valid filename and content', () => {
    const wiEntry = {
        comment: 'Dragon',
        key: ['dragon', 'wyrm'],
        content: 'A powerful creature.',
        order: 10,
        constant: false,
        position: 0,
    };
    const result = convertWiEntry(wiEntry, 'lorebook');
    assertNotNull(result, 'convertWiEntry should return a result');
    assertMatch(result.filename, /\.md$/, 'filename should end with .md');
    assert(result.content.includes('---'), 'content should include frontmatter delimiters');
    assert(result.content.includes('# Dragon'), 'content should include H1 title');
    assert(result.content.includes('A powerful creature'), 'content should include body');
});

test('F07: stripObsidianSyntax: Templater expressions stripped', () => {
    const result = stripObsidianSyntax('Hello {{tp.date.now()}} world');
    assertEqual(result, 'Hello  world', 'Templater expressions should be stripped');
});

test('F08: stripObsidianSyntax: image embeds stripped', () => {
    // Note: stripObsidianSyntax doesn't strip ![[]] — that's cleanContent's job
    // stripObsidianSyntax handles Templater, Dataview, comments, obsidian:// links
    const result = stripObsidianSyntax('Before %%hidden%% after');
    assertEqual(result, 'Before  after', 'Obsidian comments should be stripped');
});

test('F09: stripObsidianSyntax: dataview code blocks stripped', () => {
    const result = stripObsidianSyntax('Before\n```dataview\nTABLE file.name\nFROM "notes"\n```\nAfter');
    assertEqual(result, 'Before\n\nAfter', 'dataview code blocks should be stripped');
});

test('F10: stripObsidianSyntax: obsidian:// links stripped but text preserved', () => {
    const result = stripObsidianSyntax('Click [here](obsidian://open?vault=test&file=note)');
    assertEqual(result, 'Click here', 'obsidian:// links should be stripped but text preserved');
});

test('F11: stripObsidianSyntax: null/undefined returns empty string', () => {
    assertEqual(stripObsidianSyntax(null), '', 'null should return empty string');
    assertEqual(stripObsidianSyntax(undefined), '', 'undefined should return empty string');
});

test('F12: tokenBarColor returns HSL color for various ratios', () => {
    const low = tokenBarColor(10, 100); // ratio 0.1 → hue 120
    assertMatch(low, /hsl\(120/, 'low ratio should produce green (hue 120)');

    const mid = tokenBarColor(100, 100); // ratio 1.0 → hue 60
    assertMatch(mid, /hsl\(60/, 'ratio 1.0 should produce yellow (hue 60)');

    const high = tokenBarColor(200, 100); // ratio 2.0 → hue 0
    assertMatch(high, /hsl\(0/, 'high ratio should produce red (hue 0)');
});

test('F13: tokenBarColor with zero avgTokens returns CSS variable fallback', () => {
    const result = tokenBarColor(100, 0);
    assert(result.includes('var('), 'zero avgTokens should return CSS variable fallback');
});

test('F14: formatRelativeTime produces expected strings', () => {
    const now = Date.now();
    assertEqual(formatRelativeTime(now), 'just now', 'current time should be "just now"');
    assertEqual(formatRelativeTime(now - 5 * 60000), '5m ago', '5 minutes ago');
    assertEqual(formatRelativeTime(now - 3 * 3600000), '3h ago', '3 hours ago');
    assertEqual(formatRelativeTime(now - 2 * 86400000), '2d ago', '2 days ago');
});

test('F15: formatRelativeTime with zero/null returns empty string', () => {
    assertEqual(formatRelativeTime(0), '', 'zero timestamp should return empty string');
    assertEqual(formatRelativeTime(null), '', 'null timestamp should return empty string');
});

test('F16: parseMatchReason: constant', () => {
    const result = parseMatchReason('constant');
    assertEqual(result.type, 'constant', 'should detect constant type');
});

test('F17: parseMatchReason: pinned', () => {
    const result = parseMatchReason('pinned');
    assertEqual(result.type, 'pinned', 'should detect pinned type');
});

test('F18: parseMatchReason: keyword + AI two-stage', () => {
    const result = parseMatchReason('dragon \u2192 AI: relevant to scene');
    assertEqual(result.type, 'keyword_ai', 'should detect keyword_ai type');
    assertEqual(result.keyword, 'dragon', 'should extract keyword');
});

test('F19: parseMatchReason: pure AI match', () => {
    const result = parseMatchReason('AI: good match');
    assertEqual(result.type, 'ai', 'should detect ai type');
});

test('F20: parseMatchReason: bare keyword', () => {
    const result = parseMatchReason('dragon');
    assertEqual(result.type, 'keyword', 'should detect keyword type');
    assertEqual(result.keyword, 'dragon', 'keyword should be the input');
});

test('F21: parseMatchReason: null input', () => {
    const result = parseMatchReason(null);
    assertEqual(result.type, 'unknown', 'null should return unknown');
});

test('F22: computeSourcesDiff detects added entries', () => {
    const current = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
    const previous = [{ title: 'A' }, { title: 'B' }];
    const diff = computeSourcesDiff(current, previous);
    assertEqual(diff.added.length, 1, 'should detect 1 added entry');
    assertEqual(diff.added[0].title, 'C', 'added entry should be C');
    assertEqual(diff.removed.length, 0, 'should detect 0 removed entries');
});

test('F23: computeSourcesDiff detects removed entries', () => {
    const current = [{ title: 'A' }];
    const previous = [{ title: 'A' }, { title: 'B', matchedBy: 'keyword' }];
    const diff = computeSourcesDiff(current, previous);
    assertEqual(diff.removed.length, 1, 'should detect 1 removed entry');
    assertEqual(diff.removed[0].title, 'B', 'removed entry should be B');
    assert(diff.removed[0].removalReason, 'removed entry should have a removalReason');
});

test('F24: computeSourcesDiff with null previous returns empty diff', () => {
    const diff = computeSourcesDiff([{ title: 'A' }], null);
    assertEqual(diff.added.length, 0, 'no added with null previous');
    assertEqual(diff.removed.length, 0, 'no removed with null previous');
});

test('F25: categorizeRejections with null trace returns empty array', () => {
    const result = categorizeRejections(null, new Set());
    assertEqual(result, [], 'null trace should return empty array');
});

test('F26: categorizeRejections groups gated out entries', () => {
    const trace = {
        gatedOut: [{ title: 'Blocked', requires: ['Needed'], excludes: [] }],
    };
    const injected = new Set();
    const result = categorizeRejections(trace, injected);
    assert(result.length > 0, 'should produce at least one group');
    assertEqual(result[0].stage, 'gated_out', 'first group should be gated_out');
    assertEqual(result[0].entries[0].title, 'Blocked', 'should contain Blocked entry');
});

test('F27: categorizeRejections excludes already-injected entries', () => {
    // BUG-AUDIT v2.5: injectedKeys is now a Set of trackerKey-shape strings (':title' when no vault).
    const trace = {
        gatedOut: [{ title: 'Injected', requires: ['Needed'], excludes: [] }],
    };
    const injected = new Set([':injected']);
    const result = categorizeRejections(trace, injected);
    assertEqual(result.length, 0, 'injected entries should be excluded from rejection groups');
});

test('F28: resolveEntryVault with matching vault', () => {
    const source = { vaultSource: 'MainVault', filename: 'notes/Dragon.md' };
    const vaults = [{ name: 'MainVault' }, { name: 'SecondVault' }];
    const result = resolveEntryVault(source, vaults);
    assertEqual(result.vaultName, 'MainVault', 'should resolve to matching vault name');
    assertNotNull(result.uri, 'should produce a URI');
    assertMatch(result.uri, /obsidian:\/\//, 'URI should be an obsidian:// URI');
});

test('F29: resolveEntryVault with no matching vault falls back', () => {
    const source = { vaultSource: 'Unknown', filename: 'Dragon.md' };
    const vaults = [{ name: 'MainVault' }];
    const result = resolveEntryVault(source, vaults);
    assertEqual(result.vaultName, 'Unknown', 'should use vaultSource as name when no match');
});

test('F30: resolveEntryVault with no vaults array', () => {
    const source = { vaultSource: '', filename: 'Dragon.md' };
    const result = resolveEntryVault(source, undefined);
    assertEqual(result.vaultName, '', 'should return empty string with no vaults');
});

test('F31: parseMatchReason: bootstrap', () => {
    const result = parseMatchReason('bootstrap');
    assertEqual(result.type, 'bootstrap', 'should detect bootstrap type');
});

test('F32: parseMatchReason: seed', () => {
    const result = parseMatchReason('seed');
    assertEqual(result.type, 'seed', 'should detect seed type');
});

test('F33: computeSourcesDiff bootstrap removal gets specific reason', () => {
    const current = [];
    const previous = [{ title: 'Start', matchedBy: 'bootstrap' }];
    const diff = computeSourcesDiff(current, previous);
    assertEqual(diff.removed[0].removalReason, 'Bootstrap fall-off', 'bootstrap removal should have specific reason');
});

test('F34: computeSourcesDiff constant removal gets specific reason', () => {
    const current = [];
    const previous = [{ title: 'Always', matchedBy: 'constant' }];
    const diff = computeSourcesDiff(current, previous);
    assertEqual(diff.removed[0].removalReason, 'Constant removed', 'constant removal should have specific reason');
});

test('F35: formatRelativeTime future timestamp returns "just now"', () => {
    assertEqual(formatRelativeTime(Date.now() + 60000), 'just now', 'future timestamp should be "just now"');
});

// ============================================================================
// Summary
// ============================================================================

await summary('Contract Tests');
