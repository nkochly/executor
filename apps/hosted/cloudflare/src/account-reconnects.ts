import { AccountId, OwnerId, type Executor } from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";

export const AccountToReconnect = Schema.Struct({
  account: Schema.String,
  label: Schema.String,
  owner: Schema.String,
  provider: Schema.String,
});
export type AccountToReconnect = typeof AccountToReconnect.Type;

const Row = Schema.Struct({
  account: AccountId,
  label: Schema.String,
  owner: OwnerId,
  provider: Schema.String,
  definition: Schema.NullOr(Schema.String),
});

const ProviderName = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));
const providerName = Schema.decodeUnknownOption(ProviderName);

export const accountsToReconnect = (
  sql: SqlClient.SqlClient,
  signIn: Executor["accounts"]["signIn"],
) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      select a.id as account, a.label as label, a.owner as owner, a.provider as provider,
        p.definition as definition
      from executor_accounts a
      left join executor_providers p on p.id = a.provider
      order by a.id`;
    const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
    const ended = yield* Effect.filter(
      accounts,
      (row) =>
        signIn({ account: row.account, owner: row.owner }).pipe(
          Effect.map((signedIn) => signedIn.state === "reconnect"),
          Effect.catchTag("AccountNotFound", () => Effect.succeed(false)),
        ),
      { concurrency: 8 },
    );
    return ended.map((row): AccountToReconnect => ({
      account: row.account,
      label: row.label,
      owner: row.owner,
      provider: Option.match(providerName(row.definition), {
        onNone: () => row.provider,
        onSome: (named) => named.name,
      }),
    }));
  });
