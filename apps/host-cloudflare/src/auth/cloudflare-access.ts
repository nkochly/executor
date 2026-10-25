import { createRemoteJWKSet, jwtVerify } from "jose";
import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized, type Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";
import { resolveTenant, tenantSelector, type TenantMembership } from "../tenancy";

// ---------------------------------------------------------------------------
// Cloudflare Access IdentityProvider — the CF-native swap for self-host's
// Better Auth. Cloudflare Access (Zero Trust) sits IN FRONT of the Worker and
// authenticates the human; it forwards a signed `Cf-Access-Jwt-Assertion` JWT.
// This provider verifies that JWT against the team's public JWKS and maps its
// claims onto the neutral `Principal`. There is no app-level login, no session
// store, no password — the IdP is the gate.
//
// Single-tenant: every verified principal belongs to the one configured org.
// Roles come from the admin allowlist + the Access groups claim. Multi-tenant
// (a tenant directory configured): the principal acts in the tenant the
// request names, as that tenant's admin or member, and is refused when the
// directory does not list it there.
// ---------------------------------------------------------------------------

/**
 * Map verified Access JWT claims onto the neutral `Principal`. Pure (no JWT
 * verification) so it is unit-testable. Handles both human identities (email +
 * sub, optional groups) and SERVICE TOKENS — machine/API-key auth via the
 * `CF-Access-Client-Id`/`-Secret` headers — which carry `common_name` (the
 * token's client id) instead of email/sub. Single-tenant: every principal
 * belongs to the one configured org; admin comes from the email allowlist.
 */
export const principalFromAccessClaims = (
  claims: Record<string, unknown>,
  config: CloudflareConfig,
  membership?: TenantMembership | null,
): Principal | null => {
  const email = typeof claims.email === "string" ? claims.email : "";
  const sub = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : "";
  const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
  const nameClaim = claims[config.accessNameClaim];
  const groupsClaim = claims[config.accessGroupsClaim];
  const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];
  if (config.directory) {
    const member = membership ?? null;
    if (!member) return null;
    const isTenantAdmin = member.role === "admin";
    return {
      kind: "member",
      accountId: sub || email || commonName,
      organizationId: member.tenant.slug,
      organizationName: member.tenant.name,
      organizationSlug: member.tenant.slug,
      email,
      name: typeof nameClaim === "string" ? nameClaim : commonName || null,
      avatarUrl: null,
      roles: isTenantAdmin ? ["admin", ...groups] : groups.length > 0 ? groups : ["member"],
      orgRoleModel: "organization",
      orgRole: isTenantAdmin ? "admin" : "member",
    };
  }

  const isAdmin = email.length > 0 && config.adminEmails.includes(email.toLowerCase());

  return {
    kind: "member",
    accountId: sub || email || commonName,
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email,
    name: typeof nameClaim === "string" ? nameClaim : commonName || null,
    avatarUrl: null,
    roles: isAdmin ? ["admin", ...groups] : groups.length > 0 ? groups : ["member"],
    orgRoleModel: "organization",
    orgRole: isAdmin ? "admin" : "member",
  };
};

/**
 * Resolve a request to its verified `Principal`, or `null` when the Access
 * assertion is missing/invalid. The single source of truth for "who is this
 * request", shared by the `IdentityProvider` (the API gate) and the MCP auth
 * provider (the `/mcp` gate) so both enforce Access identically.
 *
 * `jose` caches + rotates the team JWKS, so build the verifier once per config.
 */
export const makeAccessVerifier = (config: CloudflareConfig) => {
  const issuer = `https://${config.accessTeamDomain}`;
  // Cached, lazily-fetched team signing keys; jose handles rotation + caching.
  const jwks = config.enableDevAuth
    ? null
    : createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  // Dev/single-user escape hatch: bypass Access entirely, every request is a
  // fixed admin. Only when explicitly enabled (and the instance is otherwise
  // unprotected). Mirrors the local app's single-user model.
  const devPrincipal: Principal = {
    kind: "member",
    accountId: "dev",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    organizationSlug: config.organizationSlug,
    email: config.adminEmails[0] ?? "dev@local",
    name: "Dev",
    avatarUrl: null,
    roles: ["admin"],
    orgRoleModel: "organization",
    orgRole: "admin",
  };

  // Dev auth in multi-tenant mode: the dev admin acts in whichever tenant the
  // request names, without a directory read.
  const devPrincipalFor = (selector: string | null): Principal | null => {
    if (!config.directory) return devPrincipal;
    if (!selector) return null;
    return {
      ...devPrincipal,
      organizationId: selector,
      organizationName: selector,
      organizationSlug: selector,
    };
  };

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      if (config.enableDevAuth) return devPrincipalFor(tenantSelector(request));
      if (!jwks) return null;
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) return null;

      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, jwks, { issuer, audience: config.accessAud }),
        catch: () => "invalid access assertion",
      }).pipe(Effect.orElseSucceed(() => null));
      if (!verified) return null;

      const claims = verified.payload as Record<string, unknown>;
      if (!config.directory) return principalFromAccessClaims(claims, config);
      const email = typeof claims.email === "string" ? claims.email : "";
      const commonName = typeof claims.common_name === "string" ? `svc:${claims.common_name}` : "";
      const membership = yield* resolveTenant(
        config.directory,
        email || commonName,
        tenantSelector(request),
      );
      return principalFromAccessClaims(claims, config, membership);
    });

  return { verify };
};

export const cloudflareAccessIdentityLayer = (
  config: CloudflareConfig,
): Layer.Layer<IdentityProvider> => {
  const { verify } = makeAccessVerifier(config);
  return Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) =>
        verify(request).pipe(
          Effect.flatMap((principal) =>
            principal ? Effect.succeed(principal) : Effect.fail(new Unauthorized()),
          ),
        ),
    }),
  );
};
