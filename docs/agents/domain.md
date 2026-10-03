# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Layout: **single-context** (one `CONTEXT.md` + `docs/adr/` at the repo root).

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the domain glossary.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/README.md`**: the existing routing table into code-level internals docs (pipeline, state/lifecycle, vault, AI, librarian, gating, prompts). **`docs/gotchas.md`** is mandatory before touching pipeline, state, or lifecycle code; its numbers are an append-only contract.

If `CONTEXT.md` or `docs/adr/` don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved. (`CONTEXT.md` is already whitelisted in `.gitignore`; `docs/**` is too.)

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── README.md          ← internals routing table (existing)
│   ├── gotchas.md         ← numbered regression contract (existing)
│   └── adr/
│       └── 0001-....md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
