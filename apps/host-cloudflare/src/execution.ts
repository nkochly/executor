import { Effect, Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  dbProviderLayer,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { env } from "cloudflare:workers";

import type { D1Database } from "@cloudflare/workers-types";
import type { McpPluginOptions } from "@executor-js/plugin-mcp";

import type { CloudflareConfig } from "./config";
import { catalogNow, catalogPresets } from "./platform";
import { makeCloudflarePlugins } from "./plugins";
import { makeTenantDefaults } from "./tenant-defaults";
import { WEBEX_MCP_ORIGIN, webexOAuthClients } from "./webex";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams — the same shape as self-host (QuickJS code
// substrate, no-op engine decorator), with the plugins + host config built from
// the per-request `env`-derived config rather than process.env.
//
// Code substrate: when the Worker declares a `worker_loaders` LOADER binding,
// use the dynamic-worker executor (cloud's substrate) — real isolates with
// `globalOutbound: null`. Without the binding, fall back to QuickJS-wasm,
// which runs in a single Worker with no extra binding.
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

export const CloudflareCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => {
    const loader = (env as { LOADER?: WorkerLoader }).LOADER;
    return loader ? makeDynamicWorkerExecutor({ loader }) : makeQuickJsExecutor();
  },
);

export const makeCloudflarePluginsProvider = (
  config: CloudflareConfig,
  callMeta?: McpPluginOptions["callMeta"],
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: (context) =>
      makeCloudflarePlugins(config.secretKey, {
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
        allowLocalNetwork: config.allowLocalNetwork,
        catalog: catalogPresets(catalogNow(config)),
        personalOnlyOrigins: config.webex ? [WEBEX_MCP_ORIGIN] : [],
        callMeta,
      }),
  });

export const makeCloudflareHostConfig = (
  config: CloudflareConfig,
  db: D1Database,
): Layer.Layer<HostConfig> =>
  Layer.effect(HostConfig)(
    Effect.promise(() => webexOAuthClients(config)).pipe(
      Effect.map((firstPartyOAuthClients) => ({
        allowLocalNetwork: config.allowLocalNetwork,
        webBaseUrl: config.webBaseUrl,
        oauthCallbackPath: "/api/oauth/callback",
        // Host-declared OAuth apps for servers with no dynamic registration.
        firstPartyOAuthClients,
        // Servers every tenant has without an admin adding them.
        tenantDefaults: makeTenantDefaults(db, config),
        // Multi-tenant: each tenant's admins approve what its connections may
        // use; a tool no admin approved is unavailable, whatever a toolkit says.
        ...(config.directory ? { toolPolicyCeiling: { unmatched: "block" as const } } : {}),
      })),
    ),
  );

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer over the long-lived D1 handle. Mirrors self-host's
 * `SelfHostExecutionStackLayer`. The HTTP path wires these seams individually
 * through `ExecutorApp.make`; the MCP session store provides this whole Layer to
 * build a per-session engine off the envelope's request pipeline.
 */
export const makeCloudflareExecutionStackLayer = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
  db: D1Database,
  callMeta?: McpPluginOptions["callMeta"],
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config, callMeta),
    makeCloudflareHostConfig(config, db),
    CloudflareCodeExecutorProvider,
    EngineDecoratorNoop,
  );
