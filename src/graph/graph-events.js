import { getVaultByName } from '../../settings.js';
import { buildObsidianURI, openExternalProtocol } from '../helpers.js';
import { computeGapAnalysis } from './graph-analysis.js';

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {object} gs
 * @param {Function} dbg
 * @returns {{ exportPNG, exportJSON }}
 */
export function initEvents(gs, dbg) {
    const { canvas, nodes, edges, edgeVisibility, edgeCountByNode, injectionCounts, settings } = gs;
    const lOpt = { signal: gs.listenerAC.signal };

    // ─── Context menu ───
    const contextMenuEl = document.getElementById('dle-graph-context-menu');

    function showContextMenu(node, screenX, screenY) {
        if (!contextMenuEl) return;
        gs.contextMenuNode = node;
        const entry = gs._vaultIndex[node.id];
        const connections = edgeCountByNode.get(node.id) || 0;
        const isPermanentlyPinned = node.pinned && gs.tempPinnedNode !== node;
        const pinLabel = isPermanentlyPinned ? 'Unpin Node' : 'Pin Node';

        const vault = getVaultByName(settings, entry.vaultSource || '');
        const obsidianUri = vault ? buildObsidianURI(vault.name, entry.filename) : null;
        // BUG-190: role + tabindex make menu items keyboard-navigable.
        const obsidianItem = obsidianUri
            ? `<div class="dle-graph-ctx-item" role="menuitem" tabindex="-1" data-action="obsidian">Open in Obsidian</div>`
            : '';

        contextMenuEl.setAttribute('role', 'menu');
        contextMenuEl.innerHTML = `
            <div class="dle-graph-ctx-header">${escapeHtml(node.title)}</div>
            <div class="dle-graph-ctx-item" role="menuitem" tabindex="-1" data-action="pin">${pinLabel}</div>
            ${obsidianItem}
            <div class="dle-graph-ctx-item" role="menuitem" tabindex="-1" data-action="focus-tree">Focus Tree</div>
            <div class="dle-graph-ctx-item" role="menuitem" tabindex="-1" data-action="details">Show Details</div>
            <div class="dle-graph-ctx-item" role="menuitem" tabindex="-1" data-action="copy-title">Copy Title</div>
            <div class="dle-graph-ctx-sep"></div>
            <div class="dle-graph-ctx-item dle-dimmed">${connections} connection(s) · ~${node.tokens} tokens</div>
        `;

        let tx = screenX;
        let ty = screenY;
        const menuW = 180;
        const menuH = contextMenuEl.offsetHeight || 120;
        if (tx + menuW > gs.W) tx = gs.W - menuW - 4;
        if (ty + menuH > gs.H) ty = gs.H - menuH - 4;
        tx = Math.max(2, tx);
        ty = Math.max(2, ty);
        contextMenuEl.style.left = `${tx}px`;
        contextMenuEl.style.top = `${ty}px`;
        contextMenuEl.style.display = 'block';

        const items = Array.from(contextMenuEl.querySelectorAll('.dle-graph-ctx-item[data-action]'));
        items.forEach((el, i) => {
            el.addEventListener('click', () => {
                const action = el.dataset.action;
                dbg(`Context menu click: action="${action}", contextMenuNode="${gs.contextMenuNode?.title}", tempPinned="${gs.tempPinnedNode?.title || 'none'}"`);
                handleContextAction(action, gs.contextMenuNode);
                hideContextMenu();
            }, { once: true });
            // BUG-190: arrow-key nav + Enter/Space activation per ARIA menu pattern.
            el.addEventListener('keydown', (ev) => {
                if (ev.key === 'ArrowDown') {
                    ev.preventDefault();
                    items[(i + 1) % items.length].focus();
                } else if (ev.key === 'ArrowUp') {
                    ev.preventDefault();
                    items[(i - 1 + items.length) % items.length].focus();
                } else if (ev.key === 'Home') {
                    ev.preventDefault();
                    items[0].focus();
                } else if (ev.key === 'End') {
                    ev.preventDefault();
                    items[items.length - 1].focus();
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    hideContextMenu();
                } else if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    el.click();
                }
            });
        });
        if (items[0]) items[0].focus();
    }

    function hideContextMenu() {
        if (contextMenuEl) contextMenuEl.style.display = 'none';
        if (gs.tempPinnedNode) {
            gs.tempPinnedNode.pinned = false;
            dbg(`Unpin temp-pinned "${gs.tempPinnedNode.title}" — menu dismissed without pin action`);
            gs.tempPinnedNode = null;
            gs.needsDraw = true;
        }
        gs.contextMenuNode = null;
    }

    function handleContextAction(action, node) {
        if (!node) return;
        dbg(`Context action: ${action} on "${node.title}" (id=${node.id})`);
        const entry = gs._vaultIndex[node.id];
        switch (action) {
            case 'pin':
                if (gs.tempPinnedNode === node) {
                    gs.tempPinnedNode = null;
                    node.pinned = true;
                    dbg(`Node "${node.title}" permanently pinned (was temp-pinned)`);
                } else {
                    node.pinned = !node.pinned;
                    dbg(`Node "${node.title}" ${node.pinned ? 'pinned' : 'unpinned'}`);
                }
                node.vx = 0; node.vy = 0;
                gs.needsDraw = true;
                break;
            case 'obsidian': {
                const vault = getVaultByName(settings, entry.vaultSource || '');
                const uri = vault ? buildObsidianURI(vault.name, entry.filename) : null;
                dbg(`Open in Obsidian: vault=${vault?.name || 'NONE'}, uri=${uri || 'NULL'}`);
                if (uri) {
                    openExternalProtocol(uri);
                } else {
                    dbg('WARNING: No vault found for entry, cannot build Obsidian URI');
                }
                break;
            }
            case 'focus-tree': {
                gs.enterFocusTree(node);
                break;
            }
            case 'copy-title':
                navigator.clipboard.writeText(node.title).then(
                    () => toastr.success(`Copied "${node.title}"`, '', { timeOut: 2000 }),
                    () => toastr.warning('Clipboard access denied — check your browser permissions.', 'DeepLore Enhanced', { timeOut: 3000 }),
                );
                break;
            case 'details': {
                const connections = edgeCountByNode.get(node.id) || 0;
                const inj = injectionCounts.get(node.id) || 0;
                const tags = (entry.tags || []).join(', ') || 'none';
                const links = entry.resolvedLinks.length;
                const reqs = entry.requires.length;
                const excl = entry.excludes.length;
                const details = [
                    `Type: ${escapeHtml(node.type)} · Priority: ${entry.priority}`,
                    `Tokens: ~${node.tokens} · Connections: ${connections}`,
                    `Injections (this chat): ${inj}`,
                    `Links: ${links} · Requires: ${reqs} · Excludes: ${excl}`,
                    `Tags: ${escapeHtml(tags)}`,
                ];
                if (entry.customFields) {
                    for (const [key, val] of Object.entries(entry.customFields)) {
                        if (val != null && val !== '' && (!Array.isArray(val) || val.length > 0)) {
                            details.push(`${escapeHtml(key)}: ${escapeHtml(Array.isArray(val) ? val.join(', ') : String(val))}`);
                        }
                    }
                }
                if (entry.summary) details.push(`<em>${escapeHtml(entry.summary.substring(0, 120))}${entry.summary.length > 120 ? '...' : ''}</em>`);
                const panel = canvas.parentNode?.querySelector('.dle-graph-detail-panel');
                // BUG-AUDIT-H25: ARIA + focus management on the detail panel (role="dialog").
                if (panel) {
                    panel.setAttribute('role', 'dialog');
                    panel.setAttribute('aria-label', `Entry details: ${entry.title}`);
                    panel.innerHTML = `<div class="dle-graph-detail-header">
                        <strong>${escapeHtml(entry.title)}</strong>
                        <button class="dle-graph-detail-close" title="Close" aria-label="Close entry details"><i class="fa-solid fa-xmark"></i></button>
                    </div><div class="dle-graph-detail-body">${details.join('<br>')}</div>`;
                    panel.style.display = '';
                    const closeBtn = panel.querySelector('.dle-graph-detail-close');
                    closeBtn?.addEventListener('click', () => { panel.style.display = ''; panel.removeAttribute('role'); panel.style.display = 'none'; }, { once: true });
                    closeBtn?.focus();
                }
                break;
            }
        }
    }

    // ─── Export ───
    function exportPNG() {
        dbg('Exporting PNG...');
        try {
            const dataUrl = canvas.toDataURL('image/png');
            const link = document.createElement('a');
            link.download = `dle-graph-${new Date().toISOString().slice(0, 10)}.png`;
            link.href = dataUrl;
            link.click();
            toastr.success('Graph exported as PNG', 'DeepLore Enhanced');
        } catch (e) {
            console.warn('[DLE] PNG export failed:', e); toastr.error('Couldn\'t save the graph image.', 'DeepLore Enhanced');
        }
    }

    function exportJSON() {
        dbg('Exporting JSON...');
        let objectUrl = null;
        try {
            const data = {
                exportedAt: new Date().toISOString(),
                nodes: nodes.map(n => ({
                    title: n.title, type: n.type, tokens: n.tokens,
                    priority: n.priority, vaultSource: n.vaultSource,
                    connections: edgeCountByNode.get(n.id) || 0,
                    injections: injectionCounts.get(n.id) || 0,
                    pinned: !!n.pinned,
                })),
                edges: edges.map(e => ({
                    from: nodes[e.from].title,
                    to: nodes[e.to].title,
                    type: e.type,
                })),
                stats: {
                    totalNodes: nodes.length, totalEdges: edges.length,
                    circularPairs: gs.circularPairs.length,
                    typeCounts: gs.typeCounts,
                },
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.download = `dle-graph-${new Date().toISOString().slice(0, 10)}.json`;
            objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl;
            link.click();
            dbg(`JSON exported: ${data.nodes.length} nodes, ${data.edges.length} edges`);
            toastr.success('Graph exported as JSON', 'DeepLore Enhanced');
        } catch (e) {
            dbg('JSON export failed:', e.message);
            console.warn('[DLE] JSON export failed:', e); toastr.error('Couldn\'t save the graph data.', 'DeepLore Enhanced');
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    }

    // ─── Canvas mouse ───
    function freshRect() { gs.cachedRect = canvas.getBoundingClientRect(); return gs.cachedRect; }

    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // G8: settlingUntil window blocks all canvas interaction during initial physics settle.
        if (gs.settlingUntil && Date.now() < gs.settlingUntil) return;
        hideContextMenu();
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = gs.toWorld(mx, my);
        const closest = gs.findNearest(w.x, w.y, gs.hitRadius(), 'mousedown');
        if (closest) {
            gs.dragNode = closest;
            canvas.style.cursor = 'grabbing';
            dbg(`mousedown: grabbed "${closest.title}"`);
        } else {
            gs.isPanning = true;
            gs.panStartX = mx; gs.panStartY = my;
            gs.panOriginX = gs.panX; gs.panOriginY = gs.panY;
            canvas.style.cursor = 'grabbing';
            // BUG-358: mark _userPanned so pending startup _fitTimers don't snap the view back.
            gs._userPanned = true;
        }
    }, lOpt);

    canvas.addEventListener('mouseenter', () => { gs.cachedRect = canvas.getBoundingClientRect(); }, lOpt);

    canvas.addEventListener('mousemove', (e) => {
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        gs.debugMouseX = mx; gs.debugMouseY = my; if (gs.focusTreeRoot) gs.needsDraw = true;
        // G8: during initial settling, only debug coords are tracked — interaction is suppressed.
        if (gs.settlingUntil && Date.now() < gs.settlingUntil) return;
        if (gs.dragNode) {
            const w = gs.toWorld(mx, my);
            gs.dragNode.x = w.x; gs.dragNode.y = w.y; gs.dragNode.vx = 0; gs.dragNode.vy = 0;
            gs.needsDraw = true;
        } else if (gs.isPanning) {
            gs.panX = gs.panOriginX + (mx - gs.panStartX);
            gs.panY = gs.panOriginY + (my - gs.panStartY);
            gs.needsDraw = true;
        } else {
            const w = gs.toWorld(mx, my);
            const closest = gs.findNearest(w.x, w.y, gs.hitRadius(), undefined);
            if (closest !== gs.hoverNode) {
                gs.hoverNode = closest;
                // Orphans have no connections — skip BFS so the entire graph doesn't get pulled into the hover set.
                gs.hoverDistances = (closest && !closest.orphan) ? gs.computeHoverDistances(closest.id) : null;
                gs.needsDraw = true;
                gs.updateTooltip();
            }
            canvas.style.cursor = closest ? 'pointer' : 'grab';
        }
    }, lOpt);

    canvas.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;
        if (gs.dragNode) {
            // G6: zero velocity + 15-frame extra-damping window prevents the released node from snapping back.
            gs.dragNode.vx = 0;
            gs.dragNode.vy = 0;
            gs.releaseStabilizeFrames = 15;
            dbg(`mouseup: released "${gs.dragNode.title}"`);
            gs.dragNode = null;
        }
        gs.isPanning = false;
        canvas.style.cursor = 'grab';
    }, lOpt);

    canvas.addEventListener('dblclick', (e) => {
        if (gs.settlingUntil && Date.now() < gs.settlingUntil) return;
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = gs.toWorld(mx, my);
        const closest = gs.findNearest(w.x, w.y, gs.hitRadius(), 'dblclick');
        if (closest) {
            if (gs.focusTreeRoot) {
                dbg(`dblclick: re-rooting Focus Tree from "${gs.focusTreeRoot.title}" to "${closest.title}"`);
                for (const n of nodes) {
                    if (n._treePinned) { n.pinned = false; n._treePinned = false; }
                    n.hidden = n.orphan || (n.revealBatchIdx != null && n.revealBatchIdx >= gs.revealedBatch && n.revealBatchIdx !== -1);
                }
                if (gs.focusTreeRoot._depthMap) delete gs.focusTreeRoot._depthMap;
                gs.focusTreeRoot.pinned = false;
                gs.focusTreeRoot = null;
                gs.focusTreePhysics = false;
            } else {
                dbg(`dblclick: entering Focus Tree on "${closest.title}"`);
            }
            gs.enterFocusTree(closest);
        }
    }, lOpt);

    canvas.addEventListener('mouseleave', () => {
        if (!gs.dragNode && !gs.isPanning) {
            gs.hoverNode = null;
            gs.hoverDistances = null;
            gs.needsDraw = true;
            gs.updateTooltip();
        }
    }, lOpt);

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (gs.settlingUntil && Date.now() < gs.settlingUntil) return;
        if (gs.dragNode) {
            const pinTarget = gs.dragNode;
            pinTarget.vx = 0; pinTarget.vy = 0;
            if (!pinTarget.pinned) {
                pinTarget.pinned = true;
                gs.tempPinnedNode = pinTarget;
                dbg(`Temp-pinned "${pinTarget.title}" during drag→right-click`);
            }
            gs.dragNode = null;
            gs.isPanning = false;
            const r2 = freshRect();
            showContextMenu(pinTarget, e.clientX - r2.left, e.clientY - r2.top);
            return;
        }
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = gs.toWorld(mx, my);
        const closest = gs.findNearest(w.x, w.y, gs.hitRadius(), 'contextmenu');
        if (closest) {
            showContextMenu(closest, mx, my);
        } else {
            hideContextMenu();
        }
    }, lOpt);

    document.addEventListener('click', (e) => {
        if (contextMenuEl && !contextMenuEl.contains(e.target)) {
            dbg(`Document click outside context menu, hiding. target=${e.target.tagName}.${e.target.className}, tempPinned="${gs.tempPinnedNode?.title || 'none'}"`);
            hideContextMenu();
        }
    }, lOpt);

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        hideContextMenu();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        // Pan correction keeps the mouse-pointed world position fixed during zoom (zoom-to-cursor).
        gs.panX = mx - (mx - gs.panX) * zoomFactor;
        gs.panY = my - (my - gs.panY) * zoomFactor;
        gs.zoom *= zoomFactor;
        gs.zoom = Math.max(0.2, Math.min(5, gs.zoom));
        gs._userPanned = true; // BUG-358

        gs.needsDraw = true;
    }, { passive: false, signal: gs.listenerAC.signal });

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('dle-graph-canvas')) return;
        // BUG-353: also block when focus is in a contenteditable surface (ST chat input,
        // custom prose editors) so e/0 don't fire while the graph is behind them.
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;

        switch (e.key) {
            case '0':
                dbg('Keyboard: fit to view');
                gs.fitToView();
                break;
            case 'e':
            case 'E':
                // ST quirk: focus-tree exit is `e`, NOT Escape — Escape bubbles to ST's popup
                // close (BUG-357). `e` either exits focus mode or resets isolation if not in focus.
                if (gs.focusTreeRoot) {
                    dbg('Keyboard: e — exiting focus tree');
                    gs.exitFocusTree();
                    hideContextMenu();
                    gs.needsDraw = true;
                    e.preventDefault();
                } else {
                    dbg('Keyboard: e — resetting isolation and context menu');
                    for (const n of nodes) {
                        const shouldBeHidden = n.orphan || (n.revealBatchIdx != null && n.revealBatchIdx >= gs.revealedBatch && n.revealBatchIdx !== -1);
                        if (n.hidden && !shouldBeHidden) { n.vx = 0; n.vy = 0; }
                        n.hidden = shouldBeHidden;
                    }
                    hideContextMenu();
                    gs.needsDraw = true;
                    e.preventDefault();
                }
                break;
        }
    }, lOpt);

    // ResizeObserver on the canvas itself (not window resize) so popup resizes are tracked too.
    function handleResize() {
        gs.cachedRect = canvas.getBoundingClientRect();
        if (gs.cachedRect.width < 1 || gs.cachedRect.height < 1) return;
        const newDpr = window.devicePixelRatio || 1;
        canvas.width = gs.cachedRect.width * newDpr;
        canvas.height = gs.cachedRect.height * newDpr;
        gs.ctx.setTransform(newDpr, 0, 0, newDpr, 0, 0);
        gs.W = gs.cachedRect.width;
        gs.H = gs.cachedRect.height;
        gs.needsDraw = true;
    }
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(canvas);
    gs.listenerAC.signal.addEventListener('abort', () => resizeObserver.disconnect());

    // ─── Toolbar wiring ───
    const searchEl = document.getElementById('dle-graph-search');
    const typeFilterEl = document.getElementById('dle-graph-type-filter');
    const tagFilterEl = document.getElementById('dle-graph-tag-filter');
    const colorModeEl = document.getElementById('dle-graph-color-mode');
    const fitBtn = document.getElementById('dle-graph-fit');
    const exportPngBtn = document.getElementById('dle-graph-export-png');
    const exportJsonBtn = document.getElementById('dle-graph-export-json');

    const searchClearBtn = document.getElementById('dle-graph-search-clear');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            gs.searchQuery = searchEl.value;
            gs.applyFilters();
            if (searchClearBtn) searchClearBtn.style.display = searchEl.value ? '' : 'none';
        }, lOpt);
    }
    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            if (searchEl) {
                searchEl.value = '';
                searchEl.dispatchEvent(new Event('input'));
                searchEl.focus();
            }
        }, lOpt);
    }
    if (typeFilterEl) {
        typeFilterEl.addEventListener('change', () => {
            gs.typeFilter = typeFilterEl.value;
            gs.applyFilters();
        }, lOpt);
    }
    if (tagFilterEl) {
        tagFilterEl.addEventListener('change', () => {
            gs.tagFilter = tagFilterEl.value;
            gs.applyFilters();
        }, lOpt);
    }
    if (colorModeEl) {
        colorModeEl.value = gs.colorMode;
        colorModeEl.addEventListener('change', () => {
            gs.colorMode = colorModeEl.value;
            dbg(`Color mode changed to: ${gs.colorMode}`);
            gs.needsDraw = true;
            gs.updateTooltip();
        }, lOpt);
    }
    const backBtn = document.getElementById('dle-graph-back');
    if (backBtn) {
        backBtn.addEventListener('click', () => gs.exitFocusTree(), lOpt);
    }
    const hopMinusBtn = document.getElementById('dle-graph-hop-minus');
    const hopPlusBtn = document.getElementById('dle-graph-hop-plus');
    const depthDisplayEl = document.getElementById('dle-graph-depth-display');
    function updateDepthDisplay() {
        if (depthDisplayEl) depthDisplayEl.textContent = gs.settings.graphFocusTreeDepth || 2;
    }
    function adjustHopDepth(delta) {
        if (!gs.focusTreeRoot) return;
        const current = gs.settings.graphFocusTreeDepth || 2;
        const newDepth = Math.max(1, Math.min(15, current + delta));
        if (newDepth === current) return;
        gs.settings.graphFocusTreeDepth = newDepth;
        updateDepthDisplay();
        const root = gs.focusTreeRoot;
        for (const n of nodes) {
            if (n._treePinned) { n.pinned = false; n._treePinned = false; }
            delete n._targetX;
            delete n._targetY;
        }
        if (gs.focusTreeRoot._depthMap) delete gs.focusTreeRoot._depthMap;
        if (gs.focusTreeRoot._treeEdgeIdx) delete gs.focusTreeRoot._treeEdgeIdx;
        if (gs.focusTreeRoot._hasDownwardChildSet) delete gs.focusTreeRoot._hasDownwardChildSet;
        gs.focusTreeRoot.pinned = false;
        gs.focusTreeRoot = null;
        gs.focusTreePhysics = false;
        gs._egoLerpActive = false;
        gs.enterFocusTree(root);
        dbg(`Hop depth adjusted to ${newDepth}`);
    }
    if (hopMinusBtn) hopMinusBtn.addEventListener('click', () => adjustHopDepth(-1), lOpt);
    if (hopPlusBtn) hopPlusBtn.addEventListener('click', () => adjustHopDepth(+1), lOpt);
    const unpinAllBtn = document.getElementById('dle-graph-unpin-all');
    if (unpinAllBtn) {
        unpinAllBtn.addEventListener('click', () => {
            let count = 0;
            for (const n of nodes) {
                if (n.pinned && !n._treePinned) { n.pinned = false; count++; }
            }
            dbg(`Unpinned ${count} nodes`);
            gs.needsDraw = true;
        }, lOpt);
    }
    const resetBtn = document.getElementById('dle-graph-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (gs.focusTreeRoot) gs.exitFocusTree();
            for (const n of nodes) {
                n.pinned = false;
                n._treePinned = false;
                n.vx = 0; n.vy = 0;
            }

            // Reset prefers saved layout (gentle settle); falls back to fresh BFS layout if too few positions match.
            const saved = settings.graphSavedLayout;
            let restored = false;
            if (saved?.positions) {
                let matched = 0;
                for (const n of nodes) {
                    const p = saved.positions[n.title];
                    if (p) { n.x = p.x; n.y = p.y; matched++; }
                }
                if (matched >= nodes.length * 0.8) {
                    restored = true;
                    gs.alpha = 0.3;
                    dbg(`Reset: restored saved layout (${matched}/${nodes.length} matched)`);
                }
            }

            if (!restored) {
                let hubId = 0, hubEdges = 0;
                for (const [id, count] of edgeCountByNode) {
                    if (count > hubEdges) { hubId = id; hubEdges = count; }
                }
                const fullAdj = new Map();
                for (const n of nodes) fullAdj.set(n.id, []);
                for (const edge of edges) {
                    fullAdj.get(edge.from).push(edge.to);
                    fullAdj.get(edge.to).push(edge.from);
                }
                const rdepth = new Map();
                rdepth.set(hubId, 0);
                const rqueue = [hubId];
                let rhead = 0;
                while (rhead < rqueue.length) {
                    const cur = rqueue[rhead++];
                    const d = rdepth.get(cur);
                    for (const nb of (fullAdj.get(cur) || [])) {
                        if (!rdepth.has(nb)) { rdepth.set(nb, d + 1); rqueue.push(nb); }
                    }
                }
                const rSpacing = 300;
                const rByDepth = new Map();
                for (const [id, d] of rdepth) {
                    if (!rByDepth.has(d)) rByDepth.set(d, []);
                    rByDepth.get(d).push(id);
                }
                for (const [d, ids] of rByDepth) {
                    if (d === 0) { nodes[ids[0]].x = 0; nodes[ids[0]].y = 0; }
                    else {
                        const radius = d * rSpacing;
                        for (let i = 0; i < ids.length; i++) {
                            const angle = (2 * Math.PI * i / ids.length) + (d * 0.5);
                            nodes[ids[i]].x = radius * Math.cos(angle) + (Math.random() - 0.5) * rSpacing * 0.2;
                            nodes[ids[i]].y = radius * Math.sin(angle) + (Math.random() - 0.5) * rSpacing * 0.2;
                        }
                    }
                }
                // Orphans land randomly along one of the 4 viewport edges to keep them out of the main mass.
                const disconnected = nodes.filter(n => !rdepth.has(n.id));
                for (const n of disconnected) {
                    const side = Math.floor(Math.random() * 4);
                    const jitter = (Math.random() - 0.5) * 0.6;
                    if (side === 0)      { n.x = gs.W * jitter; n.y = -gs.H * 0.2; }
                    else if (side === 1) { n.x = gs.W * 0.2;    n.y = gs.H * jitter; }
                    else if (side === 2) { n.x = gs.W * jitter; n.y = gs.H * 0.2; }
                    else                 { n.x = -gs.W * 0.2;   n.y = gs.H * jitter; }
                }
                gs.alpha = 1.0;
                dbg('Reset: re-initialized BFS layout and restarted physics');
            }

            gs.simFrame = 0;
            gs.needsDraw = true;
            if (gs.fitToView) gs.fitToView(true);
        }, lOpt);
    }
    if (fitBtn) {
        fitBtn.addEventListener('click', () => gs.fitToView(), lOpt);
    }
    if (exportPngBtn) {
        exportPngBtn.addEventListener('click', () => exportPNG(), lOpt);
    }
    if (exportJsonBtn) {
        exportJsonBtn.addEventListener('click', () => exportJSON(), lOpt);
    }

    const analyzeBtn = document.getElementById('dle-graph-analyze');
    if (analyzeBtn) {
        analyzeBtn.addEventListener('click', () => {
            gs.gapAnalysisActive = !gs.gapAnalysisActive;
            analyzeBtn.classList.toggle('active', gs.gapAnalysisActive);
            if (gs.gapAnalysisActive) {
                gs.gapAnalysis = computeGapAnalysis(gs);
                const ga = gs.gapAnalysis;
                dbg(`Gap Analysis: ${ga.orphans.length} orphans, ${ga.bridges.length} bridges, ${ga.missingConnections.length} missing connections`);
                const parts = [];
                if (ga.orphans.length > 0) parts.push(`${ga.orphans.length} orphan${ga.orphans.length > 1 ? 's' : ''}`);
                if (ga.bridges.length > 0) parts.push(`${ga.bridges.length} weak bridge${ga.bridges.length > 1 ? 's' : ''}`);
                if (ga.missingConnections.length > 0) parts.push(`${ga.missingConnections.length} potential missing link${ga.missingConnections.length > 1 ? 's' : ''}`);
                if (parts.length > 0) {
                    toastr.info(`Found: ${parts.join(', ')}`, 'Gap Analysis', { timeOut: 5000 });
                } else {
                    toastr.success('No gaps detected — your vault is well-connected!', 'Gap Analysis', { timeOut: 3000 });
                }
            } else {
                gs.gapAnalysis = null;
            }
            gs.needsDraw = true;
        }, lOpt);
    }

    // ─── Interactive legend (edge-type visibility toggles) ───
    const legendEl = document.getElementById('dle-graph-legend');
    if (legendEl) {
        legendEl.querySelectorAll('.dle-graph-legend-item').forEach(item => {
            const toggleEdge = () => {
                const type = item.dataset.edgeType;
                if (!type) return;
                edgeVisibility[type] = !edgeVisibility[type];
                item.classList.toggle('dle-graph-legend-item--disabled', !edgeVisibility[type]);
                dbg(`Legend toggle: ${type} → ${edgeVisibility[type] ? 'visible' : 'hidden'}`);
                gs.buildAdjacency();
                gs.needsDraw = true;
            };
            item.addEventListener('click', toggleEdge, lOpt);
            // BUG-AUDIT-H24: Enter/Space keyboard activation.
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEdge(); }
            }, lOpt);
        });
    }

    // Mirror toolbar color-mode select → settings-panel color-mode select.
    if (colorModeEl) {
        colorModeEl.addEventListener('change', () => {
            const gsColorMode = document.getElementById('dle-gs-color-mode');
            if (gsColorMode) gsColorMode.value = gs.colorMode;
        }, lOpt);
    }

    return { exportPNG, exportJSON };
}
