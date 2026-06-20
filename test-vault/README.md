# Duskfrost Test Vault

A fully realized Obsidian lorebook vault for DeepLore. **~256 entries** covering the city of Duskfrost — its factions, districts, species, history, and political intrigue — while simultaneously exercising every frontmatter field, gating mechanism, health-check condition, and graph topology the extension supports. Versioned with the extension source.

**Theme:** Duskfrost — a sprawling fantasy city built on the ruins of a pre-Calamity civilization. Gritty urban fantasy with political intrigue, faction conflict, underground economies, and magic that always has costs.

---

## Directory Structure

```
Bloodline Affinities.md  — standalone lore entry (root level)
DeepLore/            1 file  — field-definitions.yaml (custom gating field definitions)
Sessions/            — session data directory
_edge-cases/        27 files — intentionally broken/weird entries (DO NOT EDIT)
characters/         51 files — faction leaders, officers, criminals, scholars, merchants
events/             25 files — wars, treaties, disasters, political crises
items/              20 files — artifacts, tools, weapons, cursed objects
locations/          35 files — districts, taverns, tunnels, guild halls, markets
lore/               45 files — magic theory, history, customs, ecology, politics
meta/               15 files — world rules, geography, timeline, climate, religion, naming
organizations/      20 files — guilds, factions, cults, enforcement bodies
species/            18 files — 15 fantasy species + 3 core (elf, dwarf, human)
```

---

## World Overview

Duskfrost is a coastal city of ~80,000 residents, governed by three noble houses (the **Triumvirate**: Harcyne, Velkhast, Morveth) in a shifting balance of alliances. The **Duskfrost Academy** regulates arcane practice. The **Solarguard** patrols the wealthy districts while the **Bonehands** control the harbor and marsh. Magic is channeled through sigils and costs something every time.

The current year is **355 PC** (Post-Calamity). The city sits on the ruins of a civilization destroyed by cascading arcane failure ~355 years ago. A recently discovered fragment of the old resonance grid beneath Rappiop Grove has all three houses quietly maneuvering. The Velkhast succession crisis has paralyzed harbor trade. The Champions of Patience are declining. The Keepers of the Scar watch the wound in Highwallow and worry.

**Key districts** (top to bottom of the bluff): Bellsummit (wealth/Academy), Amberburgh (merchants), Scorchhelm (military), Bayside Shushail (harbor/crime), Highwallow (marsh/poverty). Plus: Rimeborough (cold/northern), Redpond (lake/fishing), Saseopt/East Hamp/South Sool (residential).

**15 custom species** with distinct cultures, districts, and politics — from bioluminescent Zuvine salvagers to subterranean Gnaino echolocators to cold-resistant Delivese metalworkers.

---

## Expected Health Check Results

Run `/dle-health` with this vault connected (default settings). Expected output:

### ERRORS (7)

| Entry | Error |
|-------|-------|
| `_edge-cases/_orphaned-requires.md` | requires non-existent entry "Nonexistent Entry XYZ" |
| `_edge-cases/_circular-requires-a.md` | circular requires chain with "Circular Requires B" |
| `_edge-cases/_circular-requires-b.md` | circular requires chain with "Circular Requires A" |
| `_edge-cases/_self-exclude.md` | entry excludes itself ("Self Exclude Entry") |
| `_edge-cases/_duplicate-title-a.md` | duplicate entry title "Duplicate Title Entry" |
| `_edge-cases/_duplicate-title-b.md` | duplicate entry title "Duplicate Title Entry" |
| `_edge-cases/_requires-excludes-contradiction.md` | requires AND excludes same title "Oracles of Might" |
| *(circular requires pair counts as 1 error per entry)* | |

### WARNINGS (10+)

| Entry | Warning |
|-------|---------|
| `_edge-cases/_empty-content.md` | entry has no content |
| `_edge-cases/_no-keywords.md` | entry has no trigger keywords |
| `_edge-cases/_probability-zero.md` | probability set to 0 — entry can never trigger |
| `_edge-cases/_cooldown-on-constant.md` | cooldown set on constant entry (no effect) |
| `_edge-cases/_depth-without-inchat.md` | depth override with non-in_chat position |
| `_edge-cases/_role-without-inchat.md` | role override with non-in_chat position |
| `_edge-cases/_oversized-entry.md` | entry exceeds 1500 tokens |
| `meta/duskfrost-timeline.md` | seed entry exceeds 2000 tokens |
| `_edge-cases/_short-keys.md` | keywords ≤2 chars (Li, Qi, ab, sk) — false match risk |
| *(shared keywords across entries, if detected)* | duplicate keyword warning |

### INFO

| Entry | Info |
|-------|------|
| `_edge-cases/_unresolved-links.md` | unresolved wiki-link targets |

### NOT INDEXED

| Entry | Reason |
|-------|--------|
| `_edge-cases/_disabled-entry.md` | `enabled: false` — skipped by indexer |
| `_edge-cases/_never-insert.md` | tagged `lorebook-never` — indexed but never injected |

---

## Feature Coverage Matrix

### Core Matching

| Feature | File |
|---------|------|
| Simple keyword (single key) | `species/gnaino.md` |
| Multi-keyword (5+ keys per entry) | `characters/felicitas-langguth.md` (7 keys) |
| Short keywords ≤2 chars | `_edge-cases/_short-keys.md` |
| Unicode keywords (CJK, Cyrillic) | `_edge-cases/_unicode-keys.md` |
| Regex special chars in keys | `_edge-cases/_regex-special-keys.md` |
| refine_keys (secondary gate) | `characters/ayre-waesphyra.md` |
| scanDepth: 0 (AI-only) | `lore/hidden-compact.md` |
| scanDepth: 50 (deep scan) | `characters/ayre-waesphyra.md` |
| scanDepth: 5 (custom) | `items/speaking-stone.md` |
| excludeRecursion: true | `characters/zoughat.md`, `organizations/marblesmiths.md`, `species/gnaino.md` |
| No keywords (health warn) | `_edge-cases/_no-keywords.md` |
| Duplicate keywords (health warn) | intentional overlap across some entries |

### Requires / Excludes Gating

| Feature | File(s) |
|---------|---------|
| requires — simple A→B | `characters/gorduin-wynlar.md` requires Oracles of Might |
| requires — chain A→B→C | `adelas-gilydark` → `gorduin-wynlar` → `Oracles of Might` |
| requires — circular (ERROR) | `_edge-cases/_circular-requires-a.md` + `_circular-requires-b.md` |
| requires — orphaned (ERROR) | `_edge-cases/_orphaned-requires.md` |
| excludes — simple | `organizations/bonehands.md` excludes Solarguard |
| excludes — mutual | `bonehands` ↔ `solarguard`, `zuni-dhegevnac` ↔ `grolgrurim-bluntgut` |
| excludes — self (ERROR) | `_edge-cases/_self-exclude.md` |
| requires + excludes contradiction (ERROR) | `_edge-cases/_requires-excludes-contradiction.md` |
| cascade_links — basic | `characters/gorduin-wynlar.md` → Oracles of Might, Bellsummit |
| cascade_links — source has cooldown | `items/angel-crown.md` (cooldown:2) → `lore/war-of-glimmering-hope.md` |

### Behavioral Gating

| Feature | File |
|---------|------|
| warmup: 1 | `characters/grolgrurim-bluntgut.md` |
| warmup: 3 | `characters/snugug.md`, `lore/battle-of-the-false-prophet.md` |
| cooldown: 1 | `characters/grolgrurim-bluntgut.md` |
| cooldown: 2 | `items/angel-crown.md` |
| cooldown: 3 | `items/resurrection-jar.md` |
| cooldown: 5 | `characters/kabugbu.md` |
| cooldown on constant (WARN) | `_edge-cases/_cooldown-on-constant.md` |
| probability: 0.1 | `characters/kabugbu.md` |
| probability: 0.3 | `items/tiara-of-teleportation.md` |
| probability: 0.4 | `items/severance-dagger.md` |
| probability: 0.5 | `characters/tybellan-hercyne.md`, `items/sword-of-enigmas.md` |
| probability: 0.7 | `items/angel-crown.md` |
| probability: 1.0 | `items/elemental-band.md` |
| probability: 0 (WARN) | `_edge-cases/_probability-zero.md` |

### Contextual Gating (era / location / scene_type / character_present)

| Feature | File |
|---------|------|
| era — single string | `events/war-of-the-broken-mountain.md` (`era: medieval`) |
| era — array | `characters/ayre-waesphyra.md` (`era: [medieval, renaissance]`) |
| era — absent (always matches) | `characters/gorduin-wynlar.md` |
| location — single string | `locations/bellsummit.md` (`location: Bellsummit`) |
| location — array | `lore/binding-compact.md` (`location: [Bellsummit, Scorchhelm]`) |
| scene_type — single | `events/war-of-the-broken-mountain.md` (`scene_type: combat`) |
| scene_type — array | `locations/scorchhelm.md` (`scene_type: [combat, exploration]`) |
| scene_type — social | `locations/the-hidden-dragonfruit-tavern.md` |
| character_present — single | `items/angel-crown.md` (`character_present: [Gorduin Wynlar]`) |
| character_present — multiple (AND) | `characters/felicitas-langguth.md` (`character_present: [Gorduin Wynlar, Ayre Waesphyra]`) |
| All 4 fields combined | `lore/solstice-ritual.md` |
| tolerance=strict blocks all-gated | test scenario 8 below |
| tolerance=lenient allows all-gated | test scenario 9 below |

### Injection Position / Role

| Feature | File |
|---------|------|
| position: before | `locations/east-hamp.md` |
| position: after | `locations/saseopt-district.md` |
| position: in_chat, depth: 0 | `locations/south-sool.md` |
| position: in_chat, depth: 4 | `locations/chorstap-row.md` |
| position: in_chat, role: system | `meta/duskfrost-world-rules.md` |
| position: in_chat, role: user | `lore/oracles-summit.md` |
| position: in_chat, role: assistant | `lore/scribe-fragment.md` |
| depth without in_chat (WARN) | `_edge-cases/_depth-without-inchat.md` |
| role without in_chat (WARN) | `_edge-cases/_role-without-inchat.md` |

### Special Entry Types

| Feature | File(s) |
|---------|---------|
| Constant (lorebook-always) | `meta/duskfrost-world-rules.md`, `meta/duskfrost-geography.md`, `meta/duskfrost-triumvirate.md`, `meta/duskfrost-law-enforcement.md`, `species/zuvine.md`, `species/cirilae.md`, `species/elf.md`, `species/dwarf.md`, `species/human.md` |
| Seed (lorebook-seed) | `meta/duskfrost-tone-guide.md`, `meta/duskfrost-era-guide.md`, `meta/duskfrost-timeline.md` |
| Seed oversized >2000 tok (WARN) | `meta/duskfrost-timeline.md` |
| Bootstrap (lorebook-bootstrap) | `meta/duskfrost-magic-system.md`, `species/bolludine.md` |
| Disabled (enabled: false) | `_edge-cases/_disabled-entry.md` |
| Never-insert (lorebook-never) | `_edge-cases/_never-insert.md` |

### Content / Parsing Edge Cases

| Feature | File |
|---------|------|
| Wiki-links `[[Target]]` | most entries |
| Wiki-links with display `[[T\|Display]]` | several lore entries |
| Unresolved wiki-links (INFO) | `_edge-cases/_unresolved-links.md` |
| Image embeds `![[img.png]]` (stripped) | `_edge-cases/_image-embeds.md` |
| Obsidian comments `%%...%%` (stripped) | `_edge-cases/_obsidian-comments.md` |
| deeplore-exclude blocks (stripped) | `_edge-cases/_deeplore-exclude-block.md` |
| HTML `<div class="meta-block">` (kept) | most entries |
| First H1 heading (stripped) | all entries with `# Title` |
| UTF-8 BOM prefix (stripped) | `_edge-cases/_bom-prefix.md` |
| YAML block scalar summary `\|` | `_edge-cases/_block-scalar-summary.md` |
| Inline array keys `keys: [a, b]` | `_edge-cases/_inline-array-keys.md` |
| Number summary `summary: 42` | `_edge-cases/_number-summary.md` |
| Oversized content >1500 tok (WARN) | `_edge-cases/_oversized-entry.md` |
| Empty content (WARN) | `_edge-cases/_empty-content.md` |
| Duplicate titles (ERROR) | `_duplicate-title-a.md` + `_duplicate-title-b.md` |

### Graph Topology

| Topology Feature | Entries |
|-----------------|---------|
| Hub node (10+ connections) | `characters/gorduin-wynlar.md` |
| Dense cluster (5+ mutual links) | gorduin-wynlar, ayre-waesphyra, oracles-of-might, bellsummit, duskfrost-magic-system |
| Isolated pair (no other links) | `events/assault-of-broken-love.md` ↔ `events/battle-of-vryhs.md` |
| Mutual excludes edges | bonehands ↔ solarguard, zuni-dhegevnac ↔ grolgrurim-bluntgut |
| Requires chain (directional) | adelas → gorduin → oracles-of-might |
| Cascade chain | angel-crown → war-of-glimmering-hope |

---

## Entry Relationship Graph

```
REQUIRES CHAIN (A must match before B triggers):
  Adelas Gilydark ──requires──► Gorduin Wynlar ──requires──► Oracles of Might

MUTUAL EXCLUDES (cannot appear together):
  Bonehands ◄──excludes──► Solarguard
  Zuni Dhegevnac ◄──excludes──► Grolgrurim Bluntgut

CASCADE LINKS (B auto-injects when A matches):
  Gorduin Wynlar ──cascade──► Oracles of Might
  Gorduin Wynlar ──cascade──► Bellsummit
  Gorduin Wynlar ──cascade──► Duskfrost Magic System
  Sarros Sylren ──cascade──► War of Glimmering Hope
  Angel Crown ──cascade──► War of Glimmering Hope
  Bellsummit ──cascade──► Oracles of Might
  Bellsummit ──cascade──► Duskfrost Academy

DENSE CLUSTER (all link to each other):
  ┌─────────────────────────────────────────────────────┐
  │  Gorduin Wynlar ── Ayre Waesphyra                   │
  │       │                  │                          │
  │  Oracles of Might ── Bellsummit                     │
  │       │                  │                          │
  │  Duskfrost Magic System ──────────────────────────  │
  └─────────────────────────────────────────────────────┘

ISOLATED PAIR (only links to each other):
  Assault of Broken Love ◄──► Battle of Vryhs
```

---

## Manual QA Test Scenarios

### Scenario 1: Era Gating
1. `/dle-set-era medieval`
2. Send: "Tell me about the war"
3. **Expect:** `events/war-of-the-broken-mountain.md`, `lore/war-of-glimmering-hope.md`, `lore/battle-of-the-false-prophet.md` eligible
4. **Expect NOT:** `events/war-of-kroyhr.md` (era: ancient), `events/battle-of-the-vanguard-crossing.md` (era: reconstruction)

### Scenario 2: Location Gating
1. `/dle-set-location Bellsummit`
2. Send: "I walk through Gorduin's office"
3. **Expect:** `characters/gorduin-wynlar.md` AND `locations/bellsummit.md` inject (both match location)
4. **Expect NOT:** `lore/oracles-summit.md` (requires character_present Ayre Waesphyra)

### Scenario 3: Cascade Links
1. Send: "The Angel Crown sits in the vault"
2. **Expect:** `items/angel-crown.md` matches AND `lore/war-of-glimmering-hope.md` auto-injects via cascade
3. **Expect:** On next generation mentioning Angel Crown — no injection (cooldown:2)

### Scenario 4: Requires Chain (3-deep)
1. Send: "Adelas is cataloguing today"
2. **Expect:** `characters/adelas-gilydark.md` does NOT inject (requires Gorduin, who is not matched)
3. Send: "Gorduin and Adelas are cataloguing"
4. **Expect:** Both inject (Gorduin matched, so Adelas's require is satisfied; Gorduin requires Oracles of Might which must be in vault)

### Scenario 5: Mutual Excludes
1. Send: "The Bonehands collect tribute on the docks"
2. **Expect:** `organizations/bonehands.md` injects; `organizations/solarguard.md` does NOT inject
3. Send: "The Solarguard patrols Scorchhelm"
4. **Expect:** `organizations/solarguard.md` injects; `organizations/bonehands.md` does NOT inject

### Scenario 6: Warmup (3 occurrences required)
1. Send: "Snugug is at the docks" — **Expect:** no injection (count 1)
2. Send: "Snugug blocks the entrance" — **Expect:** no injection (count 2)
3. Send: "Snugug steps forward" — **Expect:** injection (count 3, warmup satisfied)

### Scenario 7: Cooldown (skip 1 generation)
1. Send: "Grolgrurim negotiates" — **Expect:** `characters/grolgrurim-bluntgut.md` injects (warmup:1 satisfied)
2. Send: "Grolgrurim continues the meeting" — **Expect:** no injection (cooldown:1 — skip 1 generation)
3. Send: "Grolgrurim stands up" — **Expect:** injects again (cooldown expired)

### Scenario 8: All-4-Fields Gating (strict blocks)
1. Clear all context: `/dle-set-era`, `/dle-set-location`, etc. (no active context)
2. Set tolerance to `strict` in settings
3. Send: "The solstice ceremony begins" (matches `lore/solstice-ritual.md` keywords)
4. **Expect:** No injection — `solstice-ritual.md` requires all 4 gating fields; none are set; strict mode blocks

### Scenario 9: All-4-Fields Gating (lenient allows)
1. Same setup as Scenario 8, but set tolerance to `lenient`
2. Send: "The solstice ceremony begins"
3. **Expect:** Injection — lenient mode allows entries even when their gating context is not fully set

### Scenario 10: character_present (multi-character AND)
1. Set character_present to only Gorduin Wynlar (not Ayre)
2. Send: "Felicitas arrives at the meeting"
3. **Expect:** `characters/felicitas-langguth.md` does NOT inject (requires BOTH Gorduin AND Ayre present)
4. Set character_present to include both Gorduin Wynlar and Ayre Waesphyra
5. Send: "Felicitas arrives at the meeting"
6. **Expect:** Injection

### Scenario 11: Health Check Validation
1. Connect this vault in a test vault config
2. Run `/dle-rebuild`
3. Run `/dle-health`
4. **Verify:** 7+ errors including circular requires, self-exclude, duplicate titles, orphaned requires, requires+excludes contradiction
5. **Verify:** 9+ warnings including empty content, probability zero, cooldown-on-constant, oversized entries, short keywords
6. **Verify:** 1 info: unresolved wiki-link

### Scenario 12: Graph Topology
1. Run `/dle-graph`
2. **Verify:** Gorduin Wynlar is a hub node with many connections
3. **Verify:** Assault of Broken Love and Battle of Vryhs appear as an isolated pair
4. **Verify:** Oracles of Might cluster is visible (gorduin, ayre, bellsummit, oracles-tower, etc.)
5. **Verify:** Bonehands and Solarguard show excludes edges (if rendered)

### Scenario 13: refine_keys Gate
1. Send: "Ayre is working today"
2. **Expect:** `characters/ayre-waesphyra.md` does NOT inject (keyword "Ayre" matches, but refine_keys [ancient, elder, pre-Calamity] not present in text)
3. Send: "Ayre is studying ancient texts"
4. **Expect:** Injection (both primary key AND refine_key satisfied)

### Scenario 14: AI-Only Entry (scanDepth: 0)
1. Enable AI search, set to two-stage mode
2. Send: "There's a secret agreement between the houses"
3. **Expect:** `lore/hidden-compact.md` appears in AI results (AI can find it semantically)
4. **Verify:** It does NOT appear in keyword-only mode (scanDepth: 0 means no keyword scanning)

### Scenario 15: Injection Position Verification
1. Send any message that matches `locations/east-hamp.md` keywords ("East Hamp")
2. **Verify:** Injected BEFORE the chat (position: before)
3. Match `locations/saseopt-district.md` ("Saseopt")
4. **Verify:** Injected AFTER the chat (position: after)
5. Match `locations/south-sool.md` ("South Sool")
6. **Verify:** Injected IN CHAT at depth 0 (most recent message position)

---

## Vault Entry Index

### Root-Level Entries

**Bloodline Affinities** (`Bloodline Affinities.md`) — arcane lore entry at vault root (not in a subdirectory)

### characters/ (51 entries)

**Inner Circle (priority ≤30):** Archmage Tessavel Orindal (elf, Academy head), Warden-Captain Orin Castellan (half-elf, Solarguard), High Champion Mira Veldthar (human, Champions of Patience), Gorduin Wynlar (Head Archivist, hub node), Ayre Waesphyra (Senior Researcher)

**Core Cast (priority 31-45):** Corwin Velkhast (succession claimant), Gorbag Thrice-Scarred (orc Bonehands boss), Tybellan Hercyne (Champion field agent), Thalassa Velmorin (Zuvine salvager), Quirkavel Doss (Bolludine courier), Felicitas Langguth, Sarros Sylren, Zuni Dhegevnac, Grolgrurim Bluntgut

**Supporting Cast (priority 46-65):** Barlyn Greymantle (Cirilae mason), Kaldor Echbrine (Gnaino guide), Rhenar Frosthollow (Delivese leader), Elspeth Dunvale (wild mage), Snugug (Bonehands enforcer, warmup:3), Kabugbu (informant, probability:0.1/cooldown:5), Commander Bryndas Holte, Lieutenant Orvaine Shel, Corporal Thresh Dunmore, Kasper Lampi, Innkeeper Roswyn Halse, and 20+ more merchants, scholars, spies, and street runners

### events/ (25 entries)

**Pre-Calamity:** War of Kroyhr (ancient ley-line conflict), Calamity Onset (the fall)

**Reconstruction:** Battle of the Vanguard Crossing, First Triumvirate Compact, Great Census of 180, Champions Founding, Attack of Steel, Siege of Am, Assault of Broken Love, Battle of Vryhs

**Medieval:** Solarguard Founding, Academy Fire of 211, Night of Empty Chairs, War of the Broken Mountain, Harbour Expansion Project, Bonehands Founding, Watchers Treaty, Morveth Arcane Monopoly Broken, Great Flood of Highwallow, Oracles Schism, Zuvine Harbor Treaty

**Renaissance:** Velkhast Succession Crisis, Resonance Discovery, Scar Mapping Expedition, Archive Disappearance

### items/ (20 entries)

Pre-Calamity artifacts and dangerous objects, each with specific provenance, costs, and current whereabouts. Notable: Angel Crown (prophetic inscription, cooldown:2, cascade to War of Glimmering Hope), Severance Dagger (missing, last traced to Bonehands), Tiara of Teleportation (probability:0.3, rumored near Hollow Roads), Sword of Enigmas (probability:0.5, in_chat injection), Mirror of Binding (Archive restricted section)

### locations/ (35 entries)

**Districts:** Bellsummit, Amberburgh, Bayside Shushail, Scorchhelm, Highwallow, Rimeborough, Redpond, East Hamp, Saseopt, South Sool

**Key buildings:** Academy Main Hall, Archive Building, Oracles Tower, Solarguard Headquarters, Bonehands Counting House, Champions Chapel, Compact Vault (Scorchhelm), Resonance Observatory

**Neighborhoods & features:** Bolludine Quarter, Zuvine Harbor District, Chorstap Row (reagent alley), Cliff Stairs, Hollow Road Entrance, Rappiop Grove (Amberburgh park), Redpond Waterfront, Rimeborough Market, Highwallow Mutual Aid Hall, Highwallow Night Clinic

**Taverns & inns:** The Hidden Dragonfruit (Bayside Shushail), The Drowned Anchor (harbor dive), The Jealous Librarian (Academy pub), The Majestic Boulder (Vorruk bar), Ye Olde Guinea Pig Inn

### lore/ (45 entries)

**Magic system:** Sigil Theory, Resonance Frequency Theory, Arcane Bloodline Inheritance, Blood Binding, True Names, Forbidden Sigil Catalog, Ley Line Geography, Resonance Scar Properties, Resonance Scar Tunnels

**History & politics:** Binding Compact, Academy Charter Amendments, Academy Restriction Tiers, Triumvirate Secret Sessions, Guild Hierarchy Laws, Scorchhelm Fortifications

**Culture & customs:** Amberburgh Trade Customs, Nightmarket Customs, Bolludine Shard Politics, Zuvine Song Cycles, Highwallow Underground Economy, Nightwatch Protocol, Mage Dueling Code, Duskfrost Food Economy

**Scholarship:** Antecedent Script, Pre-Calamity Species Records, Thornwick Pallasys Biography, Calamity Theories, Calamity Survivor Adaptations, Reconstruction Oral History, Scribe Fragment

**Restricted/dangerous:** Hidden Compact (scanDepth:0, AI-only), Solstice Ritual (all 4 gating fields), Seven Seals, Phantom Bridge Legend

### meta/ (15 entries)

**Constants (always injected):** Duskfrost World Rules, Duskfrost Geography, Duskfrost Triumvirate, Duskfrost Law Enforcement

**Seeds (AI story context):** Duskfrost Tone Guide, Duskfrost Era Guide, Duskfrost Timeline (oversized)

**Bootstrap (new chat injection):** Duskfrost Magic System

**Standard meta:** Duskfrost Academy, Duskfrost Currency, Duskfrost Climate, Duskfrost Religion, Duskfrost Daily Life, Duskfrost Region, Duskfrost Naming Conventions

### organizations/ (20 entries)

**Enforcement:** Solarguard (city watch, ~400 officers), Wardenship (Academy arcane enforcement, 22 wardens)

**Criminal:** Bonehands (harbor/marsh crime, Council of Five), Old Harbor Brotherhood (2-block holdout)

**Guilds:** Oracles of Might (arcane research), Marblesmiths (construction, majority Cirilae), Amberburgh Merchants League, Night Market Guild (Orvathi-run), Salvagers Compact (harbor salvage), Redpond Fishers Cooperative, Velkhast Trading Company

**Orders & societies:** Champions of Patience (knightly order, declining), Thornwick Society (scholarly), Academy Alumni Fellowship, Mages of the Patient (theoretical research)

**Other:** Bellsummit District Council, Harcyne Granary Authority (food monopoly), Highwallow Mutual Aid Society, Keepers of the Scar (spiritual), Scourge of Vitality (cult)

### species/ (18 entries)

**Constants (always injected):** Zuvine (aquatic/bioluminescent), Cirilae (stone-bonded), Elf, Dwarf, Human

**Bootstrap:** Bolludine (insectoid couriers)

**Standard species (12):** Bhissalae (amphibious), Crennish (photographic memory), Delivese (cold-resistant), Gnaino (subterranean), Halfblood notes, Kethvali (nomadic traders), Lorant (winged), Orvathi (nocturnal), Selaveth (arcane-sensitive), Thyren (plant-bonded), Velhari (illusory), Vorruk (large laborers)

**Tag subcategories:** species/aquatic, species/humanoid, species/insectoid, species/subterranean, species/winged, species/nocturnal, species/arcane, species/botanical, species/illusory, species/nomadic

### DeepLore/

**field-definitions.yaml** — Custom gating field definitions for this vault. DLE reads this file (path configurable via `fieldDefinitionsPath` setting, default `DeepLore/field-definitions.yaml`) to discover user-defined contextual gating fields beyond the built-in era/location/scene_type/character_present.

### _edge-cases/ (27 entries — DO NOT EDIT)

Intentionally broken/weird entries for health check and parser testing:
_empty-content, _orphaned-requires, _circular-requires-a, _circular-requires-b, _self-exclude, _disabled-entry, _never-insert, _oversized-entry, _no-keywords, _regex-special-keys, _unicode-keys, _short-keys, _probability-zero, _cooldown-on-constant, _depth-without-inchat, _role-without-inchat, _bom-prefix, _block-scalar-summary, _inline-array-keys, _number-summary, _duplicate-title-a, _duplicate-title-b, _unresolved-links, _obsidian-comments, _deeplore-exclude-block, _image-embeds, _requires-excludes-contradiction

---

## How to Use This Vault

### For RP Testing
1. Point DLE at this vault directory
2. Run `/dle-rebuild` — should index ~256 entries (minus disabled/never-insert)
3. Set era to `medieval` or `renaissance`, set a location, and start chatting
4. The vault is a coherent world — entries cross-reference naturally and the AI should produce consistent RP

### For QA Testing
1. Run through the Manual QA Test Scenarios above
2. Run `/dle-health` — verify errors/warnings match the expected list
3. Run `/dle-graph` — verify topology (hub nodes, clusters, isolated pairs, excludes edges)
4. The `_edge-cases/` directory covers parser edge cases and health check conditions

### Health Check Baseline
The expected errors and warnings above serve as the baseline. Any deviation (extra warnings, missing errors) indicates a health check regression.

### Future Automated Tests
Integration tests can read vault files directly, call `buildIndex()`, and assert matching behavior against known inputs without requiring a running Obsidian instance. The deterministic content makes assertions stable.
