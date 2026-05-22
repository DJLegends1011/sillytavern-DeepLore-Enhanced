# Stages and Gating Deep Dive

Core stage functions live in `src/stages.js`. **Stages 1–5 and the Tracking Functions run in `index.js` after `runPipeline()` returns.** Folder filtering (`applyFolderFilter`) and the hierarchical pre-filter (`hierarchicalPreFilter`) are exceptions — they run _inside_ `runPipeline()` (`src/pipeline/pipeline.js`) as pre-filters before candidate manifest building, and then folder filter runs again post-pipeline (Stage 2b) as the authoritative gate. Each function takes explicit inputs and returns outputs — no implicit global state reads.

---

## ExemptionPolicy

```javascript
buildExemptionPolicy(vaultSnapshot, pins, blocks)
  → { forceInject: Set<string>, pins: Array<{title, vaultSource}>, blocks: Array<{title, vaultSource}> }
```
**Location:** `src/stages.js:buildExemptionPolicy()`

`forceInject` is a `Set<string>` keyed by `trackerKey(entry)` (i.e. `${vaultSource}:${title}`, preserving original title case). All five consumers below look up via `policy.forceInject.has(trackerKey(e))`. An entry in `forceInject` skips:
- Contextual gating (Stage 2)
- Folder filtering (Stage 2b)
- Re-injection cooldown (Stage 3)
- Requires/excludes gating (Stage 4)
- Strip dedup (Stage 5)

**Pinned entries receive `priority=10` to give them the best chance of surviving budget truncation (Stage 6), but `formatAndGroup` is not exemption-aware — it applies budget limits equally to all entries.**

Entries added to `forceInject`:
- All `constant` entries (lorebook-always) → `trackerKey(entry)`
- All `seed` entries (lorebook-seed) → `trackerKey(entry)`
- All `bootstrap` entries (lorebook-bootstrap) → `trackerKey(entry)`
- All pinned entries (from `chat_metadata.deeplore_pins`) — see pin walk below

**Pin walk (BUG-399 / Fix 2).** A normalized pin can have `vaultSource: null` (legacy bare-string pin) or a concrete `vaultSource`. The build walks `vaultSnapshot` and adds `trackerKey(entry)` for every entry where `matchesPinBlock(pin, entry)` returns true — so one legacy pin can fan out to N keys (matching the same title across multiple vaults), while a vault-scoped structured pin produces exactly one key. Multi-vault duplicates with different exemption status (e.g. vault-A's constant "Castle" vs vault-B's non-constant "Castle") no longer collapse — vault-B's copy is gated normally.

Pin/block normalization: `normalizePinBlock()` (called at top of `buildExemptionPolicy()`) converts bare title strings to `{title, vaultSource: null}` for backward compatibility.

---

## Stage 1: Pin/Block

```javascript
applyPinBlock(entries, vaultSnapshot, policy, matchedKeys)
  → entries[] (modified)
```
**Location:** `src/stages.js:applyPinBlock()`

**Pins:**
- Looks up pinned entries in `vaultSnapshot` (not just pipeline results)
- Deep-clones array fields to prevent shared references with `vaultIndex` (BUG-030)
- Shallow-clones `customFields` with array spread (BUG-AUDIT-P8)
- Sets `constant=true, priority=10` on cloned entry
- If entry already in results: replaces it. If not: appends.
- Records `matchedKeys.set(title, '(pinned)')` for trace display

**Blocks:**
- Filters out any entry matching a block via `matchesPinBlock(pb, entry)` (block pass at end of `applyPinBlock()`)
- Blocks override constants — a blocked constant is removed

**Gotcha:** Uses O(1) `resultIdx` Map for lookup (BUG-AUDIT-H15), not linear scan.

**Vault-aware index keying:** The Map keys by `trackerKey(entry)` (i.e. `${vaultSource}:${title}`), not bare lowercased title. Same-title entries from different vaults must remain distinct in the result list — keying by title alone caused vault B's pinned "Castle" to overwrite vault A's already-matched "Castle" instead of being added as a separate entry.

---

## Stage 2: Contextual Gating

```javascript
applyContextualGating(entries, context, policy, debugMode, settings, fieldDefs)
  → entries[] (filtered)
```
**Location:** `src/stages.js:applyContextualGating()`

Driven by `fieldDefinitions` array (default 4 from `src/fields.js`: `era`, `location`, `scene_type`, `character_present`). Custom fields defined in `field-definitions.yaml`.

**Logic per entry per field:**
1. ForceInject → pass
2. Entry has no value for field → pass (entry doesn't care)
3. Entry has value, context has no value:
   - `strict` tolerance → block (entry is out of context)
   - `moderate`/`lenient` → pass
4. Both have values → `evaluateOperator(operator, entryValue, activeValue)`

**Operators** (from `src/fields.js` `evaluateOperator`):
| Operator | Logic |
|---|---|
| `match_any` | Any entry value is in active values (OR) |
| `match_all` | All entry values are in active values (AND) |
| `not_any` | None of entry values are in active values |
| `exists` | Entry has a non-empty value |
| `not_exists` | Entry has no value |
| `eq` | Entry value equals active value |
| `gt` | Entry value > active value |
| `lt` | Entry value < active value |

**Tolerance levels:**
- **Strict:** Entry with value + no context = blocked
- **Moderate:** Entry with value + no context = passes
- **Lenient:** Like moderate, plus `match_any`/`match_all` non-matches also pass. Precision operators (`eq`, `gt`, `lt`, `not_any`) always filter. (BUG-H8)

**Short-circuit:** If no context dimension is set at all, returns entries unchanged (early return at top of `applyContextualGating()`).

---

## Stage 2b: Folder Filter

```javascript
applyFolderFilter(entries, selectedFolders, policy, debugMode)
  → entries[] (filtered)
```
**Location:** `src/stages.js:applyFolderFilter()`

- Root-level entries (`!e.folderPath`) always pass
- Subfolder matching: `e.folderPath === f || e.folderPath.startsWith(f + '/')`
- ForceInject entries exempt
- No-op if `selectedFolders` is null/empty (early return)

**Note:** `applyFolderFilter` runs at three points inside `runPipeline()` (one per search mode — ai-only, two-stage, keywords-only branches in `src/pipeline/pipeline.js:runPipeline()`) as a pre-filter before candidate manifest building. It also runs post-pipeline in `index.js` as Stage 2b (the authoritative gate). It is documented here because it shares the exemption policy pattern.

---

## Hierarchical Pre-Filter (Pre-pipeline, inside `runPipeline()`)

**Source:** `src/ai/ai.js:hierarchicalPreFilter()`

**Controlled by:** `settings.hierarchicalPreFilter` (default: `false`, in `settings.js` `defaultSettings`)

Not a post-pipeline stage — runs inside `runPipeline()` _before_ `applyContextualGating()` and `buildCandidateManifest()`. When enabled and candidate count exceeds `HIERARCHICAL_THRESHOLD = 40` (module-scope constant in `ai.js`), it makes a lightweight AI call to cluster candidates by category and ask which categories are relevant to the current chat, returning a reduced set.

- **Returns:** `null` (skip — too few candidates or threshold not met) or a filtered array. An empty array is a valid return (AI selected zero relevant categories).
- **BUG-396 rescue:** After filtering, entries whose primary keywords are explicitly mentioned in the chat are re-added, preventing high-relevance entries from being silently dropped.
- **Circuit breaker:** Uses `tryAcquireHalfOpenProbe()` / `releaseHalfOpenProbe()` — its probe slot is independent from the main `aiSearch()` circuit breaker probe.
- **Not exemption-aware:** ForceInject entries are not exempt from hierarchical pre-filtering (it runs before the exemption policy is computed for this phase).

---

## Stage 3: Re-injection Cooldown

```javascript
applyReinjectionCooldown(entries, policy, injectionHistory, generationCount, reinjectionCooldown, debugMode)
  → entries[] (filtered)
```
**Location:** `src/stages.js:applyReinjectionCooldown()`

- Checks `injectionHistory` Map: `trackerKey(entry) → lastInjectedGeneration`
- Entry skipped if `generationCount - lastGen < reinjectionCooldown`
- ForceInject entries exempt
- No-op if `reinjectionCooldown <= 0`

**Distinct from per-entry cooldown:** Re-injection cooldown is a global setting applied to all entries post-selection. Per-entry `cooldown` (frontmatter field) is tracked via `cooldownTracker` and applied during matching in `src/pipeline/match.js`.

---

## Stage 4: Requires/Excludes Gating

```javascript
applyRequiresExcludesGating(entries, policy, debugMode)
  → { result: entries[], removed: entries[] }
```
**Location:** `src/stages.js:applyRequiresExcludesGating()`

**Iterative loop** (max 10 iterations) until stable:
1. Sort entries so HIGHER-priority entries are processed LAST (so their `excludes`-targets may already be gone — the high-priority entry survives) (BUG-029). Default: descending raw number (lower-number-is-higher). When `settings.priorityReversed` (#16): ascending raw number (higher-number-is-higher). Uses `comparePriority()` helper, negated.
2. For each entry:
   - ForceInject → keep
   - `requires`: ALL titles must be in the active set (AND logic). Missing any → remove.
   - `excludes`: ANY title in the active set → remove (OR logic).
3. Repeat if any entry was removed (cascading dependencies)

**Re-sort on return**: "Important first" order so downstream `formatAndGroup` budget cap keeps the most important entries. Same `comparePriority()` helper, not negated.

**Signature** takes `priorityReversed` as its 4th arg; callers in `pipeline.js` and `index.js` pass `settings.priorityReversed`.

**Contradiction detection**: Warns if entry A requires B but B excludes A.

**Dangling reference handling:** References to entries not in the vault are stripped at finalization time (`resolveLinks` in vault.js), with originals preserved on `_originalRequires`, `_originalExcludes`.

---

## Stage 5: Strip Dedup

```javascript
applyStripDedup(entries, policy, injectionLog, lookbackDepth, defaultSettings, debugMode)
  → entries[] (filtered)
```
**Location:** `src/stages.js:applyStripDedup()`

- Reads `chat_metadata.deeplore_injection_log` (array of `{gen, entries[]}`)
- Takes last `lookbackDepth` log entries
- Builds dedup key: `title|position|depth|role|contentHash`
- Entry matches recent log entry with same key → skip
- ForceInject entries exempt
- No-op if log empty

---

## Stage 6: Format and Group

Not in `stages.js` — lives in `core/matching.js` as `formatAndGroup()`.

```javascript
formatAndGroup(entries, settings, promptTagPrefix)
  → { groups: Array<{tag, text, position, depth, role}>, count, totalTokens, acceptedEntries }
```

**Budget enforcement:**
- Expects entries pre-sorted "important-first" (default: ascending raw priority number; reversed when `settings.priorityReversed`) — Stage 4 re-sorts before returning
- Adds entries until `maxTokensBudget` or `maxEntries` is reached (unless `unlimited*` is set)
- Truncates the last entry to fit budget if needed (`_truncated` flag, `_originalTokens` preserved)

**Grouping:**
- **Extension mode:** Groups by `(position, depth, role)` triplet. Tag: `deeplore_p{pos}_d{depth}_r{role}`
- **Prompt List mode:** Two fixed tags: `deeplore_constants` and `deeplore_lore`. Per-entry overrides get their own `deeplore_override_p{pos}_d{depth}_r{role}` group (bypasses PM).
- **Outlet entries:** Position `-1`, tag `customWIOutlet_{name}`. Bypass PM entirely for `{{outlet::name}}` macro.

**Template rendering:** Each entry is wrapped per `settings.injectionTemplate` (default: `<{{title}}>\n{{content}}\n</{{title}}>`).

---

## Tracking Functions (Post-Commit)

**Note on numbering:** `stages.js` internally labels `trackGeneration` / `decrementTrackers` / `recordAnalytics` as "Stage 6: Tracking" in its section comment. This doc uses Stage 6 for `formatAndGroup` (which lives in `core/matching.js`, not `stages.js`) and labels the tracking functions as Stage 7/8 to reflect their call order in `index.js`. The two numbering schemes are both valid — they describe different slices of the pipeline.

### trackGeneration (Stage 7)

```javascript
trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings)
```
**Location:** `src/stages.js:trackGeneration()`

- Sets `cooldownTracker` for entries with per-entry `cooldown` field (value = `cooldown + 1` to compensate for immediate decrement)
- Records `injectionHistory` entries for re-injection cooldown (if `reinjectionCooldown > 0`)

### decrementTrackers (Finally Block)

```javascript
decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections)
```
**Location:** `src/stages.js:decrementTrackers()`

**Always runs if `pipelineRan` is true** (even with zero matches). Without this, cooldown timers freeze permanently.

1. **Cooldown:** Decrement all counters. Remove expired ones (≤1).
2. **Decay:** Reset to 0 for injected entries. Increment by 1 for non-injected entries. Prune at `2 × decayBoostThreshold` (BUG-H10 off-by-one fix).
3. **Consecutive injections:** Increment for injected entries. Delete non-injected entries (streak broken).

### recordAnalytics (Stage 8)

```javascript
recordAnalytics(matchedEntries, injectedEntries, analyticsData)
```
**Location:** `src/stages.js:recordAnalytics()`

- Increments `matched` count for all selected entries (pre-budget)
- Increments `injected` count for actually injected entries (post-budget)
- Records `lastTriggered` timestamp
- Prunes stale entries (>30 days since last trigger)
- Caps at 500 entries (evicts oldest by `lastTriggered`)

---

## Debug-Gated Stage Logging

Stage functions emit structured `[DLE]` log lines gated behind `_isDebug()`, a helper that reads `globalThis.extension_settings?.deeplore_enhanced?.debugMode` directly. This avoids importing `settings.js`, preserving test isolation.

All log lines are suppressed when their stage has no meaningful work (zero-change guard):

| Stage function | Log format | Skips when |
|---|---|---|
| `applyPinBlock()` | `[DLE] Pin/Block: +N pinned, N upgraded, -N blocked` | pins=0 AND blocks=0 |
| `trackGeneration()` | `[DLE] Track: N injected, N cooldowns set, reinjection=on/off` | injectedEntries empty |
| `decrementTrackers()` | `[DLE] Decrement: cooldowns N/N, decay pruned=N, streaks broken=N` | all trackers empty |
| `recordAnalytics()` | `[DLE] Analytics: matched=N injected=N, pruned=N+N, total=N` | matched=0 AND injected=0 |

---

## Field Definitions System

**Source:** `src/fields.js`

**Default fields:** `era`, `location`, `scene_type`, `character_present`

**YAML source:** `field-definitions.yaml` in primary vault (path configurable via `fieldDefinitionsPath` setting, default `DeepLore/field-definitions.yaml`).

**Field definition schema:**
```javascript
{
  name: string,           // Internal name (used in frontmatter, snake_case)
  label: string,          // Display name
  type: 'string'|'number'|'boolean',  // Data type
  multi: boolean,         // Whether this field holds an array of values
  values: string[],       // Optional allowed values (empty = freeform)
  contextKey: string,     // Key in chat_metadata.deeplore_context
  gating: {
    enabled: boolean,
    operator: string,     // match_any, match_all, not_any, exists, not_exists, eq, gt, lt
    tolerance: string,    // strict, moderate, lenient (overrides global setting)
  }
}
```

**`extractCustomFields(frontmatter, fieldDefs)`** — Called during `parseVaultFile()`. Extracts custom field values from entry frontmatter based on field definitions. Returns `{ [fieldName]: value }`.

**Reserved field names** (enforced by `RESERVED_FIELD_NAMES` set in `src/fields.js`): `keys`, `priority`, `tags`, `requires`, `excludes`, `position`, `depth`, `role`, `scandepth`, `excluderecursion`, `refine_keys`, `cascade_links`, `cooldown`, `warmup`, `probability`, `summary`, `graph`, `enabled`, `constant`, `seed`, `bootstrap`, `type`, `fileclass`, `status`, `aliases`.
