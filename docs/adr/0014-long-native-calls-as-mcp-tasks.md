# 0014. Long native calls as MCP tasks

Date: 2026-11-24

## Context

MCP 2026-07-28 adds the tasks extension: a server may answer a `tools/call` with an MCP task, and
the client polls it with `tasks/get` instead of holding the request open. Claude supports it. A
native `execute` or `call` can run for minutes (an app call, an approval), longer than a client
wants to hold one request.

## Decision

`makeMcpTasks` (`packages/mcp/src/implementation/mcp-tasks.ts`) serves the extension in native
mode only, through the Effect patch `patches/effect-mcp-tasks.md`.

- A native call from a client that declared the extension starts as usual. If it ends or pauses
  for input within 5 seconds, it answers inline exactly as before, input required included.
  Otherwise it answers with a task, and the execution goes on in the session's scope.
- The task reports `working`, then `input_required` with the pending approval or input as one
  `elicitation/create` request keyed by its interaction ID, then `completed` with the same result
  the call would have returned. A failure the call would have reported as a tool error is a
  completed task with that error result; only an internal failure is `failed`.
- `tasks/update` answers the pending interaction through the same resume as every other mode.
  `tasks/cancel` interrupts the execution or discards its pending interaction.
- A task belongs to the caller that started it: any other caller's `tasks/get` reads it as not
  found. Tasks live in the session's memory, like executions, for an hour at most, and at most 256
  per session; an eviction loses them as it loses programs.
- On Cloudflare the session object keeps itself awake while it holds an execution
  (decision record 0003), so a task's execution goes on between polls.
- The 5 second window, the 2 second poll interval and the hour are constants in `mcpTaskLimits`.
  The execution's own time budget still applies.

## Consequences

A client without the extension, and every other mode, sees no change. The approval of a task
waits for the client to poll and answer; it is the same approval the client would otherwise have
been asked inline.
