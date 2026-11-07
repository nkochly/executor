/** Node-test stand-ins for Cloudflare module exports reached during handler imports. */
export const env: Record<string, unknown> = {};
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
export class RpcTarget {}
export const exports: Record<string, unknown> = {};
/** Tracing as the runtime has it, with fixed ids so tests can read them back. */
const span = {
  isTraced: true,
  spanContext: () => ({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: 1,
  }),
  setAttribute() {
    return span;
  },
  setAttributes() {
    return span;
  },
  setStatus() {
    return span;
  },
  updateName() {
    return span;
  },
  recordException() {},
  end() {},
};
export const tracing = {
  enterSpan: <T>(_name: string, callback: (s: typeof span) => T): T => callback(span),
  getActiveSpan: () => span,
};
