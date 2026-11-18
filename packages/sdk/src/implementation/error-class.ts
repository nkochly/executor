/**
 * An error's standard class name, the one fact a host records about a platform error besides its
 * classified code.
 */

/** Error class names the platform and the language define. Any other name is recorded as `other`. */
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

/** An error's standard class name, or `other` for any name an app or library chose. */
export const errorClassOf = (error: unknown): string =>
  error instanceof Error && standardErrorNames.has(error.name) ? error.name : "other";
