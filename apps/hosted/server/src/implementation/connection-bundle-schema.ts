/**
 * Additive storage for connection bundles. A member's copy of a bundle is an ordinary scoped
 * connection in Better Auth's `mcpConnection` table; these rows only say which bundle made it.
 * Identifiers are made by the server, so the same statements run on PostgreSQL and SQLite.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const statements = [
  `create table if not exists hosted_connection_bundles (
    id text primary key,
    organization_id text not null references organization(id) on delete cascade,
    name text not null check (length(name) between 1 and 80),
    apps text not null,
    revision text not null,
    unique (organization_id, id)
  )`,
  `create unique index if not exists hosted_connection_bundles_org_name
    on hosted_connection_bundles (organization_id, lower(name))`,
  `create table if not exists hosted_connection_bundle_groups (
    organization_id text not null,
    bundle_id text not null,
    group_id text not null,
    primary key (bundle_id, group_id),
    foreign key (organization_id, bundle_id) references hosted_connection_bundles(organization_id, id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`,
  // No foreign key to the bundle: a copy outlives its bundle until its connection is revoked.
  `create table if not exists hosted_connection_bundle_copies (
    organization_id text not null references organization(id) on delete cascade,
    bundle_id text not null,
    user_id text not null references "user"(id) on delete cascade,
    connection_id text not null unique,
    revision text not null,
    primary key (bundle_id, user_id)
  )`,
  `create index if not exists hosted_connection_bundle_copies_org
    on hosted_connection_bundle_copies (organization_id, user_id)`,
  `create table if not exists hosted_connection_settings (
    organization_id text primary key references organization(id) on delete cascade,
    members_create_connections integer not null default 1 check (members_create_connections in (0, 1))
  )`,
];

/** Hosted step 10 on both dialects: bundles, their groups, members' copies, and the setting. */
export const migrateConnectionBundles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement).unprepared;
});
