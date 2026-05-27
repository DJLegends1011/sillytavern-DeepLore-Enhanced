/**
 * @deprecated v2.5 — Custom Proxy connection mode removed. Use Connection Profile instead.
 * This file kept for rollback safety. Dispatch is gated; callers throw via callAI / agentic-api.
 * Do NOT add new consumers. Do NOT call from new code paths.
 */
/**
 * DeepLore Enhanced — CORS-Bridged AI Proxy Module
 * Routes proxy-mode calls through SillyTavern's built-in CORS proxy (/proxy/:url).
 * Requires `enableCorsProxy: true` in ST's config.yaml.
 */
import { abortWith } from '../diagnostics/interceptors.js';

/**
 * SSRF validator: blocks cloud metadata, private/CGNAT/link-local ranges, and
 * octal/decimal IP shorthand. Allows 127.0.0.1 (local proxies) but blocks the
 * rest of 127.0.0.0/8. Throws on bad URL.
 */
export function validateProxyUrl(url) {
    // BUG-396: fail loudly here on empty/malformed/non-http(s) — callers assume
    // this either threw or OK'd the URL.
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('Proxy URL is empty');
    }
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`Proxy URL "${url}" is not a valid URL`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Proxy URL "${url}" must use http:// or https://`);
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blockedHosts = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];
    if (blockedHosts.includes(hostname)) {
        throw new Error(`Proxy URL "${hostname}" is blocked (potential SSRF target)`);
    }
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1'
        || hostname === '::ffff:127.0.0.1') {
        throw new Error(`Proxy URL "${hostname}" is blocked — use 127.0.0.1 for local proxies`);
    }
    const privatePatterns = [
        /^10\./,
        /^127\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
        /^169\.254\./,
        /^0\./,
        /^::ffff:/,
        /^fd[0-9a-f]{2}:/,
        /^fe80:/,
    ];
    if (privatePatterns.some(p => p.test(hostname)) && hostname !== '127.0.0.1') {
        throw new Error(`Proxy URL "${hostname}" points to a private/reserved network address`);
    }
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
        throw new Error(`Proxy URL "${hostname}" uses a numeric IP shorthand — use dotted notation`);
    }
    if (/(?:^|\.)0\d+(?:\.|$)/.test(hostname)) {
        throw new Error(`Proxy URL "${hostname}" uses octal IP notation — use standard dotted decimal`);
    }
}

/**
 * Call an Anthropic-compatible API through the ST CORS proxy.
 * @param {string} proxyUrl - Base URL. NOTE: literal "localhost" is rejected — use 127.0.0.1.
 * @param {{ stablePrefix?: string, dynamicSuffix?: string }} [cacheHints] - Anthropic prompt-caching blocks.
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callProxyViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout = 15000, cacheHints, externalSignal) {
    validateProxyUrl(proxyUrl);

    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    // Encode so Express doesn't collapse :// to :/.
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => abortWith(controller, 'proxy:timeout'), timeout);
    let onExternalAbort = null;

    if (externalSignal) {
        if (externalSignal.aborted) {
            const reason = externalSignal.reason?.message || 'proxy:external_pre_aborted';
            abortWith(controller, reason);
        } else {
            onExternalAbort = () => {
                const reason = externalSignal.reason?.message || 'proxy:external';
                abortWith(controller, reason);
            };
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    // With cache hints, split into blocks with cache_control for Anthropic prompt caching.
    let userContent;
    if (cacheHints && cacheHints.stablePrefix && cacheHints.dynamicSuffix) {
        userContent = [
            { type: 'text', text: cacheHints.stablePrefix, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: cacheHints.dynamicSuffix },
        ];
    } else {
        userContent = userMessage;
    }

    try {
        const response = await fetch(corsProxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
                messages: [{ role: 'user', content: userContent }],
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            // Helpful rewrite for the disabled-proxy 404.
            if (response.status === 404 && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern CORS proxy is not enabled. Set enableCorsProxy: true in config.yaml, or use a Connection Profile instead of Custom Proxy mode.');
            }
            // M5 / HIGH-LIB-2 (2026-05-22): scrub BEFORE truncating. If a token
            // starts in the last ~15 chars of the 150-char window, slicing first
            // cuts the token below the regex's {10,} minimum so it never matches
            // — and a partial token leaks into Error.message. Mirror the
            // scrub-then-slice pattern from agentic-api.js. See gotchas.md #56.
            const safeText = text
                .replace(/sk-proj-[a-zA-Z0-9_-]{10,}/g, 'sk-proj-***') // OpenAI (matched first; superset of sk-)
                .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')          // Anthropic
                .replace(/AIza[a-zA-Z0-9_-]{10,}/g, 'AIza***')         // Google
                .replace(/gsk_[a-zA-Z0-9_-]{10,}/g, 'gsk_***')         // Groq
                .replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***')
                .substring(0, 150);
            throw new Error(`Proxy returned HTTP ${response.status}: ${safeText}`);
        }

        // BUG-041: Separate network read from JSON parse so error messages are distinct.
        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse proxy response as JSON: ${e.message}`);
        }
        if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        }

        return {
            text: parsed.content?.[0]?.text || '',
            usage: parsed.usage || { input_tokens: 0, output_tokens: 0 },
        };
    } catch (err) {
        const controllerReason = controller.signal.reason?.message || null;
        const externalReason = externalSignal?.reason?.message || null;
        const abortReason = controllerReason || externalReason || null;
        if (err.name === 'AbortError') {
            if (externalSignal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                abortErr.abortReason = abortReason;
                throw abortErr;
            }
            const timeoutErr = new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`, { cause: err });
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            timeoutErr.abortReason = abortReason;
            throw timeoutErr;
        }
        if (abortReason) err.abortReason = abortReason;
        throw err;
    } finally {
        if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
        clearTimeout(timer);
    }
}

/**
 * Test connection to the AI proxy through the ST CORS proxy.
 * @param {string} proxyUrl
 * @param {string} model
 * @param {AbortSignal} [externalSignal] M6 (2026-05-22): optional cancel hook.
 *     Settings UI "Test Connection" button can now be aborted mid-flight (e.g.
 *     popup close, second click). Propagates through to the underlying fetch.
 *     Aborted-by-user errors are returned as `{ok: false, error: ..., aborted: true}`
 *     so callers can distinguish from real proxy failures.
 */
export async function testProxyConnection(proxyUrl, model, externalSignal) {
    try {
        const result = await callProxyViaCorsBridge(
            proxyUrl,
            model,
            'Reply OK.',
            'ping',
            8,
            15000,
            undefined,
            externalSignal,
        );
        return { ok: true, response: result.text.substring(0, 100) };
    } catch (err) {
        const aborted = !!(err && (err.userAborted || externalSignal?.aborted));
        return { ok: false, error: err.message, aborted };
    }
}
