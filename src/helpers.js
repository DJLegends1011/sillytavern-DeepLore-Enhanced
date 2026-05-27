/**
 * DeepLore Enhanced — Pure helpers (no ST imports). Browser + Node testable.
 */
import { yamlEscape } from '../core/utils.js';
import { compressCaveman, resolveCompressMode, APPLIED_COMPRESS_MODES } from './caveman.js';

export const MAX_PRIORITY_VALUE = 999;

/**
 * Update Existing Entries — surgical frontmatter-field update.
 *
 * Changes specific scalar fields in a markdown file's YAML frontmatter
 * without disturbing other fields, comments, array fields, or the body.
 * Preserves the original quoting / spacing of fields not touched, which
 * means round-trip-safe even for entries that use unusual YAML styles.
 *
 * Scope (v1):
 *   - Scalar values only (strings, numbers, booleans). Array / nested-object
 *     fields are not supported; pass them through `convertWiEntry` or rewrite
 *     the whole file instead.
 *   - To DELETE a field, pass `null` as the value.
 *   - New fields (not present in the original frontmatter) are appended
 *     immediately before the closing `---`.
 *   - When the file has no frontmatter at all, an empty block is created.
 *
 * @param {string} content - full markdown (frontmatter + body)
 * @param {Record<string, string|number|boolean|null>} updates - field → new value (null = delete)
 * @returns {{ content: string, applied: string[], skipped: string[] }}
 *   `applied` = field names whose value was changed.
 *   `skipped` = field names refused (non-scalar value, or new field with null value).
 */
export function updateFrontmatterFields(content, updates) {
    const applied = [];
    const skipped = [];
    if (!updates || typeof updates !== 'object') {
        return { content, applied, skipped };
    }

    // Validate value types up-front so we don't half-apply.
    const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    for (const [k, v] of Object.entries(updates)) {
        if (!isScalar(v)) skipped.push(k);
    }
    const validUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => !skipped.includes(k)),
    );

    // Strip BOM the same way parseFrontmatter does.
    const cleaned = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const fmMatch = cleaned.match(/^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*\r?\n?)([\s\S]*)$/);

    let openDelim, fmBody, closeDelim, body;
    if (fmMatch) {
        openDelim = fmMatch[1];
        fmBody = fmMatch[2];
        closeDelim = fmMatch[3];
        body = fmMatch[4];
    } else {
        // No frontmatter — create a minimal block. New fields will append below.
        openDelim = '---\n';
        fmBody = '';
        closeDelim = '\n---\n';
        body = cleaned;
    }

    // Strip trailing \r BEFORE matching so CRLF-authored files don't
    // silently fall through the in-place loop's key regex (which would
    // otherwise duplicate every key on every write — Windows-authored
    // entries grow on each update). Reassemble with the file's detected
    // line ending so the write round-trips cleanly.
    const usesCRLF = /\r\n/.test(fmBody);
    const fmLines = fmBody.split(/\r?\n/);

    const serializeValue = (v) => {
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'number') {
            // NaN / ±Infinity are not valid YAML scalars and would silently corrupt
            // the file if emitted as empty strings. Caller's value is rejected via
            // `skipped` instead — see in-place loop's serialize-and-validate path.
            if (!Number.isFinite(v)) return null;
            return String(v);
        }
        return yamlEscape(String(v));
    };

    // Detect block-scalar headers ("|", ">", with optional chomp/indent indicators).
    // Overwriting the header would orphan the indented body lines as dangling YAML,
    // silently corrupting the file when read by a strict parser.
    const BLOCK_SCALAR_VALUE = /^[|>][-+]?\d*\s*$/;

    // First pass: in-place replacement for existing scalar keys.
    // Key regex allows hyphens and dots (refine-keys, x.y) — same chars that
    // `parseFrontmatter` already accepts on the read side. Anything narrower
    // would silently duplicate hyphenated/dotted keys on each update.
    const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.\-]*)\s*:\s*(.*)$/;
    const remainingNew = new Map(Object.entries(validUpdates));
    for (let i = 0; i < fmLines.length; i++) {
        const line = fmLines[i];
        const m = line.match(KEY_RE);
        if (!m) continue;
        const key = m[1];
        const rawValue = m[2];
        if (!remainingNew.has(key)) continue;
        // Skip if this key heads a block scalar (|, >) — overwriting the header
        // would leave the body lines as untyped dangling YAML.
        if (BLOCK_SCALAR_VALUE.test(rawValue)) { skipped.push(key); remainingNew.delete(key); continue; }
        // Skip if this key heads an array block — either flow style (`[a, b]`
        // detected via rawValue) or block style (next non-blank line is `  - …`).
        let isArray = /^\[.*\]\s*$/.test(rawValue);
        if (!isArray) {
            for (let j = i + 1; j < fmLines.length; j++) {
                const peek = fmLines[j];
                if (peek.trim() === '') continue;
                if (/^\s+-\s+/.test(peek)) isArray = true;
                break;
            }
        }
        if (isArray) { skipped.push(key); remainingNew.delete(key); continue; }

        const newValue = remainingNew.get(key);
        const serialized = serializeValue(newValue);
        if (serialized === null && newValue !== null) {
            // serializeValue rejected the value (NaN/Infinity). Skip rather than
            // emit a malformed line.
            skipped.push(key);
            remainingNew.delete(key);
            continue;
        }
        remainingNew.delete(key);
        if (newValue === null) {
            fmLines.splice(i, 1);
            i--;
        } else {
            fmLines[i] = `${key}: ${serialized}`;
        }
        applied.push(key);
    }

    // Second pass: append new fields (non-null only — can't "delete a key that
    // wasn't there"). Insert before the trailing blank line if one exists so
    // the block stays visually tidy.
    for (const [key, value] of remainingNew) {
        if (value === null) { skipped.push(key); continue; }
        const serialized = serializeValue(value);
        if (serialized === null) { skipped.push(key); continue; } // NaN/Infinity refused
        // Drop a single trailing blank line, append field, restore blank
        // line — this keeps the block visually flush against `---`.
        while (fmLines.length && fmLines[fmLines.length - 1].trim() === '') fmLines.pop();
        fmLines.push(`${key}: ${serialized}`);
        applied.push(key);
    }

    const newFmBody = fmLines.join(usesCRLF ? '\r\n' : '\n');
    return { content: openDelim + newFmBody + closeDelim + body, applied, skipped };
}

/**
 * #16 — Reverse-priority comparator. By default lower priority number = higher
 * importance (Obsidian/WI convention). When `reversed` is true, flip so higher
 * number wins. Applies to pipeline budget allocation, Librarian view order,
 * and Cartographer display. Browse popup's explicit `priority_asc/desc`
 * dropdown bypasses this — user-typed sort always wins literal.
 *
 * Default priority value 50 matches what callers already coalesced inline.
 *
 * @param {{priority?: number}} a
 * @param {{priority?: number}} b
 * @param {boolean} reversed
 * @returns {number}
 */
export function comparePriority(a, b, reversed) {
    const diff = (a.priority || 50) - (b.priority || 50);
    return reversed ? -diff : diff;
}

/**
 * Sanitize a title for use as an Obsidian vault filename.
 * Strips OS-reserved chars, leading/trailing dots, and Windows reserved names.
 * @param {string} title
 * @returns {string} Safe filename
 */
export function sanitizeFilename(title) {
    let safe = title.replace(/[<>:"/\\|?*]/g, '_');
    safe = safe.replace(/^\.+|\.+$/g, '');
    safe = safe.trimEnd();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = '_' + safe;
    return safe || 'Untitled';
}

/**
 * Strip Obsidian-interpretable syntax from AI-generated content before writing
 * to the vault. Prevents Templater / Dataview / CustomJS / button blocks and
 * obsidian:// links from executing when the note is opened.
 * @param {string} text
 * @returns {string}
 */
export function stripObsidianSyntax(text) {
    if (!text || typeof text !== 'string') return text || '';
    let result = text;
    result = result.replace(/\{\{[\s\S]*?\}\}/g, ''); // Templater {{...}}
    result = result.replace(/<%[\s\S]*?%>/g, '');     // Templater <%...%>
    result = result.replace(/%%[\s\S]*?%%/g, '');     // Obsidian comments
    result = result.replace(/`=\s[^`]*`/g, '');       // Dataview inline queries
    result = result.replace(/```(?:dataview|dataviewjs)\s*\n[\s\S]*?```/gi, '');
    // obsidian:// links can trigger vault actions.
    result = result.replace(/\[([^\]]*)\]\(obsidian:\/\/[^)]*\)/g, '$1');
    result = result.replace(/```button\s*\n[\s\S]*?```/gi, '');
    result = result.replace(/```customjs\s*\n[\s\S]*?```/gi, '');
    return result;
}

/**
 * Normalize a CMRS sendRequest result into the AI-call shape DLE consumers expect.
 * ST's custom-request.js replaces `result.content` with `JSON.parse(...)` when
 * `data.json_schema` is present (chat-completions + extractData), so callers that
 * pass a schema get back an Object/Array instead of the raw string. Without this
 * normalization, downstream string ops (extractAiResponseClient, debug-preview
 * `.slice`) blow up. Issue #24.
 * @param {{content?: any, usage?: object}|null|undefined} result
 * @returns {{text: string, usage: {input_tokens: number, output_tokens: number}}}
 */
export function cmrsResultToText(result) {
    const rawContent = result?.content;
    const text = typeof rawContent === 'string'
        ? rawContent
        : (rawContent == null ? '' : JSON.stringify(rawContent));
    // PR #28.3 clean-fix half: Gemini reports token usage as
    // `usageMetadata.{promptTokenCount, candidatesTokenCount}` instead of OAI-style
    // `usage.{prompt_tokens, completion_tokens}`. Without these aliases, all Gemini
    // calls show 0/0 in DLE stats. Credit Ryah (PR #28). See PR-28.3-VERDICT.md.
    //
    // L1 fix (v2.5): defensive cascade for nested usage shapes. CMRS occasionally
    // un-flattens (or future custom-proxy paths may surface) Gemini envelopes
    // where the usage block sits one level deeper, or where the SDK surfaces a
    // candidates[] array carrying its own usageMetadata. Cascade order (return
    // first non-null match), most-flat-to-most-nested:
    //   1. result.usage                       — OAI standard, already-normalized
    //   2. result.usageMetadata               — Gemini flat (current CMRS shape)
    //   3. result.response.usage              — wrapped OAI (SDK passthrough)
    //   4. result.response.usageMetadata      — wrapped Gemini
    //   5. result.candidates[0].usageMetadata — Gemini per-candidate fallback
    const usage = result?.usage
        || result?.usageMetadata
        || result?.response?.usage
        || result?.response?.usageMetadata
        || result?.candidates?.[0]?.usageMetadata
        || {};
    return {
        text,
        usage: {
            input_tokens: usage.input_tokens || usage.prompt_tokens || usage.promptTokenCount || 0,
            output_tokens: usage.output_tokens || usage.completion_tokens || usage.candidatesTokenCount || 0,
        },
    };
}

/**
 * Extract a JSON array from AI response text. Handles direct JSON, code-fenced
 * JSON, dangling closing fences (Gemini quirk), and raw arrays via
 * bracket-balancing. Also accepts a pre-parsed array input to short-circuit
 * the string path.
 *
 * PR #28.3 partial port (credit Ryah, PR #28):
 *   - Dangling-fence strip: defense-in-depth for the direct-parse path. NOTE:
 *     this does NOT close the json_schema Gemini breaker-trip bug — by the time
 *     text reaches DLE in that flow, ST has already replaced the content with
 *     `'{}'` (tryParse failed on the fence upstream). That bug needs an upstream
 *     ST fix or a larger DLE workaround. See audit/v2.5-prep/PR-28.3-VERDICT.md.
 *   - Pre-parsed array input acceptance: forward-compatible with callers that
 *     skip the stringify step.
 *
 * @param {string|Array} text
 * @returns {Array|null}
 */
export function extractAiResponseClient(text) {
    if (text == null) return null;

    /** BUG-046: usable result arrays have at least one usable element (or are empty). */
    function isValidResultArray(val) {
        if (!Array.isArray(val)) return false;
        if (val.length === 0) return true; // valid: AI says nothing relevant
        return val.some(item =>
            typeof item === 'string'
            || (typeof item === 'object' && item !== null && (item.title || item.name)),
        );
    }

    // PR #28.3: short-circuit when caller already has the parsed object. The
    // ai.js BUG-383 unwrap handles non-array objects with known wrapper keys, so
    // we just return what we got and let the caller figure out the shape.
    if (typeof text === 'object') {
        if (isValidResultArray(text)) return text;
        return null;
    }
    if (typeof text !== 'string') return null;

    // PR #28.3: Gemini sometimes appends a stray ``` after the JSON payload
    // (no matching opener). Plain JSON.parse fails on the extra chars; without
    // this strip, json_schema-flow responses come back as '{}' and aiSearch
    // trips the breaker. The fenced-content regex below catches matched pairs;
    // this handles the dangling-closer case.
    const stripDanglingFence = (s) => s.replace(/^\s*`{3,}\s*$/gm, '').trim();
    const cleaned = stripDanglingFence(text);

    try {
        const parsed = JSON.parse(cleaned);
        if (isValidResultArray(parsed)) return parsed;
    } catch { /* noop */ }
    const fenceMatch = cleaned.match(/`{3,}(?:json)?\s*([\s\S]*?)`{3,}/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1]);
            if (isValidResultArray(parsed)) return parsed;
        } catch { /* noop */ }
    }
    // Bracket-balanced extraction — non-greedy regex fails on nested arrays
    // like ["a", ["b"]]. Prefer largest (outer) match. Walk `cleaned` so any
    // stripped dangling fence is consistent across all parse paths.
    const candidates = [];
    for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '[') {
            let depth = 1, inStr = false, inSingleStr = false, escape = false;
            for (let j = i + 1; j < cleaned.length && depth > 0; j++) {
                const c = cleaned[j];
                if (escape) { escape = false; continue; }
                if (c === '\\') { escape = true; continue; }
                if (c === '"' && !inSingleStr) { inStr = !inStr; continue; }
                if (c === "'" && !inStr) { inSingleStr = !inSingleStr; continue; }
                if (inStr || inSingleStr) continue;
                if (c === '[') depth++;
                else if (c === ']') depth--;
                if (depth === 0) {
                    candidates.push(cleaned.substring(i, j + 1));
                    break;
                }
            }
        }
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (isValidResultArray(parsed)) return parsed;
        } catch { /* noop */ }
    }
    return null;
}

/**
 * Normalize AI search results — accepts strings, objects with title/name, mixed.
 * @param {Array} arr
 * @returns {Array<{title: string, confidence: string, reason: string}>}
 */
export function normalizeResults(arr) {
    // BUG-391: reject non-string/non-object items rather than String()-coercing.
    // Numbers, booleans, untitled objects must not become "42" or "[object Object]".
    return arr.map(item => {
        if (typeof item === 'string') {
            return { title: item, confidence: 'medium', reason: 'AI search' };
        }
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            const rawTitle = item.title || item.name;
            if (typeof rawTitle !== 'string' || !rawTitle.trim()) return null;
            return {
                title: rawTitle,
                confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
                reason: typeof item.reason === 'string' ? item.reason : 'AI search',
            };
        }
        return null;
    }).filter(r => r && r.title && r.title.trim() && r.title !== 'null' && r.title !== 'undefined');
}

// BUG-384: WI imports tag every entry with these — must skip them when picking
// a clustering tag, or hierarchical pre-filter collapses to one cluster.
export const LOREBOOK_INFRA_TAGS = new Set([
    'lorebook',
    'lorebook-always',
    'lorebook-seed',
    'lorebook-bootstrap',
    'lorebook-guide',
    'lorebook-never',
    'lorebook-constant',
]);

/**
 * Cluster entries by type/tag for hierarchical manifest (large vaults).
 * Falls back: first non-infra tag → top folder → 'Uncategorized'.
 * @param {import('../core/pipeline.js').VaultEntry[]} entries - non-constant
 * @returns {Map<string, import('../core/pipeline.js').VaultEntry[]>}
 */
export function clusterEntries(entries) {
    const clusters = new Map();
    for (const entry of entries) {
        let category = 'Uncategorized';
        if (entry.tags && entry.tags.length > 0) {
            const firstReal = entry.tags.find(t => !LOREBOOK_INFRA_TAGS.has(String(t).toLowerCase()));
            if (firstReal) {
                category = firstReal;
            } else if (entry.filename && entry.filename.includes('/')) {
                category = entry.filename.split('/')[0] || 'Uncategorized';
            }
        }
        if (!clusters.has(category)) clusters.set(category, []);
        clusters.get(category).push(entry);
    }
    return clusters;
}

/**
 * Compact category manifest for stage 1 of hierarchical search.
 * @param {Map<string, import('../core/pipeline.js').VaultEntry[]>} clusters
 * @returns {string}
 */
export function buildCategoryManifest(clusters) {
    const lines = [];
    for (const [category, entries] of clusters) {
        // BUG-AUDIT v2.5: when two entries in the same sample slice share a title,
        // suffix the second occurrence with @vaultSource so the AI sees them as
        // distinct. Bare title appears for the first/only occurrence (backward
        // compatible — single-vault setups never trigger the suffix).
        const seen = new Map();
        const samples = entries.slice(0, 5).map(e => {
            const lower = e.title.toLowerCase();
            const count = (seen.get(lower) || 0) + 1;
            seen.set(lower, count);
            return count > 1 && e.vaultSource ? `${e.title}@${e.vaultSource}` : e.title;
        }).join(', ');
        const more = entries.length > 5 ? ` (+${entries.length - 5} more)` : '';
        lines.push(`[${category}] (${entries.length} entries): ${samples}${more}`);
    }
    return lines.join('\n');
}

/**
 * Build an obsidian:// URI to open a file in a specific vault.
 * @param {string} vaultName
 * @param {string} filename - vault-relative
 * @returns {string|null} URI or null if no vault name
 */
export function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    // Obsidian's URI handler expects paths without `.md`.
    const stripped = filename.replace(/\.md$/i, '');
    const encodedFile = stripped.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

/**
 * Convert a SillyTavern World Info entry into an Obsidian note with frontmatter.
 * @param {object} wiEntry
 * @param {string} lorebookTag
 * @param {object} [options]
 * @param {boolean|string} [options.compress] - #18: when truthy (or 'caveman'),
 *   pass the body through `compressCaveman()` before writing and annotate the
 *   frontmatter with `compress: caveman`. Forward-compat values pass through
 *   unmodified (annotation only) so future modes like `ai-summary` can be
 *   wired up without churning callers.
 * @param {object} [options.report] - Wave 1+: optional accumulator. When provided,
 *   the converter mutates `report.nativeApplied[field]++`, `report.roundTripped[field]++`,
 *   and `report.skipped[reason]++` in place so `importEntries` can build a structured
 *   per-import summary without re-parsing what it just emitted.
 * @returns {{filename: string, content: string}}
 */
export function convertWiEntry(wiEntry, lorebookTag, options = {}) {
    const compressMode = resolveCompressMode(options.compress);
    const report = options.report || null;
    const bump = (bucket, field) => {
        if (!report) return;
        if (!report[bucket]) report[bucket] = {};
        report[bucket][field] = (report[bucket][field] || 0) + 1;
    };
    // Title from `comment` (ST convention) or joined keys. Strip newlines to
    // prevent H1 injection.
    // BUG-008: older ST exports use a comma-separated string for `key`.
    const keyArray = Array.isArray(wiEntry.key) ? wiEntry.key
        : (typeof wiEntry.key === 'string' ? wiEntry.key.split(',').map(k => k.trim()).filter(Boolean) : []);
    const title = ((wiEntry.comment || '').trim()
        || keyArray.join(', ').substring(0, 50)
        || `Entry_${wiEntry.uid || Date.now()}`).replace(/[\r\n]+/g, ' ');

    let safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    if (!safeTitle) safeTitle = 'Untitled';

    const keys = [];
    if (Array.isArray(wiEntry.key)) {
        keys.push(...wiEntry.key.filter(k => k && k.trim()));
    } else if (typeof wiEntry.key === 'string' && wiEntry.key.trim()) {
        keys.push(...wiEntry.key.split(',').map(k => k.trim()).filter(Boolean));
    }

    // ST has 5 positions, DLE has 3 — lossy. ST: 0=after_char, 1=before_char,
    // 2=before_AN, 3=after_AN, 4=in_chat.
    const positionMap = { 0: 'after', 1: 'before', 2: 'before', 3: 'after', 4: 'in_chat' };
    const position = positionMap[wiEntry.position] || null;

    const fm = [];
    fm.push('---');
    fm.push(`type: lore`);
    fm.push(`status: active`);
    if (wiEntry.position !== undefined) fm.push(`# original_st_position: ${wiEntry.position}`);
    fm.push(`priority: ${Math.max(0, Math.min(MAX_PRIORITY_VALUE, Math.round(Number(wiEntry.order) || 50)))}`);
    fm.push(`tags:`);
    fm.push(`  - ${lorebookTag}`);
    if (wiEntry.constant) fm.push(`  - lorebook-always`);
    if (keys.length > 0) {
        fm.push(`keys:`);
        for (const k of keys) {
            fm.push(`  - ${yamlEscape(k)}`);
        }
    }
    if (wiEntry.keysecondary && wiEntry.keysecondary.length > 0) {
        const secondary = Array.isArray(wiEntry.keysecondary)
            ? wiEntry.keysecondary.filter(k => k && k.trim())
            : wiEntry.keysecondary.split(',').map(k => k.trim()).filter(Boolean);
        if (secondary.length > 0) {
            fm.push(`refine_keys:`);
            for (const k of secondary) {
                fm.push(`  - ${yamlEscape(k)}`);
            }
        }
    }
    if (position) fm.push(`position: ${position}`);
    if (wiEntry.depth != null && wiEntry.depth > 0) fm.push(`depth: ${wiEntry.depth}`);
    if (wiEntry.probability != null && wiEntry.probability < 100) {
        fm.push(`probability: ${(wiEntry.probability / 100).toFixed(2)}`);
    }
    if (wiEntry.scanDepth) fm.push(`scanDepth: ${wiEntry.scanDepth}`);

    // Wave 1 (WI parity) — Tier A: ST fields DLE supports natively but the
    // importer used to drop on the floor. Most important: `disable: true`
    // entries were getting imported as active, silently flipping authorial
    // intent. excludeRecursion + role are honored by the pipeline already
    // (core/pipeline.js:245 / line 285) but had no import-side emission.
    if (wiEntry.disable) {
        fm.push('enabled: false');
        bump('nativeApplied', 'enabled');
    }
    if (wiEntry.excludeRecursion || wiEntry.exclude_recursion) {
        fm.push('excludeRecursion: true');
        bump('nativeApplied', 'excludeRecursion');
    }
    if (wiEntry.role != null) {
        const roleNames = ['system', 'user', 'assistant'];
        const idx = typeof wiEntry.role === 'number' ? wiEntry.role : null;
        const roleName = idx != null && idx >= 0 && idx < roleNames.length ? roleNames[idx] : null;
        if (roleName) {
            fm.push(`role: ${roleName}`);
            bump('nativeApplied', 'role');
        } else {
            // Unknown role index — don't lie. Skip emission, record for the report.
            bump('skipped', 'invalid_role');
        }
    }

    // C.3: round-trip-only — parseVaultFile emits W_NOT_IMPLEMENTED for these so
    // /dle-lint surfaces them. (BUG-047 sticky, BUG-048 delay, BUG-052 group*)
    if (wiEntry.sticky != null && wiEntry.sticky !== 0) fm.push(`sticky: ${Number(wiEntry.sticky)}`);
    if (wiEntry.delay != null && wiEntry.delay !== 0) fm.push(`delay: ${Number(wiEntry.delay)}`);
    if (wiEntry.group && typeof wiEntry.group === 'string' && wiEntry.group.trim()) {
        fm.push(`group: ${yamlEscape(wiEntry.group.trim())}`);
    }
    if (wiEntry.groupWeight != null && Number(wiEntry.groupWeight) !== 100) {
        fm.push(`group_weight: ${Number(wiEntry.groupWeight)}`);
    }
    fm.push(`summary: "Imported from SillyTavern World Info"`);
    // Only annotate the compress flag for modes this build can actually apply.
    // Annotating an unknown mode (e.g. 'ai-summary') would let the frontmatter
    // claim the body is compressed when in fact it's still raw, which would
    // double-compress on a future re-import or confuse readers.
    const willApplyCompression = compressMode && APPLIED_COMPRESS_MODES.has(compressMode);
    if (willApplyCompression) fm.push(`compress: ${compressMode}`);
    fm.push('---');

    // Sanitize against YAML / control sequence injection.
    let content = wiEntry.content || '';
    content = content.replace(/^---$/gm, '- - -');
    content = content.replace(/%%deeplore-exclude%%[\s\S]*?%%\/deeplore-exclude%%/g, '');
    content = stripObsidianSyntax(content);
    // #18: compression runs at import time only. Stored form is compressed;
    // read-path treats it as the authoritative body.
    if (willApplyCompression && compressMode === 'caveman') {
        content = compressCaveman(content);
    } else if (compressMode && !willApplyCompression) {
        // User asked for a mode we don't know how to apply. Warn instead of
        // silently storing an annotation that lies about transform state.
        console.warn(`[DLE] convertWiEntry: unknown compress mode "${compressMode}" — body stored uncompressed, no annotation written.`);
    }
    const fullContent = `${fm.join('\n')}\n\n# ${title}\n\n${content}`;

    return { filename: `${safeTitle}.md`, content: fullContent };
}

/**
 * Portable health check — same logic as runHealthCheck() in diagnostics.js
 * but takes explicit params instead of reading globals, so Node tests can run it.
 * Subset of the production checks (8 per-entry + 2 aggregate, vs 30+).
 *
 * @param {Array} vaultIndex
 * @param {object} [settings]
 * @returns {Array<{type: string, entry: string, [target]: string, [ref]: string, [tokens]: number}>}
 */
export function checkHealthPure(vaultIndex, settings = {}) {
    const issues = [];
    const allTitles = new Set(vaultIndex.map(e => e.title));
    const titleCounts = new Map();

    for (const entry of vaultIndex) {
        titleCounts.set(entry.title, (titleCounts.get(entry.title) || 0) + 1);

        for (const req of entry.requires) {
            const target = vaultIndex.find(e => e.title.toLowerCase() === req.toLowerCase());
            if (target && target.requires.some(r => r.toLowerCase() === entry.title.toLowerCase())) {
                if (entry.title < target.title) {
                    issues.push({ type: 'circular_requires', entry: entry.title, target: target.title });
                }
            }
        }

        for (const req of entry.requires) {
            if (entry.excludes.some(exc => exc.toLowerCase() === req.toLowerCase())) {
                issues.push({ type: 'requires_excludes_conflict', entry: entry.title, ref: req });
            }
        }

        if (entry.cascadeLinks) {
            for (const cl of entry.cascadeLinks) {
                if (!allTitles.has(cl)) {
                    issues.push({ type: 'orphaned_cascade', entry: entry.title, ref: cl });
                }
            }
        }

        if (entry.constant && entry.cooldown !== null) {
            issues.push({ type: 'cooldown_on_constant', entry: entry.title });
        }

        if (entry.injectionDepth !== null && entry.injectionPosition !== 1) {
            issues.push({ type: 'depth_without_inchat', entry: entry.title });
        }

        if (!entry.content || !entry.content.trim()) {
            issues.push({ type: 'empty_content', entry: entry.title });
        }

        if (entry.probability === 0) {
            issues.push({ type: 'probability_zero', entry: entry.title });
        }
    }

    for (const [title, count] of titleCounts) {
        if (count > 1) {
            issues.push({ type: 'duplicate_title', entry: title });
        }
    }

    if (settings.maxTokensBudget && !settings.unlimitedBudget) {
        const constantTokens = vaultIndex.filter(e => e.constant).reduce((s, e) => s + e.tokenEstimate, 0);
        if (constantTokens > settings.maxTokensBudget) {
            issues.push({ type: 'constants_over_budget', tokens: constantTokens });
        }
    }

    return issues;
}

// Cartographer data layer — shared by the Context Cartographer popup
// (src/cartographer.js) and the drawer Why? tab (src/drawer-render.js).

/**
 * Parse a matchedBy string into a structured match reason. Renderers format
 * differently (popup: parenthetical, drawer: badge).
 * @param {string|null} matchedBy
 * @returns {{ type: 'constant'|'pinned'|'bootstrap'|'seed'|'keyword_ai'|'keyword'|'ai'|'unknown', keyword: string|null }}
 */
export function parseMatchReason(matchedBy) {
    if (!matchedBy) return { type: 'unknown', keyword: null };
    const m = matchedBy.toLowerCase();
    if (m.includes('constant') || m.includes('always')) return { type: 'constant', keyword: null };
    if (m.includes('pin')) return { type: 'pinned', keyword: null };
    if (m.includes('bootstrap')) return { type: 'bootstrap', keyword: null };
    if (m.includes('seed')) return { type: 'seed', keyword: null };
    // "keyword → AI: reason" — two-stage match.
    if (matchedBy.includes('→')) {
        const keyword = matchedBy.split('→')[0].trim();
        return { type: 'keyword_ai', keyword };
    }
    if (m.startsWith('ai:') || m === 'ai selection' || m === 'ai') return { type: 'ai', keyword: null };
    if (matchedBy.trim()) return { type: 'keyword', keyword: matchedBy.trim() };
    return { type: 'unknown', keyword: null };
}

/**
 * Compute diff between current and previous injection sources.
 * @param {Array<{title: string, tokens?: number, matchedBy?: string}>} currentSources
 * @param {Array<{title: string, tokens?: number, matchedBy?: string}>|null} previousSources
 * @returns {{ added: Array, removed: Array<{title: string, tokens?: number, matchedBy?: string, removalReason: string}> }}
 */
export function computeSourcesDiff(currentSources, previousSources) {
    if (!previousSources) return { added: [], removed: [] };
    const prevMap = new Map(previousSources.map(s => [s.title, s]));
    const currTitles = new Set(currentSources.map(s => s.title));
    const added = currentSources.filter(s => !prevMap.has(s.title));
    const removed = previousSources.filter(s => !currTitles.has(s.title)).map(s => {
        const prevReason = (s.matchedBy || '').toLowerCase();
        let removalReason = 'No longer matched';
        if (prevReason.includes('bootstrap')) removalReason = 'Bootstrap fall-off';
        else if (prevReason.includes('constant') || prevReason.includes('always')) removalReason = 'Constant removed';
        return { ...s, removalReason };
    });
    return { added, removed };
}

/**
 * Parse a pipeline trace and categorize rejected entries by stage.
 * Handles mixed trace field shapes (string arrays, object arrays).
 *
 * BUG-AUDIT v2.5: `injectedKeys` is a Set of trackerKey-shape strings
 * (`vaultSource:title.toLowerCase()`) so same-titled entries from different
 * vaults don't collide. Output entries carry `vaultSource` for the same reason.
 *
 * @param {object|null} trace - pipeline trace (entries carry vaultSource per #46 contract)
 * @param {Set<string>} injectedKeys - trackerKey-shape Set of currently-injected entries
 * @returns {Array<{ stage: string, label: string, icon: string, entries: Array<{title: string, vaultSource: string, reason: string}> }>}
 */
export function categorizeRejections(trace, injectedKeys) {
    if (!trace) return [];
    const groups = [];
    const k = (e) => `${e.vaultSource || ''}:${(e.title || '').toLowerCase()}`;

    if (trace.gatedOut?.length > 0) {
        const entries = trace.gatedOut
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => {
                const parts = [];
                if (e.requires?.length) parts.push(`needs: ${e.requires.join(', ')}`);
                if (e.excludes?.length) parts.push(`blocked by: ${e.excludes.join(', ')}`);
                return { title: e.title, vaultSource: e.vaultSource || '', reason: parts.join('; ') || 'requires/excludes' };
            });
        if (entries.length > 0) groups.push({ stage: 'gated_out', label: 'Blocked by dependencies', icon: 'fa-lock', entries });
    }

    if (trace.contextualGatingRemoved?.length > 0) {
        const entries = trace.contextualGatingRemoved
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: e.reason || 'Filtered by era/location/scene/character' }));
        if (entries.length > 0) groups.push({ stage: 'contextual_gating', label: 'Filtered by context', icon: 'fa-filter', entries });
    }

    // Candidates that made it to manifest but AI didn't pick.
    if (trace.keywordMatched?.length > 0 && trace.aiSelected) {
        const aiSelectedKeys = new Set(trace.aiSelected.map(k));
        // Entries already attributed to another stage shouldn't double-count here.
        const accountedKeys = new Set([
            ...(trace.gatedOut || []).map(k),
            ...(trace.contextualGatingRemoved || []).map(k),
            ...(trace.cooldownRemoved || []).map(k),
            ...(trace.stripDedupRemoved || []).map(k),
            ...(trace.probabilitySkipped || []).map(k),
            ...(trace.warmupFailed || []).map(k),
            ...(trace.budgetCut || []).map(k),
        ]);
        const entries = trace.keywordMatched
            .filter(m => !aiSelectedKeys.has(k(m)) && !injectedKeys.has(k(m)) && !accountedKeys.has(k(m)))
            .map(m => ({ title: m.title, vaultSource: m.vaultSource || '', reason: 'AI did not select' }));
        if (entries.length > 0) groups.push({ stage: 'ai_rejected', label: 'AI Rejected', icon: 'fa-robot', entries });
    }

    if (trace.cooldownRemoved?.length > 0) {
        const entries = trace.cooldownRemoved
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: e.reason || 'Cooldown active' }));
        if (entries.length > 0) groups.push({ stage: 'cooldown', label: 'Cooldown Active', icon: 'fa-clock', entries });
    }

    if (trace.budgetCut?.length > 0) {
        const entries = trace.budgetCut
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: `Over budget${e.tokens ? ` (${e.tokens} tok)` : ''}` }));
        if (entries.length > 0) groups.push({ stage: 'budget_cut', label: 'Over budget', icon: 'fa-scissors', entries });
    }

    if (trace.stripDedupRemoved?.length > 0) {
        const entries = trace.stripDedupRemoved
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: e.reason || 'Already in context' }));
        if (entries.length > 0) groups.push({ stage: 'strip_dedup', label: 'Already Injected', icon: 'fa-copy', entries });
    }

    if (trace.probabilitySkipped?.length > 0) {
        const entries = trace.probabilitySkipped
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: 'Probability skipped' }));
        if (entries.length > 0) groups.push({ stage: 'probability_skipped', label: 'Probability Skipped', icon: 'fa-dice', entries });
    }

    if (trace.warmupFailed?.length > 0) {
        const entries = trace.warmupFailed
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: 'Warmup not met' }));
        if (entries.length > 0) groups.push({ stage: 'warmup_failed', label: 'Warmup Not Met', icon: 'fa-temperature-low', entries });
    }

    if (trace.refineKeyBlocked?.length > 0) {
        const entries = trace.refineKeyBlocked
            .filter(e => !injectedKeys.has(k(e)))
            .map(e => ({ title: e.title, vaultSource: e.vaultSource || '', reason: `Matched "${e.primaryKey}" but refine keys [${e.refineKeys.join(', ')}] not found` }));
        if (entries.length > 0) groups.push({ stage: 'refine_key_blocked', label: 'Refine Key Blocked', icon: 'fa-filter-circle-xmark', entries });
    }

    return groups;
}

/**
 * Resolve vault name + Obsidian URI for a source entry.
 * @param {{ vaultSource?: string, filename?: string }} source
 * @param {Array<{ name: string }>|undefined} vaults - settings.vaults
 * @returns {{ vaultName: string, uri: string|null }}
 */
export function resolveEntryVault(source, vaults) {
    const srcVault = source.vaultSource && vaults
        ? vaults.find(v => v.name === source.vaultSource)
        : null;
    const vaultName = srcVault ? srcVault.name : (source.vaultSource || vaults?.[0]?.name || '');
    const uri = source.filename ? buildObsidianURI(vaultName, source.filename) : null;
    return { vaultName, uri };
}

/**
 * Green → yellow → red gradient based on tokens vs vault average. Returns HSL.
 * @param {number} tokens
 * @param {number} avgTokens
 * @returns {string} CSS color
 */
export function tokenBarColor(tokens, avgTokens) {
    if (!avgTokens || avgTokens <= 0) return 'var(--SmartThemeQuoteColor, #4caf50)';
    const ratio = Math.min(tokens / avgTokens, 3.0);
    let hue;
    if (ratio <= 0.5) {
        hue = 120;
    } else if (ratio <= 1.0) {
        hue = 120 - ((ratio - 0.5) / 0.5) * 60; // 120 → 60
    } else {
        hue = 60 - (Math.min(ratio - 1.0, 1.0)) * 60; // 60 → 0
    }
    return `hsl(${Math.round(hue)}, 70%, 45%)`;
}

/**
 * Diagnostic stage → CSS color. Shared by browse popup, test-match, settings UI.
 */
export const STAGE_COLORS = {
    keyword_miss: 'var(--dle-warning, #ff9800)',
    no_keywords: 'var(--dle-error, #f44336)',
    scan_depth_zero: 'var(--dle-error, #f44336)',
    warmup: 'var(--dle-warning, #ff9800)',
    cooldown: 'var(--dle-warning, #ff9800)',
    reinjection_cooldown: 'var(--dle-warning, #ff9800)',
    probability: 'var(--dle-accent, #9c27b0)',
    refine_keys: 'var(--dle-warning, #ff9800)',
    gating_requires: 'var(--dle-error, #f44336)',
    gating_excludes: 'var(--dle-error, #f44336)',
    ai_rejected: 'var(--dle-info, #2196f3)',
    budget_cut: 'var(--dle-warning, #ff9800)',
};

/**
 * Format a timestamp as a human-readable relative time string.
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} e.g. "just now", "5m ago", "2h ago", "3d ago"
 */
export function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    if (diff < 0) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}

/**
 * Normalize a pin/block item. Legacy bare strings (pre-H23 chat_metadata) get
 * vaultSource=null (match any vault).
 * @param {string|{title:string, vaultSource?:string}} item
 * @returns {{ title: string, vaultSource: string|null }}
 */
export function normalizePinBlock(item) {
    if (typeof item === 'string') return { title: item, vaultSource: null };
    return { title: item.title || '', vaultSource: item.vaultSource || null };
}

/**
 * Pin/block matches an entry. No vaultSource on the pin = match any vault.
 * @param {string|{title:string, vaultSource?:string}} pinBlock
 * @param {{ title: string, vaultSource?: string }} entry
 * @returns {boolean}
 */
export function matchesPinBlock(pinBlock, entry) {
    const pb = normalizePinBlock(pinBlock);
    if (pb.title.toLowerCase() !== entry.title.toLowerCase()) return false;
    if (pb.vaultSource && entry.vaultSource && pb.vaultSource !== entry.vaultSource) return false;
    return true;
}

/**
 * Normalize a persisted lore gap. v2 statuses are `pending` ↔ `written` only;
 * legacy `acknowledged` / `in_progress` / `rejected` collapse to `pending`.
 * Soft removal lives in sibling chat_metadata arrays now, not status.
 * @param {object} gap
 * @returns {object}
 */
export function normalizeLoreGap(gap) {
    if (!gap || typeof gap !== 'object') return gap;
    const allowed = new Set(['pending', 'written']);
    const status = allowed.has(gap.status) ? gap.status : 'pending';
    return { ...gap, status };
}

/**
 * Force-injected? Constant, or bootstrap when bootstrap is active for this gen.
 * Caller computes `bootstrapActive` from its own context (chat length, settings).
 * @param {object} entry
 * @param {{ bootstrapActive: boolean }} context
 * @returns {boolean}
 */
export function isForceInjected(entry, context = {}) {
    return entry.constant || (context.bootstrapActive && entry.bootstrap);
}

/**
 * M-6 (2026-05-22): canonical predicate for "this entry has an active warmup
 * gate." All three match paths in `src/pipeline/match.js` (primary keyword
 * scan, recursive scan, BM25 fuzzy supplement) MUST use this helper rather
 * than ad-hoc shape checks. Before this consolidation, the primary + recursion
 * paths used `entry.warmup !== null` while the BM25 path used
 * `entry.warmup && entry.warmup >= 1` — those diverge on NaN, on accidental
 * `0`, on `''`, on `false`, on negative numbers, and on undefined. The
 * frontmatter parser only ever emits `null` or a positive integer for
 * `warmup`, but vault cache hydration, manual `chat_metadata` edits, and
 * future field-definitions changes can all surface other shapes — pinning
 * one predicate prevents the three paths from drifting.
 *
 * Contract: returns true iff `entry.warmup` is a positive finite number.
 * Everything else (null, undefined, 0, negative, NaN, Infinity, non-number)
 * is treated as "no warmup gate."
 *
 * @param {{ warmup?: any }} entry
 * @returns {boolean}
 */
export function hasWarmup(entry) {
    const w = entry?.warmup;
    return typeof w === 'number' && Number.isFinite(w) && w > 0;
}

/**
 * Best fuzzy match (bigram Dice coefficient) for an AI-returned title.
 * @param {string} aiTitle
 * @param {string[]} candidateTitles
 * @param {number} [threshold=0.6] - 0–1
 * @returns {{ title: string, similarity: number } | null}
 */
export function fuzzyTitleMatch(aiTitle, candidateTitles, threshold = 0.6) {
    const aBigrams = bigrams(aiTitle.toLowerCase());
    if (aBigrams.size === 0) return null;

    let bestTitle = null;
    let bestScore = 0;
    for (const candidate of candidateTitles) {
        const bBigrams = bigrams(candidate.toLowerCase());
        if (bBigrams.size === 0) continue;
        let overlap = 0;
        for (const bg of aBigrams) { if (bBigrams.has(bg)) overlap++; }
        const score = (2 * overlap) / (aBigrams.size + bBigrams.size);
        if (score > bestScore) { bestScore = score; bestTitle = candidate; }
    }
    return bestScore >= threshold ? { title: bestTitle, similarity: bestScore } : null;
}

/**
 * All-results variant of fuzzyTitleMatch — returns every candidate that scores
 * at or above the threshold, sorted descending by similarity. Used by slash
 * commands (`/dle-pin`, `/dle-block`, etc.) to surface multiple plausible
 * matches via a tie-break picker when the user typed something ambiguous.
 *
 * @param {string} query
 * @param {string[]} candidateTitles
 * @param {number} [threshold=0.6]
 * @returns {Array<{title: string, similarity: number}>} — empty array if none match
 */
export function fuzzyTitleMatchAll(query, candidateTitles, threshold = 0.6) {
    const qBigrams = bigrams(String(query || '').toLowerCase());
    if (qBigrams.size === 0) return [];

    const matches = [];
    for (const candidate of candidateTitles) {
        const cBigrams = bigrams(String(candidate).toLowerCase());
        if (cBigrams.size === 0) continue;
        let overlap = 0;
        for (const bg of qBigrams) { if (cBigrams.has(bg)) overlap++; }
        const score = (2 * overlap) / (qBigrams.size + cBigrams.size);
        if (score >= threshold) matches.push({ title: candidate, similarity: score });
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    return matches;
}

/** @param {string} str @returns {Set<string>} */
function bigrams(str) {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
}

/**
 * Bigram-Dice similarity between two strings, in [0, 1]. Pairwise score used
 * where consumers need a similarity number for one specific pair (e.g. AI
 * Notepad manual dedup), as opposed to fuzzyTitleMatch's best-of-many search.
 *
 * Returns 0 when either side has no bigrams (empty/one-char strings).
 */
export function bigramDiceSimilarity(a, b) {
    if (!a || !b) return 0;
    const aBg = bigrams(String(a).toLowerCase());
    const bBg = bigrams(String(b).toLowerCase());
    if (aBg.size === 0 || bBg.size === 0) return 0;
    let overlap = 0;
    for (const bg of aBg) if (bBg.has(bg)) overlap++;
    return (2 * overlap) / (aBg.size + bBg.size);
}

/**
 * Normalize an AI-Notepad line into a comparison key. Strips bullet markers,
 * checkbox prefixes, numbered-list prefixes, punctuation, and case so
 * semantically-equal notes ("- The party met Alia." vs "* the party met alia.")
 * collapse to the same key. Used for pin matching and dedup grouping.
 */
export function normalizeNotepadLine(line) {
    if (!line) return '';
    return String(line)
        .replace(/^\s*[-*+•]\s+/, '')
        .replace(/^\s*\[[ xX]\]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract <dle-notes> content from a message; returns cleaned message + notes.
 * @param {string} messageText
 * @returns {{ notes: string|null, cleanedMessage: string }}
 */
export function extractAiNotes(messageText) {
    if (!messageText) return { notes: null, cleanedMessage: messageText || '' };

    const noteRegex = /<dle-notes>([\s\S]*?)<\/dle-notes>/g;
    const extracted = [];
    let match;
    while ((match = noteRegex.exec(messageText)) !== null) {
        const content = match[1].trim();
        if (content) extracted.push(content);
    }

    if (extracted.length === 0) return { notes: null, cleanedMessage: messageText };

    const cleanedMessage = messageText.replace(noteRegex, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    return { notes: extracted.join('\n'), cleanedMessage };
}

// ── Librarian: Session Response Parsing ──

/**
 * Parse a Librarian AI response. Tries direct JSON, code-fenced JSON, then
 * bracket-balanced first-object extraction. Pure, Node-testable.
 * @param {string} text
 * @returns {object|null}
 */
export function parseSessionResponse(text) {
    if (!text || typeof text !== 'string') return null;

    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* noop */ }

    const fenceMatch = text.match(/`{3,}(?:json)?\s*([\s\S]*?)`{3,}/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1].trim());
            if (typeof parsed === 'object' && parsed !== null) return parsed;
        } catch { /* noop */ }
    }

    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = firstBrace; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        const parsed = JSON.parse(text.slice(firstBrace, i + 1));
                        if (typeof parsed === 'object' && parsed !== null) return parsed;
                    } catch { /* noop */ }
                    break;
                }
            }
        }
    }

    return null;
}

// ── Librarian: Session Response Validation ──

const VALID_ENTRY_TYPES = ['character', 'location', 'lore', 'organization', 'story'];
const VALID_SESSION_ACTIONS = ['update_draft', 'propose_queue', 'propose_options', 'tool_call'];
const VALID_QUEUE_ACTIONS = ['create', 'update'];
const VALID_URGENCIES = ['low', 'medium', 'high'];

/**
 * Validate a parsed Librarian session response. Pure, Node-testable.
 * @param {object} parsed
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSessionResponse(parsed) {
    const errors = [];

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { valid: false, errors: ['Response must be a JSON object'] };
    }
    if (typeof parsed.message !== 'string' || !parsed.message.trim()) {
        errors.push("Missing required 'message' field (must be a non-empty string)");
    }
    if (parsed.action !== undefined && parsed.action !== null && !VALID_SESSION_ACTIONS.includes(parsed.action)) {
        errors.push(`'action' must be one of: ${VALID_SESSION_ACTIONS.join(', ')}, null. Got: '${parsed.action}'`);
    }

    if (parsed.action === 'tool_call') {
        if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
            errors.push("'tool_calls' must be a non-empty array when action is 'tool_call'");
        } else {
            for (let i = 0; i < parsed.tool_calls.length; i++) {
                const tc = parsed.tool_calls[i];
                if (!tc || typeof tc !== 'object') {
                    errors.push(`tool_calls[${i}] must be an object`);
                } else {
                    if (typeof tc.name !== 'string' || !tc.name.trim()) {
                        errors.push(`tool_calls[${i}].name must be a non-empty string`);
                    }
                    if (tc.args !== undefined && tc.args !== null && (typeof tc.args !== 'object' || Array.isArray(tc.args))) {
                        errors.push(`tool_calls[${i}].args must be an object`);
                    }
                }
            }
        }
    }

    if (parsed.draft !== undefined && parsed.draft !== null) {
        if (typeof parsed.draft !== 'object' || Array.isArray(parsed.draft)) {
            errors.push("'draft' must be an object or null");
        } else {
            // BUG-025: partial drafts are legitimate during iterative update_draft —
            // Emma may emit only the fields she's refining. Validate only PRESENT
            // fields; empty-string checks still reject obvious garbage.
            const d = parsed.draft;
            if (d.title !== undefined && d.title !== null) {
                if (typeof d.title !== 'string' || !d.title.trim()) {
                    errors.push('draft.title cannot be empty when provided');
                }
            }
            if (d.type !== undefined && !VALID_ENTRY_TYPES.includes(d.type)) {
                errors.push(`draft.type must be one of: ${VALID_ENTRY_TYPES.join(', ')}. Got: '${d.type}'`);
            }
            if (d.priority !== undefined) {
                if (typeof d.priority !== 'number' || d.priority < 1 || d.priority > 100) {
                    errors.push(`draft.priority must be a number between 1 and 100. Got: '${d.priority}'`);
                }
            }
            if (d.keys !== undefined && d.keys !== null) {
                if (!Array.isArray(d.keys)) {
                    errors.push('draft.keys must be an array');
                } else if (d.keys.length > 0) {
                    // Empty array allowed — Emma may not have proposed keys yet.
                    const emptyIndices = d.keys.reduce((acc, k, i) => {
                        if (typeof k !== 'string' || !k.trim()) acc.push(i);
                        return acc;
                    }, []);
                    if (emptyIndices.length > 0) {
                        errors.push(`draft.keys contains empty strings at indices: ${emptyIndices.join(', ')}`);
                    }
                }
            }
            if (d.summary !== undefined && typeof d.summary === 'string' && d.summary.length > 600) {
                errors.push(`draft.summary exceeds 600 character limit (${d.summary.length} chars)`);
            }
            if (d.content !== undefined && d.content !== null) {
                // Short partial content allowed during iteration — reject only non-strings.
                if (typeof d.content !== 'string') {
                    errors.push('draft.content must be a string when provided');
                }
            }
        }
    }

    if (parsed.queue !== undefined && parsed.queue !== null) {
        if (!Array.isArray(parsed.queue)) {
            errors.push("'queue' must be an array");
        } else {
            for (let i = 0; i < parsed.queue.length; i++) {
                const item = parsed.queue[i];
                if (!item.title || (typeof item.title === 'string' && !item.title.trim())) {
                    errors.push(`queue[${i}].title is required`);
                }
                if (!VALID_QUEUE_ACTIONS.includes(item.action)) {
                    errors.push(`queue[${i}].action must be 'create' or 'update'. Got: '${item.action}'`);
                }
                if (!item.reason || (typeof item.reason === 'string' && !item.reason.trim())) {
                    errors.push(`queue[${i}].reason is required`);
                }
                if (item.urgency !== undefined && !VALID_URGENCIES.includes(item.urgency)) {
                    errors.push(`queue[${i}].urgency must be low, medium, or high. Got: '${item.urgency}'`);
                }
            }
        }
    }

    if (parsed.options !== undefined && parsed.options !== null) {
        if (!Array.isArray(parsed.options)) {
            errors.push("'options' must be an array");
        } else if (parsed.options.length === 0) {
            errors.push("'options' must contain at least one option");
        } else {
            for (let i = 0; i < parsed.options.length; i++) {
                const opt = parsed.options[i];
                if (!opt.label || (typeof opt.label === 'string' && !opt.label.trim())) {
                    errors.push(`options[${i}].label is required`);
                }
                if (!opt.fields || typeof opt.fields !== 'object' || Array.isArray(opt.fields)) {
                    errors.push(`options[${i}].fields must be an object with draft field values`);
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}
