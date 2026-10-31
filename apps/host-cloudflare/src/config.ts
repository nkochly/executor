import type {
  D1Database,
  DurableObjectNamespace,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import { Option, Schema } from "effect";

import { isValidOrgSlug } from "@executor-js/api";
import { missingPublicOriginWarning, resolvePublicOrigin } from "@executor-js/sdk/public-origin";

let warnedNoCloudflareOrigin = false;

// ---------------------------------------------------------------------------
// Cloudflare host config. Unlike self-host (process.env + a data dir), a Worker
// receives its bindings + vars per request as `env`, so config is derived from
// that object — there is no process.env, no filesystem, no boot-time secret
// generation. Identity comes entirely from Cloudflare Access in front of the
// Worker; the only real secret is the at-rest secret-encryption key.
// ---------------------------------------------------------------------------

export const CLOUDFLARE_NAMESPACE = "executor_cloudflare";
export const CLOUDFLARE_SCHEMA_VERSION = "1.0.0";

export interface CloudflareEnv {
  /** D1 database binding — the app's SQLite store. */
  readonly DB: D1Database;
  /** R2 bucket binding — holds values too large for a D1 row (~1-2MB cap). */
  readonly BLOBS?: R2Bucket;
  /** Static assets binding (wrangler.jsonc `assets.binding`). The MCP session
   *  DO fetches the built MCP-Apps shell document through it — a deployed
   *  Worker has no filesystem to read the shell from. */
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  /** MCP session Durable Object namespace — one addressable isolate per MCP
   *  session (the DO id IS the session id), so a session survives across the
   *  Worker's stateless isolates. */
  readonly MCP_SESSION: DurableObjectNamespace;
  readonly MCP_EXECUTION_OWNER?: DurableObjectNamespace;
  /** Zero Trust team domain, e.g. `your-team.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag (the JWT audience to verify). */
  readonly ACCESS_AUD?: string;
  /** Claim holding the display name (default `name`). */
  readonly ACCESS_NAME_CLAIM?: string;
  /** Claim holding the user's groups (default `groups`). */
  readonly ACCESS_GROUPS_CLAIM?: string;
  /** Comma-separated emails granted the admin role. */
  readonly ADMIN_EMAILS?: string;
  /** The single organization id/name every authenticated user belongs to. */
  readonly SELF_HOSTED_ORG_ID?: string;
  readonly SELF_HOSTED_ORG_NAME?: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly SELF_HOSTED_ORG_SLUG?: string;
  /** At-rest secret-encryption key (a `wrangler secret`, NOT a var). */
  readonly EXECUTOR_SECRET_KEY?: string;
  readonly ALLOW_LOCAL_NETWORK?: string;
  readonly VITE_PUBLIC_SITE_URL?: string;
  /**
   * Dev/single-user escape hatch: when "true", skip Cloudflare Access entirely
   * and treat every request as a fixed admin. For local `wrangler dev` and
   * unattended validation only — NEVER set on a deployment that isn't already
   * behind Access, or the instance is wide open.
   */
  readonly ENABLE_DEV_AUTH?: string;
  /**
   * Multi-tenant mode: the tenant membership directory, e.g.
   * `https://wiki.example.com/api/directory`. It answers
   * `GET <url>/tenants/<slug>/members/<subject>` with `{tenant: {slug, name},
   * role}` or 404, and `GET <url>/members/<subject>` with that subject's
   * memberships. When set, the tenant comes from the URL (`/<tenant>/mcp`, the
   * console's org header), a caller the directory does not list there is
   * refused, and tools a tenant's admins have not approved are blocked. Unset
   * keeps the single configured org.
   */
  readonly TENANT_DIRECTORY_URL?: string;
  /** Access service token the directory is read with (a `wrangler secret`). */
  readonly TENANT_DIRECTORY_CLIENT_ID?: string;
  readonly TENANT_DIRECTORY_CLIENT_SECRET?: string;
  /**
   * Agent sign-in (multi-tenant mode only): the KV namespace Executor's own
   * OAuth provider keeps clients, grants and tokens in. When bound, `/mcp`
   * takes only Executor-issued tokens, each carrying one person, one tenant and
   * one agent, and Cloudflare Access guards only `/authorize` and the console.
   */
  readonly OAUTH_KV?: KVNamespace;
  /**
   * The first-party MCP servers, as JSON `[{"slug", "name", "endpoint"}]`. Their
   * tools are served by name next to `execute`, and a connection to them must
   * be a person's own: a shared org sign-in would let anyone in the tenant act
   * as whoever signed it in.
   */
  readonly FIRST_PARTY_MCP?: string;
}

export interface CloudflareConfig {
  readonly accessTeamDomain: string;
  readonly accessAud: string;
  readonly accessNameClaim: string;
  readonly accessGroupsClaim: string;
  readonly adminEmails: readonly string[];
  readonly organizationId: string;
  readonly organizationName: string;
  /** URL slug for org-prefixed console paths (`/<slug>/policies`). */
  readonly organizationSlug: string;
  readonly secretKey: string;
  readonly allowLocalNetwork: boolean;
  /** Explicit web base URL (`VITE_PUBLIC_SITE_URL`). Unset on a Worker with no
   *  static URL — the per-request origin is used instead (see RequestWebOrigin). */
  readonly webBaseUrl?: string;
  readonly enableDevAuth: boolean;
  /** The tenant membership directory; `null` is single-tenant mode. */
  readonly directory: TenantDirectoryConfig | null;
  readonly firstParty: readonly FirstPartyMcp[];
}

export interface FirstPartyMcp {
  readonly slug: string;
  readonly name: string;
  readonly endpoint: string;
}

const FirstPartyList = Schema.Array(
  Schema.Struct({ slug: Schema.String, name: Schema.String, endpoint: Schema.String }),
);

const decodeFirstParty = Schema.decodeUnknownOption(Schema.fromJsonString(FirstPartyList));

const resolveFirstParty = (raw: string | undefined): readonly FirstPartyMcp[] => {
  if (!raw?.trim()) return [];
  const decoded = decodeFirstParty(raw);
  if (Option.isNone(decoded)) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a malformed list must not silently drop the personal-only rule
    throw new Error("FIRST_PARTY_MCP must be a JSON list of {slug, name, endpoint}");
  }
  return decoded.value;
};

export interface TenantDirectoryConfig {
  readonly url: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

const resolveDirectory = (env: CloudflareConfigEnv): TenantDirectoryConfig | null => {
  const url = env.TENANT_DIRECTORY_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  if (!url.startsWith("https://") && env.ENABLE_DEV_AUTH !== "true") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: membership must not be read in the clear
    throw new Error("TENANT_DIRECTORY_URL must be an https URL");
  }
  return {
    url,
    clientId: env.TENANT_DIRECTORY_CLIENT_ID?.trim() || undefined,
    clientSecret: env.TENANT_DIRECTORY_CLIENT_SECRET?.trim() || undefined,
  };
};

type CloudflareConfigEnv = Omit<
  CloudflareEnv,
  "DB" | "BLOBS" | "ASSETS" | "MCP_SESSION" | "MCP_EXECUTION_OWNER" | "OAUTH_KV"
>;

type CloudflareAccessEnv = Pick<
  CloudflareConfigEnv,
  "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "ENABLE_DEV_AUTH"
>;

const splitLower = (value: string | undefined): readonly string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

const normalizeAccessTeamDomain = (value: string | undefined): string =>
  (value ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

export const missingCloudflareAccessVars = (env: CloudflareAccessEnv): readonly string[] => {
  if (env.ENABLE_DEV_AUTH === "true") return [];
  const accessTeamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const accessAud = (env.ACCESS_AUD ?? "").trim();
  return [
    ...(accessTeamDomain.length === 0 ||
    accessTeamDomain.toLowerCase() === "your-team.cloudflareaccess.com"
      ? ["ACCESS_TEAM_DOMAIN"]
      : []),
    ...(accessAud.length === 0 ? ["ACCESS_AUD"] : []),
  ];
};

export const cloudflareAccessConfigErrorMessage = (missingVars: readonly string[]): string =>
  `Cloudflare Access is not configured. Set ${missingVars.join(" and ")} before serving requests.`;

// The org slug doubles as a URL segment (`/<slug>/policies`), so an
// operator-set value must fit the shared grammar and avoid reserved root
// segments — a colliding slug would shadow real routes (notably /api, /mcp,
// and Cloudflare's /cdn-cgi).
const resolveOrgSlug = (value: string | undefined): string => {
  if (!value) return "default";
  if (!isValidOrgSlug(value) && value !== "default") {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: a colliding org slug would shadow app routes; refuse to boot
    throw new Error(
      `SELF_HOSTED_ORG_SLUG ${JSON.stringify(value)} is not usable as a URL slug (2-48 chars of [a-z0-9-], not a reserved path segment like "api" or "mcp")`,
    );
  }
  return value;
};

export const loadConfig = (env: CloudflareConfigEnv): CloudflareConfig => {
  const secretKey = env.EXECUTOR_SECRET_KEY?.trim();
  if (!secretKey || secretKey.length < 16) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: the Worker must not boot without the at-rest secret key
    throw new Error(
      "EXECUTOR_SECRET_KEY must be set (wrangler secret put EXECUTOR_SECRET_KEY) — it encrypts stored secrets at rest in D1",
    );
  }
  const enableDevAuth = env.ENABLE_DEV_AUTH === "true";
  const accessTeamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const accessAud = (env.ACCESS_AUD ?? "").trim();
  const missingAccessVars = missingCloudflareAccessVars(env);
  if (missingAccessVars.length > 0) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: production must fail closed without a valid Access verifier
    throw new Error(cloudflareAccessConfigErrorMessage(missingAccessVars));
  }
  const webBaseUrl = resolvePublicOrigin({ explicit: env.VITE_PUBLIC_SITE_URL, env: {} });
  if (!webBaseUrl && !enableDevAuth && !warnedNoCloudflareOrigin) {
    warnedNoCloudflareOrigin = true;
    console.warn(
      missingPublicOriginWarning({
        varName: "VITE_PUBLIC_SITE_URL",
        fallback: "the per-request origin",
      }),
    );
  }
  return {
    accessTeamDomain,
    accessAud,
    accessNameClaim: env.ACCESS_NAME_CLAIM ?? "name",
    accessGroupsClaim: env.ACCESS_GROUPS_CLAIM ?? "groups",
    adminEmails: splitLower(env.ADMIN_EMAILS),
    organizationId: env.SELF_HOSTED_ORG_ID ?? "default",
    organizationName: env.SELF_HOSTED_ORG_NAME ?? "Default",
    organizationSlug: resolveOrgSlug(env.SELF_HOSTED_ORG_SLUG),
    secretKey,
    allowLocalNetwork: env.ALLOW_LOCAL_NETWORK === "true",
    // Pinned origin via the shared resolver. A Worker receives no PaaS platform
    // vars (env: {} — there is nothing to detect), so only the explicit
    // VITE_PUBLIC_SITE_URL applies; when it's unset we leave webBaseUrl undefined
    // and let the per-request origin drive it (request.url — Cloudflare-set, not
    // spoofable via Host). Warn once on a real deployment so the operator pins it,
    // mirroring self-host (gated on enableDevAuth = local `wrangler dev`).
    webBaseUrl,
    enableDevAuth,
    directory: resolveDirectory(env),
    firstParty: resolveFirstParty(env.FIRST_PARTY_MCP),
  };
};
