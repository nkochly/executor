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
  hostedMcpRequestBackend,
  serveMcpBackendCall,
  toWire,
  McpUnauthorized,
  type McpAccess,
  type McpBackendCall,
  type WireExit,
} from "@executor-js/hosted-server";
import { ExecutionRejected, McpLimits, defaultMcpLimits, activePrograms } from "@executor-js/mcp";
import { Config, Effect, Option, RcMap, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http";
import type { BrowserApprovals } from "@executor-js/mcp/browser";
import { SelfHostStatementBatch } from "./contracts/statement-batch.ts";

/** Programs one process works on at once. */
const defaultMaxPrograms = 8;

/**
 * Where a host runs MCP sessions outside this process. The product still authenticates every
 * request and owns every backend operation; the host's session objects hold protocol state and run
 * programs, and send each operation back through `serve`.
 */
export interface McpSessionHost {
  /** Answer an authenticated `/mcp` request in the caller's session object. */
  readonly forward: (
    key: string,
    access: McpAccess,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  /** The pending approvals of the caller's session object, for the browser approval page. */
  readonly approvals: (key: string) => BrowserApprovals;
  /** Take the function that runs one backend operation a session object sends for its request. */
  readonly serve: (run: (request: Request, call: McpBackendCall) => Promise<WireExit>) => void;
}

/**
 * The program budgets and admission check of one process that runs programs. Every program in a
 * process shares its one thread, so past the cap of programs doing work (one parked on a person's
 * answer does none) a new one is refused at once with a message the agent can act on, instead of
 * slowing every caller.
 */
export const selfHostMcpLimits = Effect.gen(function* () {
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
  const beforeExecute = Effect.suspend(() =>
    activePrograms() < maxPrograms
      ? Effect.void
      : Effect.fail(
          new ExecutionRejected({
            message: `Executor is already running ${maxPrograms} programs. Retry in a minute; nothing from this request ran.`,
          }),
        ),
  );
  return { limits, beforeExecute };
});

/** Own protocol sessions in the server scope; the returned handler receives SDK/auth per request. */
export const selfHostMcp = (remote?: McpSessionHost) =>
  Effect.gen(function* () {
    const { limits, beforeExecute } = yield* selfHostMcpLimits;
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
    if (remote === undefined) return { http, approvals, backendCall: undefined };
    /**
     * One operation a session object sent for the request it is serving. The request's headers are
     * authenticated again here, and the operation runs with the backend an in-process request would.
     */
    const backendCall = (call: McpBackendCall) => {
      let outcome: WireExit = { ok: false, defect: "MCP request was not authenticated" };
      return authenticatedMcp((access, address) =>
        Effect.gen(function* () {
          const request = yield* hostedMcpRequestBackend(access, address);
          if ("refused" in request) return request.refused;
          outcome = yield* serveMcpBackendCall(request.backend, call).pipe(
            Effect.provideService(ConcurrentStatements, { group: (effect) => effect }),
            Effect.provideService(StatementBatch, batch),
          );
          return HttpServerResponse.empty({ status: 204 });
        }),
      ).pipe(
        Effect.map((response) =>
          response.status === 204
            ? outcome
            : // A credential or grant that no longer serves this request fails the operation as
              // one the caller must sign in again for.
              ({ ok: false, error: toWire(new McpUnauthorized()) } as const),
        ),
      );
    };
    return {
      http: authenticatedMcp((access) => remote.forward(mcpSessionKey(access), access)),
      // The page checks app and account access here, where the database is; the request it
      // answers is held in the session object.
      approvals: browserMcpRequest((access, address) =>
        hostedMcpApproval(remote.approvals(mcpSessionKey(access)), access, address),
      ),
      backendCall,
    };
  });
