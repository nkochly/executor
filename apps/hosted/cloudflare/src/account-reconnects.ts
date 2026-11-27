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
  account: Schema.String,
  label: Schema.String,
  owner: Schema.String,
  provider: Schema.String,
  definition: Schema.NullOr(Schema.String),
});

const ProviderName = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));
const providerName = Schema.decodeUnknownOption(ProviderName);

export const accountsToReconnect = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql`
      select a.id as account, a.label as label, a.owner as owner, a.provider as provider,
        p.definition as definition
      from executor_accounts a
      join executor_oauth_grants g on g.id = a.id
      left join executor_providers p on p.id = a.provider
      where g.status = 'reconnect'
      order by a.id`;
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows);
    return decoded.map((row): AccountToReconnect => ({
      account: row.account,
      label: row.label,
      owner: row.owner,
      provider: Option.match(providerName(row.definition), {
        onNone: () => row.provider,
        onSome: (named) => named.name,
      }),
    }));
  });
