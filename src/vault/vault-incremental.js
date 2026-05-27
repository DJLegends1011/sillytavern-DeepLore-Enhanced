/**
 * DeepLore Enhanced — Incremental Derived-State Updates (P3 / 2026-05-22)
 *
 * Pure helpers (no SillyTavern globals) that update mentionWeights, BM25, and
 * entityShortNameRegexes for a small diff between two entry sets instead of
 * rebuilding from scratch.
 *
 * Why these exist: `finalizeIndex` is called from both `buildIndex` (full
 * rebuild) and `buildIndexWithReuse` (small diff sync-poll path). The full-
 * rebuild math is O(N²) for mentionWeights and O(N) for BM25 tokenization;
 * running it on every sync-poll defeats the entire point of reuse-sync (the
 * whole reason reuse-sync exists is to skip O(N) work when only a couple of
 * entries changed).
 *
 * Correctness contract: the incremental output MUST be byte-identical to a
 * full rebuild for the same final entry set. The equivalence tests in
 * `test/vault.test.mjs` section L pin this. Any deviation = silent search
 * ranking corruption (BM25) or wrong mention-score weights — both invisible
 * in normal use but degrade quality slowly over time.
 *
 * Fallback policy: callers pass a `threshold` (default 0.5). When the changed-
 * entry count exceeds that fraction of the total, full rebuild is faster
 * anyway and we should not pay the bookkeeping overhead. See
 * `shouldUseIncremental()`.
 */

import { tokenize } from './bm25.js';

// BM25 K1/B constants live in bm25.js and aren't needed here — incremental
// update only manipulates df, idf, postings; it doesn't recompute scores.

/** Mirror bm25.js bm25DocId(). Re-declared here so this module stays pure. */
export function bm25DocId(entry) {
    return `${entry.vaultSource || ''}\0${entry.filename || entry.title}`;
}

/**
 * Reference full mentionWeights builder — mirrors `computeDerivedIndexFields`'s
 * mentionWeights block in vault.js. Exists so the equivalence tests can compare
 * `incrementalMentionWeights(...)` against a known-good full rebuild without
 * pulling in ST imports. KEEP IN SYNC with vault.js if either path changes.
 */
export function fullMentionWeights(entries) {
    const weights = new Map();
    const targetNames = new Map();
    for (const entry of entries) {
        const names = [entry.title.toLowerCase()];
        for (const key of entry.keys) {
            const keyLc = key.toLowerCase();
            if (keyLc.length >= 2) names.push(keyLc);
        }
        targetNames.set(entry.title, names);
    }
    const targetRegexes = new Map();
    for (const [title, names] of targetNames) {
        targetRegexes.set(title, buildTargetRegex(names));
    }
    const contentLower = new Map();
    for (const source of entries) {
        contentLower.set(source.title, source.content.toLowerCase());
    }
    for (const source of entries) {
        const content = contentLower.get(source.title);
        for (const [targetTitle, regex] of targetRegexes) {
            if (targetTitle === source.title) continue;
            const count = countMatches(regex, content);
            if (count > 0) weights.set(`${source.title}\0${targetTitle}`, count);
        }
    }
    return weights;
}

/**
 * Decide whether incremental updates are worthwhile.
 * @param {number} changedCount  — entries added + removed + modified
 * @param {number} totalCount    — size of the NEW entry set
 * @param {number} [threshold=0.5] — fraction above which full rebuild wins
 * @returns {boolean}
 */
export function shouldUseIncremental(changedCount, totalCount, threshold = 0.5) {
    if (totalCount === 0) return false;
    if (changedCount === 0) return true; // best case — no work needed
    return changedCount / totalCount <= threshold;
}

/**
 * Diff two entry arrays by trackerKey-equivalent identity (vaultSource:title).
 *
 * Returns the three buckets the incremental algorithms need:
 *   - `added`: present in newEntries, absent from prevEntries (by docId).
 *   - `removed`: present in prevEntries, absent from newEntries.
 *   - `modified`: docId in both, but content/keys/title differ.
 *
 * Identity is `vaultSource\0filename` (bm25DocId) — same as BM25's unique key
 * because filename + vaultSource is the only invariant across rebuilds. Title
 * is *part* of the content/keys diff (rename-without-filename-change is rare
 * but valid; we treat it as a modification).
 *
 * @param {Array} prevEntries
 * @param {Array} newEntries
 * @returns {{added: Array, removed: Array, modified: Array, modifiedPrev: Array}}
 *   `modifiedPrev` is the prior entry that corresponds to each `modified[i]`,
 *   so the BM25 delta can subtract the old TF before adding the new one.
 */
export function diffEntries(prevEntries, newEntries) {
    const prevMap = new Map();
    for (const e of prevEntries) prevMap.set(bm25DocId(e), e);
    const newMap = new Map();
    for (const e of newEntries) newMap.set(bm25DocId(e), e);

    const added = [];
    const modified = [];
    const modifiedPrev = [];
    for (const e of newEntries) {
        const id = bm25DocId(e);
        const prev = prevMap.get(id);
        if (!prev) {
            added.push(e);
        } else if (
            prev._contentHash !== e._contentHash ||
            prev.title !== e.title ||
            JSON.stringify(prev.keys) !== JSON.stringify(e.keys)
        ) {
            modified.push(e);
            modifiedPrev.push(prev);
        }
    }
    const removed = [];
    for (const e of prevEntries) {
        if (!newMap.has(bm25DocId(e))) removed.push(e);
    }
    return { added, removed, modified, modifiedPrev };
}

// ============================================================================
// A. Incremental mentionWeights
// ============================================================================
//
// The full algorithm in `computeDerivedIndexFields` is:
//   For each target entry T:
//     names[T] = [title, ...keys with length>=2] (lowercased)
//     regex[T] = combined regex matching any of names[T] (word-bounded when name<=3)
//   For each source entry S:
//     contentLower[S] = S.content.toLowerCase()
//   For each (S, T) where S.title !== T.title:
//     count = number of regex[T] matches in contentLower[S]
//     if count > 0: weights[`${S.title}\0${T.title}`] = count
//
// Key insight: a change to entry X invalidates exactly:
//   - the ROW {X → *}  (X's content changed → all matches X→T are stale)
//   - the COL {* → X}  (X's title or keys changed → regex[X] is stale, every
//                       source's contribution to X needs rescan)
//
// For a title-only / keys-only change, the COL needs recompute but the ROW
// doesn't (X's content is unchanged, only its keys/title changed). For a
// content-only change, the ROW needs recompute but COL doesn't.
//
// We don't try to distinguish — simpler to always invalidate both axes for
// any modified entry. The cost is one extra row+col per modified entry,
// negligible vs full rebuild.

/** Build the lowercased name list for one entry (title + keys >= 2 chars). */
function buildTargetNames(entry) {
    const names = [entry.title.toLowerCase()];
    for (const key of entry.keys) {
        const keyLc = key.toLowerCase();
        if (keyLc.length >= 2) names.push(keyLc);
    }
    return names;
}

/** Compose one combined regex from a target's name list. Word-bounded for short names. */
function buildTargetRegex(names) {
    const parts = names.map(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return name.length <= 3 ? `\\b${escaped}\\b` : escaped;
    });
    parts.sort((a, b) => b.length - a.length);
    return new RegExp(parts.join('|'), 'gi');
}

/**
 * Count regex matches in lowered content. Same algorithm as the full path:
 * lastIndex-reset loop on a /g regex.
 */
function countMatches(regex, contentLower) {
    regex.lastIndex = 0;
    let count = 0;
    while (regex.exec(contentLower) !== null) count++;
    return count;
}

/**
 * Incrementally update mentionWeights for a small diff. Mirrors the math in
 * `computeDerivedIndexFields` precisely — equivalence is enforced by test L1.
 *
 * @param {Map<string, number>} prevWeights — previous `${source}\0${target}` map
 * @param {Array} prevEntries — entries before the diff (parallel to prevWeights)
 * @param {Array} newEntries  — entries after the diff
 * @param {{added: Array, removed: Array, modified: Array, modifiedPrev: Array}} diff
 * @returns {Map<string, number>} fresh weights Map
 */
export function incrementalMentionWeights(prevWeights, prevEntries, newEntries, diff) {
    const weights = new Map(prevWeights); // start from previous

    // Set of titles whose ROW and COL need recompute. We treat add/remove/modify
    // identically — any change to entry X invalidates both axes for X.
    const dirtyTitles = new Set();
    for (const e of diff.added) dirtyTitles.add(e.title);
    for (const e of diff.removed) dirtyTitles.add(e.title);
    for (const e of diff.modified) dirtyTitles.add(e.title);
    // A modified entry might have RENAMED. The old title's row and column are
    // also stale — purge them so a follow-up scan from the new title doesn't
    // leave orphan rows/cols around the old title.
    for (let i = 0; i < diff.modified.length; i++) {
        const oldTitle = diff.modifiedPrev[i].title;
        if (oldTitle !== diff.modified[i].title) dirtyTitles.add(oldTitle);
    }

    if (dirtyTitles.size === 0) return weights;

    // 1. Purge ALL existing entries touching any dirty title (row OR col).
    //    Cheap iteration vs the alternative of rebuilding from scratch.
    for (const key of [...weights.keys()]) {
        const nullIdx = key.indexOf('\0');
        const src = key.slice(0, nullIdx);
        const tgt = key.slice(nullIdx + 1);
        if (dirtyTitles.has(src) || dirtyTitles.has(tgt)) {
            weights.delete(key);
        }
    }

    // 2. Build target regexes ONLY for dirty targets (others reuse cached).
    //    But for the COL recomputation we also need to scan unchanged sources
    //    against the dirty target's regex, so we still need every dirty
    //    target's regex even if no source changed.
    const newTitleSet = new Set(newEntries.map(e => e.title));
    const dirtyTargetRegexes = new Map(); // target title → combined regex
    for (const entry of newEntries) {
        if (dirtyTitles.has(entry.title)) {
            dirtyTargetRegexes.set(entry.title, buildTargetRegex(buildTargetNames(entry)));
        }
    }

    // 3. Pre-lowercase content for every source we'll scan. Two passes:
    //    - Pass A (rows): for every dirty SOURCE, scan against EVERY target's regex.
    //    - Pass B (cols): for every dirty TARGET, scan from every NON-DIRTY source
    //                     against that target's regex (dirty sources already covered
    //                     in pass A).
    //    We share a contentLower cache across both passes.
    const contentLower = new Map();
    const lowerOf = (entry) => {
        let c = contentLower.get(entry.title);
        if (c == null) {
            c = entry.content.toLowerCase();
            contentLower.set(entry.title, c);
        }
        return c;
    };

    // For pass A we need EVERY target's regex (because a dirty source scans all
    // targets). Build any missing target regexes lazily — but only if there are
    // any dirty sources. If no dirty sources exist, pass A is a no-op.
    let allTargetRegexes = null;
    const dirtySourcesExist = newEntries.some(e => dirtyTitles.has(e.title));
    if (dirtySourcesExist) {
        allTargetRegexes = new Map();
        for (const target of newEntries) {
            if (dirtyTargetRegexes.has(target.title)) {
                allTargetRegexes.set(target.title, dirtyTargetRegexes.get(target.title));
            } else {
                allTargetRegexes.set(target.title, buildTargetRegex(buildTargetNames(target)));
            }
        }
    }

    // Pass A: dirty source scans all targets
    if (allTargetRegexes) {
        for (const source of newEntries) {
            if (!dirtyTitles.has(source.title)) continue;
            const content = lowerOf(source);
            for (const [targetTitle, regex] of allTargetRegexes) {
                if (targetTitle === source.title) continue;
                const count = countMatches(regex, content);
                if (count > 0) weights.set(`${source.title}\0${targetTitle}`, count);
            }
        }
    }

    // Pass B: every dirty target scanned from non-dirty sources
    for (const [targetTitle, regex] of dirtyTargetRegexes) {
        for (const source of newEntries) {
            if (dirtyTitles.has(source.title)) continue; // covered by pass A
            if (source.title === targetTitle) continue;
            const content = lowerOf(source);
            const count = countMatches(regex, content);
            if (count > 0) weights.set(`${source.title}\0${targetTitle}`, count);
        }
    }

    // Final cleanup: if the previous index had weights to titles no longer in
    // the new entry set, the purge in step 1 already removed them (they're in
    // dirtyTitles via the removed[] list). But if a previous source/target
    // disappeared WITHOUT going through dirtyTitles (defensive — shouldn't
    // happen given diffEntries semantics), drop them now.
    for (const key of [...weights.keys()]) {
        const nullIdx = key.indexOf('\0');
        const src = key.slice(0, nullIdx);
        const tgt = key.slice(nullIdx + 1);
        if (!newTitleSet.has(src) || !newTitleSet.has(tgt)) {
            weights.delete(key);
        }
    }

    return weights;
}

// ============================================================================
// B. Incremental BM25
// ============================================================================
//
// Index shape: { idf: Map<term, number>, docs: Map<docId, {tf, len, entry}>,
//                avgDl: number, invertedIndex: Map<term, Set<docId>> }
//
// IDF formula:  log((N - df + 0.5) / (df + 0.5) + 1)
//
// Two delta scenarios:
//   - PURE MODIFIED (no add/remove): N unchanged, df may shift per term.
//     Only terms whose df actually changed need IDF recompute.
//   - ADDED OR REMOVED: N changes → ALL IDF values shift → must recompute IDF
//     for every term. Adds/removes are usually small enough that the IDF pass
//     is still vastly cheaper than re-tokenizing every doc.

/** Compute TF map + token length for one entry (matches buildBM25Index's per-doc loop). */
export function computeEntryBM25TF(entry) {
    const text = `${entry.title} ${entry.keys.join(' ')} ${entry.content}`;
    const tokens = tokenize(text);
    const tf = new Map();
    for (const token of tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
    }
    return { tf, len: tokens.length };
}

/**
 * Apply an incremental delta to a BM25 index. Returns a fresh index object
 * (does not mutate the input). The output is byte-equivalent to a full
 * `buildBM25Index(newEntries)` — equivalence is enforced by test L4.
 *
 * @param {object} prevIndex — { idf, docs, avgDl, invertedIndex }
 * @param {{added: Array, removed: Array, modified: Array, modifiedPrev: Array}} diff
 * @returns {object} new BM25 index
 */
export function incrementalBM25Update(prevIndex, diff) {
    // Defensive: if the prior index has no inverted index (pre-H-12) fall back
    // to a full rebuild via the caller. We can't reliably incremental-update
    // without the inverted index for fast posting-list maintenance.
    if (!prevIndex || !prevIndex.invertedIndex) {
        return null; // signal: caller should full-rebuild
    }

    // Clone the structural pieces so the input remains untouched (defensive —
    // future callers might still hold a reference to the previous index).
    const docs = new Map(prevIndex.docs);
    const df = new Map();
    // Reconstruct df from previous idf? Not possible — idf is derived FROM df,
    // not vice versa. Instead, derive it from the prevIndex's docs by inverse:
    // for each doc, increment df once per unique term in tf.
    for (const doc of docs.values()) {
        for (const term of doc.tf.keys()) {
            df.set(term, (df.get(term) || 0) + 1);
        }
    }
    const invertedIndex = new Map();
    for (const [term, posting] of prevIndex.invertedIndex) {
        invertedIndex.set(term, new Set(posting));
    }
    let totalLen = 0;
    for (const doc of docs.values()) totalLen += doc.len;

    // Remove obsolete docs first (removed + modified-prev).
    const removeDoc = (entry) => {
        const id = bm25DocId(entry);
        const doc = docs.get(id);
        if (!doc) return;
        for (const term of doc.tf.keys()) {
            const newDf = (df.get(term) || 0) - 1;
            if (newDf <= 0) {
                df.delete(term);
                invertedIndex.delete(term);
            } else {
                df.set(term, newDf);
                const posting = invertedIndex.get(term);
                if (posting) {
                    posting.delete(id);
                    if (posting.size === 0) invertedIndex.delete(term);
                }
            }
        }
        totalLen -= doc.len;
        docs.delete(id);
    };

    for (const e of diff.removed) removeDoc(e);
    for (const e of diff.modifiedPrev) removeDoc(e);

    // Add new + modified docs.
    const addDoc = (entry) => {
        const id = bm25DocId(entry);
        const { tf, len } = computeEntryBM25TF(entry);
        docs.set(id, { tf, len, entry });
        totalLen += len;
        for (const term of tf.keys()) {
            df.set(term, (df.get(term) || 0) + 1);
            let posting = invertedIndex.get(term);
            if (!posting) {
                posting = new Set();
                invertedIndex.set(term, posting);
            }
            posting.add(id);
        }
    };

    for (const e of diff.added) addDoc(e);
    for (const e of diff.modified) addDoc(e);

    const N = docs.size;
    const idf = new Map();
    // Always recompute ALL idf — N likely changed (if added/removed nonzero)
    // and even for pure-modified case the df shift can be widespread. The cost
    // (one log per term) is dwarfed by tokenization savings; not worth the
    // complexity to track which terms moved.
    if (N > 0) {
        for (const [term, freq] of df) {
            idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
        }
    }

    return {
        idf,
        docs,
        avgDl: N > 0 ? totalLen / N : 0,
        invertedIndex,
    };
}

// ============================================================================
// C. Incremental entityShortNameRegexes
// ============================================================================
//
// computeEntityDerivedState rebuilds both the Set and the Map for every entry
// every time. Incrementally we can:
//   - Compute the OLD name set from `prevEntries`
//   - Compute the NEW name set from `newEntries`
//   - For names removed: delete from regex map
//   - For names added: compile new regex (or reuse from prev if it was in
//     prevRegexes — a name can be added by entry X and unchanged from entry Y)
//
// The "reuse from prev" path matters because two entries might share a key
// like "fire" — removing one entry shouldn't drop "fire" from the regex map
// if another entry still uses it. We compute the new set from full newEntries
// to be safe.

/** Lowercase title + keys (>=2 chars) for one entry, same as full path. */
function entryEntityNames(entry) {
    const out = [];
    if (entry.title.length >= 1) out.push(entry.title.toLowerCase());
    for (const key of entry.keys) {
        if (key.length >= 2) out.push(key.toLowerCase());
    }
    return out;
}

/**
 * Incrementally update entityNameSet + entityShortNameRegexes.
 *
 * Reuses already-compiled regexes from `prevRegexes` when the name still
 * appears in the new set. The regex math is `\b<escaped>\b`/i — pure derived
 * from the name string, so reuse is safe (same name → byte-identical regex).
 *
 * Returns { names: Set, regexes: Map } so the caller can call the two state
 * setters atomically.
 *
 * @param {Array} newEntries
 * @param {Map<string, RegExp>} prevRegexes — to reuse compiled regexes when possible
 * @returns {{names: Set<string>, regexes: Map<string, RegExp>}}
 */
export function incrementalEntityRegexes(newEntries, prevRegexes) {
    const names = new Set();
    for (const entry of newEntries) {
        for (const n of entryEntityNames(entry)) names.add(n);
    }

    const regexes = new Map();
    for (const name of names) {
        const existing = prevRegexes && prevRegexes.get(name);
        if (existing) {
            regexes.set(name, existing); // reuse compiled regex byte-for-byte
        } else {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
        }
    }

    return { names, regexes };
}
