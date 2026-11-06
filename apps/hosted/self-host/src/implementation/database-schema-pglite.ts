/** Durable Object SQLite, or PGlite through the shared Kysely adapter. */
import { hostDatabaseSchema } from "./database-schema.ts";
import { makeAuthDatabase } from "./auth-database.ts";

export const selfHostDatabaseSchema = hostDatabaseSchema(makeAuthDatabase);
