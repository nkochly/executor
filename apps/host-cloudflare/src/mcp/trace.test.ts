import { describe, expect, it } from "@effect/vitest";

import { activeContext, makeTraceMeta, parseTraceparent } from "./trace";

describe("mcp trace context", () => {
  it("reads only well-formed W3C traceparents", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01")).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "00f067aa0ba902b7",
    });
    expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent("01-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent(42)).toBeNull();
  });

  it("stamps the active trace on calls to first-party servers only", () => {
    const meta = makeTraceMeta([
      "https://mcp-openwiki.example.dev/mcp",
      "https://muster.example.dev/mcp",
    ]);
    const ctx = activeContext();
    expect(ctx).not.toBeNull();
    expect(meta("https://muster.example.dev/mcp/beta")).toEqual({
      traceparent: `00-${ctx?.traceId}-${ctx?.spanId}-01`,
    });
    expect(meta("https://mcp.webex.com/v1/mcp")).toBeUndefined();
    expect(meta("not a url")).toBeUndefined();
  });
});
