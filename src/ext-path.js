/**
 * Runtime-derived install path for this extension.
 *
 * SillyTavern clones a git extension into a folder named after the repo slug —
 * verified in ST's installer: `sanitize(path.basename(parsedUrl.pathname, '.git'))`
 * (src/endpoints/extensions.js). A GitHub repo rename therefore changes the
 * install-folder name for FRESH installs, while existing installs keep their old
 * folder (their `git pull` follows GitHub's permanent rename redirect). Hardcoding
 * the folder name breaks one side of that split. We derive it from import.meta.url
 * so the code works no matter what the install folder is called.
 *
 * import.meta.url here resolves to:
 *   /scripts/extensions/<EXTENSION_REF>/src/ext-path.js
 * where EXTENSION_REF is e.g. "third-party/sillytavern-DeepLore-Enhanced".
 *
 * Scope: this fixes the FOLDER-NAME axis only (the rename concern), matching prior
 * behavior which assumed the global third-party serve path. The fetch() sites that
 * load locale JSON (src/i18n/i18n.js) and icon.svg (src/drawer/drawer.js) resolve
 * their URLs relative to their own import.meta.url, so those are install-location
 * agnostic too.
 */
/** Historical install-folder ref — used as the fallback when the URL shape is unexpected. */
export const FALLBACK_REF = 'third-party/sillytavern-DeepLore-Enhanced';

/**
 * Pure: extract the extensions-root-relative ref from a module URL pathname.
 * Exported for unit testing the rename-safety logic without a live ST.
 *
 * @param {string} pathname - the pathname of a module URL inside this extension,
 *   e.g. "/scripts/extensions/third-party/sillytavern-DeepLore/src/ext-path.js"
 * @returns {string} the ref (e.g. "third-party/sillytavern-DeepLore"), or FALLBACK_REF.
 */
export function parseExtensionRef(pathname) {
    const m = String(pathname || '').match(/\/scripts\/extensions\/(.+?)\/src\/ext-path\.js(?:[?#]|$)/);
    return m ? m[1] : FALLBACK_REF;
}

/**
 * Folder reference relative to the extensions root, e.g.
 * "third-party/sillytavern-DeepLore-Enhanced". Suitable as the first argument to
 * ST's renderExtensionTemplateAsync(). Falls back to the historical name if the
 * module URL shape is ever unexpected (keeps existing installs working).
 */
export const EXTENSION_REF = parseExtensionRef(new URL(import.meta.url).pathname);
