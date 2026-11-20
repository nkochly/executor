import { isSqlite } from "fumadb-effect/dialect";
import type { SqlClient, Statement } from "effect/sql";

type Sql = SqlClient.SqlClient;

export const instant = (sql: Sql, millis: number | null): Statement.Fragment =>
  isSqlite(sql)
    ? sql`${millis}`
    : sql`${millis === null ? null : new Date(millis).toISOString()}::timestamptz`;

export const text = (sql: Sql, value: string | null): Statement.Fragment =>
  isSqlite(sql) ? sql`${value}` : sql`${value}::text`;

export const integer = (sql: Sql, value: number | null): Statement.Fragment =>
  isSqlite(sql) ? sql`${value}` : sql`${value}::integer`;

export const millis = (sql: Sql, column: Statement.Fragment): Statement.Fragment =>
  isSqlite(sql) ? sql`(${column})` : sql`(extract(epoch from ${column}) * 1000)::float8`;

export const prefix = (sql: Sql, expression: Statement.Fragment, length: number) =>
  isSqlite(sql) ? sql`substr(${expression}, 1, ${length})` : sql`left(${expression}, ${length})`;

export const matches = (
  sql: Sql,
  column: Statement.Fragment,
  pattern: string | null,
): Statement.Fragment =>
  isSqlite(sql) ? sql`${column} like ${pattern} escape '\\'` : sql`${column} ilike ${pattern}`;

export const jsonStrings = (sql: Sql, array: string): Statement.Fragment =>
  isSqlite(sql)
    ? sql`select value from json_each(${array})`
    : sql`select jsonb_array_elements_text(${array}::jsonb)`;

export const countAll = (sql: Sql): Statement.Fragment =>
  sql.literal(isSqlite(sql) ? "count(*)" : "count(*)::int");

export const latest = (sql: Sql, column: string): Statement.Fragment =>
  sql.literal(
    isSqlite(sql)
      ? `(json_group_array(${column} order by c.started_at desc) ->> '$[0]')`
      : `(array_agg(${column} order by c.started_at desc))[1]`,
  );

export const cursorInstant = (sql: Sql, column: string): Statement.Fragment =>
  sql.literal(
    isSqlite(sql)
      ? `(strftime('%Y-%m-%dT%H:%M:%S', ${column} / 1000, 'unixepoch') || '.' || printf('%03d', ${column} % 1000) || '000Z')`
      : `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  );

export const cursorParameter = (sql: Sql, value: string): Statement.Fragment =>
  isSqlite(sql) ? sql`${Date.parse(`${value.slice(0, 23)}Z`)}` : sql`${value}::timestamptz`;

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
