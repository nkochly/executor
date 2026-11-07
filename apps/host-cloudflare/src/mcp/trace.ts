/**
 * End-to-end trace context for MCP calls. Workers tracing records each request as a trace; one call is followed
 * across Executor, wiki and Muster by one id, `trifecta.trace_id`. Executor's is its own Workers trace id (the
 * session Durable Object shares it with the Worker that forwarded the request). Every `tools/call` Executor sends
 * to a first-party server carries it as a W3C `traceparent` in request `_meta` (MCP SEP-414), and those servers
 * record it under the same attribute. A caller's own `traceparent` is kept on Executor's span as
 * `mcp.client.trace_id`, which links an agent's trace to Executor's.
 *
 * Names, ids and timings only: no argument or result ever goes on a span.
 */
import { tracing } from "cloudflare:workers";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

/** A W3C trace context, version 00, with non-zero ids; anything else is null. */
export const parseTraceparent = (value: unknown): TraceContext | null => {
  if (typeof value !== "string") return null;
  const [, traceId, spanId] = TRACEPARENT.exec(value.trim()) ?? [];
  if (!traceId || !spanId || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId };
};

/** The active span's ids, or null when the runtime has no tracing or observability is off. */
export const activeContext = (): TraceContext | null => {
  const ctx = tracing?.getActiveSpan?.()?.spanContext?.();
  if (!ctx || !ctx.traceId || ctx.traceId === ZERO_TRACE || !ctx.spanId) return null;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
};

/** Runs `run` inside a span named `name`, or untraced where the runtime has no tracing. */
export const inSpan = <T>(name: string, run: (span: Span | undefined) => T): T =>
  tracing?.enterSpan ? tracing.enterSpan(name.slice(0, 200), (span) => run(span)) : run(undefined);

const originOf = (endpoint: string): string | null =>
  URL.canParse(endpoint) ? new URL(endpoint).origin : null;

/**
 * Request `_meta` carrying the active trace as `traceparent`, for calls to one of `origins` (the first-party
 * servers); undefined elsewhere or when nothing is traced.
 */
export const makeTraceMeta = (origins: readonly string[]) => {
  const allowed = new Set(origins.map(originOf).filter((o): o is string => o !== null));
  return (endpoint: string): Record<string, unknown> | undefined => {
    const origin = originOf(endpoint);
    if (origin === null || !allowed.has(origin)) return undefined;
    const ctx = activeContext();
    return ctx ? { traceparent: `00-${ctx.traceId}-${ctx.spanId}-01` } : undefined;
  };
};
