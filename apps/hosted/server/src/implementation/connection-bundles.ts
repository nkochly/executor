/**
 * Connection bundles. Admins save a bundle and its groups in one transaction; afterwards every
 * member of an assigned group holds a copy, a scoped connection of their own made by the server.
 * A copy lists the bundle's apps and tools and no accounts, so it runs as whatever accounts its
 * member links to each app. Copies are reconciled after every change that can move them: a bundle
 * write, a group write, and each member's own connection list.
 */
import type { ConnectionPolicy } from "@executor-js/mcp-auth/connections";
import { ConnectionId } from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import { Effect, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import {
  Bundle,
  BundleApp,
  BundleConflict,
  BundleId,
  BundleInvalid,
  BundleNotFound,
  BundleRevision,
  BundlesUnavailable,
  type BundleInput,
  type HostedConnectionView,
} from "../contracts/connection-bundles.ts";
import { GroupDatabase, GroupId } from "../contracts/groups.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  OrganizationRole,
  organizationOwner,
  type OrganizationId,
} from "../contracts/organization.ts";

const unavailable = () => new BundlesUnavailable();
const decodeRows = <A>(schema: Schema.Decoder<A>, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.mapError(unavailable));

const StoredBundle = Schema.Struct({
  id: BundleId,
  name: Schema.String,
  apps: Schema.fromJsonString(Schema.Array(BundleApp)),
  revision: BundleRevision,
});
const BundleGroup = Schema.Struct({ bundle: BundleId, group: GroupId });
const Copy = Schema.Struct({
  bundle: Schema.String,
  user: Schema.String,
  connection: ConnectionId,
  revision: Schema.String,
});
const Wanted = Schema.Struct({ bundle: BundleId, user: Schema.String });

/** The bundles of one organization with their assigned groups. */
const readBundles = (sql: SqlClient.SqlClient, organization: OrganizationId) =>
  Effect.gen(function* () {
    const bundles = yield* sql`select id, name, apps, revision from hosted_connection_bundles
      where organization_id = ${organization} order by lower(name), id`.pipe(
      Effect.flatMap((rows) => decodeRows(StoredBundle, rows)),
    );
    const groups = yield* sql`select bundle_id as bundle, group_id as "group"
      from hosted_connection_bundle_groups where organization_id = ${organization}
      order by group_id`.pipe(Effect.flatMap((rows) => decodeRows(BundleGroup, rows)));
    return bundles.map((bundle): Bundle => ({
      ...bundle,
      name: bundle.name as Bundle["name"],
      groups: groups.filter((row) => row.bundle === bundle.id).map((row) => row.group),
    }));
  });

/** Whether members who are not admins may make connections of their own. On unless set off. */
export const membersCreateConnections = (sql: SqlClient.SqlClient, organization: string) =>
  sql`select members_create_connections as allowed from hosted_connection_settings
    where organization_id = ${organization}`.pipe(
    Effect.map((rows) => {
      const value = rows[0]?.["allowed"];
      return value === undefined || value === null || Number(value) !== 0;
    }),
  );

/** Whether a connection is a member's copy of a bundle, and so may be used however the setting is. */
export const isBundleCopy = (sql: SqlClient.SqlClient, connection: string) =>
  sql`select 1 as one from hosted_connection_bundle_copies where connection_id = ${connection}`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

/**
 * Whether a member's MCP grant may be used under the organization's setting. Admins and owners
 * always may; a member may use a bundle's copy always, and anything else only while members may
 * make their own connections.
 */
export const grantPermitted = (
  sql: SqlClient.SqlClient,
  organization: string,
  role: typeof OrganizationRole.Type,
  connection: string | undefined,
) =>
  Effect.gen(function* () {
    if (role !== "member") return true;
    if (connection !== undefined && (yield* isBundleCopy(sql, connection))) return true;
    return yield* membersCreateConnections(sql, organization);
  });

/** The bundles each member of the organization should hold a copy of. */
const wantedCopies = (sql: SqlClient.SqlClient, organization: OrganizationId) =>
  sql`select distinct bg.bundle_id as bundle, m."userId" as "user"
    from hosted_connection_bundle_groups bg
    join hosted_group_members gm on gm.group_id = bg.group_id
    join member m on m.id = gm.member_id and m."organizationId" = ${organization}
    where bg.organization_id = ${organization}`.pipe(
    Effect.flatMap((rows) => decodeRows(Wanted, rows)),
  );

const copyPolicy = (apps: readonly BundleApp[]): ConnectionPolicy => ({
  apps: apps.map((app) => ({
    app: app.app,
    tools: app.tools,
    ...(app.events === undefined ? {} : { events: app.events }),
  })),
});
const newConnectionId = () => ConnectionId.make(`bundle-${crypto.randomUUID().replace(/-/gu, "")}`);

/**
 * Make each member's copies match the bundles: create the missing ones, rewrite those whose bundle
 * changed, and revoke those whose member or bundle no longer qualifies. Idempotent; a failure part
 * way leaves rows the next reconcile finishes.
 */
export const reconcileBundles = (organization: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
    const auth = yield* McpAuthentication;
    const bundles = yield* readBundles(sql, organization).pipe(
      Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
    );
    const wanted = yield* wantedCopies(sql, organization).pipe(
      Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
    );
    const copies = yield* sql`select bundle_id as bundle, user_id as "user",
      connection_id as connection, revision from hosted_connection_bundle_copies
      where organization_id = ${organization}`.pipe(
      Effect.flatMap((rows) => decodeRows(Copy, rows)),
      Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
    );
    const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
    const key = (bundle: string, user: string) => JSON.stringify([bundle, user]);
    const wantedKeys = new Set(wanted.map((row) => key(row.bundle, row.user)));
    const existing = new Map(copies.map((copy) => [key(copy.bundle, copy.user), copy]));
    const owner = (user: string) => ({ userId: user, resource: organization });

    for (const copy of copies) {
      if (wantedKeys.has(key(copy.bundle, copy.user)) && byId.has(copy.bundle as BundleId))
        continue;
      yield* auth.connections
        .revoke(owner(copy.user), copy.connection)
        .pipe(Effect.catchTag("ConnectionNotFound", () => Effect.void));
      yield* sql`delete from hosted_connection_bundle_copies
        where bundle_id = ${copy.bundle} and user_id = ${copy.user}`.pipe(
        Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
      );
    }

    for (const row of wanted) {
      const bundle = byId.get(row.bundle);
      if (bundle === undefined) continue;
      const input = { name: bundle.name, policy: copyPolicy(bundle.apps) };
      const copy = existing.get(key(row.bundle, row.user));
      if (copy !== undefined && copy.revision === bundle.revision) continue;
      // A copy whose connection is gone (revoked elsewhere) is made again under a new ID.
      const updated =
        copy === undefined
          ? false
          : yield* auth.connections.update(owner(row.user), { id: copy.connection, ...input }).pipe(
              Effect.as(true),
              Effect.catchTag("ConnectionNotFound", () => Effect.succeed(false)),
            );
      let connection = copy?.connection;
      if (!updated) {
        connection = newConnectionId();
        yield* auth.connections.create(owner(row.user), { id: connection, ...input });
      }
      yield* (
        copy === undefined
          ? sql`insert into hosted_connection_bundle_copies
              (organization_id, bundle_id, user_id, connection_id, revision)
              values (${organization}, ${row.bundle}, ${row.user}, ${connection}, ${bundle.revision})`
          : sql`update hosted_connection_bundle_copies
              set connection_id = ${connection}, revision = ${bundle.revision}
              where bundle_id = ${row.bundle} and user_id = ${row.user}`
      ).pipe(Effect.catchTag("SqlError", () => Effect.fail(unavailable())));
    }
  }).pipe(
    Effect.catchTag("ConnectionIdTaken", () => Effect.fail(unavailable())),
    Effect.catchTag("AuthenticationUnavailable", () => Effect.fail(unavailable())),
  );

/** The bundle each of a member's copies came from, keyed by connection. */
export const copiesOf = (organization: OrganizationId, user: string) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
    const rows = yield* sql`select c.connection_id as connection, b.id as id, b.name as name
      from hosted_connection_bundle_copies c
      join hosted_connection_bundles b on b.id = c.bundle_id
      where c.organization_id = ${organization} and c.user_id = ${user}`.pipe(
      Effect.flatMap((rows) =>
        decodeRows(
          Schema.Struct({ connection: Schema.String, id: BundleId, name: Schema.String }),
          rows,
        ),
      ),
      Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
    );
    return new Map(rows.map((row) => [row.connection, { id: row.id, name: row.name }]));
  });

/** Name a member's connections by the bundle each came from. */
export const withBundles = <C extends { readonly id: string }>(
  connections: readonly C[],
  copies: ReadonlyMap<string, { readonly id: BundleId; readonly name: string }>,
) =>
  connections.map((connection) => {
    const bundle = copies.get(connection.id);
    return (bundle === undefined ? connection : { ...connection, bundle }) as C &
      Pick<HostedConnectionView, "bundle">;
  });

/** The current organization, when the caller is one of its owners or admins. */
const requireAdmin = Effect.gen(function* () {
  const access = yield* CurrentOrganization;
  const user = yield* CurrentUserId;
  if (user === undefined || access.role === "member") return yield* new OrganizationForbidden();
  return access.organization;
});

const storageFailure = (error: SqlError.SqlError) =>
  Schema.is(SqlError.UniqueViolation)(error.reason)
    ? new BundleConflict({ reason: "name_taken" })
    : unavailable();

/** Check that every app and group the bundle names belongs to the organization. */
const validate = (sql: SqlClient.SqlClient, organization: OrganizationId, input: BundleInput) =>
  Effect.gen(function* () {
    const appIds = input.apps.map((app) => app.app);
    if (appIds.length > 0) {
      const found = yield* sql`select id from executor_apps
        where owner = ${organizationOwner(organization)} and ${sql.in("id", appIds)}`;
      const known = new Set(found.map((row) => String(row["id"])));
      const missing = appIds.find((id) => !known.has(id));
      if (missing !== undefined) return yield* new BundleInvalid({ reason: "app", id: missing });
    }
    if (input.groups.length > 0) {
      const found = yield* sql`select id from hosted_groups
        where organization_id = ${organization} and ${sql.in("id", input.groups)}`;
      const known = new Set(found.map((row) => String(row["id"])));
      const missing = input.groups.find((id) => !known.has(id));
      if (missing !== undefined) return yield* new BundleInvalid({ reason: "group", id: missing });
    }
  });

const saveBundle = (
  input: BundleInput,
  current?: { readonly id: BundleId; readonly revision: BundleRevision },
) =>
  Effect.gen(function* () {
    const organization = yield* requireAdmin;
    const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
    const saved = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* validate(sql, organization, input);
          const revision = BundleRevision.make(crypto.randomUUID());
          const apps = JSON.stringify(input.apps);
          let id: BundleId;
          if (current === undefined) {
            id = BundleId.make(crypto.randomUUID());
            yield* sql`insert into hosted_connection_bundles (id, organization_id, name, apps, revision)
              values (${id}, ${organization}, ${input.name}, ${apps}, ${revision})`;
          } else {
            id = current.id;
            const rows = yield* sql`select revision from hosted_connection_bundles
              where id = ${id} and organization_id = ${organization}`;
            if (rows.length === 0) return yield* new BundleNotFound();
            if (rows[0]?.["revision"] !== current.revision)
              return yield* new BundleConflict({ reason: "changed" });
            yield* sql`update hosted_connection_bundles
              set name = ${input.name}, apps = ${apps}, revision = ${revision}
              where id = ${id} and organization_id = ${organization}`;
            yield* sql`delete from hosted_connection_bundle_groups where bundle_id = ${id}`;
          }
          for (const group of input.groups)
            yield* sql`insert into hosted_connection_bundle_groups (organization_id, bundle_id, group_id)
              values (${organization}, ${id}, ${group})`;
          return { id, revision, ...input } satisfies Bundle;
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.fail(storageFailure(error))));
    yield* reconcileBundles(organization);
    return saved;
  });

const removeBundle = (id: BundleId, revision: BundleRevision) =>
  Effect.gen(function* () {
    const organization = yield* requireAdmin;
    const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`select revision from hosted_connection_bundles
            where id = ${id} and organization_id = ${organization}`;
          if (rows.length === 0) return yield* new BundleNotFound();
          if (rows[0]?.["revision"] !== revision)
            return yield* new BundleConflict({ reason: "changed" });
          yield* sql`delete from hosted_connection_bundles where id = ${id} and organization_id = ${organization}`;
        }),
      )
      .pipe(Effect.catchTag("SqlError", (error) => Effect.fail(storageFailure(error))));
    // The bundle's copies are revoked here; their rows outlive it only until then.
    yield* reconcileBundles(organization);
    return { id };
  });

const listBundles = Effect.gen(function* () {
  const access = yield* CurrentOrganization;
  const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
  const canManage = access.role !== "member";
  const bundles = yield* readBundles(sql, access.organization).pipe(
    Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
  );
  const allowed = yield* membersCreateConnections(sql, access.organization).pipe(
    Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
  );
  const choices = canManage
    ? yield* Effect.all([
        sql`select id, name from executor_apps
          where owner = ${organizationOwner(access.organization)} order by name`,
        sql`select id, name from hosted_groups
          where organization_id = ${access.organization} order by name`,
      ]).pipe(Effect.catchTag("SqlError", () => Effect.fail(unavailable())))
    : [[], []];
  const named = (rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => ({ id: String(row["id"]), name: String(row["name"]) }));
  return {
    // Members see the setting; bundles, apps and groups are an admin's to read.
    bundles: canManage ? bundles : [],
    membersCreateConnections: allowed,
    canManage,
    apps: named(choices[0]),
    groups: named(choices[1]),
  };
});

const saveSettings = (membersCreate: boolean) =>
  Effect.gen(function* () {
    const organization = yield* requireAdmin;
    const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
    const value = membersCreate ? 1 : 0;
    yield* sql`insert into hosted_connection_settings (organization_id, members_create_connections)
      values (${organization}, ${value})
      on conflict (organization_id) do update set members_create_connections = ${value}`.pipe(
      Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
    );
    return { membersCreateConnections: membersCreate };
  });

const Member = Schema.Struct({
  userId: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  role: OrganizationRole,
});

/** Every member's connections and connected agents, for an admin. */
const memberConnections = Effect.gen(function* () {
  const organization = yield* requireAdmin;
  const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
  const auth = yield* McpAuthentication;
  const members = yield* sql`select m."userId" as "userId", u.name as name, u.email as email,
      m.role as role from member m join "user" u on u.id = m."userId"
      where m."organizationId" = ${organization} order by lower(u.name), m."userId"`.pipe(
    Effect.flatMap((rows) => decodeRows(Member, rows)),
    Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
  );
  return yield* Effect.forEach(members, (member) =>
    Effect.gen(function* () {
      const owner = { userId: member.userId, resource: organization };
      const copies = yield* copiesOf(organization, member.userId);
      const connections = yield* auth.connections.list(owner);
      const view = (connection: (typeof connections)[number]) => ({
        ...connection,
        url: mcpResource(auth.resourceOrigins.mcp[0], { mode: "model", connection: connection.id }),
      });
      return {
        userId: member.userId,
        name: member.name ?? "",
        email: member.email ?? "",
        role: member.role,
        connections: withBundles(connections.map(view), copies),
        agents: yield* auth.connections.agents(owner),
      };
    }),
  );
});

/** A member of the current organization, by user ID; nobody outside it can be named. */
const memberOwner = (user: string) =>
  Effect.gen(function* () {
    const organization = yield* requireAdmin;
    const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
    const rows = yield* sql`select 1 as one from member
      where "organizationId" = ${organization} and "userId" = ${user}`.pipe(
      Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
    );
    if (rows.length === 0) return yield* new OrganizationForbidden();
    return { userId: user, resource: organization };
  });

/** Typed handlers acquire storage only after request authentication; writes need an admin. */
export const hostedConnectionBundleHandlers = HttpApiBuilder.group(
  HostedApi,
  "connectionBundles",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* McpAuthentication;
      const withAuth = Effect.provideService(McpAuthentication, auth);
      return handlers
        .handle("list", () => listBundles)
        .handle("create", ({ payload }) => withAuth(saveBundle(payload)))
        .handle("update", ({ params, payload }) =>
          withAuth(
            saveBundle(
              { name: payload.name, apps: payload.apps, groups: payload.groups },
              { id: params.bundle, revision: payload.revision },
            ),
          ),
        )
        .handle("remove", ({ params, payload }) =>
          withAuth(removeBundle(params.bundle, payload.revision)),
        )
        .handle("settings", ({ payload }) => saveSettings(payload.membersCreateConnections))
        .handle("members", () => withAuth(memberConnections))
        .handle("revokeMemberConnection", ({ params }) =>
          Effect.gen(function* () {
            const owner = yield* memberOwner(params.user);
            yield* auth.connections.revoke(owner, params.connection);
            // A revoked copy is made again unless its bundle no longer applies to the member.
            const sql = yield* Effect.flatten(GroupDatabase).pipe(Effect.mapError(unavailable));
            yield* sql`delete from hosted_connection_bundle_copies
            where connection_id = ${params.connection}`.pipe(
              Effect.catchTag("SqlError", () => Effect.fail(unavailable())),
            );
          }),
        )
        .handle("revokeMemberAgent", ({ params }) =>
          Effect.gen(function* () {
            const owner = yield* memberOwner(params.user);
            yield* auth.connections.revokeAgent(owner, params.agent);
          }),
        );
    }),
);
