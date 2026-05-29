/**
 * DeepLore Enhanced — test-only ESM loader hook.
 *
 * Serves in-memory stub modules for the two ST-importing librarian modules
 * (`agentic-api.js`, `librarian-tools.js`) so that `src/librarian/agentic-loop.js`
 * can be imported in plain Node for unit testing. Those modules statically import
 * SillyTavern runtime files (`shared.js`, `openai.js`, `script.js`, `extensions.js`)
 * that do not exist outside the browser extension host, which otherwise makes
 * `agentic-loop.js` (and the real `_runFlagIteration`) un-importable.
 *
 * The stubs delegate every call to per-test fakes hung on
 * `globalThis.__DLE_TEST_HOOKS` — set by the test BEFORE it dynamically imports
 * `agentic-loop.js`. The loader hooks run on a worker thread, but the stub module
 * source they return is evaluated in the MAIN isolate, so the stub bodies see the
 * same `globalThis` the test wrote to. This is the only seam used; no production
 * code is modified beyond the test-only `_runFlagIteration` export.
 *
 * Registered from a test via:
 *   register('./_agentic-loop-stub-loader.mjs', import.meta.url, { data: { apiUrl, toolsUrl } });
 */

let API_URL = '';
let TOOLS_URL = '';

export async function initialize(data) {
    API_URL = data.apiUrl;
    TOOLS_URL = data.toolsUrl;
}

const API_STUB = `
const H = () => (globalThis.__DLE_TEST_HOOKS || {});
export const callWithTools = (...a) => H().callWithTools(...a);
export const parseToolCalls = (r) => (r && r.toolCalls) || [];
export const getTextContent = (r) => (r && r.text) || '';
export const getUsage = () => (H().getUsage ? H().getUsage() : {});
export const buildAssistantMessage = (r) => ({ role: 'assistant', _raw: r });
export const buildToolResults = (results) => ({ role: 'tool', results });
`;

const TOOLS_STUB = `
const H = () => (globalThis.__DLE_TEST_HOOKS || {});
export const searchLoreAction = (...a) => H().searchLoreAction(...a);
export const flagLoreAction = (...a) => H().flagLoreAction(...a);
`;

export async function load(url, context, next) {
    if (url === API_URL) {
        return { format: 'module', shortCircuit: true, source: API_STUB };
    }
    if (url === TOOLS_URL) {
        return { format: 'module', shortCircuit: true, source: TOOLS_STUB };
    }
    return next(url, context);
}
