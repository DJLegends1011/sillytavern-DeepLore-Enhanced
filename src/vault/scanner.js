/**
 * DeepLore — Obsidian Vault Scanner.
 * Diagnostic scanner that probes a range of ports × HTTPS/HTTP for Local REST API instances.
 *
 * Bypasses obsidianFetch() and the circuit breaker entirely — calls fetch() directly so a tripped
 * breaker can't kill the diagnostic. Tries HTTPS first per port (Local REST API default), HTTP fallback.
 * Distinguishes "cert untrusted but HTTP works" so the UI can show that as actionable dual entry.
 */

import { abortWith } from '../diagnostics/interceptors.js';

const DEFAULT_OPTS = {
    portCenter: 27124,
    radius: 25,
    perRequestTimeout: 2000,
    concurrency: 12,
};

/**
 * @param {object} opts
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.apiKey]
 * @param {number} [opts.portCenter=27124]
 * @param {number} [opts.radius=25]
 * @param {number} [opts.perRequestTimeout=2000]
 * @param {number} [opts.concurrency=12]
 * @param {(progress: {scanned: number, total: number, found: number}) => void} [opts.onProgress]
 * @returns {Promise<{vaults: Array<object>, certUntrusted: Array<object>, scanDurationMs: number}>}
 */
export async function scanVaults(opts = {}) {
    const o = { ...DEFAULT_OPTS, ...opts };
    const host = o.host || '127.0.0.1';
    const startMs = Date.now();

    const ports = [];
    for (let p = Math.max(1, o.portCenter - o.radius); p <= o.portCenter + o.radius; p++) ports.push(p);

    const tasks = [];
    for (const port of ports) {
        tasks.push({ port, scheme: 'https' });
        tasks.push({ port, scheme: 'http' });
    }

    const total = tasks.length;
    let scanned = 0;
    const vaults = [];
    const certUntrusted = [];
    // Ports where HTTPS failed cert validation — used to mark HTTP successes "fallback".
    const httpsCertFailed = new Set();
    // Dedup "found" entries when both HTTPS and HTTP succeed on same port.
    const sawAuthByPort = new Map();

    // BUG-235: caller can pass opts.signal to bail probes when scan popup is dismissed.
    const externalSignal = o.signal;

    async function probe(task) {
        const { port, scheme } = task;
        const url = `${scheme}://${host}:${port}/`;
        const ctrl = new AbortController();
        const t = setTimeout(() => abortWith(ctrl, 'scanner:per_request_timeout'), o.perRequestTimeout);
        let onExternalAbort = null;
        if (externalSignal) {
            if (externalSignal.aborted) { clearTimeout(t); return null; }
            onExternalAbort = () => abortWith(ctrl, externalSignal.reason?.message || 'scanner:external_signal');
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
        try {
            const headers = {};
            if (o.apiKey) headers['Authorization'] = `Bearer ${o.apiKey}`;
            const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal, mode: 'cors' });
            if (!res.ok && res.status !== 401) {
                return null;
            }
            let info = {};
            try { info = await res.json(); } catch { /* not JSON */ }
            const authed = res.status !== 401 && (info.authenticated === true || res.ok);
            return {
                scheme, host, port,
                vaultName: info.name || info.vault || '(unknown)',
                version: info.versions?.self || info.versions?.api || null,
                authenticated: authed,
                status: res.status,
            };
        } catch (err) {
            // TypeError on HTTPS = self-signed-cert signature.
            if (scheme === 'https' && err && err.name === 'TypeError') {
                httpsCertFailed.add(port);
            }
            return null;
        } finally {
            clearTimeout(t);
            if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
            scanned++;
            if (o.onProgress) {
                try { o.onProgress({ scanned, total, found: vaults.length }); } catch {}
            }
        }
    }

    let idx = 0;
    async function worker() {
        while (idx < tasks.length) {
            if (externalSignal?.aborted) return;
            const i = idx++;
            const result = await probe(tasks[i]);
            if (result) {
                const prior = sawAuthByPort.get(result.port);
                if (!prior) {
                    sawAuthByPort.set(result.port, result);
                    vaults.push(result);
                } else if (result.authenticated && !prior.authenticated) {
                    // Replace prior unauthenticated record with the authenticated one.
                    const replaceIdx = vaults.indexOf(prior);
                    if (replaceIdx >= 0) vaults[replaceIdx] = result;
                    sawAuthByPort.set(result.port, result);
                }
            }
        }
    }
    const workers = [];
    const N = Math.max(1, Math.min(o.concurrency, tasks.length));
    for (let w = 0; w < N; w++) workers.push(worker());
    await Promise.all(workers);

    // Dual entries: HTTPS cert failed but HTTP responded on same port.
    for (const port of httpsCertFailed) {
        const httpHit = vaults.find(v => v.port === port && v.scheme === 'http');
        certUntrusted.push({
            port,
            httpFallbackOk: !!httpHit,
            note: httpHit
                ? 'HTTPS cert untrusted; HTTP responded on the same port'
                : 'HTTPS cert untrusted; install the cert into your OS trust store',
        });
    }

    return {
        vaults,
        certUntrusted,
        scanDurationMs: Date.now() - startMs,
    };
}
