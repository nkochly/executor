/** Promise boundary required by Better Auth's Kysely driver, over a host-owned SQLite client. */
import { Effect, Exit, Scope, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqliteStorage } from "fumadb-effect/sqlite";
import type { Connection } from "effect/sql/SqlConnection";
import {
  type CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";

/** A SQLite auth database operation failed; driver details remain private. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "AuthDatabaseUnavailable",
  { stage: Schema.Literal("query") },
) {}

/** SQLite reports the rows a write changed through `changes()` on the same connection. */
const changedRows = (connection: Connection) =>
  connection
    .execute("select changes() as changed", [], undefined)
    .pipe(Effect.map((rows) => BigInt(Number((rows[0] as { changed?: unknown })?.changed ?? 0))));

const isRead = (sql: string) =>
  /^\s*(select|with|pragma)\b/iu.test(sql) || /\breturning\b/iu.test(sql);

/**
 * Reserve Effect's connection for each Kysely checkout, including its entire transaction. A SQLite
 * client has one connection, so a reservation also excludes every other statement until Kysely
 * releases it: auth queries cannot join or commit another SDK operation's transaction.
 */
export const makeSqliteAuthDatabase = (storage: SqliteStorage) =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    // Open transactions through storage: a Durable Object refuses `BEGIN`. Each ends when Kysely
    // commits or rolls back on the connection that began it.
    const open = new Map<DatabaseConnection, { end: (rollback: boolean) => Promise<void> }>();
    const owner = yield* Effect.scope;
    const releases = new Map<DatabaseConnection, () => Promise<void>>();
    const run = <R>(connection: Connection, query: CompiledQuery): Promise<QueryResult<R>> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const parameters = query.parameters.map((value) =>
            typeof value === "boolean" ? (value ? 1 : 0) : value,
          );
          const rows = (yield* connection.execute(query.sql, parameters, undefined)) as Array<R>;
          if (isRead(query.sql)) return { rows };
          return { rows, numAffectedRows: yield* changedRows(connection) };
        }).pipe(Effect.mapError(() => new DatabaseUnavailable({ stage: "query" }))),
      );
    const driver: Driver = {
      init: () => Promise.resolve(),
      acquireConnection: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const scope = yield* Scope.fork(owner, "sequential");
            const reserved = yield* client.reserve.pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
            );
            const connection: DatabaseConnection = {
              executeQuery: <R>(query: CompiledQuery) => run<R>(reserved, query),
              async *streamQuery<R>(query: CompiledQuery) {
                yield await run<R>(reserved, query);
              },
            };
            releases.set(connection, () => Effect.runPromise(Scope.close(scope, Exit.void)));
            return connection;
          }),
        ),
      beginTransaction: async (connection) => {
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        let finish!: (rollback: boolean) => void;
        const done = storage.transaction(
          (txn) =>
            new Promise<void>((resolve) => {
              finish = (rollback) => {
                if (rollback) txn.rollback();
                resolve();
              };
              started();
            }),
        );
        await ready;
        open.set(connection, {
          end: async (rollback) => {
            open.delete(connection);
            finish(rollback);
            await done;
          },
        });
      },
      commitTransaction: async (connection) => {
        await open.get(connection)?.end(false);
      },
      rollbackTransaction: async (connection) => {
        await open.get(connection)?.end(true);
      },
      releaseConnection: async (connection) => {
        const release = releases.get(connection);
        if (release === undefined) return;
        releases.delete(connection);
        await release();
      },
      destroy: async () => {
        for (const connection of Array.from(releases.keys()))
          await driver.releaseConnection(connection);
      },
    };
    return yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Kysely<unknown>({
            dialect: {
              createDriver: () => driver,
              createAdapter: () => new SqliteAdapter(),
              createIntrospector: (db) => new SqliteIntrospector(db),
              createQueryCompiler: () => new SqliteQueryCompiler(),
            },
          }),
      ),
      (db) => Effect.promise(() => db.destroy()),
    );
  });
