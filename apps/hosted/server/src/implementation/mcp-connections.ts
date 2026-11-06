/** Members manage their own connections and connected agents; apps and accounts use the same access checks as calls. */
import {
  ConnectionAccessInvalid,
  ConnectionNotFound,
  type Connection,
  type ConnectionApp,
  type ConnectionId,
} from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import type { App, Executor, OwnerId } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { checkAccounts, currentOwner, usableApp } from "./access.ts";
import { addLink, linkedAccounts, lockedChange } from "./app-accounts.ts";
import { policyDatabase, requireAccountAccessAs } from "./resource-policy.ts";
import { GroupDatabase } from "../contracts/groups.ts";
import {
  BundlesUnavailable,
  ConnectionManaged,
  ConnectionsRestricted,
} from "../contracts/connection-bundles.ts";
import {
  copiesOf,
  isBundleCopy,
  membersCreateConnections,
  reconcileBundles,
  withBundles,
} from "./connection-bundles.ts";

const owner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const userId = yield* CurrentUserId;
  if (userId === undefined) return yield* new OrganizationForbidden();
  return { userId, resource: organization.organization };
});

/**
 * Check one app's runs-as targets. An account target the member has not linked to any of the app's
 * user requirements is linked to each one its provider fills, as linking it from the app would: a
 * plain requirement's previous link is replaced.
 */
const resolveApp = (
  executor: Executor,
  organizationOwner: OwnerId,
  userId: string,
  input: ConnectionApp,
) =>
  Effect.gen(function* () {
    const invalid = (reason: ConnectionAccessInvalid["reason"]) =>
      new ConnectionAccessInvalid({ app: input.app, reason });
    const app: App = yield* usableApp(executor, organizationOwner, input.app).pipe(
      Effect.catchTags({
        AppNotFound: () => Effect.fail(invalid("app")),
        OrganizationForbidden: () => Effect.fail(invalid("app")),
      }),
    );
    // Grants and connections name only the caller's own accounts; app access authorizes the
    // app links.
    const requirements = Object.entries(app.requirements.accounts)
      .filter(([, requirement]) => requirement.scope === "user")
      .map(([slot, requirement]) => ({ slot, ...requirement }));
    const sql = yield* policyDatabase;
    const linked = yield* Effect.forEach(input.runsAs ?? [], (target) =>
      Effect.gen(function* () {
        if (target.kind === "app") {
          if (requirements.length > 0) return yield* invalid("target");
          return false;
        }
        const account = yield* executor.accounts
          .get({ owner: organizationOwner, account: target.id })
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(invalid("account"))));
        if (!requirements.some((requirement) => requirement.provider === account.provider))
          return yield* invalid("account");
        yield* checkAccounts(organizationOwner, { account: account.id }).pipe(
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
        const linked = yield* linkedAccounts(sql, { subject: userId, apps: [app.id] });
        if (linked.some((link) => link.id === account.id)) return false;
        // Check both again under the app's link lock: either may have been revoked while the
        // change waited for it (see `lockedChange`).
        return yield* lockedChange(executor, { app: app.id, access: "use" }, (locked, actor) =>
          Effect.gen(function* () {
            yield* requireAccountAccessAs(actor, account.id, "use").pipe(
              Effect.catchTag("OrganizationForbidden", () => Effect.fail(invalid("account"))),
            );
            return yield* Effect.forEach(
              requirements.filter((requirement) => requirement.provider === account.provider),
              (requirement) =>
                addLink(locked, executor.webhooks, {
                  app: app.id,
                  requirement: requirement.slot,
                  account: account.id,
                  subject: userId,
                  linkedBy: userId,
                }),
            );
          }),
        ).pipe(
          Effect.map((changed) => changed.some(Boolean)),
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("app")),
            RequirementMismatch: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
      }),
    );
    if (linked.some(Boolean)) yield* Effect.flatten(ScheduleWakeup);
    return input;
  });

const resolvePolicy = (apps: readonly ConnectionApp[]) =>
  Effect.gen(function* () {
    const { userId } = yield* owner;
    const organizationOwner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    return {
      apps: yield* Effect.forEach(apps, (app) =>
        resolveApp(executor, organizationOwner, userId, app),
      ),
    };
  });

/** A member who is not an admin may make a connection only while the organization allows it. */
const requireCreate = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  if (organization.role !== "member") return;
  const sql = yield* Effect.flatten(GroupDatabase).pipe(
    Effect.mapError(() => new BundlesUnavailable()),
  );
  const allowed = yield* membersCreateConnections(sql, organization.organization).pipe(
    Effect.mapError(() => new BundlesUnavailable()),
  );
  if (!allowed) return yield* new ConnectionsRestricted();
});

/** A bundle's copy changes only through its bundle; its member may neither edit nor revoke it. */
const requireOwnConnection = (connection: ConnectionId) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(GroupDatabase).pipe(
      Effect.mapError(() => new BundlesUnavailable()),
    );
    const copy = yield* isBundleCopy(sql, connection).pipe(
      Effect.mapError(() => new BundlesUnavailable()),
    );
    if (copy) return yield* new ConnectionManaged({ connection });
  });

/** RequireUser rejects bearer credentials; RequireOrganization checks current membership. */
export const hostedMcpConnectionHandlers = HttpApiBuilder.group(
  HostedApi,
  "mcpConnections",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* McpAuthentication;
      const view = (connection: Connection) => ({
        ...connection,
        url: mcpResource(auth.resourceOrigins.mcp[0], { mode: "model", connection: connection.id }),
      });
      return handlers
        .handle("list", () =>
          Effect.gen(function* () {
            const current = yield* owner;
            // Bring the member's bundle copies up to date before showing them.
            yield* reconcileBundles(current.resource).pipe(
              Effect.provideService(McpAuthentication, auth),
            );
            const copies = yield* copiesOf(current.resource, current.userId);
            const connections = yield* auth.connections.list(current);
            return withBundles(connections.map(view), copies);
          }),
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireCreate;
            const policy = yield* resolvePolicy(payload.apps);
            return view(
              yield* auth.connections.create(yield* owner, {
                id: payload.id,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("update", ({ params, payload }) =>
          Effect.gen(function* () {
            yield* requireOwnConnection(params.connection);
            // Check ownership before linking any account for this connection.
            const existing = yield* auth.connections.list(yield* owner);
            if (!existing.some((connection) => connection.id === params.connection))
              return yield* new ConnectionNotFound({ connection: params.connection });
            const policy = yield* resolvePolicy(payload.apps);
            return view(
              yield* auth.connections.update(yield* owner, {
                id: params.connection,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("revoke", ({ params }) =>
          requireOwnConnection(params.connection).pipe(
            Effect.andThen(owner),
            Effect.flatMap((current) => auth.connections.revoke(current, params.connection)),
          ),
        )
        .handle("agents", () =>
          Effect.flatMap(owner, (current) => auth.connections.agents(current)),
        )
        .handle("revokeAgent", ({ params }) =>
          Effect.flatMap(owner, (current) => auth.connections.revokeAgent(current, params.agent)),
        );
    }),
);
