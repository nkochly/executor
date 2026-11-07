/**
 * One structured Workers Logs line and one trace span per MCP request, the same shape wiki_mcp and Muster write:
 * `{event: "mcp_call", service, tenant, agent, subject, method, tool, status, ms, trace_id}`. Workers Logs and
 * traces are the store and the query surface; nothing here keeps state. `trace_id` is `trifecta.trace_id`
 * (./trace.ts), the id wiki and Muster log for the calls Executor makes on this request's behalf.
 */
import { Effect } from "effect";

import { activeContext, inSpan, parseTraceparent } from "./trace";

export interface McpCall {
  readonly method: string;
  readonly tool: string | null;
  /** The trace id of the caller's own `_meta.traceparent`, when it sent a valid one. */
  readonly clientTraceId?: string;
}

export const mcpCalls = async (request: Request): Promise<ReadonlyArray<McpCall>> => {
  if (request.method !== "POST") return [];
  const body: unknown = await Effect.runPromise(
    Effect.tryPromise(() => request.clone().json()).pipe(Effect.orElseSucceed(() => null)),
  );
  const list: ReadonlyArray<unknown> = Array.isArray(body) ? body : [body];
  return list.flatMap((m): ReadonlyArray<McpCall> => {
    if (typeof m !== "object" || m === null) return [];
    const { method, params } = m as {
      method?: unknown;
      params?: { name?: unknown; _meta?: { traceparent?: unknown } };
    };
    if (typeof method !== "string") return [];
    const tool = method === "tools/call" && typeof params?.name === "string" ? params.name : null;
    const client = parseTraceparent(params?._meta?.traceparent);
    return [{ method, tool, ...(client ? { clientTraceId: client.traceId } : {}) }];
  });
};

export interface McpCaller {
  readonly tenant: string;
  readonly agent: string | null;
  readonly subject: string;
}

interface Outcome {
  readonly status: number;
  readonly ms: number;
  readonly traceId: string | null;
}

const logLine = (
  caller: McpCaller,
  calls: ReadonlyArray<McpCall>,
  method: string,
  outcome: Outcome,
) => {
  const lines: ReadonlyArray<McpCall> = calls.length > 0 ? calls : [{ method, tool: null }];
  for (const c of lines) {
    console.log(
      JSON.stringify({
        event: "mcp_call",
        service: "executor",
        ...caller,
        method: c.method,
        tool: c.tool,
        status: outcome.status,
        ms: outcome.ms,
        ...(outcome.traceId ? { trace_id: outcome.traceId } : {}),
        ...(c.clientTraceId ? { client_trace_id: c.clientTraceId } : {}),
      }),
    );
  }
};

/** The span name the OpenTelemetry MCP conventions give: `{mcp.method.name} {tool}`, or the method alone. */
const spanName = (calls: ReadonlyArray<McpCall>, method: string): string => {
  const first = calls[0];
  if (!first) return `${method} mcp`;
  return first.tool ? `${first.method} ${first.tool}` : first.method;
};

export const loggedMcp = async (
  caller: McpCaller,
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> => {
  const calls = await mcpCalls(request);
  return inSpan(spanName(calls, request.method), (span) => {
    const started = Date.now();
    const first = calls[0];
    const traceId = activeContext()?.traceId ?? null;
    span?.setAttributes({
      "mcp.method.name": first?.method,
      "gen_ai.tool.name": first?.tool ?? undefined,
      "gen_ai.operation.name": first?.tool ? "execute_tool" : undefined,
      "mcp.batch.size": calls.length > 1 ? calls.length : undefined,
      "mcp.client.trace_id": first?.clientTraceId,
      "trifecta.service": "executor",
      "trifecta.tenant": caller.tenant,
      "trifecta.agent": caller.agent ?? undefined,
      "trifecta.trace_id": traceId ?? undefined,
    });
    const settle = (status: number) =>
      Effect.sync(() => {
        span?.setAttribute("http.response.status_code", status);
        span?.setStatus(
          status >= 500 ? { code: "error", message: `HTTP ${status}` } : { code: "ok" },
        );
        logLine(caller, calls, request.method, { status, ms: Date.now() - started, traceId });
      });
    return Effect.runPromise(
      Effect.tryPromise(run).pipe(
        Effect.tap((res) => settle(res.status)),
        Effect.tapError(() => settle(500)),
      ),
    );
  });
};
