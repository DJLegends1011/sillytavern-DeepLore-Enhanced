/**
 * DeepLore Enhanced — settings migration pure helpers.
 *
 * Extracted so version-to-version transformations can be regression-tested
 * without ST globals. NO imports from ST modules. NO imports from state.js.
 *
 * Consumed by `settings.js` (`runMigrations()` is re-exported from there for
 * call-site compatibility) and `test/regression.test.mjs` (PRX-MIG suite).
 *
 * When adding a new migration step:
 *   1. Bump `defaultSettings.settingsVersion` in `settings.js`.
 *   2. Add `if (fromVersion < N)` branch here.
 *   3. Add regression test(s) — at minimum: from-v(N-1)-applies, from-vN-is-noop,
 *      no-op-when-nothing-to-do, idempotent.
 */

/**
 * Per-feature settings keys whose value gets flipped from 'proxy' → 'profile' in the v2.5
 * migration. Order matters: the boot popup highlights the FIRST entry that flipped, so this
 * is also the precedence order for "which dropdown gets the pulse-glow first." The visible
 * label is i18n-resolved at popup-render time (see _maybeShowProxyDeprecationNotice in
 * index.js) — these are the canonical mode-key identifiers.
 */
export const PROXY_DEPRECATION_MODE_KEYS = [
    'aiSearchConnectionMode',
    'scribeConnectionMode',
    'librarianConnectionMode',
    'aiNotepadConnectionMode',
    'autoSuggestConnectionMode',
    'optimizeKeysConnectionMode',
];

/**
 * Pure version-to-version settings migration. Mutates `settings` in place.
 * Idempotent per-branch: each `if (fromVersion < N)` gate fires at most once,
 * so callers that re-invoke after a partial run (e.g. settings reload) don't
 * re-apply migrations.
 *
 * @param {object} settings - Settings object (mutated in place).
 * @param {number} fromVersion - Stored version (`settings.settingsVersion`, or 0 if unset).
 * @param {number} [_toVersion] - Target version (currently unused; kept for future fan-out).
 */
export function runMigrations(settings, fromVersion, _toVersion) {
    if (fromVersion < 1) {
        // 0 → 1: initial versioned settings (no-op).
        if (settings.debugMode) console.log('[DLE] Migrating settings to version 1');
    }
    if (fromVersion < 2) {
        // 1 → 2: AI Connections consolidation. Rename librarianSessionModel → librarianModel.
        // Other tools' connectionMode is intentionally NOT touched — existing users keep their explicit settings.
        if (settings.debugMode) console.log('[DLE] Migrating settings to version 2 (AI Connections consolidation)');
        if (settings.librarianSessionModel) {
            settings.librarianModel = settings.librarianSessionModel;
        }
        delete settings.librarianSessionModel;
    }
    if (fromVersion < 3) {
        // 2 → 3: only unconfigured Librarian (profile mode, no profileId) flips to 'inherit'.
        // Users who explicitly chose a profile keep that selection.
        if (settings.debugMode) console.log('[DLE] Migrating settings to version 3 (Librarian inherit default)');
        if (settings.librarianConnectionMode === 'profile' && !settings.librarianProfileId) {
            settings.librarianConnectionMode = 'inherit';
        }
    }
    if (fromVersion < 4) {
        // 3 → 4: Custom Proxy connection mode removed in v2.5. Any per-feature mode
        // currently set to 'proxy' flips to 'profile'. We do NOT touch *ProxyUrl keys
        // (kept for rollback) and we do NOT touch profileId — the user may need to
        // pick a profile, which is the point of the post-migration popup.
        //
        // Sentinel: settings._proxyMigrationV2_5_notice = [modeKey, …] — consumed
        // by _maybeShowProxyDeprecationNotice() at boot, then cleared. Only set when
        // at least one key actually flipped (no popup for users who weren't on proxy).
        const migratedKeys = [];
        for (const key of PROXY_DEPRECATION_MODE_KEYS) {
            if (settings[key] === 'proxy') {
                settings[key] = 'profile';
                migratedKeys.push(key);
            }
        }
        if (migratedKeys.length > 0) {
            settings._proxyMigrationV2_5_notice = migratedKeys;
            console.warn('[DLE] v2.5 migration: flipped Custom Proxy mode to Connection Profile for:', migratedKeys);
        }
    }
}
