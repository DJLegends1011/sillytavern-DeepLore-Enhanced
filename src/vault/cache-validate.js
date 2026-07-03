/**
 * DeepLore — Cache Entry Validation
 * Pure function extracted from cache.js for testability (no SillyTavern imports).
 */

import { DEFAULT_PRIORITY } from '../../core/pipeline.js';

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
    // #15: backfill the PARSER's default (100), not 50 — lower = higher priority,
    // so the old 50 made corrupt-cache entries outrank fresh parses of the same file.
    if (typeof entry.priority !== 'number' || Number.isNaN(entry.priority)) entry.priority = DEFAULT_PRIORITY;
    if (typeof entry.constant !== 'boolean') entry.constant = false;
    if (entry.requires !== undefined && !Array.isArray(entry.requires)) entry.requires = [];
    if (entry.excludes !== undefined && !Array.isArray(entry.excludes)) entry.excludes = [];
    if (entry.probability !== undefined && entry.probability !== null && typeof entry.probability !== 'number') entry.probability = null;
    for (const field of ['links', 'resolvedLinks', 'tags']) {
        if (!Array.isArray(entry[field])) entry[field] = [];
    }
    // #16: element-type sanitation. Array.isArray alone lets a single non-string
    // element (corrupt IDB write) reach computeEntityDerivedState, where
    // `.toLowerCase()` throws under the blanket hydration try/catch — silently
    // disabling whole-vault cache hydration. Policy: keep strings as-is; coerce
    // finite numbers via String() (a YAML author's bare `keys: [42]` round-trips
    // as a number); DROP everything else (null/undefined/boolean/object/array/
    // NaN/±Infinity). requires/excludes may legitimately be undefined — skipped.
    for (const field of ['keys', 'links', 'resolvedLinks', 'tags', 'requires', 'excludes']) {
        const arr = entry[field];
        if (!Array.isArray(arr)) continue;
        if (arr.every(v => typeof v === 'string')) continue;
        entry[field] = arr
            .map(v => typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null))
            .filter(v => v !== null);
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
