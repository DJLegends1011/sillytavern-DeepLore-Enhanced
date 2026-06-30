# Known Issues (Security & Design)

These are documented limitations, not actionable vulnerabilities for typical single-user setups.

## Plaintext API Key Storage
Obsidian API keys are stored as plaintext in SillyTavern's extension_settings JSON. This is a platform limitation — ST does not yet provide a secrets API. Any extension on the same origin can read these keys, granting full read/write access to the connected Obsidian vault. **Mitigation:** Use a dedicated Obsidian vault for lorebook content, not your personal vault.

## AI Search Prompt Injection via Summaries
Entry summaries are included in the AI search manifest. In multi-author vaults, a malicious summary could attempt to influence the AI's selection behavior. This is inherent to any AI retrieval system. **Mitigation:** The manifest uses XML structural delimiters and entity escaping to limit injection surface. Review summaries from untrusted authors.

## No AI Call Quota / Budget Cap
DLE enforces a 500 ms minimum interval between AI calls (a throttle floor in `src/ai/ai.js`), but there is no per-minute quota or spending cap. Rapid generation or auto-features could still run many calls in a short window. Adding a hard cap would add latency and surprise stalls, so it is deliberately omitted. **Mitigation:** Each feature has configurable intervals and timeouts, and an AI circuit breaker trips after consecutive failures.

## Librarian Requires a Tool-Calling Provider
The Librarian (Emma) uses native tool calling. It does not flip any global SillyTavern function-calling setting — instead it checks whether your selected connection profile/provider supports tools and falls back to its non-tool path otherwise. Reasoner-only models and providers without tool support will not drive the agentic loop. **Mitigation:** Route the Librarian to a tool-capable provider (Claude, Gemini, OpenAI-compatible, or Cohere).

## Guide Tag Conflict Resolution
Entries tagged `lorebook-guide` that also carry conflicting tags (`lorebook-seed`, `lorebook-bootstrap`, or base `lorebook`) have runtime conflict resolution: `guide` wins. The entry will be treated as guide-only (never injected into the writing AI context). This is intentional but may surprise authors who expect seed/bootstrap behavior.

## Duplicate Entry Titles Across Vaults
Internal data structures key on `vaultSource:title`, so same-titled entries in different vaults no longer collide by default. The `multiVaultConflictResolution` setting controls what happens (`src/vault/vault-pure.js`):
- **`all`** (default) — keep every copy; both entries coexist.
- **`first`** — keep the first vault's copy, discard later duplicates.
- **`last`** — keep the last vault's copy.
- **`merge`** — union keys/tags/links, concatenate content, OR-merge flags into one entry.

A diagnostic still warns about cross-vault title duplicates so you can decide intentionally. Pick `first`/`last`/`merge` if you want collapse behavior; leave it on `all` to keep duplicates.

## CMRS Timeout Enforcement
SillyTavern's Connection Manager Request Service (CMRS) may not respect `AbortSignal` in all cases. DLE works around this with a `Promise.race` backup timer, but in rare cases an AI request may hang longer than the configured timeout before the backup fires. **Mitigation:** The backup timer fires 500ms after the configured timeout as a safety net.

## Graph Focus Mode Exit Key
Graph focus mode exits with the `e` key, not Escape. Escape bubbles up to SillyTavern's popup event handler and would close the graph dialog instead of just exiting focus mode.

## Settings Popup Is Not Mobile-Responsive
The DLE drawer engages a fixed overlay on narrow viewports (v2.6 fix, `updateOverlayMode` in `src/drawer/drawer.js`), but the tabbed Settings popup does not get an equivalent mobile layout. It keeps a two-column sidebar-plus-content grid at every width; the only narrow-viewport adaptation is a 600px breakpoint that shrinks the nav sidebar to a 140px rail (`.dle-settings-popup` in `style.css`). On a real phone-width viewport both columns are cramped — there is no single-column/stacked layout. A full mobile settings layout is deferred to a future settings overhaul (and to the planned v3 mobile UI). **Mitigation:** Open and edit DLE settings on a desktop or wider viewport; the rest of the extension (drawer, generation) works on narrow viewports.

## Librarian Gap-Flagging Runs in the Background (and Can't Be Stopped Mid-Flight)
The Librarian's gap-finder (FLAG) step runs *after* your message is already written and shown — it no longer blocks generation. As a result, the small extra AI request that looks for lore gaps fires in the background, and the **Stop** button cannot cancel it once it has started: Stop ends the visible generation (your message is delivered, the input is re-enabled), but the in-flight gap request still completes server-side and its result is simply discarded. The only cost is one small extra tool-call's tokens if you Stop during the brief window after the message appears. The flagged gap (if any) is still recorded; if you switch chats or start a new generation, the stale background result is dropped safely. **Mitigation:** None needed — it's harmless and best-effort by design. Turn off Librarian flagging in DLE Settings → Features → Librarian if you don't want the background gap calls at all.
