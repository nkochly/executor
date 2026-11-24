# 0013. App skills over the MCP skills extension

Date: 2026-11-24

## Context

Claude reads skills from an MCP server through the skills extension
(`io.modelcontextprotocol/skills`): `skills/list`, `skills/get`, and `resources/read` on
`skill://` URIs. Executor already serves each app's skills through its own `skills` tool. Which
apps a caller has depends on the caller, so the skills cannot be registered once at start-up, which
is all Effect's MCP server offers.

## Decision

Executor's MCP server registers one skill source (`appSkillSource`,
`packages/mcp/src/implementation/skill-source.ts`) through the Effect patch
`patches/effect-mcp-skill-source.md`. The source reads the caller's skills through the same
backend call as the `skills` tool, so a caller sees only the skills of the apps it already reaches.

- A skill's URI is `skill://<app slug>/<skill name>/SKILL.md`; its other files sit beside it.
- Every listed skill says `resources: "dynamic"`: its files are found by reading the skill's
  directory, never listed up front, because an app's files can change with each release.
- Any failure to read the caller's skills lists nothing and reads as not found, the same answer a
  caller without that app gets.

## Consequences

The `skills` tool stays for clients without the extension. A client with it sees each skill twice
over: as an MCP skill and through the tool. Both read the same backend call, so they agree.
