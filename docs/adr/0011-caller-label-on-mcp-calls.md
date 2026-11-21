# 0011. Every MCP server an app calls hears which agent session is calling

Date: 2026-11-21. Status: accepted (Nathan, 2026-11-21).

## Context

Every project thread reaches Muster and the wiki through one Executor sign-in, so each service sees
the same authenticated caller. Muster names who holds a task from the label in request `_meta`
under `dev.presidio-west/attribution` (`{client, person, agent, guide}`, a label only: no check
reads it). Executor v2 sent no `_meta`, so two threads holding tasks both showed as "you".

The MCP client gives Executor little per session. Claude Code's `clientInfo` is the same for
every thread. The one thing that differs per thread is the MCP session Executor issues at
`initialize`, carried in `Mcp-Session-Id`. A client may also send the label in its own request
`_meta`.

Nathan's ruling (2026-11-21): send a short who-is-calling label to every MCP server an app calls,
knowing every such server, not only Muster, sees it. It carries no credentials.

## Decision

- The label is `{client, agent}`. `client` is the client's `clientInfo` name and version. `agent`
  is the agent the client names in its request `_meta` under the same key, or else `session` and
  the first eight hex digits of the SHA-256 of its MCP session ID. The session ID itself never
  leaves Executor: it names the session to Executor. No person, email or account is sent.
- `packages/mcp/src/implementation/caller-label.ts` reads it when an `execute` or `call` request
  starts; the execution keeps it and passes it as `attribution` in the tool invocation options of
  every call and resumed call it makes, across the product's backend socket.
- `packages/sdk/src/implementation/caller-label.ts` gives it to the app invocation as the
  `x-executor-attribution` header beside the trace headers, as URI-encoded JSON so a name outside
  Latin-1 stays a valid header value. In the app isolate, the runtime's network module
  (`app-network.ts`), which already wraps the app's `fetch`, holds each running invocation's label
  by its trace ID. A JSON-RPC `tools/call` POST whose `traceparent` carries that trace gets the
  label in `params._meta`, unless the request already names one. Two running invocations on one
  trace with different labels, or the all-zero trace ID of a host without tracing, give no label,
  so one session's label never reaches another session's request.
- Only while a labelled invocation runs is a JSON POST on its trace read whole to look for
  `tools/call`; any other request, and any other request body, goes out unchanged.
- It is host code, not the app framework, so it reaches every app build without moving any app to
  a new `apps` release. The framework's MCP client already propagates the invocation's trace in
  `traceparent`.
- Rejected: adding the label in the framework's `mcpCall`. It would reach an app only after the
  app moved to a new framework release, which needs Nathan's go for each app, and it would add a
  field to the host protocol.
- Rejected: per-invocation props on the app Worker's outbound network. A Worker's network is bound
  when it loads, and app Workers are kept loaded across calls from different sessions.
- Rejected: an `AsyncLocalStorage` in the isolate. Effect fibers from concurrent invocations share
  scheduler ticks, so a label could reach another session's request.

## Consequences

- Muster and the wiki keep the label as `via`, so two threads on one sign-in show apart.
- A request with no trace context, a dashboard or API call (no MCP session), and the local Node
  runtime carry no label. The local runtime has no network module.
- Every MCP server an app calls sees the client name and the session tag. The tag stays the same
  for the life of the session.
- The tag is 32 bits of a hash: it tells sessions apart in a list, and is not an identifier.
- A JSON-RPC batch and any method but `tools/call` go out without a label.
- Held by `e2e/tests/mcp-caller-label.spec.ts`.
