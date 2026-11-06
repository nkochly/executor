/**
 * One caller's MCP sessions and programs, in a Durable Object of their own. The product names the
 * object by the caller's session key (user, client, organization and grant), authenticates every
 * request before forwarding it, and owns every backend operation: the object holds no database
 * and sends each operation back to the product (`remoteMcpBackend`). A program's work therefore
 * uses this object's thread and memory, not the product's or another caller's.
 *
 * Each `execute` program runs in a Dynamic Worker of its own when `LOADER` is bound (see
 * `program-sandbox.ts`): its CPU and memory are that isolate's, so a heavy program cannot slow
 * another caller's, and it has no network. Without `LOADER` programs run in this object.
 *
 * Protocol state and programs live in memory. An idle object is evicted 70 to 140 seconds after
 * its last event, and a program waiting for a person holds no request, so while the object holds
 * a program it wakes itself every `holdMillis`. A deploy or crash loses its sessions; clients
 * initialize again, and a resume of a lost program reads as lost.
 */
import { DurableObject, RpcTarget } from "cloudflare:workers";
import type { DurableObjectState, WorkerLoader } from "@cloudflare/workers-types";
import {
  McpAccess,
  fromWire,
  isolatedProgram,
  makeHostedMcp,
  provideHostedMcpRequest,
  remoteMcpBackend,
  toWire,
  type HostedMcpRequestError,
  type McpBackendCall,
  type ProgramHost,
  type StartIsolatedProgram,
  type WireExit,
} from "@executor-js/hosted-server";
import programSandbox from "executor:program-sandbox";
import { selfHostMcpLimits } from "@executor-js/hosted-self-host/product";
import type { BrowserApprovalAddress } from "@executor-js/mcp/browser";
import type { McpBackend } from "@executor-js/mcp";
import { ElicitationResponse } from "apps/contracts";
import { Cause, ConfigProvider, Config, Effect, Exit, Schema, Scope } from "effect";
import { HttpEffect, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { workerConfiguration } from "./configuration.ts";

/** The header the product sets on a forwarded request: the caller's access, as encoded JSON. */
export const mcpSessionAccessHeader = "x-executor-mcp-access";

/** How often an object holding a program wakes itself. */
const holdMillis = 30_000;

/** The product operations a session object calls. */
export interface McpSessionProduct {
  mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit>;
}
export interface McpSessionEnvironment {
  readonly PRODUCT: { getByName(name: string): McpSessionProduct };
  /** Dynamic Workers; each program runs in one of its own when this is bound. */
  readonly LOADER?: WorkerLoader;
}

/** The most CPU time one program may use; Cloudflare allows a Worker invocation five minutes. */
const maxProgramCpuMs = 300_000;

/** The host a program's isolate calls back, as an RPC target so its methods cross as calls. */
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

/** Load a fresh isolate for one program, with no network and the program's CPU budget. */
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

const open = (env: McpSessionEnvironment) =>
  Effect.gen(function* () {
    const { limits, beforeExecute } = yield* selfHostMcpLimits;
    const origin = yield* Config.String("BETTER_AUTH_URL");
    const hosted = yield* makeHostedMcp(
      beforeExecute,
      limits,
      undefined,
      undefined,
      env.LOADER === undefined ? undefined : isolatedProgram(startInIsolate(env.LOADER)),
    );
    const product = env.PRODUCT.getByName("product");
    const serve = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const encoded = request.headers[mcpSessionAccessHeader];
      const access = yield* decodeAccess(encoded ?? "");
      // Each operation goes back with the headers the client sent, which the product
      // authenticates again; the access header is the product's own and does not go back.
      const headers = new Headers(request.headers);
      headers.delete(mcpSessionAccessHeader);
      // Each operation is sent without the request's body.
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      const url = new URL(request.url, origin).toString();
      // Its errors are the product's own, rebuilt by class, so they are the request's errors.
      const backend = remoteMcpBackend((call) =>
        product.mcpBackend(new Request(url, { method: "POST", headers }), call),
      ) as unknown as McpBackend<HostedMcpRequestError>;
      return yield* provideHostedMcpRequest(access, backend, origin, hosted.http);
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

/** A caller's MCP protocol sessions and running programs. Reached only through the product. */
export class ExecutorMcpSession extends DurableObject<McpSessionEnvironment> {
  readonly #state: DurableObjectState;
  readonly #env: McpSessionEnvironment;
  #opening: Promise<Effect.Success<ReturnType<typeof open>>> | undefined;
  constructor(state: DurableObjectState, env: McpSessionEnvironment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
  }
  #session() {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }
  async #open() {
    const scope = Scope.makeUnsafe();
    const opened = await Effect.runPromiseExit(
      workerConfiguration(this.#env).pipe(
        Effect.flatMap((config) =>
          open(this.#env).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          ),
        ),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    if (Exit.isSuccess(opened)) return opened.value;
    console.error(Cause.pretty(opened.cause));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("Executor MCP session could not open.", { cause: opened.cause });
  }
  /** While the object holds a program, an alarm is due within `holdMillis`. */
  async #hold() {
    const session = await this.#session();
    if (session.programs() === 0) return;
    const due = Date.now() + holdMillis;
    const set = await this.#state.storage.getAlarm();
    if (set === null || set > due || set < Date.now() - holdMillis)
      await this.#state.storage.setAlarm(due);
  }
  /** Serve one authenticated MCP request the product forwarded. */
  async fetch(request: Request): Promise<Response> {
    const session = await this.#session();
    try {
      return await session.fetch(request);
    } finally {
      await this.#hold();
    }
  }
  async alarm(): Promise<void> {
    await this.#hold();
  }
  /** A pending request for the browser approval page; the product checks the page's access. */
  async approvalView(caller: string, address: BrowserApprovalAddress): Promise<unknown> {
    const session = await this.#session();
    return toWire(
      await Effect.runPromiseWith(session.context)(session.approvals.get(caller, address)),
    );
  }
  /** The browser approval page's answer to a pending request. */
  async approvalAnswer(
    caller: string,
    address: BrowserApprovalAddress,
    response: unknown,
  ): Promise<WireExit> {
    const session = await this.#session();
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
  }
}
