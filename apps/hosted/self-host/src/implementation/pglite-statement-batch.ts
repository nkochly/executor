/**
 * PGlite runs in-process, so reads issued together cost no extra connection. A tool call's
 * statements run together under the client's lock, its reads in one snapshot, as in Cloud. Not
 * read-only: a statement another caller handed to PGlite just before the lock can still run inside
 * the transaction, as with any PGlite transaction, and must not fail there.
 */
import { PgliteClient } from "@effect/sql-pglite";
import { Layer } from "effect";
import { SelfHostStatementBatch } from "../contracts/statement-batch.ts";

export const pgliteStatementBatch = Layer.succeed(SelfHostStatementBatch, (leaves, { outside }) =>
  PgliteClient.pipelined(leaves, { outside, begin: "ISOLATION LEVEL REPEATABLE READ" }),
);
