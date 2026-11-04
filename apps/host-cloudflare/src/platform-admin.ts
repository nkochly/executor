import { Effect, Option, Schema } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import type { CloudflareConfig, CloudflareEnv } from "./config";
import {
  ensureStartingSet,
  STARTING_SET_SLUG,
  withExecutorAs,
  withHostExecutor,
  workspaceConnections,
} from "./new-workspace";

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
}

/**
 * The connections a workspace may pick, one per pattern, named by the
 * server's title when it gives one.
 */
export const pickables = (
  tools: readonly ToolView[],
  integrationNames: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
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

const decodePick = Schema.decodeUnknownOption(PickBody);
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

/**
 * `/api/platform/admin/*` for a platform admin signed in as `admin`. `null`
 * when the path is not one.
 */
export const handlePlatformAdmin = async (
  request: Request,
  env: CloudflareEnv,
  config: CloudflareConfig,
  admin: { readonly subject: string },
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

  if (route === "GET /workspaces") {
    return run(
      Effect.gen(function* () {
        const tools = yield* asAdmin((executor) => listTools(executor));
        const { workspaces, titles, names } = yield* withHostExecutor(env, config, (host) =>
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
                patterns: connections.map((connection) => connection.pattern),
                updatedAt: toolkit.updatedAt,
              });
            }
            const titles = new Map(
              (yield* workspaceConnections(host)).flatMap((connection) =>
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
            return { workspaces, titles, names };
          }),
        );
        workspaces.sort(
          (a, b) => Number(b.startingSet) - Number(a.startingSet) || a.name.localeCompare(b.name),
        );
        return {
          consolePath: `/${config.organizationSlug}/toolkits`,
          workspaces,
          connections: pickables(tools, names, titles),
        };
      }),
    );
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
