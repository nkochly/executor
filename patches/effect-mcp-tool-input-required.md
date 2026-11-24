# Input required from a toolkit tool

MCP 2026-07-28 pauses a call by answering it with `resultType: "input_required"` (multi
round-trip requests). Effect 4.1.4 sends that result only for a tool registered by hand with
`McpServer.addTool`, whose handler may return `McpSchema.InputRequired`. A tool registered from a
`Toolkit` could not: every handler failure became a declared failure or an internal tool error.

`effect@4.1.4.patch` changes `registerToolkit` in source and distributed JavaScript: a handler
that fails with an `McpSchema.InputRequired` has it sent as the call's result. Effect then checks
the client declared each requested capability and returns `-32021` when it did not, as for a
hand-registered tool. Earlier revisions keep refusing input required, as before.

Executor's native `execute` and `call` use it (decision record 0012). The patch is meant for
upstream. Remove it when an Effect release lets a toolkit tool require input.
