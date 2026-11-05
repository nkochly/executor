import type { D1Database } from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";

import { makeAccessVerifier } from "./auth/cloudflare-access";
import type { CloudflareConfig, CloudflareEnv, FirstPartyMcp } from "./config";
import { ADMIN_PAGE } from "./platform-page";
import { handlePlatformAdmin } from "./platform-admin";
import { isOperator } from "./tenancy";
import { integrationSlugFor } from "./tenant-defaults";
import { WEBEX_SERVERS, webexOAuthClients } from "./webex";

// ---------------------------------------------------------------------------
// The company's MCP server catalog. Platform admins (the wiki's operators) add a server
// once and every tenant sees it at the top of its add screen. Listing a server
// gives no tenant anything: a tenant admin still adds it and connects it (as
// themselves, or for the workspace as the tenant's team agent, which the
// first-party connect hosts offer to tenant admins), and its tools stay
// blocked until the tenant approves them.
// Removing an entry leaves tenants that already added it untouched.
//
// FIRST_PARTY_MCP entries are always listed, ahead of the stored ones, then
// Webex's servers once the company's Webex integration holds real values. Their
// slugs stay reserved while the integration is bound at all.
// ---------------------------------------------------------------------------

export interface CatalogServer {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly endpoint: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS platform_mcp_server (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
)`;

// A tenant's add screen may show an entry up to this long after a change.
const TTL_MS = 30_000;
let cached: { readonly at: number; readonly servers: readonly CatalogServer[] } | null = null;

const fromFirstParty = (server: FirstPartyMcp): CatalogServer => ({
  slug: server.slug,
  name: server.name,
  summary: `${server.name}, as yourself. Each sign-in picks one tenant; connect it again for another.`,
  endpoint: server.endpoint,
});

const readStored = async (db: D1Database): Promise<readonly CatalogServer[]> => {
  await db.prepare(SCHEMA).run();
  const rows = await db
    .prepare("SELECT slug, name, summary, endpoint FROM platform_mcp_server ORDER BY name")
    .all<CatalogServer>();
  return rows.results;
};

/** The entries the host config lists, which a platform admin cannot remove. */
const fixedEntries = (config: CloudflareConfig, webexReady: boolean): readonly CatalogServer[] => [
  ...config.firstParty.map(fromFirstParty),
  ...(webexReady ? WEBEX_SERVERS : []),
];

const reserved = (config: CloudflareConfig, slug: string): boolean =>
  fixedEntries(config, config.webex !== null).some((f) => f.slug === slug);

/** Refreshes this isolate's copy of the catalog when it is stale. */
export const refreshCatalog = async (
  db: D1Database,
  config: CloudflareConfig,
): Promise<readonly CatalogServer[]> => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.servers;
  const stored = await Effect.runPromise(
    Effect.tryPromise({ try: () => readStored(db), catch: () => "unreadable" as const }).pipe(
      Effect.orElseSucceed(() => cached?.servers ?? []),
    ),
  );
  const webexReady = (await webexOAuthClients(config)).length > 0;
  const fixed = fixedEntries(config, webexReady);
  const servers = [...fixed, ...stored.filter((s) => !fixed.some((f) => f.slug === s.slug))];
  cached = { at: Date.now(), servers };
  return servers;
};

/** This isolate's copy of the catalog, as of the last refresh. */
export const catalogNow = (config: CloudflareConfig): readonly CatalogServer[] =>
  cached?.servers ?? fixedEntries(config, false);

/**
 * The integration slugs a session serves the catalog's tools under. The console
 * and the tenant defaults add a catalog server under its slug with underscores
 * (`webex-meetings` becomes `webex_meetings`); a session that looked for the
 * hyphenated slug would find no tools and list none.
 */
export const catalogIntegrations = (servers: readonly CatalogServer[]): readonly string[] =>
  servers.map((server) => integrationSlugFor(server.slug));

/**
 * The catalog's integration slugs the org has no integration under. Each one
 * is a catalog server whose tools no session can serve; a workspace that picked
 * it would list none of its tools.
 */
export const unservedCatalogIntegrations = (
  servers: readonly CatalogServer[],
  known: readonly string[],
): readonly string[] => {
  const have = new Set(known);
  return catalogIntegrations(servers).filter((slug) => !have.has(slug));
};

/** The catalog as MCP add-screen presets. */
export const catalogPresets = (servers: readonly CatalogServer[]) =>
  servers.map((server) => ({
    id: `catalog-${server.slug}`,
    name: server.name,
    summary: server.summary,
    url: server.endpoint,
    endpoint: server.endpoint,
    featured: true,
    family: "Company",
  }));

const AddBody = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  summary: Schema.optional(Schema.String),
  endpoint: Schema.String,
});
const decodeAdd = Schema.decodeUnknownOption(AddBody);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The signed-in platform admin, else `null`. */
const platformAdmin = async (
  request: Request,
  config: CloudflareConfig,
): Promise<{ readonly email: string; readonly subject: string } | null> => {
  const claims = await Effect.runPromise(makeAccessVerifier(config).verifyClaims(request));
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) return null;
  // The account id the console's executor uses for this person.
  const subject = typeof claims?.sub === "string" && claims.sub.length > 0 ? claims.sub : email;
  // With a directory: the wiki's operators, the one platform admin list.
  // Without one: ADMIN_EMAILS.
  const admin = config.operatorDirectory
    ? await Effect.runPromise(isOperator(config.operatorDirectory, email))
    : config.adminEmails.includes(email);
  return admin ? { email, subject } : null;
};

const PAGE = ADMIN_PAGE;

/**
 * `/platform` (the page) and `/api/platform/mcp-servers` (GET for anyone signed
 * in; POST and DELETE for platform admins). `null` when the path is not one.
 */
export const handlePlatform = async (
  request: Request,
  env: CloudflareEnv,
  config: CloudflareConfig,
): Promise<Response | null> => {
  const db = env.DB;
  const { pathname } = new URL(request.url);
  const base = "/api/platform/mcp-servers";
  if (pathname.startsWith("/api/platform/admin/")) {
    const admin = await platformAdmin(request, config);
    return admin
      ? handlePlatformAdmin(request, env, config, admin)
      : json({ error: "Only a platform admin can do that." }, 403);
  }
  if (pathname !== "/platform" && pathname !== base && !pathname.startsWith(`${base}/`)) {
    return null;
  }
  const admin = await platformAdmin(request, config);
  if (pathname === "/platform") {
    return admin
      ? new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("Not found\n", { status: 404 });
  }
  if (request.method === "GET" && pathname === base) {
    cached = null;
    const servers = await refreshCatalog(db, config);
    return json({
      servers: servers.map((s) => ({
        ...s,
        removable: !reserved(config, s.slug),
      })),
    });
  }
  if (!admin) return json({ error: "Only a platform admin can change the catalog." }, 403);
  await db.prepare(SCHEMA).run();
  if (request.method === "POST" && pathname === base) {
    const body = decodeAdd(
      await Effect.runPromise(
        Effect.tryPromise({ try: () => request.json(), catch: () => "invalid" as const }).pipe(
          Effect.orElseSucceed(() => null),
        ),
      ),
    );
    if (Option.isNone(body)) return json({ error: "Give a slug, a name and an endpoint." }, 400);
    const { slug, name, endpoint } = body.value;
    if (!SLUG.test(slug)) return json({ error: "The slug is a-z, 0-9 and dashes." }, 400);
    if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:") {
      return json({ error: "The endpoint must be an https URL." }, 400);
    }
    if (reserved(config, slug)) {
      return json({ error: `"${slug}" is already listed.` }, 409);
    }
    const inserted = await db
      .prepare(
        "INSERT INTO platform_mcp_server (slug, name, summary, endpoint, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING",
      )
      .bind(
        slug,
        name.trim(),
        body.value.summary?.trim() || name.trim(),
        endpoint,
        admin.email,
        Date.now(),
      )
      .run();
    cached = null;
    return inserted.meta.changes === 0
      ? json({ error: `"${slug}" is already listed.` }, 409)
      : json({ slug }, 201);
  }
  if (request.method === "DELETE" && pathname.startsWith(`${base}/`)) {
    const slug = decodeURIComponent(pathname.slice(base.length + 1));
    await db.prepare("DELETE FROM platform_mcp_server WHERE slug = ?").bind(slug).run();
    cached = null;
    return json({ removed: true });
  }
  return json({ error: "Not found" }, 404);
};
