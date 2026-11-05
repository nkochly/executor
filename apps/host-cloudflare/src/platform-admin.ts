import { Effect, Option, Schema } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import { handleCatalogAdmin } from "./catalog-admin";
import type { CloudflareConfig, CloudflareEnv } from "./config";
import { AGENT_SLUG, agentSlug } from "./agent";
import {
  ensureStartingSet,
  firstPartyIntegrations,
  STARTING_SET_SLUG,
  startWorkspace,
  teamConnectionPatterns,
  withExecutorAs,
  withHostExecutor,
  workspaceConnections,
} from "./new-workspace";
import {
  parsePeople,
  readWorkspacePeople,
  setWorkspacePeople,
  teamsFromConnections,
} from "./workspace-people";

// ---------------------------------------------------------------------------
// The admin page's data: every agent workspace against every connection it
// may pick (the starting set first), and the company-wide setting of each
// tool. Platform admins only; the caller checks that first.
//
// Workspace changes are written as the host. Company-wide tool settings are
// the org's tool rules, written as the admin: Show approves, Ask first asks
// before each call, Hidden removes the tool from every agent's list and
// refuses it, and Same as server removes a tool's own rule. A tool's own rule
// wins over its server's.
// ---------------------------------------------------------------------------

export type Setting = "show" | "ask" | "hide";

const ACTION: Record<Setting, "approve" | "require_approval" | "block"> = {
  show: "approve",
  ask: "require_approval",
  hide: "block",
};

const SETTING: Record<string, Setting> = {
  approve: "show",
  require_approval: "ask",
  block: "hide",
};

/** One tool as a workspace and a tool rule see it. */
export interface ToolView {
  readonly static?: boolean;
  readonly address: string;
  readonly owner: string;
  readonly integration: string;
  readonly connection: string;
  readonly name: string;
  readonly description: string;
}

/** The id tool rules match: a dynamic tool's address without `tools.`. */
export const toolMatchId = (tool: ToolView): string =>
  tool.static ? tool.address : tool.address.replace(/^tools\./, "");

/** The pattern a workspace picks a tool's connection by. */
export const connectionPattern = (tool: ToolView): string => {
  const id = toolMatchId(tool);
  // Executor's own tools come from no connection; they are picked together.
  if (tool.static) return `${id.split(".").slice(0, 2).join(".")}.*`;
  const owned = `${tool.integration}.${tool.owner}.${tool.connection}`;
  if (tool.connection && (id === owned || id.startsWith(`${owned}.`))) return `${owned}.*`;
  return id.endsWith(`.${tool.name}`)
    ? `${id.slice(0, -tool.name.length - 1)}.*`
    : `${id.split(".").slice(0, -1).join(".")}.*`;
};

/** The company-wide rule pattern for one tool, on every connection, or a whole server. */
export const toolRulePattern = (integration: string, tool: ToolView | null): string => {
  if (tool === null) return `${integration}.*`;
  return tool.static ? toolMatchId(tool) : `${integration}.*.*.${tool.name}`;
};

const STATIC_NAMES: Readonly<Record<string, string>> = {
  coreTools: "Executor tools",
  mcp: "Executor tools for adding MCP servers",
  openapi: "Executor tools for adding OpenAPI APIs",
  graphql: "Executor tools for adding GraphQL APIs",
};

/** Executor's own tools, named by the plugin that serves them. */
const staticLabel = (pattern: string): string => {
  const group = pattern.split(".")[1] ?? "";
  return STATIC_NAMES[group] ?? `Executor tools (${group})`;
};

/** One column of the workspace grid. */
export interface Pickable {
  readonly pattern: string;
  readonly label: string;
  readonly personal: boolean;
  /** A team's own connection to a first-party server; the team pick adds it. */
  readonly team: boolean;
}

/**
 * The connections a workspace may pick, one per pattern, named by the
 * server's title when it gives one.
 */
export const pickables = (
  tools: readonly ToolView[],
  integrationNames: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
  teamIntegrations: readonly string[] = [],
): readonly Pickable[] => {
  const seen = new Map<string, Pickable>();
  for (const tool of tools) {
    const pattern = connectionPattern(tool);
    if (seen.has(pattern)) continue;
    const server = integrationNames.get(tool.integration) ?? tool.integration;
    const title = titles.get(`${tool.integration}.${tool.connection}`);
    const personal = !tool.static && tool.owner === "user";
    seen.set(pattern, {
      pattern,
      label: tool.static
        ? staticLabel(pattern)
        : title
          ? title
          : personal
            ? `${server} (each person's own)`
            : `${server} · ${tool.connection}`,
      personal,
      team: !tool.static && !personal && teamIntegrations.includes(tool.integration),
    });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const readBody = (request: Request) =>
  Effect.runPromise(
    Effect.tryPromise({ try: () => request.json(), catch: () => "invalid" as const }).pipe(
      Effect.orElseSucceed(() => null),
    ),
  );

const PickBody = Schema.Struct({
  workspace: Schema.String,
  pattern: Schema.String,
  on: Schema.Boolean,
});
const SettingBody = Schema.Struct({
  integration: Schema.String,
  tool: Schema.NullOr(Schema.String),
  setting: Schema.Literals(["inherit", "show", "ask", "hide"]),
});

const NewWorkspaceBody = Schema.Struct({
  name: Schema.String,
  team: Schema.optional(Schema.NullOr(Schema.String)),
  people: Schema.Array(Schema.String),
});
const WorkspacePeopleBody = Schema.Struct({
  slug: Schema.String,
  people: Schema.Array(Schema.String),
});

const decodePick = Schema.decodeUnknownOption(PickBody);
const decodeNewWorkspace = Schema.decodeUnknownOption(NewWorkspaceBody);
const decodeWorkspacePeople = Schema.decodeUnknownOption(WorkspacePeopleBody);
const decodeSetting = Schema.decodeUnknownOption(SettingBody);

const listTools = (executor: {
  readonly tools: {
    readonly list: (filter?: {
      readonly includeBlocked?: boolean;
      readonly includeAnnotations?: boolean;
    }) => Effect.Effect<readonly unknown[], unknown>;
  };
}): Effect.Effect<readonly ToolView[], unknown> =>
  executor.tools.list({ includeBlocked: true, includeAnnotations: false }).pipe(
    Effect.map((rows) =>
      (
        rows as readonly {
          static?: boolean;
          address: unknown;
          owner: unknown;
          integration: unknown;
          connection: unknown;
          name: unknown;
          description?: unknown;
        }[]
      ).map((row) => ({
        static: row.static === true,
        address: String(row.address),
        owner: String(row.owner),
        integration: String(row.integration),
        connection: String(row.connection ?? ""),
        name: String(row.name),
        description: String(row.description ?? ""),
      })),
    ),
  );

const decodeGrant = Schema.decodeUnknownOption(
  Schema.Struct({
    userId: Schema.String,
    metadata: Schema.Struct({ agent: Schema.String }),
  }),
);

/** The part of the OAuth store the people lookup reads. */
export interface GrantStore {
  readonly list: (options: { readonly prefix: string; readonly cursor?: string }) => Promise<
    | { readonly keys: readonly { readonly name: string }[]; readonly list_complete: true }
    | {
        readonly keys: readonly { readonly name: string }[];
        readonly list_complete: false;
        readonly cursor: string;
      }
  >;
  readonly get: (name: string, type: "json") => Promise<unknown>;
}

/** The most sign-ins read per page load; past it, the rest show no person. */
const MAX_GRANT_READS = 500;

/**
 * The people who connected each agent, by agent slug: every Executor sign-in
 * (an OAuth grant) names its person and the agent it was for.
 */
export const agentPeople = async (
  kv: GrantStore | undefined,
): Promise<Map<string, readonly string[]>> => {
  const people = new Map<string, Set<string>>();
  if (!kv) return new Map();
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "grant:", cursor });
    for (const key of page.keys) names.push(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < MAX_GRANT_READS);
  const grants = await Promise.all(
    names.slice(0, MAX_GRANT_READS).map((name) => kv.get(name, "json").then(decodeGrant)),
  );
  for (const grant of grants) {
    if (Option.isNone(grant)) continue;
    const agent = grant.value.metadata.agent;
    const email = decodeURIComponent(grant.value.userId);
    const set = people.get(agent) ?? new Set<string>();
    set.add(email);
    people.set(agent, set);
  }
  return new Map([...people].map(([agent, set]) => [agent, [...set].sort()]));
};

/**
 * `/api/platform/admin/*` for a platform admin signed in as `admin`. `null`
 * when the path is not one.
 */
export const handlePlatformAdmin = async (
  request: Request,
  env: CloudflareEnv,
  config: CloudflareConfig,
  admin: { readonly subject: string; readonly email: string },
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  const base = "/api/platform/admin";
  if (!pathname.startsWith(`${base}/`)) return null;
  const route = `${request.method} ${pathname.slice(base.length)}`;
  // What the admin sees is what the grid offers: the workspace's own
  // connections and the admin's personal ones, which every person has by name.
  const asAdmin = <A>(use: Parameters<typeof withHostExecutor<A>>[2]) =>
    withExecutorAs(env, config, admin.subject, use);
  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.map((body) => json(body)),
        Effect.catchCause((cause) =>
          Effect.logWarning("platform admin request failed", cause).pipe(
            Effect.as(json({ error: "That did not work. Try again." }, 500)),
          ),
        ),
      ),
    );

  const catalog = await handleCatalogAdmin(route, request, env, config);
  if (catalog) return catalog;

  if (route === "GET /workspaces") {
    return run(
      Effect.gen(function* () {
        const tools = yield* asAdmin((executor) => listTools(executor));
        const people = yield* Effect.tryPromise(() => agentPeople(env.OAUTH_KV));
        const assigned = yield* Effect.tryPromise(() => readWorkspacePeople(env.DB));
        const { workspaces, titles, names, teams } = yield* withHostExecutor(env, config, (host) =>
          Effect.gen(function* () {
            yield* ensureStartingSet(host.toolkits);
            const list = (yield* host.toolkits.list()).filter((toolkit) => toolkit.owner === "org");
            const workspaces = [];
            for (const toolkit of list) {
              const connections = yield* host.toolkits.listConnections(toolkit.id);
              workspaces.push({
                id: toolkit.id,
                slug: toolkit.slug,
                name: toolkit.name,
                startingSet: toolkit.slug === STARTING_SET_SLUG,
                people: people.get(toolkit.slug) ?? [],
                setUpFor: assigned.get(toolkit.slug) ?? [],
                patterns: connections.map((connection) => connection.pattern),
                updatedAt: toolkit.updatedAt,
              });
            }
            const shared = yield* workspaceConnections(host);
            const teams = teamsFromConnections(shared, firstPartyIntegrations(config));
            const titles = new Map(
              shared.flatMap((connection) =>
                connection.title
                  ? [[`${connection.integration}.${connection.name}`, connection.title] as const]
                  : [],
              ),
            );
            const names = new Map(
              (yield* host.integrations.list()).map(
                (integration) => [String(integration.slug), integration.name] as const,
              ),
            );
            return { workspaces, titles, names, teams };
          }),
        );
        workspaces.sort(
          (a, b) => Number(b.startingSet) - Number(a.startingSet) || a.name.localeCompare(b.name),
        );
        return {
          consolePath: `/${config.organizationSlug}/toolkits`,
          me: admin.email,
          teams,
          workspaces,
          connections: pickables(tools, names, titles, firstPartyIntegrations(config)),
        };
      }),
    );
  }

  if (route === "POST /workspaces") {
    const body = decodeNewWorkspace(await readBody(request));
    if (Option.isNone(body)) return json({ error: "Give the workspace a name." }, 400);
    const name = body.value.name.trim();
    const slug = agentSlug(name);
    if (!AGENT_SLUG.test(slug) || slug === STARTING_SET_SLUG) {
      return json({ error: "Give the workspace a name with at least one letter or digit." }, 400);
    }
    const team = body.value.team?.trim() ?? "";
    const result = await Effect.runPromise(
      withHostExecutor(env, config, (host) =>
        Effect.gen(function* () {
          yield* ensureStartingSet(host.toolkits);
          const taken = (yield* host.toolkits.list()).some((toolkit) => toolkit.slug === slug);
          if (taken) return "taken" as const;
          const extra = team
            ? teamConnectionPatterns(
                yield* workspaceConnections(host),
                firstPartyIntegrations(config),
                { slug: team, name: team },
              )
            : [];
          yield* startWorkspace(host.toolkits, { slug, name }, extra);
          return "made" as const;
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("admin new workspace failed", cause).pipe(Effect.as("failed" as const)),
        ),
      ),
    );
    if (result === "taken") {
      return json({ error: `There is already a workspace named like "${name}".` }, 409);
    }
    if (result === "failed") return json({ error: "That did not work. Try again." }, 500);
    await setWorkspacePeople(env.DB, slug, body.value.people);
    return json({ ok: true, slug });
  }

  if (route === "POST /workspaces/people") {
    const body = decodeWorkspacePeople(await readBody(request));
    if (Option.isNone(body) || !AGENT_SLUG.test(body.value.slug)) {
      return json({ error: "Name a workspace." }, 400);
    }
    await setWorkspacePeople(env.DB, body.value.slug, body.value.people);
    return json({ ok: true, people: parsePeople(body.value.people) });
  }

  if (route === "POST /workspaces/connection") {
    const body = decodePick(await readBody(request));
    if (Option.isNone(body)) return json({ error: "Name a workspace and a connection." }, 400);
    const { workspace, pattern, on } = body.value;
    return run(
      withHostExecutor(env, config, (host) =>
        Effect.gen(function* () {
          const connections = yield* host.toolkits.listConnections(workspace);
          const existing = connections.find((connection) => connection.pattern === pattern);
          if (on && !existing) yield* host.toolkits.createConnection(workspace, { pattern });
          if (!on && existing) yield* host.toolkits.removeConnection(workspace, existing.id);
          return { ok: true };
        }),
      ),
    );
  }

  if (route === "GET /tools") {
    return run(
      asAdmin((executor) =>
        Effect.gen(function* () {
          const tools = yield* listTools(executor);
          const rules = (yield* executor.policies.list()).filter((rule) => rule.owner === "org");
          const ruleFor = (pattern: string): Setting | null => {
            const rule = rules.find((candidate) => candidate.pattern === pattern);
            return rule ? (SETTING[rule.action] ?? null) : null;
          };
          const names = new Map(
            (yield* executor.integrations.list()).map(
              (integration) => [String(integration.slug), integration.name] as const,
            ),
          );
          const servers = new Map<
            string,
            { name: string; setting: Setting | null; tools: Map<string, unknown> }
          >();
          for (const tool of tools) {
            const server = servers.get(tool.integration) ?? {
              name: tool.static
                ? "Executor tools"
                : (names.get(tool.integration) ?? tool.integration),
              setting: ruleFor(toolRulePattern(tool.integration, null)),
              tools: new Map(),
            };
            servers.set(tool.integration, server);
            if (!server.tools.has(tool.name)) {
              server.tools.set(tool.name, {
                name: tool.name,
                description: tool.description.split("\n")[0]?.slice(0, 160) ?? "",
                setting: ruleFor(toolRulePattern(tool.integration, tool)),
              });
            }
          }
          return {
            servers: [...servers]
              .map(([integration, server]) => ({
                integration,
                name: server.name,
                setting: server.setting,
                tools: [...server.tools.values()],
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        }),
      ),
    );
  }

  if (route === "POST /tools") {
    const body = decodeSetting(await readBody(request));
    if (Option.isNone(body)) return json({ error: "Name a server and a setting." }, 400);
    const { integration, tool, setting } = body.value;
    return run(
      asAdmin((executor) =>
        Effect.gen(function* () {
          const tools = yield* listTools(executor);
          const target =
            tool === null
              ? null
              : (tools.find((row) => row.integration === integration && row.name === tool) ?? null);
          if (tool !== null && target === null) return { error: "No such tool." };
          const pattern = toolRulePattern(integration, target);
          const orgRules = (yield* executor.policies.list()).filter((rule) => rule.owner === "org");
          const existing = orgRules.filter((rule) => rule.pattern === pattern);
          if (setting === "inherit") {
            for (const rule of existing)
              yield* executor.policies.remove({ id: rule.id, owner: "org" });
            return { ok: true };
          }
          const [first, ...rest] = existing;
          for (const rule of rest) yield* executor.policies.remove({ id: rule.id, owner: "org" });
          if (first) {
            yield* executor.policies.update({
              id: first.id,
              owner: "org",
              action: ACTION[setting],
            });
          } else if (tool === null) {
            // A server's rule goes under every tool rule, so a tool's own
            // setting wins over its server's.
            const last = orgRules
              .map((rule) => rule.position)
              .sort()
              .at(-1);
            yield* executor.policies.create({
              owner: "org",
              pattern,
              action: ACTION[setting],
              position: generateKeyBetween(last ?? null, null),
            });
          } else {
            yield* executor.policies.create({ owner: "org", pattern, action: ACTION[setting] });
          }
          return { ok: true };
        }),
      ),
    );
  }

  return json({ error: "Not found" }, 404);
};
