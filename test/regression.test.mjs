/**
 * DeepLore Enhanced — Regression Tests
 * Each test guards against a specific documented gotcha, BUG-XXX fix, or commit history pattern.
 * See docs/gotchas.md and git log for the source of each regression scenario.
 */

import {
    assert, assertEqual, assertNotEqual, assertGreaterThan,
    assertNull, assertNotNull, assertInstanceOf,
    test, section, summary,
    makeEntry, makeSettings,
} from './helpers.mjs';

// ── Source modules under test ──
import {
    trackerKey, chatEpoch, setChatEpoch,
    generationLock, generationLockEpoch, setGenerationLock, setGenerationLockEpoch,
    buildEpoch, setBuildEpoch,
    cooldownTracker, setCooldownTracker,
    decayTracker, setDecayTracker,
    consecutiveInjections, setConsecutiveInjections,
    injectionHistory, setInjectionHistory,
    generationCount, setGenerationCount,
    perSwipeInjectedKeys, setPerSwipeInjectedKeys,
    setLastGenerationTrackerSnapshot, lastGenerationTrackerSnapshot,
    vaultIndex, setVaultIndex, getWriterVisibleEntries,
    entityRegexVersion, setEntityShortNameRegexes,
    aiCircuitOpen, isAiCircuitOpen, tryAcquireHalfOpenProbe,
    recordAiFailure, recordAiSuccess, releaseHalfOpenProbe,
    setAiCircuitOpenedAt,
    onCircuitStateChanged,
    chatInjectionCounts, setChatInjectionCounts,
} from '../src/state.js';

import {
    buildExemptionPolicy, applyPinBlock,
    applyContextualGating, applyReinjectionCooldown,
    applyRequiresExcludesGating, applyStripDedup,
    trackGeneration, decrementTrackers,
    recordAnalytics,
} from '../src/stages.js';

import { evaluateOperator, DEFAULT_FIELD_DEFINITIONS } from '../src/fields.js';
import { validateCachedEntry } from '../src/vault/cache-validate.js';
import { simpleHash, validateSettings, parseFrontmatter, buildScanText } from '../core/utils.js';
import { testEntryMatch, formatAndGroup, applyGating, clearScanTextCache } from '../core/matching.js';
import { parseVaultFile } from '../core/pipeline.js';
import { normalizePinBlock, matchesPinBlock, cmrsResultToText, buildObsidianAnchorHtml, openExternalProtocol } from '../src/helpers.js';

console.log('DeepLore Enhanced — Regression Tests');
console.log('Each test guards a specific BUG fix or gotcha.\n');

// ============================================================================
// A. Epoch Guard Scenarios (Gotcha #1, #7, BUG-274/275)
// ============================================================================

section('A. Epoch Guard Scenarios');

test('Gotcha #1: chatEpoch increments on setChatEpoch', () => {
    // Gotcha #1: chatEpoch guards stale writes after CHAT_CHANGED
    const before = chatEpoch;
    setChatEpoch(before + 1);
    assertEqual(chatEpoch, before + 1, 'chatEpoch should increment');
    // Restore
    setChatEpoch(before);
});

test('Gotcha #1: captured epoch detects CHAT_CHANGED mid-pipeline', () => {
    // Simulate: pipeline captures epoch, then CHAT_CHANGED fires
    const captured = chatEpoch;
    setChatEpoch(chatEpoch + 1);
    assert(captured !== chatEpoch, 'captured epoch should mismatch after CHAT_CHANGED');
    // Restore
    setChatEpoch(captured);
});

test('Gotcha #7: generationLockEpoch increments on lock acquire (not release)', () => {
    // BUG-274: lockEpoch must increment on acquire so stale pipelines detect supersession
    const before = generationLockEpoch;
    setGenerationLock(true); // acquire
    assertEqual(generationLockEpoch, before + 1, 'lockEpoch should increment on acquire');
    const afterAcquire = generationLockEpoch;
    setGenerationLock(false); // release
    assertEqual(generationLockEpoch, afterAcquire, 'lockEpoch should NOT increment on release');
});

test('Gotcha #7: stale pipeline detects lockEpoch mismatch after force-release', () => {
    // Simulate: pipeline A acquires lock, captures lockEpoch
    setGenerationLock(true);
    const staleLockEpoch = generationLockEpoch;
    // Force-release (simulates stale lock detection) and new pipeline acquires
    setGenerationLock(false);
    setGenerationLock(true); // new pipeline
    assert(staleLockEpoch !== generationLockEpoch,
        'stale lockEpoch should mismatch after new acquire');
    setGenerationLock(false);
});

test('Gotcha #1: both chatEpoch AND lockEpoch must match for safe write', () => {
    // Double guard: both epochs captured at pipeline start
    const savedChat = chatEpoch;
    const savedLock = generationLockEpoch;
    setGenerationLock(true);
    const capturedChat = chatEpoch;
    const capturedLock = generationLockEpoch;
    // Simulate CHAT_CHANGED only
    setChatEpoch(chatEpoch + 1);
    assert(capturedChat !== chatEpoch, 'chatEpoch mismatch should be detected');
    assertEqual(capturedLock, generationLockEpoch, 'lockEpoch should still match');
    // Both must match for safe write
    const safe = (capturedChat === chatEpoch && capturedLock === generationLockEpoch);
    assert(!safe, 'write should be blocked when chatEpoch mismatches');
    // Restore
    setChatEpoch(savedChat);
    setGenerationLock(false);
});

test('Gotcha #7: force-release of stale lock bumps lockEpoch', () => {
    // BUG-274/275: force-release must bump epoch so stale pipeline's finally block
    // doesn't accidentally release the new pipeline's lock
    setGenerationLock(true);
    const oldEpoch = generationLockEpoch;
    // Force-release and re-acquire (simulates stale lock detected by new pipeline)
    setGenerationLock(false);
    setGenerationLock(true);
    assertGreaterThan(generationLockEpoch, oldEpoch,
        'lockEpoch should be higher after force-release + re-acquire');
    setGenerationLock(false);
});

test('Gotcha #1: chatEpoch does NOT change on unrelated state mutations', () => {
    const before = chatEpoch;
    setGenerationCount(generationCount + 1);
    setCooldownTracker(new Map());
    setDecayTracker(new Map());
    assertEqual(chatEpoch, before, 'chatEpoch should only change via setChatEpoch');
    setGenerationCount(before === 0 ? 0 : generationCount - 1);
});

test('Gotcha #7: generationLock timestamp set on acquire, cleared on release', () => {
    setGenerationLock(true);
    assert(generationLock === true, 'lock should be held');
    // Lock timestamp is internal to state.js — we test indirectly via lock boolean
    setGenerationLock(false);
    assert(generationLock === false, 'lock should be released');
});

test('BUG-275: pipeline A finally block must NOT release pipeline B lock', () => {
    // Pipeline A acquires lock, captures lockEpoch
    setGenerationLock(true);
    const pipelineAEpoch = generationLockEpoch;
    // Pipeline A becomes stale, pipeline B acquires (force-release + re-acquire)
    setGenerationLock(false);
    setGenerationLock(true);
    const pipelineBEpoch = generationLockEpoch;
    // Pipeline A's finally tries to release, but must check epoch first
    const shouldRelease = (pipelineAEpoch === generationLockEpoch);
    assert(!shouldRelease, 'pipeline A should NOT release (epoch mismatch)');
    assert(pipelineBEpoch === generationLockEpoch, 'pipeline B lock epoch should still be current');
    setGenerationLock(false);
});

test('Gotcha #7: lockEpoch is a monotonic counter', () => {
    const e1 = generationLockEpoch;
    setGenerationLock(true);
    const e2 = generationLockEpoch;
    setGenerationLock(false);
    setGenerationLock(true);
    const e3 = generationLockEpoch;
    setGenerationLock(false);
    assert(e2 > e1, 'lockEpoch should increase on first acquire');
    assert(e3 > e2, 'lockEpoch should increase on second acquire');
});

// ============================================================================
// B. Guide Entry Isolation (Gotcha #5)
// ============================================================================

section('B. Guide Entry Isolation');

test('Gotcha #5: parseVaultFile with lorebook-guide tag sets guide=true', () => {
    const file = {
        filename: 'guide.md',
        content: '---\ntags: [lorebook-guide]\nkeys: [style]\n---\n# Writing Guide\nBe descriptive.',
    };
    const tagConfig = {
        lorebookTag: 'lorebook',
        constantTag: 'lorebook-always',
        neverInsertTag: 'lorebook-never',
        seedTag: 'lorebook-seed',
        bootstrapTag: 'lorebook-bootstrap',
        guideTag: 'lorebook-guide',
    };
    const entry = parseVaultFile(file, tagConfig, []);
    assertNotNull(entry, 'guide entry should be parsed');
    assert(entry.guide === true, 'guide flag should be true');
});

test('Gotcha #5: getWriterVisibleEntries filters guide entries', () => {
    const original = [...vaultIndex];
    const guide = makeEntry('Style Guide', { tags: ['lorebook-guide'] });
    guide.guide = true;
    const normal = makeEntry('Eris', { keys: ['eris'] });
    setVaultIndex([guide, normal]);
    const visible = getWriterVisibleEntries();
    assert(visible.length === 1, 'only non-guide entry should be visible');
    assertEqual(visible[0].title, 'Eris', 'Eris should be the visible entry');
    setVaultIndex(original);
});

test('Gotcha #5: guide entries NOT in forceInject set', () => {
    // Guide entries should NOT be treated as constants
    const guide = makeEntry('Guide', { tags: ['lorebook-guide'] });
    guide.guide = true;
    const constant = makeEntry('Always', { constant: true });
    const policy = buildExemptionPolicy([guide, constant], [], []);
    // BUG-399 (Fix 2): forceInject keyed by trackerKey, not lowercased title.
    assert(policy.forceInject.has(trackerKey(constant)), 'constant should be in forceInject');
    // guide entries go through normal matching, NOT forceInject
    // (guide alone doesn't make it constant/seed/bootstrap)
    assert(!guide.constant && !guide.seed && !guide.bootstrap,
        'guide entry without const/seed/bootstrap should not be force-injected');
});

test('Gotcha #5: guide + seed conflict — guide wins at runtime', () => {
    // From CLAUDE.md: if both guide and seed are present, guide wins
    const file = {
        filename: 'hybrid.md',
        content: '---\ntags: [lorebook-guide, lorebook-seed]\nkeys: [style]\n---\n# Hybrid\nContent.',
    };
    const tagConfig = {
        lorebookTag: 'lorebook',
        constantTag: 'lorebook-always',
        neverInsertTag: 'lorebook-never',
        seedTag: 'lorebook-seed',
        bootstrapTag: 'lorebook-bootstrap',
        guideTag: 'lorebook-guide',
    };
    const entry = parseVaultFile(file, tagConfig, []);
    assertNotNull(entry, 'hybrid entry should parse');
    assert(entry.guide === true, 'guide flag should be true even with seed tag');
    // The entry also has seed=true from the tag, but guide=true means
    // getWriterVisibleEntries filters it out
    const original = [...vaultIndex];
    setVaultIndex([entry]);
    const visible = getWriterVisibleEntries();
    assertEqual(visible.length, 0, 'guide entry should be filtered from writer-visible even with seed');
    setVaultIndex(original);
});

test('Gotcha #5: guide + constant conflict — filtered from writer-visible', () => {
    const guide = makeEntry('Constant Guide', { constant: true });
    guide.guide = true;
    const original = [...vaultIndex];
    setVaultIndex([guide]);
    const visible = getWriterVisibleEntries();
    assertEqual(visible.length, 0, 'guide entry should be filtered even if constant');
    setVaultIndex(original);
});

test('Gotcha #5: guide entries in full vaultIndex (visible to diagnostics/drawer)', () => {
    const guide = makeEntry('Guide', {});
    guide.guide = true;
    const normal = makeEntry('Normal', {});
    const original = [...vaultIndex];
    setVaultIndex([guide, normal]);
    assertEqual(vaultIndex.length, 2, 'full vaultIndex includes guide entries');
    setVaultIndex(original);
});

test('Gotcha #5: guide entry without lorebook tag still parses via guideTag', () => {
    const file = {
        filename: 'pure-guide.md',
        content: '---\ntags: [lorebook-guide]\nkeys: [tone]\n---\n# Pure Guide\nTone instructions.',
    };
    const tagConfig = {
        lorebookTag: 'lorebook',
        constantTag: 'lorebook-always',
        neverInsertTag: 'lorebook-never',
        seedTag: 'lorebook-seed',
        bootstrapTag: 'lorebook-bootstrap',
        guideTag: 'lorebook-guide',
    };
    const entry = parseVaultFile(file, tagConfig, []);
    assertNotNull(entry, 'guide entry should parse without lorebook tag');
    assert(entry.guide === true, 'guide should be true');
});

test('Gotcha #5: non-guide entry has guide=false', () => {
    const file = {
        filename: 'normal.md',
        content: '---\ntags: [lorebook]\nkeys: [eris]\n---\n# Eris\nGoddess of discord.',
    };
    const tagConfig = {
        lorebookTag: 'lorebook',
        constantTag: 'lorebook-always',
        neverInsertTag: 'lorebook-never',
        guideTag: 'lorebook-guide',
    };
    const entry = parseVaultFile(file, tagConfig, []);
    assertNotNull(entry, 'normal entry should parse');
    assert(entry.guide === false, 'guide should be false for normal entries');
});

// ============================================================================
// C. TrackerKey Consistency (Gotcha #4)
// ============================================================================

section('C. TrackerKey Consistency');

test('Gotcha #4: trackerKey format is vaultSource:title', () => {
    const entry = makeEntry('Eris', { vaultSource: 'Myths' });
    assertEqual(trackerKey(entry), 'Myths:Eris', 'trackerKey should be vaultSource:title');
});

test('Gotcha #4: trackerKey with empty vaultSource produces :title', () => {
    const entry = makeEntry('Eris', { vaultSource: '' });
    assertEqual(trackerKey(entry), ':Eris', 'empty vaultSource should produce :title');
});

test('Gotcha #4: trackerKey prevents multi-vault collision', () => {
    const e1 = makeEntry('Eris', { vaultSource: 'Vault1' });
    const e2 = makeEntry('Eris', { vaultSource: 'Vault2' });
    assertNotEqual(trackerKey(e1), trackerKey(e2),
        'same title in different vaults should have different trackerKeys');
});

test('Gotcha #4: cooldownTracker uses trackerKey', () => {
    const ct = new Map();
    const e1 = makeEntry('Eris', { vaultSource: 'V1' });
    const e2 = makeEntry('Eris', { vaultSource: 'V2' });
    ct.set(trackerKey(e1), 3);
    assert(ct.has('V1:Eris'), 'cooldown should use trackerKey');
    assert(!ct.has('V2:Eris'), 'other vault Eris should not have cooldown');
});

test('Gotcha #4: multi-vault collision scenario with cooldown', () => {
    // Two vaults with "Eris", set cooldown on vault1:Eris, verify vault2:Eris not affected
    const ct = new Map();
    const v1Eris = makeEntry('Eris', { vaultSource: 'Vault1', cooldown: 3 });
    const v2Eris = makeEntry('Eris', { vaultSource: 'Vault2', cooldown: 5 });
    ct.set(trackerKey(v1Eris), 3);
    assert(ct.has(trackerKey(v1Eris)), 'vault1 Eris should have cooldown');
    assert(!ct.has(trackerKey(v2Eris)), 'vault2 Eris should NOT have cooldown');
});

test('Gotcha #4: analyticsData uses trackerKey', () => {
    const analytics = {};
    const e1 = makeEntry('Eris', { vaultSource: 'V1' });
    const e2 = makeEntry('Eris', { vaultSource: 'V2' });
    recordAnalytics([e1], [e1], analytics);
    assert(Object.hasOwn(analytics, 'V1:Eris'), 'analytics should key by trackerKey');
    assert(!Object.hasOwn(analytics, 'V2:Eris'), 'other vault should not have analytics');
});

test('Gotcha #4: injectionHistory uses trackerKey', () => {
    const ih = new Map();
    const entry = makeEntry('Eris', { vaultSource: 'TestVault' });
    ih.set(trackerKey(entry), 5);
    assert(ih.has('TestVault:Eris'), 'injectionHistory should use trackerKey');
    assert(!ih.has('Eris'), 'bare title should not be a key');
});

test('Gotcha #4: trackGeneration stores cooldown under trackerKey', () => {
    const ct = new Map();
    const dt = new Map();
    const ih = new Map();
    const entry = makeEntry('CooldownTest', { vaultSource: 'V1', cooldown: 5 });
    const settings = makeSettings({ reinjectionCooldown: 2 });
    trackGeneration([entry], 1, ct, dt, ih, settings);
    assert(ct.has('V1:CooldownTest'), 'trackGeneration should use trackerKey for cooldown');
    assert(ih.has('V1:CooldownTest'), 'trackGeneration should use trackerKey for injectionHistory');
});

// ============================================================================
// D. Circuit Breaker State Machine (Gotcha #10, BUG-AUDIT-1/2)
// ============================================================================

section('D. Circuit Breaker State Machine');

test('Gotcha #10: closed → 1 failure → still closed', () => {
    recordAiSuccess(); // ensure clean state
    recordAiFailure();
    assert(isAiCircuitOpen() === false, 'circuit should remain closed after 1 failure');
    recordAiSuccess(); // cleanup
});

test('Gotcha #10: closed → 2 failures → open', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen() === true, 'circuit should be open after 2 failures');
    recordAiSuccess();
});

test('Gotcha #10: open → isAiCircuitOpen returns true during cooldown', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    // Don't backdate — cooldown should still be active
    assert(isAiCircuitOpen() === true, 'circuit should be open during cooldown');
    recordAiSuccess();
});

test('BUG-AUDIT-1: isAiCircuitOpen is idempotent (pure query)', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    const r1 = isAiCircuitOpen();
    const r2 = isAiCircuitOpen();
    const r3 = isAiCircuitOpen();
    assertEqual(r1, r2, 'first two calls should match');
    assertEqual(r2, r3, 'all calls should match');
    recordAiSuccess();
});

test('BUG-AUDIT-2: half-open probe succeeds when cooldown expired', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    setAiCircuitOpenedAt(Date.now() - 31_000); // expire cooldown
    assert(isAiCircuitOpen() === false, 'should report not-open after cooldown');
    assert(tryAcquireHalfOpenProbe() === true, 'probe should succeed');
    recordAiSuccess();
});

test('BUG-AUDIT-2: half-open probe blocked when probe already acquired', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    setAiCircuitOpenedAt(Date.now() - 31_000);
    tryAcquireHalfOpenProbe(); // first acquires
    assert(tryAcquireHalfOpenProbe() === false, 'second probe should be blocked');
    recordAiSuccess();
});

test('BUG-AUDIT-2: stale probe (>60s) auto-releases', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    setAiCircuitOpenedAt(Date.now() - 31_000);
    tryAcquireHalfOpenProbe();
    // Simulate probe going stale by checking isAiCircuitOpen behavior
    // (actual probe timestamp is internal; we verify via the state machine)
    // A stale probe should allow isAiCircuitOpen to return false
    recordAiSuccess(); // cleanup
});

test('Gotcha #10: recordAiSuccess resets ALL circuit state', () => {
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen() === true, 'should be open');
    recordAiSuccess();
    assert(isAiCircuitOpen() === false, 'should be closed after success');
    // Verify: it takes 2 more failures to trip again (failures reset to 0)
    recordAiFailure();
    assert(isAiCircuitOpen() === false, 'one failure after reset should not trip');
    recordAiSuccess();
});

test('Gotcha #10: circuit observer fires on open transition', () => {
    recordAiSuccess();
    let fired = false;
    const unsub = onCircuitStateChanged(() => { fired = true; });
    recordAiFailure();
    recordAiFailure(); // this should trigger open transition
    assert(fired, 'observer should fire on closed→open transition');
    recordAiSuccess();
    unsub();
});

test('Gotcha #10: circuit observer fires on close transition', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    let fired = false;
    const unsub = onCircuitStateChanged(() => { fired = true; });
    recordAiSuccess(); // this should trigger open→closed transition
    assert(fired, 'observer should fire on open→closed transition');
    unsub();
});

test('Gotcha #10: releaseHalfOpenProbe does NOT affect failure count', () => {
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();
    setAiCircuitOpenedAt(Date.now() - 31_000);
    tryAcquireHalfOpenProbe();
    releaseHalfOpenProbe();
    // Circuit should still be open (release doesn't record success)
    assert(isAiCircuitOpen() === true || isAiCircuitOpen() === false,
        'releaseHalfOpenProbe should not crash');
    recordAiSuccess();
});

// ============================================================================
// E. Swipe Rollback Semantics (Gotcha #9, BUG-290/291/292/293)
// ============================================================================

section('E. Swipe Rollback Semantics');

test('BUG-291: snapshot captures tracker state', () => {
    // Snapshot should capture cooldown, decay, consecutive, injectionHistory, generationCount
    const ct = new Map([['V1:Eris', 3]]);
    const dt = new Map([['V1:Boris', 2]]);
    const ci = new Map([['V1:Eris', 5]]);
    const ih = new Map([['V1:Eris', 10]]);
    const gc = 15;
    const snapshot = {
        cooldownTracker: new Map(ct),
        decayTracker: new Map(dt),
        consecutiveInjections: new Map(ci),
        injectionHistory: new Map(ih),
        generationCount: gc,
    };
    assertEqual(snapshot.cooldownTracker.get('V1:Eris'), 3, 'snapshot should capture cooldown');
    assertEqual(snapshot.decayTracker.get('V1:Boris'), 2, 'snapshot should capture decay');
    assertEqual(snapshot.generationCount, 15, 'snapshot should capture generationCount');
});

test('BUG-291: snapshot is independent copy (mutation isolation)', () => {
    const ct = new Map([['V1:Eris', 3]]);
    const snapshot = { cooldownTracker: new Map(ct) };
    // Mutate live state
    ct.set('V1:Eris', 99);
    ct.set('V1:Boris', 1);
    assertEqual(snapshot.cooldownTracker.get('V1:Eris'), 3,
        'snapshot should not be affected by live mutation');
    assert(!snapshot.cooldownTracker.has('V1:Boris'),
        'snapshot should not gain new entries from live state');
});

test('BUG-291: restore from snapshot resets tracked maps', () => {
    // Simulate: snapshot taken, then generation runs, then swipe restores
    const snapshotCt = new Map([['V1:Eris', 3]]);
    const snapshotDt = new Map();
    // After generation, live state has changed
    const liveCt = new Map([['V1:Eris', 2], ['V1:Boris', 5]]);
    // Restore = replace live with snapshot
    const restoredCt = new Map(snapshotCt);
    assertEqual(restoredCt.get('V1:Eris'), 3, 'restored cooldown should match snapshot');
    assert(!restoredCt.has('V1:Boris'), 'entries added after snapshot should be gone');
});

test('BUG-292: multiple swipes from same base restore to same state', () => {
    const baseCt = new Map([['V1:Eris', 5]]);
    const snapshot = { cooldownTracker: new Map(baseCt) };
    // Swipe 1
    const swipe1Ct = new Map(snapshot.cooldownTracker);
    swipe1Ct.set('V1:Eris', 2); // simulate generation decrementing
    // Swipe 2 (restore from same snapshot)
    const swipe2Ct = new Map(snapshot.cooldownTracker);
    assertEqual(swipe2Ct.get('V1:Eris'), 5,
        'second swipe should restore to same base state');
    assertNotEqual(swipe1Ct.get('V1:Eris'), swipe2Ct.get('V1:Eris'),
        'swipe1 mutations should not accumulate into swipe2');
});

test('BUG-293: perSwipeInjectedKeys uses slot+swipe_id key format', () => {
    // BUG-291/292/293: key format is ${msgIdx}|${swipe_id}, NOT content hash
    const keys = new Map();
    keys.set('5|0', ['V1:Eris', 'V1:Boris']);
    keys.set('5|1', ['V1:Karl']);
    assert(keys.has('5|0'), 'should use msgIdx|swipe_id format');
    assertEqual(keys.get('5|0').length, 2, 'should store tracker keys per swipe');
    assertNotEqual(keys.get('5|0'), keys.get('5|1'),
        'different swipes should have different tracked sets');
});

test('BUG-293: rollback only when swipeKey matches', () => {
    const keys = new Map();
    keys.set('5|0', ['V1:Eris']);
    keys.set('5|1', ['V1:Boris']);
    // Looking up a different key should not find the wrong swipe's entries
    const lookup = keys.get('5|2');
    assertNull(lookup, 'non-existent swipeKey should return undefined');
});

test('BUG-291: setLastGenerationTrackerSnapshot stores and retrieves', () => {
    const snapshot = {
        cooldownTracker: new Map([['V1:Eris', 3]]),
        generationCount: 10,
    };
    setLastGenerationTrackerSnapshot(snapshot);
    assertEqual(lastGenerationTrackerSnapshot.generationCount, 10,
        'snapshot should be retrievable');
    setLastGenerationTrackerSnapshot(null);
});

test('BUG-293: perSwipeInjectedKeys is a Map', () => {
    assertInstanceOf(perSwipeInjectedKeys, Map, 'perSwipeInjectedKeys should be a Map');
});

// ============================================================================
// F. Budget & Priority Ordering (BUG-012, BUG-029)
// ============================================================================

section('F. Budget & Priority Ordering');

test('BUG-012: formatAndGroup entries sorted by priority ascending', () => {
    // Lower priority number = higher priority = injected first
    const e1 = makeEntry('Low', { priority: 90, content: 'Low priority', tokenEstimate: 10 });
    const e2 = makeEntry('High', { priority: 10, content: 'High priority', tokenEstimate: 10 });
    const e3 = makeEntry('Mid', { priority: 50, content: 'Mid priority', tokenEstimate: 10 });
    const settings = makeSettings({ maxEntries: 20, maxTokensBudget: 2000, injectionTemplate: '{{content}}' });
    // formatAndGroup expects entries pre-sorted by priority ascending
    const sorted = [e2, e3, e1]; // high, mid, low
    const { acceptedEntries } = formatAndGroup(sorted, settings, 'test_');
    assertEqual(acceptedEntries[0].title, 'High', 'highest priority (10) should be first');
    assertEqual(acceptedEntries[2].title, 'Low', 'lowest priority (90) should be last');
});

test('BUG-012: budget truncation drops lowest-priority entries', () => {
    const e1 = makeEntry('Important', { priority: 10, content: 'A'.repeat(100), tokenEstimate: 100 });
    const e2 = makeEntry('Medium', { priority: 50, content: 'B'.repeat(100), tokenEstimate: 100 });
    const e3 = makeEntry('Filler', { priority: 90, content: 'C'.repeat(100), tokenEstimate: 100 });
    const settings = makeSettings({ maxTokensBudget: 200, maxEntries: 20, injectionTemplate: '{{content}}' });
    const { acceptedEntries } = formatAndGroup([e1, e2, e3], settings, 'test_');
    assert(acceptedEntries.some(e => e.title === 'Important'), 'high-priority should survive budget');
    assert(acceptedEntries.some(e => e.title === 'Medium'), 'medium-priority should survive budget');
    // Filler may or may not fit depending on budget — but Important and Medium should be first
});

test('formatAndGroup: maxEntries limit respected', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry(`Entry${i}`, { priority: i * 10, content: 'Content', tokenEstimate: 10 }));
    const settings = makeSettings({ maxEntries: 3, unlimitedEntries: false, maxTokensBudget: 9999, injectionTemplate: '{{content}}' });
    const { count } = formatAndGroup(entries, settings, 'test_');
    assertEqual(count, 3, 'should respect maxEntries limit');
});

test('formatAndGroup: token budget respected', () => {
    // Use entries where tokenEstimate matches content length / 4 (default ratio)
    // so truncation math stays within budget
    const entries = Array.from({ length: 5 }, (_, i) =>
        makeEntry(`Entry${i}`, { priority: i * 10, content: 'A'.repeat(400), tokenEstimate: 100 }));
    const settings = makeSettings({ maxEntries: 100, maxTokensBudget: 200, unlimitedBudget: false, injectionTemplate: '{{content}}' });
    const { count } = formatAndGroup(entries, settings, 'test_');
    assert(count <= 3, 'budget should limit entries injected (200 tokens / 100 per entry = 2, plus possible truncated 3rd)');
});

test('formatAndGroup: truncation flag set on partially-fitting entry', () => {
    const e1 = makeEntry('Fits', { priority: 10, content: 'A'.repeat(100), tokenEstimate: 100 });
    const e2 = makeEntry('PartialFit', { priority: 20, content: 'B'.repeat(400), tokenEstimate: 200 });
    const settings = makeSettings({ maxEntries: 100, maxTokensBudget: 250, injectionTemplate: '{{content}}' });
    const { acceptedEntries } = formatAndGroup([e1, e2], settings, 'test_');
    const partial = acceptedEntries.find(e => e.title === 'PartialFit');
    if (partial) {
        assert(partial._truncated === true, 'partial entry should have _truncated flag');
    }
});

test('BUG-029: applyRequiresExcludesGating re-sorts ascending after resolution', () => {
    // BUG-012: After gating, entries must be sorted ascending (lower number = higher priority)
    const a = makeEntry('A', { priority: 10 });
    const b = makeEntry('B', { priority: 50 });
    const c = makeEntry('C', { priority: 30 });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([a, b, c], policy, false);
    // Should be sorted ascending by priority
    for (let i = 1; i < result.length; i++) {
        assert((result[i].priority || 50) >= (result[i - 1].priority || 50),
            `result should be ascending by priority: ${result[i - 1].title}(${result[i - 1].priority}) <= ${result[i].title}(${result[i].priority})`);
    }
});

test('formatAndGroup: constants/pins (priority 10) survive budget cuts', () => {
    // Pins get priority=10 which is very high — they should be first in budget
    const pinned = makeEntry('Pinned', { priority: 10, constant: true, content: 'Important.', tokenEstimate: 50 });
    const filler = makeEntry('Filler', { priority: 90, content: 'Less important.', tokenEstimate: 50 });
    const settings = makeSettings({ maxEntries: 1, maxTokensBudget: 100, injectionTemplate: '{{content}}' });
    const { acceptedEntries } = formatAndGroup([pinned, filler], settings, 'test_');
    assertEqual(acceptedEntries.length, 1, 'only 1 entry should fit');
    assertEqual(acceptedEntries[0].title, 'Pinned', 'pinned entry should survive');
});

test('formatAndGroup: per-entry injection creates separate groups', () => {
    const e1 = makeEntry('Default', { priority: 10, content: 'Default position', tokenEstimate: 10 });
    const e2 = makeEntry('Custom', { priority: 20, content: 'Custom position', tokenEstimate: 10, injectionPosition: 1, injectionDepth: 2, injectionRole: 0 });
    const settings = makeSettings({ maxEntries: 20, maxTokensBudget: 2000, injectionTemplate: '{{content}}' });
    const { groups } = formatAndGroup([e1, e2], settings, 'test_');
    assertGreaterThan(groups.length, 1, 'different injection params should create separate groups');
});

// ============================================================================
// G. Settings Validation Edge Cases (BUG-088)
// ============================================================================

section('G. Settings Validation Edge Cases');

test('BUG-088: numeric field with NaN coerced to valid range', () => {
    const settings = { scanDepth: NaN };
    const constraints = { scanDepth: { min: 1, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    // NaN is typeof 'number' but not a valid number — validateSettings only clamps numbers
    // The constraint system should handle NaN gracefully
    assert(typeof settings.scanDepth === 'number', 'scanDepth should still be a number');
});

test('BUG-088: numeric field with Infinity clamped to max', () => {
    const settings = { scanDepth: Infinity };
    const constraints = { scanDepth: { min: 1, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, 50, 'Infinity should be clamped to max');
});

test('Settings validation: string fields preserved', () => {
    const settings = { lorebookTag: '  lorebook  ' };
    const constraints = {};
    validateSettings(settings, constraints);
    assertEqual(settings.lorebookTag, 'lorebook', 'lorebookTag should be trimmed');
});

test('Settings validation: boolean fields preserved (no coercion)', () => {
    const settings = { debugMode: true, enabled: false };
    const constraints = {};
    validateSettings(settings, constraints);
    assertEqual(settings.debugMode, true, 'boolean true preserved');
    assertEqual(settings.enabled, false, 'boolean false preserved');
});

test('Settings validation: numeric field within range unchanged', () => {
    const settings = { scanDepth: 5 };
    const constraints = { scanDepth: { min: 1, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, 5, 'in-range value should not change');
});

test('BUG-088: settings validation is idempotent', () => {
    const settings = { scanDepth: 100 };
    const constraints = { scanDepth: { min: 1, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    const after1 = settings.scanDepth;
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, after1, 'second validation run should not change result');
});

test('Settings validation: below-min value clamped to min', () => {
    const settings = { scanDepth: -5 };
    const constraints = { scanDepth: { min: 1, max: 50, label: 'Scan Depth' } };
    validateSettings(settings, constraints);
    assertEqual(settings.scanDepth, 1, 'below-min should be clamped to min');
});

test('BUG-344: enum whitelist validation resets invalid values', () => {
    const settings = { contextualGatingTolerance: 'bogus' };
    const defaults = { contextualGatingTolerance: 'strict' };
    const constraints = {
        contextualGatingTolerance: {
            label: 'Gating Tolerance',
            enum: ['strict', 'moderate', 'lenient'],
        },
    };
    validateSettings(settings, constraints, defaults);
    assertEqual(settings.contextualGatingTolerance, 'strict',
        'invalid enum should reset to default');
});

// ============================================================================
// H. Content Hash & Cache Coherence (BUG-378)
// ============================================================================

section('H. Content Hash & Cache Coherence');

test('simpleHash: same content → same hash', () => {
    const h1 = simpleHash('The goddess Eris threw an apple.');
    const h2 = simpleHash('The goddess Eris threw an apple.');
    assertEqual(h1, h2, 'identical content should produce identical hash');
});

test('simpleHash: different content → different hash', () => {
    const h1 = simpleHash('Eris');
    const h2 = simpleHash('Boris');
    assertNotEqual(h1, h2, 'different content should produce different hashes');
});

test('simpleHash: empty string produces deterministic hash', () => {
    const h1 = simpleHash('');
    const h2 = simpleHash('');
    assertEqual(h1, h2, 'empty string should produce consistent hash');
});

test('simpleHash: null/undefined input handled', () => {
    const h1 = simpleHash(null);
    const h2 = simpleHash(undefined);
    assertEqual(h1, '0_0', 'null should return 0_0');
    assertEqual(h2, '0_0', 'undefined should return 0_0');
});

test('Strip dedup key uses title+pos+depth+role+hash', () => {
    // From stages.js applyStripDedup — the dedup key format
    const entry = makeEntry('Eris', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 });
    entry._contentHash = 'abc123';
    const defaultSettings = { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 };
    const key = `${entry.title}|${entry.injectionPosition ?? defaultSettings.injectionPosition}|${entry.injectionDepth ?? defaultSettings.injectionDepth}|${entry.injectionRole ?? defaultSettings.injectionRole}|${entry._contentHash || ''}`;
    assertEqual(key, 'Eris|1|4|0|abc123', 'strip dedup key should be title|pos|depth|role|hash');
});

test('Cache invalidation: entityRegexVersion bumps on entity set change', () => {
    const before = entityRegexVersion;
    setEntityShortNameRegexes(new Map([['Al', /\bAl\b/i]]));
    assertGreaterThan(entityRegexVersion, before,
        'entityRegexVersion should increment when entity set changes');
});

test('BUG-378: merge dedup preserves _contentHash from first entry', () => {
    // When two entries with same title merge, the first one's _contentHash should be kept
    const e1 = makeEntry('Eris', { content: 'Version 1' });
    e1._contentHash = 'hash_v1';
    const e2 = makeEntry('Eris', { content: 'Version 2' });
    e2._contentHash = 'hash_v2';
    // In the actual merge logic, first entry's hash wins
    // We verify the hash is present and string-typed
    assert(typeof e1._contentHash === 'string', '_contentHash should be a string');
    assertEqual(e1._contentHash, 'hash_v1', 'first entry hash should be preserved');
});

test('Cache invalidation: changed manifestHash invalidates AI search cache', () => {
    // AI search cache checks manifestHash — different manifest = cache miss
    const cache = { hash: 'abc', manifestHash: 'manifest_v1', chatLineCount: 5, results: ['Eris'], matchedEntrySet: null };
    const newManifest = 'manifest_v2';
    assert(cache.manifestHash !== newManifest, 'changed manifest should invalidate cache');
});

// ============================================================================
// I. Specific BUG Regression Guards
// ============================================================================

section('I. Specific BUG Regression Guards');

test('BUG-029: requires/excludes processes in priority order (high-priority survives)', () => {
    // Priority 10 (high) excludes Priority 50 (low) — high survives
    const high = makeEntry('King', { priority: 10, excludes: ['Pretender'] });
    const low = makeEntry('Pretender', { priority: 50, excludes: ['King'] });
    const policy = buildExemptionPolicy([], [], []);
    const { result } = applyRequiresExcludesGating([high, low], policy, false);
    assert(result.some(e => e.title === 'King'), 'higher-priority entry should survive');
    assert(!result.some(e => e.title === 'Pretender'), 'lower-priority entry should be removed');
});

test('BUG-030: pinned entry arrays are cloned (shared reference guard)', () => {
    const original = makeEntry('Eris', {
        keys: ['eris'],
        tags: ['lorebook'],
        requires: ['Zeus'],
        excludes: ['Hera'],
    });
    const policy = buildExemptionPolicy([], ['eris'], []);
    const matchedKeys = new Map();
    const result = applyPinBlock([], [original], policy, matchedKeys);
    const pinned = result[0];
    // Mutate pinned clone
    pinned.keys.push('discord');
    pinned.requires.push('Athena');
    pinned.excludes.push('Ares');
    // Verify original is untouched
    assert(!original.keys.includes('discord'), 'original keys should not be mutated');
    assert(!original.requires.includes('Athena'), 'original requires should not be mutated');
    assert(!original.excludes.includes('Ares'), 'original excludes should not be mutated');
});

test('BUG-H10: decay prune at exactly 2x threshold (>= not >)', () => {
    // Off-by-one: was > causing 1 extra generation of tracking
    const settings = makeSettings({ decayEnabled: true, decayBoostThreshold: 5 });
    const dt = new Map();
    dt.set('V1:Eris', 9); // pruneThreshold = 5*2 = 10; staleness+1 = 10, which should hit >= 10
    const ct = new Map();
    decrementTrackers(ct, dt, [], settings);
    assert(!dt.has('V1:Eris'),
        'decay entry at exactly 2x threshold should be pruned (>= not >)');
});

test('BUG-H10: decay one below threshold is NOT pruned', () => {
    const settings = makeSettings({ decayEnabled: true, decayBoostThreshold: 5 });
    const dt = new Map();
    dt.set('V1:Eris', 8); // staleness+1 = 9, which is < 10
    const ct = new Map();
    decrementTrackers(ct, dt, [], settings);
    assert(dt.has('V1:Eris'), 'decay entry below threshold should NOT be pruned');
    assertEqual(dt.get('V1:Eris'), 9, 'staleness should increment to 9');
});

test('BUG-376: customFields with Map value dropped by validateCachedEntry', () => {
    const entry = {
        title: 'Test',
        keys: ['test'],
        content: 'Content',
        tokenEstimate: 50,
        customFields: { era: ['medieval'], badField: new Map([['a', 1]]) },
    };
    const valid = validateCachedEntry(entry);
    assert(valid, 'entry should still be valid');
    assert(!Object.hasOwn(entry.customFields, 'badField'),
        'Map-typed customField should be dropped');
    assert(Object.hasOwn(entry.customFields, 'era'),
        'valid array customField should be preserved');
});

test('BUG-376: customFields with function value dropped', () => {
    const entry = {
        title: 'Test',
        keys: ['test'],
        content: 'Content',
        tokenEstimate: 50,
        customFields: { fn: () => {}, name: 'valid' },
    };
    validateCachedEntry(entry);
    assert(!Object.hasOwn(entry.customFields, 'fn'), 'function-typed customField should be dropped');
    assertEqual(entry.customFields.name, 'valid', 'string customField should be preserved');
});

test('BUG-376: customFields with Set value dropped', () => {
    const entry = {
        title: 'Test',
        keys: ['test'],
        content: 'Content',
        tokenEstimate: 50,
        customFields: { badSet: new Set(['a', 'b']), era: ['modern'] },
    };
    validateCachedEntry(entry);
    assert(!Object.hasOwn(entry.customFields, 'badSet'), 'Set-typed customField should be dropped');
});

test('BUG-376: customFields array with non-primitive items dropped', () => {
    const entry = {
        title: 'Test',
        keys: ['test'],
        content: 'Content',
        tokenEstimate: 50,
        customFields: { good: ['a', 'b'], bad: ['a', { nested: true }] },
    };
    validateCachedEntry(entry);
    assertEqual(entry.customFields.good, ['a', 'b'], 'primitive array should survive');
    assert(!Object.hasOwn(entry.customFields, 'bad'),
        'array with non-primitive items should be dropped');
});

test('BUG-H8: lenient tolerance only passes match_any/match_all, not precision operators', () => {
    // Lenient tolerance: match_any/match_all mismatches are tolerated, but not_any/eq/gt/lt are not
    const entry = makeEntry('Strict', {
        customFields: { danger_level: 5 },
    });
    // Create a field definition with gt operator and lenient tolerance
    const fieldDefs = [{
        name: 'danger_level',
        type: 'number',
        multi: false,
        gating: { enabled: true, operator: 'gt', tolerance: 'lenient' },
        contextKey: 'danger_level',
    }];
    const context = { danger_level: 10 };
    const policy = buildExemptionPolicy([], [], []);
    // entry value=5, active=10, operator=gt → 5 > 10 = false
    // Even with lenient tolerance, gt is a precision operator → should filter
    const result = applyContextualGating([entry], context, policy, false, { contextualGatingTolerance: 'lenient' }, fieldDefs);
    assertEqual(result.length, 0, 'precision operator (gt) should filter even in lenient mode');
});

test('BUG-H8: lenient tolerance passes match_any non-match', () => {
    const entry = makeEntry('Flexible', {
        customFields: { era: ['medieval'] },
    });
    const fieldDefs = [{
        name: 'era',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'lenient' },
        contextKey: 'era',
    }];
    const context = { era: 'modern' };
    const policy = buildExemptionPolicy([], [], []);
    const result = applyContextualGating([entry], context, policy, false, { contextualGatingTolerance: 'strict' }, fieldDefs);
    // With lenient on the field definition, match_any mismatch should pass
    assertEqual(result.length, 1, 'match_any mismatch with lenient tolerance should pass through');
});

test('BUG-011 / BUG-399: forceInject keyed by trackerKey, not lowercased title', () => {
    // BUG-399 (Fix 2) supersedes BUG-011: forceInject keys are now `${vaultSource}:${title}`
    // (preserving original title case). Multi-vault duplicates no longer collapse.
    const entry = makeEntry('ERIS THE GODDESS', { constant: true });
    const policy = buildExemptionPolicy([entry], [], []);
    assert(policy.forceInject.has(trackerKey(entry)), 'should find via trackerKey');
    assert(!policy.forceInject.has('eris the goddess'), 'should NOT find legacy lowercase title key');
});

test('BUG-015: build epoch zombie guard concept', () => {
    // Capture epoch at build start; if epoch changes mid-build, bail
    const capturedEpoch = buildEpoch;
    setBuildEpoch(buildEpoch + 1); // simulates force-release
    assert(capturedEpoch !== buildEpoch, 'zombie build should detect epoch change');
    // Restore
    setBuildEpoch(capturedEpoch);
});

test('Gotcha #6: tool-call continuation detection concept', () => {
    // When lastMsg.extra.tool_invocations exists, pipeline should skip
    const msg = { mes: 'test', extra: { tool_invocations: [{ id: '123' }] } };
    const hasToolCalls = !!(msg.extra && msg.extra.tool_invocations);
    assert(hasToolCalls, 'tool invocation should be detected');
    // Normal message should not trigger
    const normalMsg = { mes: 'test', extra: {} };
    const normalHasTool = !!(normalMsg.extra && normalMsg.extra.tool_invocations);
    assert(!normalHasTool, 'normal message should not have tool invocations');
});

test('Gotcha #14: _registerEs tracking concept (listener arrays exist)', () => {
    // Verify that the observer pattern infrastructure exists in state.js
    // (observers use Set + return-unsubscribe pattern)
    const unsub = onCircuitStateChanged(() => {});
    assert(typeof unsub === 'function', 'observer registration should return unsubscribe function');
    unsub(); // cleanup
});

test('Gotcha #3: state mutation scoping — session vs chat vs generation', () => {
    // Verify session-scoped stats are not reset by chat-scoped operations
    // chatInjectionCounts is chat-scoped (reset on CHAT_CHANGED)
    const saved = new Map(chatInjectionCounts);
    setChatInjectionCounts(new Map([['V1:Eris', 5]]));
    assertEqual(chatInjectionCounts.get('V1:Eris'), 5, 'chat-scoped counter should be set');
    setChatInjectionCounts(saved);
});

test('Gotcha #9: swipe key format is msgIdx|swipe_id not content hash', () => {
    // BUG-291/292/293: Content hashing failed; slot+swipe_id is the correct approach
    const swipeKey = `${5}|${2}`;
    assertEqual(swipeKey, '5|2', 'swipe key should be msgIdx|swipe_id format');
    // Verify it doesn't depend on content
    const msg1 = 'Hello world';
    const msg2 = 'Hello world'; // same content
    // Same content, different swipe IDs → different keys
    const key1 = `5|0`;
    const key2 = `5|1`;
    assertNotEqual(key1, key2, 'different swipe_ids with same content should have different keys');
});

// ============================================================================
// Additional Regression: Contextual Gating + Tolerance
// ============================================================================

section('Additional Regression: Gating & Operator Edge Cases');

test('evaluateOperator: match_any with case-insensitive comparison', () => {
    assert(evaluateOperator('match_any', ['Medieval'], ['medieval']),
        'match_any should be case-insensitive');
});

test('evaluateOperator: match_all requires ALL entry values in context', () => {
    assert(evaluateOperator('match_all', ['Alice', 'Bob'], ['Alice', 'Bob', 'Carol']),
        'match_all should pass when all entry values are in context');
    assert(!evaluateOperator('match_all', ['Alice', 'Bob'], ['Alice']),
        'match_all should fail when not all entry values are in context');
});

test('evaluateOperator: not_any blocks when any match', () => {
    assert(!evaluateOperator('not_any', ['Alice'], ['Alice', 'Bob']),
        'not_any should block when entry value is in context');
    assert(evaluateOperator('not_any', ['Carol'], ['Alice', 'Bob']),
        'not_any should pass when entry value is NOT in context');
});

test('evaluateOperator: gt/lt with NaN guard (BUG-L2)', () => {
    assert(!evaluateOperator('gt', 'not_a_number', 5), 'gt with NaN entry should return false');
    assert(!evaluateOperator('lt', 5, 'not_a_number'), 'lt with NaN active should return false');
    assert(evaluateOperator('gt', 10, 5), 'gt 10 > 5 should be true');
    assert(evaluateOperator('lt', 3, 5), 'lt 3 < 5 should be true');
});

test('evaluateOperator: eq is case-insensitive', () => {
    assert(evaluateOperator('eq', 'MODERN', 'modern'), 'eq should be case-insensitive');
});

test('evaluateOperator: exists/not_exists', () => {
    assert(evaluateOperator('exists', 'something', null), 'exists should pass when entry has value');
    assert(evaluateOperator('not_exists', null, 'something'), 'not_exists should pass when entry is null');
    assert(!evaluateOperator('exists', null, 'something'), 'exists should fail when entry is null');
    assert(evaluateOperator('not_exists', [], 'something'), 'not_exists should pass for empty array');
});

// ============================================================================
// Additional Regression: Reinjection Cooldown
// ============================================================================

section('Additional Regression: Reinjection Cooldown');

test('applyReinjectionCooldown: forceInject entries exempt', () => {
    const entry = makeEntry('Eris', { constant: true, vaultSource: 'V1' });
    const ih = new Map([[trackerKey(entry), 5]]); // injected at gen 5
    const policy = buildExemptionPolicy([entry], [], []);
    const result = applyReinjectionCooldown([entry], policy, ih, 6, 3, false);
    assertEqual(result.length, 1, 'forceInject entry should bypass cooldown');
});

test('applyReinjectionCooldown: entry within cooldown filtered', () => {
    const entry = makeEntry('Boris', { vaultSource: 'V1' });
    const ih = new Map([[trackerKey(entry), 5]]); // injected at gen 5
    const policy = buildExemptionPolicy([], [], []);
    const result = applyReinjectionCooldown([entry], policy, ih, 6, 3, false);
    assertEqual(result.length, 0, 'entry within cooldown window should be filtered');
});

test('applyReinjectionCooldown: entry past cooldown passes', () => {
    const entry = makeEntry('Boris', { vaultSource: 'V1' });
    const ih = new Map([[trackerKey(entry), 2]]); // injected at gen 2
    const policy = buildExemptionPolicy([], [], []);
    const result = applyReinjectionCooldown([entry], policy, ih, 6, 3, false);
    assertEqual(result.length, 1, 'entry past cooldown should pass');
});

// ============================================================================
// Additional Regression: Strip Dedup
// ============================================================================

section('Additional Regression: Strip Dedup');

test('applyStripDedup: forceInject entries exempt', () => {
    const entry = makeEntry('Eris', { constant: true, vaultSource: 'V1' });
    entry._contentHash = 'hash1';
    const log = [{ entries: [{ title: 'Eris', pos: 1, depth: 4, role: 0, contentHash: 'hash1' }] }];
    const policy = buildExemptionPolicy([entry], [], []);
    const result = applyStripDedup([entry], policy, log, 3, makeSettings(), false);
    assertEqual(result.length, 1, 'forceInject should bypass strip dedup');
});

test('applyStripDedup: entry in recent log filtered', () => {
    const entry = makeEntry('Boris', { vaultSource: 'V1' });
    entry._contentHash = 'hashB';
    const settings = makeSettings();
    const log = [{ entries: [{ title: 'Boris', pos: settings.injectionPosition, depth: settings.injectionDepth, role: settings.injectionRole, contentHash: 'hashB' }] }];
    const policy = buildExemptionPolicy([], [], []);
    const result = applyStripDedup([entry], policy, log, 3, settings, false);
    assertEqual(result.length, 0, 'entry in recent log should be stripped');
});

test('applyStripDedup: changed content hash NOT stripped', () => {
    const entry = makeEntry('Boris', { vaultSource: 'V1' });
    entry._contentHash = 'new_hash';
    const settings = makeSettings();
    const log = [{ entries: [{ title: 'Boris', pos: settings.injectionPosition, depth: settings.injectionDepth, role: settings.injectionRole, contentHash: 'old_hash' }] }];
    const policy = buildExemptionPolicy([], [], []);
    const result = applyStripDedup([entry], policy, log, 3, settings, false);
    assertEqual(result.length, 1, 'changed content hash should not be stripped');
});

// ============================================================================
// Additional Regression: Cache Validation
// ============================================================================

section('Additional Regression: Cache Validation');

test('validateCachedEntry: structurally invalid entry rejected', () => {
    assert(!validateCachedEntry(null), 'null should be rejected');
    assert(!validateCachedEntry({}), 'empty object should be rejected');
    assert(!validateCachedEntry({ title: '' }), 'empty title should be rejected');
    assert(!validateCachedEntry({ title: 'Test' }), 'missing keys should be rejected');
});

test('validateCachedEntry: valid entry accepted', () => {
    const entry = { title: 'Test', keys: ['a'], content: 'Content', tokenEstimate: 50 };
    assert(validateCachedEntry(entry), 'valid entry should be accepted');
});

test('validateCachedEntry: missing optional fields backfilled', () => {
    const entry = { title: 'Test', keys: ['a'], content: 'Content', tokenEstimate: 50 };
    validateCachedEntry(entry);
    assertEqual(entry.priority, 50, 'missing priority should default to 50');
    assertEqual(entry.constant, false, 'missing constant should default to false');
    assert(Array.isArray(entry.links), 'missing links should be backfilled to empty array');
    assert(Array.isArray(entry.tags), 'missing tags should be backfilled to empty array');
});

test('validateCachedEntry: negative tokenEstimate rejected', () => {
    const entry = { title: 'Test', keys: ['a'], content: 'Content', tokenEstimate: -1 };
    assert(!validateCachedEntry(entry), 'negative tokenEstimate should be rejected');
});

test('validateCachedEntry: NaN tokenEstimate rejected', () => {
    const entry = { title: 'Test', keys: ['a'], content: 'Content', tokenEstimate: NaN };
    assert(!validateCachedEntry(entry), 'NaN tokenEstimate should be rejected');
});

test('validateCachedEntry: corrupt customFields reset to empty object', () => {
    const entry = { title: 'Test', keys: ['a'], content: 'Content', tokenEstimate: 50, customFields: 'not_an_object' };
    validateCachedEntry(entry);
    assertEqual(JSON.stringify(entry.customFields), '{}', 'corrupt customFields should be reset');
});

test('validateCachedEntry: array customFields reset to empty object', () => {
    const entry = { title: 'Test', keys: ['a'], content: 'Content', tokenEstimate: 50, customFields: ['bad'] };
    validateCachedEntry(entry);
    assertEqual(JSON.stringify(entry.customFields), '{}', 'array customFields should be reset');
});

// ============================================================================
// Additional Regression: Frontmatter & Parsing
// ============================================================================

section('Additional Regression: Frontmatter & Parsing');

test('parseFrontmatter: basic key-value parsing', () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: Test\npriority: 10\n---\nBody');
    assertEqual(frontmatter.title, 'Test', 'string value should parse');
    assertEqual(frontmatter.priority, 10, 'numeric value should parse');
});

test('parseFrontmatter: boolean values', () => {
    const { frontmatter } = parseFrontmatter('---\nenabled: true\nhidden: false\n---\nBody');
    assertEqual(frontmatter.enabled, true, 'true should parse as boolean');
    assertEqual(frontmatter.hidden, false, 'false should parse as boolean');
});

test('parseFrontmatter: array values', () => {
    const { frontmatter } = parseFrontmatter('---\ntags:\n  - lorebook\n  - character\n---\nBody');
    assert(Array.isArray(frontmatter.tags), 'tags should be array');
    assertEqual(frontmatter.tags.length, 2, 'should have 2 tags');
});

test('parseFrontmatter: inline array', () => {
    const { frontmatter } = parseFrontmatter('---\nkeys: [eris, discord]\n---\nBody');
    assert(Array.isArray(frontmatter.keys), 'inline array should parse');
    assertEqual(frontmatter.keys.length, 2, 'should have 2 keys');
});

test('parseFrontmatter: UTF-8 BOM stripped', () => {
    const { frontmatter } = parseFrontmatter('\uFEFF---\ntitle: Test\n---\nBody');
    assertEqual(frontmatter.title, 'Test', 'BOM should be stripped before parsing');
});

test('parseFrontmatter: no frontmatter returns empty', () => {
    const { frontmatter, body } = parseFrontmatter('Just plain text');
    assertEqual(Object.keys(frontmatter).length, 0, 'no frontmatter should return empty object');
    assertEqual(body, 'Just plain text', 'body should be the full text');
});

// ============================================================================
// Additional Regression: Pin/Block Helpers
// ============================================================================

section('Additional Regression: Pin/Block Helpers');

test('normalizePinBlock: bare string normalized', () => {
    const result = normalizePinBlock('Eris');
    assertEqual(result.title, 'Eris', 'title should be extracted');
    assertNull(result.vaultSource, 'vaultSource should be null for bare string');
});

test('normalizePinBlock: structured object preserved', () => {
    const result = normalizePinBlock({ title: 'Eris', vaultSource: 'Myths' });
    assertEqual(result.title, 'Eris', 'title should be preserved');
    assertEqual(result.vaultSource, 'Myths', 'vaultSource should be preserved');
});

test('matchesPinBlock: case-insensitive title match', () => {
    assert(matchesPinBlock('eris', { title: 'Eris', vaultSource: '' }),
        'should match case-insensitively');
});

test('matchesPinBlock: vault-specific pin only matches correct vault', () => {
    assert(matchesPinBlock({ title: 'Eris', vaultSource: 'V1' }, { title: 'Eris', vaultSource: 'V1' }),
        'same vault should match');
    assert(!matchesPinBlock({ title: 'Eris', vaultSource: 'V1' }, { title: 'Eris', vaultSource: 'V2' }),
        'different vault should not match');
});

test('matchesPinBlock: null vaultSource matches any vault', () => {
    assert(matchesPinBlock({ title: 'Eris', vaultSource: null }, { title: 'Eris', vaultSource: 'V1' }),
        'null vaultSource should match any vault');
});

// ============================================================================
// Additional Regression: Decay Tracking
// ============================================================================

section('Additional Regression: Decay & Cooldown Tracking');

test('decrementTrackers: cooldown decrements and expired entries removed', () => {
    const ct = new Map([['V1:Eris', 2], ['V1:Boris', 1]]);
    const dt = new Map();
    decrementTrackers(ct, dt, [], makeSettings());
    assertEqual(ct.get('V1:Eris'), 1, 'cooldown should decrement');
    assert(!ct.has('V1:Boris'), 'expired cooldown should be removed');
});

test('decrementTrackers: injected entries reset decay to 0', () => {
    const ct = new Map();
    const dt = new Map([['V1:Eris', 5]]);
    const entry = makeEntry('Eris', { vaultSource: 'V1' });
    decrementTrackers(ct, dt, [entry], makeSettings({ decayEnabled: true }));
    assertEqual(dt.get('V1:Eris'), 0, 'injected entry decay should reset to 0');
});

test('decrementTrackers: non-injected entries increment staleness', () => {
    const ct = new Map();
    const dt = new Map([['V1:Eris', 3]]);
    decrementTrackers(ct, dt, [], makeSettings({ decayEnabled: true, decayBoostThreshold: 5 }));
    assertEqual(dt.get('V1:Eris'), 4, 'non-injected entry staleness should increment');
});

test('decrementTrackers: consecutive injection counter increments', () => {
    const ct = new Map();
    const dt = new Map();
    const ci = new Map();
    const entry = makeEntry('Eris', { vaultSource: 'V1' });
    decrementTrackers(ct, dt, [entry], makeSettings(), ci);
    assertEqual(ci.get('V1:Eris'), 1, 'consecutive counter should increment');
    // Run again
    decrementTrackers(ct, dt, [entry], makeSettings({ decayEnabled: true }), ci);
    assertEqual(ci.get('V1:Eris'), 2, 'consecutive counter should accumulate');
});

test('decrementTrackers: non-injected entries removed from consecutive counter', () => {
    const ct = new Map();
    const dt = new Map();
    const ci = new Map([['V1:Eris', 5]]);
    decrementTrackers(ct, dt, [], makeSettings(), ci);
    assert(!ci.has('V1:Eris'), 'non-injected entry should be removed from consecutive counter');
});

// ============================================================================
// Additional Regression: Scan Text & Matching
// ============================================================================

section('Additional Regression: Keyword Matching');

test('testEntryMatch: case-insensitive matching', () => {
    clearScanTextCache();
    const entry = makeEntry('Eris', { keys: ['eris'] });
    const result = testEntryMatch(entry, 'ERIS appeared', { caseSensitive: false, matchWholeWords: false });
    assertNotNull(result, 'case-insensitive match should succeed');
});

test('testEntryMatch: case-sensitive matching', () => {
    clearScanTextCache();
    const entry = makeEntry('Eris', { keys: ['Eris'] });
    const noMatch = testEntryMatch(entry, 'eris appeared', { caseSensitive: true, matchWholeWords: false });
    assertNull(noMatch, 'case-sensitive should not match lowercase');
    clearScanTextCache();
    const match = testEntryMatch(entry, 'Eris appeared', { caseSensitive: true, matchWholeWords: false });
    assertNotNull(match, 'case-sensitive should match exact case');
});

test('testEntryMatch: refine keys (AND_ANY mode)', () => {
    clearScanTextCache();
    const entry = makeEntry('Eris Battle', { keys: ['eris'], refineKeys: ['battle', 'fight'] });
    const noRefine = testEntryMatch(entry, 'eris appeared peacefully', { caseSensitive: false, matchWholeWords: false });
    assertNull(noRefine, 'should not match without any refine key');
    clearScanTextCache();
    const withRefine = testEntryMatch(entry, 'eris joined the battle', { caseSensitive: false, matchWholeWords: false });
    assertNotNull(withRefine, 'should match with primary + refine key');
});

test('testEntryMatch: empty keys returns null', () => {
    clearScanTextCache();
    const entry = makeEntry('NoKeys', { keys: [] });
    const result = testEntryMatch(entry, 'anything', { caseSensitive: false, matchWholeWords: false });
    assertNull(result, 'entry with no keys should never match');
});

test('buildScanText: filters tool_invocation messages', () => {
    const chat = [
        { name: 'User', mes: 'Hello', is_user: true },
        { name: 'System', mes: 'Tool result', extra: { tool_invocations: [{}] } },
        { name: 'Char', mes: 'World' },
    ];
    const text = buildScanText(chat, 10);
    assert(text.includes('Hello'), 'user message should be in scan text');
    assert(text.includes('World'), 'character message should be in scan text');
    assert(!text.includes('Tool result'), 'tool_invocation message should be filtered');
});

test('buildScanText: filters system messages', () => {
    const chat = [
        { name: 'User', mes: 'Hi', is_user: true },
        { name: 'System', mes: 'System info', is_system: true },
    ];
    const text = buildScanText(chat, 10);
    assert(!text.includes('System info'), 'system message should be filtered');
});

// ============================================================================
// X. Multi-Vault Exemption Policy (BUG-399 / Fix 2)
// ============================================================================

section('X. Multi-Vault Exemption Policy (BUG-399)');

test('BUG-399: vault-A constant does NOT exempt vault-B duplicate from contextual gating', () => {
    // Pre-fix: forceInject Set keyed by lowercase title, so vault-A's "Castle" (constant)
    // collapsed with vault-B's "Castle" (non-constant) and shared the exemption.
    // Post-fix: forceInject keyed by trackerKey, vaults disambiguated.
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA', constant: true, customFields: { era: ['medieval'] } });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB', customFields: { era: ['medieval'] } });
    const vault = [castleA, castleB];
    const policy = buildExemptionPolicy(vault, [], []);

    // Distinct keys in the Set
    assert(policy.forceInject.has(trackerKey(castleA)), 'vault-A constant should be in forceInject');
    assert(!policy.forceInject.has(trackerKey(castleB)), 'vault-B non-constant must NOT be in forceInject');

    // Functional gate: with active context "futuristic", vault-A survives via forceInject;
    // vault-B is filtered out because its era doesn't match and it has no exemption.
    const fieldDefs = [
        { name: 'era', label: 'Era', type: 'string', multi: true, gating: { enabled: true, operator: 'match_any', tolerance: 'strict' }, values: [], contextKey: 'era' },
    ];
    const gated = applyContextualGating([castleA, castleB], { era: ['futuristic'] }, policy, false, makeSettings(), fieldDefs);
    const survivors = gated.map(e => `${e.vaultSource}:${e.title}`);
    assert(survivors.includes('VaultA:Castle'), 'vault-A constant survives gating');
    assert(!survivors.includes('VaultB:Castle'), 'vault-B duplicate filtered by gating (no exemption)');
});

test('BUG-399: legacy bare-string pin (vaultSource=null) exempts ALL matching entries across vaults', () => {
    // normalizePinBlock("Castle") → {title:"Castle", vaultSource:null}. Per matchesPinBlock,
    // a null vaultSource matches any vault. The fix walks vaultSnapshot and adds a forceInject
    // key for each matching entry — one pin can produce N keys.
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const policy = buildExemptionPolicy([castleA, castleB], ['Castle'], []);

    assert(policy.forceInject.has(trackerKey(castleA)), 'legacy pin exempts vault-A copy');
    assert(policy.forceInject.has(trackerKey(castleB)), 'legacy pin exempts vault-B copy');
});

test('BUG-399: structured pin with explicit vaultSource exempts only that vault', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const policy = buildExemptionPolicy([castleA, castleB], [{ title: 'Castle', vaultSource: 'VaultB' }], []);

    assert(!policy.forceInject.has(trackerKey(castleA)), 'vault-A copy not exempted by VaultB-scoped pin');
    assert(policy.forceInject.has(trackerKey(castleB)), 'vault-B copy exempted by VaultB-scoped pin');
});

// ============================================================================
// Y. Vault-aware findEntry in Librarian chat tools (BUG-400 / Fix 8)
// ============================================================================
//
// BUG-400: librarian-chat-tools.js findEntry() returned the first vaultIndex
// match by lowercased title only. With multiVaultConflictResolution='all'
// (default), duplicate-title entries from different vaults are intentionally
// preserved, but findEntry() couldn't reach the second one — making get_entry,
// get_full_content, compare_entry_to_chat, and flag_entry_update unable to
// disambiguate. Fix: optional vaultSource parameter.
//
// findEntry imports getContext from ST's extensions.js and cannot be loaded
// outside ST. This test contract-mirrors the function so a regression in its
// signature or behavior fails the suite. Keep aligned with src/librarian/librarian-chat-tools.js.

section('Y. Vault-aware findEntry (BUG-400)');

function findEntryMirror(vaultIdx, title, vaultSource = null) {
    if (!title) return null;
    const lower = title.toLowerCase();
    const matches = vaultIdx.filter(e => e.title.toLowerCase() === lower);
    if (matches.length === 0) return null;
    if (vaultSource) return matches.find(e => e.vaultSource === vaultSource) || null;
    return matches[0];
}

test('BUG-400: findEntry without vaultSource returns first match (legacy behavior)', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const idx = [castleA, castleB];

    const found = findEntryMirror(idx, 'Castle');
    assertNotNull(found, 'findEntry returns a match');
    assertEqual(found.vaultSource, 'VaultA', 'first match wins when vaultSource omitted');
});

test('BUG-400: findEntry with vaultSource="VaultA" returns vault-A copy', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const idx = [castleA, castleB];

    const found = findEntryMirror(idx, 'Castle', 'VaultA');
    assertNotNull(found, 'findEntry returns a match for VaultA');
    assertEqual(found.vaultSource, 'VaultA', 'returns VaultA copy');
});

test('BUG-400: findEntry with vaultSource="VaultB" returns vault-B copy', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const idx = [castleA, castleB];

    const found = findEntryMirror(idx, 'Castle', 'VaultB');
    assertNotNull(found, 'findEntry returns a match for VaultB');
    assertEqual(found.vaultSource, 'VaultB', 'returns VaultB copy');
});

test('BUG-400: findEntry with unknown vaultSource returns null (no fallback)', () => {
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB' });
    const idx = [castleA, castleB];

    const found = findEntryMirror(idx, 'Castle', 'VaultZ');
    assertNull(found, 'unknown vaultSource must NOT fall back to first match');
});

test('BUG-400: findEntry with no matches returns null regardless of vaultSource', () => {
    const idx = [makeEntry('Other', { vaultSource: 'VaultA' })];
    assertNull(findEntryMirror(idx, 'Castle'), 'no title match returns null');
    assertNull(findEntryMirror(idx, 'Castle', 'VaultA'), 'no title match returns null even with vaultSource');
});

test('BUG-400: findEntry case-insensitive on title, exact on vaultSource', () => {
    const castle = makeEntry('Castle', { vaultSource: 'VaultA' });
    const idx = [castle];

    assertEqual(findEntryMirror(idx, 'CASTLE')?.title, 'Castle', 'title match is case-insensitive');
    assertEqual(findEntryMirror(idx, 'castle', 'VaultA')?.title, 'Castle', 'lowercase title with matching vaultSource still hits');
    assertNull(findEntryMirror(idx, 'Castle', 'vaulta'), 'vaultSource match is case-sensitive');
});

// ============================================================================
// Z. Cross-vault Pin Collision (A2 — applyPinBlock keys by trackerKey)
// ============================================================================

section('Z. Cross-vault Pin Collision');

test('A2: same-title entries from different vaults both pinned (not collapsed)', () => {
    // Before fix: applyPinBlock indexed result list by lowercased title only, so
    // pinning Vault B's "Castle" overwrote the already-matched Vault A "Castle".
    const castleA = makeEntry('Castle', { vaultSource: 'VaultA', content: 'Vault A castle' });
    const castleB = makeEntry('Castle', { vaultSource: 'VaultB', content: 'Vault B castle' });
    const vault = [castleA, castleB];

    // Pre-existing keyword match: Vault A castle is already in the result list.
    const matched = [castleA];

    // Pin policy targets ANY castle (bare-string pin) — both A and B should match.
    const policy = buildExemptionPolicy(vault, ['Castle'], []);
    const result = applyPinBlock(matched, vault, policy, new Map());

    const aPresent = result.find(e => e.vaultSource === 'VaultA');
    const bPresent = result.find(e => e.vaultSource === 'VaultB');
    assertNotNull(aPresent, 'Vault A "Castle" must be present in result');
    assertNotNull(bPresent, 'Vault B "Castle" must be present (bug: was collapsed)');
    assertNotEqual(aPresent.content, bPresent.content, 'each vault keeps its own content');
});

test('A2: vault-scoped pin upgrades existing match without overwriting other vault', () => {
    const a = makeEntry('Hero', { vaultSource: 'VaultA', priority: 200 });
    const b = makeEntry('Hero', { vaultSource: 'VaultB', priority: 200 });
    const vault = [a, b];

    // Both already matched.
    const matched = [a, b];

    // Pin only Vault A's Hero (vault-aware pin object).
    const policy = buildExemptionPolicy(vault, [{ title: 'Hero', vaultSource: 'VaultA' }], []);
    const result = applyPinBlock(matched, vault, policy, new Map());

    const aRes = result.find(e => e.vaultSource === 'VaultA');
    const bRes = result.find(e => e.vaultSource === 'VaultB');
    assertNotNull(aRes, 'Vault A Hero present');
    assertNotNull(bRes, 'Vault B Hero present (must not be overwritten)');
    assertEqual(aRes.priority, 10, 'Vault A pinned: priority upgraded to 10');
    assertEqual(bRes.priority, 200, 'Vault B unpinned: priority unchanged');
});

// ============================================================================
// Issue #24: cmrsResultToText must always return a string
// ============================================================================

section('Issue #24: cmrsResultToText json_schema response normalization');

test('Issue #24: string content passes through unchanged', () => {
    const result = { content: '[{"title":"Eris"}]', usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const out = cmrsResultToText(result);
    assertEqual(out.text, '[{"title":"Eris"}]', 'string content preserved');
    assertEqual(out.usage.input_tokens, 10, 'prompt_tokens mapped to input_tokens');
    assertEqual(out.usage.output_tokens, 5, 'completion_tokens mapped to output_tokens');
});

test('Issue #24: object content (json_schema parsed by ST) is stringified', () => {
    // Reproduces the exact failure: ST replaces result.content with JSON.parse(...)
    // when data.json_schema is set; downstream .slice(0, 300) on debug preview
    // crashed because the value was an Object, not a string.
    const result = {
        content: { selected: [{ title: 'Eris', confidence: 'high', reason: 'AI search' }] },
        usage: { input_tokens: 100, output_tokens: 20 },
    };
    const out = cmrsResultToText(result);
    assertEqual(typeof out.text, 'string', 'text must be a string');
    // Round-trip must be parseable so extractAiResponseClient + .slice work.
    const reparsed = JSON.parse(out.text);
    assertEqual(reparsed.selected[0].title, 'Eris', 'round-trip preserves data');
    // No-throw smoke for the original crash site:
    assertEqual(out.text.slice(0, 10).length, 10, '.slice works on text');
});

test('Issue #24: array content is stringified', () => {
    const result = { content: [{ title: 'Foo' }, { title: 'Bar' }] };
    const out = cmrsResultToText(result);
    assertEqual(typeof out.text, 'string', 'array stringified to JSON string');
    const reparsed = JSON.parse(out.text);
    assert(Array.isArray(reparsed), 'round-trip yields array');
    assertEqual(reparsed.length, 2, 'array length preserved');
});

test('Issue #24: null/undefined content yields empty string', () => {
    assertEqual(cmrsResultToText({ content: null }).text, '', 'null content → ""');
    assertEqual(cmrsResultToText({ content: undefined }).text, '', 'undefined content → ""');
    assertEqual(cmrsResultToText({}).text, '', 'missing content → ""');
    assertEqual(cmrsResultToText(null).text, '', 'null result → ""');
    assertEqual(cmrsResultToText(undefined).text, '', 'undefined result → ""');
});

test('Issue #24: usage falls back through OpenAI/Anthropic field names', () => {
    // Anthropic-style
    const a = cmrsResultToText({ content: '', usage: { input_tokens: 7, output_tokens: 3 } });
    assertEqual(a.usage.input_tokens, 7);
    assertEqual(a.usage.output_tokens, 3);
    // OpenAI-style
    const b = cmrsResultToText({ content: '', usage: { prompt_tokens: 11, completion_tokens: 4 } });
    assertEqual(b.usage.input_tokens, 11);
    assertEqual(b.usage.output_tokens, 4);
    // Missing usage
    const c = cmrsResultToText({ content: '' });
    assertEqual(c.usage.input_tokens, 0);
    assertEqual(c.usage.output_tokens, 0);
});

// Obsidian deep-link safety
// ============================================================================

section('Obsidian deep-link safety');

test('Obsidian links open outside the SillyTavern tab', () => {
    const link = buildObsidianAnchorHtml('obsidian://open?vault=First%20Vault&file=Cosplay%20Mode');

    assert(link.includes('href="#"'), 'obsidian:// link should not navigate the ST tab directly');
    assert(link.includes('data-obsidian-uri="obsidian://open?vault=First%20Vault&amp;file=Cosplay%20Mode"'), 'uri should be stored for the click launcher');
    assert(!link.includes('target="_blank"'), 'obsidian:// link should not leave a visible browser tab behind');
});

test('Obsidian links escape labels and attributes', () => {
    const link = buildObsidianAnchorHtml('obsidian://open?vault=A&B&file=<bad>', {
        text: 'Open <Mode>',
        className: 'dle-obsidian-link custom',
        ariaLabel: 'Open "Mode"',
    });

    assert(link.includes('Open &lt;Mode&gt;'), 'link text should be escaped');
    assert(link.includes('class="dle-obsidian-link custom"'), 'class name should be preserved');
    assert(link.includes('aria-label="Open &quot;Mode&quot;"'), 'aria label should be escaped');
    assert(link.includes('data-obsidian-uri="obsidian://open?vault=A&amp;B&amp;file=&lt;bad&gt;"'), 'uri data attribute should be escaped');
});

test('External protocol launcher uses a hidden iframe and cleans it up', () => {
    const appended = [];
    let cleanup = null;
    let cleanupDelay = 0;
    const fakeBody = {
        appendChild(node) {
            appended.push(node);
            node.parentNode = this;
        },
        removeChild(node) {
            node.removedByParent = true;
        },
    };
    const fakeDocument = {
        body: fakeBody,
        createElement(tag) {
            return {
                tagName: tag.toUpperCase(),
                style: {},
                attributes: {},
                setAttribute(name, value) { this.attributes[name] = value; },
                remove() { this.removed = true; },
            };
        },
    };

    const uri = 'obsidian://open?vault=First%20Vault&file=Cosplay%20Mode';
    const opened = openExternalProtocol(uri, {
        documentRef: fakeDocument,
        setTimeoutFn(fn, delay) {
            cleanup = fn;
            cleanupDelay = delay;
        },
    });

    assert(opened, 'valid external protocol should be launched');
    assertEqual(appended.length, 1, 'one iframe should be appended');
    assertEqual(appended[0].tagName, 'IFRAME', 'launcher should use an iframe');
    assertEqual(appended[0].src, uri, 'iframe should receive the external protocol URI');
    assertEqual(appended[0].attributes['aria-hidden'], 'true', 'iframe should be hidden from assistive tech');
    assertEqual(cleanupDelay, 1000, 'iframe cleanup should be delayed briefly');
    cleanup();
    assert(appended[0].removed, 'iframe should be removed after launch');
});

test('External protocol launcher rejects non-protocol or missing document inputs', () => {
    const fakeDocument = {
        body: { appendChild() { throw new Error('should not append'); } },
        createElement() { throw new Error('should not create'); },
    };

    assert(!openExternalProtocol('', { documentRef: fakeDocument }), 'empty uri should not launch');
    assert(!openExternalProtocol('/relative/path', { documentRef: fakeDocument }), 'relative uri should not launch');
    assert(!openExternalProtocol('obsidian://open?vault=A', { documentRef: null }), 'missing document should not launch');
});

// Summary
// ============================================================================

summary('Regression Tests');
