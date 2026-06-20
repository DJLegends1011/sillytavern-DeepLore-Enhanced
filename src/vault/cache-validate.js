/**
 * DeepLore — Cache Entry Validation
 * Pure function extracted from cache.js for testability (no SillyTavern imports).
 */

/**
 * Validate a cached vault entry and backfill missing fields.
 * Returns false if the entry is structurally invalid (corrupt IndexedDB write).
 * Mutates the entry in-place to backfill missing optional fields.
 * @param {object} entry
 * @returns {boolean} true if entry is valid (possibly after backfill)
 */
export function validateCachedEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.title !== 'string' || !entry.title) return false;
    if (!Array.isArray(entry.keys)) return false;
    if (typeof entry.content !== 'string') return false;
    // Reject non-finite token estimates: NaN, ±Infinity, non-number, and negatives.
    // Infinity sneaks past a bare `typeof !== 'number'` check and poisons budget
    // math (every budget comparison against it short-circuits the pipeline).
    if (!Number.isFinite(entry.tokenEstimate) || entry.tokenEstimate < 0) return false;
    if (entry.links !== undefined && !Array.isArray(entry.links)) return false;
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) return false;
    if (entry.resolvedLinks !== undefined && !Array.isArray(entry.resolvedLinks)) return false;
    // Backfill criticals from partial writes.
    if (typeof entry.priority !== 'number' || Number.isNaN(entry.priority)) entry.priority = 50;
    if (typeof entry.constant !== 'boolean') entry.constant = false;
    if (entry.requires !== undefined && !Array.isArray(entry.requires)) entry.requires = [];
    if (entry.excludes !== undefined && !Array.isArray(entry.excludes)) entry.excludes = [];
    if (entry.probability !== undefined && entry.probability !== null && typeof entry.probability !== 'number') entry.probability = null;
    for (const field of ['links', 'resolvedLinks', 'tags']) {
        if (!Array.isArray(entry[field])) entry[field] = [];
    }
    // BUG-376: validate inner customFields values — reject non-plain-object containers
    // (Map, Set, etc.) and drop any inner value that's not a primitive or primitive-array.
    if (!entry.customFields || typeof entry.customFields !== 'object' || Array.isArray(entry.customFields)) {
        entry.customFields = {};
    } else {
        for (const [k, v] of Object.entries(entry.customFields)) {
            if (v == null) continue;
            const t = typeof v;
            if (t === 'string' || t === 'number' || t === 'boolean') continue;
            if (Array.isArray(v)) {
                if (v.every(x => x == null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) continue;
                delete entry.customFields[k];
                continue;
            }
            delete entry.customFields[k];
        }
    }
    return true;
}
