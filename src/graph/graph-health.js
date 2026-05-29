/**
 * Vault Health / World Doctor — structural problem surfacing for the graph.
 *
 * Pure detectors (detect*) are exported for headless unit testing. computeHealthFindings
 * wires them from gs. The UI is a JS-created floating side panel (NOT baked into the graph
 * container HTML) — tooltip-pattern: created on demand, fixed side view, removed on close.
 *
 * Severities: 3 = breaks silently (red), 2 = won't/doesn't fire (orange), 1 = quality (yellow).
 * Node-flag map keys are node ids (= index into gs._vaultIndex), never bare titles — gotcha #50.
 */
import { breakCycles } from './graph-dag.js';

const SEV = { CRIT: 3, WARN: 2, INFO: 1 };
const SEV_COLOR = { 3: '#e15759', 2: '#f28e2b', 1: '#edc948' };

// ─── Pure detectors ───

/** Refs (requires/excludes/cascadeLinks) pointing at a title no entry has. Cross-vault: bare-title set. */
export function detectBrokenRefs(entries) {
    const titles = new Set(entries.map(e => (e.title || '').toLowerCase()));
    const out = [];
    entries.forEach((e, idx) => {
        const scan = (arr, kind) => {
            for (const ref of (arr || [])) {
                if (ref && !titles.has(String(ref).toLowerCase())) {
                    out.push({ idx, title: e.title, kind, target: ref });
                }
            }
        };
        scan(e.requires, 'requires');
        scan(e.excludes, 'excludes');
        scan(e.cascadeLinks, 'cascade');
    });
    return out;
}

/** Entries that both require and exclude the same target — can never fire. */
export function detectContradictoryGating(entries) {
    const out = [];
    entries.forEach((e, idx) => {
        const req = new Set((e.requires || []).map(s => String(s).toLowerCase()));
        for (const ex of (e.excludes || [])) {
            if (req.has(String(ex).toLowerCase())) out.push({ idx, title: e.title, target: ex });
        }
    });
    return out;
}

/**
 * Cycles in the directed dependency graph (requires AND cascade — gotcha #71 invariant #4
 * forbids regressing to requires-only). Returns the entry-index pairs forming back-edges.
 * Reuses breakCycles (graph-dag) on a title-resolved index graph.
 */
export function detectCircular(entries) {
    const titleToIdx = new Map();
    entries.forEach((e, i) => {
        const k = (e.title || '').toLowerCase();
        if (!titleToIdx.has(k)) titleToIdx.set(k, i);
    });
    const ids = entries.map((_, i) => i);
    const edges = [];
    entries.forEach((e, i) => {
        const addDir = (arr) => {
            for (const r of (arr || [])) {
                const j = titleToIdx.get(String(r).toLowerCase());
                if (j !== undefined && j !== i) edges.push({ from: i, to: j });
            }
        };
        addDir(e.requires);
        addDir(e.cascadeLinks);
    });
    const { removed } = breakCycles(ids, edges);
    return [...removed].map(key => {
        const [from, to] = key.split('\0').map(Number);
        return { from, to, fromTitle: entries[from]?.title, toTitle: entries[to]?.title };
    });
}

/** Node ids with zero visible-edge degree. degreeOf(id) → number. */
export function detectOrphans(nodeIds, degreeOf) {
    return nodeIds.filter(id => (degreeOf(id) || 0) === 0);
}

/** Constant entries + their summed token cost (injected every turn). */
export function detectOverConstant(entries) {
    const items = [];
    let tokens = 0;
    entries.forEach((e, idx) => {
        if (e.constant) { items.push({ idx, title: e.title, tokens: e.tokenEstimate || 0 }); tokens += e.tokenEstimate || 0; }
    });
    return { count: items.length, tokens, items };
}

/**
 * Token-bloat outliers — entries above the given percentile of tokenEstimate AND above an
 * absolute floor. Percentile (not a flat cutoff) so it scales to the vault, never flagging
 * "half the vault" the way a fixed threshold does.
 */
export function detectTokenBloat(entries, percentile = 0.9, floor = 400) {
    const toks = entries.map(e => e.tokenEstimate || 0).filter(t => t > 0).sort((a, b) => a - b);
    if (toks.length === 0) return [];
    const median = toks[Math.floor((toks.length - 1) / 2)];
    // No real spread → no outliers. A uniform vault (all entries ~equal) must flag nothing,
    // not every entry above the floor.
    if (toks[toks.length - 1] <= median * 1.5) return [];
    const cut = Math.max(floor, toks[Math.min(toks.length - 1, Math.floor(toks.length * percentile))]);
    const out = [];
    entries.forEach((e, idx) => {
        const t = e.tokenEstimate || 0;
        if (t >= cut && t > floor && t > median * 1.5) {
            out.push({ idx, title: e.title, tokens: e.tokenEstimate });
        }
    });
    return out.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Entries whose requires/excludes/cascade reference their OWN title. A self-require can never
 * be satisfied (the entry would have to be matched to match itself) → breaks silently.
 */
export function detectSelfRefs(entries) {
    const out = [];
    entries.forEach((e, idx) => {
        const self = (e.title || '').toLowerCase();
        if (!self) return;
        const hit = (arr) => (arr || []).some(r => String(r).toLowerCase() === self);
        if (hit(e.requires) || hit(e.excludes) || hit(e.cascadeLinks)) {
            out.push({ idx, title: e.title });
        }
    });
    return out;
}

/** Heavily-referenced but thin entries (degree ≥ minDeg, tokens < maxTok). */
export function detectThinHubs(entries, degreeOf, minDeg = 6, maxTok = 160) {
    const out = [];
    entries.forEach((e, idx) => {
        if ((degreeOf(idx) || 0) >= minDeg && (e.tokenEstimate || 0) < maxTok) {
            out.push({ idx, title: e.title, degree: degreeOf(idx), tokens: e.tokenEstimate || 0 });
        }
    });
    return out.sort((a, b) => b.degree - a.degree);
}

// ─── Aggregation ───

/**
 * Run all structural detectors against gs. Returns { findings[], flagged: Map<id,sev> }.
 * findings: { sev, key, title, count, detail, nodeIds[] }.
 */
export function computeHealthFindings(gs) {
    const entries = gs._vaultIndex || [];
    // Structural degree from the FULL edge set, independent of gs.edgeVisibility. edgeCountByNode
    // is rebuilt under the active visibility filter (DAG mode hides link/excludes; legend toggles),
    // so using it would falsely flag link-only/excludes-only entries as orphans. Fall back to
    // edgeCountByNode only when no edge list is available (headless tests).
    const degreeOf = (() => {
        if (Array.isArray(gs.edges)) {
            const d = new Map();
            for (const e of gs.edges) {
                d.set(e.from, (d.get(e.from) || 0) + 1);
                d.set(e.to, (d.get(e.to) || 0) + 1);
            }
            return (id) => d.get(id) || 0;
        }
        return (id) => gs.edgeCountByNode?.get(id) || 0;
    })();
    const nodeIds = entries.map((_, i) => i);

    const broken = detectBrokenRefs(entries);
    const selfRefs = detectSelfRefs(entries);
    const contra = detectContradictoryGating(entries);
    const circular = detectCircular(entries);
    const orphans = detectOrphans(nodeIds, degreeOf);
    const overConst = detectOverConstant(entries);
    const bloat = detectTokenBloat(entries);
    const thin = detectThinHubs(entries, degreeOf);

    const findings = [];
    const flagged = new Map();
    const flag = (id, sev) => { if (id != null) flagged.set(id, Math.max(flagged.get(id) || 0, sev)); };
    const names = (arr, n = 3) => arr.slice(0, n).map(x => x.title || x).join(', ') + (arr.length > n ? ` +${arr.length - n}` : '');

    // 🔴 breaks silently
    if (broken.length) {
        broken.forEach(b => flag(b.idx, SEV.CRIT));
        findings.push({ sev: SEV.CRIT, key: 'broken-refs', title: 'Broken references', count: broken.length,
            detail: broken.slice(0, 3).map(b => `${b.title} → ${b.kind}:${b.target}`).join('; ') + (broken.length > 3 ? ` +${broken.length - 3}` : ''),
            nodeIds: broken.map(b => b.idx) });
    }
    if (contra.length) {
        contra.forEach(c => flag(c.idx, SEV.CRIT));
        findings.push({ sev: SEV.CRIT, key: 'contradictory', title: 'Contradictory gating', count: contra.length,
            detail: contra.slice(0, 3).map(c => `${c.title} requires∧excludes ${c.target}`).join('; '), nodeIds: contra.map(c => c.idx) });
    }
    if (selfRefs.length) {
        selfRefs.forEach(s => flag(s.idx, SEV.CRIT));
        findings.push({ sev: SEV.CRIT, key: 'self-ref', title: 'Self-reference', count: selfRefs.length,
            detail: names(selfRefs), nodeIds: selfRefs.map(s => s.idx) });
    }
    if (circular.length) {
        circular.forEach(c => { flag(c.from, SEV.CRIT); flag(c.to, SEV.CRIT); });
        findings.push({ sev: SEV.CRIT, key: 'circular', title: 'Circular requires', count: circular.length,
            detail: circular.slice(0, 3).map(c => `${c.fromTitle} ↔ ${c.toTitle}`).join('; '), nodeIds: circular.flatMap(c => [c.from, c.to]) });
    }
    // 🟠 won't / doesn't fire
    if (orphans.length) {
        orphans.forEach(id => flag(id, SEV.WARN));
        findings.push({ sev: SEV.WARN, key: 'orphans', title: 'Orphan entries', count: orphans.length,
            detail: names(orphans.map(id => ({ title: entries[id]?.title }))), nodeIds: orphans });
    }
    // 🟡 quality / budget
    if (overConst.count) {
        findings.push({ sev: SEV.INFO, key: 'over-constant', title: 'Always-injected (constant)', count: overConst.count,
            detail: `${(overConst.tokens / 1000).toFixed(1)}k tokens every turn: ${names(overConst.items)}`, nodeIds: overConst.items.map(i => i.idx) });
    }
    if (thin.length) {
        thin.forEach(t => flag(t.idx, SEV.INFO));
        findings.push({ sev: SEV.INFO, key: 'thin-hubs', title: 'Thin hubs', count: thin.length,
            detail: `heavily linked but small: ${names(thin)}`, nodeIds: thin.map(t => t.idx) });
    }
    if (bloat.length) {
        bloat.forEach(b => flag(b.idx, SEV.INFO));
        findings.push({ sev: SEV.INFO, key: 'token-bloat', title: 'Token-bloat entries', count: bloat.length,
            detail: `${names(bloat)} (${bloat[0]?.tokens} tok max)`, nodeIds: bloat.map(b => b.idx) });
    }

    findings.sort((a, b) => b.sev - a.sev);
    return { findings, flagged };
}

// ─── Floating side-panel UI (JS-created, not in container HTML) ───

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function initHealth(gs, dbg) {
    let panelEl = null;

    function close() {
        if (panelEl) { panelEl.remove(); panelEl = null; }
        gs.healthActive = false;
        gs.healthFlagged = null;
        gs.needsDraw = true;
        if (dbg) dbg('Health: closed');
    }

    function centerOnNode(id) {
        const n = gs.nodes[id];
        if (!n || n.hidden) return;
        gs._userPanned = true;
        gs.panX = gs.W / 2 - n.x * gs.zoom;
        gs.panY = gs.H / 2 - n.y * gs.zoom;
        gs.hoverNode = n;
        gs.needsDraw = true;
    }

    function render(findings) {
        if (panelEl) panelEl.remove();
        panelEl = document.createElement('div');
        panelEl.className = 'dle-graph-health-panel';
        // Inline-styled floating side view — self-contained, no container-HTML / CSS-file dependency.
        panelEl.style.cssText = 'position:absolute;top:8px;right:8px;width:286px;max-height:calc(100% - 16px);overflow:auto;'
            + 'background:var(--SmartThemeBlurTintColor,#15151a);border:1px solid rgba(255,255,255,0.12);border-radius:8px;'
            + 'box-shadow:0 10px 30px rgba(0,0,0,0.5);z-index:35;font-size:12px;color:var(--SmartThemeBodyColor,#ddd);';

        const groups = [
            { sev: SEV.CRIT, label: '🔴 Breaks silently' },
            { sev: SEV.WARN, label: "🟠 Won't / doesn't fire" },
            { sev: SEV.INFO, label: '🟡 Quality / budget' },
        ];
        let html = '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.1);position:sticky;top:0;background:inherit;">'
            + '<b><i class="fa-solid fa-stethoscope"></i> Vault Health</b>'
            + '<span class="dle-health-close" role="button" tabindex="0" title="Close" style="cursor:pointer;padding:0 4px;">&times;</span></div>';

        if (findings.length === 0) {
            html += '<div style="padding:14px;color:#7bbf7b;">No structural problems detected.</div>';
        } else {
            for (const g of groups) {
                const rows = findings.filter(f => f.sev === g.sev);
                if (!rows.length) continue;
                html += `<div style="padding:6px 10px 2px;color:${SEV_COLOR[g.sev]};font-weight:700;font-size:11px;">${g.label}</div>`;
                for (const f of rows) {
                    html += `<div class="dle-health-row" data-key="${escapeHtml(f.key)}" role="button" tabindex="0" `
                        + `style="display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;">`
                        + `<span style="color:${SEV_COLOR[f.sev]};">●</span>`
                        + `<div style="flex:1;min-width:0;"><div><b>${escapeHtml(f.title)}</b> <span style="color:#888;">${f.count}</span></div>`
                        + `<div style="color:#9a9aa5;font-size:11px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(f.detail)}</div></div></div>`;
                }
            }
        }
        panelEl.innerHTML = html;

        // Wire interactions (no inline handlers — CSP-safe).
        panelEl.querySelector('.dle-health-close')?.addEventListener('click', close);
        const byKey = new Map(findings.map(f => [f.key, f]));
        panelEl.querySelectorAll('.dle-health-row').forEach(row => {
            row.addEventListener('click', () => {
                const f = byKey.get(row.dataset.key);
                if (f && f.nodeIds && f.nodeIds.length) centerOnNode(f.nodeIds[0]);
            });
        });

        const host = gs.canvas.closest('.dle-graph-canvas-wrap') || gs.canvas.parentNode;
        host.appendChild(panelEl);
    }

    function open() {
        const { findings, flagged } = computeHealthFindings(gs);
        gs.healthFlagged = flagged;
        gs.healthActive = true;
        render(findings);
        gs.needsDraw = true;
        if (dbg) dbg(`Health: ${findings.length} finding group(s), ${flagged.size} flagged node(s)`);
    }

    function toggle() { if (panelEl) close(); else open(); }

    gs.openHealth = open;
    gs.closeHealth = close;
    gs.toggleHealth = toggle;
    return { open, close, toggle, computeHealthFindings };
}
