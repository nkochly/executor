import { WorkerEntrypoint } from "cloudflare:workers";
import { runIsolatedProgram, type ProgramHost } from "@executor-js/hosted-server/mcp-isolated";
import type { McpLimits } from "@executor-js/mcp";

export class Program extends WorkerEntrypoint<unknown> {
  run(code: string, limits: McpLimits, host: ProgramHost): Promise<unknown> {
    return runIsolatedProgram(code, limits, host);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };

addEventListener("unhandledrejection", (event) => event.preventDefault());
