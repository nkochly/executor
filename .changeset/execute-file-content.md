---
"@executor-js/mcp": patch
"@executor-js/app-templates": patch
---

Files that app tools return now reach the MCP client as embedded resources instead of base64 text.
When the result of `execute`, `call` or `resume` holds an MCP resource block with binary contents,
`{ type: "resource", resource: { uri, mimeType, blob } }`, it is sent once as its own content block
after the JSON text, as images and audio are, and the JSON keeps the block without its bytes plus
`contentIndex`. A client that saves resources as files, such as Claude Code, can then read a PDF an
app returns, such as an email attachment. Text resources stay in the JSON.
