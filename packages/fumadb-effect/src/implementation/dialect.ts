/**
 * SQL expressions whose spelling differs between PostgreSQL and SQLite. SQLite stores instants as
 * epoch milliseconds, FumaDB's SQLite temporal encoding, so comparisons stay numeric.
 */
import { Schema, SchemaGetter } from "effect";
import type { SqlClient } from "effect/sql";

/** The current instant: `now()`, or epoch milliseconds on SQLite. */
export const sqliteNow = "(cast(unixepoch('subsec') * 1000 as integer))";

/** A random version 4 UUID as text, as `gen_random_uuid()::text` returns. */
export const sqliteUuid =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

/** Whether the client speaks SQLite. */
export const isSqlite = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({ sqlite: () => true, orElse: () => false });

/**
 * Most parameters one statement may bind. SQLite runs where a Durable Object or D1 limits a
 * statement to 100, far below SQLite's own default; PostgreSQL allows 65535, kept with headroom.
 */
export const sqliteMaxParameters = 100;
export const maxParameters = (sql: SqlClient.SqlClient) =>
  isSqlite(sql) ? sqliteMaxParameters : 32000;

/** The current instant in the client's dialect, for interpolation. */
export const now = (sql: SqlClient.SqlClient) => sql.literal(isSqlite(sql) ? sqliteNow : "now()");

/** The current instant plus `seconds`, in the client's dialect. */
export const nowPlusSeconds = (sql: SqlClient.SqlClient, seconds: number) =>
  isSqlite(sql)
    ? sql.literal(`(${sqliteNow} + ${Math.round(seconds * 1000)})`)
    : sql.literal(`(now() + make_interval(secs => ${Number(seconds)}))`);

/** A new UUID in the client's dialect. */
export const uuid = (sql: SqlClient.SqlClient) =>
  sql.literal(isSqlite(sql) ? sqliteUuid : "gen_random_uuid()::text");

/** An instant column as ISO 8601 text, as PostgreSQL's `to_json(column) #>> '{}'` returns it. */
export const isoText = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(
    isSqlite(sql)
      ? `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} / 1000.0, 'unixepoch')`
      : `(to_json(${column}) #>> '{}')`,
  );

/** A boolean result: PostgreSQL returns booleans, SQLite 0 or 1. */
export const SqlBoolean = Schema.Union([
  Schema.Boolean,
  Schema.Literals([0, 1]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((value: 0 | 1) => value === 1),
      encode: SchemaGetter.transform((value: boolean) => (value ? 1 : 0) as 0 | 1),
    }),
  ),
]);

/** A JSON text column for `->` and `->>`: cast to jsonb on PostgreSQL, as is on SQLite. */
export const json = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(isSqlite(sql) ? column : `${column}::jsonb`);

/** A JSON result: PostgreSQL's driver parses json and jsonb, SQLite returns the text. */
export const SqlJson = <S extends Schema.Top>(schema: S) =>
  Schema.Union([schema, Schema.fromJsonString(schema)]);

/**
 * A transaction-scoped advisory lock on `key`. A SQLite transaction already excludes every other
 * writer, so it takes none.
 */
export const advisoryLock = (sql: SqlClient.SqlClient, key: string) =>
  isSqlite(sql) ? sql`select 1` : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/**
 * The current instant for Better Auth's tables. Its SQLite adapter stores instants as ISO 8601
 * text, unlike FumaDB's epoch milliseconds.
 */
export const authNow = (sql: SqlClient.SqlClient) =>
  sql.literal(isSqlite(sql) ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : "now()");

/**
 * Rows with these JSON columns parsed, as PostgreSQL's driver returns json and jsonb. SQLite
 * returns the text; unreadable text is left for the caller's schema to refuse.
 */
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
      } catch {
        // Kept as text: the schema decides.
      }
    }
    return parsed as Row;
  });
};

/**
 * Epoch milliseconds of a Better Auth instant column, truncated as the PostgreSQL driver truncates
 * it into a `Date`. SQLite stores it as ISO 8601 text.
 */
export const authMillis = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(
    isSqlite(sql)
      ? `cast(unixepoch(${column}, 'subsec') * 1000 as integer)`
      : `floor(extract(epoch from ${column}) * 1000)::float8`,
  );

/**
 * An instant result: PostgreSQL's driver returns a `Date`, SQLite the stored epoch milliseconds
 * (FumaDB and hosted tables) or ISO 8601 text (Better Auth tables).
 */
export const SqlDate = Schema.Union([
  Schema.Date,
  Schema.Union([Schema.Number, Schema.String]).pipe(
    Schema.decodeTo(Schema.Date, {
      decode: SchemaGetter.transform((value: number | string) => new Date(value)),
      encode: SchemaGetter.transform((value: Date) => value.getTime()),
    }),
  ),
]);
