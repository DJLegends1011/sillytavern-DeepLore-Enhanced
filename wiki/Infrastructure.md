# Infrastructure

The under-the-hood systems that make DeepLore fast, reliable, and provider-agnostic. Most of this is automatic. The page exists so you can reason about failure modes, costs, and where your data goes.

---

## Connection channels (six independent)

DeepLore has six independent AI connection channels. Each feature picks its own profile, model, and timeout. The channels are kept separate on purpose so you can route a tool-calling Claude or GPT-4o to Emma while AI search runs on a cheap model, or split Scribe to a long-context model and keep retrieval on Haiku.

| Channel | Settings prefix | Default mode | What it does |
|---|---|---|---|
| **AI Search** | `aiSearch*` | `profile` | Stage-2 retrieval. Selects entries from the keyword-matched manifest. The "source" channel that others can inherit. |
| **Session Scribe** | `scribe*` | `inherit` | Auto-summaries written back to the vault every N messages. |
| **Auto Lorebook** | `autoSuggest*` | `inherit` | AI-suggested new entries from chat content. |
| **AI Notepad** | `aiNotepad*` | `inherit` | Extract-mode session notes (the post-generation extraction call). Tag mode uses no AI channel of its own. |
| **Librarian** | `librarian*` | `inherit` (since v3) | Emma's chat sessions and the writing-AI tool calls (`search`, `flag`). Requires a tool-calling-capable connection; falls back to plain generation if unsupported. |
| **Optimize Keys** | `optimizeKeys*` | `inherit` | The `/dle-optimize-keys` AI keyword refiner. |

`inherit` mode reuses the AI Search connection's profile and model. The feature still keeps its own `maxTokens` and `timeout`. Set the channel to `profile` and pick its own profile to override.

The Librarian channel is the most commonly broken out separately. The reason: function calling is required for Emma and the writing-AI tools, and not every AI Search profile points at a tool-calling model. Per-feature override means you can leave AI Search on a non-tool model and route Librarian to Claude / GPT-4o / OpenRouter Haiku.

> [!IMPORTANT]
> The Librarian channel is intentionally separate from retrieval. Don't collapse them. If you want Emma cheap, point her at Haiku via her own profile and leave AI Search on whatever you like.

---

## Connection modes (profile and inherit)

Each channel runs in one of two modes:

- **`profile`:** routes through SillyTavern's Connection Manager (CMRS, the `ConnectionManagerRequestService`). Picks up presets, instruct templates, system prompts, and provider quirks already configured in ST. This is the only AI-calling mode in v2.5.
- **`inherit`:** non-AI-Search features only. Mirrors AI Search's mode/profile/model. Since AI Search is always `profile` in v2.5, an inheriting channel always resolves to a profile.

> [!NOTE]
> A third mode, **`proxy` (Custom Proxy)** — which routed through ST's CORS proxy to a separate Anthropic-compatible endpoint such as claude-code-proxy — was removed in v2.5. The UI option is hidden, the boot migration flips any stored `proxy` setting to `profile` (and shows a one-time notice), and any code path that still receives `proxy` throws:
>
> ```
> Custom Proxy mode was removed in v2.5. Pick a Connection Profile in
> DLE Settings → Connection → AI Connections.
> ```
>
> The proxy code is retained behind the hidden UI for rollback only. Treat Connection Profile as the single supported path.

---

## ST CORS proxy

DeepLore has no server plugin and, as of v2.5, no longer routes any AI call through SillyTavern's CORS proxy. In `profile` mode CMRS makes its own request server-side through ST's normal chat-completions route, so `enableCorsProxy: true` is **not** required for any DeepLore AI feature.

(The removed Custom Proxy mode used to post Anthropic Messages API payloads to `/proxy/<encoded URL>`; that path is now unreachable in production. ST's own raw-URL API requests may still need `enableCorsProxy: true`, but DeepLore does not.)

Obsidian fetches go directly to your local Obsidian REST endpoint (no CORS bridge). Browser CORS is allowed by the Local REST API plugin's response headers when the call originates from `http://localhost`.

---

## Forced JSON output (provider matrix)

In `profile` mode, AI Search sends a `json_schema` field on the override payload. ST's chat-completions route translates this per-provider, so you don't have to think about it:

| Provider class | What ST does with `json_schema` |
|---|---|
| OpenAI, OpenRouter, Groq, xAI, Fireworks, Custom, Azure | Strict `json_schema` on the request |
| Claude (Anthropic) | Forced `tool_choice` (translated) |
| Gemini | `responseSchema` |
| Mistral, DeepSeek, Moonshot, Z.AI | Soft `json_object` mode |
| Anything else | Field silently dropped |

DLE sends the schema unconditionally. Worst case is no-op; best case is strict parseable JSON without any prompt-engineering tricks.

The Claude exception: ST translates `json_schema` to forced `tool_choice`, which the Claude API rejects when extended thinking is enabled (`Thinking may not be enabled when tool_choice forces tool use.`). Thinking is on by default for Claude 4.x via profile presets. To avoid breaking other tooling that uses those presets, AI Search detects Claude profiles by model prefix and skips the schema for Claude. The JSON extractor in `ai.js` is permissive enough to handle Claude responses without the schema.

(Pre-v2.5 the removed Custom Proxy mode talked to the Anthropic Messages API directly and had full payload control, including `cache_control` breakpoints. With Custom Proxy gone, all forced-JSON handling runs through the profile/CMRS matrix above.)

---

## Multi-vault

Connect multiple Obsidian vaults at once. Each vault has its own host, port, API key, HTTPS toggle, and enable flag. Entries from all enabled vaults merge into a single index.

**Setup:**

1. In Settings → Connection → Obsidian, click **Add Vault** to add a new connection.
2. Each vault has Name, Host, Port, HTTPS, API Key, and Enabled.
3. Click **Test All** to verify all enabled connections.
4. Use **Scan Vaults** to sweep a port range looking for responding Local REST API instances.

**Notes:**

- Entries from all enabled vaults merge and are treated identically by the pipeline.
- Each entry tracks its `vaultSource` field for diagnostics, `trackerKey` (`vaultSource:title`) collisions, and dedup.
- The Multi-Vault Conflict Resolution setting controls how entries with the same title across vaults are handled (`all` keeps both disambiguated; `first`/`last` keep one; `merge` combines content).
- The health check audits multi-vault configuration (overlapping titles, unreachable vaults, mismatched tag conventions).

---

## IndexedDB persistent cache

The parsed vault index gets saved to IndexedDB (database `DeepLoreEnhanced`, store `vaultCache`) after every successful build.

On page load:
1. DLE hydrates from IndexedDB instantly (no Obsidian call needed).
2. A background validator hits Obsidian and reconciles changes.
3. UI surfaces show the cached state immediately so the first generation works without waiting.

This lets DLE survive Obsidian being briefly unreachable on page load. No settings to configure.

---

## Reuse sync

When auto-sync triggers, DLE fetches all vault file contents but avoids redundant work:

1. Fetches all file contents from Obsidian (local fetch is fast).
2. Computes content hashes and compares against the existing index.
3. Reuses already-parsed entries for unchanged files (skips parse and tokenize).
4. Re-parses only new or modified files.
5. Removes entries for deleted files.
6. Falls back to a full rebuild if the reuse approach fails.

The savings come from skipping the expensive parse/tokenize step for unchanged entries, not from reducing network calls.

---

## Vault change detection and auto-sync

When the index rebuilds, DLE compares the new index against the previous one and reports the diff.

**Detected changes:**

- New entries added
- Entries removed
- Modified content
- Changed keywords

**Auto-sync polling:** set Auto-Sync Interval to re-check the vault every N seconds. When changes get detected, toast notifications summarize what changed (controlled by Show Sync Change Toasts).

**Manual refresh:** click **Refresh Index** in Settings → System, or run `/dle-refresh`.

---

## Circuit breakers (Obsidian and AI)

DeepLore runs two independent circuit breakers.

**Obsidian (per-vault):**

- States: closed (normal), open (failing; skip calls during backoff), half-open (let one probe through).
- Exponential backoff from 2s to 15s.
- Keyed by `host:port` so each vault has independent failure tracking.
- Resets when a call succeeds.
- Stale circuit breakers (vaults removed from config) get pruned.

**AI search:**

- Threshold: 2 consecutive failures to trip.
- Cooldown: 30s before a half-open probe is allowed.
- Half-open probe gate ensures exactly one caller goes through after the cooldown.
- Throttled calls do not trip the breaker (the throttle is 500ms minimum between AI calls).
- User aborts, timeouts, rate-limit responses (HTTP 429), and auth errors (HTTP 401/403) also do not trip the breaker.
- 5xx responses, network errors, and persistent JSON-parse failures do trip it.

When the AI breaker is open, AI search falls back to keyword results for the cooldown window.

---

## Generation lock and chat epoch

Two race-condition guards run during generation:

- **`generationLock`** with `generationLockTimestamp` and `generationLockEpoch`. Prevents concurrent generations from clobbering each other. Stale-lock detector force-releases after 30s timeout. The Librarian agentic loop refreshes the timestamp before every API call and tool processing to prevent the stale-lock detector from firing mid-loop.
- **`chatEpoch`** increments on `CHAT_CHANGED`. Epoch-sensitive operations re-check the value after every `await` to bail out if the user switched chats mid-flight. Each turn's decision (which entries injected, the full trace, and the epoch/message-index/chat-id stamp) is written as a single record to the Verdict store, which replaced the older racing globals that used to track this.

`buildEpoch` increments on force-release of a stuck indexing flag. In-progress index builds capture the epoch at start and bail out if the value changes mid-build (zombie guard).

---

## Sliding window AI cache

AI search caches results with a sliding window strategy. The manifest and chat context are hashed separately. When only new chat messages get appended (vault unchanged):

- If the new messages don't reference any vault entity names or keys, cached results get reused.
- If new messages mention vault entities, the cache invalidates and a fresh AI call runs.
- A prefix-content-hash check catches mid-context edits (sliding window only checks lines at the end; an edit to existing lines invalidates the cache).
- An entity-regex version stamp catches the case where `entityShortNameRegexes` got rebuilt since the cache was written.

Most regenerations, swipes, and non-lore-relevant messages reuse cached results automatically.

---

## Hierarchical manifest clustering (optional Category Pre-filter)

Off by default. Toggle via AI Search → Show Filtering → **Category Pre-filter**.

For large vaults (40+ selectable entries with 4+ distinct categories), AI search uses a two-call approach:

1. Group entries by category (extracted from tags/type fields).
2. First AI call: select relevant categories from the full list.
3. Second AI call: select specific entries from within those categories.

Safety valve: if the category filter would remove more than the configured aggressiveness fraction of entries (default 0.8 → up to 80%), it falls back to the full manifest. Requires at least 4 distinct categories to activate at all.

---

## Prompt cache optimization

Explicit `cache_control` breakpoints were a feature of the removed Custom Proxy mode (it talked to the Anthropic Messages API directly, so it could place the rarely-changing manifest first and mark it cacheable). `profile` mode does not set `cache_control` breakpoints — most providers other than Anthropic have no equivalent, and CMRS does not expose them. DeepLore still keeps API calls down through the sliding-window AI cache described above (most regenerations and swipes reuse cached selections without any API call at all).

---

## Persistence (where DeepLore stores things)

DeepLore stores state in three places:

**ST extension settings** (`extension_settings.deeplore_enhanced`, persisted to disk by `saveSettingsDebounced`):

- All UI settings from the Settings popup
- Vault connection list (`vaults[]`)
- API keys (plaintext, platform limitation; use a dedicated lorebook vault, not your personal one)
- Saved prompt presets (`promptPresets`)
- All-time analytics counters
- Saved graph node positions
- The wizard-completed flag

**chat_metadata** (per-chat, saved by ST's normal chat persistence):

- `deeplore_notebook`: Author's Notebook content
- `deeplore_ai_notepad`: AI Notepad accumulated session notes
- `deeplore_lastScribeSummary`: prior Scribe note context
- `deeplore_injection_log`: injection dedup history
- `deeplore_pins` / `deeplore_blocks`: per-chat `{title, vaultSource}` arrays
- `deeplore_context`: contextual gating state (era, location, scene type, character present, custom fields)
- `deeplore_chat_counts`: per-chat injection counts keyed by `trackerKey`
- `deeplore_lore_gaps`: Librarian gap records
- `deeplore_lore_gaps_hidden`: first-tier soft-removed gap IDs (re-flag resurfaces)
- `deeplore_lore_gaps_dismissed`: second-tier permanently dismissed gap IDs
- `deeplore_librarian_session`: persisted Librarian session draft
- `deeplore_folder_filter`: folder-path filter array
- `deeplore_swipe_injected_keys`: per-swipe injected `trackerKey`s for accurate rollback across reloads

**IndexedDB** (`DeepLoreEnhanced` database, `vaultCache` store):

- Parsed vault index (entries plus BM25 inverted index)
- Used for instant hydration on page load before background validation against Obsidian

Per-message tool call records are stored on `message.extra.deeplore_tool_calls` (not chat_metadata).

---

## Provider compatibility

Profile mode works with any provider SillyTavern's Connection Manager supports:

- **Cloud APIs:** Anthropic (Claude Haiku / Sonnet / Opus), OpenAI (GPT-4o, GPT-4o-mini, GPT-5), Gemini, Cohere, Mistral, DeepSeek, OpenRouter, Groq, xAI, Fireworks, Z.AI, Moonshot, Azure OpenAI.
- **Local backends:** Oobabooga, KoboldCpp, llama.cpp, Custom (any OpenAI-compatible local endpoint).

Forced JSON output works on every provider listed above (see the matrix earlier on this page). For providers without strict schema support, DeepLore's JSON extractor handles typical responses without help.

**Function calling (Librarian):** requires a tool-calling provider. Claude 3+/4.x, GPT-4o, GPT-5, Gemini Pro, OpenRouter for any of those models. Local models that route through llama.cpp's tool-calling spec also work. The Librarian feature auto-enables function calling on the active connection when you turn it on.

**Local-model latency:** local backends typically need 60-120s for AI search on long chats. Cloud APIs respond in 5-15s. Set the per-channel timeout accordingly. The default AI Search timeout is 20s; increase to 60000-120000ms for local.

---

## Settings migrations

Settings versions are tracked in `settingsVersion` (current: 5). Migrations run on load when the stored version is behind:

- **v0 → v1:** initial versioned settings (no behavior change).
- **v1 → v2:** Librarian connection consolidation. `librarianSessionModel` got renamed to `librarianModel`. Existing per-tool connection modes are preserved; only Librarian's model field migrates.
- **v2 → v3:** Librarian default connection mode changed from `profile` to `inherit` for unconfigured users (those with `librarianConnectionMode: 'profile'` and an empty `librarianProfileId`). Users who explicitly chose a profile and set a profileId are left alone.
- **v3 → v4:** Custom Proxy mode removed. Any per-feature connection mode still set to `proxy` (AI Search, Scribe, Librarian, AI Notepad, Auto Lorebook, Optimize Keys) flips to `profile`. `*ProxyUrl` keys and `profileId`s are left untouched, and a one-time popup asks affected users to pick a profile.
- **v4 → v5:** adds the `wiImportEmHandling` setting (Example Messages import mode), defaulted to `append`.

Migrations run idempotently and persist immediately. The `settingsVersion` value is what gates re-runs.
