/**
 * DeepLore — WI Import (pure helpers)
 *
 * Pure split of import.js — parsers and transforms that need NO ST imports or
 * settings access. Node-testable in isolation (import.js transitively pulls
 * settings.js which imports ST modules outside the project tree).
 *
 * Convention matches drawer-browse-pure.js / verdict-pure.js / wi-import-report-pure.js.
 */

/**
 * Parse ST World Info JSON (handles both export format and embedded character card format).
 * @param {string} jsonText - Raw JSON text
 * @returns {{ entries: object[], source: string }}
 */
export function parseWorldInfoJson(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
    } catch (e) {
        throw new Error('Invalid World Info JSON: ' + e.message);
    }

    const filterValid = (arr) => arr.filter(e => e && typeof e === 'object' && !Array.isArray(e));

    // Direct WI export { entries: { 0: {...}, 1: {...} } }
    if (data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
        const entries = filterValid(Object.values(data.entries));
        return { entries, source: data.originalData?.name || 'World Info' };
    }

    if (Array.isArray(data)) {
        return { entries: filterValid(data), source: 'World Info Array' };
    }

    // V2 character card with embedded WI
    if (data.data?.character_book?.entries) {
        const raw = Array.isArray(data.data.character_book.entries)
            ? data.data.character_book.entries
            : Object.values(data.data.character_book.entries);
        const entries = filterValid(raw);
        return { entries, source: data.data?.name || 'Character Card' };
    }

    throw new Error('Unrecognized World Info format. Expected ST WI export JSON or V2 character card.');
}

/**
 * #14 — Failure-site → category map for importEntries' structured failure
 * records. The category is assigned AT THE SOURCE, where the failure type is
 * actually known, instead of being re-derived downstream by keyword-sniffing
 * the flat error string (classifyFailure in wi-import-report-pure.js — kept
 * only as the fallback for legacy results that lack `failures[]`). Substring
 * sniffing misclassified e.g. a network error whose message contained
 * "attempts exceeded" as a name clash.
 *
 * Category vocabulary MUST stay aligned with wi-import-report-pure.js
 * (FAILURE_RETRYABLE + CATEGORY_LABEL_KEY): transient | collision | convert |
 * write | unknown.
 */
export const IMPORT_FAILURE_SITE_CATEGORY = Object.freeze({
    'dedup-transient': 'transient', // rename-scan existence probe hit a network error/abort
    'dedup-cap': 'collision',       // MAX_DEDUP_ATTEMPTS `_imported_N` names already taken
    'exist-check': 'transient',     // initial existence check threw (network/timeout)
    'write': 'write',               // Obsidian writeNote returned !ok
    'convert': 'convert',           // convertWiEntry threw (malformed entry)
    'unexpected': 'unknown',        // post-convert throw (writeNote/probe layers don't throw; defensive)
});

/**
 * Build one structured record for importEntries' `result.failures[]`.
 * Consumed by buildImportReport (wi-import-report-pure.js), which prefers
 * these over re-parsing the legacy flat `result.errors[]` strings.
 *
 * @param {string} site - one of the IMPORT_FAILURE_SITE_CATEGORY keys
 * @param {object} [fields]
 * @param {string} [fields.filename] - target vault filename ('' when conversion failed)
 * @param {string} [fields.title] - entry title hint for unnamed rows
 * @param {string} [fields.reason] - human-readable failure reason
 * @param {object|null} [fields.entry] - the source WI entry, so retry paths can
 *   re-run importEntries directly without reconstructing a filename→entry map
 * @returns {{ filename: string, title: string, reason: string, category: string, retryable: boolean, entry: object|null }}
 */
export function makeImportFailure(site, { filename = '', title = '', reason = '', entry = null } = {}) {
    const category = IMPORT_FAILURE_SITE_CATEGORY[site] || 'unknown';
    // Parity with FAILURE_RETRYABLE in wi-import-report-pure.js: every current
    // category allows a retry (collision after the user clears duplicates,
    // convert low-odds but permitted). Recorded on the row so the consumer
    // never re-derives it from the reason text.
    return { filename, title, reason, category, retryable: true, entry };
}
