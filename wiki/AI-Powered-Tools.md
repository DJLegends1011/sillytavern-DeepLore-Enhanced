# AI-Powered Tools

Features that use AI to help you build, maintain, and grow your vault. These run alongside [[AI Search]] (which selects entries during generation); the tools on this page actively create or improve vault content.

The headline v2 feature on this page is the **Librarian**, which has two halves: writing-AI tools (`search` and `flag`) that fire mid-generation, and **Emma**, a separate chat agent that helps you author the missing entries.

> [!NOTE]
> Each tool below has its own independent connection channel. You can route Emma to one model, the Scribe to another, AI Search to a third. Defaults inherit from AI Search. Each channel is a SillyTavern **Connection Profile** (or "Inherit"); the legacy Custom Proxy mode was removed in v2.5 — see [[AI Search#connection]] for the migration note.

---

## The Librarian (Emma)

The Librarian is how your vault grows as you roleplay. Two halves, one feature.

**Half 1: writing-AI tools.** During generation, the writing AI gets two function-calling tools: `search` and `flag`. When it reaches for a detail and isn't sure if your vault has it, it calls `search`. If the vault genuinely doesn't have it, it calls `flag` instead of inventing.

**Half 2: Emma.** A separate chat agent (her own connection channel, her own toolset) for authoring entries. You open a flag from the Librarian inbox in the drawer, and chat with Emma about the gap. She checks what already exists, finds similar entries to dedupe against, pulls in any style guides marked `lorebook-guide`, and drafts the new entry. Write-to-vault saves it back to Obsidian.

> [!IMPORTANT]
> The Librarian auto-enables function calling on the active connection. If you disable function calling elsewhere on that profile, tool invocations break mid-generation with no error toast.

### Writing-AI tools (`search` and `flag`)

Both fire inside the writing AI's normal generation. Tool activity collapses into one expandable dropdown on the final assistant message; you still get one clean reply per turn.

| Tool | Args | What it does |
|---|---|---|
| `search` | `queries: string[]` (up to 4) | BM25 vault search. Returns the single best hit with full content, plus up to 3 graph-linked entries in summary form. Excludes already-injected entries and `lorebook-guide` entries. |
| `flag` | `title`, `reason`, `urgency` (`low`/`medium`/`high`), `flag_type` (`gap`/`update`), `entry_title` | Records a gap or update request to the Librarian inbox. Re-flagging a similar gap merges with the existing record (frequency increment, urgency escalation). |

The writing AI is capped at `librarianMaxSearches` searches per generation (default 2) and 5 flag calls. Internally a third tool, `write`, captures the final prose and transitions the loop from SEARCH to FLAG phase.

### Emma's toolset

Inside an Emma session, she has her own internal tool set (12 tools). Highlights:

| Tool | Purpose |
|---|---|
| `search_vault` | BM25 search across the vault |
| `get_entry` | Truncated preview + metadata |
| `get_full_content` | Full entry content; populates her draft state |
| `find_similar` | Duplicate detection before authoring a new entry |
| `get_links` / `get_backlinks` | Walk `resolvedLinks` outgoing or incoming |
| `list_entries` | Filter by type and tag |
| `get_recent_chat` | Last N messages from the active chat |
| `compare_entry_to_chat` | Side-by-side entry + recent chat |
| `flag_entry_update` | Write a gap record from inside the session |
| `get_writing_guide` | Fetch entries tagged `lorebook-guide`. Available only when guide entries exist. |

The `lorebook-guide` tag marks an entry as Librarian-only. It is never injected into the writing AI through any pipeline path; only Emma can see it via `get_writing_guide`.

### Connection channel

The Librarian has its own connection channel (`librarianConnectionMode`), independent of AI Search. Defaults to **Inherit** (resolves to AI Search settings); set it to a specific **Connection Profile** to route Emma through a different model. Tool calling is required, so the resolved provider must support function calling.

Supported tool-calling providers: Claude, Gemini (makersuite/vertexai), OpenAI-compatible (incl. NanoGPT, AI21, Pollinations, Moonshot), Cohere. Only `perplexity` is treated as no-tools and cannot drive the Librarian; the writing AI falls through to ST's normal generation when tool calling is unsupported, and a deduplicated warning fires.

### Setup

1. Enable **Librarian** in Settings → Features → Librarian
2. Pick a connection mode (default `inherit` works if your AI Search profile is tool-calling)
3. Verify with `/dle-health` (checks tool-calling support on the resolved profile)
4. Roleplay normally; gaps will accumulate in the Librarian inbox in the drawer

See also: `librarianPerMessageActivity` (default off) which changes whether gaps clear on each new generation. Off is the original behavior (gaps accumulate across messages); on ties gap and dropdown lifecycle to per-message scope.

![Librarian tab with a flagged worldbuilding gap opened](https://i.imgur.com/V8RnLdy.png)

---

## Session Scribe

Auto-summarizes your roleplay into timestamped markdown notes written back to your Obsidian vault. The next summary feeds the prior summary back as context, so notes build on each other instead of repeating.

**Flow:**

1. After every N new messages (default 5), Scribe fires from the `CHARACTER_MESSAGE_RENDERED` handler
2. It summarizes the recent message window using the configured prompt
3. The summary is written as a markdown file with frontmatter (`tags: lorebook-session`, `date`, `character`) to the configured Session Folder (default `Sessions`)
4. The vault re-indexes so the new note is searchable

**On-demand:** `/dle-scribe` writes a summary immediately. Optional focus topic: `/dle-scribe What happened during the trial?`

**Browse past summaries:** `/dle-scribe-history` opens a popup of the current chat's notes.

**Connection options:**
- **Inherit** (default): resolves to AI Search settings
- **SillyTavern Connection**: reuse your main chat's active connection
- **Connection Profile**: any saved Connection Manager profile. Use this to route summaries through a different (often cheaper) model.

**Setup:**
1. Enable **Session Scribe** in Settings → Features → Session Scribe
2. Set the auto-scribe interval (every N messages)
3. Set the Session Folder
4. Pick a connection mode
5. Optionally customize the summary prompt and message window depth (`scribeScanDepth`, default 20)

**Defaults to know:** message window 20 messages, response token limit 1024, timeout 60s.

![Session Scribe output in Obsidian showing the vault folder structure on the left and a timestamped session note with Properties metadata, Key Events and Plot Developments bullet points, and a Character Dynamics section](images/dle-scribe-entry.png)

---

## Auto Lorebook

Scans recent chat for characters, places, items, and concepts that lack a vault entry, then proposes new entries you can review and accept.

**Flow:**

1. Every N messages (default 10), or on-demand via `/dle-newlore`, the AI scans recent chat
2. It compares against existing entries and identifies gaps (case-insensitive title match)
3. Suggestions appear in a popup with title, type, keywords, summary, and content
4. Accept to write the entry to Obsidian, or reject to skip

**Connection options:** Inherit (default), SillyTavern Connection, or Connection Profile.

**Setup:**
1. Enable **Auto Lorebook** in Settings → Features → Auto Lorebook
2. Set the trigger interval
3. Optionally set a target folder for new entries
4. Pick a connection mode

`/dle-newlore` triggers on-demand without enabling automatic suggestions. Accepted entries are written with proper frontmatter (type, priority, tags, keys, summary).

---

## Optimize Keys

`/dle-optimize-keys <entry name>` asks an AI to analyze an entry and suggest better keywords. The AI considers the entry's content, summary, and current keys to recommend additions and refinements: synonyms, related terms, trigger phrases.

**When to use:** an entry isn't triggering as expected, or you want a second opinion on key choices after writing the entry.

**Modes** (`optimizeKeysMode`):
- `keyword`: pure keyword optimization without AI
- `two-stage`: AI analyzes content and suggests keys

**Connection:** independent (Inherit / Connection Profile). Defaults to Inherit (resolves to AI Search settings).

Suggestions appear in a popup for review. Apply changes in Obsidian, then run `/dle-refresh` to pick them up.

---

## Auto-Summary Generation

`/dle-summarize` scans every indexed entry, finds those without a `summary` frontmatter field, and generates summaries one at a time. Each suggestion is shown in a review popup where you can edit, approve, or skip before it is written to the entry's frontmatter in Obsidian.

**When to use:** after importing entries from World Info, or when you have a backlog of entries without summaries. The `summary` field is what AI Search reads to decide whether an entry is relevant, so filling missing summaries directly improves selection quality.

---

## Scribe-Informed Retrieval

When enabled, the Session Scribe's latest summary is fed into the AI Search context as additional story background. This widens what AI Search "knows" about the ongoing narrative beyond the scan-depth window, so it can pick entries relevant to long-running plot arcs.

**Setup:** enable **Scribe-Informed Retrieval** in [[Settings Reference|AI Search settings]].

**Requires:**
- Session Scribe enabled
- At least one summary written for the current chat

Most useful for long conversations where important plot points have scrolled past the AI Scan Depth window.

---

## Related pages

- [[AI Search]]: the second-stage AI selection during generation
- [[AI Notepad]]: AI-managed session notes (separate from Auto Lorebook and from Scribe)
- [[Pipeline]]: where each AI tool fits into the generation flow
- [[Settings Reference]]: every setting documented
- [[Slash Commands]]: every `/dle-*` command
