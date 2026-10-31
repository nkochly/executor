import { Effect, Option, Schema } from "effect";

import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { TenantDirectoryConfig } from "./config";

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
): Effect.Effect<readonly TenantMembership[]> => {
  const subject = encodeURIComponent(identity.trim().toLowerCase());
  if (subject.length === 0) return Effect.succeed([]);
  return readDirectory(directory, `/members/${subject}`).pipe(
    Effect.map((body) =>
      Option.match(decodeMany(body), {
        onNone: () => [],
        onSome: (entries) => entries.map(toMembership),
      }),
    ),
  );
};
