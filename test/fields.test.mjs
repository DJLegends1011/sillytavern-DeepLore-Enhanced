/**
 * DeepLore Enhanced — fields.js unit tests
 * Run with: node test/fields.test.mjs
 *
 * Comprehensive tests for custom field definitions: validation, parsing,
 * serialization, operator evaluation, field extraction, and duplicate detection.
 */

import {
    assert, assertEqual, assertNotEqual, assertThrows, assertNull, assertNotNull,
    assertContains, assertMatch, test, section, summary, makeEntry,
} from './helpers.mjs';

import {
    RESERVED_FIELD_NAMES, VALID_OPERATORS, DEFAULT_FIELD_DEFINITIONS,
    validateFieldName, validateFieldDefinition, parseFieldDefinitionYaml,
    serializeFieldDefinitions, evaluateOperator, extractCustomFields,
    findDuplicateFieldNames,
} from '../src/fields.js';

// ============================================================================
//  1. validateFieldName
// ============================================================================

section('validateFieldName');

test('valid: simple snake_case name', () => {
    const r = validateFieldName('custom_field');
    assert(r.valid === true, 'custom_field should be valid');
    assert(r.reason === undefined, 'no reason when valid');
});

test('valid: single letter', () => {
    assert(validateFieldName('a').valid === true, '"a" is valid');
});

test('valid: letters and digits', () => {
    assert(validateFieldName('abc123').valid === true, '"abc123" is valid');
});

test('valid: trailing underscore and digit', () => {
    assert(validateFieldName('my_field_2').valid === true, '"my_field_2" is valid');
});

test('valid: long name', () => {
    assert(validateFieldName('very_long_field_name_here').valid === true, 'long name is valid');
});

test('invalid: empty string', () => {
    const r = validateFieldName('');
    assert(r.valid === false, 'empty string is invalid');
    assertMatch(r.reason, /required/i, 'reason mentions required');
});

test('invalid: null input', () => {
    const r = validateFieldName(null);
    assert(r.valid === false, 'null is invalid');
});

test('invalid: undefined input', () => {
    const r = validateFieldName(undefined);
    assert(r.valid === false, 'undefined is invalid');
});

test('invalid: number input', () => {
    const r = validateFieldName(42);
    assert(r.valid === false, 'number is invalid');
});

test('invalid: starts with digit', () => {
    const r = validateFieldName('2field');
    assert(r.valid === false, '"2field" is invalid');
    assertMatch(r.reason, /lowercase/i, 'reason mentions format rule');
});

test('invalid: uppercase letters', () => {
    const r = validateFieldName('MyField');
    assert(r.valid === false, '"MyField" is invalid');
});

test('invalid: contains space', () => {
    const r = validateFieldName('my field');
    assert(r.valid === false, '"my field" is invalid');
});

test('invalid: contains dash', () => {
    const r = validateFieldName('my-field');
    assert(r.valid === false, '"my-field" is invalid');
});

test('invalid: special characters', () => {
    const r = validateFieldName('field!');
    assert(r.valid === false, '"field!" is invalid');
});

test('reserved: keys', () => {
    const r = validateFieldName('keys');
    assert(r.valid === false, '"keys" is reserved');
    assertMatch(r.reason, /reserved/i, 'reason mentions reserved');
});

test('reserved: priority', () => {
    assert(validateFieldName('priority').valid === false, '"priority" is reserved');
});

test('reserved: tags', () => {
    assert(validateFieldName('tags').valid === false, '"tags" is reserved');
});

test('reserved: requires', () => {
    assert(validateFieldName('requires').valid === false, '"requires" is reserved');
});

test('reserved: cooldown', () => {
    assert(validateFieldName('cooldown').valid === false, '"cooldown" is reserved');
});

test('reserved: summary', () => {
    assert(validateFieldName('summary').valid === false, '"summary" is reserved');
});

test('reserved: enabled', () => {
    assert(validateFieldName('enabled').valid === false, '"enabled" is reserved');
});

test('edge: whitespace-only string', () => {
    const r = validateFieldName('   ');
    assert(r.valid === false, 'whitespace-only is invalid');
});

test('edge: name with leading/trailing whitespace that is otherwise valid', () => {
    // validateFieldName trims, then checks the regex on the trimmed value
    const r = validateFieldName('  custom_field  ');
    assert(r.valid === true, 'trimmed name should be valid');
});

test('invalid: starts with underscore', () => {
    const r = validateFieldName('_field');
    assert(r.valid === false, '"_field" starts with underscore, not a letter');
});

// ============================================================================
//  2. validateFieldDefinition
// ============================================================================

section('validateFieldDefinition');

test('valid minimal: just name', () => {
    const { field, errors } = validateFieldDefinition({ name: 'mood' });
    assertNotNull(field, 'field should not be null');
    assertEqual(field.name, 'mood', 'name preserved');
    assertEqual(field.label, 'mood', 'label defaults to name');
    assertEqual(field.type, 'string', 'type defaults to string');
    assertEqual(field.multi, false, 'multi defaults to false');
    assertEqual(field.gating.enabled, true, 'gating.enabled defaults true');
    assertEqual(field.gating.operator, 'match_any', 'gating.operator defaults match_any');
    assertEqual(field.gating.tolerance, 'moderate', 'gating.tolerance defaults moderate');
    assertEqual(field.values, [], 'values defaults to empty array');
    assertEqual(field.contextKey, 'mood', 'contextKey defaults to name');
    assertEqual(errors.length, 0, 'no errors for valid minimal def');
});

test('valid full: all fields specified', () => {
    const raw = {
        name: 'weather',
        label: 'Weather',
        type: 'string',
        multi: true,
        gating: { enabled: false, operator: 'match_all', tolerance: 'strict' },
        values: ['sunny', 'rainy', 'cloudy'],
        contextKey: 'current_weather',
    };
    const { field, errors } = validateFieldDefinition(raw);
    assertNotNull(field, 'field should exist');
    assertEqual(field.label, 'Weather', 'label preserved');
    assertEqual(field.type, 'string', 'type preserved');
    assertEqual(field.multi, true, 'multi preserved');
    assertEqual(field.gating.enabled, false, 'gating.enabled preserved');
    assertEqual(field.gating.operator, 'match_all', 'gating.operator preserved');
    assertEqual(field.gating.tolerance, 'strict', 'gating.tolerance preserved');
    assertEqual(field.values, ['sunny', 'rainy', 'cloudy'], 'values preserved');
    assertEqual(field.contextKey, 'current_weather', 'contextKey preserved');
    assertEqual(errors.length, 0, 'no errors');
});

test('null input returns null field', () => {
    const { field, errors } = validateFieldDefinition(null);
    assertNull(field, 'field should be null');
    assert(errors.length > 0, 'should have errors');
    assertMatch(errors[0], /object/i, 'error mentions object');
});

test('undefined input returns null field', () => {
    const { field, errors } = validateFieldDefinition(undefined);
    assertNull(field, 'field should be null');
});

test('non-object input (string) returns null field', () => {
    const { field, errors } = validateFieldDefinition('not an object');
    assertNull(field, 'field should be null for string input');
});

test('non-object input (number) returns null field', () => {
    const { field, errors } = validateFieldDefinition(42);
    assertNull(field, 'field should be null for number input');
});

test('invalid name propagates error and returns null', () => {
    const { field, errors } = validateFieldDefinition({ name: 'keys' });
    assertNull(field, 'reserved name returns null field');
    assert(errors.some(e => /reserved/i.test(e)), 'error mentions reserved');
});

test('unknown type defaults to string with error', () => {
    const { field, errors } = validateFieldDefinition({ name: 'mood', type: 'date' });
    assertNotNull(field, 'field still created despite bad type');
    assertEqual(field.type, 'string', 'type falls back to string');
    assert(errors.some(e => /unknown type/i.test(e)), 'error about unknown type');
});

test('label defaults to name when missing', () => {
    const { field } = validateFieldDefinition({ name: 'mood' });
    assertEqual(field.label, 'mood', 'label equals name');
});

test('label defaults to name when empty string', () => {
    const { field } = validateFieldDefinition({ name: 'mood', label: '   ' });
    assertEqual(field.label, 'mood', 'blank label falls back to name');
});

test('multi defaults to false when not provided', () => {
    const { field } = validateFieldDefinition({ name: 'mood' });
    assertEqual(field.multi, false, 'multi is false by default');
});

test('multi false when set to non-true truthy value', () => {
    const { field } = validateFieldDefinition({ name: 'mood', multi: 1 });
    assertEqual(field.multi, false, 'multi requires strict true');
});

test('gating defaults when gating block missing', () => {
    const { field } = validateFieldDefinition({ name: 'mood' });
    assertEqual(field.gating.enabled, true, 'gating.enabled defaults true');
    assertEqual(field.gating.operator, 'match_any', 'gating.operator defaults match_any');
    assertEqual(field.gating.tolerance, 'moderate', 'gating.tolerance defaults moderate');
});

test('invalid gating operator falls back to match_any', () => {
    const { field } = validateFieldDefinition({ name: 'mood', gating: { operator: 'bogus' } });
    assertEqual(field.gating.operator, 'match_any', 'bad operator falls back to match_any');
});

test('invalid gating tolerance falls back to moderate', () => {
    const { field } = validateFieldDefinition({ name: 'mood', gating: { tolerance: 'extreme' } });
    assertEqual(field.gating.tolerance, 'moderate', 'bad tolerance falls back to moderate');
});

test('values coercion: numbers become strings', () => {
    const { field } = validateFieldDefinition({ name: 'mood', values: [1, 2, 3] });
    assertEqual(field.values, ['1', '2', '3'], 'numbers stringified');
});

test('values coercion: empty array stays empty', () => {
    const { field } = validateFieldDefinition({ name: 'mood', values: [] });
    assertEqual(field.values, [], 'empty array preserved');
});

test('values: non-array input becomes empty array', () => {
    const { field } = validateFieldDefinition({ name: 'mood', values: 'not-an-array' });
    assertEqual(field.values, [], 'non-array values becomes empty');
});

test('contextKey defaults to name when missing', () => {
    const { field } = validateFieldDefinition({ name: 'mood' });
    assertEqual(field.contextKey, 'mood', 'contextKey falls back to name');
});

test('contextKey defaults to name when blank string', () => {
    const { field } = validateFieldDefinition({ name: 'mood', contextKey: '  ' });
    assertEqual(field.contextKey, 'mood', 'blank contextKey falls back to name');
});

test('gating.enabled is true even when not specified (not false)', () => {
    const { field } = validateFieldDefinition({ name: 'mood', gating: { operator: 'eq' } });
    assertEqual(field.gating.enabled, true, 'gating.enabled true unless explicitly false');
});

test('values: empty strings filtered out after trimming', () => {
    const { field } = validateFieldDefinition({ name: 'mood', values: ['happy', '', '  ', 'sad'] });
    assertEqual(field.values, ['happy', 'sad'], 'empty/blank values removed');
});

// ============================================================================
//  3. parseFieldDefinitionYaml
// ============================================================================

section('parseFieldDefinitionYaml');

test('empty string returns empty', () => {
    const { definitions, errors } = parseFieldDefinitionYaml('');
    assertEqual(definitions.length, 0, 'no definitions from empty string');
    assertEqual(errors.length, 0, 'no errors from empty string');
});

test('null returns empty', () => {
    const { definitions, errors } = parseFieldDefinitionYaml(null);
    assertEqual(definitions.length, 0, 'no definitions from null');
});

test('undefined returns empty', () => {
    const { definitions, errors } = parseFieldDefinitionYaml(undefined);
    assertEqual(definitions.length, 0, 'no definitions from undefined');
});

test('whitespace-only returns empty', () => {
    const { definitions } = parseFieldDefinitionYaml('   \n  \n  ');
    assertEqual(definitions.length, 0, 'no definitions from whitespace');
});

test('single field definition', () => {
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
    contextKey: mood
`;
    const { definitions, errors } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'one definition parsed');
    assertEqual(definitions[0].name, 'mood', 'name is mood');
    assertEqual(definitions[0].label, 'Mood', 'label is Mood');
    assertEqual(definitions[0].type, 'string', 'type is string');
    assertEqual(definitions[0].multi, false, 'multi is false');
    assertEqual(definitions[0].gating.enabled, true, 'gating enabled');
    assertEqual(definitions[0].gating.operator, 'match_any', 'gating operator');
    assertEqual(definitions[0].values, [], 'values empty');
    assertEqual(definitions[0].contextKey, 'mood', 'contextKey');
});

test('multiple field definitions', () => {
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
    contextKey: mood
  - name: threat_level
    label: Threat Level
    type: number
    multi: false
    gating:
      enabled: false
      operator: gt
      tolerance: strict
    values: []
    contextKey: threat_level
`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 2, 'two definitions parsed');
    assertEqual(definitions[0].name, 'mood', 'first is mood');
    assertEqual(definitions[1].name, 'threat_level', 'second is threat_level');
    assertEqual(definitions[1].type, 'number', 'second type is number');
    assertEqual(definitions[1].gating.enabled, false, 'second gating disabled');
    assertEqual(definitions[1].gating.operator, 'gt', 'second operator gt');
});

test('field with values array', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: true
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values:
      - happy
      - sad
      - angry
    contextKey: mood
`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions[0].values, ['happy', 'sad', 'angry'], 'values parsed correctly');
});

test('field with empty values []', () => {
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
    contextKey: mood
`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions[0].values, [], 'inline empty array parsed');
});

test('comments are skipped', () => {
    const yaml = `# Top level comment
fields:
  # This is a field
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: mood
`;
    const { definitions, errors } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'one definition despite comments');
    assertEqual(definitions[0].name, 'mood', 'name correct');
});

test('round-trip: serialize then parse produces equivalent definitions', () => {
    const original = [
        {
            name: 'mood',
            label: 'Mood',
            type: 'string',
            multi: true,
            gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
            values: ['happy', 'sad'],
            contextKey: 'mood',
        },
        {
            name: 'threat_level',
            label: 'Threat Level',
            type: 'number',
            multi: false,
            gating: { enabled: false, operator: 'gt', tolerance: 'strict' },
            values: [],
            contextKey: 'threat_level',
        },
    ];
    const yaml = serializeFieldDefinitions(original);
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 2, 'round-trip: same count');
    assertEqual(definitions[0].name, original[0].name, 'round-trip: first name');
    assertEqual(definitions[0].label, original[0].label, 'round-trip: first label');
    assertEqual(definitions[0].type, original[0].type, 'round-trip: first type');
    assertEqual(definitions[0].multi, original[0].multi, 'round-trip: first multi');
    assertEqual(definitions[0].gating.enabled, original[0].gating.enabled, 'round-trip: first gating.enabled');
    assertEqual(definitions[0].gating.operator, original[0].gating.operator, 'round-trip: first gating.operator');
    assertEqual(definitions[0].gating.tolerance, original[0].gating.tolerance, 'round-trip: first gating.tolerance');
    assertEqual(definitions[0].values, original[0].values, 'round-trip: first values');
    assertEqual(definitions[0].contextKey, original[0].contextKey, 'round-trip: first contextKey');
    assertEqual(definitions[1].name, original[1].name, 'round-trip: second name');
    assertEqual(definitions[1].gating.enabled, original[1].gating.enabled, 'round-trip: second gating.enabled');
});

test('malformed YAML: field missing name is skipped', () => {
    const yaml = `fields:
  - name: mood
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: mood
  - label: No Name Field
    type: string
    multi: false
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: noname
`;
    // The second field has no "- name:" line, so the parser won't create a new
    // field entry for it. Only the first field should parse.
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions.length, 1, 'only first valid field parsed');
    assertEqual(definitions[0].name, 'mood', 'first field correct');
});

test('boolean gating values parsed correctly', () => {
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: false
    gating:
      enabled: false
      operator: eq
      tolerance: lenient
    values: []
    contextKey: mood
`;
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions[0].gating.enabled, false, 'enabled parsed as false boolean');
    assertEqual(definitions[0].gating.tolerance, 'lenient', 'tolerance parsed as lenient');
});

test('number value in YAML is parsed as number type', () => {
    // parseYamlValue converts numeric strings to numbers
    const yaml = `fields:
  - name: mood
    label: Mood
    type: string
    multi: true
    gating:
      enabled: true
      operator: match_any
      tolerance: moderate
    values: []
    contextKey: mood
`;
    // multi: true is parsed as boolean true by parseYamlValue
    const { definitions } = parseFieldDefinitionYaml(yaml);
    assertEqual(definitions[0].multi, true, 'boolean true parsed from YAML');
});

test('non-string input type returns empty', () => {
    const { definitions } = parseFieldDefinitionYaml(123);
    assertEqual(definitions.length, 0, 'number input returns empty');
});

test('YAML with only fields: [] line returns empty', () => {
    const { definitions } = parseFieldDefinitionYaml('fields: []');
    // The parser skips "fields:" line and there are no field entries
    assertEqual(definitions.length, 0, 'fields: [] returns empty');
});

// ============================================================================
//  4. serializeFieldDefinitions
// ============================================================================

section('serializeFieldDefinitions');

test('empty array returns fields: []', () => {
    assertEqual(serializeFieldDefinitions([]), 'fields: []\n', 'empty array serializes correctly');
});

test('null returns fields: []', () => {
    assertEqual(serializeFieldDefinitions(null), 'fields: []\n', 'null serializes to empty');
});

test('undefined returns fields: []', () => {
    assertEqual(serializeFieldDefinitions(undefined), 'fields: []\n', 'undefined serializes to empty');
});

test('non-array returns fields: []', () => {
    assertEqual(serializeFieldDefinitions('not-array'), 'fields: []\n', 'string serializes to empty');
});

test('single field serialization', () => {
    const defs = [{
        name: 'mood',
        label: 'Mood',
        type: 'string',
        multi: false,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'mood',
    }];
    const yaml = serializeFieldDefinitions(defs);
    assertMatch(yaml, /^fields:\n/, 'starts with fields:');
    assertMatch(yaml, /- name: mood/, 'contains name');
    assertMatch(yaml, /label: Mood/, 'contains label');
    assertMatch(yaml, /type: string/, 'contains type');
    assertMatch(yaml, /multi: false/, 'contains multi');
    assertMatch(yaml, /enabled: true/, 'contains gating enabled');
    assertMatch(yaml, /operator: match_any/, 'contains gating operator');
    assertMatch(yaml, /tolerance: moderate/, 'contains gating tolerance');
    assertMatch(yaml, /values: \[\]/, 'contains empty values');
    assertMatch(yaml, /contextKey: mood/, 'contains contextKey');
});

test('multiple fields serialized', () => {
    const defs = [
        {
            name: 'mood', label: 'Mood', type: 'string', multi: false,
            gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
            values: [], contextKey: 'mood',
        },
        {
            name: 'danger', label: 'Danger', type: 'number', multi: false,
            gating: { enabled: false, operator: 'gt', tolerance: 'strict' },
            values: [], contextKey: 'danger',
        },
    ];
    const yaml = serializeFieldDefinitions(defs);
    // Should have two "- name:" entries
    const nameCount = (yaml.match(/- name:/g) || []).length;
    assertEqual(nameCount, 2, 'two field entries in serialized output');
});

test('values array rendered with items', () => {
    const defs = [{
        name: 'mood', label: 'Mood', type: 'string', multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: ['happy', 'sad', 'angry'], contextKey: 'mood',
    }];
    const yaml = serializeFieldDefinitions(defs);
    assertMatch(yaml, /values:\n\s+- happy\n\s+- sad\n\s+- angry/, 'values rendered as list items');
});

test('empty values renders as []', () => {
    const defs = [{
        name: 'mood', label: 'Mood', type: 'string', multi: false,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [], contextKey: 'mood',
    }];
    const yaml = serializeFieldDefinitions(defs);
    assertMatch(yaml, /values: \[\]/, 'empty values rendered as []');
});

// ============================================================================
//  5. evaluateOperator
// ============================================================================

section('evaluateOperator');

// --- match_any ---
test('match_any: single match (string vs string)', () => {
    assert(evaluateOperator('match_any', 'forest', 'forest') === true, 'exact match');
});

test('match_any: no match', () => {
    assert(evaluateOperator('match_any', 'forest', 'city') === false, 'no match');
});

test('match_any: case-insensitive', () => {
    assert(evaluateOperator('match_any', 'Forest', 'forest') === true, 'case insensitive');
});

test('match_any: array vs array, one overlap', () => {
    assert(evaluateOperator('match_any', ['forest', 'cave'], ['cave', 'city']) === true, 'array overlap');
});

test('match_any: array vs array, no overlap', () => {
    assert(evaluateOperator('match_any', ['forest', 'cave'], ['city', 'desert']) === false, 'no array overlap');
});

test('match_any: array vs single string', () => {
    assert(evaluateOperator('match_any', ['forest', 'cave'], 'cave') === true, 'array vs single');
});

test('match_any: single string vs array', () => {
    assert(evaluateOperator('match_any', 'cave', ['cave', 'city']) === true, 'single vs array');
});

// --- match_all ---
test('match_all: all entry values present in active', () => {
    assert(evaluateOperator('match_all', ['alice', 'bob'], ['alice', 'bob', 'charlie']) === true, 'all present');
});

test('match_all: some entry values missing from active', () => {
    assert(evaluateOperator('match_all', ['alice', 'bob'], ['alice', 'charlie']) === false, 'bob missing');
});

test('match_all: case-insensitive', () => {
    assert(evaluateOperator('match_all', ['Alice', 'Bob'], ['alice', 'bob']) === true, 'case insensitive match_all');
});

test('match_all: single entry value against single active (match)', () => {
    assert(evaluateOperator('match_all', 'alice', 'alice') === true, 'single vs single match');
});

test('match_all: single entry value against single active (no match)', () => {
    assert(evaluateOperator('match_all', 'alice', 'bob') === false, 'single vs single no match');
});

// --- not_any ---
test('not_any: none match (returns true)', () => {
    assert(evaluateOperator('not_any', ['forest', 'cave'], ['city', 'desert']) === true, 'no overlap means true');
});

test('not_any: some match (returns false)', () => {
    assert(evaluateOperator('not_any', ['forest', 'cave'], ['cave', 'desert']) === false, 'overlap means false');
});

test('not_any: case-insensitive overlap', () => {
    assert(evaluateOperator('not_any', 'Forest', 'forest') === false, 'case insensitive overlap');
});

// --- exists ---
test('exists: non-null string returns true', () => {
    assert(evaluateOperator('exists', 'hello', null) === true, 'string exists');
});

test('exists: non-empty array returns true', () => {
    assert(evaluateOperator('exists', ['a'], null) === true, 'non-empty array exists');
});

test('exists: null returns false', () => {
    assert(evaluateOperator('exists', null, null) === false, 'null does not exist');
});

test('exists: undefined returns false', () => {
    assert(evaluateOperator('exists', undefined, null) === false, 'undefined does not exist');
});

test('exists: empty array returns false', () => {
    assert(evaluateOperator('exists', [], null) === false, 'empty array does not exist');
});

test('exists: zero (non-null) returns true', () => {
    assert(evaluateOperator('exists', 0, null) === true, 'zero exists (non-null)');
});

test('exists: false boolean (non-null) returns true', () => {
    assert(evaluateOperator('exists', false, null) === true, 'false exists (non-null)');
});

// --- not_exists ---
test('not_exists: null returns true', () => {
    assert(evaluateOperator('not_exists', null, null) === true, 'null → not_exists true');
});

test('not_exists: undefined returns true', () => {
    assert(evaluateOperator('not_exists', undefined, null) === true, 'undefined → not_exists true');
});

test('not_exists: empty array returns true', () => {
    assert(evaluateOperator('not_exists', [], null) === true, 'empty array → not_exists true');
});

test('not_exists: non-null returns false', () => {
    assert(evaluateOperator('not_exists', 'hello', null) === false, 'non-null → not_exists false');
});

test('not_exists: non-empty array returns false', () => {
    assert(evaluateOperator('not_exists', ['a'], null) === false, 'non-empty array → not_exists false');
});

// --- eq ---
test('eq: exact string match', () => {
    assert(evaluateOperator('eq', 'medieval', 'medieval') === true, 'exact eq');
});

test('eq: case-insensitive', () => {
    assert(evaluateOperator('eq', 'Medieval', 'medieval') === true, 'case insensitive eq');
});

test('eq: no match', () => {
    assert(evaluateOperator('eq', 'medieval', 'modern') === false, 'eq no match');
});

test('eq: numeric strings', () => {
    assert(evaluateOperator('eq', '42', '42') === true, 'numeric string eq');
});

test('eq: number vs string coercion', () => {
    assert(evaluateOperator('eq', 42, '42') === true, 'number coerced to string for eq');
});

// --- gt ---
test('gt: 10 > 5 is true', () => {
    assert(evaluateOperator('gt', 10, 5) === true, '10 > 5');
});

test('gt: 5 > 10 is false', () => {
    assert(evaluateOperator('gt', 5, 10) === false, '5 > 10 false');
});

test('gt: NaN guard — non-numeric entry returns false', () => {
    assert(evaluateOperator('gt', 'abc', 5) === false, 'NaN entry → false');
});

test('gt: NaN guard — non-numeric active returns false', () => {
    assert(evaluateOperator('gt', 10, 'abc') === false, 'NaN active → false');
});

test('gt: equal values is false', () => {
    assert(evaluateOperator('gt', 5, 5) === false, 'equal not gt');
});

test('gt: string numbers work', () => {
    assert(evaluateOperator('gt', '10', '5') === true, 'string "10" > "5"');
});

// --- lt ---
test('lt: 5 < 10 is true', () => {
    assert(evaluateOperator('lt', 5, 10) === true, '5 < 10');
});

test('lt: 10 < 5 is false', () => {
    assert(evaluateOperator('lt', 10, 5) === false, '10 < 5 false');
});

test('lt: NaN guard — non-numeric returns false', () => {
    assert(evaluateOperator('lt', 'abc', 5) === false, 'NaN entry → false');
});

test('lt: NaN guard — non-numeric active returns false', () => {
    assert(evaluateOperator('lt', 5, 'abc') === false, 'NaN active → false');
});

test('lt: equal values is false', () => {
    assert(evaluateOperator('lt', 5, 5) === false, 'equal not lt');
});

// --- default (unknown operator) ---
test('unknown operator returns true', () => {
    assert(evaluateOperator('bogus_op', 'a', 'b') === true, 'unknown op → true');
});

test('empty string operator returns true', () => {
    assert(evaluateOperator('', 'a', 'b') === true, 'empty op → true');
});

// ============================================================================
//  6. extractCustomFields
// ============================================================================

section('extractCustomFields');

test('string field extraction (single value)', () => {
    const defs = [{ name: 'mood', type: 'string', multi: false }];
    const fm = { mood: 'happy' };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.mood, 'happy', 'single string extracted');
});

test('string multi field extraction (array)', () => {
    const defs = [{ name: 'mood', type: 'string', multi: true }];
    const fm = { mood: ['happy', 'excited'] };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.mood, ['happy', 'excited'], 'multi string array extracted');
});

test('string multi from single value wraps in array', () => {
    const defs = [{ name: 'mood', type: 'string', multi: true }];
    const fm = { mood: 'happy' };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.mood, ['happy'], 'single string wrapped in array for multi');
});

test('number field extraction (valid number)', () => {
    const defs = [{ name: 'threat', type: 'number', multi: false }];
    const fm = { threat: 7 };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.threat, 7, 'number extracted');
});

test('number field from string', () => {
    const defs = [{ name: 'threat', type: 'number', multi: false }];
    const fm = { threat: '42' };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.threat, 42, 'string "42" converted to number');
});

test('number field with NaN returns null', () => {
    const defs = [{ name: 'threat', type: 'number', multi: false }];
    const fm = { threat: 'not-a-number' };
    const result = extractCustomFields(fm, defs);
    assertNull(result.threat, 'NaN becomes null');
});

test('boolean field: true', () => {
    const defs = [{ name: 'active', type: 'boolean', multi: false }];
    const fm = { active: true };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.active, true, 'boolean true extracted');
});

test('boolean field: string "true"', () => {
    const defs = [{ name: 'active', type: 'boolean', multi: false }];
    const fm = { active: 'true' };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.active, true, '"true" string treated as true');
});

test('boolean field: false', () => {
    const defs = [{ name: 'active', type: 'boolean', multi: false }];
    const fm = { active: false };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.active, false, 'boolean false extracted');
});

test('boolean field: other truthy value is false', () => {
    const defs = [{ name: 'active', type: 'boolean', multi: false }];
    const fm = { active: 1 };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.active, false, '1 is not true or "true", so false');
});

test('missing field in frontmatter not in result', () => {
    const defs = [{ name: 'mood', type: 'string', multi: false }];
    const fm = { other: 'value' };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.mood, undefined, 'missing field not present');
    assertEqual(Object.keys(result).length, 0, 'result is empty');
});

test('null frontmatter returns empty object', () => {
    const defs = [{ name: 'mood', type: 'string', multi: false }];
    const result = extractCustomFields(null, defs);
    assertEqual(Object.keys(result).length, 0, 'null frontmatter → empty');
});

test('null fieldDefinitions returns empty object', () => {
    const result = extractCustomFields({ mood: 'happy' }, null);
    assertEqual(Object.keys(result).length, 0, 'null defs → empty');
});

test('multi field with number input in string mode', () => {
    const defs = [{ name: 'era', type: 'string', multi: true }];
    const fm = { era: 1920 };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.era, ['1920'], 'number coerced to string array');
});

test('string field with number input (non-multi)', () => {
    const defs = [{ name: 'era', type: 'string', multi: false }];
    const fm = { era: 1920 };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.era, '1920', 'number coerced to string');
});

test('multiple fields extracted simultaneously', () => {
    const defs = [
        { name: 'mood', type: 'string', multi: false },
        { name: 'threat', type: 'number', multi: false },
        { name: 'active', type: 'boolean', multi: false },
    ];
    const fm = { mood: 'happy', threat: 5, active: true };
    const result = extractCustomFields(fm, defs);
    assertEqual(result.mood, 'happy', 'mood extracted');
    assertEqual(result.threat, 5, 'threat extracted');
    assertEqual(result.active, true, 'active extracted');
});

// ============================================================================
//  7. findDuplicateFieldNames
// ============================================================================

section('findDuplicateFieldNames');

test('no duplicates returns empty array', () => {
    const defs = [{ name: 'era' }, { name: 'mood' }, { name: 'location' }];
    assertEqual(findDuplicateFieldNames(defs), [], 'no duplicates');
});

test('one duplicate detected', () => {
    const defs = [{ name: 'era' }, { name: 'mood' }, { name: 'era' }];
    const dupes = findDuplicateFieldNames(defs);
    assertEqual(dupes.length, 1, 'one duplicate');
    assertEqual(dupes[0], 'era', 'duplicate is era');
});

test('case-insensitive: Era and era are duplicates', () => {
    const defs = [{ name: 'era' }, { name: 'Era' }];
    const dupes = findDuplicateFieldNames(defs);
    assertEqual(dupes.length, 1, 'case-insensitive duplicate');
    assertEqual(dupes[0], 'Era', 'second occurrence reported');
});

test('multiple duplicates detected', () => {
    const defs = [
        { name: 'era' }, { name: 'mood' }, { name: 'era' },
        { name: 'mood' }, { name: 'location' },
    ];
    const dupes = findDuplicateFieldNames(defs);
    assertEqual(dupes.length, 2, 'two duplicates');
    assertContains(dupes, 'era', 'era is duplicate');
    assertContains(dupes, 'mood', 'mood is duplicate');
});

test('empty array returns empty', () => {
    assertEqual(findDuplicateFieldNames([]), [], 'empty input → empty output');
});

test('single item: no duplicates', () => {
    assertEqual(findDuplicateFieldNames([{ name: 'era' }]), [], 'single item no dupes');
});

// ============================================================================
//  8. Constants verification
// ============================================================================

section('Constants');

test('DEFAULT_FIELD_DEFINITIONS has exactly 4 entries', () => {
    assertEqual(DEFAULT_FIELD_DEFINITIONS.length, 4, 'four default fields');
});

test('DEFAULT_FIELD_DEFINITIONS[0] is era', () => {
    const f = DEFAULT_FIELD_DEFINITIONS[0];
    assertEqual(f.name, 'era', 'first is era');
    assertEqual(f.label, 'Era', 'label is Era');
    assertEqual(f.type, 'string', 'type is string');
    assertEqual(f.multi, true, 'multi is true');
    assertEqual(f.gating.enabled, true, 'gating enabled');
    assertEqual(f.gating.operator, 'match_any', 'gating operator');
    assertEqual(f.contextKey, 'era', 'contextKey is era');
});

test('DEFAULT_FIELD_DEFINITIONS[1] is location', () => {
    assertEqual(DEFAULT_FIELD_DEFINITIONS[1].name, 'location', 'second is location');
    assertEqual(DEFAULT_FIELD_DEFINITIONS[1].label, 'Location', 'label is Location');
});

test('DEFAULT_FIELD_DEFINITIONS[2] is scene_type', () => {
    assertEqual(DEFAULT_FIELD_DEFINITIONS[2].name, 'scene_type', 'third is scene_type');
    assertEqual(DEFAULT_FIELD_DEFINITIONS[2].label, 'Scene Type', 'label is Scene Type');
});

test('DEFAULT_FIELD_DEFINITIONS[3] is character_present', () => {
    assertEqual(DEFAULT_FIELD_DEFINITIONS[3].name, 'character_present', 'fourth is character_present');
    assertEqual(DEFAULT_FIELD_DEFINITIONS[3].label, 'Characters Present', 'label is Characters Present');
});

test('all defaults have correct structure', () => {
    for (const f of DEFAULT_FIELD_DEFINITIONS) {
        assertNotNull(f.name, `${f.name} has name`);
        assertNotNull(f.label, `${f.name} has label`);
        assertEqual(f.type, 'string', `${f.name} type is string`);
        assertEqual(f.multi, true, `${f.name} multi is true`);
        assert(typeof f.gating === 'object', `${f.name} has gating object`);
        assert(Array.isArray(f.values), `${f.name} values is array`);
        assertNotNull(f.contextKey, `${f.name} has contextKey`);
    }
});

test('RESERVED_FIELD_NAMES contains critical names', () => {
    assert(RESERVED_FIELD_NAMES.has('keys'), 'keys is reserved');
    assert(RESERVED_FIELD_NAMES.has('priority'), 'priority is reserved');
    assert(RESERVED_FIELD_NAMES.has('tags'), 'tags is reserved');
    assert(RESERVED_FIELD_NAMES.has('requires'), 'requires is reserved');
    assert(RESERVED_FIELD_NAMES.has('excludes'), 'excludes is reserved');
    assert(RESERVED_FIELD_NAMES.has('cooldown'), 'cooldown is reserved');
    assert(RESERVED_FIELD_NAMES.has('summary'), 'summary is reserved');
    assert(RESERVED_FIELD_NAMES.has('enabled'), 'enabled is reserved');
    assert(RESERVED_FIELD_NAMES.has('constant'), 'constant is reserved');
    assert(RESERVED_FIELD_NAMES.has('seed'), 'seed is reserved');
    assert(RESERVED_FIELD_NAMES.has('bootstrap'), 'bootstrap is reserved');
    assert(RESERVED_FIELD_NAMES.has('type'), 'type is reserved');
    assert(RESERVED_FIELD_NAMES.has('graph'), 'graph is reserved');
});

test('RESERVED_FIELD_NAMES size is at least 20', () => {
    assert(RESERVED_FIELD_NAMES.size >= 20, `reserved set has ${RESERVED_FIELD_NAMES.size} entries, expected >= 20`);
});

test('VALID_OPERATORS contains all 8 operators', () => {
    assertEqual(VALID_OPERATORS.size, 8, 'exactly 8 operators');
    assert(VALID_OPERATORS.has('match_any'), 'match_any');
    assert(VALID_OPERATORS.has('match_all'), 'match_all');
    assert(VALID_OPERATORS.has('not_any'), 'not_any');
    assert(VALID_OPERATORS.has('exists'), 'exists');
    assert(VALID_OPERATORS.has('not_exists'), 'not_exists');
    assert(VALID_OPERATORS.has('gt'), 'gt');
    assert(VALID_OPERATORS.has('lt'), 'lt');
    assert(VALID_OPERATORS.has('eq'), 'eq');
});

// ============================================================================
//  Summary
// ============================================================================

await summary('Fields Tests');
