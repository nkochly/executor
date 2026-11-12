/**
 * The tool call log's SQL where PostgreSQL and SQLite differ. On PostgreSQL an instant is a
 * `timestamptz`; on SQLite it is epoch milliseconds, as every other SQLite product table stores
 * one (`sqlite-schema.ts`). Callers pass instants as epoch milliseconds and read them back as
 * `millis`. SQLite here is the Durable Object's, which has aggregate `order by` and `->>`.
 *
 * Upstream writes the log for PostgreSQL only; this module is the fork's SQLite half of it.
 */
import { isSqlite, sqliteNow } from "fumadb-effect/dialect";
import type { SqlClient, Statement } from "effect/sql";

type Sql = SqlClient.SqlClient;

/** An instant parameter, given in epoch milliseconds. */
export const instant = (sql: Sql, millis: number | null): Statement.Fragment =>
  isSqlite(sql)
    ? sql`${millis}`
    : sql`${millis === null ? null : new Date(millis).toISOString()}::timestamptz`;

/** A text parameter that may be null; PostgreSQL needs its type named. */
export const text = (sql: Sql, value: string | null): Statement.Fragment =>
  isSqlite(sql) ? sql`${value}` : sql`${value}::text`;

/** An integer parameter that may be null. */
export const integer = (sql: Sql, value: number | null): Statement.Fragment =>
  isSqlite(sql) ? sql`${value}` : sql`${value}::integer`;

/** An instant column as epoch milliseconds. */
export const millis = (sql: Sql, column: Statement.Fragment): Statement.Fragment =>
  isSqlite(sql) ? sql`(${column})` : sql`(extract(epoch from ${column}) * 1000)::float8`;

/** The current instant minus `days`. */
export const daysAgo = (sql: Sql, days: number): Statement.Fragment =>
  sql.literal(
    isSqlite(sql)
      ? `(${sqliteNow} - ${Math.trunc(days) * 86_400_000})`
      : `(now() - make_interval(days => ${Math.trunc(days)}))`,
  );

/** The current instant. */
export const current = (sql: Sql): Statement.Fragment =>
  sql.literal(isSqlite(sql) ? sqliteNow : "now()");

/** The first `length` characters of `expression`. */
export const prefix = (sql: Sql, expression: Statement.Fragment, length: number) =>
  isSqlite(sql) ? sql`substr(${expression}, 1, ${length})` : sql`left(${expression}, ${length})`;

/**
 * Case-insensitive match of `pattern`, whose `\`, `%` and `_` are escaped with a backslash.
 * SQLite folds case for ASCII only.
 */
export const matches = (
  sql: Sql,
  column: Statement.Fragment,
  pattern: string | null,
): Statement.Fragment =>
  isSqlite(sql) ? sql`${column} like ${pattern} escape '\\'` : sql`${column} ilike ${pattern}`;

/** The elements of a JSON array of strings, as a one-column subquery. */
export const jsonStrings = (sql: Sql, array: string): Statement.Fragment =>
  isSqlite(sql)
    ? sql`select value from json_each(${array})`
    : sql`select jsonb_array_elements_text(${array}::jsonb)`;

/** A count as an integer. */
export const countAll = (sql: Sql): Statement.Fragment =>
  sql.literal(isSqlite(sql) ? "count(*)" : "count(*)::int");

/** Of a group's rows, `column` of the one that started last (`c.started_at`). */
export const latest = (sql: Sql, column: string): Statement.Fragment =>
  sql.literal(
    isSqlite(sql)
      ? `(json_group_array(${column} order by c.started_at desc) ->> '$[0]')`
      : `(array_agg(${column} order by c.started_at desc))[1]`,
  );

/** A started-at instant as text to the microsecond, `YYYY-MM-DDTHH:MM:SS.ffffffZ`, for a cursor. */
export const cursorInstant = (sql: Sql, column: string): Statement.Fragment =>
  sql.literal(
    isSqlite(sql)
      ? `(strftime('%Y-%m-%dT%H:%M:%S', ${column} / 1000, 'unixepoch') || '.' || printf('%03d', ${column} % 1000) || '000Z')`
      : `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  );

/** A cursor's instant as a parameter: SQLite keeps milliseconds, so the microseconds are zero. */
export const cursorParameter = (sql: Sql, value: string): Statement.Fragment =>
  isSqlite(sql) ? sql`${Date.parse(`${value.slice(0, 23)}Z`)}` : sql`${value}::timestamptz`;

/**
 * A call's accounts as JSON text, those `shown` to the reader first: each with its ID and name
 * only when shown, and whether it was shared.
 */
export const accountsJson = (sql: Sql, shown: Statement.Fragment): Statement.Fragment =>
  isSqlite(sql)
    ? sql`(select json_group_array(json(entry)) from (select json_object(
              'id', case when ${shown} then a.account_id end,
              'name', case when ${shown} then a.account_name end,
              'shared', json(case when a.shared then 'true' else 'false' end)) as entry
            from hosted_tool_call_accounts a where a.call_id = c.id
            order by ${shown} desc, case when ${shown} then a.account_name end))`
    : sql`coalesce((select json_agg(json_build_object(
                'id', case when ${shown} then a.account_id end,
                'name', case when ${shown} then a.account_name end,
                'shared', a.shared)
              order by ${shown} desc, case when ${shown} then a.account_name end)
            from hosted_tool_call_accounts a where a.call_id = c.id), '[]'::json)::text`;
