# 0015. Imported MCP servers pass their skills through

Date: 2026-11-24

## Context

An MCP server can publish Agent Skills over the MCP skills extension (`skills/list`, then
`resources/read` for each file, or `resources/directory/read` for a skill that lists its files as
`dynamic`). An app imported from such a server served its tools and dropped its skills, so a
server whose whole purpose is its skills gave agents nothing through Executor.

## Decision

- The framework gains `mcpSkills` in `apps/mcp` (`packages/apps/src/implementation/mcp-skills.ts`).
  It reads a server's published skills with the same `url`, `account` and `headers` as its
  `mcpRouter`, and returns them as app skills. A server whose initialization does not declare the
  extension has no skills, so the call costs one session and never fails an app's skill read.
- Every generated MCP app (`generateMcpSource`, `mcpAppSource`) declares
  `dynamicSkills({ list: () => mcpSkills(...) })`, so only skill reads reach the server. An app
  whose members each link an account reads with the caller's first account, the same account set
  its tools use. Skill reads are already evaluated with the caller's own accounts and kept per
  account set (`packages/sdk/src/implementation/skills.ts`), so one person's skills never reach
  another.
- Every file is loaded when the catalog loads, within the shared skill limits (1,000 files,
  2 MB a file, 20 MB in all), and kept in the account's scope of the app cache. The publication
  check is one `skills/list` walk: its URIs, frontmatter and file digests identify the catalog, so
  an unchanged server is not read again. A server that lists any skill as `dynamic` cannot be
  identified that way and is loaded on every check. Nathan chose loading every file over a host
  protocol change for lazy file reads (2026-11-24).
- The framework's discovery sessions declare the skills extension in their client capabilities.

## Consequences

A newly imported MCP app passes its server's skills with no code. An app imported before this
change keeps dropping them until its source gains the `dynamicSkills` line and it is redeployed,
which needs Nathan's go for each app. A server past the limits fails its app's skill reads with
the limit error; serving it would need lazy file reads in the host protocol.
