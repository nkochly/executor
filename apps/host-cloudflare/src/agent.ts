import { Effect } from "effect";

// An agent is one toolkit in a tenant, owned by the person who connected it.

/** What an Executor token carries. */
export interface AgentGrant {
  readonly accountId: string;
  readonly email: string;
  readonly name: string | null;
  readonly tenant: string;
  /** The agent's toolkit slug in the tenant. */
  readonly agent: string;
  /** The agent's display name, as the person typed it. */
  readonly agentName: string;
  /** The registered OAuth client the token was issued to. */
  readonly clientId: string;
}

export const AGENT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const agentSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/** The request as the agent's toolkit route, whatever path the client used. */
export const agentRequest = (request: Request, agent: string): Request => {
  const url = new URL(request.url);
  url.pathname = `/mcp/toolkits/${encodeURIComponent(agent)}`;
  return new Request(url, request);
};

type AgentToolkits = {
  readonly list: () => Effect.Effect<
    readonly { readonly id: string; readonly slug: string }[],
    unknown
  >;
  readonly create: (input: {
    readonly owner: "user" | "org";
    readonly name: string;
    readonly slug: string;
  }) => Effect.Effect<{ readonly id: string }, unknown>;
  readonly createConnection: (
    toolkitId: string,
    input: { readonly pattern: string },
  ) => Effect.Effect<unknown, unknown>;
};

/**
 * The agent's toolkit exists once this returns; a lost race keeps the winner's.
 * A tenant admin's first connect makes it the tenant's, so everyone who connects
 * under that name shares one agent and one tool list. A member's first connect
 * makes a personal one.
 */
export const ensureAgentToolkit = (toolkits: AgentToolkits, slug: string, admin = false) =>
  Effect.gen(function* () {
    const existing = yield* toolkits.list();
    if (existing.some((toolkit) => toolkit.slug === slug)) return;
    const created = yield* toolkits.create({ owner: admin ? "org" : "user", name: slug, slug });
    yield* toolkits.createConnection(created.id, { pattern: "*" });
  }).pipe(Effect.ignore);
