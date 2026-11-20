import type { WorkerLoader } from "@cloudflare/workers-types";
import { isolatedProgram } from "@executor-js/hosted-server/mcp-isolated";
import { executionProgress, type McpBackend } from "@executor-js/mcp";
import { Effect } from "effect";
import programSandbox from "executor:program-sandbox";
import { startInIsolate } from "../src/program-isolate.ts";

interface Environment {
  readonly LOADER: WorkerLoader;
}

const emptyCatalog = new Proxy(
  {},
  {
    get: (_, operation) =>
      operation === "listApps" || operation === "listSkills"
        ? () => Effect.succeed([])
        : operation === "searchTools"
          ? () => Effect.sleep("2 seconds").pipe(Effect.as({ items: [], next: null }))
          : () => Effect.die(new Error(`The fixture has no ${String(operation)}`)),
  },
) as McpBackend<Error>;

const deadlines = {
  passes: (timeoutMs: number) => Effect.sleep(timeoutMs),
  fails: () =>
    Effect.sleep("200 millis").pipe(Effect.andThen(Effect.die(new Error("The deadline failed")))),
};

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "5000");
    const deadline = url.searchParams.get("deadline") === "fails" ? "fails" : "passes";
    const result = await Effect.runPromise(
      isolatedProgram(startInIsolate(env.LOADER, programSandbox))(code)(
        emptyCatalog,
        { timeoutMs, maxToolCalls: 10 },
        deadlines[deadline](timeoutMs),
        executionProgress(undefined),
      ),
    );
    return Response.json(result);
  },
};
