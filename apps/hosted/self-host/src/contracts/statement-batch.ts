import { Context } from "effect";
import type { StatementBatch } from "@executor-js/hosted-server";

export const SelfHostStatementBatch = Context.Reference<
  Context.Service.Shape<typeof StatementBatch>
>("self-host/StatementBatch", { defaultValue: () => undefined });
