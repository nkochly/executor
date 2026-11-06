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
 * The SQLite result code of a failure, as Effect's `classifySqliteError` reads it. A Durable
 * Object reports only the message, and node:sqlite its own code; both name constraint failures
 * in the message. A primary key conflict is a unique violation, as it is in Postgres.
 */
const sqliteCode = (message: string) =>
  /\b(UNIQUE|PRIMARY KEY) constraint failed\b/.test(message)
    ? "SQLITE_CONSTRAINT_UNIQUE"
    : /\bconstraint failed\b/.test(message)
      ? "SQLITE_CONSTRAINT"
      : undefined;

/**
 * The failure with the code Effect classifies it by, when its message names one, and the
 * constraint it broke when known.
 */
export const sqliteFailure = (cause: unknown, constraint?: string): unknown => {
  if (!(cause instanceof Error)) return cause;
  const code = sqliteCode(cause.message);
  if (code === undefined) return cause;
  return Object.assign(new Error(cause.message, { cause }), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
};

/**
 * A unique violation names its columns (`t.a, t.b`), not the index that holds them, where
 * Postgres names the constraint callers match. That name is the table's unique index over
 * exactly those columns, in order.
 */
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

/** A cursor whose methods and iterators fail with classified errors (a cursor may step lazily). */
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

/**
 * Storage whose statements are read as SQLite (see `translateForSqlite`), receive only values
 * SQLite can bind, and fail with errors Effect classifies (unique and other constraint
 * violations).
 */
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
