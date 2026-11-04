import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Effect } from "effect";

import type { Principal } from "@executor-js/host-mcp";

import { makeAccessVerifier, principalFromAccessClaims } from "./auth/cloudflare-access";
import { recordPerson } from "./catalog-access";
import type { CloudflareConfig, CloudflareEnv } from "./config";
import { AGENT_SLUG, agentRequest, agentSlug, type AgentGrant } from "./agent";
import {
  ensureStartingSet,
  firstPartyIntegrations,
  STARTING_SET_SLUG,
  startWorkspace,
  teamConnectionPatterns,
  withHostExecutor,
  workspaceConnections,
} from "./new-workspace";
import { isOperator, listMemberships, resolveTenant, type TenantMembership } from "./tenancy";

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
      `<style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}label{display:block;padding:.4rem 0}input[type=text]{width:100%;padding:.4rem;box-sizing:border-box}button{margin-top:1rem;padding:.5rem 1rem}.hint{color:#666;font-size:.9rem}.warn{background:#fff4e5;border:1px solid #f0b46a;padding:.6rem .8rem;border-radius:4px}code{word-break:break-all}</style>` +
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
    const agent = existing.find(
      (candidate) => candidate.slug === form.pick && candidate.slug !== STARTING_SET_SLUG,
    );
    return agent ? { slug: agent.slug, name: agent.name } : null;
  }
  const name = form.typed.trim();
  const slug = agentSlug(name);
  // The starting set is the admins' template for new agents, never one itself.
  return AGENT_SLUG.test(slug) && slug !== STARTING_SET_SLUG ? { slug, name } : null;
};

/**
 * The agent choices: every workspace agent, then a new one named `suggested`.
 * The listed agent whose name matches `suggested` starts checked; otherwise a
 * new agent does, so connecting a new app makes a new agent unless the person
 * picks one to join. Typing a name selects the new agent.
 */
/**
 * What the sign-in page says about the address the app was given. An MCP
 * client that found Executor's MCP address names it as the OAuth `resource`;
 * one pointed at a console page (behind Access, so it can never reach the
 * server) finds no resource metadata and names none. A resource that is not
 * an MCP path is refused; a missing one is warned about, since some clients
 * never send it.
 */
export const addressCheck = (
  authorizeUrl: string,
): { readonly refuse: boolean; readonly html: string } => {
  const url = new URL(authorizeUrl);
  const mcpAddress = `${url.origin}/mcp`;
  const resource = url.searchParams.get("resource");
  const say = (text: string) =>
    `<p class="warn">${text} In your app, set the server address to <code>${escapeHtml(mcpAddress)}</code>.</p>`;
  if (resource === null || resource === "") {
    return {
      refuse: false,
      html: say(
        "Your app did not name Executor's MCP address when it sent you here, so it may be set to the wrong address and get no tools.",
      ),
    };
  }
  const parsed = URL.canParse(resource) ? new URL(resource) : null;
  if (parsed !== null && parsed.origin !== url.origin) return { refuse: false, html: "" };
  const path = parsed === null ? "" : parsed.pathname.replace(/\/+$/, "");
  if (path === "/mcp" || /^\/mcp\/toolkits\/[^/]+$/.test(path)) return { refuse: false, html: "" };
  return {
    refuse: true,
    html: say(`<code>${escapeHtml(resource)}</code> is not Executor's MCP server.`),
  };
};

export const agentChoices = (existing: readonly ExistingAgent[], suggested: string): string => {
  const match = agentSlug(suggested);
  const joinsExisting = existing.some((agent) => agent.slug === match);
  const rows = existing.map(
    (agent) =>
      `<label><input type="radio" name="pick" value="${escapeHtml(agent.slug)}"${agent.slug === match ? " checked" : ""}> ${escapeHtml(agent.name)}</label>`,
  );
  rows.push(
    `<label><input type="radio" name="pick" id="pick-new" value="${NEW_AGENT}"${joinsExisting ? "" : " checked"}> New agent named <input type="text" name="agent" maxlength="63" value="${escapeHtml(suggested)}" aria-label="New agent name" onfocus="document.getElementById('pick-new').checked=true" oninput="document.getElementById('pick-new').checked=true"></label>`,
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
    toolkit.owner === "org" &&
    typeof toolkit.slug === "string" &&
    toolkit.slug !== STARTING_SET_SLUG
      ? [{ slug: toolkit.slug, name: toolkit.name || toolkit.slug }]
      : [],
  );
};

/**
 * Make the agent's workspace toolkit as the person clicks Connect, written
 * through the app with the same Access sign-in, so the agent is in the console
 * before the client's first call. It starts with no connections: the agent's
 * settings pick each one. Best effort: the first MCP session
 * still makes it (ensureAgentToolkit) when this cannot.
 */
export const createWorkspaceAgent = async (
  request: Request,
  app: (request: Request) => Promise<Response>,
  agent: { readonly slug: string; readonly name: string },
): Promise<void> => {
  const call = (method: string, path: string, body: unknown) => {
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return app(
      new Request(new URL(path, request.url), {
        method,
        headers,
        body: JSON.stringify(body),
      }),
    );
  };
  await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        await call("POST", "/api/toolkits", {
          owner: "org",
          name: agent.name,
          slug: agent.slug,
        });
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => undefined)),
  );
};

/** The team radios for a new agent, "No team" first and checked. */
export const teamChoices = (teams: readonly TenantMembership[]): string =>
  teams.length === 0
    ? ""
    : `<h2>Team</h2><p class="hint">A new agent gets this team's Wiki and Muster. An agent you join keeps what it has.</p>` +
      [
        `<label><input type="radio" name="team" value="" checked> No team</label>`,
        ...teams.map(
          (m) =>
            `<label><input type="radio" name="team" value="${escapeHtml(m.tenant.slug)}"> ${escapeHtml(m.tenant.name)}</label>`,
        ),
      ].join("");

/**
 * Make a new agent's workspace with the starting set, and the picked team's
 * Wiki and Muster, written as the host. Falls back to an empty workspace
 * made as the person when the host cannot write it.
 */
const startAgentWorkspace = async (
  request: Request,
  env: CloudflareEnv,
  config: CloudflareConfig,
  app: (request: Request) => Promise<Response>,
  agent: { readonly slug: string; readonly name: string },
  team: TenantMembership | null,
): Promise<void> => {
  const started = await Effect.runPromise(
    withHostExecutor(env, config, (host) =>
      Effect.gen(function* () {
        yield* ensureStartingSet(host.toolkits);
        const extra = team
          ? teamConnectionPatterns(
              yield* workspaceConnections(host),
              firstPartyIntegrations(config),
              team.tenant,
            )
          : [];
        yield* startWorkspace(host.toolkits, agent, extra);
        return true;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("new agent workspace not started as the host", cause).pipe(
          Effect.as(false),
        ),
      ),
    ),
  );
  if (!started) await createWorkspaceAgent(request, app, agent);
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
  // One company org: the teams a new agent may take its Wiki and Muster from.
  const teams =
    !directory && config.operatorDirectory
      ? await Effect.runPromise(listMemberships(config.operatorDirectory, email))
      : [];

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
    if (!directory && !existing.some((candidate) => candidate.slug === agent)) {
      const teamSlug = String(form.get("team") ?? "");
      const team = teamSlug ? (teams.find((m) => m.tenant.slug === teamSlug) ?? null) : null;
      if (teamSlug && !team) {
        return page("<p>That team is not one you belong to.</p>", undefined, 403);
      }
      await startAgentWorkspace(request, env, config, app, chosen, team);
    }
    const approved = await helpers.approveConsent(request, handle);
    await Effect.runPromise(
      recordPerson(
        env.DB,
        typeof claims.sub === "string" && claims.sub ? claims.sub : email,
        email,
      ),
    );
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
  const address = addressCheck(request.url);
  if (address.refuse)
    return page(`<h1>Wrong server address</h1>${address.html}`, new Headers(), 400);
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
      address.html +
      (directory
        ? `<p>${escapeHtml(clientName)} will act as you (${escapeHtml(email)}) in one tenant, as one agent, with that agent's tools only.</p>` +
          `<form method="post"><h2>Tenant</h2>${tenants}`
        : `<p>${escapeHtml(clientName)} will act as you (${escapeHtml(email)}), as one agent, with that agent's tools only.</p>` +
          `<form method="post">`) +
      (directory
        ? `<h2>Agent</h2><label>Name <input type="text" name="agent" required maxlength="63" value="${escapeHtml(clientName)}"></label>` +
          `<p class="hint">Using a name again joins that agent and its tool list. A new name starts a new agent.</p>`
        : `<h2>Agent</h2>${agentChoices(existing, clientName)}` +
          `<p class="hint">Agents belong to the workspace. Joining one gives this app that agent's tool list, run with your own sign-ins.</p>` +
          teamChoices(teams)) +
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
    clientName?: string,
  ) => Promise<Response>;
};

/** How long an unused agent sign-in lasts, in seconds. */
export const AGENT_IDLE_TTL = 7 * 86_400;

const providers = new Map<string, OAuthProvider<CloudflareEnv>>();

/** An MCP request slower than this logs the time of each of its steps. */
const SLOW_MCP_REQUEST_MS = 1_000;

/** Registered client names by client id, per isolate. A registration's name
 *  does not change after it is made, so a hit never goes stale. */
const clientNames = new Map<string, string | null>();

/** The name the OAuth client registered with ("AI Studio", "Claude"), used to
 *  label the calls made with its tokens. */
export const registeredClientName = async (
  helpers: Helpers,
  clientId: string,
): Promise<string | undefined> => {
  if (!clientNames.has(clientId)) {
    // A failed read labels this one call with the client's own `initialize`
    // name instead, and is not remembered.
    const looked = await Effect.runPromise(
      Effect.tryPromise(() => helpers.lookupClient(clientId)).pipe(
        Effect.map((client) => ({ name: client?.clientName?.trim() || null })),
        Effect.orElseSucceed(() => null),
      ),
    );
    if (looked === null) return undefined;
    if (clientNames.size >= 1_000) clientNames.clear();
    clientNames.set(clientId, looked.name);
  }
  return clientNames.get(clientId) ?? undefined;
};

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
        // Wall time of each step before and of the MCP answer, logged when
        // the whole request is slow, so a slow start can be attributed.
        const started = Date.now();
        const principal = await Effect.runPromise(principalForGrant(grant, config));
        if (!principal) return unauthorized();
        const checked = Date.now();
        const serve = await resolve(env);
        const resolved = Date.now();
        const clientName = await registeredClientName(
          (env as CloudflareEnv & { OAUTH_PROVIDER: Helpers }).OAUTH_PROVIDER,
          grant.clientId,
        );
        const named = Date.now();
        const response = await serve.mcp(
          agentRequest(request, grant.agent),
          env,
          ctx,
          principal,
          clientName,
        );
        const answered = Date.now();
        if (answered - started > SLOW_MCP_REQUEST_MS) {
          console.log(
            "[executor] MCP request ms",
            JSON.stringify({
              agent: grant.agent,
              principal: checked - started,
              resolve: resolved - checked,
              clientName: named - resolved,
              mcp: answered - named,
            }),
          );
        }
        return response;
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
