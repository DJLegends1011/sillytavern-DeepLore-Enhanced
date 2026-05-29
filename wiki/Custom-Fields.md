# Custom Fields

DeepLore lets you define your own frontmatter fields for contextual gating. Beyond the four built-in fields (era, location, scene_type, character_present), you can create any field your world needs: mood, faction, time_of_day, threat_level, whatever fits your setting.

## How it works

1. **Define fields** in a YAML file in your vault (or use the visual editor)
2. **Tag entries** with field values in their frontmatter
3. **Set the active context** with slash commands or the drawer's Filters tab
4. Entries whose field values don't match the active context are filtered out during lore selection

## Built-in fields

Four fields are included by default. You can modify or remove them.

| Field | Frontmatter Key | Type | Example Values |
|-------|----------------|------|----------------|
| Era | `era` | multi-value string | `medieval`, `renaissance`, `modern` |
| Location | `location` | multi-value string | `tavern`, `castle`, `forest` |
| Scene Type | `scene_type` | multi-value string | `combat`, `romance`, `investigation` |
| Characters Present | `character_present` | multi-value string | `Eris`, `Kael`, `Mira` |

All four use the `match_any` operator and `moderate` tolerance by default.

## Defining custom fields

### Visual editor (recommended)

Open the rule builder from the gear icon in the drawer's **Filters** tab toolbar, or the **Edit Fields** button in the Settings popup. The rule builder lets you:

- Add, delete, duplicate, and reorder fields
- Set field name (snake_case), display label, data type, and multi-value toggle
- Configure gating rules: operator, tolerance, and allowed values
- Reset to defaults if needed

Changes are saved to your Obsidian vault and the index rebuilds automatically.

### YAML file

Field definitions are stored at `DeepLore/field-definitions.yaml` in your primary vault (configurable in settings). You can edit this file directly in Obsidian.

```yaml
- name: era
  label: Era
  type: string
  multi: true
  gating:
    enabled: true
    operator: match_any
    tolerance: moderate
  contextKey: era
  values: []

- name: threat_level
  label: Threat Level
  type: number
  multi: false
  gating:
    enabled: true
    operator: gt
    tolerance: strict
  contextKey: threat_level
  values: []
```

### Field definition schema

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | Frontmatter key (snake_case, no spaces) |
| `label` | string | Yes | Human-readable display name |
| `type` | string | Yes | `string`, `number`, or `boolean` |
| `multi` | boolean | No | Whether the field holds an array of values (default: false) |
| `gating.enabled` | boolean | No | Enable contextual gating for this field (default: true) |
| `gating.operator` | string | No | How to compare values (default: `match_any`) |
| `gating.tolerance` | string | No | How strict the filter is (default: `moderate`) |
| `contextKey` | string | No | Key in chat context state (default: same as `name`) |
| `values` | string[] | No | Allowed values list (empty = freeform) |

Reserved names that cannot be used: `keys`, `priority`, `tags`, `requires`, `excludes`, `position`, `depth`, `role`, `scandepth`, `excluderecursion`, `refine_keys`, `selective_logic`, `cascade_links`, `cooldown`, `warmup`, `probability`, `summary`, `graph`, `enabled`, `constant`, `seed`, `bootstrap`, `type`, `fileclass`, `status`, `aliases`.

## Using fields in frontmatter

Add your custom field to any entry's frontmatter:

```yaml
---
tags:
  - lorebook
keys:
  - Dragon's Keep
era: medieval
location:
  - mountains
  - dragon_territory
threat_level: 8
---
# Dragon's Keep
...
```

Multi-value fields accept either a scalar or an array:
```yaml
era: medieval           # single value
era:                    # multiple values
  - medieval
  - renaissance
```

## Setting active context

Use slash commands to set the current context:

```
/dle-set-field era medieval
/dle-set-field threat_level 5
/dle-clear-field era
/dle-clear-all-context
```

Without a value argument, `/dle-set-field` shows a selection popup listing all values found in your vault with entry counts.

The built-in fields have shorthand aliases:
```
/dle-set-era medieval
/dle-set-location tavern
/dle-set-scene combat
/dle-set-characters Eris, Kael
```

View all active filters with `/dle-context-state` (alias: `/dle-ctx`).

You can also set context from the drawer's **Filters** tab by clicking the value buttons.

## Gating operators

| Operator | Behavior |
|----------|----------|
| `match_any` | Entry passes if ANY of its values match ANY active context value |
| `match_all` | Entry passes if ALL of its values exist in the active context |
| `not_any` | Entry passes if NONE of its values match the active context |
| `exists` | Entry passes if the field has any non-empty value |
| `not_exists` | Entry passes if the field is null or empty |
| `eq` | Entry value equals active context value (numbers or case-insensitive strings) |
| `gt` | Entry value is greater than active context value (numeric) |
| `lt` | Entry value is less than active context value (numeric) |

## Tolerance levels

Tolerance controls what happens when an entry has a field value but the check fails:

| Tolerance | No context set for field | Context set, operator fails |
|-----------|-------------------------|---------------------------|
| **Strict** | Entry filtered out | Entry filtered out |
| **Moderate** | Entry passes through | Entry filtered out |
| **Lenient** | Entry passes through | Entry passes through (unless explicit conflict like `not_any`, `gt`, `lt`) |

**Strict** means "if this entry cares about era, and no era is set, drop it." Use this when entries should only appear in their specific context.

**Moderate** (default) means "if no era is set, let everything through; if an era IS set, only matching entries pass." This is the most natural behavior for most setups.

**Lenient** means "only filter on clear mismatches." Use this for fields where you want soft suggestions rather than hard gates.

## Exemptions

These entries always bypass contextual gating regardless of field values:

- **Constants** (tagged `lorebook-always`)
- **Seeds** (tagged `lorebook-seed`)
- **Bootstrap** entries (tagged `lorebook-bootstrap`)
- **Pinned** entries (per-chat pins via `/dle-pin`)

## Integration

- **Drawer Filters tab:** shows all active fields with status dots, impact counts ("excluding N entries"), and quick-set buttons
- **Browse tab:** custom field filter dropdowns appear automatically for fields with values in the vault
- **Graph:** color nodes by any custom field value
- **AI manifest:** field labels shown in AI search manifests for better selection
- **`/dle-inspect`:** shows per-field mismatch reasons (e.g., `era: medieval != renaissance`)
- **`/dle-status`:** shows custom field count and names

## Related: folder filtering

Beyond field-based gating, DLE supports per-chat folder filtering via `/dle-set-folder`. This restricts injection to entries from specific vault folders, complementing custom field gating. See [[Injection and Context Control#Per-Chat Folder Filter]] for details.

## See also

- [[Injection and Context Control]]: how gating fits into the injection pipeline
- [[Slash Commands]]: full command reference
- [[Writing Vault Entries]]: frontmatter field reference
