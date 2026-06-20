/**
 * DeepLore Core — Utility Functions
 */

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles basic key-value pairs and arrays (indented with - ).
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(content) {
    // BOM prevents the `^---` anchor from matching.
    const cleaned = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const match = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: cleaned };
    }

    const yamlText = match[1];
    const body = match[2];
    // V-H3 (2026-05-22): prototype-less object — prevents prototype pollution via
    // hostile YAML keys like `__proto__`, `constructor`, or `prototype`. Vault
    // content is user-controlled and Cartographer/import flows can pull from
    // third-party sources, so a `__proto__: pwned` line MUST NOT mutate
    // Object.prototype globally. Downstream readers (`core/pipeline.js`,
    // `src/ui/popups.js`, `src/ui/commands-admin.js`) only use `Object.keys`,
    // `Object.entries`, explicit `typeof`/`===` checks, and
    // `Object.prototype.hasOwnProperty.call` — all safe on prototype-less
    // objects. JSON.stringify also handles Object.create(null) correctly so the
    // test runner's deep-equality (`JSON.stringify(a) === JSON.stringify(b)`)
    // still works. See gotchas.md #57.
    const frontmatter = Object.create(null);
    let currentKey = null;
    let currentArray = null;
    let blockScalar = null; // { key, style: '|'|'>', lines: [] }

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trimEnd();

        // Block scalars continue while lines are indented or empty; they end when
        // indentation returns to column 0 (a real YAML key).
        if (blockScalar) {
            if (line.match(/^\s/) || trimmed === '') {
                blockScalar.lines.push(trimmed === '' ? '' : trimmed);
                continue;
            } else {
                const sep = blockScalar.style === '|' ? '\n' : ' ';
                frontmatter[blockScalar.key] = blockScalar.lines.join(sep).trim();
                blockScalar = null;
                // Fall through to process current line.
            }
        }

        // Array item: "  - value"
        if (/^\s*-\s+/.test(trimmed) && currentKey) {
            let value = trimmed.replace(/^\s*-\s+/, '').trim();
            value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
            // BUG-033: unescape backslash sequences to match inline array parser.
            value = value.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        // Key-value pair: "key: value" or "key:"
        // L-6: Unicode-aware key match. `\w` is ASCII-only and silently dropped
        // frontmatter keys beginning with a non-ASCII letter (é, 名, ключ…). The
        // `u`-flagged property classes are a strict superset of the old char class
        // for ASCII keys (\p{L}\p{N}_ ⊇ A-Za-z0-9_), so ASCII behavior is unchanged.
        const kvMatch = trimmed.match(/^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*:\s*(.*)/u);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '|' || rawValue === '>') {
                blockScalar = { key: currentKey, style: rawValue, lines: [] };
                continue;
            } else if (rawValue === '' || rawValue === '[]') {
                frontmatter[currentKey] = [];
                currentArray = frontmatter[currentKey];
            } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
                const inner = rawValue.slice(1, -1).trim();
                if (inner === '') {
                    frontmatter[currentKey] = [];
                } else {
                    // Quote-aware split: enters quote mode only when quote char is at
                    // value boundary (not mid-word like King's).
                    const items = [];
                    let current = '';
                    let inQuote = false;
                    let quoteChar = '';
                    let escaped = false;
                    for (const ch of inner) {
                        if (escaped) {
                            current += ch;
                            escaped = false;
                            continue;
                        }
                        if (ch === '\\' && inQuote) {
                            escaped = true;
                            continue;
                        }
                        if (!inQuote && (ch === '"' || ch === "'") && current.trim() === '') {
                            inQuote = true; quoteChar = ch;
                        } else if (inQuote && ch === quoteChar) { inQuote = false; }
                        else if (!inQuote && ch === ',') {
                            items.push(current.trim().replace(/^['"]|['"]$/g, ''));
                            current = '';
                            continue;
                        }
                        current += ch;
                    }
                    if (current.trim()) items.push(current.trim().replace(/^['"]|['"]$/g, ''));
                    frontmatter[currentKey] = items;
                }
                currentArray = frontmatter[currentKey];
            } else if (rawValue === 'true') {
                frontmatter[currentKey] = true;
            } else if (rawValue === 'false') {
                frontmatter[currentKey] = false;
            } else if (rawValue === 'null' || rawValue === '~') {
                frontmatter[currentKey] = null;
            } else if (/^-?(\d+\.?\d*|\.\d+)$/.test(rawValue)) {
                frontmatter[currentKey] = Number(rawValue);
            } else {
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    // Flush pending block scalar at EOF.
    if (blockScalar) {
        const sep = blockScalar.style === '|' ? '\n' : ' ';
        frontmatter[blockScalar.key] = blockScalar.lines.join(sep).trim();
    }

    return { frontmatter, body };
}

/**
 * Extract wiki-link targets from raw markdown body before cleaning.
 * Handles [[Target]] and [[Target|Display]] forms.
 * Excludes image embeds (![[...]]).
 * @param {string} body - Raw markdown body (before cleanContent)
 * @returns {string[]} Deduplicated array of link target page names
 */
export function extractWikiLinks(body) {
    if (!body || typeof body !== 'string') return []; // BUG-L1: null/non-string guard
    const links = new Set();
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    // Strip H1 so wikilinks in headings aren't treated as entry links.
    const bodyWithoutH1 = body.replace(/^#\s+.+$/m, '');
    let match;
    while ((match = regex.exec(bodyWithoutH1)) !== null) {
        // Skip image embeds (`!`-prefixed).
        if (match.index > 0 && bodyWithoutH1[match.index - 1] === '!') continue;
        links.add(match[1].trim().replace(/\\$/, ''));
    }
    return [...links];
}

/**
 * Clean markdown content for prompt injection.
 * @param {string} content - Raw markdown body (frontmatter already stripped)
 * @returns {string} Cleaned content
 */
export function cleanContent(content) {
    let cleaned = content;

    // User-controlled exclusion regions.
    cleaned = cleaned.replace(/%%deeplore-exclude%%[\s\S]*?%%\/deeplore-exclude%%/g, '');

    // Obsidian %%...%% comment/plugin blocks (timeline, dataview, etc.). Two passes:
    // inline on single line, then multi-line blocks (require %% at line boundaries).
    cleaned = cleaned.replace(/%%[^%\n]+%%/g, '');
    cleaned = cleaned.replace(/^%%[\s\S]*?^%%$/gm, '');

    cleaned = cleaned.replace(/<\/?div[^>]*>/g, '');

    // Strip H1 — already used as entry title in the XML wrapper.
    cleaned = cleaned.replace(/^#\s+.+$/m, '');

    // Image embeds: ![[image.png]] or ![alt](url)
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');

    // Wiki links: [[Link|Display]] → Display, [[Link]] → Link
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');

    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Extract title from markdown content.
 * @param {string} body - Markdown body
 * @param {string} filename - Fallback filename
 * @returns {string}
 */
export function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        // Strip wikilink syntax: [[Target|Display]] → Display, [[Target]] → Target
        return h1Match[1].trim().replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
    }
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

/**
 * Truncate text at the nearest sentence boundary before maxLen.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
// BUG-054: ASCII-only (`.!?`) was producing mid-sentence cuts on CJK/emoji and
// dangling brackets on markdown. Mirrors ST's trimToEndSentence (full Unicode
// punctuation + emoji enders) but stays maxLen-aware via pre-slicing so core/
// remains free of ST imports.
const _SENTENCE_PUNCT = new Set([
    '.', '!', '?', '*', '"', ')', '}', '`', ']', '$',
    '。', '！', '？', '”', '）', '】', '’', '」', '_',
]);
const _EMOJI_RE = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;

// Returns string trimmed to last sentence-ender, or null if no boundary found
// (caller falls back to ellipsis).
function _trimToSentenceEnd(input) {
    if (!input) return null;
    let last = -1;
    const characters = Array.from(input);
    for (let i = characters.length - 1; i >= 0; i--) {
        const char = characters[i];
        const emoji = _EMOJI_RE.test(char);
        _EMOJI_RE.lastIndex = 0; // reset sticky state from /g
        if (_SENTENCE_PUNCT.has(char) || emoji) {
            if (!emoji && i > 0 && /[\s\n]/.test(characters[i - 1])) {
                last = i - 1;
            } else {
                last = i;
            }
            break;
        }
    }
    if (last === -1) return null;
    return characters.slice(0, last + 1).join('').trimEnd();
}

export function truncateToSentence(text, maxLen) {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    const trimmed = _trimToSentenceEnd(truncated);
    // Accept boundary cut only if it kept enough of the budget; else hard cut + ellipsis.
    if (trimmed && trimmed.length > maxLen * 0.4) return trimmed;
    return truncated.trimEnd() + '...';
}

/**
 * Compute a simple hash for cache comparison.
 * @param {string} text
 * @returns {string}
 */
export function simpleHash(text) {
    if (!text) return '0_0';
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = ((h1 << 5) + h1 + c) | 0;
        h2 = ((h2 << 5) + h2 + c) | 0;
    }
    return `${text.length}_${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

/**
 * Escape a string for use in a regex.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape XML/HTML special characters: &, <, >, ".
 * Safe for attribute values and element content.
 * @param {string} str
 * @returns {string}
 */
export function escapeXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * BUG-145: centralized "is this message scannable?" predicate. Mirrors openai.js's
 * exclusion set so DLE's scan/context builders don't drift from each other or from
 * ST's prompt builder. Excludes: tool invocations, system messages, narrator/thoughts.
 */
function _isScannableMessage(m) {
    if (m == null) return false;
    if (m.is_system) return false;
    if (m.is_thoughts) return false;
    const ex = m.extra;
    if (ex) {
        if (ex.tool_invocations) return false;
        if (ex.type === 'narrator') return false;
        if (ex.isSmallSys) return false;
    }
    return true;
}

/**
 * Build scan text from chat messages.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
export function buildScanText(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .filter(_isScannableMessage)
        .map(m => `${m.name || ''}: ${typeof m.mes === 'string' ? m.mes : ''}`)
        .join('\n');
}

/**
 * Build annotated chat context for AI search.
 * Marks speakers as (user) or (character) to clarify conversation roles.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
export function buildAiChatContext(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .filter(_isScannableMessage)
        .map(m => {
            const speaker = m.name || 'Unknown';
            const role = m.is_user ? '(user)' : '(character)';
            return `${speaker} ${role}: ${typeof m.mes === 'string' ? m.mes : ''}`;
        })
        .join('\n');
}

/**
 * Clamp a numeric setting to [min, max] and log if clamped.
 * @param {object} obj - Settings object
 * @param {string} key - Setting key
 * @param {number} min
 * @param {number} max
 * @param {string} label - Human-readable label for logging
 */
function clampWithLog(obj, key, min, max, label) {
    const before = obj[key];
    // L-10: NaN passes the `typeof === 'number'` caller guard, and Math.max/min(NaN)
    // returns NaN — so without this short-circuit a NaN setting clamps to NaN and
    // propagates into budgets/depths. Fall back to the safe lower bound (min).
    if (Number.isNaN(obj[key])) {
        obj[key] = min;
        console.info(`[DLE] ${label} was NaN; reset to ${min} (range: ${min}-${max})`);
        return;
    }
    // Round only when the constraint range is integer-based — float constraints
    // (e.g. fuzzySearchMinScore: 0.1–2.0) must preserve decimals.
    const isIntegerRange = Number.isInteger(min) && Number.isInteger(max);
    obj[key] = Math.max(min, Math.min(max, isIntegerRange ? Math.round(obj[key]) : obj[key]));
    if (before !== obj[key]) {
        console.info(`[DLE] ${label} clamped from ${before} to ${obj[key]} (range: ${min}-${max})`);
    }
}

/**
 * Validate and clamp settings to their allowed ranges.
 * @param {object} settings - Settings object to validate in-place
 * @param {object} constraints - Map of setting key to { min, max, label }
 */
/**
 * Escape a string for safe use as a YAML value.
 * Wraps in double quotes if the string contains special YAML characters,
 * leading/trailing whitespace, or control characters (newline, return, tab).
 * @param {string} str
 * @returns {string}
 */
export function yamlEscape(str) {
    if (/[:#\[\]{}&*!|>'"%@`\n\r\t]/.test(str) || str.trim() !== str) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    }
    return str;
}

/**
 * User-friendly message shown when no vault entries are loaded.
 */
export const NO_ENTRIES_MSG = 'No entries found. Check your Obsidian vault connection, or run /dle-health to troubleshoot.';

/**
 * Classify an error into a user-friendly message based on common patterns.
 * @param {Error|string} err - The error to classify
 * @returns {string} A user-friendly error description
 */
export function classifyError(err) {
    // BUG-246: discriminate user-abort from timeout using flags set by callViaProfile/
    // callViaProxy (err.userAborted vs err.timedOut). Bare AbortError is more likely
    // a user cancel than a timeout (timeouts are explicitly flagged by our own code).
    if (typeof err === 'object' && err !== null) {
        if (err.userAborted) return 'Cancelled.';
        if (err.timedOut) return 'The request timed out. Try increasing the timeout in settings.';
        if (err.throttled) return 'Slow down — too many AI calls in quick succession.';
    }
    const raw = typeof err === 'string' ? err : String(err.message || err);
    if (err && err.name === 'AbortError') {
        return 'Cancelled.';
    }
    if (/timeout|timed out/i.test(raw)) {
        return 'The request timed out. Try increasing the timeout in settings.';
    }
    if (/\b401\b|\b403\b|\bauth\b|unauthorized|forbidden/i.test(raw)) {
        return 'Authentication failed. Check your API key or connection profile.';
    }
    if (/\b402\b|insufficient.?quota|billing|payment.?required|credit/i.test(raw)) {
        return 'API quota exhausted or billing issue. Check your AI provider account for available credits.';
    }
    if (/CORS|Access-Control|Mixed Content/i.test(raw)) {
        // L-9: Custom Proxy mode (and its enableCorsProxy requirement) was removed in
        // v2.5 — AI calls now route server-side through Connection Profiles. Point users
        // at that path instead of the dead config flag.
        return 'Blocked by browser security (CORS). Pick a Connection Profile in DLE Settings → Connection → AI Connections.';
    }
    if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch failed/i.test(raw)) {
        return 'Could not connect. Check that the service is running.';
    }
    if (/\b404\b|Not Found/i.test(raw)) {
        return 'Endpoint not found (404). Check that the URL is correct.';
    }
    if (/model.*not.?found|model.*not.?exist|model.*not.?available|invalid.?model/i.test(raw)) {
        return 'Model not found. Check the model name in your AI search settings or connection profile.';
    }
    if (/\b429\b|Too Many Requests|rate.?limit/i.test(raw)) {
        return 'Rate limited (429). Wait a moment before retrying.';
    }
    if (/JSON|SyntaxError|Unexpected token/i.test(raw)) {
        return 'Received an invalid response (not JSON). The server may be down or returning an error page.';
    }
    if (/\b529\b|overloaded/i.test(raw)) {
        return 'The AI provider is overloaded. Wait a minute or try a different model.';
    }
    if (/\b5\d{2}\b|Internal Server Error|Bad Gateway|Service Unavailable/i.test(raw)) {
        return 'The server returned an error. Try again in a moment.';
    }
    // Scrub before truncation so secrets after char 120 are still removed.
    let safe = raw.replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***');
    safe = safe.replace(/[?&](key|apiKey|api_key|token|secret)=[^&\s]{8,}/gi, '$1=***');
    if (safe.length > 120) safe = safe.slice(0, 120) + '...';
    return safe;
}

export function validateSettings(settings, constraints, defaults) {
    for (const [key, constraint] of Object.entries(constraints)) {
        const { min, max, label, enum: enumValues } = constraint;
        if (Array.isArray(enumValues)) {
            // BUG-344: reset typo'd enum values to default.
            if (settings[key] !== undefined && !enumValues.includes(settings[key])) {
                const fallback = defaults ? defaults[key] : enumValues[0];
                console.info(`[DLE] ${label || key} invalid enum value ${JSON.stringify(settings[key])} reset to ${JSON.stringify(fallback)} (allowed: ${enumValues.join(', ')})`);
                settings[key] = fallback;
            }
            continue;
        }
        if (typeof settings[key] === 'number') {
            clampWithLog(settings, key, min, max, label || key);
        }
    }
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}
