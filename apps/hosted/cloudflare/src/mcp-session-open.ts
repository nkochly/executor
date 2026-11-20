import { RpcTarget } from "cloudflare:workers";
import type { DurableObjectStorage, WorkerLoader } from "@cloudflare/workers-types";
import {
  McpAccess,
  fromWire,
  isolatedProgram,
  makeHostedMcp,
  provideHostedMcpRequest,
  remoteMcpBackend,
  toWire,
  type HostedMcpRequestError,
  type ProgramHost,
  type StartIsolatedProgram,
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
import { productStub } from "@executor-js/hosted-cloudflare/product-location";
import {
  mcpSessionAccessHeader,
  type McpSessionEnvironment,
  type McpSessionHandle,
} from "./mcp-session.ts";

const maxProgramCpuMs = 300_000;

class ProgramHostTarget extends RpcTarget implements ProgramHost {
  readonly #host: ProgramHost;
  constructor(host: ProgramHost) {
    super();
    this.#host = host;
  }
  backend(call: Parameters<ProgramHost["backend"]>[0]) {
    return this.#host.backend(call);
  }
  progress(report: Parameters<ProgramHost["progress"]>[0]) {
    this.#host.progress(report);
  }
  deadline() {
    return this.#host.deadline();
  }
}

interface ProgramEntrypoint {
  run(code: string, limits: unknown, host: ProgramHostTarget): Promise<unknown>;
}

const startInIsolate =
  (loader: WorkerLoader): StartIsolatedProgram =>
  (code, limits, host) => {
    const worker = loader.load({
      compatibilityDate: "2026-09-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "program.js",
      modules: { "program.js": programSandbox },
      globalOutbound: null,
      limits: { cpuMs: Math.min(limits.timeoutMs, maxProgramCpuMs) },
    });
    const program = worker.getEntrypoint("Program") as unknown as ProgramEntrypoint;
    return program.run(code, limits, new ProgramHostTarget(host));
  };

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
      env.LOADER === undefined ? undefined : isolatedProgram(startInIsolate(env.LOADER)),
    );
    const product = productStub(env.PRODUCT, env);
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
        product.mcpBackend(new Request(url, { method: "POST", headers }), call),
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
