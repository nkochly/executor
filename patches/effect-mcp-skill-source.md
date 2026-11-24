# A skill source for the MCP skills extension

Effect 4.1.4 serves the MCP skills extension (`io.modelcontextprotocol/skills`) only from skills
registered once, when the server starts, with `McpServer.registerSkill`. Every caller sees the
same skills. Executor's skills belong to each caller's apps, so they can only be known per request.

`effect@4.1.4.patch` adds `McpServer.registerSkillSource` in source, distributed JavaScript and
declarations. A source answers `list`, `get`, `read` and `directory` for each request with the
request's services. `skills/list` and `skills/get` add its skills to the registered ones,
`resources/read` and `resources/directory/read` fall back to it for a URI nothing registered
answers, and a registered source turns on the `resources` capability and the skills extension.

Executor's MCP server registers one source over the caller's app skills (decision record 0013).
The patch is meant for upstream. Remove it when an Effect release serves per-request skills.
