/**
 * DeepLore Enhanced — Delete cage TDD safety tests.
 *
 * Validates `src/prompts/prompt-validators.js`. Every cage check has dedicated
 * failing-input tests written BEFORE implementation. User vault deletion is
 * the single biggest failure mode DLE can have — these tests treat it as
 * medical equipment.
 *
 * Run with: node test/prompts-delete-safety.test.mjs
 */

import { passed, failed, resetCounters, assert, assertEqual } from './helpers.mjs';

import {
    KNOWN_PROMPT_KEYS,
    ACCEPTED_PROMPT_KEYS,
    MAX_PROMPT_PATH_LENGTH,
    sanitizePromptsFolderPath,
    validatePromptDeletePath,
    checkPathIsNonEmptyString,
    checkPathStartsWithPrefix,
    checkPathEndsWithMd,
    checkPathHasNoTraversal,
    checkPathHasNoDoubleSlash,
    checkPathHasNoAbsolutePrefix,
    checkPathHasNoUrlEncoding,
    checkPathIsFlatFile,
    checkPathStemShape,
    checkPathLength,
    checkStemIsAcceptedKey,
} from '../src/prompts/prompt-validators.js';

resetCounters();

const PREFIX = 'DeepLore/prompts/';

// Pick a known prompt key to use across "should accept" tests. Anchored to
// the canonical EN dict — if the export ever disappears, this test file will
// pick a different one automatically.
const KNOWN_KEY = KNOWN_PROMPT_KEYS.has('SCRIBE_PROMPT')
    ? 'SCRIBE_PROMPT'
    : [...KNOWN_PROMPT_KEYS][0];

assert(KNOWN_KEY && KNOWN_PROMPT_KEYS.size > 0, 'KNOWN_PROMPT_KEYS is populated from en.js');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.1 — non-empty trimmed string
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathIsNonEmptyString('foo.md').ok === true, 'L1.1 accepts non-empty string');
assert(checkPathIsNonEmptyString('').ok === false, 'L1.1 rejects empty string');
assert(checkPathIsNonEmptyString('   ').ok === false, 'L1.1 rejects whitespace-only string');
assert(checkPathIsNonEmptyString(null).ok === false, 'L1.1 rejects null');
assert(checkPathIsNonEmptyString(undefined).ok === false, 'L1.1 rejects undefined');
assert(checkPathIsNonEmptyString(123).ok === false, 'L1.1 rejects number');
assert(checkPathIsNonEmptyString({}).ok === false, 'L1.1 rejects object');
assert(checkPathIsNonEmptyString([]).ok === false, 'L1.1 rejects array');
assert(checkPathIsNonEmptyString(Buffer && typeof Buffer === 'function' ? Buffer.from('a') : {}).ok === false, 'L1.1 rejects buffer-like');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.2 — starts with configured prefix
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathStartsWithPrefix(`${PREFIX}X.md`, PREFIX).ok === true, 'L1.2 accepts prefixed path');
assert(checkPathStartsWithPrefix('X.md', PREFIX).ok === false, 'L1.2 rejects bare filename');
assert(checkPathStartsWithPrefix('OtherFolder/X.md', PREFIX).ok === false, 'L1.2 rejects different folder');
assert(checkPathStartsWithPrefix(`${PREFIX}X.md`, '').ok === false, 'L1.2 rejects empty prefix');
assert(checkPathStartsWithPrefix(`${PREFIX}X.md`, 'DeepLore/prompts').ok === false, 'L1.2 rejects prefix missing trailing slash');
assert(checkPathStartsWithPrefix(`${PREFIX}X.md`, null).ok === false, 'L1.2 rejects null prefix');
assert(checkPathStartsWithPrefix('deeplore/prompts/X.md', PREFIX).ok === false, 'L1.2 is case-sensitive (lowercase rejected)');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.3 — ends with .md
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathEndsWithMd(`${PREFIX}X.md`).ok === true, 'L1.3 accepts .md extension');
assert(checkPathEndsWithMd(`${PREFIX}X.txt`).ok === false, 'L1.3 rejects .txt');
assert(checkPathEndsWithMd(`${PREFIX}X`).ok === false, 'L1.3 rejects no extension');
assert(checkPathEndsWithMd(`${PREFIX}X.md.bak`).ok === false, 'L1.3 rejects double extension');
assert(checkPathEndsWithMd(`${PREFIX}X.MD`).ok === false, 'L1.3 is case-sensitive (.MD rejected)');
assert(checkPathEndsWithMd(`${PREFIX}.md`).ok === true, 'L1.3 by itself accepts bare ".md" (other layers must reject)');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.4 — no traversal (raw, encoded, double-encoded, unicode)
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathHasNoTraversal(`${PREFIX}X.md`).ok === true, 'L1.4 accepts clean path');

// Raw `..`
assert(checkPathHasNoTraversal(`${PREFIX}../X.md`).ok === false, 'L1.4 rejects raw ".."');
assert(checkPathHasNoTraversal(`${PREFIX}..`).ok === false, 'L1.4 rejects trailing ".."');
assert(checkPathHasNoTraversal(`..${PREFIX}X.md`).ok === false, 'L1.4 rejects leading ".."');
assert(checkPathHasNoTraversal(`${PREFIX}sub/../X.md`).ok === false, 'L1.4 rejects ".." in mid-path');

// Percent-encoded `..`
assert(checkPathHasNoTraversal(`${PREFIX}%2e%2e/X.md`).ok === false, 'L1.4 rejects "%2e%2e" lowercase');
assert(checkPathHasNoTraversal(`${PREFIX}%2E%2E/X.md`).ok === false, 'L1.4 rejects "%2E%2E" uppercase');
assert(checkPathHasNoTraversal(`${PREFIX}%2e%2E/X.md`).ok === false, 'L1.4 rejects mixed-case encoded traversal');

// Double-encoded
assert(checkPathHasNoTraversal(`${PREFIX}%252e%252e/X.md`).ok === false, 'L1.4 rejects double-URL-encoded');
assert(checkPathHasNoTraversal(`${PREFIX}foo%25bar.md`).ok === false, 'L1.4 rejects any %25 (double-encode marker)');

// Unicode lookalikes
assert(checkPathHasNoTraversal(`${PREFIX}．．/X.md`).ok === false, 'L1.4 rejects U+FF0E fullwidth dot');
assert(checkPathHasNoTraversal(`${PREFIX}‥/X.md`).ok === false, 'L1.4 rejects U+2025 two-dot leader');
assert(checkPathHasNoTraversal(`${PREFIX}X．md`).ok === false, 'L1.4 rejects fullwidth dot in stem');
assert(checkPathHasNoTraversal(`${PREFIX}X／Y.md`).ok === false, 'L1.4 rejects U+FF0F fullwidth solidus');
assert(checkPathHasNoTraversal(`${PREFIX}X⁄Y.md`).ok === false, 'L1.4 rejects U+2044 fraction slash');
assert(checkPathHasNoTraversal(`${PREFIX}X∕Y.md`).ok === false, 'L1.4 rejects U+2215 division slash');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.5 — no double-slash / double-backslash
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathHasNoDoubleSlash(`${PREFIX}X.md`).ok === true, 'L1.5 accepts clean path');
assert(checkPathHasNoDoubleSlash('DeepLore//prompts/X.md').ok === false, 'L1.5 rejects "//" mid-path');
assert(checkPathHasNoDoubleSlash(`${PREFIX}/X.md`).ok === false, 'L1.5 rejects extra "/" causing "//"');
assert(checkPathHasNoDoubleSlash(`DeepLore\\\\prompts\\X.md`).ok === false, 'L1.5 rejects "\\\\" double-backslash');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.6 — no absolute prefix
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathHasNoAbsolutePrefix(`${PREFIX}X.md`).ok === true, 'L1.6 accepts relative path');
assert(checkPathHasNoAbsolutePrefix(`/${PREFIX}X.md`).ok === false, 'L1.6 rejects leading /');
assert(checkPathHasNoAbsolutePrefix(`\\${PREFIX}X.md`).ok === false, 'L1.6 rejects leading \\');
assert(checkPathHasNoAbsolutePrefix('~/DeepLore/prompts/X.md').ok === false, 'L1.6 rejects ~ home shortcut');
assert(checkPathHasNoAbsolutePrefix('C:/DeepLore/prompts/X.md').ok === false, 'L1.6 rejects C: drive letter');
assert(checkPathHasNoAbsolutePrefix('c:/DeepLore/prompts/X.md').ok === false, 'L1.6 rejects lowercase drive letter');
assert(checkPathHasNoAbsolutePrefix('D:\\DeepLore\\prompts\\X.md').ok === false, 'L1.6 rejects D: drive letter with backslashes');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.7 — no URL-encoding artifacts or control chars
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathHasNoUrlEncoding(`${PREFIX}X.md`).ok === true, 'L1.7 accepts clean path');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X%20Y.md`).ok === false, 'L1.7 rejects %20 (encoded space)');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X+Y.md`).ok === false, 'L1.7 rejects + char');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X\0Y.md`).ok === false, 'L1.7 rejects null byte');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X\nY.md`).ok === false, 'L1.7 rejects newline');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X\rY.md`).ok === false, 'L1.7 rejects carriage return');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X\tY.md`).ok === false, 'L1.7 rejects tab');
assert(checkPathHasNoUrlEncoding(`${PREFIX}X\x7FY.md`).ok === false, 'L1.7 rejects DEL char');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.8 — no subdirectories past prefix
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathIsFlatFile(`${PREFIX}X.md`, PREFIX).ok === true, 'L1.8 accepts flat file');
assert(checkPathIsFlatFile(`${PREFIX}sub/X.md`, PREFIX).ok === false, 'L1.8 rejects subdirectory with /');
assert(checkPathIsFlatFile(`${PREFIX}sub\\X.md`, PREFIX).ok === false, 'L1.8 rejects subdirectory with \\');
assert(checkPathIsFlatFile(`${PREFIX}a/b/c/X.md`, PREFIX).ok === false, 'L1.8 rejects deep nesting');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.9 — stem shape (SCREAMING_SNAKE_CASE)
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathStemShape(`${PREFIX}${KNOWN_KEY}.md`, PREFIX).ok === true, 'L1.9 accepts SCREAMING_SNAKE_CASE');
assert(checkPathStemShape(`${PREFIX}lowercase.md`, PREFIX).ok === false, 'L1.9 rejects lowercase');
assert(checkPathStemShape(`${PREFIX}mixedCase.md`, PREFIX).ok === false, 'L1.9 rejects mixedCase');
assert(checkPathStemShape(`${PREFIX}with-hyphen.md`, PREFIX).ok === false, 'L1.9 rejects hyphen');
assert(checkPathStemShape(`${PREFIX}with space.md`, PREFIX).ok === false, 'L1.9 rejects space');
assert(checkPathStemShape(`${PREFIX}1STARTING_WITH_DIGIT.md`, PREFIX).ok === false, 'L1.9 rejects digit-leading');
assert(checkPathStemShape(`${PREFIX}A.md`, PREFIX).ok === false, 'L1.9 rejects single-char stem (min length 2)');
assert(checkPathStemShape(`${PREFIX}.md`, PREFIX).ok === false, 'L1.9 rejects empty stem');
assert(checkPathStemShape(`${PREFIX}WITH.dot.md`, PREFIX).ok === false, 'L1.9 rejects inner dot in stem');

// ════════════════════════════════════════════════════════════════════════════
// Layer 1.10 — path length
// ════════════════════════════════════════════════════════════════════════════

assert(checkPathLength(`${PREFIX}X.md`).ok === true, 'L1.10 accepts short path');
const longTail = 'A'.repeat(MAX_PROMPT_PATH_LENGTH); // total exceeds with prefix
assert(checkPathLength(`${PREFIX}${longTail}.md`).ok === false, `L1.10 rejects path > ${MAX_PROMPT_PATH_LENGTH} chars`);
assert(checkPathLength('A'.repeat(MAX_PROMPT_PATH_LENGTH)).ok === true, 'L1.10 accepts exactly MAX chars');
assert(checkPathLength('A'.repeat(MAX_PROMPT_PATH_LENGTH + 1)).ok === false, 'L1.10 rejects MAX+1 chars');

// ════════════════════════════════════════════════════════════════════════════
// Layer 2 — stem must be a known or deprecated key
// ════════════════════════════════════════════════════════════════════════════

assert(checkStemIsAcceptedKey(`${PREFIX}${KNOWN_KEY}.md`, PREFIX).ok === true, 'L2 accepts a known key from en.js');
assert(checkStemIsAcceptedKey(`${PREFIX}UNKNOWN_KEY_NEVER_EXISTED.md`, PREFIX).ok === false, 'L2 rejects unknown key');
assert(checkStemIsAcceptedKey(`${PREFIX}README.md`, PREFIX).ok === false, 'L2 rejects README');
assert(checkStemIsAcceptedKey(`${PREFIX}ALICE.md`, PREFIX).ok === false, 'L2 rejects user lore entry stem');

// All known keys in the EN dict accepted by Layer 2.
for (const k of KNOWN_PROMPT_KEYS) {
    assert(
        checkStemIsAcceptedKey(`${PREFIX}${k}.md`, PREFIX).ok === true,
        `L2 accepts canonical key "${k}"`,
    );
}

// ACCEPTED_PROMPT_KEYS is the union of known + deprecated.
assert(ACCEPTED_PROMPT_KEYS.size >= KNOWN_PROMPT_KEYS.size, 'ACCEPTED is superset of KNOWN');

// ════════════════════════════════════════════════════════════════════════════
// Composite validator — first-failure short-circuit + happy path
// ════════════════════════════════════════════════════════════════════════════

{
    const result = validatePromptDeletePath(`${PREFIX}${KNOWN_KEY}.md`, PREFIX);
    assert(result.ok === true, 'composite: accepts valid path');
    assertEqual(result.stem, KNOWN_KEY, 'composite: returns stem on success');
}

{
    const result = validatePromptDeletePath('', PREFIX);
    assert(result.ok === false && result.check === 'L1.1', 'composite: empty string fails L1.1');
}

{
    const result = validatePromptDeletePath(`${PREFIX}../etc/passwd`, PREFIX);
    assert(result.ok === false, 'composite: traversal fails');
    // Could fail L1.3 (not .md) or L1.4 (..) depending on order — either is acceptable.
    assert(result.check === 'L1.3' || result.check === 'L1.4', 'composite: traversal fails at L1.3 or L1.4');
}

{
    const result = validatePromptDeletePath(`${PREFIX}README.md`, PREFIX);
    assert(result.ok === false && result.check === 'L2', 'composite: unknown stem fails L2');
}

{
    const result = validatePromptDeletePath(`/etc/passwd`, PREFIX);
    assert(result.ok === false, 'composite: absolute non-prompt path fails');
}

{
    const result = validatePromptDeletePath(`${PREFIX}sub/${KNOWN_KEY}.md`, PREFIX);
    assert(result.ok === false && result.check === 'L1.8', 'composite: subdirectory fails L1.8');
}

{
    // Even a known key in a wrong folder must fail at L1.2, not pass to L2.
    const result = validatePromptDeletePath(`OtherFolder/${KNOWN_KEY}.md`, PREFIX);
    assert(result.ok === false && result.check === 'L1.2', 'composite: known stem in wrong folder fails L1.2');
}

// ════════════════════════════════════════════════════════════════════════════
// Fuzz pass — 100 random adversarial strings
// ════════════════════════════════════════════════════════════════════════════

{
    const adversarialSamples = [];
    // Seeded deterministic "randomness" so tests are reproducible.
    let seed = 0xC0FFEE;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xFFFFFFFF;
    };
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.\\-_:%+\0\n\r\t~ ';
    for (let i = 0; i < 100; i++) {
        const len = Math.floor(rand() * 30) + 1;
        let s = '';
        for (let j = 0; j < len; j++) {
            s += charset[Math.floor(rand() * charset.length)];
        }
        adversarialSamples.push(s);
    }
    let fuzzPasses = 0;
    let fuzzAccepts = 0;
    for (const s of adversarialSamples) {
        const result = validatePromptDeletePath(s, PREFIX);
        if (!result.ok) fuzzPasses++;
        else fuzzAccepts++;
    }
    // Almost all random adversarial garbage must be refused. We allow a few
    // theoretical accidental accepts (a random string like `DeepLore/prompts/AB.md`
    // could pass if it happens to match a known key — vanishingly unlikely with
    // SCREAMING_SNAKE_CASE filter, but not impossible). Bound failures to 0.
    assert(fuzzAccepts === 0, `fuzz: zero adversarial inputs accepted (got ${fuzzAccepts})`);
    assert(fuzzPasses === 100, `fuzz: 100/100 adversarial inputs refused (got ${fuzzPasses})`);
}

// ════════════════════════════════════════════════════════════════════════════
// Known attack patterns
// ════════════════════════════════════════════════════════════════════════════

const ATTACK_PATTERNS = [
    // Directory traversal variants
    `${PREFIX}../../../etc/passwd`,
    `${PREFIX}..%2f..%2fpasswd`,
    `${PREFIX}%2e%2e%2fpasswd`,
    `${PREFIX}....//passwd`,
    `${PREFIX}..\\..\\windows\\system32\\config\\sam`,
    // Null byte injection
    `${PREFIX}${KNOWN_KEY}.md\0.txt`,
    `${PREFIX}${KNOWN_KEY}\0.md`,
    // Trailing slash trick
    `${PREFIX}${KNOWN_KEY}/`,
    `${PREFIX}${KNOWN_KEY}.md/`,
    // Wrong file types pretending to be MD
    `${PREFIX}${KNOWN_KEY}.md.exe`,
    `${PREFIX}${KNOWN_KEY}.md.sh`,
    // Path manipulation
    `${PREFIX}./X.md`,
    `${PREFIX}.${KNOWN_KEY}.md`,
    // Symlink-style names (path strings only)
    `${PREFIX}symlink_target.md`,
    // Unicode normalization attacks
    `${PREFIX}EM­MA.md`, // soft hyphen
    `${PREFIX}﻿${KNOWN_KEY}.md`, // BOM
    // Mixed slashes
    `DeepLore\\prompts/${KNOWN_KEY}.md`,
    // Empty filename
    `${PREFIX}.md`,
    // Stem too short
    `${PREFIX}A.md`,
    // Drive letter via prefix injection
    `C:\\${PREFIX}${KNOWN_KEY}.md`,
    // File URL
    `file://${PREFIX}${KNOWN_KEY}.md`,
];

for (const pattern of ATTACK_PATTERNS) {
    const result = validatePromptDeletePath(pattern, PREFIX);
    assert(result.ok === false, `attack pattern refused: ${JSON.stringify(pattern)}`);
}

// ════════════════════════════════════════════════════════════════════════════
// sanitizePromptsFolderPath — user-configurable folder setting
// ════════════════════════════════════════════════════════════════════════════

assertEqual(sanitizePromptsFolderPath('DeepLore/prompts'), 'DeepLore/prompts/', 'sanitize: appends trailing slash');
assertEqual(sanitizePromptsFolderPath('DeepLore/prompts/'), 'DeepLore/prompts/', 'sanitize: preserves trailing slash');
assertEqual(sanitizePromptsFolderPath('DeepLore\\prompts'), 'DeepLore/prompts/', 'sanitize: converts backslashes');
assertEqual(sanitizePromptsFolderPath('  DeepLore/prompts  '), 'DeepLore/prompts/', 'sanitize: trims whitespace');
assertEqual(sanitizePromptsFolderPath('MyVault/Notes/Prompts'), 'MyVault/Notes/Prompts/', 'sanitize: accepts custom path');
assertEqual(sanitizePromptsFolderPath(''), null, 'sanitize: rejects empty');
assertEqual(sanitizePromptsFolderPath('   '), null, 'sanitize: rejects whitespace');
assertEqual(sanitizePromptsFolderPath(null), null, 'sanitize: rejects null');
assertEqual(sanitizePromptsFolderPath(undefined), null, 'sanitize: rejects undefined');
assertEqual(sanitizePromptsFolderPath(42), null, 'sanitize: rejects number');
assertEqual(sanitizePromptsFolderPath('/etc/passwd'), null, 'sanitize: rejects absolute');
assertEqual(sanitizePromptsFolderPath('../escape'), null, 'sanitize: rejects ..');
assertEqual(sanitizePromptsFolderPath('a//b'), null, 'sanitize: rejects //');
assertEqual(sanitizePromptsFolderPath('~/home'), null, 'sanitize: rejects ~');
assertEqual(sanitizePromptsFolderPath('C:/Windows'), null, 'sanitize: rejects drive letter');
assertEqual(sanitizePromptsFolderPath('encoded%2e%2e'), null, 'sanitize: rejects encoded traversal');
assertEqual(sanitizePromptsFolderPath('fullwidth．/folder'), null, 'sanitize: rejects unicode lookalike');
assertEqual(sanitizePromptsFolderPath('null\0byte'), null, 'sanitize: rejects null byte');
assertEqual(sanitizePromptsFolderPath('plus+sign'), null, 'sanitize: rejects + sign');
assertEqual(sanitizePromptsFolderPath('percent%encoded'), null, 'sanitize: rejects % sign');
assertEqual(sanitizePromptsFolderPath('A'.repeat(101)), null, 'sanitize: rejects > 100 chars');
assertEqual(sanitizePromptsFolderPath('A'.repeat(99) + '/'), 'A'.repeat(99) + '/', 'sanitize: accepts 100 chars total with trailing /');

// Sanitized output, when fed into validator with a known key, must yield a valid delete path.
{
    const sanitized = sanitizePromptsFolderPath('Alt/Folder');
    const path = `${sanitized}${KNOWN_KEY}.md`;
    const result = validatePromptDeletePath(path, sanitized);
    assert(result.ok === true, 'sanitize round-trip: validator accepts path with sanitized custom prefix');
}

// ════════════════════════════════════════════════════════════════════════════
// Composite regression — every known prompt key passes composite at the
// default prefix. Guarantees coverage doesn't drift when new keys are added.
// ════════════════════════════════════════════════════════════════════════════

for (const k of KNOWN_PROMPT_KEYS) {
    const result = validatePromptDeletePath(`${PREFIX}${k}.md`, PREFIX);
    assert(result.ok === true, `composite accepts canonical key "${k}"`);
    if (result.ok) {
        assertEqual(result.stem, k, `composite returns correct stem for "${k}"`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`  Prompts delete-cage safety: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════════');

if (failed > 0) {
    process.exit(1);
}
