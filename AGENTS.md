# AGENTS.md

Read `CLAUDE.md` first — it carries the branch mission (`mobile-drawer-mode`: complete upstream's Issue #39 mobile drawer work), architecture pointers, upstream-PR discipline, and test commands. Everything there applies to any agent (Claude, Codex, or otherwise).

## Personal Codex Reminders

- When you finish code changes, explicitly check git status and remind me whether the work is uncommitted, committed, or pushed. If I say to push it to git, commit the relevant changes and push the current branch after verification.
- Push immediately after committing — I test from GitHub on a real phone, not locally.
- Run `npm run test:all` and `npm run lint` before claiming work is done.
- Keep diffs surgical: this branch is meant to become a clean upstream PR series. No drive-by refactors, no style churn outside the touched sections.
- New UI strings need keys in all 7 locale files (`locales/dle.*.json`) plus the `total_keys` recount, or `test:i18n` fails.
