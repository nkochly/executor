import { makeCloudflareApp } from "./app";
import {
  cloudflareAccessConfigErrorMessage,
  loadConfig,
  missingCloudflareAccessVars,
  type CloudflareEnv,
} from "./config";
import type { Principal } from "@executor-js/host-mcp";
import { mcpResourceFromPath } from "./mcp/resource";
import { oauthProviderFor } from "./oauth";
import { routeTenantRequest } from "./tenancy";

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` and `/mcp/toolkits/:slug` stay at this edge boundary because
// `McpAgent.serve()` needs the Cloudflare `ExecutionContext` to pass
// authenticated session props into the hibernatable Durable Object bridge.
// ---------------------------------------------------------------------------

let handlerPromise: Promise<{
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (
    request: Request,
    env: CloudflareEnv,
    ctx: ExecutionContext,
    bound?: Principal,
  ) => Promise<Response>;
}> | null = null;

const resolveHandler = (env: CloudflareEnv) => {
  if (!handlerPromise) {
    handlerPromise = makeCloudflareApp(env).then(({ toWebHandler, mcpAgentHandler }) => ({
      app: toWebHandler().handler,
      mcp: mcpAgentHandler,
    }));
  }
  return handlerPromise;
};

const accessConfigErrorResponse = (missingVars: readonly string[]): Response =>
  new Response(`${cloudflareAccessConfigErrorMessage(missingVars)}\n`, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const notFound = (): Response => new Response("Not found\n", { status: 404 });

// Without agent sign-in: the tenant comes from the URL and Access signs every
// request in. With it, this serves only what the OAuth provider passes on, so
// MCP is reachable only through an Executor token.
const route = async (
  incoming: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
  agentSignIn: boolean,
): Promise<Response> => {
  const serve = await resolveHandler(env);
  const request = routeTenantRequest(incoming, (env.TENANT_DIRECTORY_URL ?? "").trim().length > 0);
  const resource = mcpResourceFromPath(new URL(request.url).pathname);
  if (resource !== null) {
    return agentSignIn ? notFound() : serve.mcp(request, env, ctx);
  }
  return serve.app(request);
};

export default {
  fetch: async (
    incoming: Request,
    env: CloudflareEnv,
    ctx: ExecutionContext,
  ): Promise<Response> => {
    const missingAccessVars = missingCloudflareAccessVars(env);
    if (missingAccessVars.length > 0) {
      return accessConfigErrorResponse(missingAccessVars);
    }

    if (env.OAUTH_KV && (env.TENANT_DIRECTORY_URL ?? "").trim().length > 0) {
      const config = loadConfig(env);
      const provider = oauthProviderFor(
        new URL(incoming.url).host,
        config,
        resolveHandler,
        (request, e, c) => route(request, e, c, true),
      );
      return provider.fetch(incoming, env, ctx);
    }
    return route(incoming, env, ctx, false);
  },
};
