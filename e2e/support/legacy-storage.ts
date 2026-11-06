/**
 * Legacy storage fixtures: rows that only an older product version could have written.
 * The runner applies SQL to the stopped product's own database; the next start of the
 * current server then migrates, recovers and serves over that state like an upgrade.
 * Scenarios must declare `legacyStorage: true` in the test plan. Normal setup uses public APIs.
 */
import { PGlite } from "@electric-sql/pglite";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Redacted, Schema } from "effect";
import { DriverFailed, driver, Target } from "./platform.ts";
import { Evidence } from "./evidence.ts";
import { controlRequest } from "./server-control.ts";

/**
 * A JSON object as the product stores an encrypted record: version 1, a 12-byte nonce, then
 * AES-GCM under the install's key with the record's ID as additional data. The runner seals it
 * with the key it gave the product, so a row can hold a record an earlier version wrote in a
 * shape this one does not read.
 */
export const LegacySealed = Schema.Struct({
  sealed: Schema.Struct({
    id: Schema.NonEmptyString,
    value: Schema.Record(Schema.String, Schema.Json),
  }),
});

/**
 * A keyed digest only the product's key can make, as it identifies stored credentials: the hex
 * HMAC-SHA256 of JSON `[purpose, value]` under a key derived from its encryption key.
 */
export const LegacyFingerprint = Schema.Struct({
  fingerprint: Schema.Struct({ purpose: Schema.NonEmptyString, value: Schema.String }),
});

/** One parameterized statement against the product's actual tables. */
export const LegacyStatement = Schema.Struct({
  sql: Schema.NonEmptyString,
  /**
   * The same statement for a product on SQLite, whose parameters are the same; `null` when
   * SQLite needs no counterpart. Scenarios that give every statement one declare
   * `legacyStorageSqlite` in the test plan.
   */
  sqlite: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  params: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Number,
        Schema.Boolean,
        Schema.Null,
        LegacySealed,
        LegacyFingerprint,
      ]),
    ),
  ),
});
export const LegacyStatements = Schema.NonEmptyArray(LegacyStatement);
/** Rows returned by each statement, in order. Timestamps stay as stored UTC text. */
export const LegacyResults = Schema.Array(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);

/** A fixture statement failed; the whole write was rolled back. */
export class LegacyStatementFailed extends Schema.TaggedError<LegacyStatementFailed>()(
  "LegacyStatementFailed",
  { index: Schema.Number, message: Schema.String },
) {}

/** The engine a product database runs on. */
export type LegacyEngine = "pglite" | "sqlite";

/** A database the runner writes: its engine and where it is. */
export interface LegacyTarget {
  readonly engine: LegacyEngine;
  readonly path: string;
}

/** The product database inside a runner-owned data directory. */
export const productDatabase = (
  dataDirectory: string,
  target: "self-host" | "local",
  engine: LegacyEngine = "pglite",
): LegacyTarget =>
  engine === "sqlite" && target === "self-host"
    ? { engine, path: `${dataDirectory}/hosted.sqlite/executor.db` }
    : {
        engine: "pglite",
        path: `${dataDirectory}/${target === "self-host" ? "hosted.pglite" : "executor.pglite"}`,
      };

/**
 * Which database a write targets. Local keeps MCP connections and grants in a separate MCP auth
 * database; self-host keeps them in its product database.
 */
export const LegacyDatabase = Schema.Literals(["product", "mcp-auth"]);
export type LegacyDatabase = typeof LegacyDatabase.Type;

/** The targeted database inside a runner-owned data directory, if the target has it. */
export const legacyDatabase = (
  dataDirectory: string,
  target: "self-host" | "local",
  database: LegacyDatabase,
  engine: LegacyEngine = "pglite",
): LegacyTarget | undefined =>
  database === "product"
    ? productDatabase(dataDirectory, target, engine)
    : target === "local"
      ? { engine: "pglite", path: `${dataDirectory}/mcp-auth.pglite` }
      : undefined;

/** Runner side: the envelope the product decrypts with `key`, the hex key it was given. */
const seal = (key: string, { id, value }: typeof LegacySealed.Type.sealed, index: number) =>
  Effect.gen(function* () {
    const failed = () => new LegacyStatementFailed({ index, message: "Sealing a value failed" });
    const aes = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", Uint8Array.from(Buffer.from(key, "hex")), "AES-GCM", false, [
          "encrypt",
        ]),
      catch: failed,
    });
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(id) },
          aes,
          new TextEncoder().encode(JSON.stringify(value)),
        ),
      catch: failed,
    });
    const envelope = new Uint8Array(13 + encrypted.byteLength);
    envelope[0] = 1;
    envelope.set(nonce, 1);
    envelope.set(new Uint8Array(encrypted), 13);
    return envelope;
  });

/** Runner side: the product's credential fingerprint of one value, made with `key`, the hex key. */
const fingerprint = (
  key: string,
  { purpose, value }: typeof LegacyFingerprint.Type.fingerprint,
  index: number,
) =>
  Effect.gen(function* () {
    const failed = () =>
      new LegacyStatementFailed({ index, message: "Fingerprinting a value failed" });
    const root = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "raw",
          Uint8Array.from(Buffer.from(key, "hex")),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: failed,
    });
    const derived = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign(
          "HMAC",
          root,
          new TextEncoder().encode("executor credential fingerprints"),
        ),
      catch: failed,
    });
    const hmac = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      catch: failed,
    });
    const signature = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.sign(
          "HMAC",
          hmac,
          new TextEncoder().encode(JSON.stringify([purpose, value])),
        ),
      catch: failed,
    });
    return Buffer.from(signature).toString("hex");
  });

/**
 * Runner side: apply statements in one transaction. The caller guarantees the product is stopped.
 * `key` is the encryption key the runner gave the product, for sealed and fingerprinted
 * parameters.
 */
export const applyLegacyStatements = (
  database: LegacyTarget,
  statements: typeof LegacyStatements.Type,
  key: string,
) =>
  database.engine === "sqlite"
    ? applySqliteStatements(database.path, statements, key)
    : applyPgliteStatements(database.path, statements, key);

/** A statement's parameters, with sealed and fingerprinted values made under `key`. */
const statementParams = (statement: typeof LegacyStatement.Type, key: string, index: number) =>
  Effect.forEach(
    statement.params ?? [],
    (param): Effect.Effect<Uint8Array | string | number | boolean | null, LegacyStatementFailed> =>
      typeof param !== "object" || param === null
        ? Effect.succeed(param)
        : "fingerprint" in param
          ? fingerprint(key, param.fingerprint, index)
          : seal(key, param.sealed, index),
  );

// Statements and their database errors are synthetic fixture text, safe to report.
const statementFailed = (index: number) => (cause: unknown) =>
  new LegacyStatementFailed({
    index,
    message: cause instanceof Error ? cause.message : "Unknown database error",
  });

const applyPgliteStatements = (
  database: string,
  statements: typeof LegacyStatements.Type,
  key: string,
) =>
  Effect.acquireUseRelease(
    driver("open product database", () =>
      // Match the product's codec: naive timestamps are UTC text, not local-time Dates.
      PGlite.create(database, { parsers: { 1082: (value) => value, 1114: (value) => value } }),
    ),
    (db) =>
      Effect.acquireUseRelease(
        driver("begin legacy write", () => db.exec("BEGIN")),
        () =>
          Effect.forEach(statements, (statement, index) =>
            statementParams(statement, key, index).pipe(
              Effect.flatMap((params) =>
                Effect.tryPromise({
                  try: () => db.query<Record<string, unknown>>(statement.sql, params),
                  catch: statementFailed(index),
                }),
              ),
              Effect.map((result) => result.rows),
            ),
          ),
        (_, exit) =>
          driver("finish legacy write", () =>
            db.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK"),
          ).pipe(Effect.orDie),
      ),
    (db) => driver("close product database", () => db.close()).pipe(Effect.orDie),
  );

/** A synchronous driver call, failing as `driver` does. */
const syncDriver = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new DriverFailed({ operation, cause: Redacted.make(cause) }),
  });

/** SQLite takes each statement's `sqlite` form; booleans are stored as 0 and 1. */
const applySqliteStatements = (
  database: string,
  statements: typeof LegacyStatements.Type,
  key: string,
) =>
  Effect.acquireUseRelease(
    syncDriver("open product database", () => new DatabaseSync(database)),
    (db) =>
      Effect.acquireUseRelease(
        syncDriver("begin legacy write", () => db.exec("BEGIN IMMEDIATE")),
        () =>
          Effect.forEach(statements, (statement, index) => {
            const text = statement.sqlite;
            if (text === null) return Effect.succeed([]);
            if (text === undefined)
              return Effect.fail(
                new LegacyStatementFailed({ index, message: "The statement has no SQLite form" }),
              );
            return statementParams(statement, key, index).pipe(
              Effect.flatMap((params) =>
                Effect.try({
                  try: () =>
                    db
                      .prepare(text)
                      .all(
                        ...params.map((param) =>
                          typeof param === "boolean" ? (param ? 1 : 0) : param,
                        ),
                      ) as Array<Record<string, unknown>>,
                  catch: statementFailed(index),
                }),
              ),
            );
          }),
        (_, exit) =>
          syncDriver("finish legacy write", () =>
            db.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK"),
          ).pipe(Effect.orDie),
      ),
    (db) => syncDriver("close product database", () => db.close()).pipe(Effect.orDie),
  );

/**
 * Scenario side: stop the product, apply the statements to one of its databases, and leave it
 * stopped.
 * Start it with `serverControl("start")` so the current server boots over the written state.
 */
export const legacyStorage = (
  statements: typeof LegacyStatements.Type,
  database: LegacyDatabase = "product",
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      evidence = yield* Evidence;
    if (target.metadata.target === "cloud")
      return yield* Effect.die("Legacy storage requires a runner-owned product database");
    return yield* evidence.step(
      `Legacy storage write to the ${database} database (${statements.length} statements)`,
      controlRequest("storage/legacy", 200, { statements, database }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyResults))),
        Effect.orDie,
      ),
    );
  });
