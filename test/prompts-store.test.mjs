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
    buildPromptOverlay,
    normalizePromptBody,
    promptHash,
} from '../src/prompts/prompt-store-pure.js';
import {
    getPrompt,
    loadPrompts,
    reloadPrompts,
    getPromptStatusGrid,
    getLastLoadErrors,
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
// normalizePromptBody — strips shim newlines, preserves real content
// ════════════════════════════════════════════════════════════════════════════

assertEqual(normalizePromptBody('\nBody\n'), 'Body', 'normalize: strips leading + trailing newlines');
assertEqual(normalizePromptBody('Body'), 'Body', 'normalize: no-op on plain string');
assertEqual(normalizePromptBody('\r\nBody\r\n'), 'Body', 'normalize: handles CRLF');
assertEqual(normalizePromptBody('\n\nBody\n\n'), '\nBody', 'normalize: strips only one leading newline');
assertEqual(normalizePromptBody(''), '', 'normalize: empty stays empty');
assertEqual(normalizePromptBody(null), '', 'normalize: null returns empty');
assertEqual(normalizePromptBody('Body with spaces and newlines\n\t  '), 'Body with spaces and newlines', 'normalize: trims all trailing whitespace');

// ════════════════════════════════════════════════════════════════════════════
// buildPromptOverlay — pure overlay merge
// ════════════════════════════════════════════════════════════════════════════

// Case 1 — empty overrides → all entries use compiled-in
{
    const overrides = new Map();
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    assertEqual(result.errors.length, 0, 'overlay: no errors with empty overrides');
    assertEqual(result.resolved.size, KNOWN_PROMPT_KEYS.size, 'overlay: all keys resolved');
    let allCompiledIn = true;
    for (const m of result.meta.values()) {
        if (m.source !== 'compiled-in') { allCompiledIn = false; break; }
    }
    assert(allCompiledIn, 'overlay: every entry sourced from compiled-in');
}

// Case 2 — valid override for one key, unchanged content → status = current_default
{
    const key = 'SCRIBE_PROMPT';
    const fileContent = buildPromptFileContent({
        key,
        locale: 'en',
        value: PromptsEn.SCRIBE_PROMPT,
    });
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    assertEqual(result.errors.length, 0, 'overlay: no errors on unedited override');
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'vault', 'overlay: override key sourced from vault');
    assertEqual(meta.status, 'current_default', 'overlay: unedited override → current_default');
    assertEqual(meta.bodyHash, meta.canonicalHash, 'overlay: body hash == canonical hash');
}

// Case 3 — user-edited override → status = customized
{
    const key = 'SCRIBE_PROMPT';
    const sourceHash = promptHash(normalizePromptBody(PromptsEn.SCRIBE_PROMPT));
    // Edit the body, keep source_hash matching original (which is the case after
    // a fresh export → user edits but doesn't touch frontmatter)
    const fileContent = `---
key: ${key}
locale: en
source_hash: ${sourceHash}
---

I'm a custom version of the scribe prompt.`;
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    assertEqual(result.errors.length, 0, 'overlay: no errors on edited override');
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'vault', 'overlay: customized key from vault');
    assertEqual(meta.status, 'customized', 'overlay: edited override → customized');
    assert(meta.bodyHash !== meta.canonicalHash, 'overlay: body hash differs from canonical');
}

// Case 4 — stale default (untouched but upstream moved)
{
    const key = 'SCRIBE_PROMPT';
    const oldCanonical = 'OLD canonical text that has since been replaced.';
    const oldHash = promptHash(normalizePromptBody(oldCanonical));
    const fileContent = `---
key: ${key}
locale: en
source_hash: ${oldHash}
---

${oldCanonical}`;
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'vault', 'overlay: stale-default still sourced from vault');
    assertEqual(meta.status, 'stale_default', 'overlay: body == source != canonical → stale_default');
}

// Case 5 — customized + stale baseline (edited + upstream moved)
{
    const key = 'SCRIBE_PROMPT';
    const oldHash = 'old_baseline_hash_xyz';
    const fileContent = `---
key: ${key}
locale: en
source_hash: ${oldHash}
---

User's edited version of an old baseline.`;
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    const meta = result.meta.get(key);
    assertEqual(meta.status, 'customized_stale_baseline', 'overlay: edited + old hash → customized_stale_baseline');
}

// Case 6 — broken override (parse fail) → fall back to compiled-in + error
{
    const key = 'SCRIBE_PROMPT';
    const fileContent = 'not a valid prompt file';
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'compiled-in', 'overlay: parse-fail falls back to compiled-in');
    assert(meta.error !== null, 'overlay: parse-fail records error');
    assert(result.errors.some(e => e.key === key), 'overlay: errors array contains parse-fail key');
    assertEqual(result.resolved.get(key), PromptsEn.SCRIBE_PROMPT, 'overlay: resolved value is compiled-in canonical');
}

// Case 7 — placeholder mismatch (R3) → fall back + error
{
    const key = 'AGENTIC_TOOLS_INTRO';
    const fileContent = `---
key: ${key}
locale: en
---

You have tools available:`; // missing ${0} and ${1}
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'compiled-in', 'overlay: placeholder mismatch falls back');
    assert(/placeholder/.test(meta.error || ''), 'overlay: placeholder error recorded');
}

// Case 8 — frontmatter key mismatch (R1) → fall back + error
{
    const key = 'SCRIBE_PROMPT';
    const fileContent = `---
key: WRONG_KEY
locale: en
---

Body that's otherwise fine.`;
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'compiled-in', 'overlay: key mismatch falls back');
    assert(/does not match/.test(meta.error || ''), 'overlay: key-mismatch error recorded');
}

// Case 9 — lorebook- tag in body (R2) → fall back + error
{
    const key = 'SCRIBE_PROMPT';
    const fileContent = `---
key: SCRIBE_PROMPT
locale: en
---

Body uses lorebook-always tag accidentally.`;
    const overrides = new Map([[key, fileContent]]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    const meta = result.meta.get(key);
    assertEqual(meta.source, 'compiled-in', 'overlay: lorebook- tag falls back');
    assert(/lorebook/i.test(meta.error || ''), 'overlay: lorebook-tag error recorded');
}

// Case 10 — multiple overrides, mixed valid/invalid
{
    const valid = buildPromptFileContent({
        key: 'SCRIBE_PROMPT',
        locale: 'en',
        value: 'Custom scribe prose.',
    });
    const invalid = 'garbage';
    const overrides = new Map([
        ['SCRIBE_PROMPT', valid],
        ['AI_NOTEPAD_PROMPT', invalid],
    ]);
    const result = buildPromptOverlay(PromptsEn, overrides, KNOWN_PROMPT_KEYS, PromptsEn);
    assertEqual(result.meta.get('SCRIBE_PROMPT').source, 'vault', 'overlay mixed: valid override from vault');
    assertEqual(result.meta.get('AI_NOTEPAD_PROMPT').source, 'compiled-in', 'overlay mixed: invalid falls back');
    assertEqual(result.errors.length, 1, 'overlay mixed: one error reported');
    assertEqual(result.errors[0].key, 'AI_NOTEPAD_PROMPT', 'overlay mixed: correct key in errors');
}

// ════════════════════════════════════════════════════════════════════════════
// Runtime: loadPrompts with no connection still works (commit 2 behavior)
// ════════════════════════════════════════════════════════════════════════════

_resetPromptStoreForTests();
{
    const result = await loadPrompts('en');
    assertEqual(result.source, 'compiled-in', 'loadPrompts(no connection): source = compiled-in');
    assertEqual(result.vaultCount, 0, 'loadPrompts(no connection): vaultCount = 0');
    assertEqual(result.errors.length, 0, 'loadPrompts(no connection): no errors');
}

// ════════════════════════════════════════════════════════════════════════════
// Runtime: loadPrompts with malformed/incomplete connection treated as no-connection
// ════════════════════════════════════════════════════════════════════════════

_resetPromptStoreForTests();
{
    // Missing apiKey → treated as no connection (skipped silently).
    const result = await loadPrompts('en', { host: '127.0.0.1', port: 27123 });
    assertEqual(result.source, 'compiled-in', 'loadPrompts(missing apiKey): compiled-in fallback');
    assertEqual(result.vaultCount, 0, 'loadPrompts(missing apiKey): no vault count');
}

// getLastLoadErrors snapshot starts empty after reset+load
assertEqual(getLastLoadErrors().length, 0, 'runtime: getLastLoadErrors empty after clean load');

// Reset for next test
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
