const standardErrorNames: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "RequestAbortedError",
  "DOMException",
]);

export const errorClassOf = (error: unknown): string =>
  error instanceof Error && standardErrorNames.has(error.name) ? error.name : "other";
