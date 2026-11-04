import { Effect } from "effect";

import { preInitializeMethodNotFound } from "@executor-js/host-mcp";

/**
 * The answer to a session-less request that is not `initialize`, or `null` to
 * hand it to the transport. Only `initialize` opens a session; any other method
 * (MCP 2026-07-28 clients open with `server/discover`) is answered -32601 so
 * the client falls back to `initialize`. The transport's own answer is a 400
 * that ends the connection before the agent's first session.
 */
export const sessionlessProbeAnswer = async (request: Request): Promise<Response | null> => {
  const unsupported = await Effect.runPromise(preInitializeMethodNotFound(request));
  if (!unsupported) return null;
  const headers = new Headers(unsupported.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(unsupported.body, { status: unsupported.status, headers });
};
