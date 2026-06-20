/**
 * DeepLore — Custom Field Definitions
 * Parsing, validation, defaults, YAML for user-defined frontmatter fields.
 * Pure — no ST imports, Node-testable.
 */

/** Reserved frontmatter names — cannot be used as custom fields. */
export const RESERVED_FIELD_NAMES = new Set([
    'keys', 'priority', 'tags', 'requires', 'excludes', 'position', 'depth',
    'role', 'scandepth', 'excluderecursion', 'refine_keys', 'cascade_links',
    'cooldown', 'warmup', 'probability', 'summary', 'graph', 'enabled',
    'constant', 'seed', 'bootstrap', 'type', 'fileclass', 'status', 'aliases',
    // Wave 3 WI parity — selective_logic is the native refine-gate mode field.
    // Reserved so users can't shadow it via field-definitions.yaml (which would
    // route their custom value into customFields and silently overwrite the
    // native field after extractCustomFields runs).
    'selective_logic',
]);

const VALID_TYPES = new Set(['string', 'number', 'boolean']);

export const VALID_OPERATORS = new Set([
    'match_any', 'match_all', 'not_any', 'exists', 'not_exists', 'gt', 'lt', 'eq',
]);

const VALID_TOLERANCES = new Set(['strict', 'moderate', 'lenient']);

// Built-in default field definitions.
/** @type {FieldDefinition[]} */
export const DEFAULT_FIELD_DEFINITIONS = [
    {
        name: 'era',
        label: 'Era',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'era',
    },
    {
        name: 'location',
        label: 'Location',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'location',
    },
    {
        name: 'scene_type',
        label: 'Scene Type',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'scene_type',
    },
    {
        name: 'character_present',
        label: 'Characters Present',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'character_present',
    },
];

/**
 * @typedef {object} FieldDefinition
 * @property {string} name - Frontmatter field name (snake_case, must not collide with reserved names)
 * @property {string} label - Human-readable label for UI display
 * @property {'string'|'number'|'boolean'} type - Data type
 * @property {boolean} multi - Whether this field holds an array of values
 * @property {{ enabled: boolean, operator: string, tolerance: string }} gating - Gating configuration
 * @property {string[]} values - Optional allowed values (empty = freeform)
 * @property {string} contextKey - Key in chat_metadata.deeplore_context
 */

/**
 * Validate a field name against reserved names.
 * @param {string} name
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFieldName(name) {
    if (!name || typeof name !== 'string') {
        return { valid: false, reason: 'Field name is required' };
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return { valid: false, reason: 'Field name is required' };
    }
    if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
        return { valid: false, reason: 'Field name must be lowercase alphanumeric with underscores, starting with a letter' };
    }
    if (RESERVED_FIELD_NAMES.has(trimmed.toLowerCase())) {
        return { valid: false, reason: `"${trimmed}" is a reserved field name` };
    }
    return { valid: true };
}

/**
 * Validate a single field definition. Returns a normalized copy or null.
 * @param {object} raw - From YAML or UI
 * @returns {{ field: FieldDefinition|null, errors: string[] }}
 */
export function validateFieldDefinition(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object') {
        return { field: null, errors: ['Field definition must be an object'] };
    }

    const nameResult = validateFieldName(raw.name);
    if (!nameResult.valid) {
        errors.push(nameResult.reason);
    }

    const label = (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : (raw.name || '');

    const type = VALID_TYPES.has(raw.type) ? raw.type : 'string';
    if (raw.type && !VALID_TYPES.has(raw.type)) {
        errors.push(`Unknown type "${raw.type}", defaulting to "string"`);
    }

    const multi = raw.multi === true;

    const rawGating = raw.gating || {};
    if (rawGating.enabled !== undefined && typeof rawGating.enabled !== 'boolean') {
        errors.push(`gating.enabled must be true or false (got ${JSON.stringify(rawGating.enabled)}); defaulting to enabled. To disable gating use "enabled: false".`);
    }
    const gating = {
        enabled: rawGating.enabled !== false,
        operator: VALID_OPERATORS.has(rawGating.operator) ? rawGating.operator : 'match_any',
        tolerance: VALID_TOLERANCES.has(rawGating.tolerance) ? rawGating.tolerance : 'moderate',
    };

    const values = Array.isArray(raw.values) ? raw.values.map(v => String(v).trim()).filter(Boolean) : [];

    const contextKey = (typeof raw.contextKey === 'string' && raw.contextKey.trim()) ? raw.contextKey.trim() : (raw.name || '');

    if (errors.length > 0 && !nameResult.valid) {
        return { field: null, errors };
    }

    return {
        field: { name: raw.name.trim(), label, type, multi, gating, values, contextKey },
        errors,
    };
}

/**
 * Line-based YAML parser (no external lib). Expects the format produced by
 * serializeFieldDefinitions().
 * @param {string} yamlText
 * @returns {{ definitions: FieldDefinition[], errors: string[] }}
 */
export function parseFieldDefinitionYaml(yamlText) {
    if (!yamlText || typeof yamlText !== 'string') {
        return { definitions: [], errors: [] };
    }

    const trimmed = yamlText.trim();
    if (trimmed.length === 0) {
        return { definitions: [], errors: [] };
    }

    const errors = [];
    const definitions = [];

    const lines = trimmed.split('\n');
    let currentField = null;
    let inGating = false;
    let inValues = false;
    let sawContent = false; // did any non-comment/non-blank line appear?

    for (let i = 0; i < lines.length; i++) {
        // Obsidian indents with tabs by default; the serializer uses 2-space units.
        // Expand leading tabs (1 tab = one indent level → 2 spaces) so the \s{2}/\s{4}/\s{6}
        // structure regexes match tab-indented hand-edited files instead of silently
        // parsing zero fields.
        const line = lines[i].replace(/^\t+/, t => '  '.repeat(t.length));
        const stripped = line.trimEnd();

        if (stripped.startsWith('#') || stripped === '' || stripped === 'fields:') continue;
        sawContent = true;

        // New field: "  - name: ..."
        if (/^\s{2}-\s+name:\s*(.+)/.test(stripped)) {
            if (currentField) {
                const { field, errors: fieldErrors } = validateFieldDefinition(currentField);
                if (field) definitions.push(field);
                errors.push(...fieldErrors);
            }
            currentField = { name: stripped.match(/name:\s*(.+)/)[1].trim(), gating: {} };
            inGating = false;
            inValues = false;
            continue;
        }

        if (!currentField) continue;

        if (/^\s{4}gating:/.test(stripped)) {
            inGating = true;
            inValues = false;
            continue;
        }

        if (/^\s{4}values:/.test(stripped)) {
            inValues = true;
            inGating = false;
            if (/values:\s*\[\s*\]/.test(stripped)) {
                currentField.values = [];
                inValues = false;
            }
            continue;
        }

        if (inGating && /^\s{6}\w/.test(stripped)) {
            const match = stripped.match(/^\s{6}(\w+):\s*(.+)/);
            if (match) {
                const [, key, val] = match;
                const parsed = parseYamlValue(val.trim());
                if (!currentField.gating) currentField.gating = {};
                currentField.gating[key] = parsed;
            }
            continue;
        }

        if (inValues && /^\s{6}-\s/.test(stripped)) {
            if (!currentField.values) currentField.values = [];
            const valMatch = stripped.match(/^\s{6}-\s+(.+)/);
            if (valMatch) currentField.values.push(valMatch[1].trim());
            continue;
        }

        // Indent-4 = top-level field property — reset sub-block flags.
        if (/^\s{4}\w/.test(stripped)) {
            inGating = false;
            inValues = false;
            const match = stripped.match(/^\s{4}(\w+):\s*(.+)/);
            if (match) {
                const [, key, val] = match;
                currentField[key] = parseYamlValue(val.trim());
            }
        }
    }

    // Last field has no terminator — flush.
    if (currentField) {
        const { field, errors: fieldErrors } = validateFieldDefinition(currentField);
        if (field) definitions.push(field);
        errors.push(...fieldErrors);
    }

    // Non-empty content that produced zero definitions is almost always a structure
    // problem (e.g. mixed/wrong indentation). Surface it instead of failing silently.
    if (definitions.length === 0 && errors.length === 0 && sawContent) {
        errors.push('No field definitions parsed from non-empty content — check indentation and the "  - name:" structure (use spaces or tabs consistently, not mid-line mixes).');
    }

    return { definitions, errors };
}

/**
 * Parse a simple YAML scalar value.
 * @param {string} val
 * @returns {string|number|boolean}
 */
function parseYamlValue(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        return val.slice(1, -1);
    }
    if (val === '[]') return [];
    return val;
}

/**
 * Serialize FieldDefinitions to YAML.
 * @param {FieldDefinition[]} definitions
 * @returns {string}
 */
export function serializeFieldDefinitions(definitions) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
        return 'fields: []\n';
    }

    const lines = ['fields:'];
    for (const def of definitions) {
        lines.push(`  - name: ${def.name}`);
        lines.push(`    label: ${def.label}`);
        lines.push(`    type: ${def.type}`);
        lines.push(`    multi: ${def.multi}`);
        lines.push('    gating:');
        lines.push(`      enabled: ${def.gating.enabled}`);
        lines.push(`      operator: ${def.gating.operator}`);
        lines.push(`      tolerance: ${def.gating.tolerance}`);
        if (def.values && def.values.length > 0) {
            lines.push('    values:');
            for (const v of def.values) {
                lines.push(`      - ${v}`);
            }
        } else {
            lines.push('    values: []');
        }
        lines.push(`    contextKey: ${def.contextKey}`);
    }

    return lines.join('\n') + '\n';
}

/**
 * Evaluate a gating operator against entry and active context values.
 * @param {string} operator - One of VALID_OPERATORS
 * @param {*} entryValue - Value from entry.customFields[fieldName]
 * @param {*} activeValue - Value from chat_metadata.deeplore_context[contextKey]
 * @returns {boolean}
 */
export function evaluateOperator(operator, entryValue, activeValue) {
    const entryArr = Array.isArray(entryValue) ? entryValue : [entryValue];
    const activeArr = Array.isArray(activeValue) ? activeValue : [activeValue];

    switch (operator) {
        case 'match_any':
            return entryArr.some(v => activeArr.some(a => String(v).toLowerCase() === String(a).toLowerCase()));
        case 'match_all':
            // BUG-AUDIT-6: all ENTRY values must exist in active context.
            // entry.character_present: [Alice, Bob] only passes when BOTH are present.
            return entryArr.every(v => activeArr.some(a => String(v).toLowerCase() === String(a).toLowerCase()));
        case 'not_any':
            return !entryArr.some(v => activeArr.some(a => String(v).toLowerCase() === String(a).toLowerCase()));
        case 'exists':
            return entryValue != null && (!Array.isArray(entryValue) || entryValue.length > 0);
        case 'not_exists':
            return entryValue == null || (Array.isArray(entryValue) && entryValue.length === 0);
        case 'eq':
            // Reduce over active values ("any element matches") — String([a,b]) would compare
            // against "a,b" and match nothing for a multi-valued context.
            return activeArr.some(a => String(entryValue).toLowerCase() === String(a).toLowerCase());
        case 'gt': {
            const a = Number(entryValue);
            if (Number.isNaN(a)) return false; // BUG-L2: NaN guard
            // "any active element satisfies" — Number([3,5]) is NaN and would fail-closed.
            return activeArr.some(x => { const b = Number(x); return !Number.isNaN(b) && a > b; });
        }
        case 'lt': {
            const a = Number(entryValue);
            if (Number.isNaN(a)) return false; // BUG-L2: NaN guard
            return activeArr.some(x => { const b = Number(x); return !Number.isNaN(b) && a < b; });
        }
        default:
            return true;
    }
}

/**
 * Extract custom field values from parsed frontmatter, guided by field definitions.
 * @param {object} frontmatter - Parsed frontmatter object
 * @param {FieldDefinition[]} fieldDefinitions - Active field definitions
 * @returns {Object<string, *>} customFields object
 */
export function extractCustomFields(frontmatter, fieldDefinitions) {
    const customFields = {};
    if (!frontmatter || !fieldDefinitions) return customFields;

    const toStringArray = (v) => {
        if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
        if (typeof v === 'string' && v.trim()) return [v.trim()];
        if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
        return [];
    };

    for (const field of fieldDefinitions) {
        const raw = frontmatter[field.name];
        if (raw === undefined) continue;

        if (field.type === 'string') {
            customFields[field.name] = field.multi ? toStringArray(raw) : (typeof raw === 'string' ? raw.trim() : String(raw));
        } else if (field.type === 'number') {
            const num = typeof raw === 'number' ? raw : Number(raw);
            customFields[field.name] = Number.isNaN(num) ? null : num;
        } else if (field.type === 'boolean') {
            customFields[field.name] = raw === true || raw === 'true';
        }
    }

    return customFields;
}

/**
 * Check for duplicate field names in a definitions array.
 * @param {FieldDefinition[]} definitions
 * @returns {string[]} Array of duplicate names (empty if none)
 */
export function findDuplicateFieldNames(definitions) {
    const seen = new Set();
    const dupes = [];
    for (const def of definitions) {
        const lower = def.name.toLowerCase();
        if (seen.has(lower)) dupes.push(def.name);
        else seen.add(lower);
    }
    return dupes;
}
