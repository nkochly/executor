/**
 * The MCP backend wire between session objects and the product across releases. Cloudflare moves
 * a busy object to new code minutes after a deploy, so a session object and the product can run
 * different releases. A release that sends the execution and returns the tool call log's
 * reference must still serve, and be served by, one that knows neither.
 */
import { Effect } from "effect";
import { CurrentMcpExecution, ToolCallRecorded, type McpBackend } from "@executor-js/mcp";
import {
  remoteMcpBackend,
  serveMcpBackendCall,
  type McpBackendCall,
  type WireExit,
} from "@executor-js/hosted-server/mcp-remote";

interface Seen {
  execution: string | undefined;
}

/** A product backend whose `callTool` records the call under `reference` and reports its execution. */
const productBackend = (seen: Seen, reference: string) =>
  ({
    callTool: () =>
      Effect.gen(function* () {
        seen.execution = yield* CurrentMcpExecution;
        (yield* ToolCallRecorded)?.(reference);
        return { status: "completed", result: { ok: true } };
      }),
  }) as unknown as McpBackend<Error>;

/** A session object's call, as this release makes it, for execution `execution`. */
const sessionCall = (send: (call: McpBackendCall) => Promise<WireExit>, execution: string) =>
  Effect.gen(function* () {
    let recorded: string | undefined;
    const value = yield* remoteMcpBackend(send)
      .callTool({ app: "app", tool: "tool" } as never)
      .pipe(
        Effect.provideService(CurrentMcpExecution, execution),
        Effect.provideService(ToolCallRecorded, (reference) => {
          recorded = reference;
        }),
      );
    return { value, recorded };
  });

/** The product before the call log: it reads only the method and arguments, and returns no reference. */
const previousProduct = async (call: McpBackendCall): Promise<WireExit> => {
  const { reference: _reference, ...exit } = await Effect.runPromise(
    serveMcpBackendCall(productBackend({ execution: undefined }, "call_unused"), {
      method: call.method,
      args: call.args,
    }),
  );
  return exit;
};

export const run = async () => {
  const current: Seen = { execution: undefined };
  const both = await Effect.runPromise(
    sessionCall(
      (call) =>
        Effect.runPromise(serveMcpBackendCall(productBackend(current, "call_current"), call)),
      "run_current",
    ),
  );

  // A session object before the call log sends method and arguments only, and reads ok/value.
  const previous: Seen = { execution: undefined };
  const fromPreviousSession = await Effect.runPromise(
    serveMcpBackendCall(productBackend(previous, "call_previous_session"), {
      method: "callTool",
      args: [{ app: "app", tool: "tool" }],
    }),
  );

  const toPreviousProduct = await Effect.runPromise(sessionCall(previousProduct, "run_previous"));

  return {
    current: { execution: current.execution, recorded: both.recorded, value: both.value },
    previousSession: {
      execution: previous.execution,
      ok: fromPreviousSession.ok,
      value: "value" in fromPreviousSession ? fromPreviousSession.value : undefined,
    },
    previousProduct: { recorded: toPreviousProduct.recorded, value: toPreviousProduct.value },
  };
};
