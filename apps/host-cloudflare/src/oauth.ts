import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Effect } from "effect";

import type { Principal } from "@executor-js/host-mcp";

import { makeAccessVerifier, principalFromAccessClaims } from "./auth/cloudflare-access";
import type { CloudflareConfig, CloudflareEnv } from "./config";
import { AGENT_SLUG, agentRequest, agentSlug, type AgentGrant } from "./agent";
import { isOperator, listMemberships, resolveTenant } from "./tenancy";

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

/** A workspace agent someone already connected, offered on the sign-in page. */
export interface ExistingAgent {
  readonly slug: string;
  readonly name: string;
}

/** The value of the "new agent" choice; never a valid slug. */
const NEW_AGENT = "+new";

/**
 * The agent a sign-in form picks: one of the workspace's agents by slug, or a
 * new one by the name typed. `null` when the pick names no agent.
 */
export const chosenAgent = (
  form: { readonly pick: string | null; readonly typed: string },
  existing: readonly ExistingAgent[],
): { readonly slug: string; readonly name: string } | null => {
  if (form.pick !== null && form.pick !== NEW_AGENT) {
    const agent = existing.find((candidate) => candidate.slug === form.pick);
    return agent ? { slug: agent.slug, name: agent.name } : null;
  }
  const name = form.typed.trim();
  const slug = agentSlug(name);
  return AGENT_SLUG.test(slug) ? { slug, name } : null;
};

/** The agent choices: every workspace agent, then a new one named `suggested`. */
export const agentChoices = (existing: readonly ExistingAgent[], suggested: string): string => {
  const rows = existing.map(
    (agent, i) =>
      `<label><input type="radio" name="pick" value="${escapeHtml(agent.slug)}"${i === 0 ? " checked" : ""}> ${escapeHtml(agent.name)}</label>`,
  );
  rows.push(
    `<label><input type="radio" name="pick" value="${NEW_AGENT}"${existing.length === 0 ? " checked" : ""}> New agent named <input type="text" name="agent" maxlength="63" value="${escapeHtml(suggested)}" aria-label="New agent name"></label>`,
  );
  return rows.join("");
};

/**
 * The workspace's agents as the signed-in person sees them in the console,
 * read through the app with the same Access sign-in. Empty when they cannot
 * be read, so the page still offers a new agent.
 */
const workspaceAgents = async (
  request: Request,
  app: (request: Request) => Promise<Response>,
): Promise<readonly ExistingAgent[]> => {
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json");
  headers.delete("content-type");
  headers.delete("content-length");
  const body = await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const response = await app(
          new Request(new URL("/api/toolkits", request.url), { method: "GET", headers }),
        );
        return response.ok
          ? ((await response.json()) as {
              toolkits?: readonly { owner?: string; slug?: string; name?: string }[];
            })
          : null;
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  return (body?.toolkits ?? []).flatMap((toolkit) =>
    toolkit.owner === "org" && typeof toolkit.slug === "string"
      ? [{ slug: toolkit.slug, name: toolkit.name || toolkit.slug }]
      : [],
  );
};

const authorize = async (
  request: Request,
  env: CloudflareEnv & { OAUTH_PROVIDER: Helpers },
  config: CloudflareConfig,
  app: (request: Request) => Promise<Response>,
): Promise<Response> => {
  const directory = config.directory;
  const { verifyClaims } = makeAccessVerifier(config);
  const claims = await Effect.runPromise(verifyClaims(request));
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  if (!claims || !email)
    return page("<p>Sign in through Cloudflare Access first.</p>", undefined, 401);
  const helpers = env.OAUTH_PROVIDER;
  // One company org: everyone Access signs in acts there as themselves, and
  // nobody picks a tenant. Per-tenant: the directory lists the tenants to pick.
  const memberships = directory ? await Effect.runPromise(listMemberships(directory, email)) : [];
  // One company org: the workspace's agents are picked by name. Per tenant,
  // the console's list belongs to the tenant the form names, so the name is
  // typed.
  const existing = directory ? [] : await workspaceAgents(request, app);

  if (request.method === "POST") {
    const form = await request.formData();
    const tenant = directory ? String(form.get("tenant") ?? "") : config.organizationId;
    const pick = form.get("pick");
    const chosen = chosenAgent(
      { pick: typeof pick === "string" ? pick : null, typed: String(form.get("agent") ?? "") },
      existing,
    );
    const handle = String(form.get("handle") ?? "");
    if (directory && !memberships.some((m) => m.tenant.slug === tenant)) {
      return page("<p>That tenant is not one you belong to.</p>", undefined, 403);
    }
    if (!chosen) {
      return page(
        "<p>Pick an agent, or give a new one a name with at least one letter or digit.</p>",
        undefined,
        400,
      );
    }
    const agent = chosen.slug;
    const agentName = chosen.name;
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
      // Each agent a person connects through one client is its own grant;
      // connecting a second must not sign the first out.
      revokeExistingGrants: false,
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
  if (directory && memberships.length === 0) {
    return page("<p>You are not in any tenant yet. Ask a tenant owner to add you.</p>");
  }
  const consent = await helpers.beginConsent(authRequest);
  const client = await helpers.describeConsent(authRequest);
  const clientName = client.clientName ?? "This app";
  const tenants = (directory ? memberships : [])
    .map(
      (m, i) =>
        `<label><input type="radio" name="tenant" value="${escapeHtml(m.tenant.slug)}"${i === 0 ? " checked" : ""}> ${escapeHtml(m.tenant.name)}</label>`,
    )
    .join("");
  return page(
    `<h1>Connect an agent</h1>` +
      (directory
        ? `<p>${escapeHtml(clientName)} will act as you (${escapeHtml(email)}) in one tenant, as one agent, with that agent's tools only.</p>` +
          `<form method="post"><h2>Tenant</h2>${tenants}`
        : `<p>${escapeHtml(clientName)} will act as you (${escapeHtml(email)}), as one agent, with that agent's tools only.</p>` +
          `<form method="post">`) +
      (directory
        ? `<h2>Agent</h2><label>Name <input type="text" name="agent" required maxlength="63" value="${escapeHtml(clientName)}"></label>` +
          `<p class="hint">Using a name again joins that agent and its tool list. A new name starts a new agent.</p>`
        : `<h2>Agent</h2>${agentChoices(existing, clientName)}` +
          `<p class="hint">Agents belong to the workspace. Joining one gives this app that agent's tool list, run with your own sign-ins.</p>`) +
      `<input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><button type="submit">Connect</button></form>`,
    consent.headers,
  );
};

/**
 * One company org: whether the person still belongs to the company, read on
 * every call so removing them ends their agents at once. With a directory,
 * the wiki must still list them in some tenant or as an operator; which tenant
 * does not matter here. Without one, Access's sign-in is the only check.
 */
const stillListed = (config: CloudflareConfig, email: string): Effect.Effect<boolean> => {
  const directory = config.operatorDirectory;
  if (directory === null) return Effect.succeed(true);
  return listMemberships(directory, email).pipe(
    Effect.flatMap((memberships) =>
      memberships.length > 0 ? Effect.succeed(true) : isOperator(directory, email),
    ),
  );
};

/** The principal a grant acts as now, or `null` once the person left the tenant. */
export const principalForGrant = (
  grant: AgentGrant,
  config: CloudflareConfig,
): Effect.Effect<Principal | null> =>
  config.directory === null
    ? stillListed(config, grant.email).pipe(
        Effect.map((listed) =>
          listed
            ? principalFromAccessClaims(
                { sub: grant.accountId, email: grant.email, name: grant.name ?? undefined },
                config,
              )
            : null,
        ),
      )
    : resolveTenant(config.directory, grant.email, grant.tenant).pipe(
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

/** How long an unused agent sign-in lasts, in seconds. */
export const AGENT_IDLE_TTL = 7 * 86_400;

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
          const serve = await resolve(env);
          return authorize(
            request,
            env as CloudflareEnv & { OAUTH_PROVIDER: Helpers },
            config,
            serve.app,
          );
        }
        return fallback(request, env, ctx);
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // An agent stays signed in while it is used and ends after a week idle.
    // The person is re-checked on every call (membership, or Access's admin
    // list), so removing them still takes effect at once.
    refreshTokenTTL: AGENT_IDLE_TTL,
    refreshTokenIdleTTL: AGENT_IDLE_TTL,
  });
  providers.set(host, provider);
  return provider;
};
