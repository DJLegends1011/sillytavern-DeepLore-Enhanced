/** DeepLore — Vault Scan Popup. Runs scanner, user picks discovered vault. */
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { scanVaults } from '../vault/scanner.js';
import { abortWith } from '../diagnostics/interceptors.js';
import { tr, trf, trPlural } from '../i18n/i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * "Scanned N / M probes — K vault(s) found" — plural axis is the found count.
 * ${0}=found (plural pivot), ${1}=scanned, ${2}=total.
 */
function progressText(scanned, total, found) {
    return trPlural('dle_vaultscan_progress', found, scanned, total);
}

/**
 * @param {{host?: string, apiKey?: string, portCenter?: number, radius?: number}} opts
 * @returns {Promise<object|null>} selected vault, or null if cancelled
 */
export async function openVaultScanPopup(opts = {}) {
    const portLow = Math.max(1, (opts.portCenter || 27124) - (opts.radius || 25));
    const portHigh = (opts.portCenter || 27124) + (opts.radius || 25);
    const html = `
        <div class="dle-vault-scan-popup">
            <h3>${esc(tr('dle_vaultscan_heading', 'Scan for Obsidian Vaults'))}</h3>
            <p class="dle-vault-scan-sub">${esc(trf('dle_vaultscan_probing', portLow, portHigh, opts.host || '127.0.0.1'))}</p>
            <div class="dle-vault-scan-progress-wrap">
                <div class="dle-vault-scan-progress-bar"><div class="dle-vault-scan-progress-fill" id="dle-vsp-fill" style="width: 0%"></div></div>
                <div class="dle-vault-scan-progress-text" id="dle-vsp-text">${esc(tr('dle_vaultscan_starting', 'Starting…'))}</div>
            </div>
            <div class="dle-vault-scan-results" id="dle-vsp-results"></div>
            <details class="dle-vault-scan-help">
                <summary>${esc(tr('dle_vaultscan_cert_help_summary', 'How do I trust the Obsidian cert?'))}</summary>
                <div>
                    <p>${tr('dle_vaultscan_cert_help_intro', 'Install the Obsidian Local REST API certificate into your <strong>OS trust store</strong> — accepting the warning in your browser is not enough; <code>fetch()</code> from SillyTavern still fails.')}</p>
                    <ul>
                        <li>${tr('dle_vaultscan_cert_help_windows', '<strong>Windows:</strong> Double-click the cert → Install Certificate → Local Machine → Trusted Root Certification Authorities.')}</li>
                        <li>${tr('dle_vaultscan_cert_help_macos', '<strong>macOS:</strong> Keychain Access → System → drag cert in → set Trust to Always Trust.')}</li>
                        <li>${tr('dle_vaultscan_cert_help_linux', '<strong>Linux:</strong> <code>sudo cp obsidian-local-rest-api.crt /usr/local/share/ca-certificates/ &amp;&amp; sudo update-ca-certificates</code> (Firefox needs its own NSS DB import).')}</li>
                    </ul>
                </div>
            </details>
        </div>`;

    // BUG-103: scoped DOM refs via onOpen — fires once popup is in the DOM.
    let fill, text, results;
    let onOpenResolve;
    const onOpenReady = new Promise(r => { onOpenResolve = r; });

    const popupPromise = callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true, large: false, allowVerticalScrolling: true, okButton: tr('dle_common_cancel', 'Cancel'),
        onOpen: (popup) => {
            const root = popup?.dlg || document;
            fill = root.querySelector('#dle-vsp-fill') || root.querySelector('.dle-vault-scan-progress-fill');
            text = root.querySelector('#dle-vsp-text') || root.querySelector('.dle-vault-scan-progress-text');
            results = root.querySelector('#dle-vsp-results') || root.querySelector('.dle-vault-scan-results');
            onOpenResolve();
        },
    });

    await onOpenReady;

    let selected = null;

    function renderResults(vaults, certUntrusted, isFinal = false) {
        if (!results) return;
        if (vaults.length === 0 && certUntrusted.length === 0) {
            // In-progress: noncommittal. Final: actionable empty state.
            results.innerHTML = isFinal
                ? `<div class="dle-vault-scan-empty"><strong>${esc(tr('dle_vaultscan_empty_final_title', 'No vaults responded.'))}</strong><br><span class="dle-text-xs dle-muted">${esc(tr('dle_vaultscan_empty_final_help', 'Make sure Obsidian is running with the Local REST API plugin enabled. If using HTTPS with self-signed certs, see the cert-trust help below.'))}</span><br><button type="button" class="menu_button dle-vault-scan-retry-wider" style="margin-top:8px;">${esc(tr('dle_vaultscan_retry_wider_btn', 'Retry with wider port range'))}</button></div>`
                : `<div class="dle-vault-scan-empty">${esc(tr('dle_vaultscan_empty_inprogress', 'No responding vaults found yet.'))}</div>`;
            return;
        }
        const rows = [];
        for (const v of vaults) {
            const authBadge = v.authenticated
                ? `<span class="dle-vault-scan-badge dle-ok">${esc(tr('dle_vaultscan_badge_authenticated', 'authenticated'))}</span>`
                : `<span class="dle-vault-scan-badge dle-warn">${esc(tr('dle_vaultscan_badge_no_auth', 'no auth'))}</span>`;
            const schemeBadge = `<span class="dle-vault-scan-badge dle-scheme">${esc(v.scheme.toUpperCase())}</span>`;
            rows.push(`
                <div class="dle-vault-scan-row dle-vault-scan-row-clickable" role="button" tabindex="0" data-port="${v.port}" data-scheme="${esc(v.scheme)}">
                    <div class="dle-vault-scan-row-main">
                        <strong>${esc(v.vaultName)}</strong>
                        <span class="dle-vault-scan-port">${esc(v.host)}:${v.port}</span>
                        ${schemeBadge} ${authBadge}
                    </div>
                    <button class="menu_button dle-vault-scan-pick">${esc(tr('dle_vaultscan_use_this_btn', 'Use this'))}</button>
                </div>`);
        }
        for (const c of certUntrusted) {
            if (c.httpFallbackOk) continue; // already in vaults list
            rows.push(`
                <div class="dle-vault-scan-row dle-cert-warn">
                    <div class="dle-vault-scan-row-main">
                        <strong>${esc(trf('dle_vaultscan_port_label', c.port))}</strong>
                        <span class="dle-vault-scan-badge dle-warn">${esc(tr('dle_vaultscan_badge_cert_untrusted', 'cert untrusted'))}</span>
                        <span class="dle-vault-scan-port">${esc(c.note)}</span>
                    </div>
                </div>`);
        }
        results.innerHTML = rows.join('');

        const pickRow = (row) => {
            const port = parseInt(row?.dataset.port || '0', 10);
            const scheme = row?.dataset.scheme;
            selected = vaults.find(v => v.port === port && v.scheme === scheme) || null;
            const okBtn = document.querySelector('.popup_ok');
            if (okBtn) okBtn.click();
        };
        // Whole-row click selects (the inner button still works because click bubbles).
        results.querySelectorAll('.dle-vault-scan-row-clickable').forEach(row => {
            row.addEventListener('click', () => pickRow(row));
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRow(row); }
            });
        });

        // Retry-wider CTA on the empty-final state — re-runs scan with double radius.
        const retryBtn = results.querySelector('.dle-vault-scan-retry-wider');
        if (retryBtn) {
            retryBtn.addEventListener('click', async () => {
                retryBtn.disabled = true;
                retryBtn.textContent = tr('dle_vaultscan_scanning', 'Scanning…');
                try {
                    const widerOpts = { ...opts, radius: (opts.radius || 25) * 2 };
                    const res = await scanVaults({
                        host: widerOpts.host || '127.0.0.1',
                        apiKey: widerOpts.apiKey,
                        portCenter: widerOpts.portCenter || 27124,
                        radius: widerOpts.radius,
                        signal: scanAbort.signal,
                        onProgress: ({ scanned, total, found }) => {
                            if (fill) fill.style.width = `${Math.round((scanned / total) * 100)}%`;
                            if (text) text.textContent = progressText(scanned, total, found);
                        },
                    });
                    renderResults(res.vaults, res.certUntrusted, true);
                } catch (err) {
                    results.innerHTML = `<div class="dle-vault-scan-error">${esc(trf('dle_vaultscan_scan_failed', err.message || String(err)))}</div>`;
                }
            }, { once: true });
        }
    }

    // BUG-235: cancel aborts in-flight probes so `await scanPromise` below doesn't
    // block for the full scan duration on stragglers.
    const scanAbort = new AbortController();

    const scanPromise = scanVaults({
        host: opts.host || '127.0.0.1',
        apiKey: opts.apiKey,
        portCenter: opts.portCenter || 27124,
        radius: opts.radius || 25,
        signal: scanAbort.signal,
        onProgress: ({ scanned, total, found }) => {
            if (fill) fill.style.width = `${Math.round((scanned / total) * 100)}%`;
            if (text) text.textContent = progressText(scanned, total, found);
        },
    }).then(({ vaults, certUntrusted, scanDurationMs }) => {
        // ${0}=seconds (1dp), ${1}=count; plural splits on the count.
        if (text) text.textContent = trPlural('dle_vaultscan_done', vaults.length, (scanDurationMs / 1000).toFixed(1));
        renderResults(vaults, certUntrusted, true);
    }).catch(err => {
        if (results) results.innerHTML = `<div class="dle-vault-scan-error">${esc(trf('dle_vaultscan_scan_failed', err.message || String(err)))}</div>`;
    });

    await popupPromise;
    try { abortWith(scanAbort, 'vault_scan:popup_closed'); } catch { /* noop */ }
    await scanPromise;
    return selected;
}
