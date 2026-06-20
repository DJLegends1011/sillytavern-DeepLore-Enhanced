/**
 * DeepLore Core — Pipeline Helpers
 */

import { parseFrontmatter, extractWikiLinks, cleanContent, extractTitle } from './utils.js';
import { extractCustomFields } from '../src/fields.js';
// BUG-094: use ST's canonical role-name → enum mapper. Resolved lazily so cold-start
// / Node tests don't crash if ST isn't loaded.
let _getExtensionPromptRoleByName = null;
let _roleByNameAttempted = false;
const _ROLE_FALLBACK = { system: 0, user: 1, assistant: 2 };
function _resolveRoleByName(name) {
    if (typeof name !== 'string') return null;
    const lower = name.toLowerCase();
    if (!_roleByNameAttempted) {
        _roleByNameAttempted = true;
        try {
            const g = (typeof window !== 'undefined' ? window : globalThis);
            if (g && typeof g.getExtensionPromptRoleByName === 'function') {
                _getExtensionPromptRoleByName = g.getExtensionPromptRoleByName;
            }
        } catch { /* ignore */ }
    }
    if (typeof _getExtensionPromptRoleByName === 'function') {
        const v = _getExtensionPromptRoleByName(lower);
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return _ROLE_FALLBACK[lower] ?? null;
}

/**
 * @typedef {object} VaultEntry
 * @property {string} filename - Full path in vault
 * @property {string} title - Display title (from H1 or filename)
 * @property {string[]} keys - Trigger keywords from frontmatter
 * @property {string} content - Cleaned markdown content (frontmatter stripped)
 * @property {string} summary - AI selection summary from frontmatter
 * @property {number} priority - Sort priority (lower = higher priority)
 * @property {boolean} constant - Always inject regardless of keywords
 * @property {boolean} seed - Content sent to AI as story context on new chats
 * @property {boolean} bootstrap - Force-inject when chat is short
 * @property {boolean} guide - Librarian-only writing/style/meta guide; never reaches the writing AI
 * @property {number} tokenEstimate - Rough token count estimate
 * @property {number|null} scanDepth - Per-entry scan depth override (null = use global)
 * @property {boolean} excludeRecursion - Don't scan this entry's content during recursion
 * @property {string[]} links - Wiki-link targets extracted before cleaning
 * @property {string[]} resolvedLinks - Links confirmed to match existing entry titles
 * @property {string[]} tags - All Obsidian tags (excluding the lorebook marker tag)
 * @property {string[]} requires - Entry titles that must all be matched for this entry to activate
 * @property {string[]} excludes - Entry titles that, if any matched, prevent this entry from activating
 * @property {string|null} outlet - Outlet name for macro-based injection (null = normal positional injection)
 * @property {number|null} injectionPosition - Per-entry injection position override (null = use global)
 * @property {number|null} injectionDepth - Per-entry injection depth override (null = use global)
 * @property {number|null} injectionRole - Per-entry injection role override (null = use global)
 * @property {number|null} cooldown - Generations to skip after triggering (null = no cooldown)
 * @property {number|null} warmup - Keyword hit count required before triggering (null = no warmup)
 * @property {number|null} probability - Chance of triggering when matched (0.0-1.0, null = always trigger)
 * @property {string|null} folderPath - Parent folder path within vault (null = vault root)
 * @property {string} vaultSource - Name of the vault this entry came from (multi-vault)
 * @property {Object<string, *>} customFields - User-defined custom fields extracted by field definitions
 * @property {boolean} graph - Whether this entry should appear in the relationship graph (default true)
 */

/**
 * @typedef {object} TagConfig
 * @property {string} lorebookTag - Tag that marks an entry as a lorebook entry
 * @property {string} constantTag - Tag for always-inject entries
 * @property {string} neverInsertTag - Tag for entries to skip
 * @property {string} [seedTag] - Tag for seed entries (Enhanced only)
 * @property {string} [bootstrapTag] - Tag for bootstrap entries (Enhanced only)
 * @property {string} [guideTag] - Tag for Librarian-only writing-guide entries
 */

/**
 * Canonical frontmatter names keyed by lowercased lookup form. `scanDepth` and
 * `excludeRecursion` stay camelCase — the readers below use camelCase (grandfathered
 * before this alias table existed).
 */
/**
 * WI parity — parser-side round-trip preservation table. ST fields DLE does
 * NOT enforce; landed in vault frontmatter as snake_case keys and flagged via
 * `W_WI_ROUND_TRIP` for /dle-lint visibility.
 *
 * Module-level export so the WI-PARITY-1 drift guard (test/regression.test.mjs)
 * can set-compare against the importer table in `src/helpers.js`
 * (`WI_ROUND_TRIP_FIELDS`). A field appearing in one table but not the other
 * is a silent downgrade — see docs/gotchas.md #69 for the contract.
 *
 * Distinct from WI_NOT_IMPLEMENTED fields (sticky/delay/group/group_weight)
 * which carry BUG numbers signaling "planned to implement."
 *
 * selectiveLogic intentionally absent — native enforcement in Wave 3
 * (selective_logic in CANONICAL_FM_LOOKUP, validated below to W_INVALID).
 */
export const WI_ROUND_TRIP_FIELDS = [
    'vectorized', 'selective', 'use_probability', 'prevent_recursion',
    'delay_until_recursion', 'group_override', 'use_group_scoring',
    'case_sensitive', 'match_whole_words', 'automation_id', 'add_memo',
    'display_index', 'match_persona_description', 'match_character_description',
    'match_character_personality', 'match_character_depth_prompt',
    'match_scenario', 'match_creator_notes',
    // Audit fix-up: modern ST fields (originalWIDataKeyMap, world-info.js).
    'triggers', 'ignore_budget', 'character_filter', 'decorators',
];

/**
 * Set form of WI_ROUND_TRIP_FIELDS (+ the W_NOT_IMPLEMENTED set: sticky/delay/
 * group/group_weight). Consumed by `src/ai/manifest.js` to BLACKLIST these
 * fields from the manifest sent to the AI selector — pre-fix every WI-imported
 * entry paid per-gen tokens for a noise blob of "Vectorized: true | Match
 * Persona Description: true | …" that the AI couldn't act on. See round-2
 * cross-feature audit + gotchas.md #69.
 */
export const WI_PARITY_FIELD_SET = new Set([
    ...WI_ROUND_TRIP_FIELDS,
    'sticky', 'delay', 'group', 'group_weight',
]);

const CANONICAL_FM_LOOKUP = {
    keys: 'keys',
    tags: 'tags',
    priority: 'priority',
    summary: 'summary',
    depth: 'depth',
    position: 'position',
    role: 'role',
    scandepth: 'scanDepth',
    cooldown: 'cooldown',
    warmup: 'warmup',
    probability: 'probability',
    requires: 'requires',
    excludes: 'excludes',
    refine_keys: 'refine_keys',
    cascade_links: 'cascade_links',
    enabled: 'enabled',
    constant: 'constant',
    seed: 'seed',
    bootstrap: 'bootstrap',
    guide: 'guide',
    outlet: 'outlet',
    era: 'era',
    location: 'location',
    scene_type: 'scene_type',
    character_present: 'character_present',
    graph: 'graph',
    excluderecursion: 'excludeRecursion',
    selective_logic: 'selective_logic',
};

/**
 * Normalize non-canonical case variants of known frontmatter keys in-place.
 * Pushes a `W_ALIAS_USED` warning for each rewrite. If both variants exist, canonical wins.
 * @param {object} fm - Frontmatter object (mutated)
 * @param {Array} warnings - Warning sink
 */
function normalizeFrontmatterKeys(fm, warnings) {
    for (const key of Object.keys(fm)) {
        const lower = key.toLowerCase();
        const canonical = CANONICAL_FM_LOOKUP[lower];
        if (!canonical || key === canonical) continue;
        if (Object.prototype.hasOwnProperty.call(fm, canonical)) {
            // Canonical wins — drop the alias silently.
            delete fm[key];
            continue;
        }
        fm[canonical] = fm[key];
        delete fm[key];
        warnings.push({
            code: 'W_ALIAS_USED',
            severity: 'warn',
            field: key,
            message: `Field '${key}' should be '${canonical}'.`,
            suggestedFix: `Rename '${key}:' to '${canonical}:'.`,
        });
    }
}

/**
 * Coerce a value to a number when lenient. Returns { value, warned } — `value` is
 * the coerced number if successful, or null if not coercible (caller keeps default).
 */
function coerceNumber(raw, fieldName, warnings, lenient) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, warned: false };
    if (!lenient) return { value: null, warned: false };
    if (typeof raw === 'string' && raw.trim() !== '' && !isNaN(Number(raw))) {
        const coerced = Number(raw);
        warnings.push({
            code: 'W_COERCED_NUM',
            severity: 'warn',
            field: fieldName,
            message: `Field '${fieldName}' should be a number, got string "${raw}". Coerced to ${coerced}.`,
            suggestedFix: `Remove the quotes around ${fieldName}'s value.`,
        });
        return { value: coerced, warned: true };
    }
    return { value: null, warned: false };
}

/**
 * Parse a single vault file into a VaultEntry, or return null if it should be skipped.
 * @param {{ filename: string, content: string }} file - Raw file from server
 * @param {TagConfig} tagConfig - Tag configuration from settings
 * @param {import('../src/fields.js').FieldDefinition[]} [fieldDefinitions] - Custom field definitions (optional, for extracting customFields)
 * @param {{ lenientAuthoring?: boolean, onSkip?: (reason: string) => void }} [options] - Parser options
 * @returns {VaultEntry|null}
 */
export function parseVaultFile(file, tagConfig, fieldDefinitions, options = {}) {
    const lenient = options.lenientAuthoring !== false;
    const onSkip = typeof options.onSkip === 'function' ? options.onSkip : null;
    const warnings = [];

    const { frontmatter, body } = parseFrontmatter(file.content);

    // Lenient alias normalization — rewrite `Keys` → `keys`, etc.
    if (lenient) normalizeFrontmatterKeys(frontmatter, warnings);

    const hasAnyFrontmatter = Object.keys(frontmatter).length > 0;

    const tags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.map(t => String(t).toLowerCase())
        : (typeof frontmatter.tags === 'string' ? [frontmatter.tags.toLowerCase()] : []);

    const tagToMatch = tagConfig.lorebookTag.toLowerCase();
    const guideTagToMatch = tagConfig.guideTag ? tagConfig.guideTag.toLowerCase() : '';
    const hasGuideTag = !!(guideTagToMatch && tags.includes(guideTagToMatch));
    // Guide entries admitted without the lorebook tag — they live in the index for Emma's tools.
    if (!tags.includes(tagToMatch) && !hasGuideTag) {
        if (onSkip) onSkip(hasAnyFrontmatter ? 'SKIP_NO_LOREBOOK_TAG' : 'SKIP_NO_FRONTMATTER');
        return null;
    }

    if (frontmatter.enabled === false) {
        if (onSkip) onSkip('SKIP_ENABLED_FALSE');
        return null;
    }

    const neverInsertTagToMatch = tagConfig.neverInsertTag ? tagConfig.neverInsertTag.toLowerCase() : '';
    if (neverInsertTagToMatch && tags.includes(neverInsertTagToMatch)) {
        if (onSkip) onSkip('SKIP_NEVER_INSERT_TAG');
        return null;
    }

    // Extract keys — lenient comma-string auto-split.
    let keys;
    if (Array.isArray(frontmatter.keys)) {
        keys = frontmatter.keys.map(k => String(k));
    } else if (typeof frontmatter.keys === 'string') {
        const raw = frontmatter.keys;
        if (lenient && raw.includes(',')) {
            keys = raw.split(',').map(k => k.trim()).filter(Boolean);
            warnings.push({
                code: 'W_COMMA_SPLIT',
                severity: 'warn',
                field: 'keys',
                message: `'keys' was a comma-separated string ("${raw}"). Split into ${keys.length} keys.`,
                suggestedFix: 'Use a YAML list (one key per line with `- `) instead of a comma-separated string.',
            });
        } else {
            keys = [raw];
        }
    } else if (frontmatter.keys) {
        keys = [String(frontmatter.keys)];
    } else {
        keys = [];
    }

    const title = extractTitle(body, file.filename);
    // Empty/whitespace title (untitled file, or an H1 that strips to nothing) would enter the
    // index with title:'' → trackerKey "vaultSource:" → every empty-title entry collapses to one
    // key (cooldown/analytics/pins collide). validateCachedEntry rejects it on reload
    // (cache-validate.js:15), so a freshly-parsed one would vanish after restart. Skip here so
    // fresh-parse and cache agree (gotcha #50 empty-title variant).
    if (!title || !title.trim()) {
        if (onSkip) onSkip('SKIP_EMPTY_TITLE');
        return null;
    }
    const links = extractWikiLinks(body);
    const content = cleanContent(body);
    const priorityCoerced = coerceNumber(frontmatter.priority, 'priority', warnings, lenient);
    const priority = priorityCoerced.value !== null ? priorityCoerced.value : 100;

    const constantTagToMatch = tagConfig.constantTag ? tagConfig.constantTag.toLowerCase() : '';
    const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));

    const seedTagToMatch = tagConfig.seedTag ? tagConfig.seedTag.toLowerCase() : '';
    const seed = !!(seedTagToMatch && tags.includes(seedTagToMatch));

    const bootstrapTagToMatch = tagConfig.bootstrapTag ? tagConfig.bootstrapTag.toLowerCase() : '';
    const bootstrap = !!(bootstrapTagToMatch && tags.includes(bootstrapTagToMatch));

    // Librarian-only — filtered out of every writing-AI surface.
    const guide = hasGuideTag;

    const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
    const excludeRecursion = frontmatter.excludeRecursion === true;

    // Normalize a field that should be array-of-string but may be a scalar string in YAML.
    const toArray = v => Array.isArray(v) ? v.map(r => String(r).trim()).filter(Boolean)
        : (v ? [String(v).trim()].filter(Boolean) : []);

    const requires = toArray(frontmatter.requires);
    const excludes = toArray(frontmatter.excludes);
    const refineKeys = toArray(frontmatter.refine_keys);
    const cascadeLinks = toArray(frontmatter.cascade_links);

    // Folder path is derived from filename, not frontmatter.
    const folderPath = file.filename.includes('/') ? file.filename.split('/').slice(0, -1).join('/') : null;

    const outlet = typeof frontmatter.outlet === 'string' && frontmatter.outlet.trim()
        ? frontmatter.outlet.trim() : null;

    // BUG-093: positions still need a static name→enum map (ST exports no public
    // name resolver for positions); roles route through ST's helper below.
    const positionMap = { before: 2, after: 0, in_chat: 1 };

    const injectionPosition = typeof frontmatter.position === 'string'
        ? (positionMap[frontmatter.position.toLowerCase()] ?? null) : null;
    // BUG-092: clamp depth to MAX_INJECTION_DEPTH (10000) — a typo like depth: 50000
    // would otherwise make the entry vanish silently.
    let injectionDepth = null;
    if (typeof frontmatter.depth === 'number' && Number.isFinite(frontmatter.depth)) {
        const d = frontmatter.depth;
        if (d < 0) {
            console.warn(`[DLE] entry "${file.filename}": depth ${d} < 0 — clamping to 0`);
            injectionDepth = 0;
        } else if (d > 10000) {
            console.warn(`[DLE] entry "${file.filename}": depth ${d} exceeds MAX_INJECTION_DEPTH (10000) — clamping`);
            injectionDepth = 10000;
        } else {
            injectionDepth = d;
        }
    }
    // BUG-094: route role names through ST's helper so future role additions work
    // without code changes here.
    const injectionRole = typeof frontmatter.role === 'string'
        ? _resolveRoleByName(frontmatter.role) : null;

    const cooldownCoerced = coerceNumber(frontmatter.cooldown, 'cooldown', warnings, lenient);
    const cooldown = cooldownCoerced.value !== null && cooldownCoerced.value > 0 ? cooldownCoerced.value : null;
    const warmupCoerced = coerceNumber(frontmatter.warmup, 'warmup', warnings, lenient);
    const warmup = warmupCoerced.value !== null && warmupCoerced.value > 0 ? warmupCoerced.value : null;

    const probabilityCoerced = coerceNumber(frontmatter.probability, 'probability', warnings, lenient);
    const probability = probabilityCoerced.value !== null
        ? Math.max(0, Math.min(1, probabilityCoerced.value))
        : null;

    // Coerce numeric summaries to string — YAML may parse "42" as a number.
    const summary = (typeof frontmatter.summary === 'string' || typeof frontmatter.summary === 'number')
        ? String(frontmatter.summary).trim() : '';

    // Wave 3 (WI parity) — native selective_logic enforcement. Validate enum;
    // unknown values fall back to 'and_any' (current behavior) so a typo doesn't
    // silently break matching. W_INVALID surfaces the typo via /dle-lint.
    const SELECTIVE_LOGIC_VALUES = ['and_any', 'and_all', 'not_all', 'not_any'];
    let selectiveLogic = 'and_any';
    if (frontmatter.selective_logic != null) {
        const raw = String(frontmatter.selective_logic).toLowerCase().trim();
        if (SELECTIVE_LOGIC_VALUES.includes(raw)) {
            selectiveLogic = raw;
        } else {
            warnings.push({
                code: 'W_INVALID',
                severity: 'warn',
                field: 'selective_logic',
                message: `Invalid selective_logic "${frontmatter.selective_logic}". Falling back to 'and_any'. Valid: ${SELECTIVE_LOGIC_VALUES.join(', ')}.`,
                suggestedFix: `Set selective_logic to one of: ${SELECTIVE_LOGIC_VALUES.join(', ')}, or omit for default 'and_any'.`,
            });
        }
    }

    const customFields = extractCustomFields(frontmatter, fieldDefinitions || []);

    // Audit fix-up: if the user registered any of these snake_case names as
    // their own custom field via `field-definitions.yaml`, suppress the
    // WI-parity flag — their custom field is the source of truth, not the WI
    // import contract. Without this, a pre-v2.5 user with a custom field
    // literally named `vectorized` or `case_sensitive` sees /dle-lint warnings
    // + a misleading "imported from SillyTavern WI" message. The custom field
    // still works (extractCustomFields ran above); we just stop lying about
    // its provenance.
    const userFieldNames = new Set((fieldDefinitions || []).map(f => f.name));

    // C.3: round-trip-safe preservation of WI fields DLE has BUG numbers for
    // (planned-to-implement). Stored in customFields, flagged via W_NOT_IMPLEMENTED
    // so /dle-lint surfaces them.
    const WI_NOT_IMPLEMENTED_FIELDS = [
        { key: 'sticky', bug: 'BUG-047' },
        { key: 'delay', bug: 'BUG-048' },
        { key: 'group', bug: 'BUG-052' },
        { key: 'group_weight', bug: 'BUG-052' },
    ];
    for (const { key: fieldName, bug } of WI_NOT_IMPLEMENTED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(frontmatter, fieldName)) {
            customFields[fieldName] = frontmatter[fieldName];
            if (userFieldNames.has(fieldName)) continue;
            warnings.push({
                code: 'W_NOT_IMPLEMENTED',
                severity: 'warn',
                field: fieldName,
                message: `Field '${fieldName}' preserved but not enforced yet (${bug}).`,
                suggestedFix: `Remove '${fieldName}' if you don't need it round-tripped.`,
            });
        }
    }

    // Wave 2 (WI parity) — Tier C round-trip preservation. Snake-case keys
    // for the parser-side flag pass. Module-level export so the WI-PARITY-1
    // regression guard can set-compare against the importer table (src/helpers.js
    // WI_ROUND_TRIP_FIELDS) instead of substring-grepping for the literal.
    for (const fieldName of WI_ROUND_TRIP_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(frontmatter, fieldName)) {
            customFields[fieldName] = frontmatter[fieldName];
            if (userFieldNames.has(fieldName)) continue;
            warnings.push({
                code: 'W_WI_ROUND_TRIP',
                severity: 'warn',
                field: fieldName,
                message: `Field '${fieldName}' preserved from SillyTavern WI import. DLE does not act on it.`,
                suggestedFix: `Remove '${fieldName}' if you don't need it preserved for round-trip readability.`,
            });
        }
    }

    // Strip the marker tags themselves; preserve everything else.
    const entryTags = tags.filter(t => t !== tagToMatch && t !== guideTagToMatch);

    return {
        filename: file.filename,
        title,
        keys,
        content,
        summary,
        priority,
        constant,
        seed,
        bootstrap,
        guide,
        tokenEstimate: 0,
        scanDepth,
        excludeRecursion,
        links,
        resolvedLinks: [],
        tags: entryTags,
        requires,
        excludes,
        refineKeys,
        cascadeLinks,
        outlet,
        injectionPosition,
        injectionDepth,
        injectionRole,
        cooldown,
        warmup,
        probability,
        folderPath,
        vaultSource: '',
        customFields,
        graph: frontmatter.graph !== false,
        selectiveLogic,
        _parserWarnings: warnings.length > 0 ? warnings : undefined,
    };
}

/**
 * Clear all DeepLore-managed extension prompts from the prompt dictionary.
 * @param {object} extensionPrompts - The extension_prompts dictionary
 * @param {string} promptTagPrefix - Prefix for prompt tags (e.g. 'deeplore_')
 * @param {string} promptTag - The main prompt tag (e.g. 'deeplore_enhanced')
 */
export function clearPrompts(extensionPrompts, promptTagPrefix, promptTag) {
    for (const key of Object.keys(extensionPrompts)) {
        if (key.startsWith(promptTagPrefix) || key === promptTag || key.startsWith('customWIOutlet_')) {
            delete extensionPrompts[key];
        }
    }
}
