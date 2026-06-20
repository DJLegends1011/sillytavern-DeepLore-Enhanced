/**
 * DeepLore Enhanced — BM25 Fuzzy Search Index
 * Pure (no ST globals). _debugMode injected by vault.js via setDebugMode().
 */
let _debugMode = false;
export function setDebugMode(val) { _debugMode = !!val; }

/**
 * BUG-369: docId must be unique WITHIN a vault. trackerKey (`vaultSource:title`)
 * collides on same-titled entries in one vault, silently dropping one from the
 * search index. Filename is unique within a vault, so use `vaultSource\0filename`.
 */
function bm25DocId(entry) {
    return `${entry.vaultSource || ''}\0${entry.filename || entry.title}`;
}

const BM25_K1 = 1.5;   // term frequency saturation
const BM25_B = 0.75;   // length normalization
const TOKENIZE_SPLIT_RE = /[^\p{L}\p{N}]+/u;

/** Lowercase, split on non-word, drop short tokens. Unicode-aware so non-Latin
 *  scripts (Cyrillic, Arabic, etc.) work. CJK without spaces produces long
 *  unsplit tokens — proper CJK tokenization (n-grams) is out of scope. */
export function tokenize(text) {
    return text.normalize('NFC').toLowerCase().split(TOKENIZE_SPLIT_RE).filter(t => t.length >= 2);
}

/**
 * Build a BM25 index from vault entries.
 * Each "document" is the concatenation of entry title, keys, and content.
 * @param {Array} entries - VaultEntry array
 * @returns {{ idf: Map<string, number>, docs: Map<string, {tf: Map<string, number>, len: number, entry: object}>, avgDl: number }}
 */
export function buildBM25Index(entries) {
    const N = entries.length;
    if (N === 0) return { idf: new Map(), docs: new Map(), avgDl: 0 };

    const df = new Map();
    const docs = new Map();
    let totalLen = 0;

    for (const entry of entries) {
        // L-7: guard non-array `keys` — one bad entry would throw mid-loop and nuke the
        // entire BM25 build. `[].join(' ') === ''`, so this is byte-identical when keys
        // IS an array (preserves the incremental≡full equivalence in vault-incremental.js).
        const text = `${entry.title} ${Array.isArray(entry.keys) ? entry.keys.join(' ') : ''} ${entry.content}`;
        const tokens = tokenize(text);
        const tf = new Map();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        docs.set(bm25DocId(entry), { tf, len: tokens.length, entry });
        totalLen += tokens.length;

        for (const term of tf.keys()) {
            df.set(term, (df.get(term) || 0) + 1);
        }
    }

    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = new Map();
    for (const [term, freq] of df) {
        idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    }

    // H-12: inverted posting list so queryBM25 only iterates matching docs.
    const invertedIndex = new Map();
    for (const [docId, doc] of docs) {
        for (const term of doc.tf.keys()) {
            if (!invertedIndex.has(term)) invertedIndex.set(term, new Set());
            invertedIndex.get(term).add(docId);
        }
    }

    return { idf, docs, avgDl: totalLen / N, invertedIndex };
}

/**
 * Query the BM25 index with a text string. Returns scored entry titles.
 * @param {{ idf: Map, docs: Map, avgDl: number }} index
 * @param {string} queryText
 * @param {number} [topK=20] - Max results
 * @param {number} [minScore=0.5] - Minimum BM25 score threshold
 * @returns {Array<{title: string, score: number, entry: object}>}
 */
export function queryBM25(index, queryText, topK = 20, minScore = 0.5) {
    if (!index || index.docs.size === 0) return [];

    const queryTokens = tokenize(queryText);
    if (queryTokens.length === 0) return [];

    const _bm25Start = performance.now();

    // BUG-042: dedup query tokens (frequency wasn't used in scoring anyway).
    const queryTerms = new Set(queryTokens);

    const k1 = BM25_K1;
    const b = BM25_B;
    // L-8: avgDl can be 0 for an all-short-token vault (every doc tokenizes to 0 terms
    // ≥ 2 chars) — dividing by it below yields NaN scores and silent no-matches. Guard
    // with a finite fallback of 1 so the length-normalization stays defined. In the
    // currently-reachable all-empty case the `tf === 0` continue fires first, so this is
    // defensive hardening with no behavior change on any live path.
    const avgDl = index.avgDl > 0 ? index.avgDl : 1;
    const scores = [];

    // H-12: only score docs containing at least one query term.
    const candidateDocIds = new Set();
    if (index.invertedIndex) {
        for (const term of queryTerms) {
            const posting = index.invertedIndex.get(term);
            if (posting) {
                for (const docId of posting) candidateDocIds.add(docId);
            }
        }
    }
    const docsToScore = index.invertedIndex
        ? [...candidateDocIds].map(id => index.docs.get(id)).filter(Boolean)
        : [...index.docs.values()]; // fallback for pre-H-12 indexes

    for (const doc of docsToScore) {
        let score = 0;
        for (const term of queryTerms) {
            const termIdf = index.idf.get(term);
            if (!termIdf) continue;
            const tf = doc.tf.get(term) || 0;
            if (tf === 0) continue;
            const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.len / avgDl));
            score += termIdf * tfNorm;
        }
        if (score >= minScore) {
            // BUG-013: return entry.title, not the docId map key.
            scores.push({ title: doc.entry.title, score, entry: doc.entry });
        }
    }

    scores.sort((a, b) => b.score - a.score);
    const results = scores.slice(0, topK);
    const _bm25Ms = Math.round(performance.now() - _bm25Start);
    if (_debugMode) {
        console.debug('[DLE] BM25: query "%s" → %d hits in %dms (threshold: %s)', queryText?.slice(0, 40), results.length, _bm25Ms, minScore);
    }
    return results;
}
