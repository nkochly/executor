/**
 * One SQLite client for Durable Objects and native hosts. Both run Effect's Durable Object client
 * over the same storage contract: Cloudflare's `ctx.storage`, or a native file behind the same
 * `sql.exec` and `transaction` shape. Native tests therefore exercise the client a Worker runs.
 */
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

class Rollback extends Error {}

/**
 * A native SQLite file behind the Durable Object storage contract. A transaction opened inside
 * another becomes a savepoint, as nested `storage.transaction` calls are in a Durable Object.
 */
export const nativeSqliteStorage = (
  filename: string,
  /** A file that receives the text of each statement SQLite refuses, with its error. */
  trace?: string,
): SqliteStorage & { close(): void } => {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  let depth = 0;
  const exec = (query: string, ...bindings: Array<unknown>) => {
    try {
      return run(query, bindings);
    } catch (cause) {
      // Statement text only, never its values: for porting and debugging native runs.
      if (trace !== undefined)
        appendFileSync(trace, `${String(cause)}\n${query}\n----\n`, { mode: 0o600 });
      throw cause;
    }
  };
  const run = (query: string, bindings: Array<unknown>) => {
    const statement = db.prepare(query);
    const rows =
      statement.columns().length > 0
        ? (statement.all(...(bindings as Array<never>)) as Array<Record<string, unknown>>)
        : (statement.run(...(bindings as Array<never>)), []);
    const columnNames = statement.columns().map((column) => column.name);
    return {
      columnNames,
      rowsRead: rows.length,
      rowsWritten: 0,
      raw: function* () {
        for (const row of rows) yield columnNames.map((name) => row[name]);
      },
      toArray: () => rows,
      one: () => rows[0],
      next: () => ({ done: true, value: undefined }),
      [Symbol.iterator]: function* () {
        yield* rows;
      },
    };
  };
  return {
    sql: { exec: exec as unknown as SqlStorage["exec"] },
    transaction: async (closure) => {
      const savepoint = `executor_txn_${depth}`;
      db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth++;
      let rolledBack = false;
      try {
        const result = await closure({
          rollback: () => {
            rolledBack = true;
          },
        });
        if (rolledBack) throw new Rollback();
        depth--;
        db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (cause) {
        depth--;
        db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        if (cause instanceof Rollback) return undefined as never;
        throw cause;
      }
    },
    close: () => db.close(),
  };
};

/** Effect SQL over Durable Object (or native) SQLite storage, with transactions. */
export const sqliteLayer = (storage: SqliteStorage) =>
  SqliteClient.layer({
    storage: normalizedStorage(storage) as unknown as DurableObjectStorage,
  });
