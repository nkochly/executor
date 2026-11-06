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
import { Cause, Config, ConfigProvider, Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import {
  FetchHttpClient,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/http";
import { FirstPartyOAuthClientsInvalid } from "@executor-js/hosted-server";
import {
  bindingDashboard,
  bindingHttpClient,
  selfHostExecutorServices,
  selfHostRouteMap,
  sqliteDatabaseSchema,
  SelfHostWorkflowRequests,
  type HttpBinding,
} from "@executor-js/hosted-self-host/product";
import skills from "executor:skills";
import dashboard from "executor:dashboard";
import { WorkerConfigurationInvalid, workerConfiguration } from "./configuration.ts";
import { cloudflarePlatform, type PlatformBindings } from "./platform.ts";

interface ProductStub {
  fetch(request: Request): Promise<Response>;
  workflow(request: Request): Promise<Response>;
}
interface Environment extends PlatformBindings {
  readonly PRODUCT: { getByName(name: string): ProductStub };
  /** The dashboard's browser files; the Worker runs first, so only the asset manifest is served. */
  readonly ASSETS: Fetcher;
  /** This Worker's own `SelfOrigin` entrypoint, for requests to the dashboard origin. */
  readonly SELF: Fetcher;
}

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
        selfHostExecutorServices(egress, cloudflarePlatform(env)),
      );
      const routes = yield* selfHostRouteMap({
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
      console.error('DEBUG', Cause.pretty(opened.cause));
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
