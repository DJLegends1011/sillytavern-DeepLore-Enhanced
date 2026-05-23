/**
 * DeepLore Enhanced — Pipeline Stage INTERACTION Tests
 * Tests stage COMBINATIONS: pin+gating, cooldown+requires cascades, budget+priority, etc.
 * These catch regressions that per-stage isolation tests miss.
 *
 * Run with: node test/stages.test.mjs
 */

import {
    assert, assertEqual, assertNotEqual, assertGreaterThan, assertLessThan,
    assertNull, assertNotNull, assertContains, test, section, summary, makeEntry, makeSettings,
} from './helpers.mjs';

import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating, applyFolderFilter,
    applyReinjectionCooldown, applyRequiresExcludesGating, applyStripDedup,
    trackGeneration, decrementTrackers, recordAnalytics,
} from '../src/stages.js';

import { DEFAULT_FIELD_DEFINITIONS } from '../src/fields.js';
import { trackerKey } from '../src/state.js';

// ============================================================================
// A. Pin + Gating Interactions
// ============================================================================

section('A. Pin + Gating Interactions');

test('A1: Pinned entry survives contextual gating', () => {
    const pinned = makeEntry('Pinned Lore', { constant: false, customFields: { era: ['medieval'] } });
    const normal = makeEntry('Normal Lore', { customFields: { era: ['medieval'] } });
    const vault = [pinned, normal];
    const policy = buildExemptionPolicy(vault, ['Pinned Lore'], []);
    const context = { era: ['futuristic'] }; // no match for medieval

    const entries = applyPinBlock([normal], vault, policy, new Map());
    const gated = applyContextualGating(entries, context, policy, false, makeSettings(), DEFAULT_FIELD_DEFINITIONS);

    // Pinned entry is in forceInject — survives gating even though era doesn't match
    const titles = gated.map(e => e.title);
    assert(titles.includes('Pinned Lore'), 'A1: pinned entry should survive contextual gating');
});

test('A2: Pinned entry survives requires/excludes gating', () => {
    const pinned = makeEntry('Pinned Lore', { requires: ['Missing Entry'] });
    const vault = [pinned];
    const policy = buildExemptionPolicy(vault, ['Pinned Lore'], []);
    const matchedKeys = new Map();

    const entries = applyPinBlock([], vault, policy, matchedKeys);
    const { result } = applyRequiresExcludesGating(entries, policy, false);

    assert(result.some(e => e.title === 'Pinned Lore'), 'A2: pinned entry should survive requires gating');
});

test('A3: Pinned entry survives reinjection cooldown', () => {
    const pinned = makeEntry('Pinned Lore');
    const vault = [pinned];
    const policy = buildExemptionPolicy(vault, ['Pinned Lore'], []);
    const matchedKeys = new Map();

    const entries = applyPinBlock([], vault, policy, matchedKeys);
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(pinned), 5); // injected at gen 5

    const result = applyReinjectionCooldown(entries, policy, injectionHistory, 6, 3, false);
    assert(result.some(e => e.title === 'Pinned Lore'), 'A3: pinned entry should survive reinjection cooldown');
});

test('A4: Blocked entry removed even if constant', () => {
    const constant = makeEntry('Blocked Constant', { constant: true });
    const vault = [constant];
    const policy = buildExemptionPolicy(vault, [], ['Blocked Constant']);

    const entries = applyPinBlock([constant], vault, policy, new Map());
    assert(!entries.some(e => e.title === 'Blocked Constant'), 'A4: blocked constant should be removed');
});

test('A5: Blocked entry removed even if it matches keywords', () => {
    const matched = makeEntry('Keyword Match', { keys: ['dragon'] });
    const vault = [matched];
    const policy = buildExemptionPolicy(vault, [], ['Keyword Match']);

    const entries = applyPinBlock([matched], vault, policy, new Map());
    assert(!entries.some(e => e.title === 'Keyword Match'), 'A5: blocked keyword match should be removed');
});

test('A6: Pin + block on same entry — block wins (block applied after pin)', () => {
    const entry = makeEntry('Contested Entry');
    const vault = [entry];
    const policy = buildExemptionPolicy(vault, ['Contested Entry'], ['Contested Entry']);

    const entries = applyPinBlock([], vault, policy, new Map());
    assert(!entries.some(e => e.title === 'Contested Entry'), 'A6: block should win over pin');
});

test('A7: Pin + block on same entry — block wins (entry already in pipeline)', () => {
    const entry = makeEntry('Contested Entry');
    const vault = [entry];
    const policy = buildExemptionPolicy(vault, ['Contested Entry'], ['Contested Entry']);

    const entries = applyPinBlock([entry], vault, policy, new Map());
    assert(!entries.some(e => e.title === 'Contested Entry'), 'A7: block should win even if entry pre-existed');
});

test('A8: Pinned entry gets priority 10 and constant=true', () => {
    const entry = makeEntry('Pin Target', { priority: 50, constant: false });
    const vault = [entry];
    const policy = buildExemptionPolicy(vault, ['Pin Target'], []);
    const matchedKeys = new Map();

    const entries = applyPinBlock([], vault, policy, matchedKeys);
    const pinned = entries.find(e => e.title === 'Pin Target');
    assertNotNull(pinned, 'A8: pinned entry should exist');
    assertEqual(pinned.priority, 10, 'A8: pinned entry should have priority 10');
    assertEqual(pinned.constant, true, 'A8: pinned entry should have constant=true');
});

test('A9: Pinned entry replaces existing matched entry (not duplicated)', () => {
    const entry = makeEntry('Existing Match', { priority: 50 });
    const vault = [entry];
    const policy = buildExemptionPolicy(vault, ['Existing Match'], []);

    const entries = applyPinBlock([entry], vault, policy, new Map());
    const matching = entries.filter(e => e.title === 'Existing Match');
    assertEqual(matching.length, 1, 'A9: should not duplicate pinned entry');
    assertEqual(matching[0].priority, 10, 'A9: replaced entry should have pin priority');
});

test('A10: Pin with vaultSource matching — vault-aware match', () => {
    const entry1 = makeEntry('Shared Title', { vaultSource: 'VaultA' });
    const entry2 = makeEntry('Shared Title', { vaultSource: 'VaultB' });
    const vault = [entry1, entry2];
    const pin = { title: 'Shared Title', vaultSource: 'VaultB' };
    const policy = buildExemptionPolicy(vault, [pin], []);

    const entries = applyPinBlock([], vault, policy, new Map());
    // Only VaultB entry should be pinned; VaultA entry should not be added
    const pinned = entries.filter(e => e.title === 'Shared Title');
    assertEqual(pinned.length, 1, 'A10: only vault-matched entry should be pinned');
    assertEqual(pinned[0].vaultSource, 'VaultB', 'A10: should pin from correct vault');
});

test('A11: Pinned entry survives strip dedup', () => {
    const pinned = makeEntry('Pinned Lore');
    const vault = [pinned];
    const policy = buildExemptionPolicy(vault, ['Pinned Lore'], []);
    const settings = makeSettings();

    const entries = applyPinBlock([], vault, policy, new Map());
    // Simulate injection log containing this entry
    const injectionLog = [{
        entries: [{ title: 'Pinned Lore', pos: 1, depth: 4, role: 'system', contentHash: '' }],
    }];
    const result = applyStripDedup(entries, policy, injectionLog, 3, settings, false);
    assert(result.some(e => e.title === 'Pinned Lore'), 'A11: pinned entry should survive strip dedup');
});

// ============================================================================
// B. Exemption Policy Completeness
// ============================================================================

section('B. Exemption Policy Completeness');

test('B1: Constants, seeds always in forceInject; bootstrap gated by bootstrapActive', () => {
    const c = makeEntry('Constant', { constant: true });
    const s = makeEntry('Seed', { seed: true });
    const b = makeEntry('Bootstrap', { bootstrap: true });
    const n = makeEntry('Normal');

    // Stages H-3 / gotcha #60: bootstrap exemption is gen-scoped.
    const policyActive = buildExemptionPolicy([c, s, b, n], [], [], true);
    // BUG-399 (Fix 2): forceInject is keyed by trackerKey(entry), not lowercased title.
    assert(policyActive.forceInject.has(trackerKey(c)), 'B1: constant always in forceInject');
    assert(policyActive.forceInject.has(trackerKey(s)), 'B1: seed always in forceInject');
    assert(policyActive.forceInject.has(trackerKey(b)), 'B1: bootstrap in forceInject when bootstrapActive=true');
    assert(!policyActive.forceInject.has(trackerKey(n)), 'B1: normal entry NEVER in forceInject');

    const policyInactive = buildExemptionPolicy([c, s, b, n], [], [], false);
    assert(policyInactive.forceInject.has(trackerKey(c)), 'B1: constant in forceInject regardless of bootstrapActive');
    assert(policyInactive.forceInject.has(trackerKey(s)), 'B1: seed in forceInject regardless of bootstrapActive');
    assert(!policyInactive.forceInject.has(trackerKey(b)), 'B1: bootstrap NOT in forceInject when bootstrapActive=false');
    assert(!policyInactive.forceInject.has(trackerKey(n)), 'B1: normal entry NEVER in forceInject');
});

test('B2: forceInject preserves title case via trackerKey', () => {
    // BUG-399 (Fix 2): trackerKey uses entry.title as-is (no lowercasing). Multi-vault
    // disambiguation via vaultSource is the new contract; title-case normalization is
    // not part of forceInject any more. With makeEntry default vaultSource='', the key
    // for "Mixed CASE Entry" is ":Mixed CASE Entry".
    const entry = makeEntry('Mixed CASE Entry', { constant: true });
    const policy = buildExemptionPolicy([entry], [], []);

    assert(policy.forceInject.has(trackerKey(entry)), 'B2: forceInject should be keyed by trackerKey');
    assert(!policy.forceInject.has('mixed case entry'), 'B2: legacy lowercase-title key must not be present');
});

test('B3: Pins added to forceInject', () => {
    const entry = makeEntry('Pinned One');
    const policy = buildExemptionPolicy([entry], ['Pinned One'], []);

    assert(policy.forceInject.has(trackerKey(entry)), 'B3: pinned entry should be in forceInject');
});

test('B4: Blocks NOT in forceInject', () => {
    const entry = makeEntry('Blocked One');
    const policy = buildExemptionPolicy([entry], [], ['Blocked One']);

    assert(!policy.forceInject.has(trackerKey(entry)), 'B4: blocked entry should NOT be in forceInject');
});

test('B5: Empty pins/blocks produce empty arrays', () => {
    const policy = buildExemptionPolicy([], [], []);

    assertEqual(policy.pins.length, 0, 'B5: empty pins should produce empty array');
    assertEqual(policy.blocks.length, 0, 'B5: empty blocks should produce empty array');
    assertEqual(policy.forceInject.size, 0, 'B5: empty vault should produce empty forceInject');
});

test('B6: Null pins/blocks handled gracefully', () => {
    const policy = buildExemptionPolicy([], null, null);

    assertEqual(policy.pins.length, 0, 'B6: null pins should produce empty array');
    assertEqual(policy.blocks.length, 0, 'B6: null blocks should produce empty array');
});

test('B7: Multi-vault same title — distinct keys, only constant exempted', () => {
    // BUG-399 (Fix 2): forceInject keyed by trackerKey, so vault-A's constant must NOT
    // exempt vault-B's non-constant duplicate.
    const a = makeEntry('Shared', { vaultSource: 'VaultA', constant: true });
    const b = makeEntry('Shared', { vaultSource: 'VaultB' });
    const policy = buildExemptionPolicy([a, b], [], []);

    assert(policy.forceInject.has(trackerKey(a)), 'B7: vault-A constant should be in forceInject');
    assert(!policy.forceInject.has(trackerKey(b)), 'B7: vault-B non-constant must NOT be in forceInject');
    assertNotEqual(trackerKey(a), trackerKey(b), 'B7: trackerKeys for vault-A and vault-B must be distinct');

    // Functional check: gating exempts a but filters b when both fail contextual gating.
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const aWithEra = { ...a, customFields: { era: ['medieval'] } };
    const bWithEra = { ...b, customFields: { era: ['medieval'] } };
    const policy2 = buildExemptionPolicy([aWithEra, bWithEra], [], []);
    const gated = applyContextualGating([aWithEra, bWithEra], { era: ['futuristic'] }, policy2, false, makeSettings(), fieldDefs);
    const titles = gated.map(e => `${e.vaultSource}:${e.title}`);
    assertContains(titles, 'VaultA:Shared', 'B7: vault-A constant survives gating via forceInject');
    assert(!titles.includes('VaultB:Shared'), 'B7: vault-B non-constant filtered by gating');
});

test('B8: Pin with structured {title, vaultSource} object normalizes correctly', () => {
    const entry = makeEntry('Structured Pin');
    const policy = buildExemptionPolicy([entry], [{ title: 'Structured Pin', vaultSource: 'TestVault' }], []);

    assertEqual(policy.pins.length, 1, 'B8: should have one normalized pin');
    assertEqual(policy.pins[0].title, 'Structured Pin', 'B8: pin title should match');
    assertEqual(policy.pins[0].vaultSource, 'TestVault', 'B8: pin vaultSource should match');
    assert(policy.forceInject.has(trackerKey(entry)), 'B8: structured pin should be in forceInject');
});

// ============================================================================
// C. Gating + Tolerance Interactions
// ============================================================================

section('C. Gating + Tolerance Interactions');

test('C1: Strict — entry with value + no context → blocked', () => {
    const entry = makeEntry('Era Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);
    const context = { era: '' }; // no context set

    // Need at least one field with active context for gating to apply at all
    // Use a second field with active context to trigger gating, then era has no context
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
        { name: 'location', label: 'Location', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'location' },
    ];
    // Set location context so gating activates, but era is empty
    const contextWithLocation = { era: '', location: ['castle'] };
    const result = applyContextualGating([entry], contextWithLocation, policy, false, makeSettings({ contextualGatingTolerance: 'strict' }), fieldDefs);
    assertEqual(result.length, 0, 'C1: strict tolerance should block entry with value but no matching context');
});

test('C2: Moderate — entry with value + no context → passes', () => {
    const entry = makeEntry('Era Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);

    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'era' },
        { name: 'location', label: 'Location', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' }, values: [], contextKey: 'location' },
    ];
    const context = { era: '', location: ['castle'] };
    const result = applyContextualGating([entry], context, policy, false, makeSettings({ contextualGatingTolerance: 'moderate' }), fieldDefs);
    assertEqual(result.length, 1, 'C2: moderate tolerance should pass entry with value but no context for that field');
});

test('C3: Lenient — match_any non-match → passes', () => {
    const entry = makeEntry('Era Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);

    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'lenient' }, values: [], contextKey: 'era' },
    ];
    const context = { era: ['futuristic'] }; // doesn't match medieval
    const result = applyContextualGating([entry], context, policy, false, makeSettings({ contextualGatingTolerance: 'lenient' }), fieldDefs);
    assertEqual(result.length, 1, 'C3: lenient tolerance should pass match_any non-match');
});

test('C4: Lenient — not_any non-match → still blocks (precision operator)', () => {
    const entry = makeEntry('Not Any Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);

    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'not_any', tolerance: 'lenient' }, values: [], contextKey: 'era' },
    ];
    // not_any(['medieval'], ['medieval']) = false → entry has medieval, context has medieval → operator fails
    const context = { era: ['medieval'] };
    const result = applyContextualGating([entry], context, policy, false, makeSettings({ contextualGatingTolerance: 'lenient' }), fieldDefs);
    assertEqual(result.length, 0, 'C4: lenient + not_any should still block (precision operator)');
});

test('C5: Lenient — eq non-match → still blocks (precision operator)', () => {
    const entry = makeEntry('Eq Entry', { customFields: { era: 'medieval' } });
    const policy = buildExemptionPolicy([], [], []);

    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: false, gating: { enabled: true, operator: 'eq', tolerance: 'lenient' }, values: [], contextKey: 'era' },
    ];
    const context = { era: 'futuristic' };
    const result = applyContextualGating([entry], context, policy, false, makeSettings({ contextualGatingTolerance: 'lenient' }), fieldDefs);
    assertEqual(result.length, 0, 'C5: lenient + eq should still block (precision operator)');
});

test('C6: Multiple fields — passes field1 but fails field2 → blocked', () => {
    const entry = makeEntry('Multi Field', { customFields: { era: ['medieval'], location: ['castle'] } });
    const policy = buildExemptionPolicy([], [], []);

    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
        { name: 'location', label: 'Location', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'location' },
    ];
    const context = { era: ['medieval'], location: ['forest'] }; // era matches, location doesn't
    const result = applyContextualGating([entry], context, policy, false, makeSettings({ contextualGatingTolerance: 'strict' }), fieldDefs);
    assertEqual(result.length, 0, 'C6: entry that fails any field should be blocked');
});

test('C7: No context dimensions set at all → all entries pass (short-circuit)', () => {
    const entry = makeEntry('Any Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);
    const context = {}; // no context set
    const result = applyContextualGating([entry], context, policy, false, makeSettings(), DEFAULT_FIELD_DEFINITIONS);
    assertEqual(result.length, 1, 'C7: no context dimensions → all entries should pass');
});

test('C8: ForceInject entry passes regardless of gating failure', () => {
    const constant = makeEntry('Always Here', { constant: true, customFields: { era: ['medieval'] } });
    const normal = makeEntry('Normal Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([constant, normal], [], []);

    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const context = { era: ['futuristic'] }; // doesn't match medieval
    const result = applyContextualGating([constant, normal], context, policy, false, makeSettings(), fieldDefs);
    assert(result.some(e => e.title === 'Always Here'), 'C8: forceInject entry should pass gating');
    assert(!result.some(e => e.title === 'Normal Entry'), 'C8: normal entry should be gated');
});

test('C9: No field definitions → all entries pass', () => {
    const entry = makeEntry('Any Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);
    const context = { era: ['futuristic'] };
    const result = applyContextualGating([entry], context, policy, false, makeSettings(), []);
    assertEqual(result.length, 1, 'C9: no field definitions → all entries pass');
});

test('C10: Fallback tolerance from settings when field has no tolerance', () => {
    const entry = makeEntry('Test Entry', { customFields: { era: ['medieval'] } });
    const policy = buildExemptionPolicy([], [], []);

    // Field def has no tolerance → falls back to settings.contextualGatingTolerance
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any' }, values: [], contextKey: 'era' },
    ];
    const context = { era: ['futuristic'] };
    // With lenient fallback, match_any non-match passes
    const result = applyContextualGating([entry], context, policy, false, makeSettings({ contextualGatingTolerance: 'lenient' }), fieldDefs);
    assertEqual(result.length, 1, 'C10: lenient fallback tolerance should pass match_any non-match');
});

// ============================================================================
// D. Requires/Excludes Cascading
// ============================================================================

section('D. Requires/Excludes Cascading');

test('D1: A requires B, B present → A kept', () => {
    const A = makeEntry('A', { requires: ['B'] });
    const B = makeEntry('B');
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([A, B], policy, false);
    assert(result.some(e => e.title === 'A'), 'D1: A should be kept when B is present');
    assert(result.some(e => e.title === 'B'), 'D1: B should be kept');
});

test('D2: A requires B, B absent → A removed', () => {
    const A = makeEntry('A', { requires: ['B'] });
    const policy = buildExemptionPolicy([], [], []);
    const { result, removed } = applyRequiresExcludesGating([A], policy, false);
    assert(!result.some(e => e.title === 'A'), 'D2: A should be removed when B is absent');
    assert(removed.some(e => e.title === 'A'), 'D2: A should be in removed list');
});

test('D3: A requires B, B requires C, C absent → both A and B removed (cascade)', () => {
    const A = makeEntry('A', { requires: ['B'] });
    const B = makeEntry('B', { requires: ['C'] });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([A, B], policy, false);
    assert(!result.some(e => e.title === 'A'), 'D3: A should be removed (cascade)');
    assert(!result.some(e => e.title === 'B'), 'D3: B should be removed (cascade)');
});

test('D4: A excludes B, B present → A removed', () => {
    const A = makeEntry('A', { excludes: ['B'], priority: 100 });
    const B = makeEntry('B', { priority: 50 });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([A, B], policy, false);
    // B has higher priority (lower number), A excludes B but B is higher priority
    // The algorithm processes lower-priority first (descending by priority number)
    // A (100) is processed first, sees B present → removed
    assert(!result.some(e => e.title === 'A'), 'D4: A should be removed when it excludes B and B is present');
    assert(result.some(e => e.title === 'B'), 'D4: B should be kept');
});

test('D5: A excludes B, B absent → A kept', () => {
    const A = makeEntry('A', { excludes: ['B'] });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([A], policy, false);
    assert(result.some(e => e.title === 'A'), 'D5: A should be kept when B is absent');
});

test('D6: Circular — A requires B, B excludes A → both removed', () => {
    const A = makeEntry('A', { requires: ['B'], priority: 100 });
    const B = makeEntry('B', { excludes: ['A'], priority: 50 });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([A, B], policy, false);
    // Processing order: A(100) first, B(50) last.
    // Iteration 1: A passes requires (B present), B sees A present → excludes → B removed.
    // Iteration 2: A requires B, B now absent → A removed.
    // Both dropped due to circular dependency.
    assert(!result.some(e => e.title === 'A'), 'D6: A should be removed (circular)');
    assert(!result.some(e => e.title === 'B'), 'D6: B should also be removed (circular)');
});

test('D7: Priority ordering — higher priority entry survives excludes', () => {
    // Lower priority number = higher priority
    const high = makeEntry('HighPri', { excludes: ['LowPri'], priority: 10 });
    const low = makeEntry('LowPri', { excludes: ['HighPri'], priority: 100 });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([high, low], policy, false);

    // Processing order: descending by priority number (low=100 first, high=10 last)
    // low (100) processed first — sees HighPri present → removed
    // high (10) processed last — LowPri already gone → survives
    assert(result.some(e => e.title === 'HighPri'), 'D7: higher priority entry should survive excludes');
    assert(!result.some(e => e.title === 'LowPri'), 'D7: lower priority entry should be removed');
});

test('D8: ForceInject entry keeps its requires even if they would fail', () => {
    const constant = makeEntry('Constant', { constant: true, requires: ['Missing'] });
    const policy = buildExemptionPolicy([constant], [], []);
    const { result } = applyRequiresExcludesGating([constant], policy, false);
    assert(result.some(e => e.title === 'Constant'), 'D8: forceInject entry should survive failed requires');
});

test('D9: Result sorted ascending by priority for budget (BUG-012)', () => {
    const p100 = makeEntry('Low', { priority: 100 });
    const p10 = makeEntry('High', { priority: 10 });
    const p50 = makeEntry('Medium', { priority: 50 });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([p100, p10, p50], policy, false);

    assertEqual(result[0].title, 'High', 'D9: first entry should be highest priority (10)');
    assertEqual(result[1].title, 'Medium', 'D9: second entry should be medium priority (50)');
    assertEqual(result[2].title, 'Low', 'D9: third entry should be lowest priority (100)');
});

test('D10: Max iterations guard (10 iterations)', () => {
    // Create entries that would cause infinite loop without guard
    // A requires B, B requires A (non-converging with excludes wouldn't stabilize)
    // In practice, once both are removed, the loop stabilizes — so just check it completes
    const entries = [];
    for (let i = 0; i < 20; i++) {
        entries.push(makeEntry(`E${i}`, { requires: [`E${(i + 1) % 20}`] }));
    }
    // Remove one to break the chain
    const missing = entries.splice(10, 1);
    const policy = buildExemptionPolicy([], [], []);
    // Should not throw or hang
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    assertNotNull(result, 'D10: should complete without hanging');
});

test('D11: Empty requires/excludes → entry kept', () => {
    const entry = makeEntry('No Deps', { requires: [], excludes: [] });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([entry], policy, false);
    assert(result.some(e => e.title === 'No Deps'), 'D11: entry with empty requires/excludes should be kept');
});

test('D12: ForceInject entry ignores excludes targeting it', () => {
    const constant = makeEntry('Constant', { constant: true, priority: 50 });
    const excluder = makeEntry('Excluder', { excludes: ['Constant'], priority: 100 });
    const policy = buildExemptionPolicy([constant], [], []);
    const { result } = applyRequiresExcludesGating([constant, excluder], policy, false);
    // Constant is forceInject, so it always stays. Excluder sees Constant present → removed.
    // Wait — excluder excludes Constant meaning excluder should be removed if Constant is present
    assert(result.some(e => e.title === 'Constant'), 'D12: forceInject entry should be kept');
    assert(!result.some(e => e.title === 'Excluder'), 'D12: excluder should be removed since Constant is present');
});

test('D13: Multiple requires — all must be present', () => {
    const A = makeEntry('A', { requires: ['B', 'C'] });
    const B = makeEntry('B');
    // C is absent
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([A, B], policy, false);
    assert(!result.some(e => e.title === 'A'), 'D13: A should be removed when not all requires are present');
});

// ============================================================================
// E. Cooldown + Tracking Lifecycle
// ============================================================================

section('E. Cooldown + Tracking Lifecycle');

test('E1: trackGeneration sets cooldown to cooldown+1 (pre-decrement compensation)', () => {
    const entry = makeEntry('Cooldown Entry', { cooldown: 3, vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings();

    trackGeneration([entry], 1, cooldownTracker, decayTracker, injectionHistory, settings);

    assertEqual(cooldownTracker.get(trackerKey(entry)), 4, 'E1: cooldown should be set to cooldown+1 (3+1=4)');
});

test('E2: decrementTrackers reduces cooldown by 1 each generation', () => {
    const cooldownTracker = new Map();
    cooldownTracker.set(':CoolEntry', 4);
    const decayTracker = new Map();
    const settings = makeSettings();

    decrementTrackers(cooldownTracker, decayTracker, [], settings);

    assertEqual(cooldownTracker.get(':CoolEntry'), 3, 'E2: cooldown should decrement from 4 to 3');
});

test('E3: Cooldown expires after correct number of generations', () => {
    const entry = makeEntry('Cooldown Entry', { cooldown: 2, vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings();

    // Inject: sets cooldown to 3 (2+1)
    trackGeneration([entry], 1, cooldownTracker, decayTracker, injectionHistory, settings);
    assertEqual(cooldownTracker.get(trackerKey(entry)), 3, 'E3: initial cooldown should be 3');

    // Gen 2: decrement to 2
    decrementTrackers(cooldownTracker, decayTracker, [], settings);
    assertEqual(cooldownTracker.get(trackerKey(entry)), 2, 'E3: after 1 gen should be 2');

    // Gen 3: decrement to 1
    decrementTrackers(cooldownTracker, decayTracker, [], settings);
    assertEqual(cooldownTracker.get(trackerKey(entry)), 1, 'E3: after 2 gens should be 1');

    // Gen 4: reaches 0 → deleted
    decrementTrackers(cooldownTracker, decayTracker, [], settings);
    assert(!cooldownTracker.has(trackerKey(entry)), 'E3: cooldown should be deleted after expiry');
});

test('E4: Reinjection cooldown filters recently injected entries', () => {
    const entry = makeEntry('Recent Entry', { vaultSource: 'TestVault' });
    const policy = buildExemptionPolicy([], [], []);
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(entry), 5); // injected at gen 5

    const result = applyReinjectionCooldown([entry], policy, injectionHistory, 6, 3, false);
    assertEqual(result.length, 0, 'E4: recently injected entry should be filtered (gen 6, injected at 5, cooldown 3)');
});

test('E5: ForceInject entries skip reinjection cooldown', () => {
    const constant = makeEntry('Constant Entry', { constant: true, vaultSource: 'TestVault' });
    const policy = buildExemptionPolicy([constant], [], []);
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(constant), 5);

    const result = applyReinjectionCooldown([constant], policy, injectionHistory, 6, 3, false);
    assertEqual(result.length, 1, 'E5: forceInject entry should skip reinjection cooldown');
});

test('E6: Cooldown 0 setting → no filtering (no-op)', () => {
    const entry = makeEntry('Any Entry', { vaultSource: 'TestVault' });
    const policy = buildExemptionPolicy([], [], []);
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(entry), 5);

    const result = applyReinjectionCooldown([entry], policy, injectionHistory, 6, 0, false);
    assertEqual(result.length, 1, 'E6: cooldown 0 should be a no-op');
});

test('E7: Decay tracking — injected entries reset to 0, non-injected increment', () => {
    const injected = makeEntry('Injected', { vaultSource: 'TestVault' });
    const stale = makeEntry('Stale', { vaultSource: 'TestVault' });

    const cooldownTracker = new Map();
    const decayTracker = new Map();
    decayTracker.set(trackerKey(stale), 3); // already stale for 3 gens
    const settings = makeSettings({ decayEnabled: true });

    // Inject 'Injected', not 'Stale'
    decrementTrackers(cooldownTracker, decayTracker, [injected], settings);

    assertEqual(decayTracker.get(trackerKey(injected)), 0, 'E7: injected entry decay should reset to 0');
    assertEqual(decayTracker.get(trackerKey(stale)), 4, 'E7: non-injected entry decay should increment');
});

test('E8: Consecutive injection counter — tracks streaks, breaks on non-injection', () => {
    const entry = makeEntry('Streak Entry', { vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const consecutive = new Map();
    const settings = makeSettings();

    // Gen 1: injected
    decrementTrackers(cooldownTracker, decayTracker, [entry], settings, consecutive);
    assertEqual(consecutive.get(trackerKey(entry)), 1, 'E8: first injection should be 1');

    // Gen 2: injected again
    decrementTrackers(cooldownTracker, decayTracker, [entry], settings, consecutive);
    assertEqual(consecutive.get(trackerKey(entry)), 2, 'E8: second injection should be 2');

    // Gen 3: NOT injected
    decrementTrackers(cooldownTracker, decayTracker, [], settings, consecutive);
    assert(!consecutive.has(trackerKey(entry)), 'E8: non-injection should break streak (delete key)');
});

test('E9: Decay prune threshold — entries pruned at 2x decayBoostThreshold (BUG-H10)', () => {
    const stale = makeEntry('Very Stale', { vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    // decayBoostThreshold = 5, so pruneThreshold = 10
    // Set staleness to 9 — after increment it becomes 10 which is >= pruneThreshold → pruned
    decayTracker.set(trackerKey(stale), 9);
    const settings = makeSettings({ decayEnabled: true, decayBoostThreshold: 5 });

    decrementTrackers(cooldownTracker, decayTracker, [], settings);

    assert(!decayTracker.has(trackerKey(stale)), 'E9: entry at 2x threshold should be pruned');
});

test('E10: Decay prune threshold — entry at threshold-1 NOT pruned', () => {
    const stale = makeEntry('Almost Stale', { vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    // decayBoostThreshold = 5, pruneThreshold = 10
    // Set staleness to 8 — after increment it becomes 9, which is < 10 → NOT pruned
    decayTracker.set(trackerKey(stale), 8);
    const settings = makeSettings({ decayEnabled: true, decayBoostThreshold: 5 });

    decrementTrackers(cooldownTracker, decayTracker, [], settings);

    assert(decayTracker.has(trackerKey(stale)), 'E10: entry below prune threshold should be kept');
    assertEqual(decayTracker.get(trackerKey(stale)), 9, 'E10: staleness should be 9');
});

test('E11: trackGeneration records injection history when reinjectionCooldown > 0', () => {
    const entry = makeEntry('History Entry', { vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings({ reinjectionCooldown: 3 });

    trackGeneration([entry], 5, cooldownTracker, decayTracker, injectionHistory, settings);

    // Records generationCount + 1
    assertEqual(injectionHistory.get(trackerKey(entry)), 6, 'E11: injection history should record genCount+1');
});

test('E12: trackGeneration does NOT record injection history when reinjectionCooldown is 0', () => {
    const entry = makeEntry('No History', { vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings({ reinjectionCooldown: 0 });

    trackGeneration([entry], 5, cooldownTracker, decayTracker, injectionHistory, settings);

    assert(!injectionHistory.has(trackerKey(entry)), 'E12: no injection history when cooldown is 0');
});

// ============================================================================
// F. Strip Dedup Interactions
// ============================================================================

section('F. Strip Dedup Interactions');

test('F1: Entry with same title+position+depth+role+contentHash in recent log → stripped', () => {
    const entry = makeEntry('Dedup Entry', { injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });
    entry._contentHash = 'abc123';
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Dedup Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc123' }],
    }];
    const result = applyStripDedup([entry], policy, injectionLog, 3, settings, false);
    assertEqual(result.length, 0, 'F1: duplicate entry should be stripped');
});

test('F2: Different position → not stripped (different injection context)', () => {
    const entry = makeEntry('Pos Entry', { injectionPosition: 2, injectionDepth: 4, injectionRole: 'system' });
    entry._contentHash = 'abc123';
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Pos Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc123' }],
    }];
    const result = applyStripDedup([entry], policy, injectionLog, 3, settings, false);
    assertEqual(result.length, 1, 'F2: different position should not strip');
});

test('F3: ForceInject entry → not stripped', () => {
    const constant = makeEntry('Always Entry', { constant: true, injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });
    constant._contentHash = 'abc123';
    const policy = buildExemptionPolicy([constant], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Always Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc123' }],
    }];
    const result = applyStripDedup([constant], policy, injectionLog, 3, settings, false);
    assertEqual(result.length, 1, 'F3: forceInject entry should not be stripped');
});

test('F4: Empty injection log → no-op', () => {
    const entry = makeEntry('Any Entry');
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings();
    const result = applyStripDedup([entry], policy, [], 3, settings, false);
    assertEqual(result.length, 1, 'F4: empty injection log should not strip anything');
});

test('F5: Lookback depth 0 → dedup disabled (M-4 fix, 2026-05-22)', () => {
    // M-4 (2026-05-22): previously `lookbackDepth=0` was a footgun — `arr.slice(-0)`
    // returns the entire array, so callers asking for "no lookback" silently got
    // "lookback against ALL history." Now `<= 0` is an explicit no-op that matches
    // the semantic the parameter name implies. UI still clamps to min 1; this
    // guards external callers (`/dle-why`, future programmatic call sites).
    const entry = makeEntry('Any Entry', { injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });
    entry._contentHash = 'abc123';
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Any Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc123' }],
    }];
    const result = applyStripDedup([entry], policy, injectionLog, 0, settings, false);
    assertEqual(result.length, 1, 'F5: lookbackDepth=0 should be a no-op (no dedup applied)');
});

test('F5b: Negative lookback depth → dedup disabled (M-4 defense-in-depth)', () => {
    const entry = makeEntry('Negative Entry', { injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });
    entry._contentHash = 'abc123';
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Negative Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc123' }],
    }];
    const result = applyStripDedup([entry], policy, injectionLog, -5, settings, false);
    assertEqual(result.length, 1, 'F5b: negative lookback should be a no-op');
});

test('F6: Entry with no contentHash vs log with contentHash → not stripped (hash mismatch)', () => {
    const entry = makeEntry('Hash Entry', { injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });
    // no _contentHash on entry (defaults to '')
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Hash Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc123' }],
    }];
    const result = applyStripDedup([entry], policy, injectionLog, 3, settings, false);
    assertEqual(result.length, 1, 'F6: mismatched contentHash should not strip');
});

test('F7: Entry uses default settings position/depth/role when not set per-entry', () => {
    const entry = makeEntry('Default PosEntry');
    // No injectionPosition/Depth/Role set → uses null → falls back to settings defaults
    entry._contentHash = 'xyz';
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    const injectionLog = [{
        entries: [{ title: 'Default PosEntry', pos: 1, depth: 4, role: 'system', contentHash: 'xyz' }],
    }];
    const result = applyStripDedup([entry], policy, injectionLog, 3, settings, false);
    assertEqual(result.length, 0, 'F7: entry with null pos/depth/role should use settings defaults for dedup');
});

test('F8: Only recent logs within lookback window are checked', () => {
    const entry = makeEntry('Old Entry', { injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });
    entry._contentHash = 'abc';
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ injectionPosition: 1, injectionDepth: 4, injectionRole: 'system' });

    // 5 log entries, but lookback is 2 — only last 2 are checked
    const injectionLog = [
        { entries: [{ title: 'Old Entry', pos: 1, depth: 4, role: 'system', contentHash: 'abc' }] },
        { entries: [] },
        { entries: [] },
        { entries: [] },
        { entries: [] },
    ];
    const result = applyStripDedup([entry], policy, injectionLog, 2, settings, false);
    assertEqual(result.length, 1, 'F8: old log entries outside lookback window should not cause stripping');
});

// ============================================================================
// G. Full Pipeline Flow
// ============================================================================

section('G. Full Pipeline Flow');

test('G1: Entry that survives all stages makes it through', () => {
    const entry = makeEntry('Survivor', {
        keys: ['dragon'], priority: 50, vaultSource: 'TestVault',
        customFields: { era: ['medieval'] },
    });
    const vault = [entry];
    const settings = makeSettings({ reinjectionCooldown: 0 });

    // Build policy
    const policy = buildExemptionPolicy(vault, [], []);
    // Pin/block (no pins/blocks)
    let entries = applyPinBlock([entry], vault, policy, new Map());
    // Contextual gating (no context set → passes)
    entries = applyContextualGating(entries, {}, policy, false, settings, DEFAULT_FIELD_DEFINITIONS);
    // Folder filter (no folders set → passes)
    entries = applyFolderFilter(entries, null, policy, false);
    // Reinjection cooldown (cooldown 0 → no-op)
    entries = applyReinjectionCooldown(entries, policy, new Map(), 1, 0, false);
    // Requires/excludes (none → passes)
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    // Strip dedup (no log → no-op)
    const final = applyStripDedup(result, policy, [], 3, settings, false);

    assertEqual(final.length, 1, 'G1: survivor entry should make it through all stages');
    assertEqual(final[0].title, 'Survivor', 'G1: should be the correct entry');
});

test('G2: Entry blocked at gating does not appear in final output', () => {
    const entry = makeEntry('Gated Out', {
        priority: 50, vaultSource: 'TestVault',
        customFields: { era: ['medieval'] },
    });
    const vault = [entry];
    const settings = makeSettings({ reinjectionCooldown: 0 });
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];

    const policy = buildExemptionPolicy(vault, [], []);
    let entries = applyPinBlock([entry], vault, policy, new Map());
    entries = applyContextualGating(entries, { era: ['futuristic'] }, policy, false, settings, fieldDefs);
    entries = applyFolderFilter(entries, null, policy, false);
    entries = applyReinjectionCooldown(entries, policy, new Map(), 1, 0, false);
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    const final = applyStripDedup(result, policy, [], 3, settings, false);

    assertEqual(final.length, 0, 'G2: gated entry should not appear in final output');
});

test('G3: Pinned entry bypasses gating, cooldown, and requires/excludes', () => {
    const pinned = makeEntry('Pinned Hero', {
        priority: 50, vaultSource: 'TestVault',
        customFields: { era: ['medieval'] },
        requires: ['Missing Dep'],
    });
    const vault = [pinned];
    const settings = makeSettings({ reinjectionCooldown: 3 });
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];

    const policy = buildExemptionPolicy(vault, ['Pinned Hero'], []);
    let entries = applyPinBlock([], vault, policy, new Map());

    // Gating with non-matching era
    entries = applyContextualGating(entries, { era: ['futuristic'] }, policy, false, settings, fieldDefs);

    // Reinjection cooldown (recently injected)
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(pinned), 5);
    entries = applyReinjectionCooldown(entries, policy, injectionHistory, 6, 3, false);

    // Requires/excludes (requires missing entry)
    const { result } = applyRequiresExcludesGating(entries, policy, false);

    // Strip dedup (in recent log)
    const injectionLog = [{
        entries: [{ title: 'Pinned Hero', pos: 1, depth: 4, role: 'system', contentHash: '' }],
    }];
    const final = applyStripDedup(result, policy, injectionLog, 3, settings, false);

    assert(final.some(e => e.title === 'Pinned Hero'), 'G3: pinned entry should bypass all gating stages');
});

test('G4: Budget order is correct — priority ascending after all stages', () => {
    const entries = [
        makeEntry('Low Pri', { priority: 100 }),
        makeEntry('High Pri', { priority: 10 }),
        makeEntry('Med Pri', { priority: 50 }),
    ];
    const vault = entries;
    const settings = makeSettings({ reinjectionCooldown: 0 });
    const policy = buildExemptionPolicy(vault, [], []);

    let pipeline = applyPinBlock([...entries], vault, policy, new Map());
    pipeline = applyContextualGating(pipeline, {}, policy, false, settings, DEFAULT_FIELD_DEFINITIONS);
    pipeline = applyReinjectionCooldown(pipeline, policy, new Map(), 1, 0, false);
    const { result } = applyRequiresExcludesGating(pipeline, policy, false);

    assertEqual(result[0].title, 'High Pri', 'G4: first entry should be highest priority');
    assertEqual(result[1].title, 'Med Pri', 'G4: second should be medium');
    assertEqual(result[2].title, 'Low Pri', 'G4: third should be lowest');
});

test('G5: Analytics records both matched and injected counts correctly', () => {
    const matched = makeEntry('Matched', { vaultSource: 'TestVault' });
    const injected = makeEntry('Injected', { vaultSource: 'TestVault' });
    const analyticsData = {};

    recordAnalytics([matched, injected], [injected], analyticsData);

    const matchedKey = trackerKey(matched);
    const injectedKey = trackerKey(injected);

    assertNotNull(analyticsData[matchedKey], 'G5: matched entry should be in analytics');
    assertEqual(analyticsData[matchedKey].matched, 1, 'G5: matched count should be 1');
    assertEqual(analyticsData[matchedKey].injected, 0, 'G5: matched-only entry should have injected=0');

    assertNotNull(analyticsData[injectedKey], 'G5: injected entry should be in analytics');
    assertEqual(analyticsData[injectedKey].matched, 1, 'G5: injected entry matched count should be 1');
    assertEqual(analyticsData[injectedKey].injected, 1, 'G5: injected entry injected count should be 1');
});

test('G6: Tracker state is consistent after trackGeneration + decrementTrackers', () => {
    const entryA = makeEntry('A', { cooldown: 2, vaultSource: 'TestVault' });
    const entryB = makeEntry('B', { cooldown: 1, vaultSource: 'TestVault' });

    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings({ reinjectionCooldown: 5, decayEnabled: true });

    // Track: A gets cooldown 3, B gets cooldown 2
    trackGeneration([entryA, entryB], 1, cooldownTracker, decayTracker, injectionHistory, settings);

    assertEqual(cooldownTracker.get(trackerKey(entryA)), 3, 'G6: A cooldown should be 3');
    assertEqual(cooldownTracker.get(trackerKey(entryB)), 2, 'G6: B cooldown should be 2');

    // Decrement: A→2, B→1
    decrementTrackers(cooldownTracker, decayTracker, [entryA, entryB], settings);
    assertEqual(cooldownTracker.get(trackerKey(entryA)), 2, 'G6: A cooldown after decrement should be 2');
    assertEqual(cooldownTracker.get(trackerKey(entryB)), 1, 'G6: B cooldown after decrement should be 1');

    // Decrement again: A→1, B deleted
    decrementTrackers(cooldownTracker, decayTracker, [], settings);
    assertEqual(cooldownTracker.get(trackerKey(entryA)), 1, 'G6: A cooldown should be 1');
    assert(!cooldownTracker.has(trackerKey(entryB)), 'G6: B cooldown should be expired');

    // Injection history should be set
    assertEqual(injectionHistory.get(trackerKey(entryA)), 2, 'G6: A injection history should be gen+1');
    assertEqual(injectionHistory.get(trackerKey(entryB)), 2, 'G6: B injection history should be gen+1');
});

test('G7: Blocked entry removed before gating runs — does not waste gating computation', () => {
    const blocked = makeEntry('Blocked', {
        customFields: { era: ['medieval'] },
        vaultSource: 'TestVault',
    });
    const normal = makeEntry('Normal', { vaultSource: 'TestVault' });
    const vault = [blocked, normal];
    const settings = makeSettings();
    const policy = buildExemptionPolicy(vault, [], ['Blocked']);

    let entries = applyPinBlock([blocked, normal], vault, policy, new Map());
    assert(!entries.some(e => e.title === 'Blocked'), 'G7: blocked entry should be removed by pin/block stage');
    assert(entries.some(e => e.title === 'Normal'), 'G7: normal entry should remain');
});

test('G8: Constant entry survives entire pipeline even with hostile gating context', () => {
    const constant = makeEntry('World Rules', {
        constant: true, priority: 5, vaultSource: 'TestVault',
        customFields: { era: ['ancient'] },
        requires: ['NonExistent'],
    });
    const vault = [constant];
    const settings = makeSettings({ reinjectionCooldown: 5 });
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const policy = buildExemptionPolicy(vault, [], []);

    let entries = applyPinBlock([constant], vault, policy, new Map());
    entries = applyContextualGating(entries, { era: ['futuristic'] }, policy, false, settings, fieldDefs);
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(constant), 10);
    entries = applyReinjectionCooldown(entries, policy, injectionHistory, 11, 5, false);
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    const injectionLog = [{
        entries: [{ title: 'World Rules', pos: 1, depth: 4, role: 'system', contentHash: '' }],
    }];
    const final = applyStripDedup(result, policy, injectionLog, 3, settings, false);

    assert(final.some(e => e.title === 'World Rules'), 'G8: constant entry should survive entire hostile pipeline');
});

test('G9: Seed entry is in forceInject and survives gating', () => {
    const seed = makeEntry('Story Seed', {
        seed: true, vaultSource: 'TestVault',
        customFields: { era: ['ancient'] },
    });
    const vault = [seed];
    const settings = makeSettings();
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const policy = buildExemptionPolicy(vault, [], []);

    let entries = applyContextualGating([seed], { era: ['modern'] }, policy, false, settings, fieldDefs);
    assert(entries.some(e => e.title === 'Story Seed'), 'G9: seed entry should survive contextual gating');
});

test('G10: recordAnalytics accumulates across multiple calls', () => {
    const entry = makeEntry('Popular Entry', { vaultSource: 'TestVault' });
    const analyticsData = {};

    recordAnalytics([entry], [entry], analyticsData);
    recordAnalytics([entry], [], analyticsData);
    recordAnalytics([entry], [entry], analyticsData);

    const key = trackerKey(entry);
    assertEqual(analyticsData[key].matched, 3, 'G10: matched count should accumulate');
    assertEqual(analyticsData[key].injected, 2, 'G10: injected count should accumulate');
});

test('G11: Multiple entries — mixed fates through full pipeline', () => {
    const constant = makeEntry('Always', { constant: true, priority: 5, vaultSource: 'TestVault' });
    const gatedOut = makeEntry('Wrong Era', { priority: 50, vaultSource: 'TestVault', customFields: { era: ['medieval'] } });
    const depsOk = makeEntry('Has Dep', { priority: 30, requires: ['Always'], vaultSource: 'TestVault' });
    const depsMissing = makeEntry('Missing Dep', { priority: 40, requires: ['NonExistent'], vaultSource: 'TestVault' });

    const vault = [constant, gatedOut, depsOk, depsMissing];
    const settings = makeSettings({ reinjectionCooldown: 0 });
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const policy = buildExemptionPolicy(vault, [], []);

    let entries = applyPinBlock([constant, gatedOut, depsOk, depsMissing], vault, policy, new Map());
    entries = applyContextualGating(entries, { era: ['futuristic'] }, policy, false, settings, fieldDefs);
    entries = applyReinjectionCooldown(entries, policy, new Map(), 1, 0, false);
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    const final = applyStripDedup(result, policy, [], 3, settings, false);

    const titles = final.map(e => e.title);
    assert(titles.includes('Always'), 'G11: constant should survive');
    assert(!titles.includes('Wrong Era'), 'G11: wrong era entry should be gated');
    assert(titles.includes('Has Dep'), 'G11: entry with met dependency should survive');
    assert(!titles.includes('Missing Dep'), 'G11: entry with missing dependency should be removed');
});

// ============================================================================
// H. Folder Filter
// ============================================================================

section('H. Folder Filter');

test('H1: Root entries always pass', () => {
    const rootEntry = makeEntry('Root Entry');
    // No folderPath = root
    const policy = buildExemptionPolicy([], [], []);
    const result = applyFolderFilter([rootEntry], ['Characters/NPCs'], policy, false);
    assertEqual(result.length, 1, 'H1: root entry should always pass folder filter');
});

test('H2: Subfolder matching — exact path', () => {
    const entry = makeEntry('NPC', { vaultSource: 'TestVault' });
    entry.folderPath = 'Characters/NPCs';
    const policy = buildExemptionPolicy([], [], []);
    const result = applyFolderFilter([entry], ['Characters/NPCs'], policy, false);
    assertEqual(result.length, 1, 'H2: exact folder path should match');
});

test('H3: Subfolder matching — nested path', () => {
    const entry = makeEntry('Deep NPC');
    entry.folderPath = 'Characters/NPCs/Villains';
    const policy = buildExemptionPolicy([], [], []);
    const result = applyFolderFilter([entry], ['Characters/NPCs'], policy, false);
    assertEqual(result.length, 1, 'H3: nested subfolder should match parent');
});

test('H4: ForceInject entries pass regardless of folder', () => {
    const constant = makeEntry('World Constant', { constant: true });
    constant.folderPath = 'Hidden/Folder';
    const policy = buildExemptionPolicy([constant], [], []);
    const result = applyFolderFilter([constant], ['Characters'], policy, false);
    assertEqual(result.length, 1, 'H4: forceInject entry should pass folder filter');
});

test('H5: Null/empty selectedFolders → no filtering', () => {
    const entry = makeEntry('Any Entry');
    entry.folderPath = 'Some/Deep/Path';
    const policy = buildExemptionPolicy([], [], []);

    const resultNull = applyFolderFilter([entry], null, policy, false);
    assertEqual(resultNull.length, 1, 'H5: null folders should not filter');

    const resultEmpty = applyFolderFilter([entry], [], policy, false);
    assertEqual(resultEmpty.length, 1, 'H5: empty folders should not filter');
});

test('H6: Entry outside all selected folders → removed', () => {
    const entry = makeEntry('Wrong Folder');
    entry.folderPath = 'Locations/Cities';
    const policy = buildExemptionPolicy([], [], []);
    const result = applyFolderFilter([entry], ['Characters', 'Items'], policy, false);
    assertEqual(result.length, 0, 'H6: entry outside selected folders should be removed');
});

test('H7: Folder filter does not match partial folder names', () => {
    const entry = makeEntry('Partial Match');
    entry.folderPath = 'Characters-old/NPCs';
    const policy = buildExemptionPolicy([], [], []);
    // 'Characters' should NOT match 'Characters-old' (startsWith 'Characters/' would fail)
    const result = applyFolderFilter([entry], ['Characters'], policy, false);
    assertEqual(result.length, 0, 'H7: partial folder name should not match');
});

// ============================================================================
// I. Cross-Stage Edge Cases
// ============================================================================

section('I. Cross-Stage Edge Cases');

test('I1: trackerKey uses vaultSource:title format', () => {
    const entry = makeEntry('Test', { vaultSource: 'MyVault' });
    assertEqual(trackerKey(entry), 'MyVault:Test', 'I1: trackerKey should be vaultSource:title');
});

test('I2: trackerKey with empty vaultSource', () => {
    const entry = makeEntry('Test');
    assertEqual(trackerKey(entry), ':Test', 'I2: trackerKey with empty vaultSource should be :title');
});

test('I3: recordAnalytics prunes stale entries (30+ days old)', () => {
    const analyticsData = {};
    const staleKey = 'TestVault:Stale';
    analyticsData[staleKey] = {
        matched: 10,
        injected: 5,
        lastTriggered: Date.now() - (31 * 24 * 60 * 60 * 1000), // 31 days ago
    };

    const entry = makeEntry('Fresh', { vaultSource: 'TestVault' });
    recordAnalytics([entry], [entry], analyticsData);

    assert(!analyticsData[staleKey], 'I3: stale analytics entry should be pruned');
    assertNotNull(analyticsData[trackerKey(entry)], 'I3: fresh analytics entry should remain');
});

test('I4: recordAnalytics caps at 500 entries (evicts oldest)', () => {
    const analyticsData = {};
    const now = Date.now();

    // Create 501 entries
    for (let i = 0; i < 501; i++) {
        analyticsData[`V:Entry${i}`] = { matched: 1, injected: 0, lastTriggered: now - (500 - i) * 1000 };
    }

    const entry = makeEntry('New', { vaultSource: 'V' });
    recordAnalytics([entry], [entry], analyticsData);

    const keyCount = Object.keys(analyticsData).length;
    assertLessThan(keyCount, 502, 'I4: analytics should be capped at ~500 entries');
});

test('I5: Pin adds entry to matchedKeys map', () => {
    const entry = makeEntry('Pinned Target');
    const vault = [entry];
    const policy = buildExemptionPolicy(vault, ['Pinned Target'], []);
    const matchedKeys = new Map();

    applyPinBlock([], vault, policy, matchedKeys);

    assertEqual(matchedKeys.get(':Pinned Target'), '(pinned)', 'I5: pinned entry should be in matchedKeys with (pinned) — trackerKey ":title"');
});

test('I6: Cooldown entry with null cooldown not tracked', () => {
    const entry = makeEntry('No Cooldown', { cooldown: null, vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings();

    trackGeneration([entry], 1, cooldownTracker, decayTracker, injectionHistory, settings);

    assert(!cooldownTracker.has(trackerKey(entry)), 'I6: null cooldown should not be tracked');
});

test('I7: Cooldown entry with 0 cooldown not tracked', () => {
    const entry = makeEntry('Zero Cooldown', { cooldown: 0, vaultSource: 'TestVault' });
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injectionHistory = new Map();
    const settings = makeSettings();

    trackGeneration([entry], 1, cooldownTracker, decayTracker, injectionHistory, settings);

    assert(!cooldownTracker.has(trackerKey(entry)), 'I7: cooldown=0 should not be tracked');
});

test('I8: Reinjection cooldown respects generation distance', () => {
    const entry = makeEntry('Timed Entry', { vaultSource: 'TestVault' });
    const policy = buildExemptionPolicy([], [], []);
    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(entry), 5); // injected at gen 5

    // Gen 6: distance = 1, cooldown = 3 → filtered
    let result = applyReinjectionCooldown([entry], policy, injectionHistory, 6, 3, false);
    assertEqual(result.length, 0, 'I8: gen 6 should be filtered (distance 1 < cooldown 3)');

    // Gen 7: distance = 2, cooldown = 3 → filtered
    result = applyReinjectionCooldown([entry], policy, injectionHistory, 7, 3, false);
    assertEqual(result.length, 0, 'I8: gen 7 should be filtered (distance 2 < cooldown 3)');

    // Gen 8: distance = 3, cooldown = 3 → passes (3 >= 3 is false, 8-5=3 which is not < 3)
    result = applyReinjectionCooldown([entry], policy, injectionHistory, 8, 3, false);
    assertEqual(result.length, 1, 'I8: gen 8 should pass (distance 3 is not < cooldown 3)');
});

test('I9: Bootstrap exemption is gen-scoped to bootstrapActive (Stages H-3 / gotcha #60)', () => {
    // BEHAVIOR CHANGE 2026-05-22 (Stages H-3): bootstrap entries are force-injected
    // ONLY when bootstrapActive=true. Pre-fix, buildExemptionPolicy ignored the flag
    // entirely and bootstrap entries silently bypassed every post-pipeline stage
    // (contextual gating, requires/excludes, cooldown, strip-dedup, folder filter),
    // even late in a chat when bootstrap was logically off.
    //
    // This test verifies BOTH halves of the contract:
    //   (a) bootstrapActive=true  → bootstrap is in forceInject and survives all stages
    //   (b) bootstrapActive=false → bootstrap is NOT in forceInject and is gated normally
    const bootstrap = makeEntry('Intro', {
        bootstrap: true, vaultSource: 'TestVault',
        customFields: { era: ['future'] },
        requires: ['NonExistent'],
    });
    const vault = [bootstrap];
    const settings = makeSettings({ reinjectionCooldown: 5 });
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];

    // ── (a) bootstrapActive=true: bootstrap survives every stage ──
    const policyActive = buildExemptionPolicy(vault, [], [], true);
    assert(policyActive.forceInject.has(trackerKey(bootstrap)), 'I9a: bootstrap in forceInject when bootstrapActive=true');

    let entries = [bootstrap];
    entries = applyContextualGating(entries, { era: ['ancient'] }, policyActive, false, settings, fieldDefs);
    assertEqual(entries.length, 1, 'I9a: bootstrap survives contextual gating (active)');

    const injectionHistory = new Map();
    injectionHistory.set(trackerKey(bootstrap), 10);
    entries = applyReinjectionCooldown(entries, policyActive, injectionHistory, 11, 5, false);
    assertEqual(entries.length, 1, 'I9a: bootstrap survives cooldown (active)');

    const { result: resultActive } = applyRequiresExcludesGating(entries, policyActive, false);
    assert(resultActive.some(e => e.title === 'Intro'), 'I9a: bootstrap survives requires/excludes (active)');

    // ── (b) bootstrapActive=false: bootstrap is gated like any other entry ──
    const policyInactive = buildExemptionPolicy(vault, [], [], false);
    assert(!policyInactive.forceInject.has(trackerKey(bootstrap)), 'I9b: bootstrap NOT in forceInject when bootstrapActive=false');

    let entriesInactive = [bootstrap];
    entriesInactive = applyContextualGating(entriesInactive, { era: ['ancient'] }, policyInactive, false, settings, fieldDefs);
    assertEqual(entriesInactive.length, 0, 'I9b: bootstrap dropped by contextual gating when bootstrapActive=false');

    // Even bypassing contextual gating, requires/excludes should still apply.
    const { result: resultInactive } = applyRequiresExcludesGating([bootstrap], policyInactive, false);
    assert(!resultInactive.some(e => e.title === 'Intro'), 'I9b: bootstrap dropped by requires gating when bootstrapActive=false');

    // And cooldown should still apply.
    const cooled = applyReinjectionCooldown([bootstrap], policyInactive, injectionHistory, 11, 5, false);
    assertEqual(cooled.length, 0, 'I9b: bootstrap subject to cooldown when bootstrapActive=false');

    // Default-arg behavior matches explicit false (conservative default).
    const policyDefault = buildExemptionPolicy(vault, [], []);
    assert(!policyDefault.forceInject.has(trackerKey(bootstrap)), 'I9b: default bootstrapActive=false (conservative)');
});

test('I9b: Cascade-pulled bootstrap is gated when bootstrapActive=false', () => {
    // Reproduces the original bug scenario: a bootstrap-tagged entry reaches the
    // post-pipeline stages via cascade-link / AI selection / pin late in a chat.
    // With bootstrapActive=false, it must be subject to contextual gating, not
    // exempt. Pre-fix this entry would silently survive every gate.
    const bootstrap = makeEntry('Lore Seed', {
        bootstrap: true,
        customFields: { era: ['ancient'] },
    });
    const vault = [bootstrap];
    const settings = makeSettings();
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    // Simulate: chat is long enough that bootstrapActive is false, but the entry
    // got pulled in by cascade-link. The policy reflects the gen state.
    const policy = buildExemptionPolicy(vault, [], [], false);
    const result = applyContextualGating([bootstrap], { era: ['modern'] }, policy, false, settings, fieldDefs);
    assertEqual(result.length, 0, 'I9b cascade: bootstrap entry is gated when era mismatches and bootstrapActive=false');
});

test('I9c: AI-selected bootstrap survives gating when bootstrapActive=true', () => {
    // Mirror case: AI selected a bootstrap entry while bootstrap is logically
    // active. It must still bypass gating like a normal force-inject entry.
    const bootstrap = makeEntry('Intro Snippet', {
        bootstrap: true,
        customFields: { era: ['ancient'] },
    });
    const vault = [bootstrap];
    const settings = makeSettings();
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const policy = buildExemptionPolicy(vault, [], [], true);
    const result = applyContextualGating([bootstrap], { era: ['modern'] }, policy, false, settings, fieldDefs);
    assertEqual(result.length, 1, 'I9c: AI-selected bootstrap survives gating when bootstrapActive=true');
});

test('I10: Multiple pins from different vaults — both injected', () => {
    const entryA = makeEntry('Shared Title', { vaultSource: 'VaultA', priority: 50 });
    const entryB = makeEntry('Unique B', { vaultSource: 'VaultB', priority: 60 });
    const vault = [entryA, entryB];
    const policy = buildExemptionPolicy(vault, ['Shared Title', 'Unique B'], []);
    const matchedKeys = new Map();

    const entries = applyPinBlock([], vault, policy, matchedKeys);
    assert(entries.some(e => e.title === 'Shared Title'), 'I10: first pin should be injected');
    assert(entries.some(e => e.title === 'Unique B'), 'I10: second pin should be injected');
    assertEqual(entries.length, 2, 'I10: both pins should be present');
});

// ============================================================================
// Summary
// ============================================================================

await summary('Stage Interaction Tests');
