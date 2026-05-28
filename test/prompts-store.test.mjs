/**
 * DeepLore Enhanced — Pure helpers + runtime resolver tests for the
 * editable-prompts subsystem.
 *
 * Covers:
 *   - parsePromptFile()        — frontmatter + body extraction
 *   - extractPlaceholders()    — `${N}` marker scan
 *   - placeholderSetsEqual()
 *   - validatePromptShape()    — Q4 strict rules (R1 key, R2 no lorebook-, R3 placeholder parity)
 *   - computePromptStatus()    — Q11 A+ 4-state state machine
 *   - buildPromptFileContent() — round-trip with parsePromptFile()
 *   - promptHash()             — stability + length-prefix shape
 *   - getPrompt()              — sync cache hit + fallback
 *   - loadPrompts() / reloadPrompts() — cache rebuild, status grid
 *
 * Run with: node test/prompts-store.test.mjs
 */

import { passed, failed, resetCounters, assert, assertEqual } from './helpers.mjs';

import * as PromptsEn from '../src/i18n/prompts/en.js';
import {
    parsePromptFile,
    extractPlaceholders,
    placeholderSetsEqual,
    validatePromptShape,
    computePromptStatus,
    buildPromptFileContent,
    promptHash,
} from '../src/prompts/prompt-store-pure.js';
import {
    getPrompt,
    loadPrompts,
    reloadPrompts,
    getPromptStatusGrid,
    _resetPromptStoreForTests,
    _isLoadedForTests,
    _getMetaForTests,
} from '../src/prompts/prompt-store.js';
import { KNOWN_PROMPT_KEYS } from '../src/prompts/prompt-validators.js';

resetCounters();

// ════════════════════════════════════════════════════════════════════════════
// promptHash — stability
// ════════════════════════════════════════════════════════════════════════════

assertEqual(promptHash('hello'), promptHash('hello'), 'promptHash: same input → same output');
assert(promptHash('hello') !== promptHash('hello.'), 'promptHash: different input → different output');
assert(typeof promptHash('x') === 'string' && promptHash('x').length > 0, 'promptHash: returns non-empty string');
assertEqual(promptHash(''), promptHash(null), 'promptHash: null and empty equivalent');

// ════════════════════════════════════════════════════════════════════════════
// extractPlaceholders
// ════════════════════════════════════════════════════════════════════════════

assertEqual([...extractPlaceholders('no placeholders')], [], 'extract: empty result for plain text');
assertEqual([...extractPlaceholders('one ${0} marker')], ['${0}'], 'extract: single marker');
{
    const set = extractPlaceholders('${0} and ${1} and ${0} again');
    assert(set.size === 2 && set.has('${0}') && set.has('${1}'), 'extract: deduped multi-marker');
}
assertEqual([...extractPlaceholders('${name} is named not indexed')], [], 'extract: named placeholders ignored');
assertEqual([...extractPlaceholders(null)], [], 'extract: null input safe');
assertEqual([...extractPlaceholders(undefined)], [], 'extract: undefined input safe');
assertEqual([...extractPlaceholders(42)], [], 'extract: non-string safe');

// AGENTIC_TOOLS_INTRO from real EN dict
{
    const set = extractPlaceholders(PromptsEn.AGENTIC_TOOLS_INTRO);
    assert(set.has('${0}') && set.has('${1}'), 'extract: real AGENTIC_TOOLS_INTRO has both markers');
}

// ════════════════════════════════════════════════════════════════════════════
// placeholderSetsEqual
// ════════════════════════════════════════════════════════════════════════════

assert(placeholderSetsEqual(new Set(), new Set()) === true, 'sets equal: both empty');
assert(placeholderSetsEqual(new Set(['${0}']), new Set(['${0}'])) === true, 'sets equal: same single');
assert(placeholderSetsEqual(new Set(['${0}', '${1}']), new Set(['${1}', '${0}'])) === true, 'sets equal: order-independent');
assert(placeholderSetsEqual(new Set(['${0}']), new Set(['${1}'])) === false, 'sets unequal: different markers');
assert(placeholderSetsEqual(new Set(['${0}']), new Set(['${0}', '${1}'])) === false, 'sets unequal: size differs');

// ════════════════════════════════════════════════════════════════════════════
// parsePromptFile — happy path + error cases
// ════════════════════════════════════════════════════════════════════════════

{
    const raw = `---
key: SCRIBE_PROMPT
locale: en
source_hash: abc123
---

Body text here.`;
    const result = parsePromptFile(raw);
    assert(result.ok === true, 'parse: valid file');
    if (result.ok) {
        assertEqual(result.frontmatter.key, 'SCRIBE_PROMPT', 'parse: key extracted');
        assertEqual(result.frontmatter.locale, 'en', 'parse: locale extracted');
        assert(result.body.includes('Body text here.'), 'parse: body extracted');
    }
}

assert(parsePromptFile('').ok === false, 'parse: empty string fails');
assert(parsePromptFile('   ').ok === false, 'parse: whitespace fails');
assert(parsePromptFile(null).ok === false, 'parse: null fails');
assert(parsePromptFile(42).ok === false, 'parse: non-string fails');
assert(parsePromptFile('no frontmatter just body').ok === false, 'parse: missing frontmatter fails');
assert(parsePromptFile('---\nlocale: en\n---\nbody').ok === false, 'parse: missing key field fails');
assert(parsePromptFile('---\nkey: X\n---\n').ok === false, 'parse: empty body fails');
assert(parsePromptFile('---\nkey: \n---\nbody').ok === false, 'parse: empty key value fails');

// ════════════════════════════════════════════════════════════════════════════
// validatePromptShape — R1 key, R2 lorebook tag, R3 placeholder parity
// ════════════════════════════════════════════════════════════════════════════

{
    const parsed = { frontmatter: { key: 'SCRIBE_PROMPT' }, body: 'Plain prompt text.' };
    const canonical = 'Plain prompt text.';
    const result = validatePromptShape(parsed, canonical, 'SCRIBE_PROMPT');
    assert(result.ok === true, 'validate: clean override passes');
}

{
    // R1 — key mismatch
    const parsed = { frontmatter: { key: 'SOMETHING_ELSE' }, body: 'Text.' };
    const result = validatePromptShape(parsed, 'Text.', 'SCRIBE_PROMPT');
    assert(result.ok === false && /key.*does not match/.test(result.reason), 'validate: R1 key mismatch rejected');
}

{
    // R2 — body has lorebook- tag
    const parsed = { frontmatter: { key: 'X' }, body: 'I have lorebook-always in me' };
    const result = validatePromptShape(parsed, 'I have lorebook-always in me', 'X');
    assert(result.ok === false && /lorebook-/.test(result.reason), 'validate: R2 lorebook- tag rejected');
}

{
    // R2 case-insensitive
    const parsed = { frontmatter: { key: 'X' }, body: 'Lorebook-Always present' };
    const result = validatePromptShape(parsed, 'Lorebook-Always present', 'X');
    assert(result.ok === false, 'validate: R2 case-insensitive');
}

{
    // R3 — missing placeholder
    const parsed = { frontmatter: { key: 'X' }, body: 'Has ${0} only' };
    const canonical = 'Has ${0} and ${1}';
    const result = validatePromptShape(parsed, canonical, 'X');
    assert(result.ok === false && /missing/.test(result.reason), 'validate: R3 missing placeholder rejected');
}

{
    // R3 — extra placeholder
    const parsed = { frontmatter: { key: 'X' }, body: 'Has ${0} and ${1} and ${2}' };
    const canonical = 'Has ${0} and ${1}';
    const result = validatePromptShape(parsed, canonical, 'X');
    assert(result.ok === false && /extra/.test(result.reason), 'validate: R3 extra placeholder rejected');
}

{
    // R3 — order-independent
    const parsed = { frontmatter: { key: 'X' }, body: '${1} then ${0}' };
    const canonical = '${0} then ${1}';
    const result = validatePromptShape(parsed, canonical, 'X');
    assert(result.ok === true, 'validate: R3 order-independent');
}

assert(validatePromptShape(null, 'x', 'X').ok === false, 'validate: null parsed rejected');
assert(validatePromptShape({}, 'x', 'X').ok === false, 'validate: missing frontmatter/body rejected');

// ════════════════════════════════════════════════════════════════════════════
// computePromptStatus — 4-state machine + edges
// ════════════════════════════════════════════════════════════════════════════

assertEqual(
    computePromptStatus({ bodyHash: 'A', sourceHash: 'A', canonicalHash: 'A' }),
    'current_default',
    'status: untouched + current = current_default',
);

assertEqual(
    computePromptStatus({ bodyHash: 'A', sourceHash: 'A', canonicalHash: 'B' }),
    'stale_default',
    'status: untouched + upstream moved = stale_default',
);

assertEqual(
    computePromptStatus({ bodyHash: 'B', sourceHash: 'A', canonicalHash: 'A' }),
    'customized',
    'status: edited + current baseline = customized',
);

assertEqual(
    computePromptStatus({ bodyHash: 'C', sourceHash: 'A', canonicalHash: 'B' }),
    'customized_stale_baseline',
    'status: edited + stale baseline = customized_stale_baseline',
);

assertEqual(
    computePromptStatus({ bodyHash: null, sourceHash: null, canonicalHash: null }),
    'missing',
    'status: nothing = missing',
);

assertEqual(
    computePromptStatus({ bodyHash: 'X', sourceHash: null, canonicalHash: 'X' }),
    'current_default',
    'status: no source_hash + match canonical = current_default',
);

assertEqual(
    computePromptStatus({ bodyHash: 'X', sourceHash: null, canonicalHash: 'Y' }),
    'customized',
    'status: no source_hash + differ canonical = customized',
);

assertEqual(
    computePromptStatus({ bodyHash: 'X', sourceHash: 'X', canonicalHash: null }),
    'customized',
    'status: canonical missing → customized (orphan key)',
);

// ════════════════════════════════════════════════════════════════════════════
// buildPromptFileContent + round-trip
// ════════════════════════════════════════════════════════════════════════════

{
    const content = buildPromptFileContent({
        key: 'SCRIBE_PROMPT',
        locale: 'en',
        value: PromptsEn.SCRIBE_PROMPT,
    });
    assert(content.startsWith('---\n'), 'build: starts with frontmatter');
    assert(content.includes('key: SCRIBE_PROMPT'), 'build: emits key field');
    assert(content.includes('locale: en'), 'build: emits locale field');
    assert(content.includes('source_hash:'), 'build: emits source_hash field');
    assert(content.endsWith('\n'), 'build: trailing newline');

    const parsed = parsePromptFile(content);
    assert(parsed.ok === true, 'round-trip: re-parses cleanly');
    if (parsed.ok) {
        assertEqual(parsed.frontmatter.key, 'SCRIBE_PROMPT', 'round-trip: key preserved');
        assertEqual(parsed.frontmatter.locale, 'en', 'round-trip: locale preserved');
        // Body should match canonical (modulo possible trailing whitespace).
        assert(parsed.body.trim() === PromptsEn.SCRIBE_PROMPT.trim(), 'round-trip: body preserved');
    }
}

{
    // Build for a prompt with placeholders → expect placeholders: block scalar
    const content = buildPromptFileContent({
        key: 'AGENTIC_TOOLS_INTRO',
        locale: 'en',
        value: PromptsEn.AGENTIC_TOOLS_INTRO,
        placeholderDocs: { '${0}': 'tool count', '${1}': 'plural suffix' },
    });
    assert(content.includes('placeholders: |'), 'build: emits placeholders block for interpolated prompt');
    assert(content.includes('${0} = tool count'), 'build: emits per-placeholder doc');
    assert(content.includes('${1} = plural suffix'), 'build: emits second placeholder doc');
}

{
    // Build for plain prompt (no placeholders) → no placeholders block
    const content = buildPromptFileContent({
        key: 'SCRIBE_PROMPT',
        locale: 'en',
        value: 'Just plain text.',
    });
    assert(!content.includes('placeholders:'), 'build: omits placeholders block when none present');
}

// Build throws on bad input
{
    let threw = false;
    try { buildPromptFileContent({ key: '', locale: 'en', value: 'x' }); } catch { threw = true; }
    assert(threw, 'build: throws on empty key');
}
{
    let threw = false;
    try { buildPromptFileContent({ key: 'X', locale: '', value: 'x' }); } catch { threw = true; }
    assert(threw, 'build: throws on empty locale');
}
{
    let threw = false;
    try { buildPromptFileContent({ key: 'X', locale: 'en', value: 42 }); } catch { threw = true; }
    assert(threw, 'build: throws on non-string value');
}

// ════════════════════════════════════════════════════════════════════════════
// Round-trip: build a vault file, parse it, validate against canonical — pass
// ════════════════════════════════════════════════════════════════════════════

{
    const content = buildPromptFileContent({
        key: 'AGENTIC_TOOLS_INTRO',
        locale: 'en',
        value: PromptsEn.AGENTIC_TOOLS_INTRO,
    });
    const parsed = parsePromptFile(content);
    assert(parsed.ok === true, 'full round-trip: parse OK');
    if (parsed.ok) {
        const validation = validatePromptShape(parsed, PromptsEn.AGENTIC_TOOLS_INTRO, 'AGENTIC_TOOLS_INTRO');
        assert(validation.ok === true, 'full round-trip: validation OK against canonical');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Runtime: getPrompt() before load — falls back to compiled-in EN
// ════════════════════════════════════════════════════════════════════════════

_resetPromptStoreForTests();
assert(_isLoadedForTests() === false, 'runtime: pre-load, _loaded is false');

// getPrompt before load works via PromptsEn fallback
{
    const value = getPrompt('SCRIBE_PROMPT');
    assertEqual(value, PromptsEn.SCRIBE_PROMPT, 'runtime: getPrompt pre-load falls back to compiled-in EN');
}

assertEqual(getPrompt(''), '', 'runtime: getPrompt empty key returns empty');
assertEqual(getPrompt(null), '', 'runtime: getPrompt null key returns empty');
assertEqual(getPrompt('UNKNOWN_KEY_NEVER_EXISTED'), '', 'runtime: getPrompt unknown key returns empty');

// ════════════════════════════════════════════════════════════════════════════
// Runtime: loadPrompts() populates cache from compiled-in dict
// ════════════════════════════════════════════════════════════════════════════

{
    const result = await loadPrompts('en');
    assert(_isLoadedForTests() === true, 'runtime: post-load, _loaded is true');
    assertEqual(result.source, 'compiled-in', 'runtime: load reports compiled-in source');
    assert(result.loaded === KNOWN_PROMPT_KEYS.size, `runtime: load reports ${KNOWN_PROMPT_KEYS.size} keys (got ${result.loaded})`);
}

// Every known key resolves from cache after load
for (const key of KNOWN_PROMPT_KEYS) {
    const value = getPrompt(key);
    assertEqual(value, PromptsEn[key], `runtime: getPrompt("${key}") matches EN dict post-load`);
}

// Status grid has all known keys, all marked current_default
{
    const grid = getPromptStatusGrid();
    assertEqual(grid.length, KNOWN_PROMPT_KEYS.size, 'runtime: status grid covers all known keys');
    for (const row of grid) {
        assertEqual(row.source, 'compiled-in', `runtime: ${row.key} sourced from compiled-in`);
        assertEqual(row.status, 'current_default', `runtime: ${row.key} status = current_default`);
        assert(row.error === null, `runtime: ${row.key} has no error`);
    }
}

// Meta entries include hashes
{
    const meta = _getMetaForTests('SCRIBE_PROMPT');
    assert(meta && typeof meta.bodyHash === 'string', 'runtime: meta.bodyHash populated');
    assertEqual(meta.bodyHash, promptHash(PromptsEn.SCRIBE_PROMPT), 'runtime: meta.bodyHash matches hash of EN value');
    assertEqual(meta.canonicalHash, meta.bodyHash, 'runtime: compiled-in canonical and body hash equal');
}

// ════════════════════════════════════════════════════════════════════════════
// Runtime: reloadPrompts() rebuilds cache idempotently
// ════════════════════════════════════════════════════════════════════════════

{
    const before = getPromptStatusGrid().length;
    const result = await reloadPrompts();
    const after = getPromptStatusGrid().length;
    assertEqual(after, before, 'runtime: reload preserves grid size');
    assertEqual(result.source, 'compiled-in', 'runtime: reload reports compiled-in (no vault yet)');
}

// ════════════════════════════════════════════════════════════════════════════
// Locale fallback — switching to a locale where a key is missing falls back to EN
// ════════════════════════════════════════════════════════════════════════════

// Confirmed by loading 'es-es' or another locale; if a key happens to be missing,
// PromptsEn[key] is used. This is hardcoded into loadPrompts. Sanity check:
{
    await loadPrompts('es-es');
    for (const key of KNOWN_PROMPT_KEYS) {
        const value = getPrompt(key);
        assert(typeof value === 'string' && value.length > 0, `locale fallback: ${key} resolves to non-empty string under es-es`);
    }
}

// Reset for downstream tests
_resetPromptStoreForTests();

// ════════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`  Prompts store + pure helpers: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════════');

if (failed > 0) {
    process.exit(1);
}
