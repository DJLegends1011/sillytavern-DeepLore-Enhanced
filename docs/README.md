# DLE Code-Level Internals Docs

These docs explain **how the code works** — call graphs, data flows, state mutations, and cross-module contracts. They are for Claude Code sessions, not end users. The wiki covers user-facing docs.

**Always read `gotchas.md` before modifying pipeline, state, or lifecycle code.**

## Routing Table

| Change area | Read first |
|---|---|
| `onGenerate`, interceptor, prompt commit | [generation-pipeline.md](generation-pipeline.md) |
| State variables, `CHAT_CHANGED`, observers | [state-and-lifecycle.md](state-and-lifecycle.md) |
| Obsidian fetch, index build, cache, BM25 | [vault-and-indexing.md](vault-and-indexing.md) |
| AI search, connection routing, circuit breaker | [ai-subsystem.md](ai-subsystem.md) |
| Librarian tools, gap detection, agentic loop | [librarian.md](librarian.md) |
| Editable prompts (Prompts tab, override resolver, delete cage) | [editable-prompts.md](editable-prompts.md) |
| Pipeline stages, gating, field definitions | [stages-and-gating.md](stages-and-gating.md) |
| Scribe, Notebook, Graph, Cartographer | [secondary-features.md](secondary-features.md) |
| Pre-change safety check (always) | [gotchas.md](gotchas.md) |

After reading a doc, verify your understanding against the actual code — docs may lag behind recent changes.
