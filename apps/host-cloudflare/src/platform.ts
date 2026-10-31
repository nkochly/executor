import type { D1Database } from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";

import { makeAccessVerifier } from "./auth/cloudflare-access";
import type { CloudflareConfig, FirstPartyMcp } from "./config";

// ---------------------------------------------------------------------------
// The company's MCP server catalog. Platform admins (ADMIN_EMAILS) add a server
// once and every tenant sees it at the top of its add screen. Listing a server
// gives no tenant anything: a tenant admin still adds it, each person connects
// it as themselves, and its tools stay blocked until the tenant approves them.
// Removing an entry leaves tenants that already added it untouched.
//
// FIRST_PARTY_MCP entries are always listed, ahead of the stored ones.
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
  summary: `${server.name}, connected as yourself.`,
  endpoint: server.endpoint,
});

const readStored = async (db: D1Database): Promise<readonly CatalogServer[]> => {
  await db.prepare(SCHEMA).run();
  const rows = await db
    .prepare("SELECT slug, name, summary, endpoint FROM platform_mcp_server ORDER BY name")
    .all<CatalogServer>();
  return rows.results;
};

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
  const fixed = config.firstParty.map(fromFirstParty);
  const servers = [...fixed, ...stored.filter((s) => !fixed.some((f) => f.slug === s.slug))];
  cached = { at: Date.now(), servers };
  return servers;
};

/** This isolate's copy of the catalog, as of the last refresh. */
export const catalogNow = (config: CloudflareConfig): readonly CatalogServer[] =>
  cached?.servers ?? config.firstParty.map(fromFirstParty);

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

/** Origins whose connections must be each person's own: every catalog server's. */
export const catalogOrigins = (servers: readonly CatalogServer[]): readonly string[] =>
  servers.flatMap((server) =>
    URL.canParse(server.endpoint) ? [new URL(server.endpoint).origin] : [],
  );

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

/** The signed-in email when it is a platform admin's, else `null`. */
const platformAdmin = async (
  request: Request,
  config: CloudflareConfig,
): Promise<string | null> => {
  const claims = await Effect.runPromise(makeAccessVerifier(config).verifyClaims(request));
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : "";
  return email && config.adminEmails.includes(email) ? email : null;
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Company MCP servers</title>
<style>body{font:16px system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem;border-bottom:1px solid #ddd}input{width:100%;padding:.4rem;box-sizing:border-box;margin:.2rem 0}button{padding:.4rem .8rem}.hint{color:#666}</style></head><body>
<h1>Company MCP servers</h1><p class="hint">Every tenant sees these first when it adds an integration. Each tenant still adds a server, connects it and approves its tools itself.</p>
<table><thead><tr><th>Name</th><th>Endpoint</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<h2>Add a server</h2><form id="add"><input name="name" placeholder="Name" required><input name="slug" placeholder="slug (a-z, 0-9, -)" required pattern="[a-z0-9][a-z0-9-]*"><input name="endpoint" placeholder="https://…/mcp" required type="url"><input name="summary" placeholder="One line on what it does"><button>Add</button></form><p id="msg"></p>
<script>
const api='/api/platform/mcp-servers';const msg=document.getElementById('msg');
async function load(){const r=await fetch(api);const list=await r.json();const tb=document.getElementById('rows');tb.textContent='';for(const s of list.servers){const tr=document.createElement('tr');for(const v of [s.name,s.endpoint]){const td=document.createElement('td');td.textContent=v;tr.append(td)}const td=document.createElement('td');if(s.removable){const b=document.createElement('button');b.textContent='Remove';b.onclick=async()=>{await fetch(api+'/'+encodeURIComponent(s.slug),{method:'DELETE'});load()};td.append(b)}tr.append(td);tb.append(tr)}}
document.getElementById('add').onsubmit=async(e)=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));const r=await fetch(api,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const out=await r.json();msg.textContent=r.ok?'Added.':out.error;if(r.ok){e.target.reset();load()}};
load();
</script></body></html>`;

/**
 * `/platform` (the page) and `/api/platform/mcp-servers` (GET for anyone signed
 * in; POST and DELETE for platform admins). `null` when the path is not one.
 */
export const handlePlatform = async (
  request: Request,
  db: D1Database,
  config: CloudflareConfig,
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  const base = "/api/platform/mcp-servers";
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
        removable: !config.firstParty.some((f) => f.slug === s.slug),
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
    if (config.firstParty.some((f) => f.slug === slug)) {
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
        admin,
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
