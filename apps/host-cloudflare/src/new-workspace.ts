import { Effect } from "effect";

import { TENANT_DEFAULTS_SUBJECT } from "@executor-js/api/server";

import type { CloudflareConfig, CloudflareEnv } from "./config";
import { createD1ExecutorDb } from "./db/d1";
import { makeCloudflareExecutionStackLayer, makeExecutionStack } from "./execution";
import type { CloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// What a new agent's workspace starts with. Admins keep one workspace, the
// starting set, like any other in the console; each new agent's workspace
// gets a copy of its connections and tool rules once, when it is made. Later
// changes to the starting set leave existing workspaces alone.
//
// A team picked at sign-in adds that team's Workspace connections to the
// first-party servers (Wiki, Muster), the ones whose title names the team.
// Without a pick the workspace gets none of them.
//
// The copy is written as the host, not as the person signing in: only admins
// change a workspace, and making one with what an admin chose is not the
// person's change.
// ---------------------------------------------------------------------------

/** The starting set's slug; never an agent. */
export const STARTING_SET_SLUG = "new-workspaces";
export const STARTING_SET_NAME = "New workspaces start with";

type Policy = {
  readonly pattern: string;
  readonly action: "approve" | "require_approval" | "block";
  readonly position: string;
};

export type WorkspaceToolkits = {
  readonly list: () => Effect.Effect<
    readonly { readonly id: string; readonly slug: string; readonly owner: "user" | "org" }[],
    unknown
  >;
  readonly create: (input: {
    readonly owner: "user" | "org";
    readonly name: string;
    readonly slug: string;
  }) => Effect.Effect<{ readonly id: string }, unknown>;
  readonly listConnections: (
    toolkitId: string,
  ) => Effect.Effect<readonly { readonly pattern: string; readonly position: string }[], unknown>;
  readonly createConnection: (
    toolkitId: string,
    input: { readonly pattern: string; readonly position?: string },
  ) => Effect.Effect<unknown, unknown>;
  readonly listPolicies: (toolkitId: string) => Effect.Effect<readonly Policy[], unknown>;
  readonly createPolicy: (
    toolkitId: string,
    input: Omit<Policy, "position"> & { readonly position?: string },
  ) => Effect.Effect<unknown, unknown>;
};

/** A connection as the starting set needs it. */
export interface WorkspaceConnection {
  readonly owner: string;
  readonly integration: string;
  readonly name: string;
  /** The server's own title for it, such as "Muster · team-eichten". */
  readonly title: string | null;
}

const teamKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/**
 * The patterns for a team's Workspace connections to the first-party servers:
 * each one whose title ends with the team's slug or name. A first-party
 * server names one tenant per connection, in its title after " · ".
 */
export const teamConnectionPatterns = (
  connections: readonly WorkspaceConnection[],
  firstPartyIntegrations: readonly string[],
  team: { readonly slug: string; readonly name: string },
): readonly string[] => {
  const keys = new Set([teamKey(team.slug), teamKey(team.name)]);
  return connections
    .filter((connection) => {
      if (connection.owner !== "org") return false;
      if (!firstPartyIntegrations.includes(connection.integration)) return false;
      const suffix = connection.title?.split(" · ").at(-1);
      return suffix !== undefined && connection.title!.includes(" · ") && keys.has(teamKey(suffix));
    })
    .map((connection) => `${connection.integration}.org.${connection.name}.*`);
};

/**
 * Make the agent's workspace with the starting set's connections and rules,
 * plus `extraConnections`. Does nothing when the workspace exists already, or
 * when `slug` is the starting set itself.
 */
export const startWorkspace = (
  toolkits: WorkspaceToolkits,
  agent: { readonly slug: string; readonly name: string },
  extraConnections: readonly string[] = [],
) =>
  Effect.gen(function* () {
    if (agent.slug === STARTING_SET_SLUG) return;
    const all = yield* toolkits.list();
    if (all.some((toolkit) => toolkit.slug === agent.slug && toolkit.owner === "org")) return;
    const template = all.find(
      (toolkit) => toolkit.slug === STARTING_SET_SLUG && toolkit.owner === "org",
    );
    const created = yield* toolkits.create({ owner: "org", name: agent.name, slug: agent.slug });
    if (template) {
      for (const connection of yield* toolkits.listConnections(template.id)) {
        yield* toolkits.createConnection(created.id, {
          pattern: connection.pattern,
          position: connection.position,
        });
      }
      for (const policy of yield* toolkits.listPolicies(template.id)) {
        yield* toolkits.createPolicy(created.id, policy);
      }
    }
    for (const pattern of extraConnections) {
      yield* toolkits.createConnection(created.id, { pattern });
    }
  });

/** Make the starting set, empty, if no admin has made it yet. */
export const ensureStartingSet = (toolkits: WorkspaceToolkits) =>
  Effect.gen(function* () {
    const all = yield* toolkits.list();
    if (all.some((toolkit) => toolkit.slug === STARTING_SET_SLUG && toolkit.owner === "org"))
      return;
    yield* toolkits.create({ owner: "org", name: STARTING_SET_NAME, slug: STARTING_SET_SLUG });
  });

/** The integration slugs the first-party servers are added under. */
export const firstPartyIntegrations = (config: CloudflareConfig): readonly string[] =>
  config.firstParty.map((server) => server.slug.replaceAll("-", "_"));

type HostExecutor = Effect.Success<
  ReturnType<typeof makeExecutionStack<CloudflarePlugins>>
>["executor"];

/**
 * Run `use` with an executor in the company org acting as `subject`, allowed
 * to write workspace rows. Only for a subject already checked to be allowed:
 * the host itself, or a platform admin.
 */
export const withExecutorAs = <A>(
  env: CloudflareEnv,
  config: CloudflareConfig,
  subject: string,
  use: (executor: HostExecutor) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.gen(function* () {
    const dbHandle = yield* Effect.tryPromise(() => createD1ExecutorDb(env.DB, env.BLOBS));
    const { executor } = yield* makeExecutionStack<CloudflarePlugins>(
      subject,
      config.organizationId,
      config.organizationName,
      { orgWrites: "allowed" },
    ).pipe(Effect.provide(makeCloudflareExecutionStackLayer(config, dbHandle, env.DB)));
    return yield* use(executor);
  });

/**
 * Run `use` with an executor acting as the host in the company org, which may
 * write workspace rows a member could not.
 */
export const withHostExecutor = <A>(
  env: CloudflareEnv,
  config: CloudflareConfig,
  use: (executor: HostExecutor) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> => withExecutorAs(env, config, TENANT_DEFAULTS_SUBJECT, use);

/** The Workspace connections, with each one's server title when it has one. */
export const workspaceConnections = (executor: {
  readonly connections: {
    readonly list: (filter?: { readonly owner?: "org" | "user" }) => Effect.Effect<
      readonly {
        readonly owner: unknown;
        readonly integration: unknown;
        readonly name: unknown;
        readonly lastHealth?: {
          readonly status: string;
          readonly identity?: string | null;
        } | null;
      }[],
      unknown
    >;
  };
}): Effect.Effect<readonly WorkspaceConnection[], unknown> =>
  executor.connections.list({ owner: "org" }).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        owner: String(row.owner),
        integration: String(row.integration),
        name: String(row.name),
        title:
          row.lastHealth?.status === "healthy" && row.lastHealth.identity
            ? row.lastHealth.identity.trim()
            : null,
      })),
    ),
  );
