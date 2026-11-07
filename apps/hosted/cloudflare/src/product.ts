/**
 * The product itself: its database, auth, routes and background work, opened inside the
 * `ExecutorProduct` Durable Object. `worker.ts` imports this module only when the object first
 * opens, so building it costs a request's CPU time rather than the Worker's startup budget.
 */
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import type { DurableObjectState } from "@cloudflare/workers-types";
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
import { cloudflarePlatform } from "./platform.ts";
import { mcpSessionAccessHeader } from "./mcp-session.ts";
import type { Environment, ProductStub } from "./worker.ts";

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
 * Open the product on the object's storage. Opening runs schema migrations and data steps; a
 * failure releases what it acquired and throws an error naming any invalid setting.
 */
export const openProduct = async (
  state: DurableObjectState,
  env: Environment,
): Promise<ProductStub> => {
  const scope = Scope.makeUnsafe();
  // Invalid settings say which setting, never a value, so they are reported as they are; any
  // other failure keeps the whole cause.
  let settings: string | undefined;
  let failure: unknown;
  try {
    const opened = await Effect.runPromiseExit(
      workerConfiguration(env).pipe(
        Effect.flatMap((config) =>
          prepare(state, env).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          ),
        ),
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    if (Exit.isSuccess(opened)) {
      await state.storage.setAlarm(Date.now() + 30_000);
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
};
