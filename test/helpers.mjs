/**
 * DeepLore Enhanced — Shared Test Utilities
 * Common assertion helpers, factories, and runner used by both unit and integration tests.
 */

// ============================================================================
// Test Runner — Counters & Core Assertions
// ============================================================================

export let passed = 0;
export let failed = 0;

export function resetCounters() {
    passed = 0;
    failed = 0;
}

export function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

export function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

export function assertNotEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    should not equal: ${JSON.stringify(expected)}`);
    }
}

export function assertThrows(fn, message) {
    try {
        fn();
        failed++;
        console.error(`  FAIL: ${message} (did not throw)`);
    } catch {
        passed++;
    }
}

// ============================================================================
// Extended Assertions
// ============================================================================

/**
 * Check that an array contains an item (deep equality via JSON.stringify).
 */
export function assertContains(array, item, message) {
    const itemStr = JSON.stringify(item);
    if (Array.isArray(array) && array.some(el => JSON.stringify(el) === itemStr)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    array does not contain: ${itemStr}`);
    }
}

/**
 * Check that a string matches a regex.
 */
export function assertMatch(string, regex, message) {
    if (typeof string === 'string' && regex instanceof RegExp && regex.test(string)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    string: ${JSON.stringify(string)}`);
        console.error(`    regex:  ${regex}`);
    }
}

/**
 * Floating-point approximate equality.
 */
export function assertApprox(actual, expected, epsilon, message) {
    if (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) <= epsilon) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected: ${expected} ± ${epsilon}`);
        console.error(`    actual:   ${actual}`);
    }
}

/**
 * Element-wise deep equality with better diff output (shows first mismatch index).
 */
export function assertArrayEquals(actual, expected, message) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    not both arrays — actual isArray: ${Array.isArray(actual)}, expected isArray: ${Array.isArray(expected)}`);
        return;
    }
    if (actual.length !== expected.length) {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    length mismatch — actual: ${actual.length}, expected: ${expected.length}`);
        return;
    }
    for (let i = 0; i < expected.length; i++) {
        if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
            failed++;
            console.error(`  FAIL: ${message}`);
            console.error(`    first mismatch at index ${i}:`);
            console.error(`      expected: ${JSON.stringify(expected[i])}`);
            console.error(`      actual:   ${JSON.stringify(actual[i])}`);
            return;
        }
    }
    passed++;
}

/**
 * Check actual > expected.
 */
export function assertGreaterThan(actual, expected, message) {
    if (actual > expected) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected ${actual} > ${expected}`);
    }
}

/**
 * Check actual < expected.
 */
export function assertLessThan(actual, expected, message) {
    if (actual < expected) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected ${actual} < ${expected}`);
    }
}

/**
 * Check value is null or undefined.
 */
export function assertNull(value, message) {
    if (value == null) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected null/undefined, got: ${JSON.stringify(value)}`);
    }
}

/**
 * Check value is NOT null/undefined.
 */
export function assertNotNull(value, message) {
    if (value != null) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected non-null value, got: ${value}`);
    }
}

/**
 * Check value is an instance of the given constructor.
 */
export function assertInstanceOf(value, constructor, message) {
    if (value instanceof constructor) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected instanceof ${constructor.name}, got: ${value?.constructor?.name ?? typeof value}`);
    }
}

// ============================================================================
// Test Runner — test/testAsync/section/summary
//
// Tests and section markers are enqueued in registration order and drained by
// summary() so async test bodies are properly awaited. Without this queue, a
// test('name', async () => { ... }) would return its Promise to test(), get
// discarded, and summary() would print counts BEFORE the async assertions ran
// — producing false-pass counts and (worst case) crashing the process AFTER
// the summary printed. See fix dispatch 2026-05-22.
// ============================================================================

const _queue = [];

export function test(name, fn) {
    _queue.push(async () => {
        console.log(`\n${name}`);
        await fn();
    });
}

// Back-compat alias: callers that historically used testAsync still work.
// Internally identical to test() now that test() awaits.
export const testAsync = test;

/**
 * Print a section header (visual separator between test groups). Enqueued so
 * section order is preserved relative to surrounding tests at drain time.
 */
export function section(name) {
    _queue.push(async () => {
        console.log(`\n${'='.repeat(76)}`);
        console.log(`  ${name}`);
        console.log(`${'='.repeat(76)}`);
    });
}

/**
 * Drain the queued tests/sections IN ORDER, then print the results summary and
 * exit with code 1 if any failures. Must be awaited at module top-level.
 * @param {string} [label] Optional label prefix (e.g. "Integration Tests")
 */
export async function summary(label) {
    while (_queue.length > 0) {
        const fn = _queue.shift();
        try {
            await fn();
        } catch (err) {
            failed++;
            console.error(`  UNCAUGHT in test: ${err?.stack || err}`);
        }
    }
    const total = passed + failed;
    console.log(`\n${'='.repeat(60)}`);
    if (label) {
        console.log(`${label}: ${passed} passed, ${failed} failed (${total} total)`);
    } else {
        console.log(`Results: ${passed} passed, ${failed} failed`);
    }
    console.log(`${'='.repeat(60)}`);
    if (failed > 0) {
        process.exit(1);
    }
}

// ============================================================================
// Factories
// ============================================================================

/**
 * Create a VaultEntry with sensible defaults. Override any field via opts.
 * @param {string} title
 * @param {object} [opts]
 * @returns {object} VaultEntry-shaped object
 */
export function makeEntry(title, opts = {}) {
    return {
        title,
        requires: opts.requires || [],
        excludes: opts.excludes || [],
        constant: opts.constant || false,
        seed: opts.seed || false,
        bootstrap: opts.bootstrap || false,
        keys: opts.keys || [],
        content: opts.content || '',
        summary: opts.summary || '',
        priority: opts.priority || 100,
        tokenEstimate: opts.tokenEstimate || 50,
        scanDepth: opts.scanDepth ?? null,
        excludeRecursion: opts.excludeRecursion || false,
        links: opts.links || [],
        resolvedLinks: opts.resolvedLinks || [],
        tags: opts.tags || [],
        injectionPosition: opts.injectionPosition ?? null,
        injectionDepth: opts.injectionDepth ?? null,
        injectionRole: opts.injectionRole ?? null,
        cooldown: opts.cooldown ?? null,
        warmup: opts.warmup ?? null,
        probability: opts.probability ?? null,
        cascadeLinks: opts.cascadeLinks || [],
        refineKeys: opts.refineKeys || [],
        vaultSource: opts.vaultSource || '',
        filename: opts.filename || `${title}.md`,
        customFields: opts.customFields || {},
        enabled: opts.enabled !== false,
        guide: opts.guide || false,
        folderPath: opts.folderPath || '',
    };
}

/**
 * Create a settings object with sensible defaults. Override any field via overrides.
 * @param {object} [overrides]
 * @returns {object} Settings-shaped object
 */
export function makeSettings(overrides = {}) {
    return {
        enabled: true,
        lorebookTag: 'lorebook',
        constantTag: 'lorebook-always',
        neverInsertTag: 'lorebook-never',
        seedTag: 'lorebook-seed',
        bootstrapTag: 'lorebook-bootstrap',
        scanDepth: 5,
        maxEntries: 20,
        unlimitedEntries: false,
        maxTokensBudget: 2000,
        unlimitedBudget: false,
        injectionPosition: 1,
        injectionDepth: 4,
        injectionRole: 'system',
        injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
        injectionMode: 'extension',
        allowWIScan: false,
        recursiveScan: false,
        maxRecursionSteps: 3,
        matchWholeWords: false,
        caseSensitive: false,
        characterContextScan: false,
        aiSearchEnabled: false,
        aiSearchMode: 'two-stage',
        stripDuplicateInjections: false,
        stripLookbackDepth: 3,
        reinjectionCooldown: 0,
        debugMode: false,
        decayEnabled: false,
        decayBoostThreshold: 5,
        decayPenaltyThreshold: 10,
        analyticsData: {},
        vaults: [{ name: 'Test', port: 27123, apiKey: 'test', enabled: true }],
        contextualGatingTolerance: 'strict',
        multiVaultConflictResolution: 'all',
        librarianConnectionMode: 'profile',
        librarianSessionMaxTokens: 4096,
        autoSuggestSkipReview: false,
        connectionManager: overrides.connectionManager || { selectedProfile: 'test-profile' },
        ...overrides,
    };
}

// ============================================================================
// Extended Factories — Multi-Vault, Librarian, Diagnostics
// ============================================================================

/**
 * Build a chat_metadata stub for popup-binding tests.
 * Includes deeplore_* keys that DLE reads/writes.
 * @param {object} [overrides]
 * @returns {object}
 */
export function makeChatMetadata(overrides = {}) {
    return {
        deeplore_pins: [],
        deeplore_blocks: [],
        deeplore_context: {},
        deeplore_injection_log: [],
        deeplore_chat_counts: {},
        deeplore_lore_gaps: [],
        deeplore_librarian_session: null,
        deeplore_notebook: '',
        deeplore_ai_notepad: '',
        deeplore_folder_filter: null,
        deeplore_swipe_injected_keys: {},
        ...overrides,
    };
}

/**
 * Build a Librarian session stub for sendMessage/regenerate tests.
 * @param {object} [opts]
 * @param {Array} [opts.messages] - Pre-existing message history
 * @param {object} [opts.draftState]
 * @returns {object}
 */
export function makeLibrarianSession(opts = {}) {
    return {
        messages: opts.messages || [],
        draftState: opts.draftState ?? null,
        entryPoint: opts.entryPoint || 'manual',
        gapRecord: opts.gapRecord || null,
        manifest: opts.manifest || '',
        chatContext: opts.chatContext || '',
        relatedEntries: opts.relatedEntries || [],
        workQueue: opts.workQueue || [],
        lastOptions: opts.lastOptions || null,
        mode: opts.mode || null,
        guideBootstrap: opts.guideBootstrap || '',
    };
}

/**
 * Build an option-card payload for option-apply tests.
 * Used for verifying explicit-null preservation (Fix 11).
 * @param {object} fields - Field overrides for the proposed option
 * @returns {object}
 */
export function makeDraftOption(fields = {}) {
    return {
        label: 'Test option',
        fields,
    };
}

/**
 * Build a fetch-response stub for vault.js per-file failure tests.
 * @param {object} [opts]
 * @param {Array} [opts.files] - File entries
 * @param {number} [opts.failed] - Per-file failure count
 * @param {number} [opts.total] - Total files attempted
 * @returns {object}
 */
export function makeFetchResponse(opts = {}) {
    const files = opts.files || [];
    return {
        files,
        failed: opts.failed ?? 0,
        total: opts.total ?? files.length,
    };
}
