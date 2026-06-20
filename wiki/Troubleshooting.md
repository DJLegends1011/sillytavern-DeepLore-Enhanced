# Troubleshooting

Common issues and how to fix them. Run `/dle-health` first; it catches most problems automatically. For a shareable bug report, run `/dle-diagnostics` (see [[Inspection and Diagnostics#Diagnostics export]]).

## Connection issues

### "Connection failed" or "ECONNREFUSED"
- **Check:** Is Obsidian running?
- **Check:** Is the Local REST API plugin enabled in Obsidian settings?
- **Check:** Does the port in DeepLore settings match the REST API plugin port? Default: `27123` for HTTP, `27124` for HTTPS.
- **Check:** Is another application using the same port?
- **Try:** Restart Obsidian, then click **Test All** in DeepLore settings.

### "Authentication failed" (401/403)
- **Check:** Your API key matches what is shown in Obsidian → Settings → Local REST API.
- **Check:** You copied the full key without extra spaces.
- **Try:** Regenerate the API key in the Local REST API plugin and paste it fresh.

### "Obsidian connection timed out"
- **Check:** Obsidian is not frozen or unresponsive.
- **Check:** No firewall is blocking localhost connections.
- **Check:** The Local REST API plugin is enabled (not just installed).
- **Try:** Increase the cache TTL in Index and Cache settings to reduce connection frequency.

### HTTPS certificate not trusted

If you are using HTTPS (port 27124) and seeing "Failed to fetch" or "Certificate not trusted" errors, the browser is blocking the connection because the Local REST API plugin uses a self-signed certificate.

**Option 1 (recommended): switch to HTTP.**
1. In Obsidian, open Settings → Local REST API.
2. Make sure "Enable Non-Encrypted (HTTP) Server" is **ON**.
3. In DeepLore settings, uncheck HTTPS and set the port to `27123`.

**Option 2: trust the certificate.**
1. Open `https://127.0.0.1:27124` directly in your browser.
2. Accept the security warning or add an exception.
3. See the [Local REST API certificate guide](https://github.com/coddingtonbear/obsidian-web/wiki/Troubleshooting%3A-Certificate-Trust-Issues) for platform-specific steps.

> [!TIP]
> DeepLore detects certificate failures during a connection test and shows a guidance popup with both options.

## Entries not matching

### Keywords not triggering
- **Run:** `/dle-inspect` after sending a message and check the keyword-matches section.
- **Check:** Scan depth is not 0 (Settings → Matching).
- **Check:** Keywords are in the entry's `keys:` frontmatter field, not just in the content body.
- **Check:** "Match Whole Words" setting. With it on, "ai" will not match "artificial".
- **Check:** "Case Sensitive" setting. With it on, "Eris" will not match "eris".
- **Check:** The entry has the configured lorebook tag (default: `lorebook`).
- **Try:** `/dle-lint` to see if the entry was skipped during the last index build.

### Entries matching but not injecting
- **Check:** Token budget. The entry may be cut for space. Run `/dle-inspect` to see budget-cut entries.
- **Check:** Gating rules. The entry may have `requires` or `excludes` that are not met.
- **Check:** Contextual gating. With era/location/scene filters set, entries may be gated out. Run `/dle-context-state` to see active filters, or `/dle-clear-all-context` to reset.
- **Check:** Per-chat blocks. Run `/dle-pins` to see if the entry is blocked.
- **Check:** Per-entry cooldown.
- **Check:** Re-injection cooldown. The entry may be skipped because it injected recently.
- **Check:** Strip-dedup. The entry may be deduped against recent generations.
- **Check:** Folder filter. The entry may live outside the active folder set.

### Too many entries matching (noisy results)
- **Fix:** Make keywords more specific.
- **Fix:** Lower the scan depth (fewer messages scanned, fewer matches).
- **Fix:** Use priority values to make sure important entries win the budget allocation.
- **Fix:** Enable AI search (two-stage mode) so the AI filters out irrelevant matches.

## AI search issues

### "AI search failed, using keyword fallback"
- **Timed out:** increase the AI Search timeout (default: 20s).
- **Auth error:** check that your connection profile's API key is valid.
- **Profile not found:** select a profile in AI Search settings, or create one in Connection Manager.
- **Network error:** verify your connection profile works in SillyTavern's main API panel.
- **Server error:** the API provider may be down. Try again later.

> [!NOTE]
> If you see **"Custom Proxy mode was removed in v2.5"**, a channel is still set to the removed proxy mode. Open **Settings → Connection → AI Connections** and pick a Connection Profile for it. (DeepLore migrates `proxy` settings to `profile` automatically on upgrade, but a manually-edited setting can still hit this.)

### AI search returning empty results
- **Check:** Entries have a `summary:` field. AI search relies on summaries to decide relevance.
- **Check:** AI search scan depth is not too low. The AI needs enough chat context to judge relevance.
- **Try:** Run `/dle-status` to verify AI search is enabled and configured.
- **Try:** Switch from AI-only to two-stage mode. Two-stage uses keywords as a safety net.

### AI search too expensive
- **Fix:** Use two-stage mode instead of AI-only. Keywords pre-filter, reducing AI workload.
- **Fix:** Use a cheaper model (Claude Haiku, GPT-4o-mini).
- **Fix:** Reduce **Entry Description Length** (`aiSearchManifestSummaryLength`) to send less text per entry.
- **Fix:** Check `/dle-status` for cache hit rate. High cache hits mean fewer API calls.

### "AI Search Throttled"
- AI calls are throttled to a minimum of 500ms between requests. If you regenerate rapidly, the AI call is skipped and keywords are used instead.
- Not a bug. The throttle prevents request flooding and protects your API budget.
- The throttle does not count as a failure and does not trip the AI circuit breaker.

### AI search timing out with local LLMs
- Local models (e.g. Magistry 24B, Qwen, Mistral) are often much slower than cloud APIs and may need 60-120 seconds to respond, especially on longer chats.
- The default AI search timeout is 20,000ms (20 seconds), tuned for fast cloud APIs.
- **Fix:** Increase the timeout in Settings → AI Search → Show Advanced → Timeout. Values of 60000-120000ms (60-120 seconds) are common for local models. The cap is 999999ms (~16 minutes) for cases where a slow provider routinely runs longer. The same applies to Scribe and Auto-Suggest timeouts in their respective tabs.

### AI circuit breaker tripped
- After 2 consecutive AI failures (timeouts, errors), the circuit breaker trips and AI search is disabled for 30 seconds.
- During this period, the pipeline falls back to keyword-only matching.
- After 30 seconds, a single half-open probe is allowed. If it succeeds, the circuit breaker resets and AI search resumes normally.
- **Fix:** Check that your connection profile works (test it in SillyTavern's main API panel). Run `/dle-status` to see circuit breaker state.

### Per-vault circuit breaker
- In multi-vault setups, each vault (identified by host:port) has its own independent circuit breaker with exponential backoff (2s → 4s → 8s → 15s max).
- One vault being unreachable does not block the others. Entries from healthy vaults are still indexed.
- **Fix:** Check that the Local REST API plugin is running on the affected vault's port.

## Lore not injecting

### Extension enabled but nothing happens
1. Run `/dle-refresh` to rebuild the index.
2. Check the header badge. Does it show entries? "0 entries" means your notes are not being indexed.
3. Run `/dle-health` for a full diagnostic.
4. Check the browser console (F12) for `[DLE]` error messages, or run `/dle-logs`.

### "No vault entries loaded"
- **No tagged notes:** make sure at least one note has the lorebook tag in its frontmatter `tags:` field.
- **Wrong tag:** check that the lorebook tag in settings matches the tag in your notes (default: `lorebook`).
- **Connection failed:** the vault connection test should be green. Fix the connection first.

### Entries injecting in wrong position
- **Check:** Injection settings (before/after prompt, or `in_chat` with depth).
- **Check:** Per-entry overrides. Entries can have their own `position`, `depth`, and `role` in frontmatter.
- **Check:** In `prompt_list` mode, drag the DeepLore entries in Prompt Manager to your preferred position.

## Cache and sync issues

### Stale entries (edits in Obsidian not showing up)
- **Quick fix:** run `/dle-refresh` to force a full rebuild.
- **Check:** Cache TTL setting. With it set high (e.g. 300s), changes take up to 5 minutes to appear.
- **Check:** Sync polling interval. Controls how often DeepLore checks for changes in the background.
- **Fix:** Lower cache TTL to 60-120s for faster updates during active editing.

### "Index refresh timed out"
- Obsidian is taking too long to respond. Common with very large vaults (1000+ notes).
- **Try:** Restart Obsidian and try again.
- **Check:** No other plugins are hogging Obsidian's resources.

## Extension errors

### JavaScript errors in console
1. Open the browser console (F12) and filter for `[DLE]`, or run `/dle-logs`.
2. Note the exact error message.
3. Try disabling the extension, refreshing, and re-enabling.
4. If the error persists, [report it on GitHub](https://github.com/pixelnull/sillytavern-DeepLore/issues) with the error message. Attach the output of `/dle-diagnostics` if you can.

### Extension freezes SillyTavern
- This can happen if the generation lock gets stuck.
- **Quick fix:** run `/dle-refresh` in chat to reset the lock.
- If chat input is frozen, refresh the page. The lock auto-recovers after 30 seconds.

### Conflicts with other extensions
- DeepLore uses `setExtensionPrompt()` for injection, which is standard ST API.
- If another extension also uses `generate_interceptor`, they may conflict.
- **Try:** Disable other lorebook/World Info extensions and test.
- In `prompt_list` mode, conflicts are less likely since entries integrate with Prompt Manager.

## Librarian and function calling

### Function calling stops working in other extensions

The Librarian auto-enables function calling on the active connection when it is in use. If you disable function calling elsewhere while the Librarian is active, tool invocations break.

- **Fix:** turn the Librarian off if you need function calling disabled for other tooling.
- See [[Features]] for the full Librarian behavior.

## Still stuck?

1. Run `/dle-health` and review all errors and warnings.
2. Run `/dle-logs` (or check the browser console) for `[DLE]` messages.
3. Run `/dle-status` to see the full extension state.
4. Run `/dle-diagnostics` to export an anonymized report.
5. [Open an issue on GitHub](https://github.com/pixelnull/sillytavern-DeepLore/issues) with:
   - Your DeepLore version (see About tab)
   - The error message or unexpected behavior
   - Steps to reproduce
   - `/dle-status` output
   - The diagnostic report from step 4 (verify the privacy section before attaching)
