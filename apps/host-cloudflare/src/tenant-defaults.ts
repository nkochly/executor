import type { D1Database } from "@cloudflare/workers-types";
import { Effect } from "effect";

import type { HostConfigShape } from "@executor-js/api/server";
import { IntegrationSlug, type Executor } from "@executor-js/sdk";

import type { CloudflareConfig } from "./config";
import type { CloudflarePlugins } from "./plugins";
import { WEBEX_SERVERS, webexOAuthClients } from "./webex";

// ---------------------------------------------------------------------------
// Servers every tenant has without anyone adding them. Each person connects
// their own account; nobody in the tenant has to add the server or approve its
// tools first. They are the company's own servers (FIRST_PARTY_MCP: wiki,
// Muster and the rest), then Webex's once the company's Webex integration
// holds real values.
//
// Each server is added to a tenant once, ever (`tenant_default` in D1 records
// it), with its tools approved except the ones that delete or remove. After
// that the tenant's admins own it: their changes stand, and a server they
// remove stays removed.
// ---------------------------------------------------------------------------

const SCHEMA = `CREATE TABLE IF NOT EXISTS tenant_default (
  tenant TEXT NOT NULL,
  item TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (tenant, item)
)`;

interface DefaultServer {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly endpoint: string;
  /** Tool ids (sanitized MCP tool names) the server's tools stay blocked for. */
  readonly blocked: readonly string[];
}

const WEBEX_BLOCKED: Readonly<Record<string, readonly string[]>> = {
  "webex-meetings": ["webex_delete_meeting"],
  "webex-messaging": ["webex_delete_message", "webex_delete_space", "webex_remove_membership"],
};

const webexDefaults = (): readonly DefaultServer[] =>
  WEBEX_SERVERS.map((server) => ({ ...server, blocked: WEBEX_BLOCKED[server.slug] ?? [] }));

const firstPartyDefaults = (config: CloudflareConfig): readonly DefaultServer[] =>
  config.firstParty.map((server) => ({
    slug: server.slug,
    name: server.name,
    summary: `${server.name}, as yourself. Each sign-in picks one tenant; connect it again for another.`,
    endpoint: server.endpoint,
    blocked: [],
  }));

/** The name the console gives a server added by URL: its host. */
const hostOf = (endpoint: string): string | null =>
  URL.canParse(endpoint) ? new URL(endpoint).host : null;

/** The integration slug the console gives a catalog server: its slug with underscores. */
export const integrationSlugFor = (slug: string): string => slug.replaceAll("-", "_");

/** The org policy rows a default server starts with, in the order they are created. */
export const defaultPolicies = (server: Pick<DefaultServer, "slug" | "blocked">) => {
  const integration = integrationSlugFor(server.slug);
  // Each new row takes the top of the list, so the blocks, created last, win
  // over the approval.
  return [
    { pattern: `${integration}.*`, action: "approve" as const },
    ...server.blocked.map((tool) => ({
      pattern: `${integration}.*.*.${tool}`,
      action: "block" as const,
    })),
  ];
};

/**
 * A server added by URL carries the URL's host as its name and description;
 * give it the server's own. A name an admin chose stands.
 */
const renameHostNamed = (executor: Executor, server: DefaultServer): Effect.Effect<void, unknown> =>
  executor.integrations.get(IntegrationSlug.make(integrationSlugFor(server.slug))).pipe(
    Effect.flatMap((existing) =>
      existing && existing.name === hostOf(server.endpoint)
        ? executor.integrations.update(existing.slug, {
            name: server.name,
            description: server.summary,
          })
        : Effect.void,
    ),
  );

const seed = (executor: Executor, server: DefaultServer): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    // oxlint-disable-next-line executor/no-double-cast -- boundary: the host seam erases the plugin tuple; this host's executors always carry its plugins
    const mcp = (executor as unknown as Executor<CloudflarePlugins>).mcp;
    yield* mcp
      .addServer({
        transport: "remote",
        name: server.name,
        description: server.summary,
        endpoint: server.endpoint,
        slug: integrationSlugFor(server.slug),
        auth: { kind: "oauth2" },
      })
      .pipe(
        Effect.catchTag("IntegrationAlreadyExistsError", () => renameHostNamed(executor, server)),
      );
    for (const rule of defaultPolicies(server)) {
      yield* executor.policies.create({ owner: "org", ...rule });
    }
  });

/** The host's `tenantDefaults`, or none when there is nothing to add. */
export const makeTenantDefaults = (
  db: D1Database,
  config: CloudflareConfig,
): HostConfigShape["tenantDefaults"] => {
  if (config.webex === null && config.firstParty.length === 0) return undefined;
  // Tenants this host config has already brought up to date.
  const settled = new Set<string>();
  return (tenant, seeder) =>
    Effect.gen(function* () {
      if (settled.has(tenant)) return;
      const webexReady =
        config.webex !== null &&
        (yield* Effect.promise(() => webexOAuthClients(config))).length > 0;
      const defaults = [...firstPartyDefaults(config), ...(webexReady ? webexDefaults() : [])];
      if (defaults.length === 0) return;
      yield* Effect.tryPromise(() => db.prepare(SCHEMA).run());
      const rows = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT item FROM tenant_default WHERE tenant = ?")
          .bind(tenant)
          .all<{ item: string }>(),
      );
      const done = new Set(rows.results.map((row) => row.item));
      const missing = defaults.filter((server) => !done.has(server.slug));
      const executor = yield* seeder();
      // A tenant admin can remove a default and add it back from the catalog
      // by URL; it then needs its name again, so this runs every time.
      for (const server of defaults.filter((server) => done.has(server.slug))) {
        yield* renameHostNamed(executor, server);
      }
      if (missing.length > 0) {
        for (const server of missing) {
          yield* seed(executor, server);
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "INSERT INTO tenant_default (tenant, item, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
              )
              .bind(tenant, server.slug, Date.now())
              .run(),
          );
        }
      }
      settled.add(tenant);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("tenant defaults not applied; retrying on a later request", cause),
      ),
    );
};
