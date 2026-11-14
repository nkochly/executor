/** Durable Object SQLite, or PGlite through the shared Kysely adapter. */
import { PgliteClient } from "@effect/sql-pglite";
import { Effect, Option } from "effect";
import { hostDatabaseSchema } from "./database-schema.ts";
import { makeAuthDatabase } from "./auth-database.ts";

/**
 * The PGlite auth database, built only when the engine is PGlite. A SQLite engine provides no
 * PGlite client, and `hostDatabaseSchema` never runs this effect for it.
 */
const pgliteAuthDatabase = Effect.serviceOption(PgliteClient.PgliteClient).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die(new Error("The PostgreSQL auth database needs a PGlite client")),
      onSome: (client) =>
        makeAuthDatabase.pipe(Effect.provideService(PgliteClient.PgliteClient, client)),
    }),
  ),
);

export const selfHostDatabaseSchema = hostDatabaseSchema(pgliteAuthDatabase);
