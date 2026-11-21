import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  McpAccess,
  fromWire,
  isolatedProgram,
  makeHostedMcp,
  provideHostedMcpRequest,
  remoteMcpBackend,
  toWire,
  type HostedMcpRequestError,
} from "@executor-js/hosted-server";
import programSandbox from "executor:program-sandbox";
import { selfHostMcpLimits } from "@executor-js/hosted-self-host/product";
import type { McpBackend } from "@executor-js/mcp";
import { ElicitationResponse } from "apps/contracts";
import { Cause, ConfigProvider, Config, Effect, Exit, Schema, Scope } from "effect";
import { HttpEffect, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { withRemoteSpan } from "@executor-js/telemetry";
import { workerConfiguration } from "./configuration.ts";
import { mcpSessionStore } from "./mcp-session-store.ts";
import { sessionProductBackend } from "./mcp-session-product.ts";
import { startInIsolate } from "./program-isolate.ts";
import {
  mcpSessionAccessHeader,
  type McpSessionEnvironment,
  type McpSessionHandle,
} from "./mcp-session.ts";

const decodeAccess = Schema.decodeUnknownEffect(Schema.fromJsonString(McpAccess));
const decodeResponse = Schema.decodeUnknownEffect(ElicitationResponse);

const open = (env: McpSessionEnvironment, storage: DurableObjectStorage) =>
  Effect.gen(function* () {
    const { limits, beforeExecute } = yield* selfHostMcpLimits;
    const origin = yield* Config.String("BETTER_AUTH_URL");
    const hosted = yield* makeHostedMcp(
      beforeExecute,
      limits,
      mcpSessionStore(storage),
      undefined,
      env.LOADER === undefined
        ? undefined
        : isolatedProgram(startInIsolate(env.LOADER, programSandbox)),
    );
    const product = sessionProductBackend(env);
    const serve = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const encoded = request.headers[mcpSessionAccessHeader];
      const access = yield* decodeAccess(encoded ?? "");
      const headers = new Headers(request.headers);
      headers.delete(mcpSessionAccessHeader);
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      const url = new URL(request.url, origin).toString();
      const backend = remoteMcpBackend((call) =>
        product(new Request(url, { method: "POST", headers }), call),
      ) as unknown as McpBackend<HostedMcpRequestError>;
      return yield* provideHostedMcpRequest(access, backend, origin, hosted.http).pipe(
        withRemoteSpan(
          new Request("https://mcp-session.internal", {
            headers: { traceparent: request.headers.traceparent ?? "" },
          }),
          "mcp.session.request",
        ),
      );
    }).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ),
    );
    const context = yield* Effect.context<never>();
    return {
      fetch: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof serve>>(context)(serve),
      approvals: hosted.approvals,
      programs: hosted.programs,
      context,
    };
  }).pipe(Effect.provide(HttpServer.layerServices));

export const openMcpSession = async (
  env: McpSessionEnvironment,
  storage: DurableObjectStorage,
): Promise<McpSessionHandle> => {
  const scope = Scope.makeUnsafe();
  const opened = await Effect.runPromiseExit(
    workerConfiguration(env).pipe(
      Effect.flatMap((config) =>
        open(env, storage).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
        ),
      ),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  if (Exit.isFailure(opened)) {
    console.error(Cause.pretty(opened.cause));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("Executor MCP session could not open.", { cause: opened.cause });
  }
  const session = opened.value;
  return {
    fetch: session.fetch,
    programs: session.programs,
    approvalView: async (caller, address) =>
      toWire(await Effect.runPromiseWith(session.context)(session.approvals.get(caller, address))),
    approvalAnswer: async (caller, address, response) => {
      const exit = await Effect.runPromiseWith(session.context)(
        decodeResponse(fromWire(response)).pipe(
          Effect.orDie,
          Effect.flatMap((answer) => session.approvals.answer(caller, address, answer)),
          Effect.exit,
        ),
      );
      if (Exit.isSuccess(exit)) return { ok: true, value: toWire(exit.value) };
      const error = Cause.findErrorOption(exit.cause);
      return error._tag === "Some"
        ? { ok: false, error: toWire(error.value) }
        : { ok: false, defect: Cause.pretty(exit.cause) };
    },
  };
};
