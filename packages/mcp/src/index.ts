/** Shared Effect MCP surface. Authentication and authorization belong to the host. */
export * from "./contracts/backend.ts";
export * from "./contracts/execute.ts";
export * from "./contracts/elicitation.ts";
export * from "./contracts/skills.ts";
export * from "./contracts/tools.ts";
export * from "./contracts/telemetry.ts";
export { mcp, makeMcp } from "./implementation/server.ts";
export { skills } from "./implementation/skills.ts";
export { activePrograms, makeExecutions, runningPrograms } from "./implementation/executions.ts";
export { refusedMcpRequest } from "./implementation/diagnostics.ts";
export {
  executeProgram,
  executionProgress,
  programFailure,
  type ExecutionProgress,
  type Program,
} from "./implementation/execute.ts";

export * from "./contracts/browser.ts";
export * from "./contracts/browser-tools.ts";

export * from "./contracts/targets.ts";
