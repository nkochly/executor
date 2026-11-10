/** A native SQLite file behind the Durable Object storage contract, for Node and Bun hosts. */
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { sqliteMaxParameters } from "./dialect.ts";
import type { SqliteStorage } from "./sqlite.ts";

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
    // A Durable Object refuses these; a native file would accept them and hide the failure.
    if (bindings.length > sqliteMaxParameters)
      throw new Error(
        `too many SQL variables: ${bindings.length} bound, at most ${sqliteMaxParameters}: SQLITE_ERROR`,
      );
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
      const outermost = depth === 0;
      db.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth++;
      let rolledBack = false;
      try {
        const result = await closure({
          rollback: () => {
            rolledBack = true;
          },
        });
        if (rolledBack) throw new Rollback();
        // A refused COMMIT (a deferred foreign key) leaves the transaction open: the catch
        // rolls it back.
        db.exec(outermost ? "COMMIT" : `RELEASE ${savepoint}`);
        depth--;
        return result;
      } catch (cause) {
        depth--;
        // SQLite may already have rolled the transaction back (a busy or full database).
        if (db.isTransaction)
          db.exec(outermost ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        if (cause instanceof Rollback) return undefined as never;
        throw cause;
      }
    },
    close: () => db.close(),
  };
};
