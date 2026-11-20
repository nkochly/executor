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

const productBackend = (seen: Seen, reference: string) =>
  ({
    callTool: () =>
      Effect.gen(function* () {
        seen.execution = yield* CurrentMcpExecution;
        (yield* ToolCallRecorded)?.(reference);
        return { status: "completed", result: { ok: true } };
      }),
  }) as unknown as McpBackend<Error>;

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
