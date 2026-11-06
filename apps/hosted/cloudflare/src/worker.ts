/**
 * Executor on stock Cloudflare Workers. One Durable Object owns the database, auth, sessions and
 * background work, as in the self-host image, with the Durable Object's own SQLite storage as the
 * database and no native helper beside it:
 * - settings come from the Worker's vars and secrets (`configuration.ts`);
 * - the dashboard's browser files are the Worker's static assets (`ASSETS`);
 * - outbound HTTP is the global `fetch`, behind the same URL policy;
 * - requests to this instance's own origin go to the product through `SELF`;
 * - telemetry is logged to the console, which Workers observability collects, unless an OTLP
 *   endpoint is configured;
 * - blobs, app repositories and the app runtime come from `platform.ts`.
 */
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import { sqliteLayer } from "fumadb-effect/sqlite";
import { executorSkillFiles } from "@executor-js/app-templates/executor";
import { ScheduleHostReady } from "@executor-js/sdk/scheduling";
import { telemetryConfig, telemetryLayer } from "@executor-js/telemetry";
import { urlPolicyConfig } from "@executor-js/utils/url-policy";
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";
import {
  FetchHttpClient,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  FirstPartyOAuthClientsInvalid,
  McpAccess,
  fromWire,
  toWire,
  type McpBackendCall,
  type WireExit,
} from "@executor-js/hosted-server";
import type { BrowserApprovalView, BrowserApprovals } from "@executor-js/mcp/browser";
import {
  bindingDashboard,
  bindingHttpClient,
  selfHostExecutorServices,
  selfHostRouteMap,
  sqliteDatabaseSchema,
  SelfHostWorkflowRequests,
  type HttpBinding,
  type McpSessionHost,
} from "@executor-js/hosted-self-host/product";
import skills from "executor:skills";
import dashboard from "executor:dashboard";
import { WorkerConfigurationInvalid, workerConfiguration } from "./configuration.ts";
import { cloudflarePlatform, type PlatformBindings } from "./platform.ts";
import { mcpSessionAccessHeader } from "./mcp-session.ts";

export { ExecutorMcpSession } from "./mcp-session.ts";

interface ProductStub {
  fetch(request: Request): Promise<Response>;
  workflow(request: Request): Promise<Response>;
  mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit>;
}
/** A caller's session object, as the product reaches it. */
interface McpSessionStub {
  fetch(request: Request): Promise<Response>;
  approvalView(caller: string, address: unknown): Promise<unknown>;
  approvalAnswer(caller: string, address: unknown, response: unknown): Promise<WireExit>;
}
interface Environment extends PlatformBindings {
  readonly PRODUCT: { getByName(name: string): ProductStub };
  /** Callers' MCP session objects; used when `EXECUTOR_MCP_SESSIONS` is true. */
  readonly MCP_SESSIONS?: { getByName(name: string): McpSessionStub };
  /** The dashboard's browser files; the Worker runs first, so only the asset manifest is served. */
  readonly ASSETS: Fetcher;
  /** This Worker's own `SelfOrigin` entrypoint, for requests to the dashboard origin. */
  readonly SELF: Fetcher;
}

const encodeAccess = Schema.encodeSync(Schema.fromJsonString(McpAccess));

/**
 * MCP sessions in their own objects: the product authenticates and forwards each `/mcp` request
 * to the caller's object, and runs the backend operations the object sends back. Until `serve`
 * is called no operation can run, and the product answers each with a defect.
 */
const sessionHost = (sessions: NonNullable<Environment["MCP_SESSIONS"]>) => {
  let served: ((request: Request, call: McpBackendCall) => Promise<WireExit>) | undefined;
  const host: McpSessionHost = {
    forward: (key, access) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
        const forwarded = new Request(web);
        forwarded.headers.set(mcpSessionAccessHeader, encodeAccess(access));
        const response = yield* Effect.promise(() => sessions.getByName(key).fetch(forwarded));
        return HttpServerResponse.fromWeb(response);
      }),
    approvals: (key): BrowserApprovals => ({
      get: (product, address) =>
        Effect.promise(() => sessions.getByName(key).approvalView(product, address)).pipe(
          Effect.map((view) => fromWire(view) as BrowserApprovalView),
        ),
      answer: (product, address, response) =>
        Effect.promise(() =>
          sessions.getByName(key).approvalAnswer(product, address, toWire(response)),
        ).pipe(
          Effect.flatMap((exit) =>
            exit.ok
              ? Effect.succeed(fromWire(exit.value) as never)
              : "error" in exit
                ? Effect.fail(fromWire(exit.error) as never)
                : Effect.die(exit.defect),
          ),
        ),
    }),
    serve: (run) => {
      served = run;
    },
  };
  const backend = (request: Request, call: McpBackendCall): Promise<WireExit> =>
    served === undefined
      ? Promise.resolve({ ok: false, defect: "MCP sessions are not served by this product" })
      : served(request, call);
  return { host, backend };
};

/** Outbound requests leave through the Worker's network; the URL policy is checked before. */
const network: HttpBinding = { fetch: (request) => fetch(request) };

const prepare = (state: DurableObjectState, env: Environment) =>
  Effect.gen(function* () {
    const telemetry = yield* telemetryConfig("executor-cloudflare");
    const common = yield* Layer.build(
      Layer.mergeAll(
        sqliteDatabaseSchema.pipe(Layer.provideMerge(sqliteLayer(state.storage))),
        telemetryLayer(telemetry),
        HttpServer.layerServices,
        BrowserCrypto.layer,
        Layer.succeed(ScheduleHostReady, Effect.void),
      ),
    );
    return yield* Effect.gen(function* () {
      const policy = yield* urlPolicyConfig;
      const egress = {
        policy,
        client: yield* bindingHttpClient(policy, network, network, {
          origin: yield* Config.String("BETTER_AUTH_URL"),
          binding: env.SELF as unknown as HttpBinding,
        }),
      };
      const services = yield* Layer.build(
        selfHostExecutorServices(egress, cloudflarePlatform(env, state.storage)),
      );
      const sessions =
        env.MCP_SESSIONS !== undefined &&
        (yield* Config.Boolean("EXECUTOR_MCP_SESSIONS").pipe(Config.withDefault(false)))
          ? sessionHost(env.MCP_SESSIONS)
          : undefined;
      const routes = yield* selfHostRouteMap({
        ...(sessions === undefined ? {} : { mcpSessions: sessions.host }),
        skills: executorSkillFiles(skills),
        egress,
        executorServices: Layer.succeedContext(services),
        dashboard: bindingDashboard(env.ASSETS as unknown as HttpBinding, dashboard),
      });
      const http = yield* HttpRouter.toHttpEffect(routes).pipe(
        Effect.provideService(Layer.CurrentMemoMap, yield* Layer.makeMemoMap),
      );
      const workflow = Context.get(services, SelfHostWorkflowRequests);
      const context = yield* Effect.context<never>();
      const addressed = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* http.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            request.modify({
              remoteAddress: Option.fromUndefinedOr(request.headers["x-executor-client-ip"]),
            }),
          ),
        );
      });
      return {
        fetch: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof addressed>>(context)(
          addressed,
        ),
        workflow: HttpEffect.toWebHandlerWith<never, Effect.Services<typeof workflow>>(context)(
          workflow,
        ),
        mcpBackend: (request: Request, call: McpBackendCall): Promise<WireExit> =>
          sessions === undefined
            ? Promise.resolve({ ok: false, defect: "MCP sessions are off" })
            : sessions.backend(request, call),
      };
    }).pipe(Effect.provideContext(common));
  });

/**
 * Opening the store runs schema migrations and data steps, which can take longer on a large
 * install than a `blockConcurrencyWhile` callback may run. So the store opens outside it, and
 * every entry point waits for the open product instead.
 */
export class ExecutorProduct extends DurableObject<Environment> implements ProductStub {
  readonly #state: DurableObjectState;
  readonly #env: Environment;
  #opening: Promise<Effect.Success<ReturnType<typeof prepare>>> | undefined;
  constructor(state: DurableObjectState, env: Environment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    // Start at once, as after a restart; a failure is reported to the events that wait for it.
    this.#product().catch(() => undefined);
  }
  /** The open product. A failed open releases what it acquired, and the next event retries it. */
  #product() {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }
  async #open() {
    const scope = Scope.makeUnsafe();
    // Invalid settings say which setting, never a value, so they are reported as they are; any
    // other failure keeps the whole cause.
    let settings: string | undefined;
    let failure: unknown;
    try {
      const opened = await Effect.runPromiseExit(
        workerConfiguration(this.#env).pipe(
          Effect.flatMap((config) =>
            prepare(this.#state, this.#env).pipe(
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
            ),
          ),
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      if (Exit.isSuccess(opened)) {
        await this.#state.storage.setAlarm(Date.now() + 30_000);
        return opened.value;
      }
      const squashed = Cause.squash(opened.cause);
      if (
        Schema.is(FirstPartyOAuthClientsInvalid)(squashed) ||
        Schema.is(WorkerConfigurationInvalid)(squashed)
      )
        settings = squashed.message;
      failure = opened.cause;
      // The Worker's logs are the operator's only view of why the product did not open.
      console.error(Cause.pretty(opened.cause));
    } catch (error) {
      failure = error;
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error(settings ?? "Executor product storage could not open.", { cause: failure });
  }
  /** Dispatch the authenticated product routes. */
  async fetch(request: Request): Promise<Response> {
    return (await this.#product()).fetch(request);
  }
  /** Private workflow callbacks are reached only through the named service entrypoint. */
  async workflow(request: Request): Promise<Response> {
    return (await this.#product()).workflow(request);
  }
  /** One backend operation a caller's session object sends for the request it serves. */
  async mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit> {
    return (await this.#product()).mcpBackend(request, call);
  }
  /** Restore the background owner after an eviction or restart even when no request arrives. */
  async alarm(): Promise<void> {
    await this.#product();
    await this.#state.storage.setAlarm(Date.now() + 30_000);
  }
}

/** Service entrypoint for the app host's workflow callbacks. */
export class WorkflowCallbacks extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    return this.env.PRODUCT.getByName("product").workflow(request);
  }
}

/**
 * Requests this instance sends to its own dashboard origin, from app isolates or host egress.
 * They never cross the network, so they carry a fixed internal source instead of any client
 * address header the sender supplied.
 */
export class SelfOrigin extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const internal = new Request(request);
    internal.headers.set("x-executor-client-ip", "127.0.0.1");
    return this.env.PRODUCT.getByName("product").fetch(internal);
  }
}

/**
 * Public traffic reaches only the product's authenticated route map. The client address is the
 * one Cloudflare's edge saw; any address header the client sent is replaced.
 */
export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    const addressed = new Request(request);
    addressed.headers.delete("x-executor-client-ip");
    const client = request.headers.get("cf-connecting-ip");
    if (client !== null) addressed.headers.set("x-executor-client-ip", client);
    return env.PRODUCT.getByName("product").fetch(addressed);
  },
};
