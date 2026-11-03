import { Effect } from "effect";

// An agent is one workspace toolkit. The person who connects it is who it acts
// as; the toolkit says which tools it has.

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
    readonly { readonly id: string; readonly slug: string; readonly owner: "user" | "org" }[],
    unknown
  >;
  readonly create: (input: {
    readonly owner: "user" | "org";
    readonly name: string;
    readonly slug: string;
  }) => Effect.Effect<{ readonly id: string }, unknown>;
  readonly remove: (toolkitId: string) => Effect.Effect<unknown, unknown>;
  readonly listConnections: (
    toolkitId: string,
  ) => Effect.Effect<readonly { readonly pattern: string; readonly position: string }[], unknown>;
  readonly createConnection: (
    toolkitId: string,
    input: { readonly pattern: string; readonly position?: string },
  ) => Effect.Effect<unknown, unknown>;
  readonly listPolicies: (toolkitId: string) => Effect.Effect<
    readonly {
      readonly pattern: string;
      readonly action: "approve" | "require_approval" | "block";
      readonly position: string;
    }[],
    unknown
  >;
  readonly createPolicy: (
    toolkitId: string,
    input: {
      readonly pattern: string;
      readonly action: "approve" | "require_approval" | "block";
      readonly position?: string;
    },
  ) => Effect.Effect<unknown, unknown>;
};

/**
 * The agent's workspace toolkit exists once this returns; a lost race keeps
 * the winner's. Every agent is the workspace's, never someone's personal one:
 * whoever connects under that name joins the same agent and tool list, and
 * each person's picks of personal connections run as their own sign-ins.
 *
 * A personal toolkit the caller made earlier under the name moves to the
 * workspace with its connections and rules, so nothing they picked is lost.
 */
export const ensureAgentToolkit = (toolkits: AgentToolkits, slug: string) =>
  Effect.gen(function* () {
    const existing = (yield* toolkits.list()).filter((toolkit) => toolkit.slug === slug);
    if (existing.some((toolkit) => toolkit.owner === "org")) return;
    const personal = existing.find((toolkit) => toolkit.owner === "user");
    if (!personal) {
      const created = yield* toolkits.create({ owner: "org", name: slug, slug });
      yield* toolkits.createConnection(created.id, { pattern: "*" });
      return;
    }
    const connections = yield* toolkits.listConnections(personal.id);
    const policies = yield* toolkits.listPolicies(personal.id);
    // The slug is unique among visible toolkits, so the personal one goes first.
    yield* toolkits.remove(personal.id);
    const created = yield* toolkits.create({ owner: "org", name: slug, slug });
    for (const connection of connections) {
      yield* toolkits.createConnection(created.id, {
        pattern: connection.pattern,
        position: connection.position,
      });
    }
    for (const policy of policies) {
      yield* toolkits.createPolicy(created.id, {
        pattern: policy.pattern,
        action: policy.action,
        position: policy.position,
      });
    }
  }).pipe(Effect.ignore);
