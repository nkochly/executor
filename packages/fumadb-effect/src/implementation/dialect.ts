import { Schema, SchemaGetter } from "effect";
import type { SqlClient } from "effect/sql";

export const sqliteNow = "(cast(unixepoch('subsec') * 1000 as integer))";

export const sqliteUuid =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

export const isSqlite = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({ sqlite: () => true, orElse: () => false });

export const sqliteMaxParameters = 100;
export const maxParameters = (sql: SqlClient.SqlClient) =>
  isSqlite(sql) ? sqliteMaxParameters : 32000;

export const now = (sql: SqlClient.SqlClient) => sql.literal(isSqlite(sql) ? sqliteNow : "now()");

export const nowPlusSeconds = (sql: SqlClient.SqlClient, seconds: number) =>
  isSqlite(sql)
    ? sql.literal(`(${sqliteNow} + ${Math.round(seconds * 1000)})`)
    : sql.literal(`(now() + make_interval(secs => ${Number(seconds)}))`);

export const uuid = (sql: SqlClient.SqlClient) =>
  sql.literal(isSqlite(sql) ? sqliteUuid : "gen_random_uuid()::text");

export const isoText = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(
    isSqlite(sql)
      ? `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} / 1000.0, 'unixepoch')`
      : `(to_json(${column}) #>> '{}')`,
  );

export const SqlBoolean = Schema.Union([
  Schema.Boolean,
  Schema.Literals([0, 1]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((value: 0 | 1) => value === 1),
      encode: SchemaGetter.transform((value: boolean) => (value ? 1 : 0) as 0 | 1),
    }),
  ),
]);

export const json = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(isSqlite(sql) ? column : `${column}::jsonb`);

export const SqlJson = <S extends Schema.Top>(schema: S) =>
  Schema.Union([schema, Schema.fromJsonString(schema)]);

export const advisoryLock = (sql: SqlClient.SqlClient, key: string) =>
  isSqlite(sql) ? sql`select 1` : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

export const authNow = (sql: SqlClient.SqlClient) =>
  sql.literal(isSqlite(sql) ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "now()");

export const jsonColumns = <Row>(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<Row>,
  ...columns: ReadonlyArray<string>
): ReadonlyArray<Row> => {
  if (!isSqlite(sql)) return rows;
  return rows.map((row) => {
    const parsed: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const column of columns) {
      const value = parsed[column];
      if (typeof value !== "string") continue;
      try {
        parsed[column] = JSON.parse(value);
      } catch {}
    }
    return parsed as Row;
  });
};

export const authMillis = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(
    isSqlite(sql)
      ? `cast(unixepoch(${column}, 'subsec') * 1000 as integer)`
      : `floor(extract(epoch from ${column}) * 1000)::float8`,
  );

export const SqlDate = Schema.Union([
  Schema.Date,
  Schema.Union([Schema.Number, Schema.String]).pipe(
    Schema.decodeTo(Schema.Date, {
      decode: SchemaGetter.transform((value: number | string) => new Date(value)),
      encode: SchemaGetter.transform((value: Date) => value.getTime()),
    }),
  ),
]);
