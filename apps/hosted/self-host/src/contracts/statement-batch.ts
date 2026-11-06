/**
 * How a tool call's statements go out together on this host's database, when it can send them
 * as one batch. Set by the PGlite database layer; unset on SQLite, which runs in the product's
 * own process and has no round trip to save.
 */
import { Context } from "effect";
import type { StatementBatch } from "@executor-js/hosted-server";

export const SelfHostStatementBatch = Context.Reference<
  Context.Service.Shape<typeof StatementBatch>
>("self-host/StatementBatch", { defaultValue: () => undefined });
