import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { Context, Layer } from "effect";
import { translateForSqlite } from "./sqlite-translate.ts";

export interface SqliteStorage {
  readonly sql: Pick<SqlStorage, "exec">;
  readonly transaction: <T>(closure: (txn: { rollback(): void }) => Promise<T>) => Promise<T>;
}

export const sqliteParameter = (value: unknown): unknown => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value === undefined) return null;
  return value;
};

const sqliteCode = (message: string) =>
  /\b(UNIQUE|PRIMARY KEY) constraint failed\b/.test(message)
    ? "SQLITE_CONSTRAINT_UNIQUE"
    : /\bconstraint failed\b/.test(message)
      ? "SQLITE_CONSTRAINT"
      : undefined;

export const sqliteFailure = (cause: unknown, constraint?: string): unknown => {
  if (!(cause instanceof Error)) return cause;
  const code = sqliteCode(cause.message);
  if (code === undefined) return cause;
  return Object.assign(new Error(cause.message, { cause }), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
};

const uniqueIndexOf = (storage: SqliteStorage, message: string): string | undefined => {
  const listed = /UNIQUE constraint failed: (.+)$/u.exec(message)?.[1];
  if (listed === undefined || listed.startsWith("index ")) return undefined;
  const columns = listed.split(",").map((part) => part.trim());
  const table = columns[0]?.split(".")[0];
  if (table === undefined || !columns.every((column) => column.startsWith(`${table}.`)))
    return undefined;
  const names = columns.map((column) => column.slice(table.length + 1));
  try {
    const indexes = storage.sql
      .exec(`select name from pragma_index_list(?) where "unique" = 1`, table)
      .toArray() as Array<{ name: string }>;
    return indexes.find(({ name }) => {
      const indexed = storage.sql
        .exec(`select name from pragma_index_info(?) order by seqno`, name)
        .toArray() as Array<{ name: string }>;
      return (
        indexed.length === names.length &&
        indexed.every((column, index) => column.name === names[index])
      );
    })?.name;
  } catch {
    return undefined;
  }
};

type Classify = <A>(run: () => A) => A;

const classifiedBy =
  (storage: SqliteStorage): Classify =>
  (run) => {
    try {
      return run();
    } catch (cause) {
      throw sqliteFailure(
        cause,
        cause instanceof Error ? uniqueIndexOf(storage, cause.message) : undefined,
      );
    }
  };

const classifiedCursor = <C extends object>(cursor: C, classified: Classify): C =>
  new Proxy(cursor, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: Array<unknown>) => {
        const result = classified(() => Reflect.apply(value, target, args) as unknown);
        return typeof result === "object" &&
          result !== null &&
          typeof (result as Iterator<unknown>).next === "function"
          ? classifiedIterator(result as Iterator<unknown>, classified)
          : result;
      };
    },
  });

function* classifiedIterator<T>(iterator: Iterator<T>, classified: Classify): Generator<T> {
  while (true) {
    const step = classified(() => iterator.next());
    if (step.done) return;
    yield step.value;
  }
}

export const normalizedStorage = (storage: SqliteStorage): SqliteStorage => {
  const classified = classifiedBy(storage);
  return {
    sql: {
      exec: ((query: string, ...bindings: Array<unknown>) =>
        classifiedCursor(
          classified(() =>
            storage.sql.exec(translateForSqlite(query), ...bindings.map(sqliteParameter)),
          ),
          classified,
        )) as SqlStorage["exec"],
    },
    transaction: (closure) =>
      storage.transaction(closure).catch((cause: unknown) => {
        throw sqliteFailure(cause);
      }),
  };
};

export class SqliteStorageService extends Context.Service<SqliteStorageService, SqliteStorage>()(
  "fumadb-effect/SqliteStorage",
) {}

export const sqliteLayer = (storage: SqliteStorage) => {
  const normalized = normalizedStorage(storage);
  return Layer.merge(
    SqliteClient.layer({ storage: normalized as unknown as DurableObjectStorage }),
    Layer.succeed(SqliteStorageService, normalized),
  );
};
