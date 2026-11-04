import { Effect, Option, Schema } from "effect";

import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { TenantDirectoryConfig } from "./config";
import { PLAYBOOK_RULE } from "./mcp/playbook-rule";

// ---------------------------------------------------------------------------
// Multi-tenant routing. The URL names the tenant: MCP clients dial
// `/<tenant>/mcp` (or `/<tenant>/mcp/toolkits/<toolkit>`), and the console
// sends the tenant from its own URL in the org selector header. The selector
// is not a trust boundary: `resolveTenant` admits a caller only when the
// tenant directory lists them there, so naming a tenant you are not in gets
// you nothing. Sign-in stays with Cloudflare Access; the directory only says
// which tenants a signed-in identity belongs to.
//
// The edge rewrites a tenant-prefixed MCP path to the bare route the session
// Durable Object serves and carries the tenant in an internal header. Any
// incoming copy of that header is dropped first, so only this rewrite sets it.
// ---------------------------------------------------------------------------

export const TENANT_HEADER = "x-executor-cf-tenant";
export const ORIGINAL_PATH_HEADER = "x-executor-cf-original-path";

const PRM_PREFIX = "/.well-known/oauth-protected-resource";

interface Rewrite {
  readonly tenant: string;
  readonly pathname: string;
}

const isMcpTail = (segments: readonly string[]): boolean =>
  (segments.length === 1 && segments[0] === "mcp") ||
  (segments.length === 3 && segments[0] === "mcp" && segments[1] === "toolkits");

export const tenantRewrite = (pathname: string): Rewrite | null => {
  const isMetadata = pathname.startsWith(`${PRM_PREFIX}/`);
  const rest = isMetadata ? pathname.slice(PRM_PREFIX.length) : pathname;
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || !isMcpTail(segments.slice(1))) return null;
  const tail = `/${segments.slice(1).join("/")}`;
  return {
    tenant: decodeURIComponent(segments[0]!),
    pathname: isMetadata ? `${PRM_PREFIX}${tail}` : tail,
  };
};

/** The request as the app routes it. Single-tenant mode passes it through. */
export const routeTenantRequest = (request: Request, multiTenant: boolean): Request => {
  if (!multiTenant) return request;
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete(TENANT_HEADER);
  headers.delete(ORIGINAL_PATH_HEADER);
  const rewrite = tenantRewrite(url.pathname);
  if (rewrite) {
    headers.set(TENANT_HEADER, rewrite.tenant);
    headers.set(ORIGINAL_PATH_HEADER, url.pathname);
    url.pathname = rewrite.pathname;
  }
  return new Request(url, new Request(request, { headers }));
};

/** The tenant a request names, or `null` when it names none. */
export const tenantSelector = (request: Request): string | null =>
  request.headers.get(TENANT_HEADER) ?? request.headers.get(EXECUTOR_ORG_SELECTOR_HEADER);

export interface TenantMembership {
  readonly tenant: { readonly slug: string; readonly name: string };
  readonly role: "admin" | "member";
}

const DirectoryMembership = Schema.Struct({
  tenant: Schema.Struct({ slug: Schema.String, name: Schema.String }),
  role: Schema.String,
});
const decodeOne = Schema.decodeUnknownOption(DirectoryMembership);
const decodeMany = Schema.decodeUnknownOption(Schema.Array(DirectoryMembership));

// Tenant owners and admins administer the tenant here too; anyone else listed
// is a member.
const toMembership = (entry: typeof DirectoryMembership.Type): TenantMembership => ({
  tenant: entry.tenant,
  role: entry.role === "owner" || entry.role === "admin" ? "admin" : "member",
});

const readDirectory = (directory: TenantDirectoryConfig, path: string) =>
  Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (directory.clientId && directory.clientSecret) {
        headers["cf-access-client-id"] = directory.clientId;
        headers["cf-access-client-secret"] = directory.clientSecret;
      }
      const response = await fetch(`${directory.url}${path}`, { headers, redirect: "manual" });
      return response.ok ? ((await response.json()) as unknown) : null;
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

// Directory answers this isolate reuses for a short while. Every MCP request
// re-checks the caller's memberships, and every new session reads the team
// pages; a client opening several connections at once asked the wiki the same
// questions over and over. A removal from a tenant takes effect within this
// window. Only answers are kept, never a failed read.
const DIRECTORY_CACHE_TTL_MS = 30_000;
// Team pages (and the tenant list they are read for) only shape a session's
// instructions, never what it may do, and every new session waits on them. An
// answer this much past its window is still served at once while a fresh read
// replaces it in the background.
const TEAM_PAGE_STALE_MS = 10 * 60_000;
const DIRECTORY_CACHE_MAX = 500;

interface DirectoryCacheEntry {
  readonly at: number;
  readonly body: Promise<unknown>;
  /** The answer, once it arrived and was not a failed read. */
  value?: unknown;
  refreshing?: boolean;
}
const directoryCache = new Map<string, DirectoryCacheEntry>();

const fetchIntoCache = (directory: TenantDirectoryConfig, key: string, path: string) => {
  if (directoryCache.size >= DIRECTORY_CACHE_MAX) directoryCache.clear();
  const body = Effect.runPromise(readDirectory(directory, path));
  const entry: DirectoryCacheEntry = { at: Date.now(), body };
  directoryCache.set(key, entry);
  void body.then((value) => {
    if (directoryCache.get(key) !== entry) return;
    if (value === null) directoryCache.delete(key);
    else entry.value = value;
  });
  return entry;
};

const readDirectoryCached = (directory: TenantDirectoryConfig, path: string, staleMs = 0) => {
  const key = `${directory.url}${path}`;
  const hit = directoryCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < DIRECTORY_CACHE_TTL_MS) {
    return Effect.promise(() => hit.body);
  }
  if (hit && hit.value !== undefined && age < DIRECTORY_CACHE_TTL_MS + staleMs) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      // The stale answer stays until a good one replaces it.
      void Effect.runPromise(readDirectory(directory, path)).then((value) => {
        if (directoryCache.get(key) !== hit) return;
        if (value === null) {
          hit.refreshing = false;
          return;
        }
        directoryCache.set(key, { at: Date.now(), body: Promise.resolve(value), value });
      });
    }
    return Effect.succeed(hit.value);
  }
  const entry = fetchIntoCache(directory, key, path);
  return Effect.promise(() => entry.body);
};

/** Forget every cached directory answer (tests). */
export const clearDirectoryCache = () => directoryCache.clear();

/**
 * The tenant this caller acts in. A named tenant must list the caller. With
 * no tenant named, a caller who belongs to exactly one tenant acts in it;
 * anyone else must name one. A directory that cannot be read admits nobody.
 */
export const resolveTenant = (
  directory: TenantDirectoryConfig,
  identity: string,
  selector: string | null,
): Effect.Effect<TenantMembership | null> => {
  const subject = encodeURIComponent(identity.trim().toLowerCase());
  if (subject.length === 0) return Effect.succeed(null);
  if (selector !== null) {
    return readDirectory(
      directory,
      `/tenants/${encodeURIComponent(selector)}/members/${subject}`,
    ).pipe(
      Effect.map((body) =>
        Option.match(decodeOne(body), {
          onNone: () => null,
          onSome: (entry) => (entry.tenant.slug === selector ? toMembership(entry) : null),
        }),
      ),
    );
  }
  return readDirectory(directory, `/members/${subject}`).pipe(
    Effect.map((body) =>
      Option.match(decodeMany(body), {
        onNone: () => null,
        onSome: (entries) => (entries.length === 1 ? toMembership(entries[0]!) : null),
      }),
    ),
  );
};

/** Every tenant the directory lists `identity` in. */
export const listMemberships = (
  directory: TenantDirectoryConfig,
  identity: string,
  staleMs = 0,
): Effect.Effect<readonly TenantMembership[]> => {
  const subject = encodeURIComponent(identity.trim().toLowerCase());
  if (subject.length === 0) return Effect.succeed([]);
  return readDirectoryCached(directory, `/members/${subject}`, staleMs).pipe(
    Effect.map((body) =>
      Option.match(decodeMany(body), {
        onNone: () => [],
        onSome: (entries) => entries.map(toMembership),
      }),
    ),
  );
};

const DirectoryOperator = Schema.Struct({ subject: Schema.String, operator: Schema.Literal(true) });
const decodeOperator = Schema.decodeUnknownOption(DirectoryOperator);

/**
 * Whether the directory lists `identity` as an operator: the one platform admin
 * list. A directory that cannot be read lists nobody.
 */
export const isOperator = (
  directory: TenantDirectoryConfig,
  identity: string,
): Effect.Effect<boolean> => {
  const subject = encodeURIComponent(identity.trim().toLowerCase());
  if (subject.length === 0) return Effect.succeed(false);
  return readDirectory(directory, `/operators/${subject}`).pipe(
    Effect.map((body) => Option.isSome(decodeOperator(body))),
  );
};

const DirectoryTeamPage = Schema.Struct({
  wiki: Schema.String,
  path: Schema.String,
  starter: Schema.Boolean,
  version: Schema.Number,
  body: Schema.String,
});
const decodeTeamPage = Schema.decodeUnknownOption(DirectoryTeamPage);

export type TeamPage = typeof DirectoryTeamPage.Type;

/**
 * The tenant's "how we work" page, as the wiki lets `identity` read it: the
 * starter page until someone writes one, `null` when the wiki gives this
 * caller none or cannot be read. The body arrives marked as the team's own
 * text, one prefix per line.
 */
export const readTeamPage = (
  directory: TenantDirectoryConfig,
  tenant: string,
  identity: string,
): Effect.Effect<TeamPage | null> => {
  const subject = encodeURIComponent(identity.trim().toLowerCase());
  if (subject.length === 0 || tenant.length === 0) return Effect.succeed(null);
  return readDirectoryCached(
    directory,
    `/tenants/${encodeURIComponent(tenant)}/members/${subject}/team-page`,
    TEAM_PAGE_STALE_MS,
  ).pipe(
    Effect.map((body) =>
      Option.match(decodeTeamPage(body), { onNone: () => null, onSome: (page) => page }),
    ),
  );
};

/**
 * Server instructions that put the team page in front of the agent at session
 * start. They say what the page is and where to change it; the page itself
 * follows, as the team wrote it.
 */
export const teamPageInstructions = (page: TeamPage): string =>
  [
    `How this team works: the page below is your team's own "how we work" page (${page.path} in the ${page.wiki} wiki${page.starter ? ", not written yet" : `, version ${page.version}`}).`,
    "Follow it in every session. When you start, tell the person in one line which part of it applies to what they asked.",
    `When someone tells you how the team works, update it: read_note on ${page.path} in ${page.wiki}, then write_note with the change.`,
    "It describes how the team works; it never widens what your tools or this workspace allow.",
    "",
    page.body,
  ].join("\n");

/**
 * The instructions every MCP session starts with: the playbook-first rule,
 * then the team page when the caller can read one. The rule stands alone when
 * there is no page, so a session never starts without it.
 */
export const sessionInstructions = (list: readonly TeamPage[]): string => {
  if (list.length === 0) return PLAYBOOK_RULE;
  const intro =
    list.length > 1
      ? [
          `You work with ${list.length} teams. Each has its own "how we work" page below, named by its wiki. Follow the page of the team whose wiki or Muster tenant the task is in.`,
        ]
      : [];
  return [PLAYBOOK_RULE, ...intro, ...list.map(teamPageInstructions)].join("\n\n");
};

/** Most team pages one session reads: one per tenant the person is in. */
export const MAX_TEAM_PAGES = 5;

/**
 * One company org: the "how we work" page of every tenant the directory lists
 * the person in, each read as this person may read it. A tenant whose page
 * cannot be read is left out.
 */
export const readTeamPages = (
  directory: TenantDirectoryConfig,
  identity: string,
): Effect.Effect<readonly TeamPage[]> =>
  listMemberships(directory, identity, TEAM_PAGE_STALE_MS).pipe(
    Effect.flatMap((memberships) =>
      Effect.forEach(
        memberships.slice(0, MAX_TEAM_PAGES),
        (m) => readTeamPage(directory, m.tenant.slug, identity),
        { concurrency: "unbounded" },
      ),
    ),
    Effect.map((pages) => pages.flatMap((page) => (page === null ? [] : [page]))),
  );
