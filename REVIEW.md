# Review Guidelines

For an agent reviewing a pull request here before it merges. How to build and
test is in `CLAUDE.md` and `AGENTS.md`; the reasons are in `docs/adr/`.

## Important (fix before merge)

- **Wrong behavior.** A path that does something other than the PR says. Name
  the input that breaks it.
- **Bug fix without a test** that fails before the fix, committed before it.
- **A credential reaching an agent, a log or an error.** A secret, token or
  account value in a tool result, a span, a log line or an error message.
- **Access.** A route or entrypoint served before the product's
  authenticated route map, or a client address read from anything but the
  edge's (decision record 0002).
- **A promise or wake-up shared across requests** in a Worker or Durable
  Object. Waiters poll on their own timers (decision record 0002).
- **Storage that cannot roll forward.** A migration that takes the product
  offline, or a Durable Object change without the mixed-version case
  (`AGENTS.md`, Migrations must keep the app online).
- **A code comment in fork-owned code,** or a decision that belongs in a
  decision record and is not in one.
- **An upstream file reshaped** beyond what the port or fix needs, which
  makes the next port conflict.
- **Glossary drift.** A domain word that differs from `CONTEXT.md` or the
  shared core, or an edit to the shared core here instead of in wiki_mcp.
- **Personal data or secrets** in this public repository: emails, tokens or
  account ids in code, tests, docs or commit messages.

## Nits (at most five, never block)

Naming, small duplication, test tidiness.

## Output

List Important findings first, each with file, line and the failing case.
Say "no Important findings" when there are none. A repeated finding is a
sign `CLAUDE.md` is missing a line: say which.
