# Security

DeepLore is a client-side SillyTavern extension that connects to a local Obsidian vault via the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

## Data Flow

- Vault traffic stays on your machine: the browser talks to Obsidian over localhost (HTTP on port 27123, or HTTPS via the Local REST API plugin's self-signed cert). HTTPS fetches may be proxied through SillyTavern's local CORS bridge to bypass the cert exception, but the destination is still your own machine.
- DLE both reads and writes to the vault: Scribe notes, auto-suggested entries, imports, and Librarian review results can create or modify vault files
- All AI calls (search, Scribe, Librarian, etc.) route through SillyTavern's Connection Profiles via its Connection Manager Request Service — the extension makes no direct external API calls. (The legacy Custom Proxy mode that called providers through ST's CORS bridge was removed in v2.5.)
- Vault content (entry summaries during retrieval, full entries when injected) is sent to whatever LLM provider you've configured in that profile — treat it as you would any prompt content
- AI provider API keys (OpenRouter, OpenAI, Anthropic, etc.) are managed entirely by SillyTavern — DLE does not store or handle them. DLE only stores the Obsidian REST API key, in SillyTavern's `extension_settings` (browser localStorage)

## Reporting Issues

For security vulnerabilities, please use [GitHub private vulnerability reporting](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/security/advisories/new) or contact the maintainer privately before opening a public issue. This allows time to assess and patch before disclosure.

For non-security bugs, use [GitHub Issues](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues).
