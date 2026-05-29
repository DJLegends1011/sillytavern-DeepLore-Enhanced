# Advanced Entry Gating

These fields give you fine control over *when* an entry fires — beyond simple keyword matching. For copy-paste examples of each, see [[Vault Entry Templates]]; for the field table and defaults see [[Frontmatter Fields]]. New to authoring? Start at [[Writing Vault Entries]].

All of these are optional. A plain entry with just `keys` works fine — reach for these when an entry triggers too often, too rarely, or only in specific situations.

## requires / excludes — entry dependencies

`requires` makes an entry activate only when other named entries are **also** matched in the same generation. `excludes` blocks an entry when any named entry is present.

```yaml
requires:
  - Valen Ashwick
  - The Soulbrand   # both must be matched for this entry to activate
excludes:
  - Brand Removed   # if this entry is matched, block this one
```

- `requires`: **all** listed titles must be matched.
- `excludes`: if **any** listed title is matched, this entry is blocked.
- Titles must match the target entry's **title** exactly, and are case-sensitive. A typo silently drops the gate, so run `/dle-lint` after editing.

> [!NOTE]
> `requires` / `excludes` match by **bare title**, which is cross-vault: a `Castle` entry in vault A satisfies a `requires: [Castle]` gate in vault B. This is intentional. If you have same-named entries in different vaults, be aware they're interchangeable for gating purposes.

**Use cases:** spoiler prevention (don't reveal the twist entry until the setup entry is active), mutually exclusive world states (`Brand Removed` excludes the `Active Brand` entry), and detail entries that only make sense in the presence of their parent concept.

## cooldown / warmup / probability — trigger rate control

These three throttle how often an entry fires.

```yaml
cooldown: 5       # after firing, skip for the next 5 generations
warmup: 2         # keyword must appear ≥2 times in scan text before firing
probability: 0.5  # 50% chance to fire even when matched
```

- **`cooldown`** — After the entry triggers, it's skipped for N generations. Prevents the same atmospheric or flavor block from repeating every turn. Only values greater than 0 take effect.
- **`warmup`** — The keyword must appear N or more times in the scan text before the entry can trigger. Filters out one-off passing mentions. Only values greater than 0 take effect.
- **`probability`** — A 0.0–1.0 chance the entry fires when matched (values are clamped to that range). Omit, or set 1.0, for "always when matched." Useful for random flavor — a rumor that surfaces only sometimes.

## refine_keys / selective_logic — secondary keyword filter

`refine_keys` adds a second keyword set on top of your primary `keys`. The `selective_logic` field decides how those refine keys are evaluated. This is the tool for entries whose primary keyword is common ("the Guild", "the king") and over-fires.

```yaml
keys:
  - the Guild
refine_keys:
  - contract
  - mission
  - branded
selective_logic: and_any   # default — ≥1 refine key must also appear
```

A primary `keys` match is always required first. Then the refine keys are checked according to `selective_logic`:

| `selective_logic` | Triggers when… |
|-------------------|----------------|
| `and_any` *(default)* | At least **one** refine key also matches. |
| `and_all` | **All** refine keys also match. |
| `not_all` | At least **one** refine key is **missing** (a full match blocks the entry). |
| `not_any` | **No** refine key matches (any refine-key hit blocks the entry). |

Invalid `selective_logic` values fall back to `and_any` and are flagged by `/dle-lint` with `W_INVALID`.

> [!NOTE]
> An empty `refine_keys` list passes for all four modes — the refine gate is vacuously satisfied, so the entry behaves as if it had no refine filter.

> [!NOTE]
> Refine-key gating applies to the primary keyword and recursion match paths. The BM25 fuzzy-match path does not apply refine keys (TF-IDF scoring is content-wide by design).

## cascade_links — auto-pull related entries

`cascade_links` pulls in other named entries **unconditionally** whenever this entry matches — no keyword check on the linked entries.

```yaml
cascade_links: ["Soulbrand Removal", "Ironveil Guild"]
```

This is different from `[[wikilink]]` recursion. Wikilinks make the linked entry a *candidate* that still has to pass its own keyword scan; cascade links pull the entry in regardless.

**Use cases:**
- Lore mechanics that always travel together (a blood-bond entry cascading to its feeding-mechanics entry).
- Locations with sub-locations (a fortress cascading to its dungeon and armory).
- Characters with a dedicated ability entry that should always come along.

## Contextual gating — era / location / scene / characters

The four default contextual fields gate an entry on the current story context, which you set with slash commands rather than chat keywords:

```yaml
era: pre-war
location: The Docks
scene_type: investigation
character_present:
  - Maren Blacktide
```

Set the active context with `/dle-set-era`, `/dle-set-location`, `/dle-set-scene`, `/dle-set-characters`, or the generic `/dle-set-field <name> [value]`.

**How it works:**
- Entries with **no** contextual fields are always eligible (they pass through unfiltered).
- Each field is checked **independently**: an entry with only `era` set is filtered only on era, regardless of location / scene / character.
- The four defaults use the `match_any` operator at `moderate` tolerance — the entry passes if any of its listed values matches the active context value.
- Use `/dle-context-state` to see the current active context.
- Context is stored per-chat in `chat_metadata.deeplore_context`.

These four fields ship out of the box. You can add, remove, or modify gating fields via the "Manage Fields" rule builder (Filters tab toolbar or Settings popup). Custom field definitions are stored in `DeepLore/field-definitions.yaml` in your vault, where each field gets a type (`string`, `number`, `boolean`), a gating operator (`match_any`, `match_all`, `not_any`, `exists`, `not_exists`, `eq`, `gt`, `lt`), and a tolerance level (`strict`, `moderate`, `lenient`). See [[Custom Fields]] for the full schema.

## outlet — macro-based injection

The `outlet` field injects the entry's cleaned content wherever you place the matching `{{outlet::name}}` macro, instead of using positional injection.

```yaml
outlet: house_rules
```

Place `{{outlet::house_rules}}` in your system prompt, character card, or any prompt-list slot, and DLE substitutes the entry there. Outlet entries skip the normal positional injection (before / after / in_chat). Useful for recurring lore that must appear at a precise, fixed spot in the prompt.

---

Next: [[Frontmatter Fields]] · [[Vault Entry Templates]] · [[Custom Fields]] · back to [[Writing Vault Entries]]
