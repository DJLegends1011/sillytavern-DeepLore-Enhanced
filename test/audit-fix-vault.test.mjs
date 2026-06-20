/**
 * DeepLore Enhanced — Audit-Fix Vault Regression Tests
 * Run with: node test/audit-fix-vault.test.mjs
 *
 * Covers the confirmed vault/index/cache/import fixes from the audit pass:
 *   P1-1 — buildIndex fresh-rebuild catch carries forward a failed vault's prior entries.
 *   P2-7 — merge-mode + vault failure commits the WHOLE prior snapshot (provenance unsplittable).
 *   P2-8 — merge dedup unions cascadeLinks AND refineKeys.
 *   P3-2 — importEntries fires onProgress on EVERY entry (incl. failure `continue` branches).
 *   P3-3 — convertWiEntry routes filenames through sanitizeFilename (reserved names, dots).
 *   P3-4 — validateCachedEntry rejects ±Infinity tokenEstimate.
 *   P3-5 — conflictModeMessage drives BOTH fresh-build and reuse-sync dupe warnings.
 *
 * Pure functions are exercised directly. vault.js / ai.js / import.js pull the ST
 * module chain (settings.js, script.js, …) so they can't be Node-imported — those
 * fixes are pinned via source-code assertions, mirroring the existing M1–M6 /
 * L11b-MERGE style in vault.test.mjs.
 */

import {
    assert, assertEqual, assertContains, assertArrayEquals,
    test, section, summary,
} from './helpers.mjs';

import {
    deduplicateMultiVault, conflictModeMessage,
} from '../src/vault/vault-pure.js';

import { validateCachedEntry } from '../src/vault/cache-validate.js';

import { convertWiEntry, sanitizeFilename } from '../src/helpers.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('DeepLore Enhanced — Audit-Fix Vault Tests');
console.log('='.repeat(60));

// Minimal merge-eligible entry factory (merge dedup keys on title.toLowerCase()).
function mergeEntry(title, vaultSource, opts = {}) {
    return {
        title,
        vaultSource,
        keys: opts.keys || [],
        tags: opts.tags || [],
        links: opts.links || [],
        resolvedLinks: opts.resolvedLinks || [],
        requires: opts.requires || [],
        excludes: opts.excludes || [],
        cascadeLinks: opts.cascadeLinks || [],
        refineKeys: opts.refineKeys || [],
        content: opts.content ?? `body-${vaultSource}`,
        summary: opts.summary || '',
        tokenEstimate: opts.tokenEstimate ?? 10,
        constant: opts.constant || false,
        seed: opts.seed || false,
        bootstrap: opts.bootstrap || false,
        guide: opts.guide || false,
        customFields: opts.customFields || {},
        _contentHash: opts._contentHash || `hash-${vaultSource}`,
    };
}

// ============================================================================
//  P2-8 — merge dedup unions cascadeLinks AND refineKeys
// ============================================================================

section('P2-8: merge dedup unions cascadeLinks + refineKeys');

test('P2-8a: merged entry unions cascadeLinks from both members', () => {
    const entries = [
        mergeEntry('Castle', 'v1', { cascadeLinks: ['Moat', 'Gate'] }),
        mergeEntry('Castle', 'v2', { cascadeLinks: ['Gate', 'Tower'] }),
    ];
    const out = deduplicateMultiVault(entries, 'merge');
    assertEqual(out.length, 1, 'merge collapses to one entry');
    const merged = out[0];
    assertContains(merged.cascadeLinks, 'Moat', 'cascadeLinks keeps v1-only Moat');
    assertContains(merged.cascadeLinks, 'Gate', 'cascadeLinks keeps shared Gate');
    assertContains(merged.cascadeLinks, 'Tower', 'cascadeLinks keeps v2-only Tower');
    assertEqual(merged.cascadeLinks.length, 3, 'cascadeLinks deduped (no double Gate)');
});

test('P2-8b: merged entry unions refineKeys from both members', () => {
    const entries = [
        mergeEntry('Castle', 'v1', { refineKeys: ['siege', 'wall'] }),
        mergeEntry('Castle', 'v2', { refineKeys: ['wall', 'keep'] }),
    ];
    const out = deduplicateMultiVault(entries, 'merge');
    const merged = out[0];
    assertContains(merged.refineKeys, 'siege', 'refineKeys keeps v1-only siege');
    assertContains(merged.refineKeys, 'wall', 'refineKeys keeps shared wall');
    assertContains(merged.refineKeys, 'keep', 'refineKeys keeps v2-only keep');
    assertEqual(merged.refineKeys.length, 3, 'refineKeys deduped (no double wall)');
});

test('P2-8c: merge still unions the pre-existing array fields (no regression)', () => {
    const entries = [
        mergeEntry('Castle', 'v1', { keys: ['a'], tags: ['lorebook'], requires: ['X'] }),
        mergeEntry('Castle', 'v2', { keys: ['b'], tags: ['lore'], requires: ['Y'] }),
    ];
    const merged = deduplicateMultiVault(entries, 'merge')[0];
    assertEqual(merged.keys.sort().join(','), 'a,b', 'keys unioned');
    assertEqual(merged.requires.sort().join(','), 'X,Y', 'requires unioned');
});

test('P2-8d: source-pin — vault-pure union list includes cascadeLinks + refineKeys', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault-pure.js'), 'utf8');
    // The single union loop in the merge branch must name both new fields.
    assert(/for \(const field of \[[^\]]*'cascadeLinks'[^\]]*'refineKeys'[^\]]*\]\)/.test(src)
        || /'cascadeLinks'/.test(src) && /'refineKeys'/.test(src),
        'merge union list names cascadeLinks and refineKeys');
});

// ============================================================================
//  P3-4 — validateCachedEntry rejects ±Infinity tokenEstimate
// ============================================================================

section('P3-4: validateCachedEntry rejects non-finite tokenEstimate');

function baseCachedEntry(tokenEstimate) {
    return { title: 'T', keys: [], content: 'c', tokenEstimate };
}

test('P3-4a: Infinity tokenEstimate rejected', () => {
    assertEqual(validateCachedEntry(baseCachedEntry(Infinity)), false, 'Infinity → invalid');
});

test('P3-4b: -Infinity tokenEstimate rejected', () => {
    assertEqual(validateCachedEntry(baseCachedEntry(-Infinity)), false, '-Infinity → invalid');
});

test('P3-4c: NaN tokenEstimate still rejected', () => {
    assertEqual(validateCachedEntry(baseCachedEntry(NaN)), false, 'NaN → invalid');
});

test('P3-4d: negative tokenEstimate still rejected', () => {
    assertEqual(validateCachedEntry(baseCachedEntry(-1)), false, 'negative → invalid');
});

test('P3-4e: non-number tokenEstimate still rejected', () => {
    assertEqual(validateCachedEntry(baseCachedEntry('50')), false, 'string → invalid');
});

test('P3-4f: finite non-negative tokenEstimate still accepted', () => {
    assertEqual(validateCachedEntry(baseCachedEntry(0)), true, '0 → valid');
    assertEqual(validateCachedEntry(baseCachedEntry(123)), true, '123 → valid');
});

// ============================================================================
//  P3-3 — convertWiEntry routes filenames through sanitizeFilename
// ============================================================================

section('P3-3: convertWiEntry uses sanitizeFilename');

test('P3-3a: Windows reserved name CON is escaped', () => {
    const out = convertWiEntry({ comment: 'CON', content: 'x' }, 'lorebook');
    assertEqual(out.filename, sanitizeFilename('CON') + '.md', 'filename matches sanitizeFilename output');
    assertEqual(out.filename, '_CON.md', 'CON → _CON.md');
});

test('P3-3b: other Windows reserved names escaped (COM1, LPT1, NUL)', () => {
    assertEqual(convertWiEntry({ comment: 'COM1', content: 'x' }, 'lorebook').filename, '_COM1.md', 'COM1 → _COM1.md');
    assertEqual(convertWiEntry({ comment: 'LPT1', content: 'x' }, 'lorebook').filename, '_LPT1.md', 'LPT1 → _LPT1.md');
    assertEqual(convertWiEntry({ comment: 'NUL', content: 'x' }, 'lorebook').filename, '_NUL.md', 'NUL → _NUL.md');
});

test('P3-3c: reserved-name match is case-insensitive', () => {
    assertEqual(convertWiEntry({ comment: 'con', content: 'x' }, 'lorebook').filename, '_con.md', 'con → _con.md');
});

test('P3-3d: leading/trailing dots stripped', () => {
    const out = convertWiEntry({ comment: '.hidden.', content: 'x' }, 'lorebook');
    assertEqual(out.filename, 'hidden.md', '".hidden." → hidden.md');
});

test('P3-3e: illegal chars still replaced with underscore', () => {
    const out = convertWiEntry({ comment: 'a/b:c', content: 'x' }, 'lorebook');
    assertEqual(out.filename, 'a_b_c.md', 'a/b:c → a_b_c.md');
});

test('P3-3f: empty/dots-only title falls back to Untitled', () => {
    const out = convertWiEntry({ comment: '...', content: 'x' }, 'lorebook');
    assertEqual(out.filename, 'Untitled.md', '"..." → Untitled.md');
});

test('P3-3g: normal title is unaffected; in_chat title preserved', () => {
    const out = convertWiEntry({ comment: 'The Old Castle', content: 'x' }, 'lorebook');
    assertEqual(out.filename, 'The Old Castle.md', 'normal title untouched');
    assertEqual(out.title, 'The Old Castle', 'title field unchanged');
});

// ============================================================================
//  P3-5 — conflictModeMessage shared helper
// ============================================================================

section('P3-5: conflictModeMessage covers all four modes + fallback');

test('P3-5a: all mode message', () => {
    assertContains([conflictModeMessage('all')], conflictModeMessage('all'), 'returns string');
    assert(/mode: all/.test(conflictModeMessage('all')), 'all message names mode: all');
    assert(/all copies/i.test(conflictModeMessage('all')), 'all message mentions all copies');
});

test('P3-5b: first mode message', () => {
    assert(/first vault/i.test(conflictModeMessage('first')), 'first message mentions first vault');
});

test('P3-5c: last mode message', () => {
    assert(/last vault/i.test(conflictModeMessage('last')), 'last message mentions last vault');
});

test('P3-5d: merge mode message', () => {
    assert(/merging/i.test(conflictModeMessage('merge')), 'merge message mentions merging');
});

test('P3-5e: unknown mode falls back', () => {
    assert(/configured conflict mode/i.test(conflictModeMessage('bogus')), 'unknown → fallback string');
    assert(/configured conflict mode/i.test(conflictModeMessage(undefined)), 'undefined → fallback string');
});

test('P3-5f: source-pin — both vault.js dupe warnings call conflictModeMessage', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const imported = /import\s*\{[^}]*conflictModeMessage[^}]*\}\s*from\s*'\.\/vault-pure\.js'/.test(src);
    assert(imported, 'vault.js imports conflictModeMessage');
    const calls = (src.match(/conflictModeMessage\(/g) || []).length;
    assert(calls >= 2, `conflictModeMessage called at both dupe-warning sites (found ${calls})`);
    // The old reuse-path lie must be gone.
    assert(!/Keeping the first vault's copy\. Rename one copy to avoid issues\./.test(src),
        'hardcoded reuse-path "Keeping the first vault\'s copy" warning removed');
});

// ============================================================================
//  P1-1 — fresh-rebuild catch carries forward a failed vault's prior entries
// ============================================================================

section('P1-1: buildIndex catch carries forward failed vault entries (source-pin)');

function buildIndexBody(src) {
    // Isolate the fresh buildIndex() function body (up to buildIndexWithReuse).
    const start = src.indexOf('export async function buildIndex(');
    const reuse = src.indexOf('export async function buildIndexWithReuse');
    assert(start > 0, 'buildIndex declaration found');
    assert(reuse > start, 'buildIndexWithReuse declaration found after buildIndex');
    return src.slice(start, reuse);
}

test('P1-1a: catch block carries forward prior entries for the failed vault', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const body = buildIndexBody(src);
    const catchIdx = body.indexOf('} catch (vaultErr) {');
    assert(catchIdx > 0, 'buildIndex per-vault catch found');
    // Within the catch, after the single-vault throw, the per-vault carry-forward.
    const catchTail = body.slice(catchIdx, catchIdx + 2000);
    assert(/if \(enabledVaults\.length === 1\) throw vaultErr;/.test(catchTail),
        'single-vault case still throws');
    assert(/for \(const entry of priorIndexSnapshot\)/.test(catchTail),
        'catch iterates priorIndexSnapshot');
    assert(/entry\.vaultSource === vault\.name/.test(catchTail),
        'catch filters by failed vault.name');
    assert(/entries\.push\(entry\)/.test(catchTail),
        'catch pushes carried-forward entries');
});

test('P1-1b: carry-forward sits AFTER the single-vault throw (single-vault still throws)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const body = buildIndexBody(src);
    const throwIdx = body.indexOf('if (enabledVaults.length === 1) throw vaultErr;');
    const carryIdx = body.indexOf('for (const entry of priorIndexSnapshot)', throwIdx);
    assert(throwIdx > 0 && carryIdx > throwIdx,
        'per-vault carry-forward is placed after the single-vault throw guard');
});

// ============================================================================
//  P2-7 — merge-mode + failure commits the whole prior snapshot
// ============================================================================

section('P2-7: merge-mode failure preserves whole prior index (source-pin)');

test('P2-7a: merge + vaultFetchFailed branch commits whole priorIndexSnapshot', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const body = buildIndexBody(src);
    // A branch guarded by merge mode + a failure that replaces entries with the snapshot.
    const branchMatch = /multiVaultConflictResolution === 'merge'[\s\S]{0,400}?entries = \[\.\.\.priorIndexSnapshot\]/.test(body)
        || /vaultFetchFailed[\s\S]{0,200}?'merge'[\s\S]{0,400}?priorIndexSnapshot/.test(body);
    assert(branchMatch, 'merge-mode failure branch replaces entries with priorIndexSnapshot');
});

test('P2-7b: merge-mode preserve branch skips cache save (skipCacheSave: true)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const body = buildIndexBody(src);
    const mergeIdx = body.indexOf("multiVaultConflictResolution === 'merge'");
    assert(mergeIdx > 0, 'merge-preserve branch present');
    const branch = body.slice(mergeIdx, mergeIdx + 700);
    assert(/finalizeIndex\(\{[^}]*skipCacheSave:\s*true/.test(branch),
        'merge-preserve branch finalizes with skipCacheSave: true');
});

test('P2-7c: merge-mode preserve branch guards isZombie before committing', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/vault.js'), 'utf8');
    const body = buildIndexBody(src);
    const mergeIdx = body.indexOf("multiVaultConflictResolution === 'merge'");
    const branch = body.slice(mergeIdx, mergeIdx + 700);
    assert(/isZombie\(\)/.test(branch), 'merge-preserve branch re-checks isZombie');
});

// ============================================================================
//  P3-2 — importEntries fires onProgress on every entry, including failures
// ============================================================================

section('P3-2: importEntries progress fires on every entry (source-pin)');

function importEntriesBody(src) {
    const start = src.indexOf('export async function importEntries');
    assert(start > 0, 'importEntries declaration found');
    // Stop at the next top-level export to bound the body.
    const next = src.indexOf('export async function upsertConvertedEntry', start);
    return src.slice(start, next > start ? next : undefined);
}

test('P3-2a: per-entry loop uses a finally that always calls onProgress', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/import.js'), 'utf8');
    const body = importEntriesBody(src);
    assert(/\}\s*finally\s*\{\s*\n?\s*if \(onProgress\) onProgress\(/.test(body)
        || /finally\s*\{[\s\S]{0,120}?onProgress\(imported \+ failed \+ skipped, entries\.length\)/.test(body),
        'loop body has a finally that calls onProgress');
});

test('P3-2b: failure `continue` branches no longer bypass progress', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/import.js'), 'utf8');
    const body = importEntriesBody(src);
    // The dedup-fail and existence-catch branches still `continue`, but the trailing
    // standalone `if (onProgress) onProgress(...)` after the catch (which they skipped)
    // is gone — progress now rides the finally instead.
    const finallyIdx = body.indexOf('} finally {');
    assert(finallyIdx > 0, 'finally block present');
    // There must be exactly one onProgress numerator-of-failures site outside the
    // EM-skip path: the finally. The old post-catch standalone call is removed.
    const afterCatch = body.slice(body.lastIndexOf('errors.push(`Entry:'), body.length);
    assert(/finally\s*\{/.test(afterCatch), 'finally immediately follows the catch (no standalone post-catch onProgress)');
});

test('P3-2c: EM-skip path no longer double-fires onProgress (relies on finally)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/vault/import.js'), 'utf8');
    const body = importEntriesBody(src);
    // The EM-skip block bumps counters then `continue`s; it must NOT also call
    // onProgress inline (the finally covers it) — otherwise progress jumps by 2.
    const emIdx = body.indexOf("emHandling === 'skip'");
    assert(emIdx > 0, 'EM-skip branch present');
    const emBranch = body.slice(emIdx, body.indexOf('continue;', emIdx) + 'continue;'.length);
    assert(!/onProgress\(/.test(emBranch), 'EM-skip branch does not call onProgress inline');
});

// ============================================================================
//  P2-6 — hierarchicalPreFilter passes a jsonSchema
// ============================================================================

section('P2-6: hierarchicalPreFilter constrains response via jsonSchema (source-pin)');

function preFilterBody(src) {
    const start = src.indexOf('export async function hierarchicalPreFilter');
    assert(start > 0, 'hierarchicalPreFilter declaration found');
    // Bound to a reasonable window covering the schema def + callAI invocation.
    return src.slice(start, start + 7000);
}

test('P2-6a: hierarchicalPreFilter callAI options include jsonSchema', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ai/ai.js'), 'utf8');
    const body = preFilterBody(src);
    assert(/caller: 'hierarchicalPreFilter'/.test(body), 'prefilter callAI block present');
    assert(/jsonSchema:\s*categorySelectionSchema/.test(body)
        || /jsonSchema:/.test(body),
        'prefilter callAI passes jsonSchema');
});

test('P2-6b: a category-selection schema is defined for the prefilter', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ai/ai.js'), 'utf8');
    const body = preFilterBody(src);
    assert(/categorySelectionSchema\s*=\s*\{/.test(body), 'categorySelectionSchema defined');
    assert(/categories/.test(body), 'schema names the categories array (matches BUG-027 unwrap)');
    assert(/strict:\s*true/.test(body), 'schema is strict (mirrors lorebookSelectionSchema)');
});

test('P2-6c: disableThinkingOnClaude still set (null-fallback safety preserved)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/ai/ai.js'), 'utf8');
    const body = preFilterBody(src);
    assert(/disableThinkingOnClaude:\s*true/.test(body), 'disableThinkingOnClaude kept');
    // Null-fallback path intact: parse-fail still returns null and widens.
    const fullSrc = readFileSync(join(REPO_ROOT, 'src/ai/ai.js'), 'utf8');
    assert(/if \(!parsed\) \{ _releaseProbeOnce\(\); return null; \}/.test(fullSrc),
        'parse-fail null fallback preserved');
});

await summary('Audit-Fix Vault Tests');
