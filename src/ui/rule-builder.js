/** DeepLore — Rule Builder Popup. Custom frontmatter gating field editor. */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../popup.js';
import { getSettings, getPrimaryVault, invalidateSettingsCache } from '../../settings.js';
import { fieldDefinitions, setFieldDefinitions } from '../state.js';
import {
    DEFAULT_FIELD_DEFINITIONS,
    validateFieldDefinition, serializeFieldDefinitions,
} from '../fields.js';
import { writeFieldDefinitions } from '../vault/obsidian-api.js';
import { buildIndex } from '../vault/vault.js';
import { tr } from '../i18n/i18n.js';

// JS value key → locale key + English fallback. Resolved at render time via tr()
// so the dropdowns honor the active locale. The op/type/tolerance strings were
// authored in all locale files but the Rule Builder hardcoded English until now.
const OPERATOR_LABELS = {
    match_any: ['dle_op_match_any', 'Match Any'],
    match_all: ['dle_op_match_all', 'Match All'],
    not_any: ['dle_op_not_any', 'Not Any'],
    exists: ['dle_op_exists', 'Exists'],
    not_exists: ['dle_op_not_exists', 'Not Exists'],
    gt: ['dle_op_greater_than', 'Greater Than'],
    lt: ['dle_op_less_than', 'Less Than'],
    eq: ['dle_op_equals', 'Equals'],
};

const TOLERANCE_LABELS = {
    strict: ['dle_tolerance_strict', 'Strict — require match or filter out'],
    moderate: ['dle_tolerance_moderate', 'Moderate — pass if context not set'],
    lenient: ['dle_tolerance_lenient', 'Lenient — pass unless mismatch'],
};

const TYPE_LABELS = {
    string: ['dle_type_text', 'Text'],
    number: ['dle_type_number', 'Number'],
    boolean: ['dle_type_boolean', 'Boolean'],
};

function buildFieldRowHtml(field, index) {
    const nameVal = escapeHtml(field.name || '');
    const labelVal = escapeHtml(field.label || '');
    const contextKeyVal = escapeHtml(field.contextKey || '');
    const valuesStr = escapeHtml((field.values || []).join(', '));

    const typeOptions = Object.entries(TYPE_LABELS)
        .map(([k, [lk, fb]]) => `<option value="${k}"${field.type === k ? ' selected' : ''}>${escapeHtml(tr(lk, fb))}</option>`)
        .join('');

    const operatorOptions = Object.entries(OPERATOR_LABELS)
        .map(([k, [lk, fb]]) => `<option value="${k}"${field.gating?.operator === k ? ' selected' : ''}>${escapeHtml(tr(lk, fb))}</option>`)
        .join('');

    const toleranceOptions = Object.entries(TOLERANCE_LABELS)
        .map(([k, [lk, fb]]) => `<option value="${k}"${field.gating?.tolerance === k ? ' selected' : ''}>${escapeHtml(tr(lk, fb))}</option>`)
        .join('');

    const gatingDisabled = field.gating?.enabled === false;
    const gatingDimClass = gatingDisabled ? ' dle-rb-gating-disabled' : '';

    // A saved field with a deliberately divergent contextKey reopens UNLINKED so the
    // .dle-rb-name handler won't clobber it on the first keystroke.
    const linked = (field.contextKey || field.name || '') === (field.name || '');
    const linkIconClass = linked ? 'fa-link' : 'fa-link-slash';
    const linkIconTitle = linked
        ? 'Linked to field name — click to unlink'
        : 'Unlinked from field name — click to re-link';
    const linkIconStyle = linked ? '' : ' style="opacity:0.4"';
    const ctxManualAttr = linked ? '' : ' data-manual="true"';

    return `
    <div class="dle-rb-field" data-idx="${index}">
        <div class="dle-rb-field-header">
            <span class="dle-rb-field-num">#${index + 1}</span>
            <input class="dle-rb-name text_pole" data-prop="name" value="${nameVal}" placeholder="field_name" title="Frontmatter field name (snake_case)" />
            <input class="dle-rb-label text_pole" data-prop="label" value="${labelVal}" placeholder="Display Label" title="Human-readable label" />
            <div class="dle-rb-field-tools">
                <button class="dle-rb-move-up menu_button" title="Move up" aria-label="Move field up"><i class="fa-solid fa-chevron-up"></i></button>
                <button class="dle-rb-move-down menu_button" title="Move down" aria-label="Move field down"><i class="fa-solid fa-chevron-down"></i></button>
                <button class="dle-rb-dupe menu_button" title="Duplicate field" aria-label="Duplicate field"><i class="fa-solid fa-copy"></i></button>
                <button class="dle-rb-delete menu_button" title="Remove field" aria-label="Remove field #${index + 1}"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
        <div class="dle-rb-field-body">
            <div class="dle-rb-row">
                <label class="dle-rb-lbl">Type</label>
                <select class="dle-rb-select" data-prop="type">${typeOptions}</select>
                <label class="dle-rb-lbl dle-rb-multi-lbl"><input type="checkbox" data-prop="multi" ${field.multi ? 'checked' : ''} ${field.type === 'boolean' ? 'disabled' : ''} /> Multi-value</label>
            </div>
            <div class="dle-rb-row">
                <label class="dle-rb-lbl">Gating</label>
                <label class="dle-rb-lbl dle-rb-enabled-lbl" title="Enable or disable contextual gating for this field"><input type="checkbox" data-prop="gating.enabled" ${field.gating?.enabled !== false ? 'checked' : ''} /> Enabled</label>
                <select class="dle-rb-select${gatingDimClass}" data-prop="gating.operator">${operatorOptions}</select>
                <select class="dle-rb-select dle-rb-tolerance${gatingDimClass}" data-prop="gating.tolerance">${toleranceOptions}</select>
            </div>
            <div class="dle-rb-row">
                <label class="dle-rb-lbl">Context Key</label>
                <input class="dle-rb-ctx text_pole" data-prop="contextKey" value="${contextKeyVal}"${ctxManualAttr} placeholder="chat_metadata key" title="Key used in chat_metadata.deeplore_context" />
                <span class="dle-rb-link-icon" role="button" tabindex="0" aria-label="Toggle link between context key and field name" title="${escapeHtml(linkIconTitle)}"${linkIconStyle}><i class="fa-solid ${linkIconClass}"></i></span>
            </div>
            <div class="dle-rb-row">
                <label class="dle-rb-lbl">Allowed Values</label>
                <input class="dle-rb-values text_pole" data-prop="values" value="${valuesStr}" placeholder="e.g. morning, afternoon, evening (or leave empty for freeform)" title="Comma-separated allowed values. Leave empty for freeform." />
            </div>
        </div>
    </div>`;
}

function reindexFields($container) {
    $container.find('.dle-rb-field').each(function (i) {
        $(this).attr('data-idx', i);
        $(this).find('.dle-rb-field-num').text(`#${i + 1}`);
    });
}

function readFieldFromRow($row) {
    const get = (prop) => {
        const $el = $row.find(`[data-prop="${prop}"]`);
        if ($el.is(':checkbox')) return $el.is(':checked');
        return ($el.val() || '').trim();
    };

    const valuesRaw = get('values');
    const values = valuesRaw ? valuesRaw.split(',').map(v => v.trim()).filter(Boolean) : [];

    return {
        name: get('name'),
        label: get('label') || get('name'),
        type: get('type') || 'string',
        multi: get('multi'),
        gating: {
            enabled: get('gating.enabled'),
            operator: get('gating.operator') || 'match_any',
            tolerance: get('gating.tolerance') || 'moderate',
        },
        values,
        contextKey: get('contextKey') || get('name'),
    };
}

export async function openRuleBuilder() {
    // Deep clone — edits live in `working` until Save commits to module state.
    const working = JSON.parse(JSON.stringify(
        fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS
    ));

    const html = `
    <div class="dle-rb-popup">
        <div class="dle-rb-header">
            <h3><i class="fa-solid fa-sliders"></i> Custom Gating Fields</h3>
            <p class="dle-text-sm dle-rb-desc">
                Define frontmatter fields for contextual gating. Each field controls which lore entries
                are injected based on the active scene context.
            </p>
        </div>
        <div class="dle-rb-errors dle-hidden"></div>
        <div class="dle-rb-fields">
            ${working.map((f, i) => buildFieldRowHtml(f, i)).join('')}
        </div>
        <div class="dle-rb-actions">
            <button class="dle-rb-add menu_button"><i class="fa-solid fa-plus"></i> Add Field</button>
            <button class="dle-rb-reset menu_button" title="Reset to 4 built-in defaults (era, location, scene_type, character_present)"><i class="fa-solid fa-rotate-left"></i> Reset Defaults</button>
        </div>
        <div class="dle-rb-footer">
            <button class="dle-rb-save menu_button menu_button_default"><i class="fa-solid fa-floppy-disk"></i> Save to Obsidian</button>
            <button class="dle-rb-cancel menu_button"><i class="fa-solid fa-xmark"></i> Cancel</button>
        </div>
    </div>`;

    const $container = $(html);
    let dirty = false;
    let saved = false;
    let saving = false;

    $container.on('input change', '.dle-rb-field input, .dle-rb-field select', () => {
        dirty = true;
        $container.find('.dle-rb-field-error').removeClass('dle-rb-field-error');
    });

    $container.on('click', '.dle-rb-add', () => {
        const count = $container.find('.dle-rb-field').length;
        const newField = {
            name: '', label: '', type: 'string', multi: false,
            gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
            values: [], contextKey: '',
        };
        const $newRow = $(buildFieldRowHtml(newField, count));
        $newRow.addClass('dle-rb-new');
        $container.find('.dle-rb-fields').append($newRow);
        $newRow[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        $newRow.find('.dle-rb-name').trigger('focus');
        dirty = true;
    });

    $container.on('click', '.dle-rb-delete', function () {
        const $field = $(this).closest('.dle-rb-field');
        $field.addClass('dle-rb-removing');
        // BUG-M1: .one() auto-removes the listener; setTimeout is a fallback if transitionend never fires.
        $field.one('transitionend', () => { $field.remove(); reindexFields($container); });
        setTimeout(() => { if ($field.parent().length) { $field.remove(); reindexFields($container); } }, 200);
        dirty = true;
    });

    $container.on('click', '.dle-rb-move-up', function () {
        const $field = $(this).closest('.dle-rb-field');
        const $prev = $field.prev('.dle-rb-field');
        if ($prev.length) {
            $field.insertBefore($prev);
            reindexFields($container);
            dirty = true;
        }
    });
    $container.on('click', '.dle-rb-move-down', function () {
        const $field = $(this).closest('.dle-rb-field');
        const $next = $field.next('.dle-rb-field');
        if ($next.length) {
            $field.insertAfter($next);
            reindexFields($container);
            dirty = true;
        }
    });

    $container.on('click', '.dle-rb-dupe', function () {
        const $row = $(this).closest('.dle-rb-field');
        const data = readFieldFromRow($row);
        data.name = data.name ? data.name + '_copy' : '';
        data.label = data.label ? data.label + ' (Copy)' : '';
        data.contextKey = data.contextKey ? data.contextKey + '_copy' : '';
        const count = $container.find('.dle-rb-field').length;
        const $newRow = $(buildFieldRowHtml(data, count));
        $newRow.addClass('dle-rb-new');
        $row.after($newRow);
        reindexFields($container);
        $newRow[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        dirty = true;
    });

    // Auto-sync contextKey from name unless user has manually edited contextKey.
    $container.on('input', '.dle-rb-name', function () {
        const $row = $(this).closest('.dle-rb-field');
        const $ctx = $row.find('[data-prop="contextKey"]');
        const $icon = $row.find('.dle-rb-link-icon');
        if (!$ctx.data('manual')) {
            $ctx.val($(this).val().trim());
            $icon.find('i').removeClass('fa-link-slash').addClass('fa-link');
            $icon.attr('title', 'Linked to field name — click to unlink');
            $icon.css('opacity', '');
        }
    });
    $container.on('input', '[data-prop="contextKey"]', function () {
        const $row = $(this).closest('.dle-rb-field');
        const $icon = $row.find('.dle-rb-link-icon');
        $(this).data('manual', true);
        $icon.find('i').removeClass('fa-link').addClass('fa-link-slash');
        $icon.attr('title', 'Unlinked from field name — click to re-link');
        $icon.css('opacity', '0.4');
    });

    // BUG-189: keyboard activation for the link/unlink icon.
    $container.on('keydown', '.dle-rb-link-icon', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    $container.on('click', '.dle-rb-link-icon', function () {
        const $row = $(this).closest('.dle-rb-field');
        const $ctx = $row.find('[data-prop="contextKey"]');
        const isManual = $ctx.data('manual');
        if (isManual) {
            $ctx.data('manual', false);
            $ctx.val($row.find('[data-prop="name"]').val().trim());
            $(this).find('i').removeClass('fa-link-slash').addClass('fa-link');
            $(this).attr('title', 'Linked to field name — click to unlink');
            $(this).css('opacity', '');
        } else {
            $ctx.data('manual', true);
            $(this).find('i').removeClass('fa-link').addClass('fa-link-slash');
            $(this).attr('title', 'Unlinked from field name — click to re-link');
            $(this).css('opacity', '0.4');
        }
        dirty = true;
    });

    $container.on('change', '[data-prop="gating.enabled"]', function () {
        const $row = $(this).closest('.dle-rb-field');
        const isEnabled = $(this).is(':checked');
        $row.find('[data-prop="gating.operator"], [data-prop="gating.tolerance"]')
            .toggleClass('dle-rb-gating-disabled', !isEnabled);
    });

    $container.on('change', '[data-prop="type"]', function () {
        const $row = $(this).closest('.dle-rb-field');
        const isBool = $(this).val() === 'boolean';
        const $multi = $row.find('[data-prop="multi"]');
        if (isBool) {
            $multi.prop('checked', false).prop('disabled', true);
        } else {
            $multi.prop('disabled', false);
        }
    });

    $container.on('click', '.dle-rb-reset', async () => {
        const confirm = await callGenericPopup(
            'Reset all fields to the 4 built-in defaults? Custom fields will be lost.',
            POPUP_TYPE.CONFIRM,
        );
        if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;

        const defaults = JSON.parse(JSON.stringify(DEFAULT_FIELD_DEFINITIONS));
        $container.find('.dle-rb-fields').html(
            defaults.map((f, i) => buildFieldRowHtml(f, i)).join('')
        );
        $container.find('.dle-rb-errors').hide().empty();
        dirty = true;
    });

    $container.on('click', '.dle-rb-save', async () => {
        if (saving) return;
        saving = true;
        const $saveBtn = $container.find('.dle-rb-save');
        $saveBtn.prop('disabled', true).css('opacity', '0.5');

        try {
            const $errBox = $container.find('.dle-rb-errors');
            $errBox.hide().empty();
            $container.find('.dle-rb-field-error').removeClass('dle-rb-field-error');
            const allErrors = [];
            let firstBadIdx = -1;

            const newDefs = [];
            $container.find('.dle-rb-field').each(function (idx) {
                const raw = readFieldFromRow($(this));
                const { field, errors } = validateFieldDefinition(raw);
                if (!field && errors.length > 0) {
                    allErrors.push(`<b>${escapeHtml(raw.name || '(unnamed)')}</b>: ${errors.map(escapeHtml).join(', ')}`);
                    $(this).addClass('dle-rb-field-error');
                    if (firstBadIdx < 0) firstBadIdx = idx;
                }
                if (field) newDefs.push(field);
            });

            const names = newDefs.map(f => f.name);
            const dupes = names.filter((n, i) => names.indexOf(n) !== i);
            if (dupes.length > 0) {
                allErrors.push(`Duplicate field names: ${[...new Set(dupes)].join(', ')}`);
            }

            if (allErrors.length > 0) {
                $errBox.html(allErrors.join('<br>')).show();
                if (firstBadIdx >= 0) {
                    $container.find('.dle-rb-field').eq(firstBadIdx)[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
                return;
            }

            const settings = getSettings();
            const vault = getPrimaryVault(settings);
            if (!vault) {
                $errBox.html('<i class="fa-solid fa-triangle-exclamation"></i> No Obsidian vault configured. Field definitions must be saved to your vault. Check Connection settings.').show();
                return;
            }
            const yaml = serializeFieldDefinitions(newDefs);
            const path = settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
            const result = await writeFieldDefinitions(vault.host || '127.0.0.1', vault.port, vault.apiKey, path, yaml, vault.https || false);
            if (!result?.ok) {
                $errBox.html('<i class="fa-solid fa-triangle-exclamation"></i> Failed to write field definitions to Obsidian. Check your connection and try again.').show();
                return;
            }

            // BUG-134: explicitly invalidate settings cache — field defs feed into
            // settings-derived state downstream.
            setFieldDefinitions(newDefs);
            invalidateSettingsCache();
            saved = true;
            dirty = false;

            const fieldNames = newDefs.map(f => f.name).join(', ');
            toastr.success(`Saved ${newDefs.length} field${newDefs.length !== 1 ? 's' : ''} (${fieldNames}). Rebuilding index...`, 'Fields Updated');
            // Surface reindex failure: fields saved but vault still indexed without
            // new extractions is a silent data-drift footgun.
            buildIndex().catch(err => {
                console.warn('[DLE] Index rebuild after field save failed:', err?.message);
                try {
                    toastr.error(
                        `Fields saved, but index rebuild failed: ${err?.message || 'unknown error'}. Run /dle-force-refresh or rebuild from the drawer.`,
                        'Reindex Failed',
                        { timeOut: 12000 },
                    );
                } catch { /* toastr unavailable */ }
            });

            $container.closest('.dialogue_popup').find('.dialogue_popup_ok').trigger('click');
        } finally {
            saving = false;
            $saveBtn.prop('disabled', false).css('opacity', '');
        }
    });

    $container.on('click', '.dle-rb-cancel', () => {
        $container.closest('.dialogue_popup').find('.dialogue_popup_ok').trigger('click');
    });

    await callGenericPopup($container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClosing: async () => {
            if (dirty && !saved) {
                const confirm = await callGenericPopup(
                    'You have unsaved changes. Discard them?',
                    POPUP_TYPE.CONFIRM,
                );
                return confirm === POPUP_RESULT.AFFIRMATIVE;
            }
            return true;
        },
    });
}
