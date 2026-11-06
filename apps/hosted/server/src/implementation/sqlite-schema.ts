/**
 * The hosted product tables on SQLite, as PostgreSQL steps 1 to 9 leave them. A SQLite database is
 * always created fresh by this baseline: no PostgreSQL history is replayed or transferred, so the
 * steps' backfills (which read empty tables on a new database) have nothing to do here.
 *
 * Instants are epoch milliseconds and JSON columns are text, as FumaDB stores them on SQLite.
 * Triggers keep the PostgreSQL functions' effects; a refused API key aborts its statement.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { sqliteNow, sqliteUuid } from "fumadb-effect/dialect";

const statements = [
  `create table if not exists hosted_groups (
    id text primary key default ${sqliteUuid},
    organization_id text not null references organization(id) on delete cascade,
    name text not null check (length(name) between 1 and 80 and name = trim(name)),
    description text not null default '' check (length(description) <= 240),
    revision text not null default ${sqliteUuid}
  )`,
  `create unique index if not exists hosted_groups_org_name on hosted_groups (organization_id, lower(name))`,
  `create unique index if not exists hosted_groups_organization_identity on hosted_groups (organization_id, id)`,
  `create table if not exists hosted_group_members (
    group_id text not null references hosted_groups(id) on delete cascade,
    member_id text not null references member(id) on delete cascade,
    primary key (group_id, member_id)
  )`,
  `create index if not exists hosted_group_members_member on hosted_group_members (member_id)`,
  `create table if not exists hosted_app_access (
    id text primary key references executor_apps(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text references "user"(id) on delete set null,
    audience text not null check (audience in ('private', 'groups', 'everyone')),
    revision text not null default ${sqliteUuid},
    unique (organization_id, id)
  )`,
  `create table if not exists hosted_app_groups (
    organization_id text not null,
    app_id text not null,
    group_id text not null,
    primary key (app_id, group_id),
    foreign key (organization_id, app_id) references hosted_app_access(organization_id, id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`,
  `create table if not exists hosted_account_access (
    account_id text primary key references executor_accounts(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text references "user"(id) on delete set null,
    kind text not null check (kind in ('personal', 'shared')),
    personal_user_id text,
    audience text check (audience in ('groups', 'everyone')),
    revision text not null default ${sqliteUuid},
    check ((kind = 'personal' and personal_user_id is not null and audience is null)
      or (kind = 'shared' and personal_user_id is null and audience is not null)),
    unique (organization_id, account_id)
  )`,
  `create table if not exists hosted_account_groups (
    organization_id text not null,
    account_id text not null,
    group_id text not null,
    primary key (account_id, group_id),
    foreign key (organization_id, account_id) references hosted_account_access(organization_id, account_id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`,
  `create table if not exists hosted_connection_access (
    connection_id text primary key references executor_account_connections(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text not null references "user"(id) on delete cascade,
    destination text not null,
    target text not null
  )`,
  `create table if not exists hosted_provisioning (
    id text primary key default ${sqliteUuid},
    kind text not null constraint hosted_provisioning_kind check (kind in ('user', 'team', 'member', 'billing', 'domain')),
    organization_id text references organization(id) on delete cascade,
    user_id text references "user"(id) on delete cascade,
    status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
    attempts integer not null default 0,
    available_at integer not null default ${sqliteNow},
    updated_at integer not null default ${sqliteNow},
    constraint hosted_provisioning_subject check (
      (kind = 'user' and user_id is not null and organization_id is null)
      or (kind = 'member' and user_id is not null and organization_id is not null)
      or (kind in ('team', 'billing', 'domain') and organization_id is not null and user_id is null))
  )`,
  `create index if not exists hosted_provisioning_pending on hosted_provisioning (available_at) where status in ('queued', 'running')`,
  `create index if not exists hosted_provisioning_member on hosted_provisioning (organization_id, user_id, updated_at desc) where kind = 'member'`,
  `create trigger if not exists hosted_provision_team_insert after insert on organization for each row begin
    insert or ignore into hosted_provisioning (id, kind, organization_id) values ('team-' || new.id, 'team', new.id);
    insert into hosted_provisioning (kind, organization_id) values ('billing', new.id);
    insert into hosted_provisioning (kind, organization_id) values ('domain', new.id);
  end`,
  `create trigger if not exists hosted_provision_team_slug after update of slug on organization for each row begin
    insert into hosted_provisioning (kind, organization_id) values ('domain', new.id);
  end`,
  // Cascade deletion must not insert an event referencing a removed team.
  `create trigger if not exists hosted_provision_member_insert after insert on member for each row
    when exists (select 1 from organization where id = new."organizationId") begin
    insert into hosted_provisioning (kind, organization_id) values ('billing', new."organizationId");
    insert into hosted_provisioning (kind, organization_id, user_id) values ('member', new."organizationId", new."userId");
  end`,
  `create trigger if not exists hosted_provision_member_role after update of role on member for each row
    when exists (select 1 from organization where id = new."organizationId") begin
    insert into hosted_provisioning (kind, organization_id) values ('billing', new."organizationId");
    insert into hosted_provisioning (kind, organization_id, user_id) values ('member', new."organizationId", new."userId");
  end`,
  `create trigger if not exists hosted_provision_member_delete after delete on member for each row
    when exists (select 1 from organization where id = old."organizationId") begin
    insert into hosted_provisioning (kind, organization_id) values ('billing', old."organizationId");
  end`,
  `create trigger if not exists hosted_provision_user_insert after insert on "user" for each row
    when new."emailVerified" begin
    insert or ignore into hosted_provisioning (id, kind, user_id) values ('user-' || new.id, 'user', new.id);
    insert into hosted_provisioning (kind, organization_id, user_id)
      select 'member', "organizationId", new.id from member where "userId" = new.id;
  end`,
  `create trigger if not exists hosted_provision_user_verified after update of "emailVerified" on "user" for each row
    when new."emailVerified" and not old."emailVerified" begin
    insert or ignore into hosted_provisioning (id, kind, user_id) values ('user-' || new.id, 'user', new.id);
    insert into hosted_provisioning (kind, organization_id, user_id)
      select 'member', "organizationId", new.id from member where "userId" = new.id;
  end`,
  `create table if not exists hosted_organization_removal (
    organization_id text primary key,
    instance_id text not null,
    status text not null default 'running' check (status in ('running', 'done')),
    started_at integer not null default ${sqliteNow},
    finished_at integer,
    logo text,
    check ((status = 'done') = (finished_at is not null))
  )`,
  ...(["insert", 'update of metadata, "referenceId"'] as const).map(
    (
      event,
    ) => `create trigger if not exists hosted_api_key_membership_${event === "insert" ? "insert" : "update"}
    before ${event} on apikey for each row
    when json_valid(new.metadata) and json_extract(new.metadata, '$.organization') is not null
      and not exists (select 1 from member join organization on organization.id = member."organizationId"
        where member."organizationId" = json_extract(new.metadata, '$.organization')
          and member."userId" = new."referenceId") begin
    select raise(abort, 'Organization membership is required for this API key');
  end`,
  ),
  `create trigger if not exists hosted_member_api_key_revocation after delete on member for each row begin
    delete from apikey where "referenceId" = old."userId" and json_valid(metadata)
      and json_extract(metadata, '$.organization') = old."organizationId";
  end`,
  `create table if not exists hosted_oauth_client_access (
    client_id text primary key references executor_stored_oauth_clients(id) on delete cascade,
    organization_id text not null references organization(id) on delete cascade,
    creator_id text references "user"(id) on delete set null,
    audience text not null check (audience in ('private', 'groups', 'everyone')),
    revision text not null default ${sqliteUuid},
    unique (organization_id, client_id)
  )`,
  `create table if not exists hosted_oauth_client_groups (
    organization_id text not null,
    client_id text not null,
    group_id text not null,
    primary key (client_id, group_id),
    foreign key (organization_id, client_id) references hosted_oauth_client_access(organization_id, client_id) on delete cascade,
    foreign key (organization_id, group_id) references hosted_groups(organization_id, id) on delete cascade
  )`,
  `create table if not exists hosted_app_account_links (
    app text not null references executor_apps(id) on delete cascade,
    requirement text not null,
    subject text references "user"(id) on delete cascade,
    account text not null references executor_accounts(id) on delete cascade,
    linked_by text not null,
    created_at integer not null default ${sqliteNow}
  )`,
  `create unique index if not exists hosted_app_account_links_app
    on hosted_app_account_links (app, requirement, account) where subject is null`,
  `create unique index if not exists hosted_app_account_links_user
    on hosted_app_account_links (app, subject, requirement, account) where subject is not null`,
  `create index if not exists hosted_app_account_links_account on hosted_app_account_links (account, app)`,
];

/** Hosted step 1 on SQLite: the whole current layout. */
export const migrateSqliteBaseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement).unprepared;
});
