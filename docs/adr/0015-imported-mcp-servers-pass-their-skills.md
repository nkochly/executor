# 0015. Imported MCP servers pass their skills through

Date: 2026-11-24

## Context

An MCP server can publish Agent Skills over the MCP skills extension (`skills/list`, then
`resources/read` for each file, or `resources/directory/read` for a skill that lists its files as
`dynamic`). An app imported from such a server served its tools and dropped its skills, so a
server whose whole purpose is its skills gave agents nothing through Executor.

Live app builds resolve `apps` from the public npm registry, not from this checkout: the stack
sets no `EXECUTOR_APPS_VERSION`. A framework export the fork adds is not in any published
release, so app source that imports it fails to build live, even though the e2e suite, whose
registry serves this checkout's `apps`, passes. The first version of this record added
`mcpSkills` to `apps/mcp`, and every MCP app imported after it would not have built.

## Decision

- Every generated MCP app (`generateMcpSource`, `mcpAppSource`) gets its own `skills.ts`
  (`packages/app-templates/src/implementation/mcp-skills-source.ts`). Its `serverSkills` reads a
  server's published skills with the MCP SDK the app already depends on, and builds them with
  `fileSkill`, using only what published `apps` releases export. A server whose initialization
  does not declare the extension has no skills.
- The app declares `dynamicSkills({ list: () => serverSkills(...) })`, so only skill reads reach
  the server, with the same `url`, `account` and `headers` as its `mcpRouter`. An app whose
  members each link an account reads with the caller's first account. Skill reads are already
  evaluated with the caller's own accounts and kept per account set
  (`packages/sdk/src/implementation/skills.ts`), so one person's skills never reach another.
- Every file is loaded with the catalog, within the shared skill limits (1,000 files, 2 MB a
  file, 20 MB in all), and the catalog is kept for five minutes in the account's scope of the app
  cache. Nathan chose loading every file over a host protocol change for lazy file reads
  (2026-11-24).
- The generated app imports from `apps/mcp` only `mcpRouter`; the hosted-parity scenario
  "an imported MCP server's skills are served as the app's skills" holds that.
- Rejected: a framework `mcpSkills`. It reaches no live app until upstream publishes it.

## Consequences

A newly imported MCP app passes its server's skills with no code, and the reader is editable
source like the rest of the app. An app imported earlier keeps dropping them until it gains
`skills.ts` and the `dynamicSkills` line and is redeployed, which needs Nathan's go for each app.
A fix to the reader reaches an existing app only when its source changes.
