import { Effect } from "effect";

import type { McpResource } from "@executor-js/host-mcp";

/**
 * An agent whose name starts with this is a timeout drill: reading its direct
 * integrations' tool lists never answers, so a person can see in their client
 * exactly what an agent is told when Executor cannot load a connection's
 * tools. Only that agent's own sessions are affected.
 */
export const TIMEOUT_DRILL_AGENT_PREFIX = "test-timeout";

export const timeoutDrillTools = <T extends { readonly list: (...args: never[]) => unknown }>(
  sessionMeta: { readonly resource?: McpResource },
  tools: T,
): T =>
  sessionMeta.resource?.kind === "toolkit" &&
  sessionMeta.resource.slug.startsWith(TIMEOUT_DRILL_AGENT_PREFIX)
    ? { ...tools, list: () => Effect.never }
    : tools;
