/**
 * Tiny shared graph utilities. MUST stay dependency-free (no ST imports) so the
 * pure-engine modules that import it (graph-health, etc.) remain Node.js-testable.
 */

/** HTML-escape for innerHTML interpolation of user-controlled strings. */
export const escapeHtml = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The canonical "should this node be hidden in the resting force layout" rule: orphan, or a
 * reveal batch that hasn't rolled in yet. Both exitFocusTree and exitDagLayout restore visibility
 * through this so the two non-force layouts can't drift apart. Pure (takes revealedBatch) so it's
 * unit-testable and ST-free.
 */
export function isRehidden(n, revealedBatch) {
    return n.orphan
        || (n.revealBatchIdx != null && n.revealBatchIdx >= revealedBatch && n.revealBatchIdx !== -1);
}
