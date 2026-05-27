/**
 * DeepLore Enhanced — WI Import (pure helpers)
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
