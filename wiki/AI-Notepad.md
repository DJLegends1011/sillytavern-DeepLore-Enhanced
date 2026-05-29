# AI Notepad

The AI Notepad lets the writing AI keep private session notes: things it should remember across messages but not say out loud. Character motivations, unspoken thoughts, plot threads to revisit, relationship shifts, revealed secrets. The notes are hidden from the visible chat and reinjected as context on the next generation.

> [!NOTE]
> The settings panel labels this feature **"AI Notebook"**. The wiki uses "AI Notepad" because that matches the setting key prefix (`aiNotepad*`) and the slash command (`/dle-ai-notepad`). Same feature, two names.

This is a different feature from:
- The **Author's Notebook** (`/dle-notebook`), which is written by you, the author, as a per-chat scratchpad
- The **Session Scribe** ([[AI Powered Tools|Scribe]]), which writes longer summaries back to your Obsidian vault

All three coexist; they target different writing tasks and have independent settings.

---

## How it works

Two modes pick which side does the note-taking.

### Tag mode (default)

The writing AI is instructed to write notes inside `<dle-notes>` tags at the end of its response. After generation:

1. DLE scans the response for `<dle-notes>...</dle-notes>` blocks
2. The notes are extracted and stripped from the visible message
3. Extracted notes are appended to the chat's accumulated note store
4. On the next generation, all stored notes are injected back as context

The reader never sees the tags. The AI gets its notes back every turn.

### Extract mode

The writing AI writes normally with no special tags. After generation, a separate API call sends the response to a second model that extracts noteworthy details:

1. DLE sends the latest AI response + previous notes to the extraction model
2. The extraction model returns bullet points worth remembering, or `NOTHING_TO_NOTE`
3. Notes are appended to the chat's accumulated note store

Extract mode is useful when your writing model doesn't reliably follow the `<dle-notes>` tag format, or when you don't want to burden it with extra instructions.

---

## Enabling

1. Open **Settings** (gear icon in the drawer, or the extension settings panel)
2. Go to the **Features** tab
3. Check **Enable AI Notebook**
4. Choose **Tag** or **Extract** mode
5. For Extract mode, configure the AI connection (Inherit or a Connection Profile)

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Enabled | Off | Master toggle |
| Mode | Tag | `tag` (writing AI uses `<dle-notes>` tags) or `extract` (post-gen API call) |
| Position | In Chat | Where notes are injected (same options as injection position) |
| Depth | 4 | Injection depth in chat context |
| Role | System | Injection role (system, user, or assistant) |
| Instruction Prompt | (built-in) | Custom prompt override for tag mode instructions |
| Extract Prompt | (built-in) | Custom prompt override for extract mode |
| Connection Mode | Inherit | `inherit` (resolves to AI Search settings) or `profile` (an ST Connection Manager profile) |
| Profile ID | (none) | Which ST profile to use for extract mode |
| Model | (none) | Model override for extract mode |
| Max Tokens | 1024 | Token limit for the extraction API call (256-8192) |
| Timeout | 30s (30000ms) | API timeout for extraction (5000-999999ms) |

---

## Viewing and editing notes

`/dle-ai-notepad` opens a popup showing all accumulated notes for the current chat with a live token counter. Edit and save manually.

`/dle-ai-notepad clear` clears all notes for the current chat.

Notes are also visible per-message in the **Context Cartographer** popup (the sources button on AI messages).

---

## How notes are stored

Notes live in `chat_metadata.deeplore_ai_notepad` as a plain text string. They persist with the chat: switching chats loads that chat's notes, and notes survive page reloads. The accumulator is capped at 64KB; when it exceeds the cap, oldest blocks are trimmed at paragraph boundaries (`\n\n`).

Each message's extracted notes are also saved on `message.extra.deeplore_ai_notes` for per-message inspection.

### Pinning notes

In the `/dle-ai-notepad` editor you can **pin** individual lines. Pinned lines are protected: they survive the 64KB cap trim and any deduplication pass, so a critical fact you want kept forever won't be evicted as the note store grows. Pins are stored as normalized keys in `chat_metadata.deeplore_ai_notepad_pins` (per chat). If you later edit a pinned line so it no longer matches its stored key, the pin quietly stops applying rather than erroring.

### Swipe and edit rollback

When a message is swiped, deleted, or edited, that message's notes are surgically removed from the accumulated store. The rollback uses `lastIndexOf` anchored on the note block, so an earlier message with identical notes is left alone.

---

## How notes are injected

On each generation, stored notes are wrapped in markers and injected at the configured position, depth, and role:

```
[Your previous session notes]
- Eris revealed she knows about the betrayal but hasn't confronted Kael yet
- The seal on the northern gate is weakening (mentioned twice now)
- Player character promised to return the artifact by the festival
[End of session notes]
```

In tag mode, the instruction prompt is appended after the notes, telling the AI how to use `<dle-notes>` tags.

---

## Tips

- **Tag mode works best with capable models** (Claude, GPT-4, etc.) that reliably follow formatting instructions. Smaller models may forget the tags or place them wrong.
- **Extract mode is more reliable but costs an extra API call per generation.** Good fit for local models that don't follow tags well. Route Extract mode to a cheap model via its own connection channel.
- **Edit notes periodically** with `/dle-ai-notepad` to prune stale information. The store grows every turn and eventually wastes tokens on outdated context.
- **Custom prompts let you steer what the AI tracks.** For example, instruct it to only track relationship changes and ignore combat details.

---

## Related pages

- [[Features]]: feature overview
- [[AI Powered Tools]]: Session Scribe (longer summaries to vault), Auto Lorebook, Librarian, others
- [[Injection and Context Control]]: how injection position, depth, and role work
- [[Slash Commands]]: `/dle-ai-notepad` and `/dle-notebook` reference
