# Vault & Indexing Internals

Code-level reference for Claude Code. Covers the full lifecycle from Obsidian fetch through IndexedDB persistence.

**Source files:**
- `src/vault/vault.js` — orchestrator (buildIndex, buildIndexWithReuse, hydrateFromCache, ensureIndexFresh, finalizeIndex)
- `src/vault/cache.js` — IndexedDB persistence (save/load/prune/clear)
- `src/vault/cache-validate.js` — pure entry validator (validateCachedEntry)
- `src/vault/obsidian-api.js` — HTTP fetch layer, circuit breaker, connection diagnostics
- `src/vault/bm25.js` — BM25 fuzzy search index (pure functions)
- `src/vault/vault-pure.js` — pure derived-state helpers (computeEntityDerivedState, deduplicateMultiVault, detectCrossVaultDuplicates)
- `src/vault/vault-incremental.js` — P3 incremental derived-state helpers (incrementalMentionWeights, incrementalBM25Update, incrementalEntityRegexes, diffEntries, shouldUseIncremental). Pure (no ST imports).
- `src/vault/sync.js` — sync polling loop (setupSyncPolling, showChangesToast)
- `src/vault/import.js` — World Info import bridge
- `core/pipeline.js` — parseVaultFile (frontmatter parsing, tag classification)
- `core/sync.js` — takeIndexSnapshot, detectChanges (pure snapshot diffing)

---

## 1. Vault Configuration

### `settings.vaults[]` shape

```javascript
{
    name: string,          // User-facing label (e.g. "Primary")
    host: string,          // IP or hostname (default "127.0.0.1")
    port: number,          // Obsidian Local REST API port (27123 HTTP, 27124 HTTPS)
    apiKey: string,        // Bearer token from Obsidian plugin settings
    https: boolean,        // Use HTTPS (requires OS-trusted cert, not just browser exception)
    enabled: boolean,      // Toggle without deleting config
}
```

Default in `settings.js`: `vaults: []` (in `defaultSettings`). Legacy single-vault fields (`obsidianPort`, `obsidianApiKey`) are migrated once into `vaults[0]` inline inside `getSettings()`, guarded by `s._vaultsMigrated` sentinel.

### Multi-vault support

All vault-aware code iterates `settings.vaults.filter(v => v.enabled)`. Vault order matters for:
- **Field definitions**: always loaded from `enabledVaults[0]` (the "primary" vault).
- **Conflict resolution** (`settings.multiVaultConflictResolution`): `all` | `first` | `last` | `merge`. Applied by `deduplicateMultiVault()` in `vault-pure.js`. Keyed by `entry.title.toLowerCase()`. H-05: merge mode now OR-merges boolean flags (`constant`, `seed`, `bootstrap`, `guide`).
- **Cross-vault duplicate detection**: `detectCrossVaultDuplicates()` runs before dedup in both `buildIndex()` and `buildIndexWithReuse()`. Shows a warning toast listing conflicting titles and vault sources. Duplicates are not forbidden at runtime but users are told to rename.

### `getPrimaryVault(settings)` (settings.js:getPrimaryVault())

Returns first enabled vault, or `vaults[0]`, or a fallback object `{ name: 'Default', host: '127.0.0.1', port: 27124, apiKey: '', https: true, enabled: false }`.

### `resolveWriteVault(toolKey, settings, overrideName?)` (settings.js)

Per-tool write destination. `toolKey` is `'librarian' | 'scribe' | 'autoSuggest'`. Precedence: `overrideName` (per-write picker) > `settings[{tool}WriteVaultId]` (configured default, a vault `name` string) > primary. Each step falls through cleanly if the named vault is missing or disabled — never throws. Use this instead of `getPrimaryVault()` at any AI-driven write site so the user can route Scribe / Auto Lorebook / Librarian writes to different vaults.

Settings keys: `librarianWriteVaultId`, `scribeWriteVaultId`, `autoSuggestWriteVaultId`. Value is the target `vault.name`; empty string means "use primary." Librarian additionally exposes a per-write picker in its review popup (visible only when 2+ vaults are enabled) which feeds `overrideName`.

### Field definitions source

Custom field definitions are loaded from a YAML file in the primary vault at `settings.fieldDefinitionsPath` (default `DeepLore/field-definitions.yaml`). Loaded via `fetchFieldDefinitions()` from obsidian-api.js. Both `buildIndex()` and `buildIndexWithReuse()` load them independently.

**Gotcha (BUG-305/BUG-008):** Field definitions are resolved into a local variable and published to state (`setFieldDefinitions()`) atomically alongside the new `vaultIndex`, never before parsing completes. This prevents a half-stale window where reused entries carry old schema but newly-parsed entries use the new one.

---

## 2. Boot Sequence

### Call graph

```
init()
  -> hydrateFromCache()
       -> loadIndexFromCache()           // IndexedDB read
       -> validateCachedEntry() per entry // structural check + backfill
       -> resolveLinks(vaultIndex)
       -> computeEntityDerivedState()    // entityNameSet, entityShortNameRegexes
       -> computeDerivedIndexFields()    // mentionWeights, folderList, vaultAvgTokens
       -> buildBM25Index()              // if fuzzy/librarian search enabled
       -> notifyIndexUpdated()
       -> buildIndex()                  // background, fire-and-forget with epoch guard

onGenerate(chat)
  -> ensureIndexFresh()
       -> buildIndexWithReuse()         // preferred: skip re-parse of unchanged
       -> buildIndex()                  // fallback if reuse fails or index empty
```

### `hydrateFromCache()` (vault.js:hydrateFromCache())

Instant startup path. Loads entries from IndexedDB, runs all derived-state computations so the first generation isn't degraded, then kicks off a background `buildIndex()` to validate against Obsidian.

**State written:** `vaultIndex`, `indexTimestamp` (set to 0 to force `ensureIndexFresh` rebuild), `entityNameSet`, `entityShortNameRegexes`, `mentionWeights`, `folderList`, `vaultAvgTokens`, `fuzzySearchIndex`.

**State NOT written:** `indexEverLoaded` -- intentionally left false until a real Obsidian fetch succeeds.

**Epoch guard:** Captures `chatEpoch` before the background `buildIndex()`. Both `.then()` and `.catch()` bail if `chatEpoch` changed mid-flight (BUG-377).

**Cache fallback:** If background `buildIndex()` fails but cached data exists, sets a short-lived timestamp (`Date.now() - ttl + 30s`) so `ensureIndexFresh()` retries soon rather than using stale cache forever.

### `buildPromise` deduplication (BUG-010)

Both `buildIndex()` and `buildIndexWithReuse()` use a deferred promise pattern:

```javascript
let _buildResolve, _buildReject;
const promise = new Promise((res, rej) => { _buildResolve = res; _buildReject = rej; });
setBuildPromise(promise);  // installed BEFORE setIndexing(true)
setIndexing(true);
```

This ensures that any synchronous observer seeing `indexing === true` always finds a populated `buildPromise`. The actual build runs in an IIFE that resolves/rejects the deferred. If `indexing` is already true when `buildIndex()` is called, it returns the existing `buildPromise` instead of starting a second build.

`buildIndexWithReuse()` has a slightly different guard: if `indexing` is true AND `buildPromise` exists, it `await`s the existing promise and returns `true` (BUG-AUDIT-CNEW03 -- previously returned `false`, causing redundant full rebuilds).

### `buildEpoch` zombie guard

`buildEpoch` is a monotonic counter in `state.js` (module-top `buildEpoch` state var). Incremented by `sync.js` when a stuck indexing flag is force-released after 120s. Both build functions capture `buildEpoch` at start and check via `isZombie = () => buildEpoch !== capturedEpoch` at multiple points:
- After field definitions load
- After each vault fetch
- After dedup
- Before committing to state

If `isZombie()` returns true, the build bails silently without committing stale results.

The `finally` block in `buildIndex()` only clears `indexing`/`buildPromise` if `buildEpoch === capturedEpoch` (vault.js:buildIndex() finally block), preventing a zombie cleanup from interfering with a legitimately-running new build.

---

## 3. Fetch Layer

### obsidian-api.js functions

| Function | Purpose |
|----------|---------|
| `obsidianFetch(options)` | Core HTTP request. All other functions call this. |
| `listAllFiles(host, port, apiKey, dir, depth, https)` | Recursive directory listing. Returns `{files: string[], partial: boolean}`. |
| `fetchAllMdFiles(host, port, apiKey, https)` | Lists all `.md` files then fetches each in parallel batches of `OBSIDIAN_BATCH_SIZE` (50). Returns `{files, total, failed, partial}`. |
| `testConnection(host, port, apiKey, https)` | User-initiated test. Force-resets circuit breaker first. |
| `diagnoseFetchFailure(host, port, apiKey)` | Probes HTTP on alternate port to distinguish cert/unreachable/auth failures. |
| `fetchFieldDefinitions(host, port, apiKey, path, https)` | GET a YAML file from vault. |
| `writeNote(host, port, apiKey, filename, content, https)` | PUT markdown content. Used by import and Scribe. |
| `fetchScribeNotes(host, port, apiKey, folder, https)` | Batch-fetch all `.md` files in a folder. |

### Per-vault circuit breaker

Keyed by `"host:port"` string (e.g. `"127.0.0.1:27123"`). Each vault gets independent state.

**States:** `closed` -> `open` (after `maxFailures` = 3) -> `half-open` (after exponential backoff expires).

**Backoff:** `min(baseBackoff * 2^min(failures - maxFailures, 3), maxBackoff)` = `min(2000 * 2^min(n, 3), 15000)` ms. Exponent capped at 3 to limit the growth rate.

**What counts as failure:** 5xx, 429, network errors. **Not failures:** 401/403 (persistent config issue), AbortError (timeout/cancel).

**Half-open:** Exactly one probe request allowed through (`halfOpenProbe` flag). Success -> closed. Failure -> open (with fresh `openedAt` for recalculated backoff).

**Circuit state events:** State transitions push `pushEvent('obsidian_circuit', {key, from, to})` to the `eventBuffer`. This tracks when individual vaults enter/exit open state for diagnostic timeline reconstruction.

**Pruning:** `pruneCircuitBreakers(activeKeys)` removes entries for hosts no longer in config. Called from settings-ui when vault config changes.

### CORS proxy usage

DLE does NOT use ST's CORS proxy for Obsidian connections. The Obsidian Local REST API plugin has built-in CORS support. CORS proxy (`enableCorsProxy: true` in ST's `config.yaml`) is still required for Obsidian vault fetching if you use HTTPS with a self-signed cert (some browser/cert-store combinations route through the bridge to bypass cert errors). **AI features no longer use CORS proxy as of v2.5** (Custom Proxy mode dead-headed; Connection Profile uses CMRS server-side and bypasses the bridge entirely — see `docs/gotchas.md` #68). Pre-v2.5, the CORS proxy was used by AI search and Librarian in proxy mode; that path is now unreachable in production but the code is preserved for rollback.

### `diagnoseFetchFailure()` (obsidian-api.js:diagnoseFetchFailure())

When an HTTPS fetch fails with TypeError/Failed to fetch, probes `http://host:httpPort/vault/` to diagnose. If `port` is 27124 (HTTPS default), probes 27123 (HTTP default). Returns `{diagnosis: 'cert'|'unreachable'|'auth', httpWorked, httpPort}`.

---

## 4. Parsing

### `parseVaultFile(file, tagConfig, fieldDefinitions)` (core/pipeline.js:parseVaultFile())

Takes `{filename, content}` and tag/field config. Returns a `VaultEntry` or `null`.

**Admission criteria (in order):**
1. Must have the lorebook tag OR the guide tag in frontmatter `tags[]`.
2. `frontmatter.enabled` must not be `false`.
3. Must not have the never-insert tag.

### Tag classification

| Tag setting | Settings key | Boolean field set | Semantics |
|-------------|-------------|-------------------|-----------|
| `lorebook` | `lorebookTag` | (admission gate) | Entry is eligible for keyword/AI matching |
| `lorebook-always` | `constantTag` | `constant: true` | Always injected regardless of keywords |
| `lorebook-never` | `neverInsertTag` | (entry skipped) | Entry excluded from index entirely |
| `lorebook-seed` | `seedTag` | `seed: true` | Story context on new/short chats |
| `lorebook-bootstrap` | `bootstrapTag` | `bootstrap: true` | Force-inject when chat is short |
| `lorebook-guide` | `librarianGuideTag` | `guide: true` | Librarian-only; never reaches writing AI |

**Guide conflict rule:** If both `lorebook-guide` and lorebook/seed/bootstrap tags are present, `guide` wins at runtime (the entry is admitted to the index via guide tag, but the `guide` flag causes filtering at injection time).

### Frontmatter field extraction

Pipeline.js extracts these frontmatter fields (with type coercion):
- `keys` -> `string[]` (array or single-value coercion)
- `priority` -> `number` (default 100)
- `constant`, `excludeRecursion` -> `boolean`
- `scanDepth`, `depth` -> `number|null` (depth clamped to 0-10000, BUG-092)
- `position` -> mapped via `{before: 2, after: 0, in_chat: 1}` to `injectionPosition`
- `role` -> resolved via ST's `getExtensionPromptRoleByName()` with fallback map `{system: 0, user: 1, assistant: 2}` (BUG-094)
- `requires`, `excludes`, `refine_keys`, `cascade_links` -> `string[]` via `toArray()` helper
- `summary` -> `string` (coerces numbers to string)
- `cooldown`, `warmup` -> `number|null` (must be > 0)
- `probability` -> `number|null` (clamped to 0.0-1.0)
- `outlet` -> `string|null`
- `graph` -> `boolean` (default true, only false if explicitly `graph: false`)

### Custom field extraction

`extractCustomFields(frontmatter, fieldDefinitions)` (in `src/fields.js`) extracts user-defined fields based on the loaded field definitions YAML. Returns a plain object `{fieldName: value}`.

### Token estimation

`tokenEstimate` is initially set to `0` in `parseVaultFile()`. Actual estimation happens later:
- **buildIndex():** `await getTokenCountAsync(entry.content)` with fallback `Math.ceil(content.length / 4.0)` — wrapped in `Promise.all(entries.map(async ...))` so tokenization runs in parallel. When the tokenizer is unavailable and the fallback is used, a warning is logged.
- **buildIndexWithReuse():** Same for newly-parsed entries; reused entries keep their existing estimate. **The reuse-path tokenization is intentionally serial inside the for-loop** (one `await getTokenCountAsync` per file). This is acceptable in the steady state because reuse-sync only re-tokenizes the small set of *modified* files (cache hits skip the await). It is NOT acceptable when every file needs re-parsing — see V-H4 below.
- **Merge dedup:** `Math.ceil(mergedContent.length / 4.0)` (rough estimate, not tokenizer).

### V-H4: fieldDefsChanged delegates to buildIndex (2026-05-22)

When `parseFieldDefinitionYaml` returns a different definition set than what's currently committed (`fieldDefsChanged === true`), the reuse-sync cache check (`existing._contentHash === fileHash && !fieldDefsChanged`) fails for every file. Every entry then goes down the re-parse + serial `await getTokenCountAsync` path, blocking the UI for several seconds on a 500-entry vault.

`buildIndex()` does the same work but tokenizes in parallel via `Promise.all`. So when `fieldDefsChanged === true`, `buildIndexWithReuse()` now returns early with `_reuseResult = false` — the caller's standard fallback (`ensureIndexFresh` and `setupSyncPolling` both check the reuse-path result and invoke `buildIndex` when it's false) takes over and gets the parallel tokenization for free. The `finally` block clears the build lock so `buildIndex` can acquire it cleanly.

Regression guards: `test/vault.test.mjs` section M (M1-M6) — source-code assertions on the early-return position, structure, and fallback contract.

---

## 5. Finalization

### `finalizeIndex({ entries, settings, skipCacheSave })` (vault.js:finalizeIndex())

Shared post-processing called by both `buildIndex()` and `buildIndexWithReuse()` after entries are committed to `vaultIndex`.

### Call graph

```
finalizeIndex()
  -> resolveLinks(vaultIndex)               // core/matching.js
  -> dangling reference cleanup              // inline in finalizeIndex()
  -> computeDerivedIndexFields(entries)      // vault.js:computeDerivedIndexFields()
       -> setVaultAvgTokens()
       -> build mentionWeights Map           // setMentionWeights()
       -> build folderList                   // setFolderList()
  -> computeEntityDerivedState(entries)      // vault-pure.js
       -> setEntityNameSet()
       -> setEntityShortNameRegexes()        // also bumps entityRegexVersion
  -> buildBM25Index(entries)                 // if fuzzy/librarian enabled -> setFuzzySearchIndex()
  -> setAiSearchCache({empty})              // invalidate AI search cache
  -> takeIndexSnapshot() + detectChanges()  // core/sync.js
  -> showChangesToast()                     // if changes detected and toasts enabled
  -> setPreviousIndexSnapshot()
  -> setIndexEverLoaded(true)
  -> pushEvent('index_build')               // lifecycle event for diagnostics
  -> prune analytics                        // settings.analyticsData
  -> saveIndexToCache(entries)              // unless skipCacheSave
  -> pruneOrphanedCacheKeys()
  -> notifyIndexUpdated()                   // UI callbacks
```

### `resolveLinks(vaultIndex)` (core/matching.js)

Populates `entry.resolvedLinks[]` by matching `entry.links[]` (wiki-link targets) against actual entry titles in the index.

### Dangling reference cleanup (vault.js: inline block in finalizeIndex())

Strips `requires[]`, `excludes[]`, and `cascadeLinks[]` references that don't match any entry title in the current index. Originals preserved on `_originalRequires`, `_originalExcludes`, `_originalCascadeLinks` so the health check can still surface broken references.

**Gotcha:** The `_original*` fields are included in the IndexedDB cache save (cache.js:saveIndexToCache(), explicit `_original*` allowlist in the private-field filter). This means cached entries retain the broken-ref information across reloads.

### `computeDerivedIndexFields(entries, settings, previousEntries?)` (vault.js:computeDerivedIndexFields())

Shared between `finalizeIndex()` and `hydrateFromCache()` (BUG-370). Optional third arg `previousEntries` enables the incremental path (P3).

**mentionWeights** (vault.js: mentionWeights block inside computeDerivedIndexFields()): Cross-entry mention frequency table. Key format: `"sourceName\0targetTitle"`, value: match count. Uses precompiled combined regexes per target entry for O(N x total_content) instead of O(N x M x content) (BUG-374). Short names (<=3 chars) use `\b` word boundaries.

**P3 incremental path (2026-05-22):** When `previousEntries` is supplied AND `shouldUseIncremental(changed, total) === true` (default threshold: 50% of total), `incrementalMentionWeights()` from `src/vault/vault-incremental.js` updates the prior Map by purging dirty rows/columns and recomputing only the affected source×target pairs. Output is byte-equivalent to the full path — pinned by `test/vault.test.mjs` section L (L1-L3, L11). The same `previousEntries` triggers incremental BM25 (`incrementalBM25Update`) and incremental entity regexes (`incrementalEntityRegexes`) in `finalizeIndex` itself.

**folderList** (vault.js: folderList block inside computeDerivedIndexFields()): Array of `{path, entryCount}` sorted by count descending. Includes all ancestor folders (e.g. entry in `A/B/C` counts toward `A`, `A/B`, and `A/B/C`).

**vaultAvgTokens**: Simple mean of all `entry.tokenEstimate` values.

### `computeEntityDerivedState(entries)` (vault-pure.js:computeEntityDerivedState())

**entityNameSet:** `Set<string>` of all lowercased titles (min 1 char) and keys (min 2 chars).

**entityShortNameRegexes:** `Map<string, RegExp>` mapping each entity name to a precompiled `\b...\b` case-insensitive regex. Used by AI search cache sliding window for entity mention detection.

**Side effect:** `setEntityShortNameRegexes()` bumps `entityRegexVersion` (state.js:setEntityShortNameRegexes()), a monotonic counter. AI search cache stamps this at write time and compares on read to detect post-rebuild staleness (BUG-394).

### AI search cache invalidation

`setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] })` -- forces a fresh AI selection on next generation after any index rebuild.

### Analytics pruning (vault.js: analytics block inside finalizeIndex())

Removes `settings.analyticsData` keys that don't match any active `trackerKey(entry)` (format: `"vaultSource:title"`). Skips keys starting with `_` (sub-objects like `_librarian`). Prevents unbounded growth when vault entries are renamed/deleted.

### IndexedDB cache save

`saveIndexToCache(entries)` is called unless `skipCacheSave` is true (set when a vault fetch partially failed -- avoids caching a truncated index). `pruneOrphanedCacheKeys()` follows to clean up stale cache keys from previous vault configs. Both are fire-and-forget (`.catch(() => {})`).

**Cache lifecycle events:** `saveIndexToCache()` pushes `pushEvent('cache_save', {entryCount, ...})` on completion. `loadIndexFromCache()` pushes `pushEvent('cache_load', {entryCount, ...})` on successful hydration. These events feed the `eventBuffer` for diagnostic exports. Cache save/prune operations also log at debug level.

---

## 6. Cache Layer

### IndexedDB schema

- **Database:** `DeepLoreEnhanced` (DB_VERSION = 1)
- **Object store:** `vaultCache` (no key path -- uses explicit keys)
- **Schema version:** `CACHE_SCHEMA_VERSION = 4` (bumped: H-06 cache key includes lorebookTag + conflictResolution)

### Cache key format

`getCacheKey()` (cache.js:getCacheKey()): Builds a fingerprint from enabled vault configs:

```
"index_" + lorebookTag + "_" + conflictResolution + "_" + sorted("name:host:port:protocol:hashedApiKey" per enabled vault, joined by "|")
```

Falls back to `"primaryIndex"` if no vaults configured or on error. H-06: `lorebookTag` and `multiVaultConflictResolution` are included so changing either invalidates the cache.

### Stored data shape

```javascript
{
    schemaVersion: 4,
    timestamp: Date.now(),
    entries: entries.map(e => {
        // All own properties EXCEPT private (_*) fields,
        // with explicit exceptions: _contentHash, _originalRequires,
        // _originalExcludes, _originalCascadeLinks
    })
}
```

### `loadIndexFromCache()` (cache.js:loadIndexFromCache())

Returns `{entries, timestamp}` or `null`. Rejection cases:
1. No data or empty entries array -> `null`
2. `schemaVersion` mismatch -> `null` (shows toast "Refreshing your lore cache after an update")
3. All entries fail `validateCachedEntry()` -> `null`

### `validateCachedEntry(entry)` (cache-validate.js:validateCachedEntry())

Pure function. Returns `false` if structurally invalid; mutates in-place to backfill missing fields.

**Hard failures (returns false):**
- Not an object, missing/empty `title`, `keys` not an array, `content` not a string
- `tokenEstimate` not a number, negative, or NaN

**Backfill/coercion:**
- `priority` defaults to 50 if not a number
- `constant` defaults to `false`
- `requires`/`excludes` coerced to `[]` if present but not arrays
- `links`, `resolvedLinks`, `tags` defaulted to `[]`
- `customFields` coerced to `{}` if not a plain object; inner values validated for primitive/array types (BUG-376)

### `pruneOrphanedCacheKeys(saveSucceeded)` (cache.js:pruneOrphanedCacheKeys())

Removes all IndexedDB keys except the current `getCacheKey()`. Guarded by `_lastSaveSucceeded` (BUG-371): if the most recent `saveIndexToCache()` failed (quota/blocked), pruning is skipped to avoid wiping the only valid cache.

### `_lastSaveSucceeded` guard (cache.js: `_lastSaveSucceeded` module-level var)

Module-level: `null` (no save attempted), `true` (last save succeeded), `false` (last save failed). Set by `saveIndexToCache()`. Read by `pruneOrphanedCacheKeys()`. Prevents catastrophic cache loss when IndexedDB quota is exceeded.

### `clearIndexCache()` (cache.js:clearIndexCache())

Clears ALL keys in the `vaultCache` store (not just the current fingerprint). Called by manual cache clear in settings/danger zone.

### IndexedDB blocked handling (cache.js:openDB())

`openDB()` wraps `openDBOnce()` with a one-shot 250ms retry on `BLOCKED` error. Shows a deduped warning toast. Blocked state occurs when another SillyTavern tab has an older DB version open.

---

## 7. BM25 Fuzzy Search

### Source: `src/vault/bm25.js` (pure functions, no ST imports)

### `buildBM25Index(entries)` (bm25.js:buildBM25Index())

Returns `{idf: Map<term, number>, docs: Map<docId, {tf, len, entry}>, avgDl: number, invertedIndex: Map<term, Set<docId>>}`.

**Document construction:** Each entry becomes one document = `"title keys.join(' ') content"`.

**Document ID format (BUG-369):** `"vaultSource\0filename"` (not trackerKey, which is `vaultSource:title`). Filename is unique within a vault; titles can collide.

**Tokenization:** `tokenize(text)` (bm25.js:tokenize()) -- lowercase, split on `[^\p{L}\p{N}]+` (Unicode-aware), filter tokens < 2 chars. No CJK n-gram splitting.

**IDF formula:** `log((N - df + 0.5) / (df + 0.5) + 1)`

### `queryBM25(index, queryText, topK=20, minScore=0.5)` (bm25.js:queryBM25())

Returns `Array<{title, score, entry}>` sorted by score descending.

**Scoring:** Standard BM25 with `k1=1.5`, `b=0.75`. Query tokens are deduplicated (BUG-042). H-12: Uses inverted posting list (`index.invertedIndex`) to score only docs containing at least one query term, instead of scanning all docs. Falls back to full scan if `index.invertedIndex` is undefined (indexes built before this version).

**Returns `entry.title`** in results, not the map key (BUG-013).

### When BM25 is used

1. **Pipeline matching (secondary filter):** When `settings.fuzzySearchEnabled` is true, BM25 augments keyword matching in the pre-filter stage.
2. **Librarian `search_lore` tool:** When `settings.librarianSearchEnabled` is true, the Librarian's search tool queries the BM25 index.

### Build timing

- **finalizeIndex():** Built if `fuzzySearchEnabled || librarianSearchEnabled`. Stored via `setFuzzySearchIndex()`.
- **hydrateFromCache():** Also built during hydration so search is available before background rebuild.
- If neither setting is enabled, `setFuzzySearchIndex(null)`.

### Logging

- **`buildIndex()` and `buildIndexWithReuse()`** in `vault.js` log `[DLE] Index built: N entries in Xms (mode: fresh|reuse)` on completion. Always-on (not debug-gated) -- valuable performance signal for diagnosing slow rebuilds or unexpected reuse misses.
- **`queryBM25()`** in `bm25.js` logs `[DLE] BM25: query "..." → N hits in Xms` when debug mode is active. Debug mode is injected via `setDebugMode()` rather than imported from settings, preserving the module's pure-function / no-ST-import design.

---

## 8. Sync Polling

### `setupSyncPolling(buildIndexFn, buildIndexWithReuseFn)` (src/vault/sync.js:setupSyncPolling())

Uses `setTimeout` chaining (NOT `setInterval`) to prevent overlapping callbacks.

### Epoch guard (BUG-018)

Module-level `_syncEpoch` counter. Each `setupSyncPolling()` call increments it. The polling chain captures `myEpoch` at creation; every tick checks `_syncEpoch !== myEpoch` and bails if orphaned. Checked both before and after `await`.

### Per-tick logic

```
1. Check _syncEpoch (bail if orphaned)
2. Re-read syncPollingInterval from settings (live adjustment)
3. If !enabled -> schedule next, skip
4. Stuck indexing guard: if indexing for >120s, force-release:
     setIndexing(false), setBuildPromise(null),
     setBuildEpoch(buildEpoch + 1)  // zombie-invalidate stuck coroutine
5. Check circuit breaker (skip tick if all vaults open)
6. Try buildIndexWithReuse() first
7. If reuse returned false, fall back to buildIndex()
8. Schedule next tick
```

### Change detection

Done inside `finalizeIndex()`, not in sync.js directly:
- `takeIndexSnapshot(vaultIndex)` (core/sync.js:takeIndexSnapshot()): Creates `{contentHashes: Map<filename, hash>, titleMap, keyMap, timestamp}`.
- `detectChanges(old, new)` (core/sync.js:detectChanges()): Returns `{added[], removed[], modified[], keysChanged[], hasChanges}`. Content changes detected via hash comparison; key changes detected via JSON.stringify comparison.
- `showChangesToast(changes)` (src/vault/sync.js:showChangesToast()): HTML toast with truncated lists (max 3 items per category).

### Snapshot patching for failed vaults (BUG-368)

In `buildIndexWithReuse()` (vault.js: failed-vault snapshot-patch block inside buildIndexWithReuse()): After `finalizeIndex()` replaces `previousIndexSnapshot`, entries from vaults that failed during this sync cycle have their snapshot entries restored from the pre-sync snapshot. This prevents masking edits made while a vault was unreachable.

### First-build-post-hydrate silence (intentional)

The first full build after cold-boot hydrate has no `previousIndexSnapshot` to compare against, so `detectChanges()` is not called and no toast fires. This is intentional cold-start UX — firing "100 entries added" on every app load would be noise. `previousIndexSnapshot` is built during the first build's `finalizeIndex()` and subsequent polls fire change toasts normally from that baseline.

---

## 9. Import

### Source: `src/vault/import.js`

### `parseWorldInfoJson(jsonText)` (import.js:parseWorldInfoJson())

Handles three ST World Info JSON formats:
1. **Direct WI export:** `{entries: {0: {...}, 1: {...}}}` (object with numeric keys)
2. **Array:** `[{...}, {...}]`
3. **V2 character card:** `{data: {character_book: {entries: [...]}}}`

Returns `{entries: object[], source: string}`. Filters out null/non-object entries.

### `convertWiEntry(wiEntry, lorebookTag, options?)` (src/helpers.js:convertWiEntry())

Maps a single ST World Info entry to `{filename, content}` (Obsidian markdown with frontmatter).

- Title: from `wiEntry.comment` or first key or `Entry_<uid>`.
- Filename: sanitized title + `.md`.
- Keys: from `wiEntry.key` (handles both array and comma-separated string formats, BUG-008).
- Position: maps ST's 5-value enum `{0: 'after', 1: 'before', 2: 'before', 3: 'after', 4: 'in_chat'}` (lossy). Original ST value preserved as `# original_st_position: N` comment.
- Content: `wiEntry.content` as markdown body after frontmatter.

**Tier A native fields (Wave 1, WI parity):** ST fields DLE supports natively are emitted as canonical frontmatter so authorial intent survives the import:
- `wiEntry.disable === true` → `enabled: false` (parser then skips the entry at load time per `parseVaultFile:191`). **Pre-Wave-1 these silently became active entries** — the most damaging silent downgrade in the importer.
- `wiEntry.excludeRecursion` (or snake `exclude_recursion`) → `excludeRecursion: true` (camelCase is the grandfathered canonical form — see `CANONICAL_FM_LOOKUP` in `core/pipeline.js`).
- `wiEntry.role` ∈ {0,1,2} → `role: system|user|assistant`. Unknown integers omit the line rather than emit a lie; the report's `skipped.invalid_role` counter is bumped instead.

**`options.compress`** (#18) — when truthy (or `'caveman'`), pipe the body through `compressCaveman()` before writing and annotate frontmatter with `compress: caveman`. Other strings are passed through `resolveCompressMode` for forward compatibility, but only modes in `APPLIED_COMPRESS_MODES` (currently just `'caveman'`) actually transform and annotate — unknown modes log a warning and leave the body untouched rather than emit a misleading annotation.

**`options.report`** (Wave 1+) — optional accumulator shaped `{nativeApplied:{}, roundTripped:{}, skipped:{}}`. When passed, the converter mutates `report.<bucket>[field]++` in place. `importEntries` and `upsertConvertedEntry` thread their own accumulator through and return it on the result object so the import-report popup (Wave 5) can render per-field counts without re-parsing emitted YAML.

### `importEntries(entries, folder, onProgress, options?)` (import.js:importEntries())

Writes entries to the primary vault one at a time.

**Dedup logic:** Before writing, checks if file already exists via `obsidianFetch` GET. If it does, tries suffixes: `_imported`, `_imported_2`, ... up to `_imported_20` (`MAX_DEDUP_ATTEMPTS`, module-scoped in `import.js`). Each suffix existence-check is a separate Obsidian fetch. The walk is extracted into `_findUniquePath(vault, filename, folder)` (private) so both `importEntries` and `upsertConvertedEntry` share the same behavior.

**Error handling:**
- AbortError on dedup check → skip entry (FIX-M6), not use undefined path.
- Network error on existence check → skip entry with error message.
- Cap exhausted (>20 dedup attempts) → skip entry.
- Returns `{imported, failed, renamed, errors, report}`. The `report` accumulator (Wave 1) carries per-field counts of native applications, round-tripped fields, and skip reasons — consumed by the import-report popup (Wave 5).

**V-C2 (2026-05-22):** `_findUniquePath` previously returned the candidate path "assume free" when the existence-check `obsidianFetch` threw a non-Abort error. If the file actually existed, the caller's `writeNote` then silently overwrote real vault content. The helper now delegates to `classifyDedupProbe(fetchResult, err)` in `src/vault/vault-pure.js` — any error (Abort or otherwise) yields `{accept:false, taken:false}`, so the helper returns `null` and the caller skips with a "dedup check failed" error message. See gotchas.md #49.

**`options.compress`** (#18) — forwarded into `convertWiEntry`. Defaults to `settings.importCompressByDefault`.

**State read:** `getSettings()`, `getPrimaryVault(settings)`.
**State written:** None (writes directly to Obsidian vault via API).

### `upsertConvertedEntry(wiEntry, folder, options?)` (import.js:upsertConvertedEntry())

PR #28.2 — Single-entry convert-and-upsert. Designed for companion-extension integration that wants to push one entry without running the full batch flow.

**Vault selection:** `options.vault` if given, else `resolveWriteVault('autoSuggest', settings)`. Returns `{ok:false, error: 'No vault configured…'}` when host/port/apiKey not all set.

**Collision policy** (`options.policy`, default `'rename'`):
- `'rename'` — find unique `_imported[_N]` suffix via `_findUniquePath`.
- `'replace'` — overwrite existing file. Destructive — companion callers should confirm.
- `'skip'` — bail with `{ok:true, action:'skipped'}`.

**Returns** `{ok, action: 'created'|'replaced'|'renamed'|'skipped'|null, path, report?, error?}`. The `report` accumulator (Wave 1) is present on every successful return so single-entry callers can show the same field-application summary as batch imports.

**`options.compress`** — forwarded into `convertWiEntry`, defaults to `settings.importCompressByDefault`.

### `updateEntryFields(host, port, apiKey, filename, updates, useHttps?)` (obsidian-api.js:updateEntryFields())

Surgical frontmatter-field update. Reads the file via REST, hands the content to `updateFrontmatterFields()` (in `src/helpers.js`), writes back. Body and untouched frontmatter fields preserved byte-for-byte.

**Scope (v1):**
- Scalar values only (string / number / boolean). Arrays / objects refused, reported via `skipped`.
- `null` value deletes an existing field (or is silently skipped for new fields).
- New fields appended before the closing `---`.
- Refuses to overwrite block scalars (`|`, `>`) — would orphan body lines and silently corrupt.
- Refuses to overwrite inline-flow arrays (`[a, b]`) — same data-loss risk.
- CRLF input handled (strips `\r` before key matching so Windows-authored files don't grow duplicate keys on every update).
- Hyphenated / dotted keys (`refine-keys`, `x.y`) match the read-side parser.
- `NaN` / `±Infinity` refused (returned in `skipped`) rather than emitted as malformed YAML.

**Returns** `{ok, applied: string[], skipped: string[], error?}`. No-op write (no mtime touch) when `applied.length === 0`.

**Does NOT create the file if missing** — returns `ok:false` with a 404 message. Caller should use `writeNote` or `upsertConvertedEntry` when create-or-update is wanted.

### Progress callback

`onProgress(imported + failed, total)` called after each entry attempt.

---

## Cross-Cutting Gotchas

1. **`trackerKey(entry)` = `"vaultSource:title"`** -- used for Map keys, analytics, pin/block. Bare titles will collide across vaults.

2. **BM25 docId = `"vaultSource\0filename"`** -- different from trackerKey. Using trackerKey caused silent drops for same-titled entries within one vault (BUG-369).

3. **`_contentHash` must not be recomputed on merge** (BUG-378). Reuse-sync compares `entry._contentHash` against on-disk file hashes. If merge recomputes it, every poll reports the merged entry as "modified" and triggers redundant re-parse/tokenize.

4. **Field definitions are loaded independently by both build paths** (`buildIndex()` and `buildIndexWithReuse()` — each has its own field-definitions load block). Both defer publishing to state until parsing is complete.

5. **`skipCacheSave`** is set to `true` when any vault fetch partially failed (in `buildIndex()`, passed into `finalizeIndex()` as `vaultFetchFailed`). This prevents caching a truncated index over a previously-good one. **V-C1 (2026-05-22):** `buildIndexWithReuse()` now mirrors this — `anyVaultFailed` is sticky across the vault loop and passed as `skipCacheSave: anyVaultFailed` to `finalizeIndex()`. Earlier code passed no `skipCacheSave` at all on the reuse path, so a partial listing or high per-file failure rate silently truncated IDB on next save (which then dropped trackers on next hydrate via analytics-prune). The shared classifier `classifyReuseFetch(data)` in `src/vault/vault-pure.js` codifies the contract (see gotchas.md #48).

6. **BUG-366/367 carry-forward guards** in both `buildIndex()` and `buildIndexWithReuse()`: if a vault returns partial results or zero files but previously had entries, the prior entries for that vault are carried forward instead of being silently dropped. **V-C1 extension:** `buildIndexWithReuse()` also carries forward on `data.partial === true` (previously only `buildIndex()` did this) and flags `anyVaultFailed`/`failedVaultNames` so the snapshot-patch and cache-skip branches downstream both see the failure.

7. **`ensureIndexFresh()` respects three rebuild trigger modes** (vault.js:ensureIndexFresh()): `ttl` (default, time-based), `generation` (every N generations), `manual` (only if index empty). The `generation` mode uses `generationCount` / `lastIndexGenerationCount` from state.js.

8. **The `finally` block asymmetry**: `buildIndex()` only clears indexing/buildPromise if epoch matches (vault.js:buildIndex() finally block). `buildIndexWithReuse()` always clears them in `finally` (vault.js:buildIndexWithReuse() finally block). This is intentional -- `buildIndex` is the only path that can be zombie-killed by force-release, and a force-release immediately starts a new build that must own the lock.

9. **`notifyIndexUpdated()`** fires registered callbacks (from settings-ui.js) without the vault module importing from the UI layer. This is the pub-sub bridge between data and presentation.

10. **Circuit breaker is per-vault but `getCircuitState()` with no argument returns aggregate worst state** across all vaults. Sync polling uses this aggregate to decide whether to skip a tick.
