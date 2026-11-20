# 0007. One trace across the Trifecta

Date: 2026-11-20. Status: accepted.

## Decision

`apps/hosted/cloudflare/src/trace.ts`:

- Executor's trace id is the invocation's Workers trace id, followed across the Trifecta as
  `trifecta.trace_id`. The product receives it as the request's W3C `traceparent`, so the product's
  tracer continues it: its spans, the app host's and every outbound request an app makes through
  `ctx.fetch` carry the same id, and wiki_mcp and Muster record it under the same attribute.
- A caller's own trace context, including a message's `_meta.traceparent` (MCP SEP-414), is kept as
  `mcp.client.trace_id` and never becomes Executor's. B3 headers and `tracestate` are dropped, so no
  caller's context takes precedence on a path that reads headers in another order.
- Each `/mcp` request is one Workers span named `{mcp.method.name} {tool}` (OpenTelemetry MCP
  conventions) and one `mcp_call` log line per JSON-RPC message, as in wiki_mcp and Muster. Names,
  ids and timings only; never an argument or result.
- Where observability is off the ids are zeros and the request runs untraced. The module imports
  nothing at run time, so Worker startup stays within its CPU limit.
