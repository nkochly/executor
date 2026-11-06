/**
 * One SQLite client for Durable Objects and native hosts. Both run Effect's Durable Object client
 * over the same storage contract: Cloudflare's `ctx.storage`, or a native file behind the same
 * `sql.exec` and `transaction` shape. Native tests therefore exercise the client a Worker runs.
 */
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { Context, Layer } from "effect";
import { translateForSqlite } from "./sqlite-translate.ts";

/** What the client reads of Durable Object storage. */
export interface SqliteStorage {
  readonly sql: Pick<SqlStorage, "exec">;
  readonly transaction: <T>(closure: (txn: { rollback(): void }) => Promise<T>) => Promise<T>;
}

/**
 * SQLite binds numbers, strings, bigints, bytes and null. Booleans become 0 or 1, dates their
 * epoch milliseconds (FumaDB's SQLite temporal encoding), and undefined null.
 */
export const sqliteParameter = (value: unknown): unknown => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value === undefined) return null;
  return value;
};

/**
 * Storage whose statements are read as SQLite (see `translateForSqlite`) and receive only values
 * SQLite can bind.
 */
export const normalizedStorage = (storage: SqliteStorage): SqliteStorage => ({
  sql: {
    exec: ((query: string, ...bindings: Array<unknown>) =>
      storage.sql.exec(
        translateForSqlite(query),
        ...bindings.map(sqliteParameter),
      )) as SqlStorage["exec"],
  },
  transaction: (closure) => storage.transaction(closure),
});

/**
 * The storage under the host's SQLite client, for code outside Effect SQL that must open its own
 * transactions (a Durable Object refuses `BEGIN`). It shares the client's database, not its
 * connection lock: callers hold a reservation of the client while they use it.
 */
export class SqliteStorageService extends Context.Service<SqliteStorageService, SqliteStorage>()(
  "fumadb-effect/SqliteStorage",
) {}

/** Effect SQL over Durable Object (or native) SQLite storage, with transactions. */
export const sqliteLayer = (storage: SqliteStorage) => {
  const normalized = normalizedStorage(storage);
  return Layer.merge(
    SqliteClient.layer({ storage: normalized as unknown as DurableObjectStorage }),
    Layer.succeed(SqliteStorageService, normalized),
  );
};
