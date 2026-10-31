import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Effect } from "effect";

import type { Principal } from "@executor-js/host-mcp";

import { makeAccessVerifier, principalFromAccessClaims } from "./auth/cloudflare-access";
import type { CloudflareConfig, CloudflareEnv } from "./config";
import { AGENT_SLUG, agentRequest, agentSlug, type AgentGrant } from "./agent";
import { listMemberships, resolveTenant } from "./tenancy";

// ---------------------------------------------------------------------------
// Executor's own MCP sign-in. A client dials one URL, `/mcp`, and signs in
// with standard MCP OAuth: it registers itself (RFC 7591), the person signs in
// through Cloudflare Access on `/authorize` (the only path Access guards in this
// mode), and picks a tenant and an agent. The token carries the person, the
// tenant and the agent, and every call on it is held to them:
//
//   - the tenant is re-checked against the membership directory on every
//     request, so removing someone takes effect at once;
//   - the agent is a toolkit in that tenant, and the call is served as that
//     toolkit, so the agent sees only its own tool list inside what the
//     tenant's admins approved. Nothing in the URL can widen it.
//
// Sessions are bound to the toolkit (the session owner check compares the
// resource), so each agent keeps its own sessions.
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string, headers = new Headers(), status = 200): Response => {
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect an agent</title>` +
      `<style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}label{display:block;padding:.4rem 0}input[type=text]{width:100%;padding:.4rem;box-sizing:border-box}button{margin-top:1rem;padding:.5rem 1rem}.hint{color:#666;font-size:.9rem}</style>` +
      `</head><body>${body}</body></html>`,
    { status, headers },
  );
};

type Helpers = OAuthHelpers;

const authorize = async (
  request: Request,
  env: CloudflareEnv & { OAUTH_PROVIDER: Helpers },
  config: CloudflareConfig,
): Promise<Response> => {
  const directory = config.directory!;
  const { verifyClaims } = makeAccessVerifier(config);
  const claims = await Effect.runPromise(verifyClaims(request));
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  if (!claims || !email)
    return page("<p>Sign in through Cloudflare Access first.</p>", undefined, 401);
  const helpers = env.OAUTH_PROVIDER;
  const memberships = await Effect.runPromise(listMemberships(directory, email));

  if (request.method === "POST") {
    const form = await request.formData();
    const tenant = String(form.get("tenant") ?? "");
    const agentName = String(form.get("agent") ?? "").trim();
    const agent = agentSlug(agentName);
    const handle = String(form.get("handle") ?? "");
    if (!memberships.some((m) => m.tenant.slug === tenant)) {
      return page("<p>That tenant is not one you belong to.</p>", undefined, 403);
    }
    if (!AGENT_SLUG.test(agent)) {
      return page(
        "<p>Give the agent a name with at least one letter or digit.</p>",
        undefined,
        400,
      );
    }
    const approved = await helpers.approveConsent(request, handle);
    const grant: AgentGrant = {
      accountId: typeof claims.sub === "string" && claims.sub ? claims.sub : email,
      email,
      name: typeof claims.name === "string" ? claims.name : null,
      tenant,
      agent,
      agentName,
      clientId: approved.request.clientId,
    };
    const { redirectTo } = await helpers.completeAuthorization({
      request: approved.request,
      userId: encodeURIComponent(email),
      metadata: { tenant, agent },
      scope: approved.request.scope,
      props: grant,
    });
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  }

  const authRequest = await helpers.parseAuthRequest(request);
  if (memberships.length === 0) {
    return page("<p>You are not in any tenant yet. Ask a tenant owner to add you.</p>");
  }
  const consent = await helpers.beginConsent(authRequest);
  const client = await helpers.describeConsent(authRequest);
  const clientName = client.clientName ?? "This app";
  const tenants = memberships
    .map(
      (m, i) =>
        `<label><input type="radio" name="tenant" value="${escapeHtml(m.tenant.slug)}"${i === 0 ? " checked" : ""}> ${escapeHtml(m.tenant.name)}</label>`,
    )
    .join("");
  return page(
    `<h1>Connect an agent</h1>` +
      `<p>${escapeHtml(clientName)} will act as you (${escapeHtml(email)}) in one tenant, as one agent, with that agent's tools only.</p>` +
      `<form method="post"><h2>Tenant</h2>${tenants}` +
      `<h2>Agent</h2><label>Name <input type="text" name="agent" required maxlength="63" value="${escapeHtml(clientName)}"></label>` +
      `<p class="hint">Using a name again reconnects that agent with its tool list. A new name starts a new agent.</p>` +
      `<input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><button type="submit">Connect</button></form>`,
    consent.headers,
  );
};

/** The principal a grant acts as now, or `null` once the person left the tenant. */
export const principalForGrant = (
  grant: AgentGrant,
  config: CloudflareConfig,
): Effect.Effect<Principal | null> =>
  resolveTenant(config.directory!, grant.email, grant.tenant).pipe(
    Effect.map((membership) =>
      principalFromAccessClaims(
        { sub: grant.accountId, email: grant.email, name: grant.name ?? undefined },
        config,
        membership,
      ),
    ),
  );

const unauthorized = (): Response =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );

type Serve = {
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (
    request: Request,
    env: CloudflareEnv,
    ctx: ExecutionContext,
    bound?: Principal,
  ) => Promise<Response>;
};

const providers = new Map<string, OAuthProvider<CloudflareEnv>>();

/**
 * The OAuth front door for one hostname. `/mcp` takes only this provider's
 * tokens; everything else (`/authorize`, the console, `/api`) goes on to the
 * app, and a non-OAuth MCP request is refused there so no URL serves MCP
 * without an agent.
 */
export const oauthProviderFor = (
  host: string,
  config: CloudflareConfig,
  resolve: (env: CloudflareEnv) => Promise<Serve>,
  fallback: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>,
): OAuthProvider<CloudflareEnv> => {
  const existing = providers.get(host);
  if (existing) return existing;
  const provider = new OAuthProvider<CloudflareEnv>({
    resourceMetadata: { resource: `https://${host}/mcp`, resource_name: "Executor" },
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
        const grant = (ctx as ExecutionContext & { props: AgentGrant }).props;
        const principal = await Effect.runPromise(principalForGrant(grant, config));
        if (!principal) return unauthorized();
        const serve = await resolve(env);
        return serve.mcp(agentRequest(request, grant.agent), env, ctx, principal);
      },
    },
    defaultHandler: {
      async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
        if (new URL(request.url).pathname === "/authorize") {
          return authorize(request, env as CloudflareEnv & { OAUTH_PROVIDER: Helpers }, config);
        }
        return fallback(request, env, ctx);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // Access re-checks the person at most a day apart, as its own session does.
    refreshTokenTTL: 86_400,
  });
  providers.set(host, provider);
  return provider;
};
