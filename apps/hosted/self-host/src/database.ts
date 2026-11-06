/** One persisted PGlite engine for self-host auth and product data. */
import { Config, Effect, FileSystem, Layer, Option, Path } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { sqliteLayer } from "fumadb-effect/sqlite";
import { nativeSqliteStorage } from "fumadb-effect/sqlite-native";
import { lock } from "proper-lockfile";
import { dataDirectory } from "./contracts/config.ts";
import { DatabaseUnavailable } from "./contracts/database.ts";
import { selfHostDatabaseSchema } from "./implementation/database-schema.ts";

const databaseDirectory = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configured = yield* dataDirectory;
    const directory = path.resolve(configured, name);
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => new DatabaseUnavailable({ stage: "directory" })));
    yield* fs
      .chmod(directory, 0o700)
      .pipe(Effect.mapError(() => new DatabaseUnavailable({ stage: "directory" })));
    // Heartbeat lock recovers after a crash, while rejecting concurrent processes.
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => lock(directory, { retries: 0 }),
        catch: () => new DatabaseUnavailable({ stage: "lock" }),
      }),
      (unlock) => Effect.promise(() => unlock()),
    );
    return directory;
  });

/**
 * The SQLite engine a Durable Object runs, over a local file in place of `ctx.storage`. The file
 * sits in its own locked directory, as the PGlite data directory does.
 */
const sqliteDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = yield* databaseDirectory("hosted.sqlite");
    // `EXECUTOR_SQLITE_TRACE` names a file for the text of statements SQLite refuses.
    const trace = yield* Config.String("EXECUTOR_SQLITE_TRACE").pipe(Config.option);
    const storage = yield* Effect.acquireRelease(
      Effect.sync(() =>
        nativeSqliteStorage(path.join(directory, "executor.db"), Option.getOrUndefined(trace)),
      ),
      (opened) => Effect.sync(() => opened.close()),
    );
    return sqliteLayer(storage);
  }),
);

/** `EXECUTOR_DATABASE=sqlite` stores everything in SQLite, as the Cloudflare host does. */
const databaseEngine = Config.Literals(["pglite", "sqlite"], "EXECUTOR_DATABASE").pipe(
  Config.withDefault("pglite"),
);

/** Acquire the native engine before exposing migrated auth and product services. */
export const selfHostDatabase = selfHostDatabaseSchema.pipe(
  Layer.provideMerge(
    Layer.unwrap(
      Effect.map(databaseEngine, (engine) =>
        engine === "sqlite"
          ? sqliteDatabase
          : Layer.unwrap(
              Effect.map(databaseDirectory("hosted.pglite"), (dataDir) => pgliteLayer({ dataDir })),
            ),
      ),
    ),
  ),
);
