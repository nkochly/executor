/**
 * The isolate one `execute` program runs in. The session object that admitted the program loads
 * this module as a Dynamic Worker of its own for each program, with no network and a CPU budget,
 * and calls `run`; the program reaches its backend, deadline and progress only through `host`.
 * `scripts/generate.ts` bundles it into the module the Worker imports as `executor:program-sandbox`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { runIsolatedProgram, type ProgramHost } from "@executor-js/hosted-server/mcp-isolated";
import type { McpLimits } from "@executor-js/mcp";

export class Program extends WorkerEntrypoint<unknown> {
  run(code: string, limits: McpLimits, host: ProgramHost): Promise<unknown> {
    return runIsolatedProgram(code, limits, host);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };

// Work a finished program left waiting is interrupted and rejects with no one to hear it. The
// isolate exists for this one program and its result has already crossed, so that is not an error.
addEventListener("unhandledrejection", (event) => event.preventDefault());
