# Agent Reference

This repository is a fork of upstream Executor. Its working branch is
`claude/project-thread-qw4ysu`, not `main`. `AGENTS.md` is upstream's guidance,
left as upstream wrote it so ports stay clean, and is imported below; where this
file and `AGENTS.md` differ, this file wins.

Read `GLOSSARY.md` for the words: the Trifecta's shared core, then a pointer to
`CONTEXT.md`, which holds Executor's own domain words and wins for them. The
decision records are listed in `docs/adr/README.md`. Review a pull request
against `REVIEW.md`.

## Where AGENTS.md does not hold here

- **No `notes/` folder.** Every `notes/*.md` link in `AGENTS.md` and in the
  executor-e2e skill is dead. The decision records and `CONTEXT.md` hold what
  the fork knows.
- **CI is two workflows on GitHub-hosted runners**, on every pull request and
  every push to the working branch. `check.yml` runs `bun run check`, then
  `e2e-sqlite`, one self-host scenario on SQLite (decision record 0006).
  `comment-ratchet.yml` runs the comment ratchet and the glossary check.
  There is no `ci.yml`, `checks.yml`, `cloud-tests.yml`, Blacksmith runner or
  `~/agent-workspace`, so the `## CI` and `## Workspace lifecycle` sections of
  `AGENTS.md` do not apply.
- **CI does not run the full local suites.** Run the named scenarios your
  change touches yourself, as `AGENTS.md` says. A change under
  `apps/hosted/cloudflare/` or to the SDK's workerd code also runs
  `bun run e2e:cloudflare-storage`, which no CI job runs.
- **Deploys come from wiki_mcp's Trifecta stack** (package `executor-v2`),
  after a merge to the working branch, never from here. Upstream's release and
  publication flows do not run here.
- **Ports come from upstream's own commits and tests.** Never sync the whole
  of upstream.
- **No AI attribution** in commits, pull request titles or merge messages.
- **Subagents run Sonnet**, with the model passed explicitly.

## Shared rules

The shared rules below hold for fork-owned code only: every file in neither
upstream's `v2` branch nor the commit the fork started from (decision record
0001). Upstream's files keep upstream's code comments and conventions.

<!-- shared-rules:start -->
<!-- shared-rules:end -->

@AGENTS.md
