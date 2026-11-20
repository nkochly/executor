export interface Span {
  spanContext(): { readonly traceId: string; readonly spanId: string };
  setAttribute(key: string, value: boolean | number | string): unknown;
  setAttributes(attributes: Record<string, boolean | number | string | undefined>): unknown;
  setStatus(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
}

export interface WorkersTracing {
  enterSpan?<T>(name: string, callback: (span: Span) => T): T;
  getActiveSpan?(): Span | undefined;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

export const parseTraceparent = (value: unknown): TraceContext | null => {
  if (typeof value !== "string") return null;
  const [, traceId, spanId] = TRACEPARENT.exec(value.trim()) ?? [];
  if (!traceId || !spanId || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId };
};

const contextOf = (span: Span | undefined): TraceContext | null => {
  const ctx = span?.spanContext?.();
  if (!ctx || !ctx.traceId || ctx.traceId === ZERO_TRACE || !ctx.spanId) return null;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
};

export interface McpCall {
  readonly method: string;
  readonly tool: string | null;
  readonly clientTraceId: string | null;
}

export const mcpCalls = async (request: Request): Promise<ReadonlyArray<McpCall>> => {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/mcp") return [];
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return [];
  }
  return (Array.isArray(body) ? body : [body]).flatMap((message: unknown): McpCall[] => {
    if (typeof message !== "object" || message === null) return [];
    const { method, params } = message as {
      method?: unknown;
      params?: { name?: unknown; _meta?: { traceparent?: unknown } };
    };
    if (typeof method !== "string") return [];
    return [
      {
        method,
        tool: method === "tools/call" && typeof params?.name === "string" ? params.name : null,
        clientTraceId: parseTraceparent(params?._meta?.traceparent)?.traceId ?? null,
      },
    ];
  });
};

const spanName = (calls: ReadonlyArray<McpCall>) => {
  const first = calls[0];
  const name = first ? (first.tool ? `${first.method} ${first.tool}` : first.method) : "POST mcp";
  return name.slice(0, 200);
};

export const continuing = (request: Request, context: TraceContext | null): Request => {
  if (context === null) return request;
  const next = new Request(request);
  next.headers.set("traceparent", `00-${context.traceId}-${context.spanId}-01`);
  next.headers.delete("tracestate");
  next.headers.delete("b3");
  for (const name of ["x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid", "x-b3-sampled"])
    next.headers.delete(name);
  return next;
};

export const traced = async (
  tracing: WorkersTracing | undefined,
  request: Request,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> => {
  const calls = await mcpCalls(request);
  const clientHeader = parseTraceparent(request.headers.get("traceparent"))?.traceId ?? null;
  if (calls.length === 0 || !tracing?.enterSpan)
    return forward(continuing(request, contextOf(tracing?.getActiveSpan?.())));
  return tracing.enterSpan(spanName(calls), async (span) => {
    const started = Date.now();
    const context = contextOf(span);
    const traceId = context?.traceId ?? null;
    const first = calls[0];
    span.setAttributes({
      "mcp.method.name": first?.method,
      "gen_ai.tool.name": first?.tool ?? undefined,
      "gen_ai.operation.name": first?.tool ? "execute_tool" : undefined,
      "mcp.batch.size": calls.length > 1 ? calls.length : undefined,
      "mcp.client.trace_id": first?.clientTraceId ?? clientHeader ?? undefined,
      "trifecta.service": "executor-v2",
      "trifecta.trace_id": traceId ?? undefined,
    });
    let status = 500;
    try {
      const response = await forward(continuing(request, context));
      status = response.status;
      return response;
    } finally {
      span.setAttribute("http.response.status_code", status);
      span.setStatus(status >= 500 ? { code: "error", message: `HTTP ${status}` } : { code: "ok" });
      const ms = Date.now() - started;
      for (const call of calls) {
        console.log(
          JSON.stringify({
            event: "mcp_call",
            service: "executor-v2",
            method: call.method,
            tool: call.tool,
            status,
            ms,
            ...(traceId ? { trace_id: traceId } : {}),
            ...((call.clientTraceId ?? clientHeader)
              ? { client_trace_id: call.clientTraceId ?? clientHeader }
              : {}),
          }),
        );
      }
    }
  });
};
