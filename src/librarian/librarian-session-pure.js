/**
 * Pure helpers for librarian-session.js — split out so the BUG-043 migration
 * logic can be regression-tested without standing up SillyTavern globals.
 *
 * No imports from ST modules. Keep it that way.
 */

export const SESSION_METADATA_KEY = 'deeplore_librarian_session';
export const LEGACY_STORAGE_KEY = 'deeplore_librarian_session';

/**
 * Resolve what to do when the Librarian popup wants to load a saved session.
 *
 * Outcomes:
 *  - `{ action: 'load',    data }` — chat_metadata already had a session draft
 *  - `{ action: 'migrate', data }` — legacy localStorage draft parsed cleanly;
 *                                    caller must write it into chat_metadata and
 *                                    remove the localStorage key
 *  - `{ action: 'discard', data: null }` — legacy raw was unparseable
 *  - `{ action: 'none',    data: null }` — neither side had anything
 *
 * @param {object|null} chatMetadata  ST's chat_metadata, or null when no chat is active
 * @param {string|null} legacyRaw     localStorage[LEGACY_STORAGE_KEY] value, or null
 * @returns {{ action: 'load'|'migrate'|'discard'|'none', data: object|null }}
 */
export function planSessionLoad(chatMetadata, legacyRaw) {
    if (chatMetadata && chatMetadata[SESSION_METADATA_KEY]) {
        return { action: 'load', data: chatMetadata[SESSION_METADATA_KEY] };
    }
    if (!legacyRaw) {
        return { action: 'none', data: null };
    }
    try {
        const parsed = JSON.parse(legacyRaw);
        return { action: 'migrate', data: parsed };
    } catch {
        return { action: 'discard', data: null };
    }
}
