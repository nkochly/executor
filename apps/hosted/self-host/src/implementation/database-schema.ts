/** Shared auth and product schema initialization over an acquired SQL client. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./auth-options.ts";
import {
  hostedDatabaseProvider,
  migrateHostedSchemas,
} from "@executor-js/hosted-server/migrations";
import { makeSqliteAuthDatabase } from "@executor-js/mcp-auth/sqlite-database";
import { SqlClient } from "effect/sql";
import { Effect, Layer, Option, Redacted, type Scope } from "effect";
import { SqliteStorageService } from "fumadb-effect/sqlite";
import type { Kysely } from "kysely";
import { AuthDatabase } from "../contracts/database.ts";

/**
 * Acquire one engine and initialize both schemas before exposing services. `postgres` builds the
 * auth database when the SQL client is not Durable Object SQLite; a host that only runs SQLite
 * passes none, so it never imports a PostgreSQL engine, and then refuses any other client.
 */
export const hostDatabaseSchema = <E, R>(
  postgres: Effect.Effect<Kysely<unknown>, E, R> | undefined,
) =>
  Layer.effect(
    AuthDatabase,
    Effect.gen(function* () {
      const sqlite = hostedDatabaseProvider(yield* SqlClient.SqlClient) === "sqlite";
      const storage = yield* Effect.serviceOption(SqliteStorageService);
      const database = AuthDatabase.of(
        sqlite && Option.isSome(storage)
          ? { db: yield* makeSqliteAuthDatabase(storage.value), type: "sqlite", transaction: true }
          : postgres === undefined
            ? yield* Effect.die(new Error("This host's database must be Durable Object SQLite"))
            : { db: yield* postgres, type: "postgres", transaction: true },
      );
      const settings = yield* selfHostAuthSettings;
      yield* migrateHostedSchemas({
        // Migrations read plugin schemas only. SSO adds none, so this reads no provider metadata.
        ...selfHostAuthOptions(settings, [], null),
        database,
        secret: Redacted.value(settings.secret),
      });
      return database;
    }),
  );

/** Durable Object SQLite only. */
export const sqliteDatabaseSchema = hostDatabaseSchema<never, Scope.Scope>(undefined);
