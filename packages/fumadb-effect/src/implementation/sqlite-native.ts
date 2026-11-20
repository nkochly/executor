import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { sqliteMaxParameters } from "./dialect.ts";
import type { SqliteStorage } from "./sqlite.ts";

class Rollback extends Error {}

export const nativeSqliteStorage = (
  filename: string,
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
      if (trace !== undefined)
        appendFileSync(trace, `${String(cause)}\n${query}\n----\n`, { mode: 0o600 });
      throw cause;
    }
  };
  const run = (query: string, bindings: Array<unknown>) => {
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
        db.exec(outermost ? "COMMIT" : `RELEASE ${savepoint}`);
        depth--;
        return result;
      } catch (cause) {
        depth--;
        if (db.isTransaction)
          db.exec(outermost ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        if (cause instanceof Rollback) return undefined as never;
        throw cause;
      }
    },
    close: () => db.close(),
  };
};
