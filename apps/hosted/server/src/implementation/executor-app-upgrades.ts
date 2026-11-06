import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlite, json } from "fumadb-effect/dialect";
import { StorageError, type App, type VersionId } from "@executor-js/sdk/core";

/**
 * One-off, kept for its recorded migration steps: queued member setup for every organization when
 * member setup still redeployed the default Executor app to the current template. Member setup no
 * longer changes the app, so these jobs only link missing keys. Do not append new steps.
 *
 * Jobs start after a delay so the replacement server, not the one still serving during the
 * deployment, runs them.
 */
export const queueExecutorAppUpgrades = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`insert into hosted_provisioning (kind, organization_id, user_id, available_at)
    select distinct on (organization.id) 'member', organization.id, member."userId", now() + interval '15 minutes'
    from organization
    join member on member."organizationId" = organization.id and member.role in ('owner', 'admin')
    join "user" on "user".id = member."userId"
    where organization.metadata::jsonb -> 'executorDefaults' ->> 'deployment' is not null
    order by organization.id, "user"."emailVerified" desc, member.role = 'owner' desc, member."createdAt"`;
});

/**
 * After a data step redeploys an organization's default Executor app, record the new version
 * where the replaced one was recorded. Member setup trusts only the recorded version as
 * Executor's own; a copy recorded under another version, or none, stays as it was. The host
 * names how the step wakes webhook source reconciliation, which the new version leaves pending.
 */
export const executorDefaultRedeployed =
  (wake: Effect.Effect<void>) => (app: App, replaced: VersionId, version: VersionId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const recorded = isSqlite(sql)
        ? sql`json_set(metadata, '$.executorDefaults.deployment', ${version})`
        : sql`jsonb_set(metadata::jsonb, '{executorDefaults,deployment}', to_jsonb(${version}::text))::text`;
      yield* sql`update "organization" set metadata = ${recorded}
      where ${json(sql, "metadata")} -> 'executorDefaults' ->> 'app' = ${app.id}
        and ${json(sql, "metadata")} -> 'executorDefaults' ->> 'deployment' = ${replaced}`.pipe(
        Effect.mapError(() => new StorageError()),
      );
      // Polling recovers a missed wake.
      yield* wake;
    });
