/**
 * DLE diagnostic logger.
 *
 * Pre-formats printf specifiers (%s %d %i %f %o %O %j) and object args into a
 * single string BEFORE console.*, so tooling that doesn't process Chrome
 * DevTools formatArgs (preview_console_logs, automated harnesses) still gets
 * readable output. Native DevTools still renders correctly — just loses the
 * expandable-object affordance.
 *
 * Optional formatting helpers (`dlog`/`dwarn`/`derror`/`ddebug`) for tooling that
 * can't parse DevTools format-args; not required for new code, which uses raw
 * `console.*`. Trailing object args are JSON-stringified instead of flattening
 * to "[object Object]".
 */

function safeJson(v) {
    try {
        return JSON.stringify(v, (_, val) => (typeof val === 'bigint' ? String(val) : val));
    } catch {
        return String(v);
    }
}

function renderValue(v, spec) {
    if (spec === '%d' || spec === '%i') {
        const n = Number(v);
        return Number.isFinite(n) ? String(Math.trunc(n)) : String(v);
    }
    if (spec === '%f') {
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : String(v);
    }
    if (spec === '%o' || spec === '%O' || spec === '%j') return safeJson(v);
    // %s + default
    return typeof v === 'object' && v !== null ? safeJson(v) : String(v);
}

export function fmt(template, ...args) {
    if (typeof template !== 'string') {
        return [template, ...args]
            .map(a => (typeof a === 'object' && a !== null ? safeJson(a) : String(a)))
            .join(' ');
    }
    let i = 0;
    const formatted = template.replace(/%[sdifoOj%]/g, (spec) => {
        if (spec === '%%') return '%';
        if (i >= args.length) return spec;
        return renderValue(args[i++], spec);
    });
    const rest = args.slice(i).map(a => (typeof a === 'object' && a !== null ? safeJson(a) : String(a)));
    return rest.length ? `${formatted} ${rest.join(' ')}` : formatted;
}

export function dlog(template, ...args) { console.log(fmt(template, ...args)); }
export function dwarn(template, ...args) { console.warn(fmt(template, ...args)); }
export function derror(template, ...args) { console.error(fmt(template, ...args)); }
export function ddebug(template, ...args) { console.debug(fmt(template, ...args)); }

/**
 * [DLE][DIAG] probe helper — prepends the tag, expands format specifiers.
 * Example: diag('strip-dedup-log-clear', '— %s, clearing %d stale entries', reason, count);
 */
export function diag(tag, template, ...args) {
    console.debug(fmt(`[DLE][DIAG] ${tag} ${template}`, ...args));
}
