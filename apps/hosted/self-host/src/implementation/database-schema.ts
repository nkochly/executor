/** Shared auth and product schema initialization over an acquired SQL client. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./auth-options.ts";
import {
  hostedDatabaseProvider,
  migrateHostedSchemas,
} from "@executor-js/hosted-server/migrations";
import { makeSqliteAuthDatabase } from "@executor-js/mcp-auth/sqlite-database";
import { SqlClient } from "effect/sql";
import { Effect, Layer, Option, Redacted } from "effect";
import { SqliteStorageService } from "fumadb-effect/sqlite";
import { AuthDatabase } from "../contracts/database.ts";
import { makeAuthDatabase } from "./auth-database.ts";
/** Acquire one engine and initialize both schemas before exposing services. */
export const selfHostDatabaseSchema = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const sqlite = hostedDatabaseProvider(yield* SqlClient.SqlClient) === "sqlite";
    const storage = yield* Effect.serviceOption(SqliteStorageService);
    const database = AuthDatabase.of(
      sqlite && Option.isSome(storage)
        ? { db: yield* makeSqliteAuthDatabase(storage.value), type: "sqlite", transaction: true }
        : { db: yield* makeAuthDatabase, type: "postgres", transaction: true },
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
