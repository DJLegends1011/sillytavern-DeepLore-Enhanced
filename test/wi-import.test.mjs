/**
 * DeepLore Enhanced — WI Import Full-Parity Tests (Wave 7, v2.5 WI parity)
 *
 * End-to-end coverage of the import contract (docs/gotchas.md #69):
 *   1. Tier A native fields land as canonical frontmatter (Wave 1)
 *   2. Tier C round-trip fields preserve as snake_case (Wave 2)
 *   3. selective_logic enforces all 4 modes natively (Wave 3)
 *   4. Example Messages (positions 5/6) get the subheader treatment + skip
 *      mode honored at the I/O layer (Wave 4)
 *   5. Importer drift guard: every ST WI field in the fixture has a documented
 *      home (no silent drops). Driven by st-wi-export-full.json — DO NOT prune
 *      fields from that fixture without updating the contract.
 *
 * Round-trip flow exercised:
 *     parseWorldInfoJson(json)
 *       → convertWiEntry(wiEntry, lorebookTag, {report, emHandling})
 *         → parseVaultFile(emitted, tagConfig)
 *           → assert Tier A landed, Tier C preserved, EM handled
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { test, assert, summary } from './helpers.mjs';
import { parseWorldInfoJson } from '../src/vault/import-pure.js';
import { convertWiEntry, WI_ROUND_TRIP_FIELDS } from '../src/helpers.js';
import { parseVaultFile } from '../core/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'st-wi-export-full.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

const tagConfig = {
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    seedTag: 'lorebook-seed',
    bootstrapTag: 'lorebook-bootstrap',
    guideTag: 'lorebook-guide',
};

// ============================================================================
// Parse + entry shape
// ============================================================================

test('parseWorldInfoJson: parses the full-parity fixture into 7 entries', () => {
    const { entries, source } = parseWorldInfoJson(FIXTURE_JSON);
    assert(entries.length === 7, `expected 7 entries, got ${entries.length}`);
    assert(source === 'Full Parity Test Book', 'source name extracted');
});

// ============================================================================
// Tier A (Wave 1) — native fields land
// ============================================================================

test('full-parity: entry 0 emits enabled:false (disable=true → silent-downgrade fix)', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[0], 'lorebook');
    assert(out.content.includes('enabled: false'), 'disable=true must emit enabled:false');
});

test('full-parity: entry 0 emits excludeRecursion:true (native, camelCase)', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[0], 'lorebook');
    assert(out.content.includes('excludeRecursion: true'), 'excludeRecursion native');
});

test('full-parity: entry 0 emits role:user (ST enum 1 → user)', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[0], 'lorebook');
    assert(out.content.includes('role: user'), 'role 1 → user');
});

test('full-parity: entry 0 emits selective_logic:and_all (ST mode 3)', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[0], 'lorebook');
    assert(out.content.includes('selective_logic: and_all'), 'selectiveLogic 3 → and_all');
});

test('full-parity: entry 0 round-trips through parseVaultFile with all Tier A semantics', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[0], 'lorebook');
    const vaultEntry = parseVaultFile({ filename: out.filename, content: out.content }, tagConfig);
    // disable=true means parseVaultFile returns null (skipped). To verify the
    // OTHER fields survived parsing, also test entry 1 which has disable=false.
    assert(vaultEntry === null, 'disabled entry → parser returns null (Wave 1 silent-downgrade fix)');
});

test('full-parity: enabled-only Tier A subset round-trips into VaultEntry shape', () => {
    // Synthesize a Tier A entry WITHOUT disable so the parser actually returns it.
    const wi = {
        comment: 'TierAEnabled', key: ['t'], content: 'c',
        excludeRecursion: true, role: 2, selectiveLogic: 1,
    };
    const out = convertWiEntry(wi, 'lorebook');
    const vaultEntry = parseVaultFile({ filename: out.filename, content: out.content }, tagConfig);
    assert(vaultEntry !== null, 'enabled entry returned');
    assert(vaultEntry.excludeRecursion === true, 'excludeRecursion in entry shape');
    assert(vaultEntry.injectionRole != null, 'role resolved to injectionRole');
    assert(vaultEntry.selectiveLogic === 'not_all', 'selective_logic 1 → not_all in entry shape');
});

// ============================================================================
// Tier C (Wave 2) — round-trip preservation
// ============================================================================

test('full-parity: entry 1 emits ALL round-trip fields as snake_case', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[1], 'lorebook');
    // Every snake-cased target from WI_ROUND_TRIP_FIELDS must appear.
    for (const [, fmKey] of WI_ROUND_TRIP_FIELDS) {
        assert(out.content.includes(`${fmKey}:`), `missing round-trip field: ${fmKey}`);
    }
});

test('full-parity: round-trip fields land in customFields after parseVaultFile', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[1], 'lorebook');
    const vaultEntry = parseVaultFile({ filename: out.filename, content: out.content }, tagConfig);
    assert(vaultEntry !== null, 'entry returned');
    for (const [, fmKey] of WI_ROUND_TRIP_FIELDS) {
        assert(fmKey in vaultEntry.customFields, `missing in customFields: ${fmKey}`);
    }
});

test('full-parity: parser flags every round-trip field with W_WI_ROUND_TRIP', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[1], 'lorebook');
    const vaultEntry = parseVaultFile({ filename: out.filename, content: out.content }, tagConfig);
    const flagged = (vaultEntry._parserWarnings || [])
        .filter(w => w.code === 'W_WI_ROUND_TRIP')
        .map(w => w.field);
    for (const [, fmKey] of WI_ROUND_TRIP_FIELDS) {
        assert(flagged.includes(fmKey), `field NOT surfaced by /dle-lint: ${fmKey}`);
    }
});

test('full-parity: report.roundTripped counts every Tier C field once', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const report = { nativeApplied: {}, roundTripped: {}, skipped: {} };
    convertWiEntry(entries[1], 'lorebook', { report });
    // Entry 1 exercises all 22 Tier C fields (original 18 Wave 2 + 4 modern
    // ST fields added during the audit fix-up).
    assert(Object.keys(report.roundTripped).length === 22, `expected 22 round-trip counters, got ${Object.keys(report.roundTripped).length}`);
});

// ============================================================================
// Wave 3 — selective_logic enforcement
// ============================================================================

test('full-parity: entry 4 (NOT_ANY) round-trips to selective_logic:not_any', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[4], 'lorebook');
    assert(out.content.includes('selective_logic: not_any'), 'selectiveLogic 2 → not_any');
    const vaultEntry = parseVaultFile({ filename: out.filename, content: out.content }, tagConfig);
    assert(vaultEntry.selectiveLogic === 'not_any', 'parser surfaces not_any');
});

// ============================================================================
// Wave 4 — Example Messages handling
// ============================================================================

test('full-parity: entry 2 (position 5) gets ## Example Dialogue subheader + position:before', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[2], 'lorebook');
    assert(out.content.includes('position: before'), 'position 5 → before');
    assert(out.content.includes('## Example Dialogue'), 'EM subheader prepended');
    assert(out.content.includes('Halt, traveler'), 'original sample line preserved');
    assert(out._emPosition === 5, '_emPosition flag set');
});

test('full-parity: entry 3 (position 6) gets ## Example Dialogue subheader + position:after', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[3], 'lorebook');
    assert(out.content.includes('position: after'), 'position 6 → after');
    assert(out.content.includes('## Example Dialogue'), 'EM subheader prepended');
    assert(out._emPosition === 6, '_emPosition flag set');
});

test('full-parity: EM subheader entries round-trip through parser into normal vault entries', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const out = convertWiEntry(entries[2], 'lorebook');
    const vaultEntry = parseVaultFile({ filename: out.filename, content: out.content }, tagConfig);
    assert(vaultEntry !== null, 'EM entry becomes a normal vault entry on parse');
    assert(vaultEntry.content.includes('## Example Dialogue'), 'subheader survives parse');
    assert(vaultEntry.injectionPosition !== null, 'position parsed (DLE no longer sees ST 5/6)');
});

// ============================================================================
// Wave 1/3 negative paths — invalid enums omit, bump skipped counters
// ============================================================================

test('full-parity: invalid role (99) omitted + skipped.invalid_role bumped', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const report = { nativeApplied: {}, roundTripped: {}, skipped: {} };
    const out = convertWiEntry(entries[5], 'lorebook', { report });
    assert(!out.content.includes('role:'), 'invalid role omitted');
    assert(report.skipped.invalid_role === 1, 'invalid_role counter bumped');
});

test('full-parity: invalid selectiveLogic (99) omitted + skipped counter bumped', () => {
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const report = { nativeApplied: {}, roundTripped: {}, skipped: {} };
    const out = convertWiEntry(entries[6], 'lorebook', { report });
    assert(!out.content.includes('selective_logic:'), 'invalid selectiveLogic omitted');
    assert(report.skipped.invalid_selective_logic === 1, 'invalid_selective_logic counter bumped');
});

// ============================================================================
// No-silent-drop contract — every ST WI field in the fixture has a home
// ============================================================================

const FIELD_HOMES = {
    // Native — DLE acts on (or maps to canonical frontmatter)
    uid: 'discarded',
    key: 'native:keys',
    keysecondary: 'native:refine_keys',
    comment: 'native:title',
    content: 'native:body',
    constant: 'native:lorebook-always tag',
    order: 'native:priority',
    position: 'native:position (+ EM subheader for 5/6)',
    depth: 'native:depth',
    probability: 'native:probability',
    scanDepth: 'native:scanDepth',
    disable: 'native:enabled:false',
    excludeRecursion: 'native:excludeRecursion',
    role: 'native:role',
    selectiveLogic: 'native:selective_logic',
    cooldown: 'native:cooldown',
    // Round-trip (Tier C / W_NOT_IMPLEMENTED)
    sticky: 'round-trip:sticky',
    delay: 'round-trip:delay',
    group: 'round-trip:group',
    groupWeight: 'round-trip:group_weight',
    vectorized: 'round-trip:vectorized',
    selective: 'round-trip:selective',
    useProbability: 'round-trip:use_probability',
    preventRecursion: 'round-trip:prevent_recursion',
    delayUntilRecursion: 'round-trip:delay_until_recursion',
    groupOverride: 'round-trip:group_override',
    useGroupScoring: 'round-trip:use_group_scoring',
    caseSensitive: 'round-trip:case_sensitive',
    matchWholeWords: 'round-trip:match_whole_words',
    automationId: 'round-trip:automation_id',
    addMemo: 'round-trip:add_memo',
    displayIndex: 'round-trip:display_index',
    matchPersonaDescription: 'round-trip:match_persona_description',
    matchCharacterDescription: 'round-trip:match_character_description',
    matchCharacterPersonality: 'round-trip:match_character_personality',
    matchCharacterDepthPrompt: 'round-trip:match_character_depth_prompt',
    matchScenario: 'round-trip:match_scenario',
    matchCreatorNotes: 'round-trip:match_creator_notes',
    // Audit fix-up: modern ST fields (originalWIDataKeyMap in world-info.js).
    triggers: 'round-trip:triggers',
    ignoreBudget: 'round-trip:ignore_budget',
    characterFilter: 'round-trip:character_filter',
    decorators: 'round-trip:decorators',
};

test('full-parity: every ST WI field in the fixture has a documented home (no silent drops)', () => {
    // Drift guard: if the fixture grows a new ST WI field, this test fails
    // until FIELD_HOMES is updated. That forces reviewers to decide native vs
    // round-trip vs documented gap — exactly the contract from gotchas.md #69.
    const { entries } = parseWorldInfoJson(FIXTURE_JSON);
    const seenFields = new Set();
    for (const e of entries) {
        for (const k of Object.keys(e)) seenFields.add(k);
    }
    const orphans = [...seenFields].filter(f => !(f in FIELD_HOMES));
    assert(orphans.length === 0, `orphan ST fields with no documented home: ${orphans.join(', ')} — update FIELD_HOMES + decide native/round-trip/gap`);
});

// Audit fix-up: the FIELD_HOMES check above was a false positive — it only
// verified the lookup table had the key, NOT that the importer actually emits
// the field. That's how `cooldown` slipped past (FIELD_HOMES claimed
// native:cooldown but convertWiEntry never wrote a `cooldown:` line). This
// per-tier emission check closes the gap.

test('full-parity emission: every native:* field round-trips into emitted frontmatter', () => {
    // Synthesize an entry that sets every native field to a NON-default value
    // and assert each one lands as expected frontmatter. Catches the cooldown
    // class of silent drop where the home is documented but the line is missing.
    const wi = {
        comment: 'EmissionCheck',
        key: ['ek'],
        keysecondary: ['rk'],
        content: 'body',
        constant: true,
        order: 25,
        position: 1, // → before
        depth: 4,
        probability: 50,
        scanDepth: 10,
        disable: false, // we want the entry to land so the parser doesn't skip it
        excludeRecursion: true,
        role: 1,
        selectiveLogic: 3, // and_all
        cooldown: 7,
    };
    const out = convertWiEntry(wi, 'lorebook');
    // priority + tags + content always emit; the rest are the per-field checks.
    assert(out.content.includes('priority: 25'), 'native:order → priority emitted');
    assert(out.content.includes('  - lorebook'), 'native:tags emitted (lorebook tag)');
    assert(out.content.includes('  - lorebook-always'), 'native:constant → lorebook-always tag');
    assert(out.content.includes('keys:'), 'native:keys emitted');
    assert(out.content.includes('refine_keys:'), 'native:keysecondary → refine_keys');
    assert(out.content.includes('position: before'), 'native:position emitted');
    assert(out.content.includes('depth: 4'), 'native:depth emitted');
    assert(out.content.includes('probability: 0.50'), 'native:probability emitted (rescaled)');
    assert(out.content.includes('scanDepth: 10'), 'native:scanDepth emitted');
    assert(out.content.includes('excludeRecursion: true'), 'native:excludeRecursion emitted');
    assert(out.content.includes('role: user'), 'native:role emitted');
    assert(out.content.includes('selective_logic: and_all'), 'native:selectiveLogic emitted (non-default mode)');
    assert(out.content.includes('cooldown: 7'), 'native:cooldown emitted (audit fix-up — was silently dropped pre-fix)');
});

test('full-parity emission: disable=true emits enabled:false (silent-downgrade guard)', () => {
    const wi = { comment: 'D', key: ['d'], content: 'c', disable: true };
    const out = convertWiEntry(wi, 'lorebook');
    assert(out.content.includes('enabled: false'), 'native:disable → enabled:false emitted');
});

test('full-parity emission: every round-trip:* field appears as snake_case frontmatter', () => {
    // Set EVERY Tier C field to a truthy non-default value; assert each maps
    // to its snake_case frontmatter key. Stronger than the W_WI_ROUND_TRIP
    // count check because it asserts the literal emission shape.
    const { WI_ROUND_TRIP_FIELDS: importerTable } = { WI_ROUND_TRIP_FIELDS };
    const wi = { comment: 'AllRT', key: ['rt'], content: 'c' };
    for (const [wiKey] of importerTable) {
        // Set string fields to a non-empty value, bools/numbers truthy non-default.
        if (wiKey === 'automationId' || wiKey === 'group' || wiKey === 'triggers' || wiKey === 'characterFilter' || wiKey === 'decorators') {
            wi[wiKey] = 'val';
        } else if (wiKey === 'displayIndex' || wiKey === 'useGroupScoring') {
            wi[wiKey] = 5;
        } else {
            wi[wiKey] = true;
        }
    }
    const out = convertWiEntry(wi, 'lorebook');
    for (const [, fmKey] of importerTable) {
        assert(out.content.includes(`${fmKey}:`), `round-trip emission missing: ${fmKey}`);
    }
});

await summary('WI Import Full-Parity Tests');
