/**
 * DeepLore Enhanced — Prompt I/O cage L4 + structural L6 tests.
 *
 * Network-level behavior of the I/O wrappers (writePromptFile,
 * fetchPromptFile, listPromptsFolder, deletePromptFile) requires a live
 * Obsidian REST API and is covered by manual smoke tests after merge.
 *
 * This file covers what can be unit-tested without HTTP:
 *
 *   L4 (pre-flight check) — pure `verifyPromptFileForDeletion()` helper:
 *     - frontmatter `key:` must match validated stem
 *     - body must not contain a `lorebook-` tag
 *     - malformed prompt files refused
 *
 *   L6 (structural) — codebase scan: exactly one site issues HTTP DELETE
 *     against the Obsidian REST API, and it's `deletePromptFile()` in
 *     `src/prompts/prompt-api.js`.
 *
 *   Module surface — exported helpers, default constants, no accidental
 *     re-export of a generic `deleteNote()` from `obsidian-api.js`.
 *
 * Run with: node test/prompts-api.test.mjs
 */

import { passed, failed, resetCounters, assert, assertEqual } from './helpers.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPromptFileForDeletion } from '../src/prompts/prompt-store-pure.js';
import {
    deletePromptFile,
    writePromptFile,
    fetchPromptFile,
    listPromptsFolder,
    DLE_PROMPTS_DEFAULT_DIR,
    DLE_PROMPTS_LIST_LIMIT,
    DLE_PROMPTS_MAX_FILE_BYTES,
} from '../src/prompts/prompt-api.js';
import * as ObsidianApi from '../src/vault/obsidian-api.js';

resetCounters();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ════════════════════════════════════════════════════════════════════════════
// L4 — verifyPromptFileForDeletion: happy path
// ════════════════════════════════════════════════════════════════════════════

{
    const raw = `---
key: SCRIBE_PROMPT
locale: en
source_hash: abc
---

Summarize this segment.
`;
    const result = verifyPromptFileForDeletion(raw, 'SCRIBE_PROMPT');
    assert(result.ok === true, 'L4: valid file + matching stem passes');
}

// ════════════════════════════════════════════════════════════════════════════
// L4.R1 — frontmatter key mismatch refused
// ════════════════════════════════════════════════════════════════════════════

{
    const raw = `---
key: SOMETHING_ELSE
locale: en
---

Body.
`;
    const result = verifyPromptFileForDeletion(raw, 'SCRIBE_PROMPT');
    assert(result.ok === false, 'L4.R1: key mismatch refused');
    assert(/does not match/.test(result.reason), 'L4.R1: refusal reason mentions mismatch');
}

// ════════════════════════════════════════════════════════════════════════════
// L4.R2 — body containing lorebook- tag refused (looks like a vault entry)
// ════════════════════════════════════════════════════════════════════════════

{
    const raw = `---
key: SCRIBE_PROMPT
locale: en
---

This entry uses #lorebook-always for unconditional injection.
`;
    const result = verifyPromptFileForDeletion(raw, 'SCRIBE_PROMPT');
    assert(result.ok === false, 'L4.R2: lorebook- tag refused');
    assert(/lorebook/i.test(result.reason), 'L4.R2: refusal reason mentions lorebook');
}

// Case-insensitive
{
    const raw = `---
key: SCRIBE_PROMPT
locale: en
---

Body uses #LOREBOOK-NEVER somewhere.
`;
    const result = verifyPromptFileForDeletion(raw, 'SCRIBE_PROMPT');
    assert(result.ok === false, 'L4.R2: case-insensitive lorebook- refused');
}

// Other variants of "lorebook-" prefix
for (const variant of ['lorebook-always', 'lorebook-never', 'lorebook-seed', 'lorebook-bootstrap', 'lorebook-guide']) {
    const raw = `---
key: SCRIBE_PROMPT
locale: en
---

I contain #${variant} as a tag.
`;
    const result = verifyPromptFileForDeletion(raw, 'SCRIBE_PROMPT');
    assert(result.ok === false, `L4.R2: ${variant} refused`);
}

// ════════════════════════════════════════════════════════════════════════════
// L4 — malformed prompt files refused
// ════════════════════════════════════════════════════════════════════════════

assert(verifyPromptFileForDeletion('', 'X').ok === false, 'L4: empty refused');
assert(verifyPromptFileForDeletion('no frontmatter just body', 'X').ok === false, 'L4: no frontmatter refused');
assert(verifyPromptFileForDeletion('---\nlocale: en\n---\nbody', 'X').ok === false, 'L4: missing key field refused');
assert(verifyPromptFileForDeletion(null, 'X').ok === false, 'L4: null refused');
assert(verifyPromptFileForDeletion(42, 'X').ok === false, 'L4: non-string refused');

// ════════════════════════════════════════════════════════════════════════════
// L4 — file with valid prompt structure but stem mismatch
// (e.g. attacker placed a fake-prompt file with a different key in frontmatter)
// ════════════════════════════════════════════════════════════════════════════

{
    // Imagine a malicious file `SCRIBE_PROMPT.md` whose frontmatter says
    // `key: EMMA_FIRSTRUN_GREETING` — different from filename. Caller passes
    // validatedStem = 'SCRIBE_PROMPT'. Must refuse.
    const raw = `---
key: EMMA_FIRSTRUN_GREETING
locale: en
---

Body that looks legit.
`;
    const result = verifyPromptFileForDeletion(raw, 'SCRIBE_PROMPT');
    assert(result.ok === false, 'L4: frontmatter-vs-filename mismatch attack refused');
}

// ════════════════════════════════════════════════════════════════════════════
// Module surface — exports + constants present, no leaking helpers
// ════════════════════════════════════════════════════════════════════════════

assert(typeof deletePromptFile === 'function', 'export: deletePromptFile is a function');
assert(typeof writePromptFile === 'function', 'export: writePromptFile is a function');
assert(typeof fetchPromptFile === 'function', 'export: fetchPromptFile is a function');
assert(typeof listPromptsFolder === 'function', 'export: listPromptsFolder is a function');
assertEqual(DLE_PROMPTS_DEFAULT_DIR, 'DeepLore/prompts/', 'export: DLE_PROMPTS_DEFAULT_DIR matches Q2 default');
assert(typeof DLE_PROMPTS_LIST_LIMIT === 'number' && DLE_PROMPTS_LIST_LIMIT > 0, 'export: DLE_PROMPTS_LIST_LIMIT positive number');
assert(typeof DLE_PROMPTS_MAX_FILE_BYTES === 'number' && DLE_PROMPTS_MAX_FILE_BYTES > 0, 'export: DLE_PROMPTS_MAX_FILE_BYTES positive number');

// L6 — there must NOT be a generic deleteNote export anywhere in obsidian-api.js.
assert(typeof ObsidianApi.deleteNote === 'undefined', 'L6: obsidian-api.js does NOT export a generic deleteNote');
assert(typeof ObsidianApi.deleteFile === 'undefined', 'L6: obsidian-api.js does NOT export a generic deleteFile');

// ════════════════════════════════════════════════════════════════════════════
// L1+L2 cage refuses bad input on every I/O function — no HTTP call attempted.
// We exercise this with paths/keys that would fail cage even before reaching
// the network layer. Functions must return { ok: false } synchronously-ish
// (after awaiting the path validation only).
// ════════════════════════════════════════════════════════════════════════════

{
    const result = await deletePromptFile('127.0.0.1', 27123, 'fake', '', 'SCRIBE_PROMPT');
    assert(result.ok === false, 'cage: deletePromptFile refuses empty prefix');
}

{
    const result = await deletePromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', 'README');
    assert(result.ok === false, 'cage: deletePromptFile refuses unknown stem');
}

{
    const result = await deletePromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', '../etc/passwd');
    assert(result.ok === false, 'cage: deletePromptFile refuses traversal');
}

{
    const result = await deletePromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', null);
    assert(result.ok === false, 'cage: deletePromptFile refuses null key');
}

{
    const result = await writePromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', 'README', 'body');
    assert(result.ok === false, 'cage: writePromptFile refuses unknown stem');
}

{
    const result = await writePromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', 'SCRIBE_PROMPT', 'A'.repeat(DLE_PROMPTS_MAX_FILE_BYTES + 1));
    assert(result.ok === false, 'cage: writePromptFile refuses too-large content');
}

{
    const result = await writePromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', 'SCRIBE_PROMPT', 42);
    assert(result.ok === false, 'cage: writePromptFile refuses non-string content');
}

{
    const result = await fetchPromptFile('127.0.0.1', 27123, 'fake', 'DeepLore/prompts/', 'README');
    assert(result.ok === false, 'cage: fetchPromptFile refuses unknown stem');
}

{
    const result = await listPromptsFolder('127.0.0.1', 27123, 'fake', '../bad');
    assert(result.ok === false, 'cage: listPromptsFolder refuses traversal prefix');
}

{
    const result = await listPromptsFolder('127.0.0.1', 27123, 'fake', null);
    assert(result.ok === false, 'cage: listPromptsFolder refuses null prefix');
}

// ════════════════════════════════════════════════════════════════════════════
// L6 STRUCTURAL — exactly one occurrence of `method: 'DELETE'` in src/.
// Anyone adding a new DELETE call to the codebase must edit prompt-api.js,
// preserving cage discipline. This test makes that contract explicit.
// ════════════════════════════════════════════════════════════════════════════

function collectJsFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.git')) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) results.push(...collectJsFiles(full));
        else if (entry.endsWith('.js') || entry.endsWith('.mjs')) results.push(full);
    }
    return results;
}

// Strip JS comments before scanning so DELETE mentioned in docstrings doesn't
// count. Two passes: block comments (/* ... */) then line comments (// ...).
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const srcFiles = collectJsFiles(join(ROOT, 'src'));
const deleteRe = /method\s*:\s*['"]DELETE['"]/g;
const deleteCallSites = [];
for (const file of srcFiles) {
    const content = stripComments(readFileSync(file, 'utf8'));
    const matches = content.match(deleteRe);
    if (matches && matches.length > 0) {
        deleteCallSites.push({ file: file.replace(ROOT, '').replace(/\\/g, '/'), count: matches.length });
    }
}

assertEqual(deleteCallSites.length, 1, 'L6: exactly one file in src/ contains an HTTP DELETE call');
if (deleteCallSites.length === 1) {
    assert(
        deleteCallSites[0].file.endsWith('/prompts/prompt-api.js'),
        `L6: the sole DELETE site is prompt-api.js (got ${deleteCallSites[0].file})`,
    );
    assertEqual(deleteCallSites[0].count, 1, 'L6: prompt-api.js contains exactly one DELETE call');
}

// And the DLE_DELETE_PRIMITIVE marker comment is present in prompt-api.js.
{
    const content = readFileSync(join(ROOT, 'src/prompts/prompt-api.js'), 'utf8');
    assert(content.includes('DLE_DELETE_PRIMITIVE'), 'L6: prompt-api.js has the DLE_DELETE_PRIMITIVE comment-tag');
}

// ════════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`  Prompts I/O cage L4 + L6: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════════');

if (failed > 0) {
    process.exit(1);
}
