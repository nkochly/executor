/** Docker keeps protocol state in bounded, idle-expiring Effect scopes. */
import {
  CallStateCache,
  type CallState,
  ConcurrentStatements,
  StatementBatch,
  authenticatedMcp,
  browserMcpRequest,
  hostedMcpApproval,
  dispatchHostedMcp,
  makeHostedMcp,
  mcpSessionKey,
} from "@executor-js/hosted-server";
import { ExecutionRejected, McpLimits, defaultMcpLimits, activePrograms } from "@executor-js/mcp";
import { Config, Effect, Option, RcMap, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { SelfHostStatementBatch } from "./contracts/statement-batch.ts";

/** Programs one process works on at once. */
const defaultMaxPrograms = 8;

/** Own protocol sessions in the server scope; the returned handler receives SDK/auth per request. */
export const selfHostMcp = Effect.gen(function* () {
  // Decoded as McpLimits, so a budget that is not a positive integer stops startup.
  const limits = yield* Schema.decodeUnknownEffect(McpLimits)({
    ...defaultMcpLimits,
    timeoutMs: yield* Config.Number("EXECUTOR_MCP_TIMEOUT_MS").pipe(
      Config.withDefault(defaultMcpLimits.timeoutMs),
    ),
    // Unset, a program's value and logs reach the agent whole.
    ...Option.match(yield* Config.Number("EXECUTOR_MCP_MAX_OUTPUT_BYTES").pipe(Config.option), {
      onNone: () => ({}),
      onSome: (maxOutputBytes) => ({ maxOutputBytes }),
    }),
  });
  const maxPrograms = yield* Config.Number("EXECUTOR_MCP_MAX_PROGRAMS").pipe(
    Config.withDefault(defaultMaxPrograms),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))),
  );
  // Every program in this process shares its one thread, so past the cap of programs doing work
  // (one parked on a person's answer does none) a new one is refused at once with a message the agent can act on, instead of slowing every caller.
  const beforeExecute = Effect.suspend(() =>
    activePrograms() < maxPrograms
      ? Effect.void
      : Effect.fail(
          new ExecutionRejected({
            message: `Executor is already running ${maxPrograms} programs. Retry in a minute; nothing from this request ran.`,
          }),
        ),
  );
  const sessions = yield* RcMap.make({
    // Each session keeps what its callers' last tool calls read (CallStateCache).
    lookup: (_key: string) =>
      Effect.map(makeHostedMcp(beforeExecute, limits), (handler) => ({
        ...handler,
        calls: new Map<string, CallState>(),
      })),
    idleTimeToLive: "30 minutes",
    capacity: 256,
  });
  const batch = yield* SelfHostStatementBatch;
  const http = authenticatedMcp((access, address) =>
    Effect.gen(function* () {
      const handler = yield* RcMap.get(sessions, mcpSessionKey(access));
      // A tool call's statements go out as one batch where the database can send one.
      return yield* dispatchHostedMcp(access, address, handler.http).pipe(
        Effect.provideService(ConcurrentStatements, { group: (effect) => effect }),
        Effect.provideService(StatementBatch, batch),
        Effect.provideService(CallStateCache, handler.calls),
      );
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(
          // An active request is never evicted to admit a new session.
          // Native clients can retry after another scope expires.
          HttpServerResponse.empty({ status: 503 }),
        ),
      ),
    ),
  );
  const approvals = browserMcpRequest((access, address) =>
    Effect.gen(function* () {
      const host = yield* RcMap.get(sessions, mcpSessionKey(access));
      return yield* hostedMcpApproval(host.approvals, access, address);
    }).pipe(
      Effect.catchTag("ExceededCapacityError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      ),
    ),
  );
  return { http, approvals };
});
