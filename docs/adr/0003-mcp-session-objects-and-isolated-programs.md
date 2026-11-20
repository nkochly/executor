# 0003. MCP session objects and isolated programs

Date: 2026-11-20. Status: accepted.

## Context

On one product object every caller's MCP protocol state and every `execute` program would share
one thread and one isolate's memory, so one heavy program could slow or crash every other caller.

## Decision

Session objects (`apps/hosted/cloudflare/src/mcp-session.ts`, `mcp-session-open.ts`):

- Each caller's MCP sessions and programs live in a Durable Object of their own,
  `ExecutorMcpSession`, named by the caller's session key (user, client, organization and grant).
  It is reached only through the product, which authenticates every request before forwarding it,
  with the caller's access in `x-executor-mcp-access` (encoded JSON).
- The session object holds no database. Every backend operation goes back to the product
  (`remoteMcpBackend`), with the headers the client sent, which the product authenticates again;
  the access header is the product's own and does not go back. Each operation is sent without the
  request's body.
- The product's errors come back rebuilt by class, so they are the request's own errors.
- The product hands over the request's trace context, and the session continues it, so the
  session's spans, its programs and every app call stay in the caller's trace.
- With a product location, each caller's object is the one named for it there. Sessions live in
  memory, so an object left at an old location holds nothing a caller loses.
- An idle object is evicted 70 to 140 seconds after its last event, and a program waiting for a
  person holds no request. While the object holds a program it wakes itself every 30 seconds
  (`holdMillis`).
- The browser approval page reads and answers a pending request through the session object; the
  product checks the page's access first.

Protocol sessions survive eviction (`mcp-session-store.ts`):

- Each protocol session's negotiated `initialize` (version, client capabilities and info) and the
  log level the client set are kept in the object's storage, so after an eviction, deploy or crash
  the client continues with the same session id instead of a 404 and a new `initialize`. A program
  running then is lost, and its resume reads as lost.
- A record grants nothing: every request is authenticated, and the product forwards a request only
  to the object its bearer's key names.
- One store per elicitation mode: a session belongs to the mode that opened it.
- A session unused for 7 days is forgotten; an object keeps at most 64, least recently used going
  first; an `initialize` over 16 KiB stays in memory only.
- Writes happen only on `initialize`, on `logging/setLevel` and once per restore. Reads happen only
  for a session id the object's memory does not hold.
- Each save or load reads, decides and writes in one synchronous step through the object's
  synchronous key-value storage. An object runs one piece of JavaScript at a time, so no other
  request can act between a step's read and its writes: a prune never works from a list older than
  a concurrent restore, and a restore never writes back a record a prune removed. A load refreshes
  a record only after the protocol server has decoded it and registered the session, within the
  same step.
- A record the server cannot use (unreadable, or a version it no longer serves) is deleted rather
  than kept to answer 404 again.
- A storage call that throws does not fail the client's request: a session it could not save stays
  in memory only, and one it could not read is unknown (404). A write that fails later, when the
  object's storage commits, is not caught: the runtime discards the response and restarts the
  object, and the client sees an error.

Programs in isolates (`program-sandbox.ts`, `apps/hosted/server/src/implementation/mcp-isolated.ts`):

- When `LOADER` is bound, each `execute` program runs in a fresh Dynamic Worker with no network
  and a CPU budget of 300 seconds, the most Cloudflare allows one Worker invocation. Without
  `LOADER` programs run in the session object.
- The session object keeps the execution: the brokered backend, approvals, the deadline and the
  progress its driver reads. The isolate runs only the interpreter and reaches the object through
  a `ProgramHost`: each backend operation, each progress change and the deadline cross as RPC
  calls.
- Progress reports are told, not awaited: a lost one is corrected by the next. A wait the driver
  marked stays marked.
- A tool call names the program's call it serves, so the host can mark its approval wait. The
  broker finds that call by the fiber that runs the backend operation.
- The deadline settles when the budget is spent or the host ends the execution; either way the
  program stops and returns what it did. When the isolate cannot give a result, the execution
  fails with the calls the program made, and nothing it started keeps running.

The wire between session object and product (`mcp-remote.ts`):

- Values cross as structured clones. Schema classes and Options do not survive a clone, so they
  cross as their encoded form under their identifier and are rebuilt on the other side from a
  registry of every class the product's operations return or fail with. A class the receiver does
  not know arrives as `RemoteFailure`, which keeps the tag and presents nothing. Dates, maps, sets
  and bytes cross as they are.
- An elicitation handler in an operation's options crosses as an RPC stub (a plain async
  function) and becomes an Effect again on the product side.
- No transaction spans two calls.
- An operation that cannot be reached or dies is `RemoteBackendUnavailable` to the agent.
- Cloudflare moves a busy object to new code minutes after a deploy, so a session object and the
  product can run different releases. The wire carries the execution an operation runs for and
  returns the tool call log's reference beside the outcome; a side that predates either neither
  sends nor reads it, and still serves and is served
  (`fixture/mcp-wire-versions.ts`, `e2e/tests/cloudflare-mcp-wire.spec.ts`).

Self-host program cap (`e2e/tests/self-host-program-cap.spec.ts`):

- Every program a self-host process runs shares its one thread. Past `EXECUTOR_MCP_MAX_PROGRAMS`
  programs doing work, a new `execute` is refused at once with a message the agent can act on, and
  nothing from it runs; once a program ends the next is admitted. With
  `EXECUTOR_MCP_MAX_OUTPUT_BYTES` set, a program's value is cut to that budget and marked.

## Consequences

- A program's CPU and memory are its isolate's, so it cannot slow or crash another caller's.
- Two excuses in this area are beta Muster tasks: the sandbox swallows every unhandled rejection
  after a program finishes, and the isolate's deadline swallows every failure of its wait.
