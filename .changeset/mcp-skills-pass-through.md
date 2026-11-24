---
"apps": patch
"@executor-js/app-templates": patch
---

`mcpSkills` in `apps/mcp` loads the skills an MCP server publishes over the MCP
skills extension as app skills. Pass the same `url`, `account` and `headers` as
the server's `mcpRouter`, and `cache: ctx.cache`. Imported MCP apps declare it
with `dynamicSkills`, so they pass their server's skills through.
