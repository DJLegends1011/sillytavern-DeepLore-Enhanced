# Entry matching and behavior

Per-entry frontmatter fields and global settings that control when and how entries trigger. These features refine the basic keyword matching described in [[Pipeline]]. They give you fine-grained control over which entries activate under which conditions.

For the full frontmatter reference, see [[Writing Vault Entries]].

---

## Fuzzy search (BM25)

When enabled, DLE supplements exact keyword matching with BM25-scored fuzzy search. This catches entries that are textually relevant to the conversation even when no exact keyword match occurs.

**How it works:**

1. During index building, DLE constructs a BM25 index from every entry's title, keys, and content.
2. During matching, the scan text (recent chat messages) is tokenized and scored against the index.
3. Entries scoring above the minimum threshold (default 0.5) are added to the match set alongside keyword matches.
4. Up to 20 fuzzy results are returned per generation, sorted by score.

BM25 (Best Matching 25) is a term-frequency / inverse-document-frequency algorithm. It scores documents higher when they share many terms with the query, weighted by how rare those terms are across the whole vault. Common words contribute little; distinctive terms contribute a lot.

**What it catches that keywords miss:**

- Entries where the conversation uses synonyms or related terms instead of exact keywords
- Entries with long, descriptive content that overlaps thematically with the chat
- Entries where you forgot to add a keyword that the chat is using

**Setup:** check "Enable Fuzzy Search" in [[Settings Reference|Matching & Budget settings]].

**Notes:**

- Fuzzy matches appear in the pipeline inspector and Context Cartographer with the label `(fuzzy, score: N.N)`.
- Fuzzy results respect cooldown, probability, warmup, and other per-entry behavior settings.
- The BM25 index is rebuilt every time the vault index refreshes.
- Works alongside keyword matching: it adds to the match set, never removes from it.
- In two-stage mode, fuzzy matches are included in the candidate manifest sent to the AI.

---

## Keyword occurrence weighting

When enabled (off by default), entries with more keyword occurrences in the scan text are weighted higher during matching. This separates entries mentioned once in passing from entries whose keywords appear repeatedly in the recent conversation.

**Use case:** prioritize entries whose keywords dominate the recent conversation. If "magic" appears 5 times in the last 4 messages, a magic-related entry is weighted higher than one where "magic" appears once.

**Notes:**

- Experimental setting. Test with your vault to see if it helps or hurts selection quality.
- Only affects keyword matching, not AI search.
- Enable in [[Settings Reference|Matching & Budget settings]] under Show Advanced.

---

## Cooldown

Per-entry `cooldown: N` in frontmatter. After an entry triggers, it's skipped for the next N generations before becoming eligible again.

**Use case:** prevent the same lore from re-injecting every single generation. Useful for flavor text or background entries that don't need constant repetition.

**Example:**

```yaml
cooldown: 3  # After triggering, skip for 3 generations
```

**Notes:**

- Cooldown is tracked per-chat (resets on chat change or page refresh).
- Constants (`#lorebook-always`) are exempt from cooldown.

---

## Warmup

Per-entry `warmup: N` in frontmatter. An entry's keywords must appear N or more times in the scan text before it triggers. The check runs every generation, not just the first time.

**Use case:** prevent entries from triggering on a single casual mention. Make sure a topic is being discussed in depth before injecting detailed lore.

**Example:**

```yaml
warmup: 3  # Keyword must appear 3+ times in scan text each generation
```

**Notes:**

- The warmup threshold is checked every generation. The keyword must meet the hit count each time, not just the first time.
- Count is based on occurrences in the scan text, not unique messages.

---

## Probability

Per-entry `probability: N` in frontmatter, a number from `0.0` to `1.0`. After an entry matches by keyword, DLE rolls a random number; the entry only triggers if the roll falls within the probability.

**Use case:** add variety. A "random encounter" or "rumor" entry with `probability: 0.3` triggers about 30% of the times its keywords match, so the same flavor lore doesn't appear on every relevant turn.

**Example:**

```yaml
probability: 0.5   # ~50% chance to trigger when keywords match
```

**Notes:**

- No `probability` field (or `null`) means the entry always triggers when matched.
- `probability: 0` means the entry never triggers, even when its keywords match.
- The roll happens once per generation, after the keyword and warmup checks pass.
- Cascade-linked entries also respect probability (a cascade-linked entry with `probability: 0` is still skipped), but warmup is ignored for them.

---

## Re-injection cooldown

Global setting (not per-entry). Skips re-injecting an entry for N generations after it was last injected. Saves context by avoiding redundant lore repetition.

**Setup:** set "Re-injection Cooldown" in [[Settings Reference|Matching & Budget settings]] (0 = disabled).

**Notes:**

- Constants (`#lorebook-always`) are exempt.
- Tracked per-chat (resets on chat change).
- Distinct from per-entry cooldown: re-injection cooldown is a global post-selection filter; per-entry cooldown is checked during keyword matching.

---

## Injection deduplication

Global setting that prevents the same entries from being injected in consecutive generations. When enabled, entries injected within the last N generations (configurable lookback depth) are skipped.

**Setup:**

1. Check "Strip Duplicate Injections" in [[Settings Reference|Matching & Budget settings]].
2. Set the "Lookback Depth" (default 2: checks last 2 generations).

**Notes:**

- Enabled by default with a lookback depth of 2.
- Constants (`#lorebook-always`) are exempt and always inject.
- Injection history is tracked per-chat in `chat_metadata.deeplore_injection_log`.
- The dedup key combines vault, title, position, depth, role, and a content hash, so the same entry at a different depth or role (or with edited content) isn't considered a duplicate. Two entries with the same title in different vaults are also kept distinct.
- Distinct from re-injection cooldown: deduplication checks a sliding window of recent generations; re-injection cooldown counts generations since last injection.

---

## Entry decay and freshness

Tracks how many generations have passed since each entry was last injected. Stale entries (not seen recently) get a boost in the AI manifest; frequently injected entries get a penalty. This rotates lore without manual intervention.

**Setup:**

1. Enable "Entry Decay" in [[Settings Reference|Entry Decay settings]].
2. Set the **Boost Threshold** (default 5): generations without injection before the freshness boost.
3. Set the **Penalty Threshold** (default 2): consecutive injections before the frequency penalty.

**Notes:**

- Decay tracking is per-chat (resets on chat change or page refresh).
- Only affects the AI search manifest (adds decay hints for the AI to consider).
- Constants are exempt from decay penalties.

---

## Conditional gating

Entries can declare dependencies on other entries using `requires` and `excludes` frontmatter fields.

### requires

Every listed entry title must be in the matched set for this entry to activate.

```yaml
requires:
  - Eris
  - Dark Council
```

This entry only injects when both "Eris" and "Dark Council" are also matched.

### excludes

If any listed entry title is in the matched set, this entry is blocked.

```yaml
excludes:
  - Draft Notes
```

This entry is blocked if "Draft Notes" is matched.

> [!IMPORTANT]
> Constants, seeds, bootstraps, and pinned entries override all gating. They are never removed by requires/excludes rules. They do remain in the active set, so other entries' `excludes` rules still see them. If you exclude a constant, your entry will be blocked because the constant is always there. This is intentional: force-injected entries represent ground truth that the rest of your lore should respect.

### Cascading resolution

Gating resolves iteratively. If Entry A requires Entry B, and Entry B is removed by its own gating rules, Entry A is also removed. This cascading repeats until no more entries are affected (max 10 passes).

See [[Writing Vault Entries]] for a complete template.

---

## Refine keys

Per-entry `refine_keys` in frontmatter. Adds a secondary filter on top of primary keyword matching: a primary keyword must match **and** the refine keys must satisfy the entry's `selective_logic` mode before the entry triggers.

**Use case:** reduce false positives for entries with common primary keywords. A character named "Rose" might have `refine_keys` requiring mention of their faction or role to avoid triggering on every use of the word "rose".

**Example:**

```yaml
keys:
  - Rose
  - Rose Blackwood
refine_keys:
  - guild
  - spymaster
  - intelligence
```

### Selective logic modes

`selective_logic` controls how the refine keys are evaluated. This mirrors SillyTavern's World Info Selective Logic, so imported lorebooks keep the same behavior. Four modes are supported (default `and_any`):

| Mode | Entry triggers when… |
|------|----------------------|
| `and_any` (default) | A primary key matched **and** at least one refine key also matched. |
| `and_all` | A primary key matched **and** every refine key also matched. |
| `not_all` | A primary key matched **and** not all refine keys matched (fewer than the full set). |
| `not_any` | A primary key matched **and** no refine key matched. |

```yaml
refine_keys:
  - hostile
  - betrayal
selective_logic: not_any   # only fire when neither word is present
```

An invalid `selective_logic` value falls back to `and_any` and is flagged by `/dle-lint`. When an entry's primary key matches but the refine gate blocks it, the `/dle-inspect` trace reports the mode-aware reason (e.g. "selective_logic=and_all blocked (1/2 refine keys matched)").

See [[Writing Vault Entries]] for a complete template.

---

## Cascade links

Per-entry `cascade_links` in frontmatter. When an entry matches, all entries listed in its `cascade_links` are pulled in without keyword matching. Cascade-linked entries respect cooldown and probability gates, but not warmup.

**Use case:** ensure related entries always travel together. Wikilink recursion requires keyword matches; cascade links bypass keyword matching.

**Example:**

```yaml
cascade_links: ["Soulbrand Removal", "Ironveil Guild"]
```

When this entry matches, "Soulbrand Removal" and "Ironveil Guild" are included.

See [[Writing Vault Entries]] for a complete template.

---

## Active Character Boost

When enabled, automatically matches the active character's vault entry by name or keyword, even if the character isn't mentioned in recent chat messages.

**Use case:** keep the lore for your current roleplay character available without relying on their name appearing in the most recent messages.

**Setup:** check "Active Character Boost" in [[Settings Reference|Matching & Budget settings]].

---

## New chat bootstrapping

On a brand-new chat (below the New Chat Threshold, default 3 messages), two features help bootstrap the conversation.

### Seed entries (`#lorebook-seed`)

- Entry content is sent to the AI as additional story context alongside the chat.
- Helps the AI understand your setting and make better entry selections from minimal context.
- Not injected into the writing AI's context. Only informs AI search.
- When seed mode is active, AI search is instructed to fill to maxEntries selections (more aggressive).

### Bootstrap entries (`#lorebook-bootstrap`)

- Force-injected like constants when the chat is short.
- Once chat grows past the threshold, they revert to regular entries managed by normal selection.
- Good for writing instructions or foundational lore needed at the start.

An entry can have both tags: its content feeds the AI (seed) and it force-injects (bootstrap).
