/**
 * DeepLore — AI circuit breaker pure helpers.
 *
 * Split out so the shared classifier (and any other future breaker pure helper)
 * can be regression-tested without ST globals. NO imports from ST modules and
 * no imports from state.js — keep it that way.
 *
 * Re-exported from `src/ai/ai.js` so existing call sites can keep importing
 * from there without a churn-only diff.
 */

/**
 * Shared AI-circuit-breaker exclusion classifier.
 *
 * Returns true when an error should NOT count as a breaker failure. The breaker
 * exists to detect *service-down* conditions; transient or user-caused errors
 * are excluded so they don't lock the user out of every AI feature for 30s.
 *
 * Excluded categories (must stay in sync with `docs/ai-subsystem.md`
 * "What does NOT trip the breaker" + "All Circuit Breaker Callers"):
 *   - `err.throttled`        — already rate-limited locally, we backed off cleanly
 *   - `err.userAborted`      — user pressed Stop
 *   - `AbortError` w/ "aborted by user" message — user abort masquerading as AbortError
 *   - `err.timedOut` / generic AbortError / "timed out" message — request timeout
 *   - HTTP 429 (rate_limit)  — provider asking us to slow down (not service-down)
 *   - HTTP 401 / 403 (auth)  — bad API key isn't a service-down signal
 *
 * Wave-B audit (2026-05-22): pre-fix, scribe / auto-suggest / summarize wrappers
 * each inlined a 3-condition check (throttled / userAborted / timedOut), missing
 * 401/403/429. Second bad-API-key call tripped the 2-failure threshold and locked
 * all AI for 30s. This helper is the single source of truth — every wrapper MUST
 * route its trip decision through it.
 *
 * @param {Error & {status?: number, throttled?: boolean, userAborted?: boolean, timedOut?: boolean}} err
 * @returns {boolean} true if the breaker should NOT trip
 */
export function isExcludedFromBreaker(err) {
    if (!err) return false;
    if (err.throttled) return true;
    if (err.userAborted) return true;
    const msg = err.message || '';
    const isUserAbortByName = err.name === 'AbortError' && /aborted by user/i.test(msg);
    if (isUserAbortByName) return true;
    const isTimeout = err.timedOut === true || err.name === 'AbortError' || /timed?\s*out/i.test(msg);
    if (isTimeout) return true;
    // Prefer structured fields. err.code may carry a numeric or string status.
    // The prose fallback ONLY scrapes a status that is explicitly LABELED
    // (e.g. "HTTP 503", "status: 401", "status 429") — never a bare 3-digit run,
    // which over-matches token counts, model names, and other prose numbers and
    // would wrongly EXCLUDE a genuine service-down 5xx from the breaker.
    const codeNum = Number(err.code);
    const status = Number(err.status)
        || (Number.isFinite(codeNum) ? codeNum : 0)
        || Number((msg.match(/(?:\bhttp|\bstatus(?:\s*code)?)[:\s]+(\d{3})\b/i) || [])[1])
        || 0;
    const isRateLimit = status === 429 || /rate.?limit|too many requests/i.test(msg);
    if (isRateLimit) return true;
    // Drop the bare `auth` substring/word alternative — it over-matched
    // "Author"/"authentication" AND a standalone "auth" inside a genuine 5xx
    // ("auth backend 500 unavailable"), wrongly excluding service-down errors.
    // Keep only the explicit, unambiguous auth phrases for status-less providers.
    const isAuthError = status === 401 || status === 403
        || /unauthoriz|forbidden|invalid api key/i.test(msg);
    if (isAuthError) return true;
    return false;
}
