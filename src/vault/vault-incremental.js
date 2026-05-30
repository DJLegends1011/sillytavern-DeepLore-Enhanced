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
import { escapeRegex } from '../../core/utils.js';

// BM25 K1/B constants live in bm25.js and aren't needed here — incremental
// update only manipulates df, idf, postings; it doesn't recompute scores.

/** Mirror bm25.js bm25DocId(). Re-declared here so this module stays pure. */
export function bm25DocId(entry) {
    return `${entry.vaultSource || ''}\0${entry.filename || entry.title}`;
}

/**
 * Mirror state.js `trackerKey(entry)` (`vaultSource:title`). Re-declared here so
 * this module stays pure (no ST-state import). The mentionWeights IDENTITY/storage
 * keys MUST use this so same-titled entries across vaults don't collide (gotcha
 * #50). Search-TERMS (names/targetNames) stay title/keys-based by design.
 */
function keyOf(entry) {
    return `${entry.vaultSource || ''}:${entry.title}`;
}

/**
 * Canonical full mentionWeights builder — the SINGLE source of truth for the
 * full-rebuild mention-weights computation (R6, 2026-05-29).
 *
 * Both production (`computeDerivedIndexFields` in vault.js, the `weights === null`
 * branch) and the equivalence tests call THIS function, so they can no longer
 * drift. Pure (no ST imports) — vault.js imports it; the test harness import()s it
 * directly. Output is byte-identical to the pre-R6 inline production block (pinned
 * by test/vault.test.mjs section L equivalence + section P T-L6a).
 *
 * IDENTITY/storage keys use keyOf (vaultSource:title) — same as state.js
 * `trackerKey` — so same-titled cross-vault entries don't collide (gotcha #50).
 * Search-TERMS (the regex name list) stay title/keys-based by design. contentLower
 * is pre-populated LAST-WRITE-WINS over `entries` (a same-keyOf duplicate's LAST
 * content wins — the L11 invariant the incremental path must match).
 *
 * Collapses gotcha #55's old "hand-sync 3 copies" mandate to TWO copies: this
 * shared full builder + the separate `incrementalMentionWeights` delta algorithm
 * (a genuinely different algorithm, still pinned to this builder by section L).
 *
 * @param {Array} entries — VaultEntry array
 * @returns {Map<string, number>} `${sourceKeyOf}\0${targetKeyOf}` → match count
 */
export function buildFullMentionWeights(entries) {
    const weights = new Map();
    // IDENTITY/storage keyed by keyOf (vaultSource:title); search-TERMS stay
    // title/keys-based. See keyOf() note above.
    const targetNames = new Map(); // keyOf → string[]
    for (const entry of entries) {
        const names = [entry.title.toLowerCase()];
        for (const key of entry.keys) {
            const keyLc = key.toLowerCase();
            if (keyLc.length >= 2) names.push(keyLc);
        }
        targetNames.set(keyOf(entry), names);
    }
    const targetRegexes = new Map(); // keyOf → regex
    for (const [key, names] of targetNames) {
        targetRegexes.set(key, buildTargetRegex(names));
    }
    const contentLower = new Map(); // keyOf → lowered content (last-write-wins)
    for (const source of entries) {
        contentLower.set(keyOf(source), source.content.toLowerCase());
    }
    for (const source of entries) {
        const sourceKey = keyOf(source);
        const content = contentLower.get(sourceKey);
        for (const [targetKey, regex] of targetRegexes) {
            if (targetKey === sourceKey) continue;
            const count = countMatches(regex, content);
            if (count > 0) weights.set(`${sourceKey}\0${targetKey}`, count);
        }
    }
    return weights;
}

/**
 * Reference alias for the equivalence tests + any legacy importer. Identical to
 * `buildFullMentionWeights` — the "reference copy" and production are now the SAME
 * function (R6). T-L6a (test/vault.test.mjs section P) guards that production calls
 * this shared builder rather than reimplementing the algorithm inline.
 */
export const fullMentionWeights = buildFullMentionWeights;

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
// The full algorithm in `computeDerivedIndexFields` is (IDENTITY keyed by
// keyOf = vaultSource:title; search-TERMS title/keys-based — gotcha #50):
//   For each target entry T:
//     names[T] = [title, ...keys with length>=2] (lowercased)   ← search-terms
//     regex[T] = combined regex matching any of names[T] (word-bounded when name<=3)
//   For each source entry S:
//     contentLower[keyOf(S)] = S.content.toLowerCase()
//   For each (S, T) where keyOf(S) !== keyOf(T):
//     count = number of regex[T] matches in contentLower[keyOf(S)]
//     if count > 0: weights[`${keyOf(S)}\0${keyOf(T)}`] = count
//
// Key insight: a change to entry X (identified by keyOf(X)) invalidates exactly:
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
        const escaped = escapeRegex(name);
        return name.length <= 3 ? `\\b${escaped}\\b` : escaped;
    });
    parts.sort((a, b) => b.length - a.length);
    return new RegExp(parts.join('|'), 'gi');
}

/**
 * PERF (L5, 2026-05-29): module-scoped cache of compiled mention-target regexes,
 * reused ACROSS incremental builds. Mirrors `incrementalEntityRegexes`'s
 * `prevRegexes` reuse pattern, but kept inside this module because
 * `incrementalMentionWeights` returns a plain Map (its caller can't thread a
 * regex map back in without a signature change, which would break the L*
 * equivalence tests + vault.js caller).
 *
 * Before this, a single-entry change recompiled a combined regex for EVERY entry
 * in the vault on every call (the `allTargetRegexes` pass below), defeating the
 * incremental win. Now we recompile only when an entry's regex INPUTS changed.
 *
 * Correctness: the cached compiled RegExp is a pure function of `buildTargetNames
 * (entry)` (title + keys>=2, lowercased) — so reuse is byte-identical to a fresh
 * compile. We guard on a names-signature, NOT just keyOf, so a rename/keys-change
 * (same keyOf, different names) recompiles. The /g regexes are stateful
 * (`lastIndex`), but every read goes through `countMatches`, which resets
 * `lastIndex` first — so sharing one instance across calls is safe. Capacity is
 * bounded with a soft LRU-ish trim to avoid unbounded growth across many distinct
 * vaults (e.g. across test runs).
 */
const _targetRegexCache = new Map(); // keyOf → { sig, regex }
const TARGET_REGEX_CACHE_MAX = 4096;

/** Stable signature of a target's regex inputs (title + keys>=2, lowercased). */
function targetNamesSignature(names) {
    return names.join('\0');
}

/**
 * Return the combined target regex for an entry, reusing the cached compiled
 * instance when the entry's names are unchanged since the last build.
 */
function getTargetRegex(entry, key) {
    const names = buildTargetNames(entry);
    const sig = targetNamesSignature(names);
    const hit = _targetRegexCache.get(key);
    if (hit && hit.sig === sig) {
        // Refresh recency (Map insertion order ≈ LRU for the trim below).
        _targetRegexCache.delete(key);
        _targetRegexCache.set(key, hit);
        return hit.regex;
    }
    const regex = buildTargetRegex(names);
    _targetRegexCache.set(key, { sig, regex });
    if (_targetRegexCache.size > TARGET_REGEX_CACHE_MAX) {
        // Evict oldest insertions until back under cap.
        const overflow = _targetRegexCache.size - TARGET_REGEX_CACHE_MAX;
        let i = 0;
        for (const k of _targetRegexCache.keys()) {
            if (i++ >= overflow) break;
            _targetRegexCache.delete(k);
        }
    }
    return regex;
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

    // Set of IDENTITY keys (keyOf = vaultSource:title) whose ROW and COL need
    // recompute. We treat add/remove/modify identically — any change to entry X
    // invalidates both axes for X. Keying by keyOf (not bare title) keeps
    // same-titled cross-vault entries distinct (gotcha #50).
    const dirtyKeys = new Set();
    for (const e of diff.added) dirtyKeys.add(keyOf(e));
    for (const e of diff.removed) dirtyKeys.add(keyOf(e));
    for (const e of diff.modified) dirtyKeys.add(keyOf(e));
    // A modified entry might have RENAMED (or been re-homed to another vault).
    // The old identity's row and column are also stale — purge them so a
    // follow-up scan from the new identity doesn't leave orphan rows/cols.
    for (let i = 0; i < diff.modified.length; i++) {
        const oldKey = keyOf(diff.modifiedPrev[i]);
        if (oldKey !== keyOf(diff.modified[i])) dirtyKeys.add(oldKey);
    }

    if (dirtyKeys.size === 0) return weights;

    // 1. Purge ALL existing entries touching any dirty key (row OR col).
    //    Cheap iteration vs the alternative of rebuilding from scratch.
    for (const key of [...weights.keys()]) {
        const nullIdx = key.indexOf('\0');
        const src = key.slice(0, nullIdx);
        const tgt = key.slice(nullIdx + 1);
        if (dirtyKeys.has(src) || dirtyKeys.has(tgt)) {
            weights.delete(key);
        }
    }

    // 2. Build target regexes ONLY for dirty targets (others reuse cached).
    //    But for the COL recomputation we also need to scan unchanged sources
    //    against the dirty target's regex, so we still need every dirty
    //    target's regex even if no source changed.
    //    NOTE (L5): `getTargetRegex` returns the module-cached compiled regex
    //    when an entry's names are unchanged. Dirty entries whose names changed
    //    (title/keys) recompile (signature miss) — so this is still correct.
    const newKeySet = new Set(newEntries.map(e => keyOf(e)));
    const dirtyTargetRegexes = new Map(); // target keyOf → combined regex
    for (const entry of newEntries) {
        const k = keyOf(entry);
        if (dirtyKeys.has(k)) {
            dirtyTargetRegexes.set(k, getTargetRegex(entry, k));
        }
    }

    // 3. Pre-lowercase content for every source we'll scan. Two passes:
    //    - Pass A (rows): for every dirty SOURCE, scan against EVERY target's regex.
    //    - Pass B (cols): for every dirty TARGET, scan from every NON-DIRTY source
    //                     against that target's regex (dirty sources already covered
    //                     in pass A).
    //    We share a contentLower cache (keyed by keyOf) across both passes.
    //
    //    Pre-populate LAST-WRITE-WINS over newEntries, exactly mirroring the full
    //    path (vault.js: `for (const source of entries) contentLower.set(
    //    trackerKey(source), source.content.toLowerCase())`). When two entries
    //    share a keyOf (`vaultSource:title` — e.g. same-vault same-title
    //    duplicates kept under multiVaultConflictResolution='all'), the LAST
    //    one's content must win so a cold (incremental) build matches a warm
    //    (full) rebuild. A lazy first-write-wins memo here diverged from full
    //    (review finding L11 / gotcha): incremental sourced the FIRST duplicate's
    //    content while full sourced the LAST → silent mention-ranking drift.
    const contentLower = new Map();
    for (const source of newEntries) {
        contentLower.set(keyOf(source), source.content.toLowerCase());
    }
    const lowerOf = (entry) => {
        const k = keyOf(entry);
        let c = contentLower.get(k);
        if (c == null) {
            c = entry.content.toLowerCase();
            contentLower.set(k, c);
        }
        return c;
    };

    // For pass A we need EVERY target's regex (because a dirty source scans all
    // targets). Non-dirty targets reuse the module-cached compiled regex
    // (`getTargetRegex` — L5 perf: a single-entry change no longer recompiles a
    // regex for every entry in the vault). Build only if there are any dirty
    // sources; if no dirty sources exist, pass A is a no-op.
    let allTargetRegexes = null;
    const dirtySourcesExist = newEntries.some(e => dirtyKeys.has(keyOf(e)));
    if (dirtySourcesExist) {
        allTargetRegexes = new Map();
        for (const target of newEntries) {
            const tKey = keyOf(target);
            if (dirtyTargetRegexes.has(tKey)) {
                allTargetRegexes.set(tKey, dirtyTargetRegexes.get(tKey));
            } else {
                allTargetRegexes.set(tKey, getTargetRegex(target, tKey));
            }
        }
    }

    // Pass A: dirty source scans all targets
    if (allTargetRegexes) {
        for (const source of newEntries) {
            const sourceKey = keyOf(source);
            if (!dirtyKeys.has(sourceKey)) continue;
            const content = lowerOf(source);
            for (const [targetKey, regex] of allTargetRegexes) {
                if (targetKey === sourceKey) continue;
                const count = countMatches(regex, content);
                if (count > 0) weights.set(`${sourceKey}\0${targetKey}`, count);
            }
        }
    }

    // Pass B: every dirty target scanned from non-dirty sources
    for (const [targetKey, regex] of dirtyTargetRegexes) {
        for (const source of newEntries) {
            const sourceKey = keyOf(source);
            if (dirtyKeys.has(sourceKey)) continue; // covered by pass A
            if (sourceKey === targetKey) continue;
            const content = lowerOf(source);
            const count = countMatches(regex, content);
            if (count > 0) weights.set(`${sourceKey}\0${targetKey}`, count);
        }
    }

    // Final cleanup: if the previous index had weights to identities no longer in
    // the new entry set, the purge in step 1 already removed them (they're in
    // dirtyKeys via the removed[] list). But if a previous source/target
    // disappeared WITHOUT going through dirtyKeys (defensive — shouldn't
    // happen given diffEntries semantics), drop them now.
    for (const key of [...weights.keys()]) {
        const nullIdx = key.indexOf('\0');
        const src = key.slice(0, nullIdx);
        const tgt = key.slice(nullIdx + 1);
        if (!newKeySet.has(src) || !newKeySet.has(tgt)) {
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
 * `buildBM25Index(newEntries)` — equivalence is enforced by test L4 + T-L5.
 *
 * PERF (L5, 2026-05-29): the index produced here CARRIES `df` and `totalLen`
 * so a follow-up incremental call reuses them with zero rebuild. addDoc/removeDoc
 * mutate both as they go (they already adjusted df/len locally). Previously this
 * re-derived `df` by walking every doc's every term and re-summed `totalLen`
 * over all docs on EVERY call (O(total tokens)) — pure throwaway work that
 * defeated the point of an incremental update. When the prior index lacks the
 * carried fields (it came from a full `buildBM25Index`, which returns no `df`/
 * `totalLen`, or from an older cache), we derive them ONCE: df from posting-list
 * sizes (`df.get(term) === invertedIndex.get(term).size` by construction — no
 * per-doc term walk needed) and totalLen by summing doc.len. The output remains
 * byte-identical to a full rebuild either way; `df`/`totalLen` are extra fields
 * the BM25 scorer ignores.
 *
 * @param {object} prevIndex — { idf, docs, avgDl, invertedIndex, [df], [totalLen] }
 * @param {{added: Array, removed: Array, modified: Array, modifiedPrev: Array}} diff
 * @returns {object} new BM25 index (carries `df` + `totalLen` for the next call)
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
    const invertedIndex = new Map();
    for (const [term, posting] of prevIndex.invertedIndex) {
        invertedIndex.set(term, new Set(posting));
    }

    // Carry df + totalLen from the prior index when present (it came from a
    // previous incrementalBM25Update). Otherwise derive ONCE — df straight from
    // posting-list sizes (df === posting.size by construction; no need to walk
    // every doc's every term), totalLen by summing doc.len. Subsequent
    // add/remove mutate these in place, so the expensive rebuild never repeats.
    let df;
    let totalLen;
    if (prevIndex.df instanceof Map && typeof prevIndex.totalLen === 'number') {
        df = new Map(prevIndex.df);
        totalLen = prevIndex.totalLen;
    } else {
        df = new Map();
        for (const [term, posting] of invertedIndex) df.set(term, posting.size);
        totalLen = 0;
        for (const doc of docs.values()) totalLen += doc.len;
    }

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
    // complexity to track which terms moved. (df === invertedIndex posting size
    // by construction — invariant L5-inv1.)
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
        // Carry df + totalLen so the NEXT incremental call skips the rebuild.
        df,
        totalLen,
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
            const escaped = escapeRegex(name);
            regexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
        }
    }

    return { names, regexes };
}
