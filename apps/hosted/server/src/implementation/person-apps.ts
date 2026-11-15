/**
 * The person's apps: every app the caller can use in their organization, with each account slot
 * and whether an account fills it for them now. It names apps, slots and providers only; never an
 * account's ID, label or credentials. Read-only, and only as the caller: their membership, app
 * access and grant decide what it lists, exactly as MCP discovery lists the same apps.
 */
import { grantAuthorization } from "@executor-js/mcp-auth";
import { permittedAppIds } from "@executor-js/authorization";
import type { AccountScope, App } from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationReference } from "../contracts/organization.ts";
import { appLinkedAccounts, callerLinkedAccounts } from "./app-accounts.ts";
import { policyDatabase, visibleApps } from "./resource-policy.ts";

/** One account slot of an app, and whether an account fills it for the caller. */
export interface PersonAppSlot {
  readonly name: string;
  readonly scope: AccountScope;
  readonly provider: string;
  readonly cardinality: "one" | "many";
  readonly linked: boolean;
}

/** One app the caller can use. `ready`: deployed, and every plain slot has an account. */
export interface PersonApp {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly deployed: boolean;
  readonly ready: boolean;
  readonly slots: readonly PersonAppSlot[];
}

/** Shape the apps with the requirements their user links and app links fill. */
export const personAppList = (
  apps: readonly App[],
  links: ReadonlyArray<{ readonly app: string; readonly requirement: string }>,
): PersonApp[] => {
  const filled = new Set(links.map((link) => `${link.app}\u0000${link.requirement}`));
  return apps
    .map((app) => {
      const slots = Object.entries(app.requirements.accounts)
        .map(([name, requirement]) => ({
          name,
          scope: requirement.scope,
          provider: requirement.provider,
          cardinality: requirement.cardinality,
          linked: filled.has(`${app.id}\u0000${name}`),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const deployed = app.activeVersion !== null;
      return {
        id: app.id,
        name: app.name,
        slug: app.slug,
        deployed,
        ready: deployed && slots.every((slot) => slot.cardinality === "many" || slot.linked),
        slots,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * `GET /api/me/apps[?organization=<id or slug>]`. The caller authenticates as on `/mcp`: the person
 * Access signed in, or their own bearer. A browser page on another origin is refused.
 */
export const personApps = Effect.gen(function* () {
  const auth = yield* McpAuthentication;
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.origin !== undefined && request.headers.origin !== auth.origin)
    return HttpServerResponse.empty({ status: 403 });
  const url = new URL(request.url, auth.origin);
  const named = url.searchParams.get("organization");
  const organization =
    named === null
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(OrganizationReference)(named));
  if (named !== null && organization === undefined)
    return HttpServerResponse.empty({ status: 400 });
  const access = yield* auth.authenticate(
    new Headers(request.headers),
    undefined,
    organization,
    undefined,
  );
  const policy = grantAuthorization(access.grant.policy);
  const apps = yield* Effect.gen(function* () {
    const executor = yield* Effect.flatten(HostedExecutor);
    const usable = yield* executor.apps
      .list({ ids: permittedAppIds(policy), owner: access.access.owner })
      .pipe(Effect.flatMap(visibleApps));
    const ids = usable.map((app) => app.id);
    const own = yield* callerLinkedAccounts(ids);
    const shared = yield* appLinkedAccounts(yield* policyDatabase, ids);
    return personAppList(usable, [...own, ...shared]);
  }).pipe(
    Effect.provideService(CurrentOrganization, access.access),
    Effect.provideService(CurrentAuthorization, policy),
    Effect.provideService(CurrentUserId, access.userId),
  );
  return HttpServerResponse.jsonUnsafe({ organization: access.access.organization, apps });
}).pipe(
  Effect.catchTags({
    McpUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
    McpForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    OrganizationForbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    AuthenticationUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    StorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
  }),
  Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
);
