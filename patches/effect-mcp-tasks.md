# The MCP tasks extension

MCP 2026-07-28 lets a server answer a `tools/call` with a task (`resultType: "task"`) that the
client polls with `tasks/get`, answers with `tasks/update` and stops with `tasks/cancel`, under the
tasks extension (`io.modelcontextprotocol/tasks`). Effect 4.1.4 has none of it.

`effect@4.1.4.patch` adds it in source, distributed JavaScript and declarations:

- `McpSchema.TaskCreated`: a tool handler that fails with it has its task sent as the call's
  result, to a client that declared the extension. Any other client gets `-32021` naming the
  extension. `McpSchema.McpTask` and `McpSchema.McpDetailedTask` are the task's fields.
- `McpServer.registerTasks` and `McpServer.tasks`: handlers for `tasks/get`, `tasks/update` and
  `tasks/cancel`, run with the request's services. A registered handler declares the extension in
  `server/discover`. A client that did not declare it gets `-32021` from the three methods.
- The three methods are routed with `Mcp-Name` set to the task ID, as the extension requires.

Only `2026-07-28` serves tasks; older protocols refuse a task as client input they do not support.

Executor's native mode uses it (decision record 0014). The patch is meant for upstream. Remove it
when an Effect release serves the tasks extension.
