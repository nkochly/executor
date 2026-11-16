---
"@executor-js/mcp": patch
"@executor-js/mcp-auth": patch
"@executor-js/ui": patch
"@executor-js/app-templates": patch
---

New `automatic` approval mode, chosen only with `?elicitation_mode=automatic`.
Executor approves tool calls at once, and the agent's own permission prompt for
`call` or `execute` is the check. Questions a running tool asks still reach the
agent, as in `model` mode. The plain `/mcp` URL stays in `model` mode, and
existing grants keep their mode.
