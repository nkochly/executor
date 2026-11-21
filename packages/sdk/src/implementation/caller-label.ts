import { Effect } from "effect";
import { ToolCallAttribution } from "../contracts/tools.ts";

export const callerLabelHeader = "x-executor-attribution";
const callerLabelKey = "dev.presidio-west/attribution";

export const callerLabelHeaders = Effect.gen(function* () {
  const label = yield* ToolCallAttribution;
  const headers: Readonly<Record<string, string>> =
    label === undefined ? {} : { [callerLabelHeader]: JSON.stringify(label) };
  return headers;
});

export const callerLabelNetwork = `
const callerLabels = new Map();
const callerLabelKey = ${JSON.stringify(callerLabelKey)};
const traceOf = (value) => {
  const found = typeof value === "string" ? /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(value.trim()) : null;
  return found === null ? undefined : found[1];
};
const plain = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const callerLabelOf = (headers) => {
  const raw = headers?.[${JSON.stringify(callerLabelHeader)}];
  if (typeof raw !== "string") return undefined;
  try {
    const label = JSON.parse(raw);
    return plain(label) ? label : undefined;
  } catch {
    return undefined;
  }
};
export const labelled = (headers, run) => {
  const trace = traceOf(headers?.traceparent);
  const label = callerLabelOf(headers);
  if (trace === undefined || label === undefined) return run();
  const held = callerLabels.get(trace);
  if (held === undefined) callerLabels.set(trace, { label, count: 1 });
  else held.count += 1;
  const release = () => {
    const current = callerLabels.get(trace);
    if (current === undefined) return;
    current.count -= 1;
    if (current.count === 0) callerLabels.delete(trace);
  };
  let pending;
  try {
    pending = Promise.resolve(run());
  } catch (error) {
    release();
    throw error;
  }
  return pending.finally(release);
};
const withCallerLabel = (text, label) => {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!plain(message) || message.jsonrpc !== "2.0" || message.method !== "tools/call") return undefined;
  const params = message.params === undefined ? {} : message.params;
  if (!plain(params)) return undefined;
  const meta = params._meta === undefined ? {} : params._meta;
  if (!plain(meta) || meta[callerLabelKey] !== undefined) return undefined;
  return JSON.stringify({ ...message, params: { ...params, _meta: { ...meta, [callerLabelKey]: label } } });
};
const callerLabelled = async (input, init) => {
  if (callerLabels.size === 0) return [input, init];
  const headers = init?.headers !== undefined ? new Headers(init.headers) : input instanceof Request ? input.headers : undefined;
  const held = callerLabels.get(traceOf(headers?.get("traceparent")));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (held === undefined || method !== "POST" || !(headers?.get("content-type") ?? "").toLowerCase().includes("json")) return [input, init];
  const request = new Request(input, init);
  const body = withCallerLabel(await request.clone().text(), held.label);
  return body === undefined ? [request] : [new Request(request, { body })];
};
`;
