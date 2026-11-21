import { Effect } from "effect";
import { ToolCallAttribution } from "../contracts/tools.ts";

export const callerLabelHeader = "x-executor-attribution";
const callerLabelKey = "dev.presidio-west/attribution";

export const callerLabelHeaders = Effect.gen(function* () {
  const label = yield* ToolCallAttribution;
  const headers: Readonly<Record<string, string>> =
    label === undefined ? {} : { [callerLabelHeader]: encodeURIComponent(JSON.stringify(label)) };
  return headers;
});

export const callerLabelNetwork = `
const callerLabels = new Map();
const callerLabelKey = ${JSON.stringify(callerLabelKey)};
const traceOf = (value) => {
  const found = typeof value === "string" ? /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(value.trim()) : null;
  return found === null || /^0+$/.test(found[1]) ? undefined : found[1];
};
const plain = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const callerLabelOf = (headers) => {
  const raw = headers?.[${JSON.stringify(callerLabelHeader)}];
  if (typeof raw !== "string") return undefined;
  try {
    const text = decodeURIComponent(raw);
    return plain(JSON.parse(text)) ? text : undefined;
  } catch {
    return undefined;
  }
};
export const labelled = (headers, run) => {
  const trace = traceOf(headers?.traceparent);
  const label = callerLabelOf(headers);
  if (trace === undefined || label === undefined) return run();
  const held = callerLabels.get(trace) ?? [];
  callerLabels.set(trace, [...held, label]);
  const release = () => {
    const current = callerLabels.get(trace) ?? [];
    const index = current.indexOf(label);
    const left = index === -1 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
    if (left.length === 0) callerLabels.delete(trace);
    else callerLabels.set(trace, left);
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
const heldLabel = (trace) => {
  const held = trace === undefined ? undefined : callerLabels.get(trace);
  if (held === undefined || held.some((label) => label !== held[0])) return undefined;
  return JSON.parse(held[0]);
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
  const label = heldLabel(traceOf(headers?.get("traceparent")));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (label === undefined || method !== "POST" || !(headers?.get("content-type") ?? "").toLowerCase().includes("json")) return [input, init];
  const request = new Request(input, init);
  const body = withCallerLabel(await request.clone().text(), label);
  if (body === undefined) return [request];
  const sent = new Headers(request.headers);
  sent.delete("content-length");
  return [new Request(request, { body, headers: sent })];
};
`;
