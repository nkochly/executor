# 0012. Native approvals as input required on MCP 2026-07-28

Date: 2026-11-24. Status: accepted.

## Context

Claude made elicitation generally available on 2026-11-24, on MCP 2026-07-28. That revision has
no sessions, so a server can no longer send `elicitation/create` to the client in the middle of a
call. It answers the call with `resultType: "input_required"` instead, and the client sends the
same call again with the person's answer in `inputResponses` and the server's `requestState`
(multi round-trip requests). Native mode (`?elicitation_mode=native`) served only 2025-06-18 and
2025-11-25, where it held the request open and asked over the session. Upstream Executor had
neither.

## Decision

- Native mode serves 2026-07-28 too. On that revision `execute` and `call` return each pending
  approval or tool input as `input_required`, with one input request keyed by the interaction's
  `requestId`, and `requestState` set to that same `requestId`
  (`packages/mcp/src/implementation/native-elicitation.ts`, `executeNativeByInput`).
- The retry finds the parked program by `requestState` and answers it with
  `inputResponses[requestState]`, through the same `resume` the model mode uses. A retry without
  the answer gets the same request again; an unknown or ended request gets the `unavailable`
  result the `resume` tool gives.
- `requestState` is the bare `requestId`, not a sealed blob. The specification asks servers to
  protect state that decides authorization; here nothing in it does. The executions store keeps
  each request under its caller, the session object is named for the caller (decision record
  0003), and a request id another caller sends is `unavailable`. Sealing it would need a new
  secret for no gain.
- Effect's toolkit could not return `input_required`, only a hand-registered tool could.
  `effect@4.1.4.patch` lets a toolkit handler fail with `McpSchema.InputRequired`, and the server
  sends it as the call's result (`patches/effect-mcp-tool-input-required.md`).
- A client that does not declare form elicitation gets Effect's `-32021` naming the capability.
  Native mode stays opt-in: an unattended agent whose client declares elicitation would otherwise
  wait on a prompt nobody answers.

## Consequences

- Claude and Claude Code show Executor's approvals in their own prompt when the connector URL has
  `?elicitation_mode=native`.
- The session-based path is unchanged for older revisions.
- `mcp-protocol-versions.spec.ts` ("Hosted MCP asks a 2026-07-28 client for native approval as
  input required") holds the round trip, the retry without an answer and the missing capability.
