/**
 * Pure helpers for the Browse tab — folder grouping + selection math.
 *
 * No imports from ST modules or jQuery. Keep it that way so test/unit.mjs
 * can import without standing up the harness.
 *
 * Row-model contract:
 *   [{ type: 'header', folder, count, expanded }, { type: 'entry', entry, folder }, ...]
 *
 * Headers are virtual-scrollable rows just like entries — they occupy a row
 * slot. When grouping is OFF, the row model is just flat entry rows (no headers).
 * When a folder is COLLAPSED, its child entry rows are omitted from the model.
 */

const ROOT_LABEL = '(root)';

/**
 * Top-level folder bucket for an entry. Multi-segment paths bucket on the first
 * segment so 'Locations/Cities/Vire' groups under 'Locations'. Entries without
 * a folderPath bucket under '(root)'.
 *
 * @param {{folderPath?: string}} entry
 * @returns {string}
 */
export function topFolderOf(entry) {
    if (!entry || !entry.folderPath) return ROOT_LABEL;
    const seg = String(entry.folderPath).split('/')[0];
    return seg || ROOT_LABEL;
}

/**
 * Build the row model the virtual-scroll renderer walks.
 *
 * @param {Array<object>} entries - already filtered + sorted
 * @param {object} opts
 * @param {boolean} [opts.grouping=false] - false → flat row list (current behavior)
 * @param {Set<string>|null} [opts.expandedFolders=null] - which top-folder names are expanded
 * @returns {Array<{type: string, folder?: string, entry?: object, count?: number, expanded?: boolean}>}
 */
export function buildBrowseRowModel(entries, opts = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const grouping = !!opts.grouping;
    if (!grouping) {
        return entries.map(e => ({ type: 'entry', entry: e, folder: topFolderOf(e) }));
    }

    const expandedFolders = opts.expandedFolders instanceof Set ? opts.expandedFolders : null;

    // Stable bucket order = order of first appearance in entries (preserves sort).
    const bucketOrder = [];
    const buckets = new Map();
    for (const e of entries) {
        const folder = topFolderOf(e);
        if (!buckets.has(folder)) {
            bucketOrder.push(folder);
            buckets.set(folder, []);
        }
        buckets.get(folder).push(e);
    }

    const rows = [];
    for (const folder of bucketOrder) {
        const group = buckets.get(folder);
        // Default expanded = true (no Set means everything open); explicit Set means
        // only listed folders are expanded.
        const expanded = expandedFolders ? expandedFolders.has(folder) : true;
        rows.push({ type: 'header', folder, count: group.length, expanded });
        if (expanded) {
            for (const e of group) {
                rows.push({ type: 'entry', entry: e, folder });
            }
        }
    }
    return rows;
}

/**
 * Collect distinct top-folder names across the entry list. Used to seed the
 * "expand all" / "collapse all" actions on first render.
 *
 * @param {Array<object>} entries
 * @returns {string[]} sorted unique folder names
 */
export function listTopFolders(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const seen = new Set();
    for (const e of entries) seen.add(topFolderOf(e));
    return [...seen].sort();
}

/**
 * Return the trackerKey-equivalent strings for entries that belong to a given
 * top-folder bucket. Used for "select all in folder" wiring.
 *
 * @param {Array<object>} entries
 * @param {string} folder
 * @param {(entry: object) => string} keyFn - usually trackerKey from state.js
 * @returns {string[]}
 */
export function entryKeysInFolder(entries, folder, keyFn) {
    if (!Array.isArray(entries) || typeof keyFn !== 'function') return [];
    const out = [];
    for (const e of entries) {
        if (topFolderOf(e) === folder) out.push(keyFn(e));
    }
    return out;
}
