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

- **No `notes/` folder.** Every `notes/*.md` link is dead: in `AGENTS.md`,
  the executor-e2e skill, package READMEs and `plans/`. The decision records and `CONTEXT.md` hold what
  the fork knows.
- **CI is two workflows on GitHub-hosted runners**, on every pull request,
  every push to the working branch and manual dispatch. `check.yml` runs `bun run check`, then
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

## Finding your way in the fork

- **The host design is in decision records 0002 to 0010**
  (`docs/adr/README.md`): the product Durable Object, MCP session objects,
  location and backups, storage, SQLite, tracing, sign-in, connection bundles.
- **Fork-owned files are the `only` list in `.comment-baseline.json`.** A new
  fork-owned file joins it in the same change.
- **One `ExecutorMcpSession` object per caller** (decision record 0003), and
  one `/rpc` socket from the product to the app host per app call.
- **A framework change reaches a live app only when that app moves to the new
  `apps` release.** Moving a person's app needs Nathan's go for that app.
- **Live app builds take `apps` from npm,** not from this checkout. App source the fork
  generates or edits may import only what a published `apps` release exports; a fork-only
  framework export passes the e2e suite and fails the live build (decision record 0015).
- **The MCP `call` tool takes `calls: [...]`,** so an upstream test that calls
  one tool needs adapting when it is ported.
- **Deploy:** wiki_mcp `ci.yml`, mode `deploy`, packages `executor-v2`, one
  run at a time across the beta unit. The product object moves to the new
  version about five minutes after the Worker does.

## Scope of the shared rules

The shared rules below hold for fork-owned code only: every file in neither
upstream's `v2` branch nor the commit the fork started from (decision record
0001). Upstream's files keep upstream's code comments and conventions.

<!-- shared-rules:start -->
## Shared rules

These rules hold in every Trifecta repo and are the same, byte for byte, in
each repo's `CLAUDE.md`. Their one source is the wiki_mcp repo's `CLAUDE.md`:
change them there and run `npm run glossary:sync` in wiki_mcp, which writes
every copy and the digest each repo's check holds it to. Never edit them in a
copy. This repo's own rules sit outside this block.

- **SDK first.** Use the latest SDK and what it provides (`ECOSYSTEM.md` in
  the wiki_mcp repo, Shared SDK versions). Before writing an alarm loop,
  scheduler, retry queue, WebSocket hub, MCP extension or routing helper, use
  the `agents` capability or MCP package that already does it; hand-roll only
  what no SDK offers, and say so in a decision record.
- **Bug fix: failing test first.** Commit a test that fails on the bug, then
  make it pass without editing that test.
- **No code comments.** Names, types and tests say what code does. An
  important, non-obvious decision goes in a decision record (`docs/adr/`); a
  known weakness goes in a beta Muster task. The comment ratchet
  (`scripts/comment-ratchet.mjs`, run by each repo's tests) holds every file
  to its count in `.comment-baseline.json`, which only goes down. Directives,
  shebangs and license headers are exempt. `/delete-comment` clears a file.
- **Review before merge.** Run a code review of the PR diff against this
  repo's `REVIEW.md` (against these rules where it has none) and fix every
  Important finding before merging.
- **Small rulings are the thread's.** Decide these without asking Nathan,
  take the option you would recommend, and say what you chose in your reply:
  a glossary edit that only makes an entry match code already shipped (a
  Code line, a missed case); deleting or archiving a file git tracks; an
  A-or-B choice inside a task he already approved. Still ask him for a new
  glossary term or a changed meaning, a delete of live data, accounts or
  resources, creating a token or secret, a CVE override, a reviewed-push
  entry, and a change of a task's scope (Nathan, 2026-11-21).
- **Cloud first.** Do the work in the cloud: the session's own container,
  CI and the deploy stack. Fall back to Nathan's Mac (his folders or a
  Remote Control session) only for a step the cloud truly cannot do, and
  say in your reply why it could not (Nathan, 2026-11-21).
- **Read the solution notes first.** At the start of a build thread, search
  this repo's `docs/solutions/` (when it exists) for the area the work
  touches, and the common repo's `docs/solutions/` when the work sets up or
  changes how threads, scheduled tasks, merges or deploys run.
- **Compound check before finishing.** Before a build thread finishes its
  task, it asks one question: did this work correct a wrong belief (an
  approach that failed, a review finding that was a real defect, a first
  diagnosis that was wrong)? If yes, the lesson lands in the same PR, in the
  cheapest form below. If no, nothing is written. Either way the result goes
  in the Muster finish summary: "no wrong belief corrected", or the lesson
  and where it landed. Project memory is not a place a lesson lands.
- **Cheapest form first.** A lesson goes to the first of these that can hold
  it: make one way to do the thing; a test or check that fails on a repeat;
  a line in this repo's `CLAUDE.md`, outside this block; a glossary proposal,
  which Nathan approves; only then a solution note.
- **Solution notes.** A solution note is one Markdown file in this repo's
  `docs/solutions/`, named for its subject, with front matter `title`,
  `tags` and `date`, and a body that says what was believed, what is true and
  the evidence. It holds only reasoning no test or rule can hold, such as a
  rejected approach or a measured fact. When the code changes so a note is
  wrong, the same PR corrects or deletes it. A lesson about how threads,
  scheduled tasks, merges or deploys run, rather than about one repo's code,
  is a solution note in the common repo, never in the repo nearest at hand.
- **Same mistake twice: add a line.** When an agent repeats a mistake in a
  repo, add the correction to that repo's `CLAUDE.md`, outside this block, in
  the fix's PR.
<!-- shared-rules:end -->

@AGENTS.md
