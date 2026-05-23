/** DeepLore Enhanced — First-Run Setup Wizard */
import { saveSettingsDebounced } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { callGenericPopup, POPUP_TYPE, Popup } from '../../../../../popup.js';
import { getSettings, getPrimaryVault, invalidateSettingsCache } from '../../settings.js';
import { setIndexTimestamp } from '../state.js';
import { testConnection, writeNote, writeFieldDefinitions, buildConnectionGuidanceHtml } from '../vault/obsidian-api.js';
import { buildIndex } from '../vault/vault.js';
import { serializeFieldDefinitions, DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { parseWorldInfoJson, importEntries } from '../vault/import.js';

const TOTAL_PAGES = 9;

const PRESETS = {
    small:  { scanDepth: 4,  maxEntries: 10, budget: 2048 },
    medium: { scanDepth: 6,  maxEntries: 15, budget: 3072 },
    large:  { scanDepth: 8,  maxEntries: 20, budget: 4096 },
};

let currentPage = 1;
let connectionVerified = false;
let searchMode = 'keywords';
let importResult = null;
let $wizard = null;

/** @param {number} [startPage=1] 1-indexed page to start on */
export async function showSetupWizard(startPage = 1) {
    const html = await renderExtensionTemplateAsync('third-party/sillytavern-DeepLore-Enhanced', 'setup-wizard');

    currentPage = 1;
    connectionVerified = false;
    searchMode = 'keywords';
    importResult = null;

    await callGenericPopup(html, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        okButton: false,
        cancelButton: false,
        allowVerticalScrolling: true,
        onOpen: () => {
            $wizard = $('.dle-wizard');
            if (!$wizard.length) return;
            librarianToggleWired = false;
            resetWizardState(); // BUG-340: fresh state per open

            prefillFromSettings();
            wireNavigation();
            wireConnectionTest();
            wireDemoVault();
            wireAiSetup();
            wirePresets();
            wireSearchMode();
            wireVaultStructure();
            wireImport();
            wireDoneActions();
            wireStepIndicator();

            if (startPage > 1 && startPage <= TOTAL_PAGES) {
                for (let i = 1; i < startPage; i++) markStepComplete(i);
                goToPage(startPage);
            }

            updateNavButtons();
        },
    });
}

function prefillFromSettings() {
    const s = getSettings();
    const v = getPrimaryVault(s);

    // Page 2: Connection
    if (v.name) $wizard.find('#dle-wiz-vault-name').val(v.name);
    if (v.host) $wizard.find('#dle-wiz-host').val(v.host);
    if (v.port) $wizard.find('#dle-wiz-port').val(v.port);
    if (v.apiKey) $wizard.find('#dle-wiz-api-key').val(v.apiKey);
    $wizard.find('#dle-wiz-https').prop('checked', !!v.https);

    // Page 3: Tags
    $wizard.find('#dle-wiz-lorebook-tag').val(s.lorebookTag || 'lorebook');
    $wizard.find('#dle-wiz-constant-tag').val(s.constantTag || 'lorebook-always');
    $wizard.find('#dle-wiz-seed-tag').val(s.seedTag || 'lorebook-seed');
    $wizard.find('#dle-wiz-bootstrap-tag').val(s.bootstrapTag || 'lorebook-bootstrap');

    // Search mode
    if (s.aiSearchEnabled) {
        searchMode = s.aiSearchMode || 'two-stage';
        $wizard.find(`input[name="dle-wiz-search-mode"][value="${searchMode}"]`).prop('checked', true);
    }

    // Page 4: Matching
    $wizard.find('#dle-wiz-scan-depth').val(s.scanDepth);
    $wizard.find('#dle-wiz-max-entries').val(s.maxEntries);
    $wizard.find('#dle-wiz-budget').val(s.maxTokensBudget);
    $wizard.find('#dle-wiz-fuzzy').prop('checked', s.fuzzySearchEnabled);
    $wizard.find('#dle-wiz-unlimited-entries').prop('checked', !!s.unlimitedEntries);
    $wizard.find('#dle-wiz-unlimited-budget').prop('checked', !!s.unlimitedBudget);
    if (s.unlimitedEntries) $wizard.find('#dle-wiz-max-entries').prop('disabled', true);
    if (s.unlimitedBudget) $wizard.find('#dle-wiz-budget').prop('disabled', true);

    // Page 5: AI
    if (s.aiSearchConnectionMode === 'proxy') {
        $wizard.find('input[name="dle-wiz-ai-mode"][value="proxy"]').prop('checked', true);
        $wizard.find('#dle-wiz-ai-profile-fields').hide();
        $wizard.find('#dle-wiz-ai-proxy-fields').show();
    }
    if (s.aiSearchProxyUrl) $wizard.find('#dle-wiz-ai-proxy-url').val(s.aiSearchProxyUrl);
    if (s.aiSearchModel) $wizard.find('#dle-wiz-ai-model').val(s.aiSearchModel);

    // Page 6: Librarian
    if (s.librarianEnabled) $wizard.find('#dle-wiz-librarian-enabled').prop('checked', true);
    if (s.librarianSearchEnabled !== undefined) $wizard.find('#dle-wiz-librarian-search').prop('checked', s.librarianSearchEnabled);
    if (s.librarianFlagEnabled !== undefined) $wizard.find('#dle-wiz-librarian-flag').prop('checked', s.librarianFlagEnabled);
}

function wireNavigation() {
    $wizard.find('#dle-wiz-prev').on('click', () => {
        let target = currentPage - 1;
        // Skip AI (5) and Librarian (6) pages when keywords-only — no tool calling without AI.
        if (target === 6 && searchMode === 'keywords') target = 5;
        if (target === 5 && searchMode === 'keywords') target = 4;
        if (target >= 1) goToPage(target);
    });

    $wizard.find('#dle-wiz-next').on('click', () => {
        if (!validateCurrentPage()) return;
        markStepComplete(currentPage);
        let target = currentPage + 1;
        if (target === 5 && searchMode === 'keywords') target = 6;
        if (target === 6 && searchMode === 'keywords') target = 7;
        if (target <= TOTAL_PAGES) goToPage(target);
    });

    $wizard.find('#dle-wiz-finish').on('click', async () => {
        try {
            await applyWizardSettings();
        } catch (err) {
            console.error('[DLE] Wizard finish error:', err);
            toastr.warning('Setup saved but index build failed — it will retry on first generation.', 'DeepLore Enhanced');
        }
        // Close popup regardless — settings are already saved before buildIndex().
        // Wizard popup has no okButton/cancelButton so .popup_ok doesn't exist;
        // walk up to the dialog and ask Popup util to close it.
        const $popup = $wizard.closest('dialog.popup, .popup');
        const popupEl = $popup.get(0);
        const popupInstance = popupEl && Popup && typeof Popup.util?.popups !== 'undefined'
            ? Popup.util.popups.find(p => p.dlg === popupEl)
            : null;
        if (popupInstance && typeof popupInstance.completeCancelled === 'function') {
            popupInstance.completeCancelled();
        } else if (popupEl && typeof popupEl.close === 'function') {
            popupEl.close();
        } else {
            $popup.find('.popup_cross, .popup_close').trigger('click');
        }
    });
}

function goToPage(page) {
    currentPage = page;

    $wizard.find('.dle-wizard-page').removeClass('active');
    $wizard.find(`[data-wizard-page="${page}"]`).addClass('active');

    $wizard.find('.dle-wizard-step').removeClass('active').attr('aria-selected', 'false').removeAttr('aria-current');
    $wizard.find(`.dle-wizard-step[data-step="${page}"]`).addClass('active').attr('aria-selected', 'true').attr('aria-current', 'step');

    updateNavButtons();

    if (page === 5) loadAiProfiles();
    if (page === 6) wireLibrarianToggle();
    if (page === 7) wireVaultStructurePage();
    if (page === 8) loadImportLorebooks();
    if (page === 9) buildSummary();
}

function updateNavButtons() {
    const $prev = $wizard.find('#dle-wiz-prev');
    const $next = $wizard.find('#dle-wiz-next');
    const $finish = $wizard.find('#dle-wiz-finish');
    const $reason = $wizard.find('.dle-wiz-next-reason');

    $prev.toggle(currentPage > 1);

    if (currentPage === TOTAL_PAGES) {
        $next.hide();
        $finish.show();
        $reason.hide();
    } else {
        $next.show();
        $finish.hide();
        const valid = isPageValid(currentPage);
        $next.prop('disabled', !valid);
        // Surface why Next is disabled so the user knows what to fix without hunting.
        if (!valid && currentPage === 2 && !connectionVerified) {
            if (!$reason.length) {
                $next.before('<span class="dle-wiz-next-reason dle-text-xs dle-muted" style="margin-right:8px;">Test connection to continue</span>');
            } else {
                $reason.text('Test connection to continue').show();
            }
        } else {
            $reason.hide();
        }
    }
}

function validateCurrentPage() {
    if (!isPageValid(currentPage)) {
        if (currentPage === 2 && !connectionVerified) {
            $wizard.find('#dle-wiz-test-conn').addClass('dle-wizard-pulse');
            setTimeout(() => $wizard.find('#dle-wiz-test-conn').removeClass('dle-wizard-pulse'), 600);
        }
        return false;
    }
    return true;
}

function isPageValid(page) {
    switch (page) {
        case 2: return connectionVerified;
        default: return true;
    }
}

function wireStepIndicator() {
    $wizard.find('.dle-wizard-step').on('click', function () {
        const step = parseInt($(this).data('step'));
        // Only completed or current steps are navigable.
        if ($(this).hasClass('completed') || step === currentPage) {
            goToPage(step);
        }
    });
}

function markStepComplete(step) {
    const $step = $wizard.find(`.dle-wizard-step[data-step="${step}"]`);
    $step.addClass('completed');
    $step.find('.dle-wizard-step-dot').html('<i class="fa-solid fa-check"></i>');
}

// ── Page 2: Connection Test ──

function wireConnectionTest() {
    $wizard.find('#dle-wiz-test-conn').on('click', async () => {
        const $btn = $wizard.find('#dle-wiz-test-conn');
        const $result = $wizard.find('#dle-wiz-conn-result');

        const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
        const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
        const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
        const useHttps = $wizard.find('#dle-wiz-https').is(':checked');

        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
        $result.hide();

        try {
            const result = await testConnection(host, port, apiKey, useHttps);
            if (result.certError) {
                const $trustLink = $wizard.find('#dle-wiz-trust-cert');
                $trustLink.attr('href', result.certUrl).show().off('click').on('click', (e) => {
                    e.preventDefault();
                    window.open(result.certUrl, '_blank');
                });
            }
            if (result.ok) {
                connectionVerified = true;
                $wizard.find('#dle-wiz-trust-cert').hide();
                $result
                    .html('<i class="fa-solid fa-circle-check"></i> Connected to Obsidian vault successfully')
                    .removeClass('dle-wizard-result-error')
                    .addClass('dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> Connected').addClass('dle-wizard-btn-verified');
            } else {
                connectionVerified = false;
                if (result.diagnosis) {
                    const guidanceHtml = `<div class="dle-popup">${buildConnectionGuidanceHtml(result)}</div>`;
                    callGenericPopup(guidanceHtml, POPUP_TYPE.TEXT, 'Connection Help', {
                        wide: true, allowVerticalScrolling: true, okButton: 'Got it',
                    });
                }
                $wizard.find('#dle-wiz-trust-cert').hide();
                // V-M4 (2026-05-22): testConnection may return `{ ok: false, diagnosis }`
                // with no `error` set. escapeHtml(undefined) renders the literal string
                // "undefined" — fall back to a diagnosis-derived string so the user
                // doesn't see "Error: undefined" in the UI.
                const errorText = result.error
                    || (result.diagnosis ? `Diagnosis: ${result.diagnosis}` : 'Unknown error');
                $result
                    .html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(errorText)}`)
                    .removeClass('dle-wizard-result-success')
                    .addClass('dle-wizard-result-error')
                    .show();
                $btn.html('<i class="fa-solid fa-plug"></i> Test Connection');
            }
        } catch (err) {
            connectionVerified = false;
            $result
                .html(`<i class="fa-solid fa-circle-xmark"></i> Error: ${escapeHtml(err.message)}`)
                .removeClass('dle-wizard-result-success')
                .addClass('dle-wizard-result-error')
                .show();
            $btn.html('<i class="fa-solid fa-plug"></i> Test Connection');
        }

        $btn.prop('disabled', false);
        updateNavButtons();
    });

    // Auto-switch port on HTTPS toggle — user can override.
    $wizard.find('#dle-wiz-https').on('change', function () {
        const currentPort = parseInt($wizard.find('#dle-wiz-port').val());
        if (this.checked && currentPort === 27123) {
            $wizard.find('#dle-wiz-port').val(27124);
        } else if (!this.checked && currentPort === 27124) {
            $wizard.find('#dle-wiz-port').val(27123);
        }
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> Test Connection')
            .prop('disabled', false);
    });

    $wizard.find('#dle-wiz-host, #dle-wiz-port, #dle-wiz-api-key').on('input', () => {
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> Test Connection')
            .removeClass('dle-wizard-btn-verified');
        $wizard.find('#dle-wiz-conn-result').hide();
        updateNavButtons();
    });
}

// ── Page 2: Demo Vault ──

/** Path is shown relative to ST root since the install dir varies per user. */
function getDemoVaultPath() {
    return 'public/scripts/extensions/third-party/sillytavern-DeepLore-Enhanced/test-vault';
}

function wireDemoVault() {
    $wizard.find('#dle-wiz-demo-toggle').on('click', () => {
        const $instructions = $wizard.find('#dle-wiz-demo-instructions');
        const $btn = $wizard.find('#dle-wiz-demo-toggle');
        const isHidden = !$instructions.is(':visible');
        $instructions.slideToggle(200);
        $btn.html(isHidden
            ? '<i class="fa-solid fa-chevron-up"></i> Hide instructions'
            : '<i class="fa-solid fa-folder-open"></i> Show me how');
        if (isHidden) {
            $wizard.find('#dle-wiz-demo-path').text(getDemoVaultPath());
        }
    });

    $wizard.find('#dle-wiz-demo-copy').on('click', () => {
        const path = $wizard.find('#dle-wiz-demo-path').text();
        navigator.clipboard.writeText(path).then(
            () => toastr.info('Path copied to clipboard', 'DeepLore Enhanced'),
            () => toastr.warning('Failed to copy — select and copy manually', 'DeepLore Enhanced'),
        );
    });

    $wizard.find('#dle-wiz-demo-autofill').on('click', () => {
        $wizard.find('#dle-wiz-vault-name').val('Duskfrost Demo');
        $wizard.find('#dle-wiz-host').val('127.0.0.1');
        $wizard.find('#dle-wiz-port').val('27123');
        $wizard.find('#dle-wiz-https').prop('checked', false);
        connectionVerified = false;
        $wizard.find('#dle-wiz-test-conn')
            .html('<i class="fa-solid fa-plug"></i> Test Connection')
            .removeClass('dle-wizard-btn-verified');
        $wizard.find('#dle-wiz-conn-result').hide();
        updateNavButtons();
        // API key is the only field the user must still enter.
        $wizard.find('#dle-wiz-api-key').val('').focus();
        toastr.info('Connection fields filled — enter your Obsidian API key and click Test', 'DeepLore Enhanced');
    });
}

function wireSearchMode() {
    $wizard.find('input[name="dle-wiz-search-mode"]').on('change', function () {
        searchMode = $(this).val();
    });
}

function wirePresets() {
    $wizard.find('.dle-wizard-preset').on('click', function () {
        const preset = $(this).data('preset');
        const values = PRESETS[preset];
        if (!values) return;

        $wizard.find('.dle-wizard-preset').removeClass('active');
        $(this).addClass('active');

        $wizard.find('#dle-wiz-scan-depth').val(values.scanDepth);
        $wizard.find('#dle-wiz-max-entries').val(values.maxEntries);
        $wizard.find('#dle-wiz-budget').val(values.budget);

        const label = preset.charAt(0).toUpperCase() + preset.slice(1);
        $wizard.find('#dle-wiz-preset-badge')
            .html(`<i class="fa-solid fa-check"></i> Configured for ${label} vault`)
            .addClass('dle-wizard-badge-visible');

        // Presets always override unlimited toggles.
        $wizard.find('#dle-wiz-unlimited-entries').prop('checked', false);
        $wizard.find('#dle-wiz-unlimited-budget').prop('checked', false);
        $wizard.find('#dle-wiz-max-entries, #dle-wiz-budget').prop('disabled', false);
    });

    $wizard.find('#dle-wiz-unlimited-entries').on('change', function () {
        $wizard.find('#dle-wiz-max-entries').prop('disabled', this.checked);
    });
    $wizard.find('#dle-wiz-unlimited-budget').on('change', function () {
        $wizard.find('#dle-wiz-budget').prop('disabled', this.checked);
    });
}

function wireAiSetup() {
    $wizard.find('input[name="dle-wiz-ai-mode"]').on('change', function () {
        const mode = $(this).val();
        $wizard.find('#dle-wiz-ai-profile-fields').toggle(mode === 'profile');
        $wizard.find('#dle-wiz-ai-proxy-fields').toggle(mode === 'proxy');
    });

    $wizard.find('#dle-wiz-test-ai').on('click', async () => {
        const $btn = $wizard.find('#dle-wiz-test-ai');
        const $result = $wizard.find('#dle-wiz-ai-result');
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Testing...');
        $result.hide();

        try {
            const mode = $wizard.find('input[name="dle-wiz-ai-mode"]:checked').val();
            let ok = false;
            let detail = '';

            if (mode === 'profile') {
                const profileId = $wizard.find('#dle-wiz-ai-profile').val();
                if (!profileId) throw new Error('Select a connection profile first');
                const { ConnectionManagerRequestService } = await import('../../../../shared.js')
                    .catch(() => ({ ConnectionManagerRequestService: null }));
                if (!ConnectionManagerRequestService) throw new Error('Connection Manager not available');
                const profile = ConnectionManagerRequestService.getProfile(profileId);
                if (!profile) throw new Error('Selected profile not found');
                ok = true;
                detail = `Profile: ${$wizard.find('#dle-wiz-ai-profile option:selected').text()}`;
            } else {
                const proxyUrl = $wizard.find('#dle-wiz-ai-proxy-url').val().trim();
                const model = $wizard.find('#dle-wiz-ai-model').val().trim();
                if (!proxyUrl) throw new Error('Enter a proxy URL first');
                if (!model) throw new Error('Enter a model name first (e.g. claude-haiku-4-5-20251001)');
                const { testProxyConnection } = await import('../ai/proxy-api.js');
                const result = await testProxyConnection(proxyUrl, model);
                ok = result.ok;
                detail = result.ok ? `Model: ${result.model || model}` : result.error;
            }

            if (ok) {
                $result
                    .html(`<i class="fa-solid fa-circle-check"></i> AI connection working — ${detail}`)
                    .removeClass('dle-wizard-result-error')
                    .addClass('dle-wizard-result-success')
                    .show();
                $btn.html('<i class="fa-solid fa-circle-check"></i> Connected').addClass('dle-wizard-btn-verified');
            } else {
                $result
                    .html(`<i class="fa-solid fa-circle-xmark"></i> ${detail}`)
                    .removeClass('dle-wizard-result-success')
                    .addClass('dle-wizard-result-error')
                    .show();
                $btn.html('<i class="fa-solid fa-brain"></i> Test AI Connection');
            }
        } catch (err) {
            $result
                .html(`<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(err.message)}`)
                .removeClass('dle-wizard-result-success')
                .addClass('dle-wizard-result-error')
                .show();
            $btn.html('<i class="fa-solid fa-brain"></i> Test AI Connection');
        }

        $btn.prop('disabled', false);
    });
}

async function loadAiProfiles() {
    const $select = $wizard.find('#dle-wiz-ai-profile');
    try {
        const { ConnectionManagerRequestService } = await import('../../../../shared.js')
            .catch(() => ({ ConnectionManagerRequestService: null }));
        if (!ConnectionManagerRequestService) {
            $select.html('<option value="">Connection Manager not available</option>');
            return;
        }
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        if (!profiles || profiles.length === 0) {
            $select.html('<option value="">No profiles configured</option>');
            return;
        }
        const s = getSettings();
        let options = '<option value="">— Select a profile —</option>';
        for (const p of profiles) {
            const selected = p.id === s.aiSearchProfileId ? ' selected' : '';
            const label = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            options += `<option value="${p.id}"${selected}>${esc(label)}</option>`;
        }
        $select.html(options);
    } catch (err) {
        // BUG-112: log so dropdown load failures are diagnosable.
        console.debug('[DLE] Wizard profile dropdown load failed:', err?.message);
        $select.html('<option value="">Failed to load profiles</option>');
    }
}

let librarianToggleWired = false;

function wireLibrarianToggle() {
    if (librarianToggleWired) return;
    librarianToggleWired = true;

    const $master = $wizard.find('#dle-wiz-librarian-enabled');
    const $sub = $wizard.find('#dle-wiz-librarian-sub');

    $master.on('change', function () {
        $sub.toggle(this.checked);
    });

    $sub.toggle($master.is(':checked'));
}

function wireVaultStructure() {
    // Handled on page entry via runVaultStructureCreation
}

// BUG-340: wizardState reset per open via resetWizardState() — prior-session state
// must not leak across reopens since we hang it off globalThis for debugging.
let wizardState = (globalThis.__dleWizardState = {});
function resetWizardState() {
    wizardState = (globalThis.__dleWizardState = {});
}

function wireVaultStructurePage() {
    // BUG-137: gate on actual connectionVerified flag — the (host && apiKey)
    // heuristic let users proceed without testing.
    const connVerified = connectionVerified;
    if (!connVerified) {
        $wizard.find('#dle-wiz-vault-conn-warning').show();
        $wizard.find('#dle-wiz-vault-helpers-wrap').hide();
        $wizard.find('#dle-wiz-vault-back-conn').off('click.dlewiz').on('click.dlewiz', () => goToPage(2));
        return;
    }
    $wizard.find('#dle-wiz-vault-conn-warning').hide();
    $wizard.find('#dle-wiz-vault-helpers-wrap').show();

    const s = getSettings();

    const $fieldsPath = $wizard.find('#dle-wiz-fields-path');
    if (!$fieldsPath.val()) $fieldsPath.val(s.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml');
    const $sessPath = $wizard.find('#dle-wiz-sessions-path');
    if (!$sessPath.val()) $sessPath.val(s.scribeFolder || 'Sessions');

    $fieldsPath.off('blur.dlewiz').on('blur.dlewiz', () => {
        const v = $fieldsPath.val().trim();
        if (v) { getSettings().fieldDefinitionsPath = v; saveSettingsDebounced(); }
    });
    $sessPath.off('blur.dlewiz').on('blur.dlewiz', () => {
        const v = $sessPath.val().trim();
        if (v) { getSettings().scribeFolder = v; saveSettingsDebounced(); }
    });

    try {
        const yaml = serializeFieldDefinitions(DEFAULT_FIELD_DEFINITIONS);
        $wizard.find('#dle-wiz-fields-yaml').text(yaml);
    } catch { /* non-fatal */ }

    // Collapse Sessions card when Scribe disabled upstream.
    const $optDetails = $wizard.find('#dle-wiz-optional-helpers');
    if (!s.scribeEnabled) {
        $optDetails.prop('open', false);
        $wizard.find('#dle-wiz-create-sessions').prop('checked', false);
    } else {
        $optDetails.prop('open', true);
        $wizard.find('#dle-wiz-create-sessions').prop('checked', true);
    }

    // Wired idempotently — cheap rewires happen each time the page is shown.
    const $btn = $wizard.find('#dle-wiz-create-files');
    if (!$btn.data('wired')) {
        $btn.data('wired', true);
        $btn.on('click', async () => {
            $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Creating...');
            await runVaultStructureCreation();
            $btn.html('<i class="fa-solid fa-circle-check"></i> Done').addClass('dle-wizard-btn-verified').prop('disabled', false);
        });
    }

    const $skip = $wizard.find('#dle-wiz-vault-skip');
    if (!$skip.data('wired')) {
        $skip.data('wired', true);
        $skip.on('click', () => {
            wizardState.vaultHelpers = 'skipped';
            goToPage(8);
        });
    }
}

async function runVaultStructureCreation() {
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
    const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
    const useHttps = $wizard.find('#dle-wiz-https').is(':checked');

    const outcome = { fields: 'skipped', sessions: 'skipped' };

    const createFields = $wizard.find('#dle-wiz-create-fields').is(':checked');
    if (createFields) {
        try {
            const yaml = serializeFieldDefinitions(DEFAULT_FIELD_DEFINITIONS);
            const path = ($wizard.find('#dle-wiz-fields-path').val().trim()) || 'DeepLore/field-definitions.yaml';
            getSettings().fieldDefinitionsPath = path;
            saveSettingsDebounced();
            await writeFieldDefinitions(host, port, apiKey, path, yaml, useHttps);
            outcome.fields = 'created';
        } catch (err) {
            outcome.fields = 'failed';
            outcome.fieldsError = err.message;
        }
    }

    const createSessions = $wizard.find('#dle-wiz-create-sessions').is(':checked');
    if (createSessions) {
        try {
            const folder = ($wizard.find('#dle-wiz-sessions-path').val().trim()) || 'Sessions';
            getSettings().scribeFolder = folder;
            saveSettingsDebounced();
            await writeNote(host, port, apiKey, `${folder}/.gitkeep`, '# Session Scribe\nThis folder is used by DeepLore Enhanced Session Scribe.\n', useHttps);
            outcome.sessions = 'created';
        } catch (err) {
            outcome.sessions = 'failed';
            outcome.sessionsError = err.message;
        }
    }

    const $result = $wizard.find('#dle-wiz-vault-result');
    const lines = [];
    const labels = { created: 'Created', skipped: 'Skipped', failed: 'Failed', exists: 'Already present' };
    lines.push(`<div><strong>Field definitions:</strong> ${labels[outcome.fields]}${outcome.fieldsError ? ` &mdash; ${escapeHtml(outcome.fieldsError)}` : ''}</div>`);
    lines.push(`<div><strong>Sessions folder:</strong> ${labels[outcome.sessions]}${outcome.sessionsError ? ` &mdash; ${escapeHtml(outcome.sessionsError)}` : ''}</div>`);
    const anyFailed = outcome.fields === 'failed' || outcome.sessions === 'failed';
    const anyDone = outcome.fields === 'created' || outcome.sessions === 'created';
    $result
        .html(lines.join(''))
        .removeClass('dle-wizard-result-success dle-wizard-result-error')
        .addClass(anyFailed ? 'dle-wizard-result-error' : 'dle-wizard-result-success')
        .show();

    wizardState.vaultHelpers = anyFailed ? 'partial' : (anyDone ? 'done' : 'skipped');
    // BUG-139: per-feature outcomes so summary doesn't conflate them.
    wizardState.fieldsOutcome = outcome.fields;
    wizardState.sessionsOutcome = outcome.sessions;
}

let importJsonData = '';

function wireImport() {
    $wizard.find('input[name="dle-wiz-import-method"]').on('change', function () {
        const method = $(this).val();
        $wizard.find('#dle-wiz-import-lb-fields').toggle(method === 'lorebook');
        $wizard.find('#dle-wiz-import-file-fields').toggle(method === 'file');
        $wizard.find('#dle-wiz-import-paste-fields').toggle(method === 'paste');
        $wizard.find('#dle-wiz-import-folder-row').toggle(method !== 'skip');
        $wizard.find('#dle-wiz-import-action').toggle(method !== 'skip');
        $wizard.find('#dle-wiz-import-result').hide();
        importJsonData = '';
    });

    $wizard.find('#dle-wiz-import-browse').on('click', () => {
        $wizard.find('#dle-wiz-import-file')[0]?.click();
    });
    $wizard.find('#dle-wiz-import-file').on('change', function () {
        const file = this.files?.[0];
        if (!file) return;
        $wizard.find('#dle-wiz-import-file-name').text(file.name);
        const reader = new FileReader();
        reader.onload = () => { importJsonData = /** @type {string} */ (reader.result); };
        reader.onerror = () => { toastr.error('Failed to read file.', 'DeepLore Enhanced'); };
        reader.readAsText(file);
    });

    $wizard.find('#dle-wiz-import-lorebook').on('change', async function () {
        const name = $(this).val();
        if (!name) { importJsonData = ''; return; }
        try {
            const { loadWorldInfo } = await import('../../../../../world-info.js');
            const data = await loadWorldInfo(name);
            if (!data) {
                toastr.error(`Failed to load lorebook "${name}".`, 'DeepLore Enhanced');
                return;
            }
            importJsonData = JSON.stringify(data, null, 2);
        } catch (err) {
            console.error('[DLE] Wizard loadWorldInfo error:', err);
            toastr.error('Couldn\'t load that lorebook. Try a different one or paste the JSON directly.', 'DeepLore Enhanced');
        }
    });

    $wizard.find('#dle-wiz-import-btn').on('click', async function () {
        const $btn = $(this);
        const $result = $wizard.find('#dle-wiz-import-result');
        const method = $wizard.find('input[name="dle-wiz-import-method"]:checked').val();

        let jsonText = '';
        if (method === 'paste') {
            jsonText = $wizard.find('#dle-wiz-import-json').val()?.trim() || '';
        } else {
            jsonText = importJsonData;
        }

        if (!jsonText) {
            toastr.warning('No data to import. Select a lorebook, upload a file, or paste JSON first.', 'DeepLore Enhanced');
            return;
        }

        let entries, source;
        try {
            ({ entries, source } = parseWorldInfoJson(jsonText));
        } catch (err) {
            $result.html(`<i class="fa-solid fa-circle-xmark"></i> ${esc(err.message)}`)
                .removeClass('dle-wizard-result-success').addClass('dle-wizard-result-error').show();
            return;
        }

        if (!entries || entries.length === 0) {
            $result.html('<i class="fa-solid fa-circle-info"></i> No entries found in the provided data.')
                .removeClass('dle-wizard-result-success dle-wizard-result-error').show();
            return;
        }

        const folder = $wizard.find('#dle-wiz-import-folder').val()?.trim() || '';

        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Importing...');
        $result.html(`<i class="fa-solid fa-spinner fa-spin"></i> Importing 0/${entries.length}...`)
            .removeClass('dle-wizard-result-success dle-wizard-result-error').show();

        try {
            const result = await importEntries(entries, folder, (done, total) => {
                $result.html(`<i class="fa-solid fa-spinner fa-spin"></i> Importing ${done}/${total}...`);
            });

            importResult = result;
            const renamedNote = result.renamed > 0 ? ` (${result.renamed} renamed to avoid overwrite)` : '';
            if (result.failed > 0) {
                $result.html(`<i class="fa-solid fa-triangle-exclamation"></i> Imported ${result.imported}/${entries.length} from "${esc(source)}"${renamedNote}. ${result.failed} failed.`)
                    .addClass('dle-wizard-result-error').removeClass('dle-wizard-result-success').show();
            } else {
                $result.html(`<i class="fa-solid fa-circle-check"></i> Imported ${result.imported} entries from "${esc(source)}"${renamedNote}`)
                    .addClass('dle-wizard-result-success').removeClass('dle-wizard-result-error').show();
            }
            $btn.html('<i class="fa-solid fa-circle-check"></i> Import Complete');
        } catch (err) {
            $result.html(`<i class="fa-solid fa-circle-xmark"></i> Import error: ${esc(err.message)}`)
                .addClass('dle-wizard-result-error').removeClass('dle-wizard-result-success').show();
            $btn.html('<i class="fa-solid fa-file-import"></i> Import Entries').prop('disabled', false);
        }
    });
}

async function loadImportLorebooks() {
    const $select = $wizard.find('#dle-wiz-import-lorebook');
    try {
        const { world_names } = await import('../../../../../world-info.js');
        if (!Array.isArray(world_names) || world_names.length === 0) {
            $select.html('<option value="">No lorebooks available</option>');
            return;
        }
        let options = '<option value="">— Select a lorebook —</option>';
        for (const name of world_names) {
            options += `<option value="${esc(name)}">${esc(name)}</option>`;
        }
        $select.html(options);
    } catch (err) {
        // BUG-112: log so dropdown load failures are diagnosable.
        console.debug('[DLE] Wizard lorebook dropdown load failed:', err?.message);
        $select.html('<option value="">Failed to load lorebooks</option>');
    }
}

function buildSummary() {
    const $summary = $wizard.find('#dle-wiz-summary');
    const vaultName = $wizard.find('#dle-wiz-vault-name').val().trim() || 'Primary';
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = $wizard.find('#dle-wiz-port').val() || '27123';

    const modeLabels = { keywords: 'Keywords Only', 'two-stage': 'Two-Stage (keywords + AI)', 'ai-only': 'AI Only' };
    const modeLabel = modeLabels[searchMode] || searchMode;

    const maxEntries = $wizard.find('#dle-wiz-max-entries').val();
    const budget = $wizard.find('#dle-wiz-budget').val();

    const scanDepth = parseInt($wizard.find('#dle-wiz-scan-depth').val());
    let presetLabel = 'Custom';
    for (const [name, vals] of Object.entries(PRESETS)) {
        if (vals.scanDepth === scanDepth && vals.maxEntries === parseInt(maxEntries) && vals.budget === parseInt(budget)) {
            presetLabel = name.charAt(0).toUpperCase() + name.slice(1);
            break;
        }
    }

    // BUG-139: per-feature outcomes, not the conflated compound state.
    const fieldsCreated = wizardState.fieldsOutcome === 'created' || wizardState.fieldsOutcome === 'exists';
    const sessionsCreated = wizardState.sessionsOutcome === 'created' || wizardState.sessionsOutcome === 'exists';

    const items = [
        `<i class="fa-solid fa-circle-check"></i> Vault connected: <strong>${esc(vaultName)}</strong> on ${esc(host)}:${esc(port)}`,
        `<i class="fa-solid fa-circle-check"></i> Search mode: <strong>${esc(modeLabel)}</strong>`,
        `<i class="fa-solid fa-circle-check"></i> Matching: <strong>${esc(presetLabel)} preset</strong> (${maxEntries} entries, ${budget} token budget)`,
    ];

    if (fieldsCreated) items.push('<i class="fa-solid fa-circle-check"></i> Field definitions created');
    if (sessionsCreated) items.push('<i class="fa-solid fa-circle-check"></i> Sessions folder created');
    if (importResult && importResult.imported > 0) {
        items.push(`<i class="fa-solid fa-circle-check"></i> Imported <strong>${importResult.imported}</strong> entries${importResult.failed > 0 ? ` (${importResult.failed} failed)` : ''}`);
    }

    const vaultNameLower = vaultName.toLowerCase();
    if (vaultNameLower.includes('duskfrost') || vaultNameLower.includes('demo')) {
        items.push('<i class="fa-solid fa-flask"></i> <strong>Demo vault detected!</strong> Try mentioning "Duskfrost" or "Bellsummit" in chat to see lore injection.');
        items.push('<i class="fa-solid fa-lightbulb"></i> Run <code>/dle-health</code> to see the health check (edge-case entries will flag intentional warnings)');
        items.push('<i class="fa-solid fa-lightbulb"></i> Run <code>/dle-graph</code> to see the full relationship graph');
    }

    $summary.html(items.map((item, i) => `<div class="dle-wizard-summary-item" style="animation-delay: ${i * 120}ms">${item}</div>`).join(''));
}

function wireDoneActions() {
    $wizard.on('click', '.dle-wizard-done-btn', function () {
        const action = $(this).data('action');
        const popup = $wizard.closest('.popup');
        if (popup.length) popup.find('.popup_ok, .popup_close').trigger('click');

        setTimeout(() => {
            switch (action) {
                case 'health': executeCommand('/dle-health'); break;
                case 'graph': executeCommand('/dle-graph'); break;
                case 'browse': executeCommand('/dle-browse'); break;
                case 'settings':
                    import('./settings-ui.js').then(m => m.openSettingsPopup?.()).catch(() => {});
                    break;
                case 'meet-emma':
                    import('../librarian/librarian-review.js')
                        .then(m => m.openLibrarianPopup(null, { mode: 'guide-firstrun' }))
                        .catch(err => console.warn('[DLE] Meet Emma open failed:', err));
                    break;
            }
        }, 300);
    });
}

async function applyWizardSettings() {
    const settings = getSettings();

    const vaultName = $wizard.find('#dle-wiz-vault-name').val().trim() || 'Primary';
    const host = $wizard.find('#dle-wiz-host').val().trim() || '127.0.0.1';
    const port = parseInt($wizard.find('#dle-wiz-port').val()) || 27123;
    const apiKey = $wizard.find('#dle-wiz-api-key').val().trim();
    const useHttps = $wizard.find('#dle-wiz-https').is(':checked');

    settings.enabled = true;
    // BUG-106: update primary vault in place — overwriting the array would
    // silently destroy existing multi-vault configurations.
    const newVault = { name: vaultName, host, port, apiKey, https: useHttps, enabled: true };
    if (!settings.vaults || settings.vaults.length === 0) {
        settings.vaults = [newVault];
    } else {
        Object.assign(settings.vaults[0], newVault);
    }

    settings.lorebookTag = $wizard.find('#dle-wiz-lorebook-tag').val().trim() || 'lorebook';
    settings.constantTag = $wizard.find('#dle-wiz-constant-tag').val().trim() || 'lorebook-always';
    settings.seedTag = $wizard.find('#dle-wiz-seed-tag').val().trim() || 'lorebook-seed';
    settings.bootstrapTag = $wizard.find('#dle-wiz-bootstrap-tag').val().trim() || 'lorebook-bootstrap';

    settings.aiSearchEnabled = searchMode !== 'keywords';
    if (searchMode !== 'keywords') settings.aiSearchMode = searchMode;

    settings.scanDepth = parseInt($wizard.find('#dle-wiz-scan-depth').val()) || 6;
    settings.maxEntries = parseInt($wizard.find('#dle-wiz-max-entries').val()) || 15;
    settings.maxTokensBudget = parseInt($wizard.find('#dle-wiz-budget').val()) || 3072;
    settings.unlimitedEntries = $wizard.find('#dle-wiz-unlimited-entries').is(':checked');
    settings.unlimitedBudget = $wizard.find('#dle-wiz-unlimited-budget').is(':checked');
    settings.fuzzySearchEnabled = $wizard.find('#dle-wiz-fuzzy').is(':checked');

    if (searchMode !== 'keywords') {
        const aiMode = $wizard.find('input[name="dle-wiz-ai-mode"]:checked').val();
        settings.aiSearchConnectionMode = aiMode || 'profile';
        if (aiMode === 'profile') {
            settings.aiSearchProfileId = $wizard.find('#dle-wiz-ai-profile').val() || '';
        } else {
            settings.aiSearchProxyUrl = $wizard.find('#dle-wiz-ai-proxy-url').val().trim() || 'http://127.0.0.1:42069';
            settings.aiSearchModel = $wizard.find('#dle-wiz-ai-model').val().trim() || '';
        }
    }

    settings.librarianEnabled = $wizard.find('#dle-wiz-librarian-enabled').is(':checked');
    settings.librarianSearchEnabled = $wizard.find('#dle-wiz-librarian-search').is(':checked');
    settings.librarianFlagEnabled = $wizard.find('#dle-wiz-librarian-flag').is(':checked');

    // BUG-125: localStorage sentinel guards against saveSettingsDebounced
    // crashing before flush — without it, wizard re-triggers on next load.
    settings._wizardCompleted = true;
    try { localStorage.setItem('dle-wizard-completed', '1'); } catch { /* noop */ }

    invalidateSettingsCache();
    saveSettingsDebounced();

    setIndexTimestamp(0);
    await buildIndex();
}

function executeCommand(cmd) {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(cmd).catch(err => console.error('[DLE] Wizard command error:', cmd, err));
    }
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}
