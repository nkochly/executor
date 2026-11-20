import { PgliteClient } from "@effect/sql-pglite";
import { Effect, Option } from "effect";
import { hostDatabaseSchema } from "./database-schema.ts";
import { makeAuthDatabase } from "./auth-database.ts";

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
