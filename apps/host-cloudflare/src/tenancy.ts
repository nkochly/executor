import { EXECUTOR_ORG_SELECTOR_HEADER } from "@executor-js/sdk/shared";

import type { CloudflareConfig, TenantEntry } from "./config";

// ---------------------------------------------------------------------------
// Multi-tenant routing. The URL names the tenant: MCP clients dial
// `/<tenant>/mcp` (or `/<tenant>/mcp/toolkits/<toolkit>`), and the console
// sends the tenant from its own URL in the org selector header. The selector
// is not a trust boundary: `resolveTenant` admits a caller only when the
// tenant map lists them, so naming a tenant you are not in gets you nothing.
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
  readonly tenant: TenantEntry;
  readonly role: "admin" | "member";
}

const membership = (tenant: TenantEntry, identity: string): TenantMembership | null => {
  if (identity.length === 0) return null;
  if (tenant.admins.has(identity)) return { tenant, role: "admin" };
  if (tenant.members.has(identity) || tenant.members.has("*")) return { tenant, role: "member" };
  return null;
};

/**
 * The tenant this caller acts in. A named tenant must list the caller. With
 * no tenant named, a caller who belongs to exactly one tenant acts in it;
 * anyone else must name one.
 */
export const resolveTenant = (
  config: CloudflareConfig,
  identity: string,
  selector: string | null,
): TenantMembership | null => {
  const tenants = config.tenants;
  if (!tenants) return null;
  const key = identity.toLowerCase();
  if (selector !== null) {
    const tenant = tenants.get(selector);
    return tenant ? membership(tenant, key) : null;
  }
  const all = [...tenants.values()]
    .map((tenant) => membership(tenant, key))
    .filter((entry): entry is TenantMembership => entry !== null);
  return all.length === 1 ? all[0]! : null;
};
