import { PgliteClient } from "@effect/sql-pglite";
import { Layer } from "effect";
import { SelfHostStatementBatch } from "../contracts/statement-batch.ts";

export const pgliteStatementBatch = Layer.succeed(SelfHostStatementBatch, (leaves, { outside }) =>
  PgliteClient.pipelined(leaves, { outside, begin: "ISOLATION LEVEL REPEATABLE READ" }),
);
