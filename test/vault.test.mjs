/**
 * DeepLore Enhanced — Vault, Multi-Vault, Dedup & Search Tests
 * Run with: node test/vault.test.mjs
 *
 * Covers: detectCrossVaultDuplicates, deduplicateMultiVault, BM25 search,
 *         entity name tracking, vault path/URI utilities, index snapshot/change
 *         detection, and entry clustering.
 */

import {
    assert, assertEqual, assertNotEqual, assertNull, assertNotNull,
    assertGreaterThan, assertLessThan, assertContains,
    test, section, summary, makeEntry, makeSettings,
} from './helpers.mjs';

import {
    detectCrossVaultDuplicates, deduplicateMultiVault, computeEntityDerivedState,
    classifyReuseFetch, classifyDedupProbe, PARTIAL_FETCH_FAILURE_THRESHOLD,
} from '../src/vault/vault-pure.js';

import { buildBM25Index, queryBM25 } from '../src/vault/bm25.js';

import {
    diffEntries, shouldUseIncremental,
    incrementalMentionWeights, incrementalBM25Update, incrementalEntityRegexes,
    fullMentionWeights, computeEntryBM25TF, bm25DocId,
} from '../src/vault/vault-incremental.js';

import {
    encodeVaultPath, validateVaultPath, pruneCircuitBreakers,
} from '../src/vault/obsidian-api.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
    trackerKey, setEntityNameSet, entityNameSet,
    setEntityShortNameRegexes, entityShortNameRegexes,
} from '../src/state.js';

import { buildObsidianURI, clusterEntries } from '../src/helpers.js';

import { takeIndexSnapshot, detectChanges } from '../core/sync.js';

console.log('DeepLore Enhanced — Vault & Multi-Vault Tests');
console.log('='.repeat(60));

// ============================================================================
//  A. detectCrossVaultDuplicates (12 tests)
// ============================================================================

section('A. detectCrossVaultDuplicates');

test('A1: no duplicates returns empty array', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Elf', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 0, 'no cross-vault dups');
});

test('A2: same title in 2 vaults detected', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'one dup detected');
    assertEqual(dupes[0].title, 'Dragon', 'title is Dragon');
    assert(dupes[0].vaults.includes('v1'), 'v1 listed');
    assert(dupes[0].vaults.includes('v2'), 'v2 listed');
});

test('A3: same title in 3 vaults detected with all vaults listed', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
        makeEntry('Dragon', { vaultSource: 'v3' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'one dup group');
    assertEqual(dupes[0].vaults.length, 3, 'all 3 vaults listed');
    assert(dupes[0].vaults.includes('v3'), 'v3 in vaults');
});

test('A4: case-insensitive detection — "Eris" vs "eris"', () => {
    const entries = [
        makeEntry('Eris', { vaultSource: 'vaultA' }),
        makeEntry('eris', { vaultSource: 'vaultB' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'case-insensitive dup found');
    assert(dupes[0].vaults.includes('vaultA'), 'vaultA listed');
    assert(dupes[0].vaults.includes('vaultB'), 'vaultB listed');
});

test('A5: different titles produce no duplicate', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Wyvern', { vaultSource: 'v2' }),
    ];
    assertEqual(detectCrossVaultDuplicates(entries).length, 0, 'no dup');
});

test('A6: same vault, same title is NOT a cross-vault duplicate', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v1' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 0, 'same vault same title not cross-vault');
});

test('A7: empty entries returns empty', () => {
    assertEqual(detectCrossVaultDuplicates([]).length, 0, 'empty input');
});

test('A8: missing vaultSource defaults to "(unknown)"', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: '' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'dup detected with unknown vault');
    // vaultSource '' => '(unknown)'
    assert(dupes[0].vaults.includes('(unknown)'), '(unknown) listed for empty vaultSource');
    assert(dupes[0].vaults.includes('v2'), 'v2 listed');
});

test('A9: multiple duplicate titles produce multiple results', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
        makeEntry('Elf', { vaultSource: 'v1' }),
        makeEntry('Elf', { vaultSource: 'v3' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 2, 'two dup groups');
    const titles = dupes.map(d => d.title.toLowerCase());
    assert(titles.includes('dragon'), 'dragon group found');
    assert(titles.includes('elf'), 'elf group found');
});

test('A10: titles with special characters still detected', () => {
    const entries = [
        makeEntry('"The [Great] Dragon"', { vaultSource: 'v1' }),
        makeEntry('"The [Great] Dragon"', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'special char title dup detected');
});

test('A11: single entry returns no duplicates', () => {
    const entries = [makeEntry('Dragon', { vaultSource: 'v1' })];
    assertEqual(detectCrossVaultDuplicates(entries).length, 0, 'single entry no dup');
});

test('A12: display title preserved from first vault seen', () => {
    const entries = [
        makeEntry('Eris', { vaultSource: 'v1' }),
        makeEntry('ERIS', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes[0].title, 'Eris', 'preserves first display title');
});

// ============================================================================
//  B. deduplicateMultiVault — All 4 Modes (26 tests)
// ============================================================================

section('B. deduplicateMultiVault — All 4 Modes');

test('B1: mode "all" returns all entries unchanged', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'a' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'b' }),
    ];
    const result = deduplicateMultiVault(entries, 'all');
    assertEqual(result.length, 2, 'all keeps both');
    assertEqual(result[0].content, 'a', 'first unchanged');
    assertEqual(result[1].content, 'b', 'second unchanged');
});

test('B2: null mode returns all (same as "all")', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, null).length, 2, 'null = no dedup');
});

test('B3: undefined mode returns all', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, undefined).length, 2, 'undefined = no dedup');
});

test('B4: empty string mode returns all', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, '').length, 2, 'empty string = no dedup');
});

test('B5: mode "first" keeps first vault copy', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'first content' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'second content' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 1, 'deduped to one');
    assertEqual(result[0].content, 'first content', 'first vault content kept');
    assertEqual(result[0].vaultSource, 'v1', 'first vault source kept');
});

test('B6: mode "first" discards later entry data entirely', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', keys: ['fire'], tags: ['lorebook'] }),
        makeEntry('Dragon', { vaultSource: 'v2', keys: ['ice'], tags: ['lorebook', 'creature'] }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result[0].keys.length, 1, 'only first keys');
    assertEqual(result[0].keys[0], 'fire', 'first keys kept');
    assert(!result[0].keys.includes('ice'), 'second keys discarded');
});

test('B7: mode "last" keeps last vault copy', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'first' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'second' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result.length, 1, 'deduped to one');
    assertEqual(result[0].content, 'second', 'last vault content kept');
});

test('B8: mode "last" earlier entry data replaced', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', summary: 'old summary' }),
        makeEntry('Dragon', { vaultSource: 'v2', summary: 'new summary' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result[0].summary, 'new summary', 'last vault summary replaces');
});

test('B9: mode "merge" unions array fields (keys, tags, links, requires, excludes)', () => {
    const entries = [
        makeEntry('Dragon', {
            keys: ['fire', 'drake'], tags: ['lorebook'], links: ['Castle'],
            requires: ['Mountain'], excludes: ['Sea'],
        }),
        makeEntry('Dragon', {
            keys: ['drake', 'wyrm'], tags: ['lorebook', 'beast'], links: ['Castle', 'Cave'],
            requires: ['Mountain', 'Volcano'], excludes: ['Sea', 'Ocean'],
        }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 1, 'merged to one');
    // keys
    assert(result[0].keys.includes('fire'), 'keys: fire');
    assert(result[0].keys.includes('wyrm'), 'keys: wyrm');
    assertEqual(result[0].keys.length, 3, 'keys deduped (fire, drake, wyrm)');
    // tags
    assert(result[0].tags.includes('beast'), 'tags: beast merged');
    // links
    assert(result[0].links.includes('Cave'), 'links: Cave merged');
    assertEqual(result[0].links.length, 2, 'links deduped (Castle, Cave)');
    // requires
    assert(result[0].requires.includes('Volcano'), 'requires: Volcano');
    assertEqual(result[0].requires.length, 2, 'requires deduped');
    // excludes
    assert(result[0].excludes.includes('Ocean'), 'excludes: Ocean');
    assertEqual(result[0].excludes.length, 2, 'excludes deduped');
});

test('B10: mode "merge" concatenates content with separator', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire breather.' }),
        makeEntry('Dragon', { content: 'Ice breather.' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assert(result[0].content.includes('Fire breather.'), 'first content present');
    assert(result[0].content.includes('Ice breather.'), 'second content present');
    assert(result[0].content.includes('\n\n---\n\n'), 'separator present');
});

test('B11: mode "merge" sums member tokenEstimates', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Short text.', tokenEstimate: 3 }),
        makeEntry('Dragon', { content: 'More text here.', tokenEstimate: 4 }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    // Sum tokenizer-accurate member estimates (not char/4, which diverged from tokenizer units).
    assertEqual(result[0].tokenEstimate, 7, 'token estimate sums members');
});

test('B12: mode "merge" summary prefers first non-empty', () => {
    const entries = [
        makeEntry('Dragon', { summary: 'A fierce dragon' }),
        makeEntry('Dragon', { summary: 'A tame dragon' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].summary, 'A fierce dragon', 'first summary kept');
});

test('B13: mode "merge" summary uses second if first empty', () => {
    const entries = [
        makeEntry('Dragon', { summary: '' }),
        makeEntry('Dragon', { summary: 'Fallback summary' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].summary, 'Fallback summary', 'second summary used');
});

test('B14: mode "merge" boolean flags OR-merged (constant, seed, bootstrap, guide)', () => {
    const e1 = makeEntry('Dragon', { constant: false, seed: true, bootstrap: false });
    e1.guide = false;
    const e2 = makeEntry('Dragon', { constant: true, seed: false, bootstrap: true });
    e2.guide = true;
    const result = deduplicateMultiVault([e1, e2], 'merge');
    assert(result[0].constant === true, 'constant OR-merged');
    assert(result[0].seed === true, 'seed OR-merged');
    assert(result[0].bootstrap === true, 'bootstrap OR-merged');
    assert(result[0].guide === true, 'guide OR-merged');
});

test('B15: mode "merge" customFields — arrays unioned', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { era: ['medieval'], location: ['cave'] } }),
        makeEntry('Dragon', { customFields: { era: ['medieval', 'modern'], location: ['mountain'] } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.era.length, 2, 'era unioned');
    assert(result[0].customFields.era.includes('modern'), 'era has modern');
    assertEqual(result[0].customFields.location.length, 2, 'location unioned');
    assert(result[0].customFields.location.includes('mountain'), 'location has mountain');
});

test('B16: mode "merge" customFields — scalars: first wins unless null/undefined', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { mood: 'fierce', region: '', count: 0, missing: null } }),
        makeEntry('Dragon', { customFields: { mood: 'calm', region: 'north', count: 42, missing: 'found' } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.mood, 'fierce', 'first non-empty scalar kept');
    // Code uses `== null` (null/undefined only), NOT generic falsy — preserves legitimate '' and 0.
    assertEqual(result[0].customFields.region, '', 'empty string preserved (not null)');
    assertEqual(result[0].customFields.count, 0, 'zero preserved (not null)');
    assertEqual(result[0].customFields.missing, 'found', 'null scalar filled from second');
});

test('B17: BUG-378 — _contentHash preserved from first entry (not recomputed)', () => {
    const e1 = makeEntry('Dragon', { content: 'Original' });
    e1._contentHash = 'abc123_original';
    const e2 = makeEntry('Dragon', { content: 'Extra' });
    e2._contentHash = 'def456_extra';
    const result = deduplicateMultiVault([e1, e2], 'merge');
    assertEqual(result[0]._contentHash, 'abc123_original', '_contentHash preserved from first');
    assert(result[0].content.includes('Extra'), 'content still merged');
});

test('B18: mode "merge" 3 entries same title all merged', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['a'], content: 'one', vaultSource: 'v1' }),
        makeEntry('Dragon', { keys: ['b'], content: 'two', vaultSource: 'v2' }),
        makeEntry('Dragon', { keys: ['c'], content: 'three', vaultSource: 'v3' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 1, 'merged to single entry');
    assertEqual(result[0].keys.length, 3, 'all keys from 3 entries');
    assert(result[0].content.includes('one'), 'first content');
    assert(result[0].content.includes('two'), 'second content');
    assert(result[0].content.includes('three'), 'third content');
});

test('B19: mode "merge" entry with empty content does not double separator', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Real content.' }),
        makeEntry('Dragon', { content: '' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    // Empty content should not trigger concatenation
    assertEqual(result[0].content, 'Real content.', 'empty content not appended');
    assert(!result[0].content.includes('---'), 'no separator for empty content');
});

test('B20: non-duplicate entries unaffected in mode "first"', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'dragon lore' }),
        makeEntry('Elf', { vaultSource: 'v2', content: 'elf lore' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 2, 'both unique kept');
    assertEqual(result[0].content, 'dragon lore', 'dragon unchanged');
    assertEqual(result[1].content, 'elf lore', 'elf unchanged');
});

test('B21: non-duplicate entries unaffected in mode "merge"', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'dragon lore' }),
        makeEntry('Elf', { vaultSource: 'v2', content: 'elf lore' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 2, 'both unique kept in merge mode');
});

test('B22: mixed some duplicated some unique handled correctly', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'v1 dragon' }),
        makeEntry('Elf', { vaultSource: 'v1', content: 'elf' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'v2 dragon' }),
        makeEntry('Orc', { vaultSource: 'v2', content: 'orc' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 3, 'Dragon deduped, Elf+Orc kept');
    const titles = result.map(e => e.title);
    assert(titles.includes('Dragon'), 'Dragon present');
    assert(titles.includes('Elf'), 'Elf present');
    assert(titles.includes('Orc'), 'Orc present');
});

test('B23: mode "merge" does not mutate original entries', () => {
    const e1 = makeEntry('Dragon', { keys: ['fire'], content: 'first' });
    const e2 = makeEntry('Dragon', { keys: ['ice'], content: 'second' });
    const origKeys1 = [...e1.keys];
    const origContent1 = e1.content;
    deduplicateMultiVault([e1, e2], 'merge');
    assertEqual(e1.keys.length, origKeys1.length, 'original keys not mutated');
    assertEqual(e1.content, origContent1, 'original content not mutated');
});

test('B24: mode "merge" resolvedLinks field unioned', () => {
    const entries = [
        makeEntry('Dragon', { resolvedLinks: ['Castle.md'] }),
        makeEntry('Dragon', { resolvedLinks: ['Castle.md', 'Cave.md'] }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].resolvedLinks.length, 2, 'resolvedLinks deduped');
    assert(result[0].resolvedLinks.includes('Cave.md'), 'Cave.md in resolvedLinks');
});

test('B25: mode "merge" customFields new key from second entry added', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { mood: 'fierce' } }),
        makeEntry('Dragon', { customFields: { mood: 'calm', weakness: 'water' } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.weakness, 'water', 'new key from second entry');
    assertEqual(result[0].customFields.mood, 'fierce', 'first scalar preserved');
});

test('B26: mode "last" with 3 entries keeps the very last', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'one' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'two' }),
        makeEntry('Dragon', { vaultSource: 'v3', content: 'three' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result.length, 1, 'deduped to one');
    assertEqual(result[0].content, 'three', 'last vault wins');
    assertEqual(result[0].vaultSource, 'v3', 'v3 source');
});

// ============================================================================
//  C. BM25 Search Edge Cases (17 tests)
// ============================================================================

section('C. BM25 Search Edge Cases');

test('C1: buildBM25Index: basic index creation', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire', 'scales'], content: 'A large fire-breathing dragon.' }),
        makeEntry('Elf', { keys: ['forest', 'magic'], content: 'An ancient elf of the forest.' }),
    ];
    const index = buildBM25Index(entries);
    assertNotNull(index, 'index created');
    assertNotNull(index.idf, 'idf map present');
    assertNotNull(index.docs, 'docs map present');
    assertGreaterThan(index.avgDl, 0, 'avgDl > 0');
    assertEqual(index.docs.size, 2, 'two docs indexed');
});

test('C2: buildBM25Index: entries with no content still indexed by title/keys', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: '' }),
    ];
    const index = buildBM25Index(entries);
    assertEqual(index.docs.size, 1, 'entry indexed');
    // 'dragon' and 'fire' should be in the index
    assert(index.idf.has('dragon'), 'title term in IDF');
    assert(index.idf.has('fire'), 'key term in IDF');
});

test('C3: buildBM25Index: empty entries array returns empty index', () => {
    const index = buildBM25Index([]);
    assertEqual(index.docs.size, 0, 'no docs');
    assertEqual(index.idf.size, 0, 'no IDF terms');
    assertEqual(index.avgDl, 0, 'avgDl is 0');
});

test('C4: queryBM25: exact keyword match produces high score', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'A dragon breathes fire.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'An elf in the forest.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon fire', 10, 0.1);
    assertGreaterThan(results.length, 0, 'has results');
    assertEqual(results[0].title, 'Dragon', 'Dragon scores highest');
});

test('C5: queryBM25: no match returns empty', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'spaceship laser', 10, 0.1);
    assertEqual(results.length, 0, 'no matches');
});

test('C6: queryBM25: multiple matching entries scored and ranked', () => {
    const entries = [
        makeEntry('Fire Dragon', { keys: ['fire', 'dragon'], content: 'A fire dragon with flames.' }),
        makeEntry('Ice Dragon', { keys: ['ice', 'dragon'], content: 'An ice dragon with frost.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'Forest elf.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 10, 0.1);
    assertGreaterThan(results.length, 1, 'multiple dragon matches');
    // Both dragons should score, elf should not
    const titles = results.map(r => r.title);
    assert(titles.includes('Fire Dragon'), 'Fire Dragon matched');
    assert(titles.includes('Ice Dragon'), 'Ice Dragon matched');
});

test('C7: queryBM25: case-insensitive matching', () => {
    const entries = [
        makeEntry('Dragon', { keys: [], content: 'The great DRAGON roars.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 10, 0.1);
    assertGreaterThan(results.length, 0, 'case-insensitive match works');
});

test('C8: queryBM25: multiple query terms score higher for entries with more matches', () => {
    const entries = [
        makeEntry('Fire Dragon', { keys: [], content: 'A fire dragon breathes fire and has scales.' }),
        makeEntry('Dragon Info', { keys: [], content: 'Dragon information page.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'fire dragon scales', 10, 0.1);
    assertGreaterThan(results.length, 0, 'has results');
    // Fire Dragon matches all 3 terms, Dragon Info matches only 'dragon'
    assertEqual(results[0].title, 'Fire Dragon', 'multi-term match ranked first');
});

test('C9: queryBM25: empty query returns empty', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' })];
    const index = buildBM25Index(entries);
    // Empty query tokenizes to nothing
    const results = queryBM25(index, '', 10, 0.1);
    assertEqual(results.length, 0, 'empty query returns nothing');
});

test('C10: queryBM25: single-character query returns empty (tokenizer filters < 2 chars)', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' })];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'a', 10, 0.1);
    assertEqual(results.length, 0, 'single char query filtered');
});

test('C11: queryBM25: entry with many keyword repetitions has higher TF', () => {
    const entries = [
        makeEntry('Dragon Lore', { keys: [], content: 'dragon dragon dragon dragon dragon lore.' }),
        makeEntry('Dragon Brief', { keys: [], content: 'A brief mention of dragon.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 10, 0.1);
    assertEqual(results[0].title, 'Dragon Lore', 'high TF entry ranked first');
    assertGreaterThan(results[0].score, results[1].score, 'higher score for more occurrences');
});

test('C12: queryBM25: maxResults (topK) limit respected', () => {
    const entries = [];
    for (let i = 0; i < 30; i++) {
        entries.push(makeEntry(`Dragon ${i}`, { keys: ['dragon'], content: `Dragon entry number ${i}.` }));
    }
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 5, 0.001);
    assertLessThan(results.length, 6, 'topK limit enforced (max 5)');
    assertGreaterThan(results.length, 0, 'has some results');
});

test('C13: queryBM25: minScore threshold filters low-confidence matches', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'A fire dragon with many words about fire and dragons and scales and caves and treasure and mountains.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'forest elf with leaves and trees and nature.' }),
    ];
    const index = buildBM25Index(entries);
    // Query 'dragon' with very high minScore — may filter some results
    const highThreshold = queryBM25(index, 'dragon', 10, 100.0);
    const lowThreshold = queryBM25(index, 'dragon', 10, 0.01);
    assertGreaterThan(lowThreshold.length, highThreshold.length,
        'higher minScore filters more results (or equal if all score high)');
});

test('C14: queryBM25: special characters in query do not crash', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' })];
    const index = buildBM25Index(entries);
    // These should not throw
    let threw = false;
    try {
        queryBM25(index, '(dragon) [fire] {scales} $$$', 10, 0.1);
        queryBM25(index, 'C++ .NET #hashtag @mention', 10, 0.1);
        queryBM25(index, '***', 10, 0.1);
    } catch {
        threw = true;
    }
    assert(!threw, 'special characters in query did not crash');
});

test('C15: queryBM25: null/undefined index returns empty', () => {
    assertEqual(queryBM25(null, 'dragon').length, 0, 'null index');
    assertEqual(queryBM25(undefined, 'dragon').length, 0, 'undefined index');
});

test('C16: queryBM25: results include entry reference', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A fire dragon.' })];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon fire', 10, 0.1);
    assertGreaterThan(results.length, 0, 'has results');
    assertNotNull(results[0].entry, 'entry reference present');
    assertEqual(results[0].entry.title, 'Dragon', 'entry title matches');
});

test('C17: buildBM25Index: inverted index built for fast lookup', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'dragon fire.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'elf forest.' }),
    ];
    const index = buildBM25Index(entries);
    assertNotNull(index.invertedIndex, 'invertedIndex present');
    assert(index.invertedIndex instanceof Map, 'invertedIndex is a Map');
    assert(index.invertedIndex.has('dragon'), 'dragon in inverted index');
    assert(index.invertedIndex.has('forest'), 'forest in inverted index');
});

// ============================================================================
//  D. Entity Name Tracking (10 tests)
// ============================================================================

section('D. Entity Name Tracking');

test('D1: setEntityNameSet stores names readable via entityNameSet', () => {
    const names = new Set(['dragon', 'elf']);
    setEntityNameSet(names);
    assert(entityNameSet.has('dragon'), 'dragon in set');
    assert(entityNameSet.has('elf'), 'elf in set');
});

test('D2: computeEntityDerivedState: entity names from titles (lowercase)', () => {
    const entries = [makeEntry('Dragon', { keys: [] }), makeEntry('Elf Warrior', { keys: [] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('dragon'), 'title lowercased');
    assert(entityNameSet.has('elf warrior'), 'multi-word title lowercased');
});

test('D3: computeEntityDerivedState: entity names from keys (lowercase, min length 2)', () => {
    const entries = [makeEntry('Test', { keys: ['Fire', 'ICE', 'ab'] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('fire'), 'key lowercased');
    assert(entityNameSet.has('ice'), 'key lowercased');
    assert(entityNameSet.has('ab'), 'two-char key included');
});

test('D4: short title (1 char) included', () => {
    const entries = [makeEntry('X', { keys: [] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('x'), 'single-char title included (>= 1)');
});

test('D5: short key (1 char) excluded (min length 2)', () => {
    const entries = [makeEntry('Test', { keys: ['x', 'ab'] })];
    computeEntityDerivedState(entries);
    assert(!entityNameSet.has('x'), 'single-char key excluded');
    assert(entityNameSet.has('ab'), 'two-char key included');
});

test('D6: entity short name regexes use word boundary matching', () => {
    const entries = [makeEntry('Arch', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('arch');
    assertNotNull(regex, 'regex exists for arch');
    assert(regex.test('The Arch stands tall'), 'matches whole word');
    assert(!regex.test('monarchy'), 'does not match inside word');
    assert(!regex.test('architecture'), 'does not match prefix');
});

test('D7: entity regex "an" does not match "want" (word boundary)', () => {
    const entries = [makeEntry('Test', { keys: ['an'] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('an');
    assertNotNull(regex, 'regex exists for "an"');
    assert(!regex.test('I want food'), '"an" does not match inside "want"');
    assert(regex.test('Give an apple'), '"an" matches standalone');
});

test('D8: entity regex case-insensitive — "Eris" matches "eris"', () => {
    const entries = [makeEntry('Eris', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('eris');
    assertNotNull(regex, 'regex exists');
    assert(regex.test('ERIS is here'), 'case-insensitive match');
    assert(regex.test('eris is here'), 'lowercase match');
    assert(regex.test('Eris is here'), 'title case match');
});

test('D9: entity regex special chars in name are escaped', () => {
    const entries = [makeEntry('C++', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('c++');
    assertNotNull(regex, 'regex exists for C++');
    // Should not throw (+ is escaped to \\+)
    let threw = false;
    try { regex.test('I use C++ daily'); } catch { threw = true; }
    assert(!threw, 'regex with special chars does not throw');
});

test('D10: multiple entries accumulate all names', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire', 'scales'] }),
        makeEntry('Elf', { keys: ['forest', 'magic'] }),
        makeEntry('Orc', { keys: ['war'] }),
    ];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('dragon'), 'dragon title');
    assert(entityNameSet.has('elf'), 'elf title');
    assert(entityNameSet.has('orc'), 'orc title');
    assert(entityNameSet.has('fire'), 'dragon key');
    assert(entityNameSet.has('forest'), 'elf key');
    assert(entityNameSet.has('war'), 'orc key');
    assert(entityNameSet.has('scales'), 'dragon key 2');
    assert(entityNameSet.has('magic'), 'elf key 2');
    // Check total count: 3 titles + 5 keys (all >= 2 chars) = 8
    assertEqual(entityNameSet.size, 8, '8 total entity names');
});

// ============================================================================
//  E. Vault Path & URI (12 tests)
// ============================================================================

section('E. Vault Path & URI');

test('E1: encodeVaultPath: basic path passes through', () => {
    assertEqual(encodeVaultPath('Characters/Alice.md'), 'Characters/Alice.md', 'no encoding needed');
});

test('E2: encodeVaultPath: spaces encoded per segment', () => {
    const result = encodeVaultPath('LA World/My Characters/Alice Smith.md');
    assert(result.includes('LA%20World'), 'space encoded in first segment');
    assert(result.includes('Alice%20Smith.md'), 'space encoded in filename');
    assert(result.includes('/'), 'slashes preserved');
});

test('E3: encodeVaultPath: special characters encoded', () => {
    const result = encodeVaultPath('Notes/Dragon & Elf.md');
    assert(result.includes('%26'), 'ampersand encoded');
    assert(!result.includes(' & '), 'original ampersand not present');
});

test('E4: validateVaultPath: valid path passes', () => {
    const result = validateVaultPath('Characters/Alice.md');
    assertEqual(result, 'Characters/Alice.md', 'valid path returned');
});

test('E5: validateVaultPath: backslashes normalized to forward', () => {
    const result = validateVaultPath('Characters\\Alice.md');
    assertEqual(result, 'Characters/Alice.md', 'backslashes normalized');
});

test('E6: validateVaultPath: empty relative path passes', () => {
    const result = validateVaultPath('file.md');
    assertEqual(result, 'file.md', 'simple filename passes');
});

test('E7: validateVaultPath: path traversal (..) throws', () => {
    let threw = false;
    try { validateVaultPath('../etc/passwd'); } catch { threw = true; }
    assert(threw, 'path traversal rejected');
});

test('E8: validateVaultPath: dot segment (.) throws', () => {
    let threw = false;
    try { validateVaultPath('./file.md'); } catch { threw = true; }
    assert(threw, 'dot segment rejected');
});

test('E9: validateVaultPath: absolute path throws', () => {
    let threw = false;
    try { validateVaultPath('/etc/passwd'); } catch { threw = true; }
    assert(threw, 'absolute path rejected');
});

test('E10: buildObsidianURI: constructs correct URI', () => {
    const uri = buildObsidianURI('MyVault', 'Characters/Alice.md');
    assertEqual(uri, 'obsidian://open?vault=MyVault&file=Characters/Alice', 'correct URI');
});

test('E11: buildObsidianURI: with vault name containing spaces', () => {
    const uri = buildObsidianURI('My Vault', 'Alice.md');
    assert(uri.includes('vault=My%20Vault'), 'vault name encoded');
    assert(uri.includes('file=Alice'), 'file path present');
});

test('E12: buildObsidianURI: no vault name returns null', () => {
    assertNull(buildObsidianURI('', 'Alice.md'), 'empty vault name returns null');
    assertNull(buildObsidianURI(null, 'Alice.md'), 'null vault name returns null');
    assertNull(buildObsidianURI(undefined, 'Alice.md'), 'undefined vault name returns null');
});

// ============================================================================
//  F. Index Snapshot & Change Detection (12 tests)
// ============================================================================

section('F. Index Snapshot & Change Detection');

test('F1: takeIndexSnapshot: creates snapshot with contentHash, title, keys', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' }),
    ];
    const snap = takeIndexSnapshot(entries);
    assertNotNull(snap.contentHashes, 'contentHashes map present');
    assertNotNull(snap.titleMap, 'titleMap present');
    assertNotNull(snap.keyMap, 'keyMap present');
    assertNotNull(snap.timestamp, 'timestamp present');
    // BUG-AUDIT (Fix 25): keys are `vaultSource:filename`. Default vaultSource is ''.
    assert(snap.contentHashes.has(':Dragon.md'), 'entry tracked by vaultSource:filename');
    assertEqual(snap.titleMap.get(':Dragon.md'), 'Dragon', 'title mapped');
});

test('F2: takeIndexSnapshot: empty array creates empty snapshot', () => {
    const snap = takeIndexSnapshot([]);
    assertEqual(snap.contentHashes.size, 0, 'no content hashes');
    assertEqual(snap.titleMap.size, 0, 'no titles');
    assertEqual(snap.keyMap.size, 0, 'no keys');
});

test('F3: detectChanges: no changes between identical snapshots', () => {
    const entries = [makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries);
    const snap2 = takeIndexSnapshot(entries);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.added.length, 0, 'no added');
    assertEqual(changes.removed.length, 0, 'no removed');
    assertEqual(changes.modified.length, 0, 'no modified');
    assertEqual(changes.keysChanged.length, 0, 'no key changes');
    assert(!changes.hasChanges, 'hasChanges is false');
});

test('F4: detectChanges: new entry detected as added', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const entries2 = [
        makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' }),
        makeEntry('Elf', { content: 'Forest.', filename: 'Elf.md' }),
    ];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.added.length, 1, 'one added');
    assertEqual(changes.added[0], 'Elf', 'Elf added');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F5: detectChanges: removed entry detected', () => {
    const entries1 = [
        makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' }),
        makeEntry('Elf', { content: 'Forest.', filename: 'Elf.md' }),
    ];
    const entries2 = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.removed.length, 1, 'one removed');
    assertEqual(changes.removed[0], 'Elf', 'Elf removed');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F6: detectChanges: modified content detected via different hash', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const entries2 = [makeEntry('Dragon', { content: 'Ice and Fire.', filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.modified.length, 1, 'one modified');
    assertEqual(changes.modified[0], 'Dragon', 'Dragon modified');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F7: detectChanges: key changes detected', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' })];
    const entries2 = [makeEntry('Dragon', { content: 'Fire.', keys: ['fire', 'dragon'], filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    // Content is same, but keys changed
    assertEqual(changes.modified.length, 0, 'content not modified');
    assertEqual(changes.keysChanged.length, 1, 'one key change');
    assertEqual(changes.keysChanged[0], 'Dragon', 'Dragon keys changed');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F8: detectChanges: null old snapshot returns empty changes (no crash)', () => {
    const entries = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const snap = takeIndexSnapshot(entries);
    const changes = detectChanges(null, snap);
    // With null old snapshot, the function returns early with empty changes
    assertEqual(changes.added.length, 0, 'no added (null old)');
    assertEqual(changes.removed.length, 0, 'no removed (null old)');
    assert(!changes.hasChanges, 'hasChanges is false (null old)');
});

test('F9: detectChanges: multiple simultaneous changes', () => {
    const entries1 = [
        makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' }),
        makeEntry('Elf', { content: 'Forest.', keys: ['forest'], filename: 'Elf.md' }),
        makeEntry('Orc', { content: 'War.', keys: ['war'], filename: 'Orc.md' }),
    ];
    const entries2 = [
        makeEntry('Dragon', { content: 'Ice!', keys: ['fire'], filename: 'Dragon.md' }),
        // Elf removed
        makeEntry('Orc', { content: 'War.', keys: ['war'], filename: 'Orc.md' }),
        makeEntry('Dwarf', { content: 'Mine.', keys: ['mine'], filename: 'Dwarf.md' }),
    ];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.added.length, 1, 'Dwarf added');
    assertEqual(changes.removed.length, 1, 'Elf removed');
    assertEqual(changes.modified.length, 1, 'Dragon modified');
    assert(changes.hasChanges, 'hasChanges true');
});

test('F10: takeIndexSnapshot: entries tracked by vaultSource:filename', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire.', filename: 'Lore/Dragon.md' }),
        makeEntry('Dragon Alt', { content: 'Ice.', filename: 'Lore/DragonAlt.md' }),
    ];
    const snap = takeIndexSnapshot(entries);
    assertEqual(snap.contentHashes.size, 2, 'two separate entries');
    // BUG-AUDIT (Fix 25): keys are `vaultSource:filename`.
    assert(snap.contentHashes.has(':Lore/Dragon.md'), 'tracked by vaultSource:filename');
    assert(snap.contentHashes.has(':Lore/DragonAlt.md'), 'second tracked by vaultSource:filename');
});

test('F11: detectChanges: content+keys both changed counts as modified (not double-counted)', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Old.', keys: ['fire'], filename: 'Dragon.md' })];
    const entries2 = [makeEntry('Dragon', { content: 'New.', keys: ['fire', 'ice'], filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.modified.length, 1, 'in modified');
    assertEqual(changes.keysChanged.length, 0, 'not in keysChanged (already in modified)');
});

test('F12: takeIndexSnapshot: keys serialized as JSON for comparison', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire', 'ice'], filename: 'Dragon.md' })];
    const snap = takeIndexSnapshot(entries);
    // BUG-AUDIT (Fix 25): keys are `vaultSource:filename`.
    assertEqual(snap.keyMap.get(':Dragon.md'), JSON.stringify(['fire', 'ice']), 'keys JSON-serialized');
});

// ============================================================================
//  G. Clustering (7 tests)
// ============================================================================

section('G. Clustering');

test('G1: clusterEntries: groups by first non-infrastructure tag', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook', 'creature'] }),
        makeEntry('Elf', { tags: ['lorebook', 'creature'] }),
        makeEntry('Castle', { tags: ['lorebook', 'location'] }),
    ];
    const clusters = clusterEntries(entries);
    assert(clusters.has('creature'), 'creature cluster exists');
    assert(clusters.has('location'), 'location cluster exists');
    assertEqual(clusters.get('creature').length, 2, 'two entries in creature');
    assertEqual(clusters.get('location').length, 1, 'one entry in location');
});

test('G2: clusterEntries: empty entries returns empty clusters', () => {
    const clusters = clusterEntries([]);
    assertEqual(clusters.size, 0, 'no clusters');
});

test('G3: clusterEntries: single entry creates single cluster', () => {
    const entries = [makeEntry('Dragon', { tags: ['lorebook', 'monster'] })];
    const clusters = clusterEntries(entries);
    assertEqual(clusters.size, 1, 'one cluster');
    assert(clusters.has('monster'), 'cluster named monster');
});

test('G4: clusterEntries: entries with no non-infra tags go to Uncategorized', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook'], filename: 'Dragon.md' }),
    ];
    const clusters = clusterEntries(entries);
    // No non-infra tag, no folder in filename => 'Uncategorized'
    assert(clusters.has('Uncategorized'), 'Uncategorized cluster');
});

test('G5: clusterEntries: entries with no tags go to Uncategorized', () => {
    const entries = [makeEntry('Dragon', { tags: [] })];
    const clusters = clusterEntries(entries);
    assert(clusters.has('Uncategorized'), 'Uncategorized for empty tags');
});

test('G6: clusterEntries: infra-only tags fall back to folder from filename', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook', 'lorebook-always'], filename: 'Creatures/Dragon.md' }),
    ];
    const clusters = clusterEntries(entries);
    assert(clusters.has('Creatures'), 'folder fallback used');
    assert(!clusters.has('Uncategorized'), 'not in Uncategorized');
});

test('G7: clusterEntries: multiple different tags create separate clusters', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook', 'creature'] }),
        makeEntry('Fireball', { tags: ['lorebook', 'spell'] }),
        makeEntry('Castle', { tags: ['lorebook', 'location'] }),
        makeEntry('Elf', { tags: ['lorebook', 'creature'] }),
    ];
    const clusters = clusterEntries(entries);
    assertEqual(clusters.size, 3, 'three clusters: creature, spell, location');
    assertEqual(clusters.get('creature').length, 2, 'two creatures');
    assertEqual(clusters.get('spell').length, 1, 'one spell');
    assertEqual(clusters.get('location').length, 1, 'one location');
});

// ============================================================================
//  H. trackerKey (3 tests — complements state.js tests in unit.mjs)
// ============================================================================

section('H. trackerKey');

test('H1: trackerKey combines vaultSource and title', () => {
    assertEqual(trackerKey({ title: 'Dragon', vaultSource: 'main' }), 'main:Dragon', 'correct key');
});

test('H2: trackerKey with no vaultSource', () => {
    assertEqual(trackerKey({ title: 'Dragon', vaultSource: '' }), ':Dragon', 'empty vault');
    assertEqual(trackerKey({ title: 'Dragon' }), ':Dragon', 'undefined vault falls back to empty string');
});

test('H3: trackerKey uniqueness across vaults', () => {
    const key1 = trackerKey({ title: 'Dragon', vaultSource: 'v1' });
    const key2 = trackerKey({ title: 'Dragon', vaultSource: 'v2' });
    assertNotEqual(key1, key2, 'different vaults produce different keys');
});

// ============================================================================
//  I. pruneCircuitBreakers (4 tests)
// ============================================================================

section('I. pruneCircuitBreakers');

test('I1: pruneCircuitBreakers is callable without error', () => {
    // pruneCircuitBreakers operates on module-level Map; we can at least call it safely
    let threw = false;
    try {
        pruneCircuitBreakers(new Set(['127.0.0.1:27123']));
    } catch {
        threw = true;
    }
    assert(!threw, 'pruneCircuitBreakers does not throw');
});

test('I2: pruneCircuitBreakers with empty active set clears all', () => {
    // We can't directly inspect the internal Map, but calling with empty set should not crash
    let threw = false;
    try {
        pruneCircuitBreakers(new Set());
    } catch {
        threw = true;
    }
    assert(!threw, 'empty active set does not crash');
});

test('I3: pruneCircuitBreakers accepts Set of host:port strings', () => {
    let threw = false;
    try {
        pruneCircuitBreakers(new Set(['127.0.0.1:27123', '192.168.1.5:27124']));
    } catch {
        threw = true;
    }
    assert(!threw, 'multiple active keys accepted');
});

test('I4: encodeVaultPath: slash-separated segments encoded independently', () => {
    const result = encodeVaultPath('A B/C D/E F.md');
    // Each segment encoded separately, slashes preserved
    assertEqual(result, 'A%20B/C%20D/E%20F.md', 'segments encoded independently');
});

// ============================================================================
//  J. V-C1 — classifyReuseFetch (reuse-sync partial-fetch handling)
// ============================================================================
//
// Regression guards for the V-C1 fix (ship-blocker for v2.5). Before the fix,
// buildIndexWithReuse honored neither `data.partial` nor isPartialFetchFailure:
// files missing from a truncated listing were treated as deletions, then the
// dedupedEntries (minus those files) were written to IDB without skipCacheSave.
// On next hydrate the analytics-prune at finalizeIndex stripped trackers for
// the "deleted" entries — cooldowns, pins, and blocks silently lost.
//
// These tests pin the contract that classifyReuseFetch sets BOTH carryForward
// (in-memory restoration) AND skipCacheSave (IDB protection) so the bug can't
// regress.

section('J. V-C1 — classifyReuseFetch');

test('J1: ok path — full fetch with no failures returns {action:ok, no carry, no skip}', () => {
    const data = { files: [{ filename: 'a.md', content: 'x' }], failed: 0, total: 1 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'ok', 'action is ok');
    assertEqual(result.carryForward, false, 'no carry-forward needed');
    assertEqual(result.skipCacheSave, false, 'safe to persist to IDB');
});

test('J2: invalid path — non-array files returns {action:invalid, carry, skip}', () => {
    const data = { files: null, failed: 0, total: 0 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'invalid', 'action is invalid');
    assertEqual(result.carryForward, true, 'carry-forward prior snapshot entries');
    assertEqual(result.skipCacheSave, true, 'MUST skip cache to avoid wiping IDB');
});

test('J3: invalid path — undefined data returns {action:invalid, carry, skip}', () => {
    const result = classifyReuseFetch(undefined);
    assertEqual(result.action, 'invalid', 'action is invalid');
    assertEqual(result.carryForward, true, 'carry-forward');
    assertEqual(result.skipCacheSave, true, 'skip cache');
});

test('J4: V-C1 BUG — partial listing returns {action:partial, carry, skip}', () => {
    // The exact bug: REST returns data.partial:true on transient directory-listing
    // glitch. Without this classifier, the missing files looked like deletions.
    const data = { files: [{ filename: 'a.md', content: 'x' }], partial: true, failed: 0, total: 1 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'partial', 'action is partial');
    assertEqual(result.carryForward, true, 'MUST carry-forward prior entries — missing files are not deletions');
    assertEqual(result.skipCacheSave, true, 'MUST skip cache — truncated view would persist as deletions');
});

test('J5: V-C1 BUG — many-file failure returns {action:partial_failure, no carry, skip}', () => {
    // Threshold default: 5 absolute OR 10% rate. 5/30 hits absolute threshold.
    const data = { files: [], failed: 5, total: 30 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'partial_failure', 'action is partial_failure');
    // Notably: process the partial data (no carry) but DON'T persist.
    assertEqual(result.carryForward, false, 'process whatever fetched OK');
    assertEqual(result.skipCacheSave, true, 'MUST skip cache to avoid IDB truncation');
});

test('J6: V-C1 BUG — high failure rate (10%+) triggers partial_failure even below absolute', () => {
    // 1/10 = 10% — meets rate threshold despite being below absolute (5).
    const data = { files: [], failed: 1, total: 10 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'partial_failure', 'rate threshold triggers');
    assertEqual(result.skipCacheSave, true, 'MUST skip cache');
});

test('J7: low failure count below thresholds returns ok (single transient miss is fine)', () => {
    // 1/100 = 1% — well below both thresholds.
    const data = { files: [{ filename: 'a.md', content: 'x' }], failed: 1, total: 100 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'ok', 'below thresholds');
    assertEqual(result.skipCacheSave, false, 'safe to cache');
});

test('J8: data.partial wins over a small failure count', () => {
    // Partial listing is a stronger signal than per-file failure rate.
    const data = { files: [{ filename: 'a.md' }], partial: true, failed: 0, total: 1 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'partial', 'partial takes precedence');
    assertEqual(result.carryForward, true, 'full carry-forward when listing truncated');
});

test('J9: zero files with no failures returns ok (empty vault is a valid state)', () => {
    // A genuinely empty vault should NOT trigger carry-forward — the caller has
    // its own preserve guard for "0 files but prior had entries" (see vault.js
    // BUG-367). classifyReuseFetch only handles the truncation cases.
    const data = { files: [], failed: 0, total: 0 };
    const result = classifyReuseFetch(data);
    assertEqual(result.action, 'ok', 'empty vault is ok');
    assertEqual(result.skipCacheSave, false, 'cache the empty state');
});

test('J10: V-C1 contract — every non-ok action sets skipCacheSave=true', () => {
    // Pin the invariant: ANY action other than 'ok' MUST set skipCacheSave so
    // IDB never receives a truncated index. If a future contributor adds a new
    // action without setting skipCacheSave, this test fails loudly.
    const cases = [
        classifyReuseFetch(null),
        classifyReuseFetch({}),
        classifyReuseFetch({ files: [], partial: true }),
        classifyReuseFetch({ files: [], failed: 99, total: 100 }),
    ];
    for (const r of cases) {
        if (r.action !== 'ok') {
            assertEqual(r.skipCacheSave, true, `skipCacheSave must be true for action=${r.action}`);
        }
    }
});

test('J11: PARTIAL_FETCH_FAILURE_THRESHOLD exported and matches vault.js constant', () => {
    // The same constant must drive both the warning toast AND the cache-skip
    // flag in vault.js. Drift would re-introduce the bug.
    assertEqual(PARTIAL_FETCH_FAILURE_THRESHOLD.absolute, 5, 'absolute threshold = 5 failures');
    assertEqual(PARTIAL_FETCH_FAILURE_THRESHOLD.rate, 0.1, 'rate threshold = 10%');
});

test('J12: custom threshold override respected (test-time injection)', () => {
    // 2/10 with default thresholds → 20% rate → partial_failure.
    // Override to absolute=10 rate=0.5 → both miss → ok.
    const data = { files: [{ filename: 'a.md' }], failed: 2, total: 10 };
    const tight = classifyReuseFetch(data);
    assertEqual(tight.action, 'partial_failure', 'default thresholds catch 20%');
    const loose = classifyReuseFetch(data, { absolute: 10, rate: 0.5 });
    assertEqual(loose.action, 'ok', 'loosened thresholds pass');
});

// ============================================================================
//  K. V-C2 — classifyDedupProbe (import dedup existence check)
// ============================================================================
//
// Regression guards for the V-C2 fix (ship-blocker for v2.5). Before the fix,
// _findUniquePath's catch block returned the candidate path on any non-Abort
// exception ("assume free"). If the file ACTUALLY existed but the existence
// check threw mid-flight (network glitch, timeout, DNS hiccup), the caller
// would then writeNote over the real file — silent vault content overwrite,
// the exact opposite of what a dedup helper should do.
//
// classifyDedupProbe is now the single source of truth: any error (Abort or
// otherwise) returns {accept:false, taken:false} → caller fails loud.

section('K. V-C2 — classifyDedupProbe');

test('K1: file does not exist (status != 200) → accept candidate', () => {
    const verdict = classifyDedupProbe({ status: 404 }, null);
    assertEqual(verdict.accept, true, 'accept the candidate');
    assertEqual(verdict.taken, false, 'not taken');
});

test('K2: file exists (status 200) → reject, try next suffix', () => {
    const verdict = classifyDedupProbe({ status: 200 }, null);
    assertEqual(verdict.accept, false, 'do not accept');
    assertEqual(verdict.taken, true, 'taken — bump suffix');
});

test('K3: AbortError → inconclusive (no accept, no taken)', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const verdict = classifyDedupProbe(null, err);
    assertEqual(verdict.accept, false, 'do not accept on abort');
    assertEqual(verdict.taken, false, 'do not advance suffix on abort');
});

test('K4: V-C2 BUG — generic network error → inconclusive (NOT accept)', () => {
    // The exact bug: a non-Abort exception used to return the candidate path
    // "assume free", causing silent overwrites. classifyDedupProbe MUST refuse.
    const err = new TypeError('Failed to fetch');
    const verdict = classifyDedupProbe(null, err);
    assertEqual(verdict.accept, false, 'V-C2: MUST NOT accept on network error');
    assertEqual(verdict.taken, false, 'V-C2: MUST NOT advance suffix');
});

test('K5: V-C2 BUG — DNS error → inconclusive', () => {
    const err = new Error('ENOTFOUND');
    err.code = 'ENOTFOUND';
    const verdict = classifyDedupProbe(null, err);
    assertEqual(verdict.accept, false, 'inconclusive');
    assertEqual(verdict.taken, false, 'no advance');
});

test('K6: V-C2 BUG — timeout error → inconclusive', () => {
    const err = new Error('Request timed out');
    err.name = 'AbortError';
    err.timedOut = true;
    const verdict = classifyDedupProbe(null, err);
    assertEqual(verdict.accept, false, 'inconclusive on timeout');
    assertEqual(verdict.taken, false, 'no advance on timeout');
});

test('K7: V-C2 contract — any error returns inconclusive, regardless of fetchResult', () => {
    // Even if fetchResult is somehow populated alongside an error (defensive),
    // err presence MUST dominate. Otherwise stale partial data could mask the
    // inconclusive state.
    const err = new Error('mixed');
    const verdict = classifyDedupProbe({ status: 200 }, err);
    assertEqual(verdict.accept, false, 'err dominates fetchResult');
    assertEqual(verdict.taken, false, 'no false-take on partial state');
});

test('K8: non-200 success codes treated as "free" (consistent with obsidianFetch semantics)', () => {
    // obsidianFetch returns {status, data} for all HTTP responses including 404.
    // Only an actual 200 means the file exists.
    const cases = [
        classifyDedupProbe({ status: 404 }, null),
        classifyDedupProbe({ status: 204 }, null),
        classifyDedupProbe({ status: 301 }, null),
    ];
    for (const verdict of cases) {
        assertEqual(verdict.accept, true, 'non-200 is free');
        assertEqual(verdict.taken, false, 'not taken');
    }
});

test('K9: null fetchResult with no error → accept (legacy edge case)', () => {
    // Defensive: if probe somehow resolves to null without an error, treat as
    // "no file there." This branch shouldn't fire in practice but guards against
    // future caller refactors that might pass null on success.
    const verdict = classifyDedupProbe(null, null);
    assertEqual(verdict.accept, true, 'null result without error is acceptable');
    assertEqual(verdict.taken, false, 'not taken');
});

test('K10: V-C2 invariant — inconclusive cases produce {accept:false, taken:false} only', () => {
    // Pin the invariant: there's no valid state where the helper returns
    // {accept:true, taken:true} or {accept:false, taken:false, candidate:string}.
    // The caller's `if (!candidatePath) bail` pattern depends on this.
    const errors = [
        Object.assign(new Error('a'), { name: 'AbortError' }),
        new TypeError('Failed to fetch'),
        new Error('generic'),
        Object.assign(new Error('t'), { name: 'AbortError', timedOut: true }),
    ];
    for (const err of errors) {
        const v = classifyDedupProbe(null, err);
        assert(!v.accept && !v.taken, `err ${err.name}: must be inconclusive`);
    }
});

// ============================================================================
//  L. P3 — Incremental derived-state equivalence (mentionWeights / BM25 / entity regexes)
// ============================================================================
//
// Equivalence guards for the P3 perf fix (Wave C / 2026-05-22). finalizeIndex
// used to rebuild mentionWeights (O(N²)), BM25 (O(N) tokenize + O(M) IDF), and
// entityShortNameRegexes (O(N×K)) on EVERY reuse-sync poll regardless of how
// many entries actually changed. The incremental path skips that work — but
// only safely if the output is byte-equivalent to a full rebuild. Any drift
// = silent ranking corruption (BM25) or wrong mention scoring weights that
// degrade quality invisibly over time.
//
// These tests pin: for the same final entry set, full and incremental paths
// produce the same Maps / Sets / numbers. We also pin the fallback (threshold
// crossed → full rebuild).

section('L. P3 — Incremental derived-state equivalence');

// Helper: build a deterministic vault of N entries with cross-references so
// mentionWeights is non-trivial.
function buildSyntheticVault(N) {
    const entries = [];
    const names = ['Dragon', 'Elf', 'Orc', 'Castle', 'Forest', 'Cave', 'Mage', 'Sword', 'Throne', 'Ship'];
    for (let i = 0; i < N; i++) {
        const title = `${names[i % names.length]}-${i}`;
        // Each entry mentions the next 2 entries by their base name.
        const next1 = names[(i + 1) % names.length];
        const next2 = names[(i + 2) % names.length];
        entries.push(makeEntry(title, {
            filename: `entry-${i}.md`,
            vaultSource: 'main',
            keys: [names[i % names.length], `kw${i}`],
            content: `This is ${title}. It mentions ${next1} and ${next2} and ${next1} again.`,
            _contentHash: `h${i}`,
        }));
    }
    return entries;
}

test('L1: mentionWeights — incremental matches full rebuild after modification', () => {
    const prev = buildSyntheticVault(8);
    // Mutate one entry's content (must also bump _contentHash so diff picks it up).
    const next = prev.map(e => ({ ...e }));
    next[3].content = `Updated content for ${next[3].title} that mentions Dragon and Elf.`;
    next[3]._contentHash = `h3-new`;

    const fullWeights = fullMentionWeights(next);
    const diff = diffEntries(prev, next);
    const incWeights = incrementalMentionWeights(fullMentionWeights(prev), prev, next, diff);

    assertEqual(incWeights.size, fullWeights.size, 'same number of mention pairs');
    for (const [key, val] of fullWeights) {
        assertEqual(incWeights.get(key), val, `pair ${key}`);
    }
});

test('L2: mentionWeights — incremental matches full rebuild after addition', () => {
    const prev = buildSyntheticVault(6);
    const next = prev.map(e => ({ ...e }));
    next.push(makeEntry('NewEntry', {
        filename: 'new.md',
        vaultSource: 'main',
        keys: ['novel', 'introduced'],
        content: 'NewEntry mentions Dragon-0 and Elf-1 here.',
        _contentHash: 'hnew',
    }));

    const fullWeights = fullMentionWeights(next);
    const diff = diffEntries(prev, next);
    const incWeights = incrementalMentionWeights(fullMentionWeights(prev), prev, next, diff);

    assertEqual(incWeights.size, fullWeights.size, 'same pair count after add');
    for (const [key, val] of fullWeights) {
        assertEqual(incWeights.get(key), val, `pair ${key}`);
    }
});

test('L3: mentionWeights — incremental matches full rebuild after removal', () => {
    const prev = buildSyntheticVault(6);
    const next = prev.slice(0, 5); // drop last entry

    const fullWeights = fullMentionWeights(next);
    const diff = diffEntries(prev, next);
    const incWeights = incrementalMentionWeights(fullMentionWeights(prev), prev, next, diff);

    assertEqual(incWeights.size, fullWeights.size, 'same pair count after removal');
    for (const [key, val] of fullWeights) {
        assertEqual(incWeights.get(key), val, `pair ${key}`);
    }
    // No orphan keys pointing to the removed entry's title.
    for (const key of incWeights.keys()) {
        assert(!key.includes(prev[5].title), `no orphan key referencing removed entry: ${key}`);
    }
});

test('L4: BM25 — incremental matches full rebuild after modification', () => {
    const prev = buildSyntheticVault(8);
    const prevIndex = buildBM25Index(prev);

    const next = prev.map(e => ({ ...e }));
    next[2].content = `Modified content for ${next[2].title}, now mentions phoenix and griffin.`;
    next[2]._contentHash = 'h2-new';

    const diff = diffEntries(prev, next);
    const incIndex = incrementalBM25Update(prevIndex, diff);
    const fullIndex = buildBM25Index(next);

    assertNotNull(incIndex, 'incremental returned an index');
    assertEqual(incIndex.docs.size, fullIndex.docs.size, 'same doc count');
    assertEqual(incIndex.idf.size, fullIndex.idf.size, 'same idf term count');
    assertEqual(incIndex.invertedIndex.size, fullIndex.invertedIndex.size, 'same inverted-index size');
    // Compare avgDl with float tolerance (Math.log shouldn't introduce error
    // here, but accept tiny drift).
    assert(Math.abs(incIndex.avgDl - fullIndex.avgDl) < 1e-9, 'avgDl matches');
    // Compare IDF values per term.
    for (const [term, idfVal] of fullIndex.idf) {
        const incIdf = incIndex.idf.get(term);
        assertNotNull(incIdf, `incremental has term ${term}`);
        assert(Math.abs(incIdf - idfVal) < 1e-9, `idf[${term}] matches`);
    }
    // Compare invertedIndex per term.
    for (const [term, posting] of fullIndex.invertedIndex) {
        const incPosting = incIndex.invertedIndex.get(term);
        assertNotNull(incPosting, `incremental has posting for ${term}`);
        assertEqual(incPosting.size, posting.size, `posting count for ${term}`);
        for (const docId of posting) {
            assert(incPosting.has(docId), `posting[${term}] includes ${docId}`);
        }
    }
});

test('L5: BM25 — incremental matches full rebuild after addition', () => {
    const prev = buildSyntheticVault(5);
    const prevIndex = buildBM25Index(prev);

    const next = prev.map(e => ({ ...e }));
    next.push(makeEntry('AddedEntry', {
        filename: 'added.md',
        vaultSource: 'main',
        keys: ['shiny', 'novel'],
        content: 'AddedEntry has unique tokens like quasar and pulsar.',
        _contentHash: 'hadd',
    }));

    const diff = diffEntries(prev, next);
    const incIndex = incrementalBM25Update(prevIndex, diff);
    const fullIndex = buildBM25Index(next);

    assertEqual(incIndex.docs.size, fullIndex.docs.size, 'doc count matches after add');
    // The added doc's tokens should appear in both.
    const addedDoc = incIndex.docs.get(bm25DocId(next[next.length - 1]));
    assertNotNull(addedDoc, 'added doc indexed');
    assert(addedDoc.tf.has('quasar'), 'quasar token tracked');
    // N changed → every IDF value should match full rebuild's IDF.
    for (const [term, idfVal] of fullIndex.idf) {
        const incIdf = incIndex.idf.get(term);
        assert(Math.abs(incIdf - idfVal) < 1e-9, `idf[${term}] matches after N change`);
    }
});

test('L6: BM25 — incremental matches full rebuild after removal', () => {
    const prev = buildSyntheticVault(6);
    const prevIndex = buildBM25Index(prev);

    const next = prev.slice(0, 5); // remove last entry
    const removedId = bm25DocId(prev[5]);

    const diff = diffEntries(prev, next);
    const incIndex = incrementalBM25Update(prevIndex, diff);
    const fullIndex = buildBM25Index(next);

    assertEqual(incIndex.docs.size, fullIndex.docs.size, 'doc count after removal');
    assert(!incIndex.docs.has(removedId), 'removed doc gone from docs');
    // No posting list should reference the removed docId.
    for (const [term, posting] of incIndex.invertedIndex) {
        assert(!posting.has(removedId), `posting[${term}] does not reference removed ${removedId}`);
    }
    // Every full-rebuild IDF should match.
    for (const [term, idfVal] of fullIndex.idf) {
        assert(Math.abs(incIndex.idf.get(term) - idfVal) < 1e-9, `idf[${term}] matches`);
    }
});

test('L7: entity regexes — incremental matches full path AND bumps entityRegexVersion contract', () => {
    // The full path is computeEntityDerivedState (vault-pure.js). Compare name
    // sets + regex string forms (RegExp identity isn't comparable directly).
    const prev = buildSyntheticVault(4);
    const next = prev.map(e => ({ ...e }));
    next[1].keys = ['Elf', 'newkey', 'addedterm'];

    // Build the "full" expected name set manually (same logic as
    // vault-pure.js:computeEntityDerivedState).
    const expectedNames = new Set();
    for (const e of next) {
        if (e.title.length >= 1) expectedNames.add(e.title.toLowerCase());
        for (const k of e.keys) {
            if (k.length >= 2) expectedNames.add(k.toLowerCase());
        }
    }

    // Pre-built regex map from prev (simulates state.entityShortNameRegexes).
    const prevRegexes = new Map();
    for (const e of prev) {
        if (e.title.length >= 1) {
            const name = e.title.toLowerCase();
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            prevRegexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
        }
        for (const k of e.keys) {
            if (k.length >= 2) {
                const name = k.toLowerCase();
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                prevRegexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
            }
        }
    }

    const { names, regexes } = incrementalEntityRegexes(next, prevRegexes);
    assertEqual(names.size, expectedNames.size, 'incremental name set size matches full');
    for (const n of expectedNames) assert(names.has(n), `name ${n} present`);
    for (const n of names) assert(expectedNames.has(n), `no extra name ${n}`);
    // Regex map size should equal the name set size (one regex per name).
    assertEqual(regexes.size, names.size, 'one regex per name');
    // Regexes are word-boundary, case-insensitive.
    for (const [name, rx] of regexes) {
        assertEqual(rx.flags, 'i', `flags for ${name}`);
        assert(rx.source.startsWith('\\b'), `${name} has word boundary prefix`);
    }
    // Pinned: previously-existing regex objects should be REUSED (same identity)
    // for names that survived — this is what makes the path actually cheap.
    const survivingName = prev[0].title.toLowerCase();
    if (names.has(survivingName) && prevRegexes.has(survivingName)) {
        assert(regexes.get(survivingName) === prevRegexes.get(survivingName),
            'surviving regex object reused (identity preserved)');
    }
});

test('L8: shouldUseIncremental — fallback when changes exceed threshold', () => {
    // Default threshold 0.5: anything over 50% of total → full rebuild
    assert(shouldUseIncremental(1, 100), '1% changed — incremental');
    assert(shouldUseIncremental(50, 100), '50% changed — still incremental (at threshold)');
    assert(!shouldUseIncremental(51, 100), '51% changed — full rebuild');
    assert(!shouldUseIncremental(100, 100), 'all changed — full rebuild');
    // Edge cases
    assert(!shouldUseIncremental(0, 0), 'empty vault — full path');
    assert(shouldUseIncremental(0, 10), 'zero changes — incremental (no-op)');
    // Custom threshold
    assert(shouldUseIncremental(1, 10, 0.1), '10% with 0.1 threshold — incremental');
    assert(!shouldUseIncremental(2, 10, 0.1), '20% with 0.1 threshold — full rebuild');
});

test('L9: diffEntries — detects rename (title change) as modification', () => {
    const prev = buildSyntheticVault(3);
    const next = prev.map(e => ({ ...e }));
    next[1].title = 'RenamedTitle';
    next[1]._contentHash = 'h1-renamed';

    const diff = diffEntries(prev, next);
    assertEqual(diff.added.length, 0, 'no added');
    assertEqual(diff.removed.length, 0, 'no removed');
    assertEqual(diff.modified.length, 1, 'one modified');
    assertEqual(diff.modifiedPrev.length, 1, 'modifiedPrev paired');
    assertEqual(diff.modified[0].title, 'RenamedTitle', 'new title');
    assertEqual(diff.modifiedPrev[0].title, prev[1].title, 'prev title preserved for old-row cleanup');
});

test('L10: incremental BM25 — returns null when prior index lacks invertedIndex (defensive)', () => {
    // Pre-H-12 indexes had no inverted index. The incremental path needs it
    // for posting-list maintenance — must signal full-rebuild fallback.
    const prev = buildSyntheticVault(3);
    const fakeLegacyIndex = { idf: new Map(), docs: new Map(), avgDl: 0 }; // no invertedIndex
    const next = prev.map(e => ({ ...e }));
    const diff = diffEntries(prev, next);
    const result = incrementalBM25Update(fakeLegacyIndex, diff);
    assertEqual(result, null, 'returns null to signal full-rebuild fallback');
});

test('L11: incremental mentionWeights — handles entry rename without leaving orphan row/col', () => {
    // Prior bug class: rename means OLD title still has row/col in weights.
    // diffEntries detects rename as modification + modifiedPrev keeps old title
    // so incrementalMentionWeights can purge the old-title row AND col.
    const prev = buildSyntheticVault(5);
    const next = prev.map(e => ({ ...e }));
    const oldTitle = next[2].title;
    next[2].title = 'CompletelyRenamed';
    next[2]._contentHash = 'h2-renamed';

    const fullWeights = fullMentionWeights(next);
    const diff = diffEntries(prev, next);
    const incWeights = incrementalMentionWeights(fullMentionWeights(prev), prev, next, diff);

    assertEqual(incWeights.size, fullWeights.size, 'same pair count after rename');
    // No orphan weights referencing the old title (neither as source nor target).
    for (const key of incWeights.keys()) {
        assert(!key.startsWith(`${oldTitle}\0`), `no orphan ${oldTitle} as source`);
        assert(!key.endsWith(`\0${oldTitle}`), `no orphan ${oldTitle} as target`);
    }
    // And the full rebuild produces the same byte-identical Map.
    for (const [key, val] of fullWeights) {
        assertEqual(incWeights.get(key), val, `pair ${key}`);
    }
});

test('L12: computeEntryBM25TF — matches buildBM25Index per-doc TF', () => {
    const entry = makeEntry('TestEntry', {
        keys: ['fire', 'magic'],
        content: 'A short test entry about fire and magic.',
        filename: 'test.md',
        vaultSource: 'v1',
    });
    const fullIndex = buildBM25Index([entry]);
    const { tf, len } = computeEntryBM25TF(entry);
    const fullDoc = fullIndex.docs.get(bm25DocId(entry));
    assertEqual(len, fullDoc.len, 'token length matches');
    assertEqual(tf.size, fullDoc.tf.size, 'TF map size matches');
    for (const [term, count] of fullDoc.tf) {
        assertEqual(tf.get(term), count, `tf[${term}]`);
    }
});

test('L13: incrementalEntityRegexes — name removed when only entry using it is dropped', () => {
    const prev = [
        makeEntry('Solo', { keys: ['uniquekey'], filename: 's.md', vaultSource: 'v1' }),
        makeEntry('Other', { keys: ['sharedkey'], filename: 'o.md', vaultSource: 'v1' }),
    ];
    const next = [prev[1]]; // drop Solo, keep Other

    const prevRegexes = new Map();
    prevRegexes.set('solo', /\bsolo\b/i);
    prevRegexes.set('uniquekey', /\buniquekey\b/i);
    prevRegexes.set('other', /\bother\b/i);
    prevRegexes.set('sharedkey', /\bsharedkey\b/i);

    const { names, regexes } = incrementalEntityRegexes(next, prevRegexes);
    assert(!names.has('solo'), 'solo name removed');
    assert(!names.has('uniquekey'), 'uniquekey name removed (only Solo had it)');
    assert(names.has('other'), 'other name preserved');
    assert(names.has('sharedkey'), 'sharedkey name preserved');
    assertEqual(regexes.size, 2, 'only 2 regexes left');
});

// Bug #7 — mentionWeights bare-title re-key. Two entries share a TITLE but live
// in DIFFERENT vaults, each mentioning the other (and the SHARED title word). The
// IDENTITY/storage keys MUST be keyOf (vaultSource:title), so the cross-mentions
// produce DISTINCT weight keys instead of colliding onto one bare-title key.
// FAILS on the pre-fix bare-`.title` code (collides to a single key / self-skip
// drops the pair); PASSES after keying identity by keyOf. Pinned for BOTH paths.
test('L14: mentionWeights — same title, different vault does NOT collide (full)', () => {
    // "Castle" in vault A mentions "Castle" (the B one) and vice-versa. Because the
    // search-TERM is the shared word "Castle", each entry's content matches the
    // other's regex. Under bare-title keying, source===target self-skip would
    // wrongly drop the pair AND both would map to one key. keyOf keeps them apart.
    const entries = [
        makeEntry('Castle', {
            filename: 'castle.md', vaultSource: 'lore-a', keys: ['fortress'],
            content: 'The Castle here is grand. The other Castle is rival.',
            _contentHash: 'a1',
        }),
        makeEntry('Castle', {
            filename: 'castle.md', vaultSource: 'lore-b', keys: ['keep'],
            content: 'This Castle stands tall. The first Castle opposes it.',
            _contentHash: 'b1',
        }),
    ];
    const w = fullMentionWeights(entries);
    // Two DISTINCT identity keys: A→B and B→A. Bare-title code yields self-skip
    // (same .title) → 0 pairs, OR a single colliding key. Either way size !== 2.
    assertEqual(w.size, 2, 'two distinct cross-vault mention pairs (not collided)');
    assert(w.has('lore-a:Castle\0lore-b:Castle'), 'A→B keyed by keyOf');
    assert(w.has('lore-b:Castle\0lore-a:Castle'), 'B→A keyed by keyOf');
});

test('L14b: mentionWeights — same title, different vault does NOT collide (incremental)', () => {
    // Build the B entry incrementally on top of the A-only prev index. The
    // incremental dirty-key / self-skip math must also key identity by keyOf, or
    // it collides the two "Castle"s exactly like the full path would.
    const prev = [
        makeEntry('Castle', {
            filename: 'castle.md', vaultSource: 'lore-a', keys: ['fortress'],
            content: 'The Castle here is grand. The other Castle is rival.',
            _contentHash: 'a1',
        }),
    ];
    const next = [
        prev[0],
        makeEntry('Castle', {
            filename: 'castle.md', vaultSource: 'lore-b', keys: ['keep'],
            content: 'This Castle stands tall. The first Castle opposes it.',
            _contentHash: 'b1',
        }),
    ];
    const diff = diffEntries(prev, next);
    const inc = incrementalMentionWeights(fullMentionWeights(prev), prev, next, diff);
    const full = fullMentionWeights(next);

    // Equivalence invariant: incremental === full, byte-for-byte.
    assertEqual(inc.size, full.size, 'incremental pair count matches full');
    for (const [key, val] of full) {
        assertEqual(inc.get(key), val, `pair ${key}`);
    }
    // And the cross-vault keys are distinct (not collided to one bare-title key).
    assertEqual(inc.size, 2, 'two distinct cross-vault mention pairs (incremental)');
    assert(inc.has('lore-a:Castle\0lore-b:Castle'), 'A→B keyed by keyOf (incremental)');
    assert(inc.has('lore-b:Castle\0lore-a:Castle'), 'B→A keyed by keyOf (incremental)');
});

// ============================================================================
//  M. V-H4 — fieldDefsChanged delegates to buildIndex (perf fix)
// ============================================================================
//
// Regression guards for the V-H4 fix (ship-blocker for v2.5). Before the fix,
// when `fieldDefsChanged` was true, buildIndexWithReuse re-parsed every entry
// inside its sequential for-loop with `await getTokenCountAsync` per file —
// blocking the UI for seconds on a 500-entry vault. buildIndex() does the same
// work but parallelizes tokenization via `Promise.all`.
//
// The fix: bail early from buildIndexWithReuse when fieldDefsChanged so the
// caller's standard `usedReuse === false → buildIndex()` fallback (see
// ensureIndexFresh + setupSyncPolling) takes over.
//
// vault.js can't be imported in tests (ST module imports), so we assert via
// source-code regex: the early-return block exists AND the cache hit check
// no longer needs the !fieldDefsChanged guard to be load-bearing.

section('M. V-H4 — fieldDefsChanged delegates to buildIndex');

test('M1: vault.js has V-H4 early-return when fieldDefsChanged is true', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    // The early-return block must:
    //   1. Reference the V-H4 fix label (so future code-readers find context).
    //   2. Live inside buildIndexWithReuse (not buildIndex — which already
    //      tokenizes in parallel).
    //   3. Set _reuseResult to false so the caller falls through to buildIndex.
    //   4. Use a bare `return` so the IIFE's finally block runs (clears
    //      indexing/buildPromise so buildIndex can acquire the lock).
    assert(src.includes('V-H4'), 'V-H4 marker present in vault.js');

    // Match the structural early-return: `if (fieldDefsChanged) { ... _reuseResult = false; ... return;` (multi-line)
    const earlyReturnPattern = /if\s*\(\s*fieldDefsChanged\s*\)\s*\{[\s\S]*?_reuseResult\s*=\s*false\s*;[\s\S]*?return\s*;[\s\S]*?\}/;
    assert(earlyReturnPattern.test(src),
        'V-H4 early-return present: `if (fieldDefsChanged) { ... _reuseResult = false; ... return; }`');
});

test('M2: vault.js V-H4 early-return is INSIDE buildIndexWithReuse, not buildIndex', () => {
    // The bail-out is only valid for the reuse path. buildIndex() is the
    // fallback target and must NOT itself return false on fieldDefsChanged.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    // Find the V-H4 marker location.
    const vh4Idx = src.indexOf('V-H4');
    assert(vh4Idx > 0, 'V-H4 marker found');

    // Find buildIndexWithReuse and buildIndex declaration positions.
    const reuseIdx = src.indexOf('export async function buildIndexWithReuse');
    const buildIdx = src.indexOf('export async function buildIndex');
    assert(reuseIdx > 0, 'buildIndexWithReuse found');
    assert(buildIdx > 0, 'buildIndex found');

    // V-H4 must be after buildIndexWithReuse start.
    assert(vh4Idx > reuseIdx, 'V-H4 fix is inside buildIndexWithReuse');
});

test('M3: vault.js does NOT call getTokenCountAsync serially inside a for-loop after V-H4 fix', () => {
    // This pins the perf intent: when fieldDefsChanged triggers full re-parse,
    // tokenization should NOT be serial. Either Promise.all (buildIndex path)
    // OR the bail-out (V-H4 path) is acceptable — both avoid the serial-await
    // bug. We assert that buildIndex still has the parallel pattern; the V-H4
    // bail-out is asserted by M1+M2.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    // buildIndex must use Promise.all for tokenization.
    assert(/Promise\.all\(entries\.map\(async/.test(src),
        'buildIndex still uses Promise.all for parallel tokenization');
});

test('M4: vault.js V-H4 early-return precedes the per-file serial tokenize loop', () => {
    // Pin the order: the early-return must happen BEFORE the reuse-path
    // for-loop that contains the serial `await getTokenCountAsync` — otherwise
    // the bail is useless (we'd already have done the slow work).
    //
    // Find the SECOND `entry.tokenEstimate = await getTokenCountAsync` occurrence
    // (the first is inside buildIndex's Promise.all). The reuse-path one is
    // distinguished by the adjacent `_reuseTokenizerFailCount++` line.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    const vh4Idx = src.indexOf('V-H4');
    assert(vh4Idx > 0, 'V-H4 marker found');

    // The reuse path's serial tokenize is the one near _reuseTokenizerFailCount.
    const reuseFailCounterIdx = src.indexOf('_reuseTokenizerFailCount++');
    assert(reuseFailCounterIdx > 0, 'reuse-path token fallback counter found');

    // Walk backwards from the fail counter to find the nearest preceding
    // `entry.tokenEstimate = await getTokenCountAsync` — that's the serial site.
    const serialTokenSig = 'entry.tokenEstimate = await getTokenCountAsync';
    const reuseSerialIdx = src.lastIndexOf(serialTokenSig, reuseFailCounterIdx);
    assert(reuseSerialIdx > 0, 'reuse-path serial tokenize site located');

    assert(vh4Idx < reuseSerialIdx,
        'V-H4 early-return is positioned BEFORE the reuse-path serial tokenize loop');
});

test('M5: vault.js fallback chain documented — caller falls through to buildIndex', () => {
    // The bail-out is only safe because the caller has a fallback. Pin the
    // fallback contract in both ensureIndexFresh and the V-H4 comment.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    // ensureIndexFresh: `const usedReuse = await buildIndexWithReuse(); if (usedReuse) ...; await buildIndex();`
    assert(/const usedReuse = await buildIndexWithReuse/.test(src),
        'ensureIndexFresh awaits buildIndexWithReuse and checks usedReuse');
    assert(/if\s*\(\s*usedReuse\s*\)[\s\S]*?return[\s\S]*?await buildIndex\(\)/.test(src),
        'ensureIndexFresh falls through to buildIndex when usedReuse is false');
});

test('M6: vault.js sync.js fallback chain unchanged — buildIndexWithReuseFn → buildIndexFn', () => {
    // sync.js has the same fallback. If V-H4 returns false, sync polling MUST
    // call buildIndexFn next. This pins that contract so the V-H4 fix can't
    // be undermined by a sync.js refactor.
    const syncSrc = readFileSync(join(REPO_ROOT, 'src/vault/sync.js'), 'utf8');
    assert(/const deltaOk = await buildIndexWithReuseFn\(\)/.test(syncSrc),
        'sync.js awaits buildIndexWithReuseFn delta result');
    // The fallback to buildIndexFn must execute when deltaOk is false.
    assert(/if\s*\(\s*deltaOk\s*\)\s*\{\s*scheduleNext\(\)[\s\S]*?return[\s\S]*?\}\s*[\s\S]*?await buildIndexFn\(\)/.test(syncSrc),
        'sync.js falls through to buildIndexFn() when deltaOk is false');
});

// ============================================================================
//  N. V-M3 — clearIndexCache onabort handler
// ============================================================================
//
// Runtime test would require a fake-indexeddb stub + a settings.js shim
// (cache.js → settings.js → ST extensions.js, which is unresolvable in node).
// Until that test infra lands, we pin V-M3 at the source level — three guards
// catch any refactor that drops the handler:
//   N1: structural pattern (function body wires `tx.onabort`)
//   N2: rejection pattern (onabort handler actually rejects, not just bound to noop)
//   N3: cross-function consistency (matches the saveIndexToCache / pruneOrphanedCacheKeys pattern)
// The runtime path is exercised end-to-end whenever a user hits "Clear cache"
// in Settings → About → Danger Zone in a browser with quota pressure or a
// version-change abort — pre-fix that hung the UI indefinitely.

section('N. V-M3 — clearIndexCache onabort handler');

test('N1: clearIndexCache wires tx.onabort to reject', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/cache.js'), 'utf8');
    const clearStart = src.indexOf('export async function clearIndexCache');
    assert(clearStart > 0, 'clearIndexCache function present');
    // Function body ends at the next top-level `}` followed by EOF or another export.
    const restOfFile = src.slice(clearStart);
    const nextExportIdx = restOfFile.indexOf('\nexport ', 1);
    const clearBody = nextExportIdx > 0 ? restOfFile.slice(0, nextExportIdx) : restOfFile;
    assert(clearBody.includes('tx.onabort'), 'clearIndexCache wires tx.onabort');
    assert(/V-M3/.test(clearBody), 'V-M3 marker comment present near the fix');
});

test('N2: clearIndexCache onabort rejects (does not silently swallow)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/cache.js'), 'utf8');
    const clearStart = src.indexOf('export async function clearIndexCache');
    const restOfFile = src.slice(clearStart);
    const nextExportIdx = restOfFile.indexOf('\nexport ', 1);
    const clearBody = nextExportIdx > 0 ? restOfFile.slice(0, nextExportIdx) : restOfFile;
    // The onabort must call reject (otherwise the await would still hang).
    // Same shape as saveIndexToCache / pruneOrphanedCacheKeys post-BUG-380.
    assert(/tx\.onabort\s*=\s*\(\)\s*=>\s*reject\(/.test(clearBody),
        'tx.onabort handler invokes reject(...)');
    assert(/Transaction aborted/.test(clearBody),
        'fallback error message matches sibling DB ops');
});

test('N3: clearIndexCache onabort pattern matches sibling DB ops (consistency)', () => {
    // Same handler shape as saveIndexToCache (post-BUG-380) and
    // pruneOrphanedCacheKeys (post-BUG-380). If those drift, clearIndexCache
    // should drift with them — pin the shared pattern.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/cache.js'), 'utf8');
    const onabortMatches = src.match(/tx\.onabort\s*=\s*\(\)\s*=>\s*reject\(tx\.error\s*\|\|\s*new Error\(['"]Transaction aborted['"]\)\)/g) || [];
    // Three DB ops with transactions: saveIndexToCache, pruneOrphanedCacheKeys, clearIndexCache.
    assertGreaterThan(onabortMatches.length, 2,
        'all 3 transactional DB ops in cache.js share the same onabort pattern (≥3 occurrences)');
});

// ============================================================================
//  O. V-M5 — Vault rename UX (Option B: destructive-confirmation toast)
// ============================================================================

section('O. V-M5 — Vault rename UX');

test('O1: settings-ui captures original vault name on focus (V-M5 baseline)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ui/settings-ui.js'), 'utf8');
    assert(/focus\.dleVault.*\.dle-vault-name/.test(src) || /focus\.dleVault['"]\s*,\s*['"]\.dle-vault-name/.test(src),
        'focus.dleVault handler bound to .dle-vault-name');
    assert(/dleOriginalName/.test(src), 'original name stored via $.data(\'dleOriginalName\', …)');
});

test('O2: settings-ui surfaces rename confirmation on .dle-vault-name change (V-M5)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ui/settings-ui.js'), 'utf8');
    // change handler must exist for the name input (separate from input handler).
    assert(/container\.on\(\s*['"]change\.dleVault['"]\s*,\s*['"]\.dle-vault-name['"]/.test(src),
        'change.dleVault handler bound to .dle-vault-name');
    // The popup must be a CONFIRM (so user can cancel) and reference the destructive copy.
    const renameIdx = src.indexOf('change.dleVault\', \'.dle-vault-name');
    assert(renameIdx > 0, 'rename change handler located');
    const handlerBody = src.slice(renameIdx, renameIdx + 2400);
    assert(/callGenericPopup/.test(handlerBody), 'rename handler calls callGenericPopup');
    assert(/POPUP_TYPE\.CONFIRM/.test(handlerBody), 'popup is CONFIRM type (cancel preserves name)');
    assert(/destructive/i.test(handlerBody), 'copy warns user the action is destructive');
    assert(/cooldown/i.test(handlerBody) && /(pin|block|analytics)/i.test(handlerBody),
        'copy enumerates affected tracker categories');
});

test('O3: cancel branch reverts settings.vaults[idx].name AND input value (V-M5)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ui/settings-ui.js'), 'utf8');
    const renameIdx = src.indexOf('change.dleVault\', \'.dle-vault-name');
    const handlerBody = src.slice(renameIdx, renameIdx + 2400);
    // The cancel branch must revert both settings and the input value back to originalName.
    assert(/settings\.vaults\[idx\]\.name\s*=\s*originalName/.test(handlerBody),
        'cancel branch restores settings.vaults[idx].name = originalName');
    assert(/\$input\.val\(\s*originalName\s*\)/.test(handlerBody),
        'cancel branch restores input value to originalName');
});

test('O4: rename handler is no-op when originalName === newName (no spurious prompts)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ui/settings-ui.js'), 'utf8');
    const renameIdx = src.indexOf('change.dleVault\', \'.dle-vault-name');
    const handlerBody = src.slice(renameIdx, renameIdx + 2400);
    assert(/originalName\s*===\s*newName/.test(handlerBody)
        || /originalName\s*==\s*null/.test(handlerBody),
        'handler short-circuits when there is no actual rename');
});

test('O5: V-M5 documents Option B trade-off — trackers are not re-keyed', () => {
    // Pin the documentation so a future refactor that switches to Option A
    // (or to silent re-key) still has to update the comment + this test.
    const src = readFileSync(join(REPO_ROOT, 'src/ui/settings-ui.js'), 'utf8');
    assert(/V-M5/.test(src), 'V-M5 marker comment present in settings-ui.js');
    // Either explicitly mentions trackerKey or the per-entry state classes.
    assert(/trackerKey|cooldown|pin|block|analytics/i.test(src),
        'V-M5 comment ties the warning to per-entry tracker state');
});

// ============================================================================
//  P. T-L6a — anchor the fullMentionWeights reference copy to PRODUCTION
// ============================================================================
//
// Why this section exists (thermo-nuclear T1):
//   The Section-L equivalence tests above compare `incrementalMentionWeights`
//   against the REFERENCE copy `fullMentionWeights` (in vault-incremental.js).
//   They never compare against the PRODUCTION full path, which is the
//   mentionWeights block inside `computeDerivedIndexFields` (src/vault/vault.js,
//   the `weights === null` branch). If the production block and the reference
//   copy ever drift, every Section-L "incremental == full" test still passes
//   while production silently diverges — pure theater.
//
//   vault.js imports ST globals (tokenizers.js / openai.js / script.js /
//   settings.js) and cannot be import()'d in the node harness, AND
//   `computeDerivedIndexFields` is not exported. So — exactly like the existing
//   Section M / N / O source-guards — we anchor the reference to production with
//   a TWO-PART guard:
//     P1 (behavioral): run the shared builder `fullMentionWeights` (===
//         `buildFullMentionWeights`) on a FIXED small vault and assert it equals a
//         hand-derived expected Map. This pins the shared builder's actual OUTPUT
//         to a known-good ground truth.
//     P2 (structural): read vault.js source and assert the production full-rebuild
//         branch IMPORTS and CALLS that same shared builder (delegation), rather
//         than reimplementing a drift-prone copy of the algorithm inline.
//
//   R6 (2026-05-29) collapsed the old hand-maintained reference copy and the inline
//   production block into ONE shared `buildFullMentionWeights` in
//   vault-incremental.js. So P1 now guards production DIRECTLY (it runs the exact
//   function production calls), and P2 just confirms the delegation wiring stays
//   intact. gotcha #55's "3 copies" mandate is now "2 copies": this shared full
//   builder + the separate `incrementalMentionWeights` delta algorithm.
//
// gotcha #55 (mentionWeights algorithm drift) is exactly the regression class
// these guards catch.

section('P. T-L6a — anchor fullMentionWeights to production');

test('P1: fullMentionWeights matches hand-derived ground truth for a fixed vault', () => {
    // Fixed, hand-checkable vault. Identity keys are `vaultSource:title`
    // (trackerKey / keyOf). Search-terms are title + keys >= 2 chars, lowercased.
    //   Alpha  (keys: [orb])  content mentions "Beta" twice and "Gamma" once.
    //   Beta   (keys: [])     content mentions "Alpha" once.
    //   Gamma  (keys: [ray])  content mentions "Beta" once and "ray" (its own
    //                         key — but a target self-skips, so Gamma→Gamma is 0;
    //                         "ray" only matters as Gamma's search-term for OTHER
    //                         sources).
    const entries = [
        makeEntry('Alpha', {
            vaultSource: 'v1', filename: 'alpha.md', keys: ['orb'],
            content: 'Alpha greets Beta. Beta nods. Then Gamma arrives.',
        }),
        makeEntry('Beta', {
            vaultSource: 'v1', filename: 'beta.md', keys: [],
            content: 'Beta remembers Alpha fondly.',
        }),
        makeEntry('Gamma', {
            vaultSource: 'v1', filename: 'gamma.md', keys: ['ray'],
            content: 'Gamma watched Beta from afar with the ray.',
        }),
    ];

    // Hand-derived expected pairs (source\0target → match count):
    //   Alpha content "alpha greets beta. beta nods. then gamma arrives."
    //     → target Beta  ("beta"): matches 2  → v1:Alpha\0v1:Beta = 2
    //     → target Gamma ("gamma"|"ray"): "gamma" matches 1, "ray" 0 → 1
    //   Beta content "beta remembers alpha fondly."
    //     → target Alpha ("alpha"|"orb"): "alpha" 1, "orb" 0 → 1
    //     → target Gamma: 0
    //   Gamma content "gamma watched beta from afar with the ray."
    //     → target Alpha: 0
    //     → target Beta ("beta"): 1 → v1:Gamma\0v1:Beta = 1
    const expected = new Map([
        ['v1:Alpha\0v1:Beta', 2],
        ['v1:Alpha\0v1:Gamma', 1],
        ['v1:Beta\0v1:Alpha', 1],
        ['v1:Gamma\0v1:Beta', 1],
    ]);

    const w = fullMentionWeights(entries);
    assertEqual(w.size, expected.size, 'reference produces exactly the expected pair count');
    for (const [key, val] of expected) {
        assertEqual(w.get(key), val, `reference pair ${key} == ${val}`);
    }
    // And no EXTRA pairs leaked beyond the hand-derived set.
    for (const key of w.keys()) {
        assert(expected.has(key), `no unexpected reference pair ${key}`);
    }
});

test('P2: production computeDerivedIndexFields DELEGATES its full path to the shared builder', () => {
    // R6 (2026-05-29): production no longer reimplements the mention-weights
    // algorithm inline — it imports and CALLS the canonical `buildFullMentionWeights`
    // from vault-incremental.js, which is the SAME function P1 exercises above (and
    // the same `fullMentionWeights` the section-L equivalence tests run). So P1 now
    // directly guards production's algorithm, and P2 only needs to confirm the
    // delegation wiring is intact (drift can only happen if someone re-inlines a
    // divergent copy). vault.js can't be import()'d (ST module imports) — anchor at
    // the source level, same convention as Sections M/N/O.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    // 1. Production imports the canonical builder from vault-incremental.js. This is
    //    the link that makes P1 a guard for production: same module, same function.
    assert(/import\s*\{[^}]*\bbuildFullMentionWeights\b[^}]*\}\s*from\s*['"]\.\/vault-incremental\.js['"]/s.test(src),
        'production imports buildFullMentionWeights from vault-incremental.js');

    const fnStart = src.indexOf('function computeDerivedIndexFields');
    assert(fnStart > 0, 'computeDerivedIndexFields located in vault.js');
    // The full-rebuild branch begins at `if (weights === null)` and runs until
    // setMentionWeights(weights). Slice that window.
    const branchStart = src.indexOf('if (weights === null)', fnStart);
    assert(branchStart > fnStart, 'production full-rebuild branch (weights === null) present');
    const setIdx = src.indexOf('setMentionWeights(weights)', branchStart);
    assert(setIdx > branchStart, 'setMentionWeights commit located after full-rebuild branch');
    const block = src.slice(branchStart, setIdx);

    // 2. The full-rebuild branch DELEGATES to the shared builder over the full
    //    entry set — it does NOT reimplement the algorithm inline. If a future edit
    //    re-inlines a divergent mention-weights computation, this assertion fails
    //    (the call disappears) and P1 stops guarding the real path.
    assert(/weights\s*=\s*buildFullMentionWeights\(entries\)/.test(block),
        'production full-rebuild delegates to buildFullMentionWeights(entries) (no inline reimplementation)');

    // 3. Guard against re-inlining: the dropped inline primitives (own targetNames
    //    build, parts.sort, combined RegExp construction) must NOT reappear in the
    //    branch — their presence would mean a second, drift-prone copy is back.
    assert(!/parts\.sort\(/.test(block) && !/new RegExp\(parts\.join/.test(block),
        'production full-rebuild branch holds no re-inlined regex assembly (single source of truth)');
});

test('P3: shared buildFullMentionWeights preserves the algorithm properties P2 used to source-guard', () => {
    // R6: the old P2 source-matched the inline production block for five algorithm
    // primitives (trackerKey-keyed identity, last-write-wins contentLower, the
    // `length <= 3` word-boundary rule, length-desc sort + combined /gi regex, and
    // self-skip by key identity). Those primitives now live ONLY in the shared
    // builder, so we re-assert them BEHAVIORALLY on `buildFullMentionWeights` —
    // a stronger guard than the old source regex, and the function production calls.

    // (a) IDENTITY keyed by vaultSource:title — two vaults' same-titled "Castle"
    //     stay DISTINCT identities (gotcha #50). Each source mentions only the OTHER
    //     vault's distinctive target, so the surviving keys must carry the vault prefix.
    const idEntries = [
        makeEntry('Castle', { vaultSource: 'va', filename: 'a-castle.md', keys: [], content: 'The Castle guards Drake.' }),
        makeEntry('Drake', { vaultSource: 'va', filename: 'a-drake.md', keys: [], content: 'Drake hoards gold.' }),
        makeEntry('Castle', { vaultSource: 'vb', filename: 'b-castle.md', keys: [], content: 'The Castle shelters Wren.' }),
        makeEntry('Wren', { vaultSource: 'vb', filename: 'b-wren.md', keys: [], content: 'Wren sings at dawn.' }),
    ];
    const idW = fullMentionWeights(idEntries);
    // Both vaults' "Castle" produce DISTINCT identity keys (vaultSource:title), each
    // scoring only its own vault's distinctive target — proves cross-vault
    // same-title entries never collide (gotcha #50).
    assert(idW.has('va:Castle\0va:Drake') && idW.has('vb:Castle\0vb:Wren'),
        'identity keys are vaultSource:title — cross-vault same-title "Castle" stays distinct');

    // (b) LAST-WRITE-WINS: two entries with the SAME keyOf (vaultSource:title) but
    //     different content — the LAST one's content sources the scan (the L11
    //     invariant). dupB (last) mentions Rival; dupA (first) mentions Mentor.
    const lww = [
        makeEntry('Hero', { vaultSource: 'd', filename: 'a.md', keys: [], content: 'Hero meets Mentor.' }),
        makeEntry('Hero', { vaultSource: 'd', filename: 'b.md', keys: [], content: 'Hero fights Rival.' }),
        makeEntry('Mentor', { vaultSource: 'd', filename: 'm.md', keys: [], content: 'Mentor teaches.' }),
        makeEntry('Rival', { vaultSource: 'd', filename: 'r.md', keys: [], content: 'Rival schemes.' }),
    ];
    const lwwW = fullMentionWeights(lww);
    assert(lwwW.has('d:Hero\0d:Rival') && !lwwW.has('d:Hero\0d:Mentor'),
        'last-write-wins: the LAST same-keyOf entry content (mentions Rival) sources the scan');

    // (c) Short-name (<=3 chars) WORD-BOUNDARY rule: a 3-char title "Orb" must NOT
    //     match the substring inside "Absorbed"; a >3-char title matches as substring.
    const wb = [
        makeEntry('Orb', { vaultSource: 'w', filename: 'orb.md', keys: [], content: 'inert.' }),
        makeEntry('Crystal', { vaultSource: 'w', filename: 'cry.md', keys: [], content: 'inert.' }),
        makeEntry('Probe', { vaultSource: 'w', filename: 'pr.md', keys: [], content: 'The probe absorbed the Crystal fully.' }),
    ];
    const wbW = fullMentionWeights(wb);
    assert(!wbW.has('w:Probe\0w:Orb'), 'short name (<=3) is word-bounded: "Orb" does NOT match inside "absorbed"');
    assert(wbW.get('w:Probe\0w:Crystal') === 1, 'long name (>3) matches as substring ("Crystal")');

    // (d) SELF-SKIP by identity: an entry that mentions its own title scores no
    //     self-pair (targetKey === sourceKey is skipped).
    const ss = [
        makeEntry('Echo', { vaultSource: 's', filename: 'e.md', keys: [], content: 'Echo hears Echo echo Echo.' }),
        makeEntry('Cliff', { vaultSource: 's', filename: 'c.md', keys: [], content: 'silent.' }),
    ];
    const ssW = fullMentionWeights(ss);
    assert(!ssW.has('s:Echo\0s:Echo'), 'self-skip: an entry never scores a mention pair against itself');
});

// ============================================================================
//  Q. T-RED L11 — incremental != full when same vaultSource + same title differ
// ============================================================================
//
// RED reproduce-test for review finding L11 (HIGH). It encodes a CURRENT BUG and
// is SUPPOSED TO FAIL until the L11 fix lands. Do NOT weaken the assertion.
//
// Bug: two entries share the same `vaultSource` AND the same `title` (so the
// same keyOf = `vaultSource:title`) but have a DIFFERENT filename and DIFFERENT
// content, and both are kept (multiVaultConflictResolution = 'all' — no dedup).
//   - The PRODUCTION full path pre-populates contentLower LAST-WRITE-WINS
//     (vault.js: `for (const source of entries) contentLower.set(trackerKey(...),
//     source.content.toLowerCase())`) → the second duplicate's content wins.
//   - The INCREMENTAL path memoizes content FIRST-WRITE-WINS via `lowerOf`
//     (vault-incremental.js ~268-276: `let c = contentLower.get(k); if (c == null)
//     { c = entry.content.toLowerCase(); ... }`) → the FIRST duplicate's content
//     wins.
// So a cold build (full) and a warm build (incremental) scan DIFFERENT source
// content for that keyOf → mention-ranking drift cold-vs-warm. The equivalence
// contract (vault-incremental.js header: "byte-identical to a full rebuild")
// is violated.
//
// Because both entries collapse to ONE keyOf, the weights Map can only hold one
// row/col for that identity — the question is WHOSE content sourced it. Full uses
// the LAST duplicate's content (last-write-wins); incremental's `lowerOf` uses
// the FIRST duplicate's content (first-write-wins). We make the two duplicates
// mention DIFFERENT distinctive targets so the surviving weight key DIFFERS
// between the two builds. For the divergence to surface, the duplicate identity
// must be DIRTY (so incremental actually invokes `lowerOf` rather than reusing
// the seeded prev-weights): the simplest realistic trigger is adding the second
// duplicate on top of a prev that already holds the first.
//
// Observed today (the bug):
//   full  → { dup:Hero \0 dup:Rival : 1 }   (heroB content wins → mentions Rival)
//   inc   → { dup:Hero \0 dup:Mentor : 1 }  (heroA content wins → mentions Mentor)

section('Q. T-RED L11 — same vaultSource+title, different content (incremental != full)');

test('L11-RED: incremental mentionWeights == full for same-vault/same-title duplicates', () => {
    // Distinctive targets: only heroA's content mentions Mentor; only heroB's
    // content mentions Rival. Whichever content "wins" for keyOf `dup:Hero`
    // decides which target it scores against.
    const mentor = makeEntry('Mentor', {
        vaultSource: 'dup', filename: 'mentor.md', keys: [],
        content: 'Mentor is a wise teacher.', _contentHash: 'm1',
    });
    const rival = makeEntry('Rival', {
        vaultSource: 'dup', filename: 'rival.md', keys: [],
        content: 'Rival is a fierce competitor.', _contentHash: 'r1',
    });

    // Two "Hero" entries: SAME vaultSource ('dup'), SAME title ('Hero'),
    // DIFFERENT filename + DIFFERENT content. heroA mentions Mentor; heroB
    // mentions Rival. Both kept side-by-side (multiVaultConflictResolution='all'
    // — no dedup; the index can legitimately carry both, e.g. before a merge).
    const heroA = makeEntry('Hero', {
        vaultSource: 'dup', filename: 'hero-a.md', keys: [],
        content: 'The Hero trains under Mentor every dawn.', _contentHash: 'ha',
    });
    const heroB = makeEntry('Hero', {
        vaultSource: 'dup', filename: 'hero-b.md', keys: [],
        content: 'The Hero duels the Rival at dusk.', _contentHash: 'hb',
    });

    // prev holds heroA (the first duplicate). next ADDS heroB (the second
    // duplicate, same keyOf). heroB is `added` → DIRTY → incremental scans it via
    // `lowerOf`, which first-write-wins memoizes the keyOf `dup:Hero` content. The
    // full path pre-populates contentLower last-write-wins → the two disagree.
    const prev = [heroA, mentor, rival];
    const next = [
        { ...heroA }, { ...heroB }, { ...mentor }, { ...rival },
    ];

    const fullWeights = fullMentionWeights(next);
    const diff = diffEntries(prev, next);
    const incWeights = incrementalMentionWeights(fullMentionWeights(prev), prev, next, diff);

    // Equivalence contract: incremental MUST equal full, byte-for-byte. These are
    // the assertions that FAIL today — incremental sources heroA's content for the
    // shared `dup:Hero` identity while full sources heroB's, so the surviving
    // mention pair (and thus the Map) differs.
    assertEqual(incWeights.size, fullWeights.size,
        'L11: incremental pair count must equal full for same-vault/same-title duplicates');
    for (const [key, val] of fullWeights) {
        assertEqual(incWeights.get(key), val, `L11: pair ${key} (full=${val}) must match incremental`);
    }
    for (const key of incWeights.keys()) {
        assert(fullWeights.has(key), `L11: incremental must not invent pair ${key} absent from full`);
    }
});

// ============================================================================
//  R. T-L5 — incremental BM25 structural invariants (pin before perf refactor)
// ============================================================================
//
// Phase-2 (L5) will rewrite the incremental BM25 path to CARRY df + totalLen on
// the index object and mutate them in addDoc/removeDoc instead of rebuilding df
// from every doc's every term and re-summing totalLen on every call. These
// tests pin the structural invariants the rewrite must preserve. They PASS today
// (the current code derives the same OUTPUT), but they guard the contract so the
// perf refactor can't silently corrupt df / totalLen.
//
// The returned index shape is { idf, docs, avgDl, invertedIndex } — df and
// totalLen are NOT exposed, so we derive them from the public structure:
//   df(term)  := number of docs whose tf contains term  (== invertedIndex posting size)
//   totalLen  := sum of doc.len over all docs            (== avgDl * N)

section('R. T-L5 — incremental BM25 df / totalLen invariants');

// Derive df(term) from docs: count docs whose tf Map contains the term.
function deriveDfFromDocs(index) {
    const df = new Map();
    for (const doc of index.docs.values()) {
        for (const term of doc.tf.keys()) {
            df.set(term, (df.get(term) || 0) + 1);
        }
    }
    return df;
}

test('L5-inv1: after incremental update, df(term) === invertedIndex posting size for ALL terms', () => {
    const prev = buildSyntheticVault(8);
    const prevIndex = buildBM25Index(prev);

    // Mix of add + remove + modify so removeDoc/addDoc both run.
    const next = prev.slice(0, 7).map(e => ({ ...e })); // drop last (remove)
    next[1].content = `Reworked ${next[1].title}: now about phoenix and griffin.`; // modify
    next[1]._contentHash = 'h1-mod';
    next.push(makeEntry('Newcomer', {                                              // add
        filename: 'new.md', vaultSource: 'main', keys: ['fresh'],
        content: 'Newcomer brings unique tokens quasar and pulsar.',
        _contentHash: 'hnew',
    }));

    const diff = diffEntries(prev, next);
    const incIndex = incrementalBM25Update(prevIndex, diff);
    assertNotNull(incIndex, 'incremental returned an index');

    const df = deriveDfFromDocs(incIndex);
    // INVARIANT: df.get(term) === invertedIndex.get(term).size for every term.
    for (const [term, posting] of incIndex.invertedIndex) {
        assertEqual(df.get(term), posting.size,
            `L5-inv1: df(${term}) must equal posting size`);
    }
    // And no posting list exists for a term with df 0, and no df-tracked term
    // lacks a posting list (bijection between df keys and invertedIndex keys).
    for (const term of df.keys()) {
        assertNotNull(incIndex.invertedIndex.get(term),
            `L5-inv1: term ${term} with df>0 has a posting list`);
    }
    assertEqual(df.size, incIndex.invertedIndex.size,
        'L5-inv1: df key set and invertedIndex key set are the same size (bijection)');
});

test('L5-inv2: after incremental update, totalLen (sum doc.len) === avgDl * N', () => {
    const prev = buildSyntheticVault(6);
    const prevIndex = buildBM25Index(prev);

    const next = prev.map(e => ({ ...e }));
    next[2].content = `Lengthened content for ${next[2].title} with several extra distinct words here.`;
    next[2]._contentHash = 'h2-mod';
    next.push(makeEntry('Tail', {
        filename: 'tail.md', vaultSource: 'main', keys: ['tailkey'],
        content: 'Tail entry adds words: alpha beta gamma delta.',
        _contentHash: 'htail',
    }));

    const diff = diffEntries(prev, next);
    const incIndex = incrementalBM25Update(prevIndex, diff);
    assertNotNull(incIndex, 'incremental returned an index');

    let totalLen = 0;
    for (const doc of incIndex.docs.values()) totalLen += doc.len;
    const N = incIndex.docs.size;
    // avgDl === totalLen / N  ⇒  totalLen === avgDl * N. This pins the totalLen
    // bookkeeping the Phase-2 rewrite will mutate incrementally.
    assert(Math.abs(incIndex.avgDl * N - totalLen) < 1e-9,
        'L5-inv2: avgDl * N reproduces summed doc.len (totalLen consistent)');
});

test('L5-equiv: incremental BM25 == full rebuild for a small mixed delta (df+totalLen+idf)', () => {
    const prev = buildSyntheticVault(7);
    const prevIndex = buildBM25Index(prev);

    const next = prev.slice(0, 6).map(e => ({ ...e })); // remove last
    next[0].content = `Updated ${next[0].title} mentions nebula and comet now.`; // modify
    next[0]._contentHash = 'h0-mod';
    next.push(makeEntry('Extra', {                                               // add
        filename: 'extra.md', vaultSource: 'main', keys: ['extrakey'],
        content: 'Extra brings supernova and meteor tokens.',
        _contentHash: 'hextra',
    }));

    const diff = diffEntries(prev, next);
    const incIndex = incrementalBM25Update(prevIndex, diff);
    const fullIndex = buildBM25Index(next);
    assertNotNull(incIndex, 'incremental returned an index');

    // df equivalence (derived both sides).
    const incDf = deriveDfFromDocs(incIndex);
    const fullDf = deriveDfFromDocs(fullIndex);
    assertEqual(incDf.size, fullDf.size, 'L5-equiv: same df term count');
    for (const [term, freq] of fullDf) {
        assertEqual(incDf.get(term), freq, `L5-equiv: df(${term}) matches full`);
    }

    // totalLen equivalence.
    let incTotal = 0, fullTotal = 0;
    for (const doc of incIndex.docs.values()) incTotal += doc.len;
    for (const doc of fullIndex.docs.values()) fullTotal += doc.len;
    assertEqual(incTotal, fullTotal, 'L5-equiv: totalLen matches full rebuild');
    assert(Math.abs(incIndex.avgDl - fullIndex.avgDl) < 1e-9, 'L5-equiv: avgDl matches');

    // idf equivalence (the user-visible consequence of df/N being right).
    assertEqual(incIndex.idf.size, fullIndex.idf.size, 'L5-equiv: same idf term count');
    for (const [term, idfVal] of fullIndex.idf) {
        const incIdf = incIndex.idf.get(term);
        assertNotNull(incIdf, `L5-equiv: incremental has idf for ${term}`);
        assert(Math.abs(incIdf - idfVal) < 1e-9, `L5-equiv: idf(${term}) matches full`);
    }
    // invertedIndex equivalence.
    assertEqual(incIndex.invertedIndex.size, fullIndex.invertedIndex.size,
        'L5-equiv: same inverted-index term count');
    for (const [term, posting] of fullIndex.invertedIndex) {
        const incPosting = incIndex.invertedIndex.get(term);
        assertNotNull(incPosting, `L5-equiv: incremental has posting for ${term}`);
        assertEqual(incPosting.size, posting.size, `L5-equiv: posting size for ${term}`);
        for (const docId of posting) {
            assert(incPosting.has(docId), `L5-equiv: posting[${term}] includes ${docId}`);
        }
    }
});

// ============================================================================
//  S. L11b — merge-mode reuse-sync must NOT double-accumulate content
// ============================================================================
//
// RED reproduce-test for review finding L11b (MED). It encodes a CURRENT BUG and
// is SUPPOSED TO FAIL until the L11b fix lands (the source-guard test below is the
// RED→GREEN anchor; the behavioral test documents the mechanism).
//
// Bug: under `multiVaultConflictResolution='merge'`, the committed index holds ONE
// entry per title whose `content` is the concatenation of all members
// (m1 + sep + m2) but whose `_contentHash` is BUG-378-preserved as the hash of the
// FIRST member's on-disk file (m1). On a reuse-sync tick, buildIndexWithReuse's
// fast-path keys `existingMap` by `vaultSource\0filename`, so the merged blob is
// reachable under the FIRST member's file key. When that file is re-fetched its
// hash matches → the naive fast-path pushes the m1+m2 blob; the SECOND member's
// file has no existing entry under its own key → re-parsed fresh (m2); then the
// `deduplicateMultiVault(..., 'merge')` pass re-merges → (m1+m2) + sep + m2 =
// m1+m2+m2. Each tick re-merges the already-merged blob → unbounded growth, and
// the inflated entry becomes the baseline fed to the incremental delta (token /
// budget skew). The FULL build always re-parses members cleanly, so reuse ≠ full.
//
// The fix: on the reuse fast-path, under merge mode only, verify the reuse
// candidate against a fresh single-member parse of its own file via
// `canReuseMergedCandidate` (content-equality) — a genuine single-file entry
// matches, a merged blob does not → forced re-parse → the dedup pass rebuilds the
// merge cleanly from fresh members (== full build). Persisted markers can't be
// used: cache.js strips `_`-fields on save, so a `_mergedFrom` flag dies on
// hydrate (and the first post-hydrate sync is a reuse tick).
//
// vault.js is NOT importable in the Node harness (it pulls tokenizers.js /
// openai.js / script.js), so — exactly like the M-series — the RED→GREEN anchor
// is a SOURCE-STRUCTURE guard, paired with a behavioral simulation built on the
// real (importable) `deduplicateMultiVault` that reproduces the growth mechanism.

section('S. L11b — merge-mode reuse-sync double-accumulation');

// Faithful, dependency-free model of the reuse-sync file loop's per-file decision
// (mirrors buildIndexWithReuse). `verifyMergeReuse` toggles the L11b fix:
//   false → naive (== OLD production): reuse the existing entry whenever its
//           _contentHash matches the file hash (this reuses the merged blob).
//   true  → fixed (== NEW production): under merge mode, only reuse when a fresh
//           single-member parse of the file matches existing.content (the rule
//           `canReuseMergedCandidate` enforces). A merged blob fails the check and
//           is re-parsed to its single member.
// In both cases the surviving `allEntries` are run through the REAL
// `deduplicateMultiVault(..., 'merge')` — the production dedup pass.
function simulateReuseMergeTick(snapshot, fetchedFiles, { verifyMergeReuse }) {
    // existingMap keyed by `vaultSource\0filename` (production key shape).
    const existingMap = new Map();
    for (const e of snapshot) existingMap.set(`${e.vaultSource}\0${e.filename}`, e);

    const allEntries = [];
    for (const file of fetchedFiles) {
        const existing = existingMap.get(`${file.vaultSource}\0${file.filename}`);
        // Fresh single-member parse of THIS file (in production: parseVaultFile →
        // content === this file's own member content, never the merged blob).
        const fresh = {
            title: file.title, vaultSource: file.vaultSource, filename: file.filename,
            content: file.content, keys: file.keys || [], tags: ['lorebook'],
            tokenEstimate: file.tokenEstimate || 0, _contentHash: file.hash,
            links: [], resolvedLinks: [], requires: [], excludes: [], customFields: {},
        };
        const hashMatches = existing && existing._contentHash === file.hash;
        let reuse = hashMatches;
        if (reuse && verifyMergeReuse) {
            // canReuseMergedCandidate's rule: genuine single-file entry parses back
            // to identical content; a merged blob (m1+sep+m2) does not.
            reuse = fresh.content === existing.content;
        }
        allEntries.push(reuse ? existing : fresh);
    }
    return deduplicateMultiVault(allEntries, 'merge');
}

test('L11b-MERGE: naive reuse path GROWS merged content each tick (bug reproduced)', () => {
    // Two cross-vault same-title entries: vaultA/Castle (m1) and vaultB/Castle (m2).
    const m1 = 'Castle of the north, ancient and cold.';
    const m2 = 'Castle gardens bloom in the southern spring.';
    const filesA = { title: 'Castle', vaultSource: 'vaultA', filename: 'castle.md', content: m1, hash: 'hashA', tokenEstimate: 10 };
    const filesB = { title: 'Castle', vaultSource: 'vaultB', filename: 'castle.md', content: m2, hash: 'hashB', tokenEstimate: 12 };

    // Tick 0 = full build: parse both members fresh, dedup-merge.
    const fetched = [filesA, filesB];
    const tick0 = deduplicateMultiVault(
        fetched.map(f => ({
            title: f.title, vaultSource: f.vaultSource, filename: f.filename,
            content: f.content, keys: [], tags: ['lorebook'], tokenEstimate: f.tokenEstimate,
            _contentHash: f.hash, links: [], resolvedLinks: [], requires: [], excludes: [], customFields: {},
        })), 'merge');
    assertEqual(tick0.length, 1, 'tick0: merged to one entry');
    const fullLen = tick0[0].content.length;
    assert(tick0[0].content.includes(m1) && tick0[0].content.includes(m2), 'tick0: both members present');
    // Sanity: the merged blob carries vaultA's _contentHash (BUG-378) → matches filesA's hash.
    assertEqual(tick0[0]._contentHash, 'hashA', 'tick0: merged blob keeps first member hash (BUG-378)');

    // Tick 1 (naive reuse): snapshot = [merged blob]; re-fetch both files.
    const naive1 = simulateReuseMergeTick(tick0, fetched, { verifyMergeReuse: false });
    assertEqual(naive1.length, 1, 'naive tick1: still one entry');
    // The bug: merged blob (m1+m2) reused for filesA + fresh m2 → m1+m2+m2.
    assert(naive1[0].content.length > fullLen,
        'naive tick1: content GREW vs full build (bug — reuse != full)');
    const m2Count1 = naive1[0].content.split(m2).length - 1;
    assertEqual(m2Count1, 2, 'naive tick1: second member body duplicated (m1+m2+m2)');

    // Tick 2 (naive reuse again, snapshot = naive1): grows further still.
    const naive2 = simulateReuseMergeTick(naive1, fetched, { verifyMergeReuse: false });
    assert(naive2[0].content.length > naive1[0].content.length,
        'naive tick2: content keeps growing unbounded');
});

test('L11b-MERGE: fixed reuse path keeps merged content STABLE == full build', () => {
    const m1 = 'Castle of the north, ancient and cold.';
    const m2 = 'Castle gardens bloom in the southern spring.';
    const filesA = { title: 'Castle', vaultSource: 'vaultA', filename: 'castle.md', content: m1, hash: 'hashA', tokenEstimate: 10 };
    const filesB = { title: 'Castle', vaultSource: 'vaultB', filename: 'castle.md', content: m2, hash: 'hashB', tokenEstimate: 12 };
    const fetched = [filesA, filesB];

    const fullBuild = deduplicateMultiVault(
        fetched.map(f => ({
            title: f.title, vaultSource: f.vaultSource, filename: f.filename,
            content: f.content, keys: [], tags: ['lorebook'], tokenEstimate: f.tokenEstimate,
            _contentHash: f.hash, links: [], resolvedLinks: [], requires: [], excludes: [], customFields: {},
        })), 'merge');
    const fullLen = fullBuild[0].content.length;
    const fullTokens = fullBuild[0].tokenEstimate;

    // Tick 1 (fixed reuse): verifyMergeReuse=true → merged blob fails the content
    // check for filesA → re-parsed to m1; filesB re-parsed to m2 → dedup merges →
    // m1+m2, identical to the full build.
    const fixed1 = simulateReuseMergeTick(fullBuild, fetched, { verifyMergeReuse: true });
    assertEqual(fixed1.length, 1, 'fixed tick1: one entry');
    assertEqual(fixed1[0].content.length, fullLen, 'fixed tick1: content length == full build');
    assertEqual(fixed1[0].content, fullBuild[0].content, 'fixed tick1: content byte-identical to full build');
    assertEqual(fixed1[0].tokenEstimate, fullTokens, 'fixed tick1: tokenEstimate == full build (no skew)');
    const m2CountFixed = fixed1[0].content.split(m2).length - 1;
    assertEqual(m2CountFixed, 1, 'fixed tick1: second member body appears exactly once');

    // Tick 2 (fixed reuse, snapshot = fixed1): STILL stable — no growth.
    const fixed2 = simulateReuseMergeTick(fixed1, fetched, { verifyMergeReuse: true });
    assertEqual(fixed2[0].content.length, fullLen, 'fixed tick2: content length STILL == full build');
    assertEqual(fixed2[0].content, fullBuild[0].content, 'fixed tick2: content STILL byte-identical (no accumulation)');
});

test('L11b-MERGE: vault.js reuse loop gates merge reuse behind canReuseMergedCandidate (source guard — RED→GREEN anchor)', () => {
    // vault.js is not importable in the Node harness, so anchor the fix to source
    // (mirrors the M-series). RED on unfixed source, GREEN once L11b lands.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');

    // 1. The pure, exported predicate must exist.
    assert(/export function canReuseMergedCandidate\s*\(/.test(src),
        'canReuseMergedCandidate exported from vault.js');

    // 2. The reuse loop must compute a mergeMode flag from the conflict-resolution setting.
    assert(/const\s+mergeMode\s*=\s*settings\.multiVaultConflictResolution\s*===\s*'merge'/.test(src),
        'reuse path derives mergeMode from multiVaultConflictResolution');

    // 3. The fast-path reuse decision must consult canReuseMergedCandidate when in
    //    merge mode (so a merged blob is never reused verbatim).
    const reuseIdx = src.indexOf('export async function buildIndexWithReuse');
    assert(reuseIdx > 0, 'buildIndexWithReuse found');
    const reuseBody = src.slice(reuseIdx);
    assert(/if\s*\(\s*canReuse\s*&&\s*mergeMode\s*\)/.test(reuseBody),
        'merge-mode verification gate present in reuse loop');
    assert(/canReuse\s*=\s*canReuseMergedCandidate\(/.test(reuseBody),
        'reuse decision routed through canReuseMergedCandidate under merge mode');
});

test('L11b-MERGE: non-merge reuse decision is untouched by the fix (mergeMode-gated)', () => {
    // Guard the "non-merge default path byte-identical" requirement: the merge
    // verification (the only new branch) must be gated behind `mergeMode`, so for
    // 'all'/'first'/'last' the reuse decision is the original hash-only check.
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const reuseIdx = src.indexOf('export async function buildIndexWithReuse');
    const reuseBody = src.slice(reuseIdx);

    // The verification re-parse + canReuseMergedCandidate call must appear ONLY
    // inside an `if (canReuse && mergeMode)` block — never unconditionally.
    const gateIdx = reuseBody.indexOf('if (canReuse && mergeMode)');
    const predIdx = reuseBody.indexOf('canReuse = canReuseMergedCandidate(');
    assert(gateIdx > 0, 'mergeMode gate present');
    assert(predIdx > gateIdx, 'canReuseMergedCandidate call sits after (inside) the mergeMode gate');

    // The base reuse decision must still be the original hash + !fieldDefsChanged check.
    assert(/let\s+canReuse\s*=\s*existing\s*&&\s*existing\._contentHash\s*===\s*fileHash\s*&&\s*!fieldDefsChanged/.test(reuseBody),
        'base reuse decision unchanged: existing && hash match && !fieldDefsChanged');
});

// ============================================================================
// Summary
// ============================================================================

await summary('Vault & Multi-Vault Tests');
