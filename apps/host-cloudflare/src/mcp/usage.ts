/**
 * One structured Workers Logs line per MCP request, the same shape wiki_mcp and Muster write:
 * `{event: "mcp_call", service, tenant, agent, subject, method, tool, status, ms}`. Workers Logs is the store and the
 * query surface; nothing here keeps state.
 */
import { Effect } from "effect";

export interface McpCall {
  readonly method: string;
  readonly tool: string | null;
}

export const mcpCalls = async (request: Request): Promise<ReadonlyArray<McpCall>> => {
  if (request.method !== "POST") return [];
  const body: unknown = await Effect.runPromise(
    Effect.tryPromise(() => request.clone().json()).pipe(Effect.orElseSucceed(() => null)),
  );
  const list: ReadonlyArray<unknown> = Array.isArray(body) ? body : [body];
  return list.flatMap((m): ReadonlyArray<McpCall> => {
    if (typeof m !== "object" || m === null) return [];
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== "string") return [];
    const tool = method === "tools/call" && typeof params?.name === "string" ? params.name : null;
    return [{ method, tool }];
  });
};

export interface McpCaller {
  readonly tenant: string;
  readonly agent: string | null;
  readonly subject: string;
}

const logLine = (
  caller: McpCaller,
  calls: ReadonlyArray<McpCall>,
  method: string,
  status: number,
  ms: number,
) => {
  for (const c of calls.length > 0 ? calls : [{ method, tool: null }]) {
    console.log(
      JSON.stringify({
        event: "mcp_call",
        service: "executor",
        ...caller,
        method: c.method,
        tool: c.tool,
        status,
        ms,
      }),
    );
  }
};

export const loggedMcp = async (
  caller: McpCaller,
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> => {
  const calls = await mcpCalls(request);
  const started = Date.now();
  return Effect.runPromise(
    Effect.tryPromise(run).pipe(
      Effect.tap((res) =>
        Effect.sync(() => logLine(caller, calls, request.method, res.status, Date.now() - started)),
      ),
      Effect.tapError(() =>
        Effect.sync(() => logLine(caller, calls, request.method, 500, Date.now() - started)),
      ),
    ),
  );
};
