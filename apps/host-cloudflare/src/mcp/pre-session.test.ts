import { describe, expect, it } from "@effect/vitest";

import { sessionlessProbeAnswer } from "./pre-session";

const post = (body: unknown) =>
  new Request("https://executor.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify(body),
  });

describe("session-less agent requests", () => {
  it("answers a server/discover probe with -32601 on a 200, so the client falls back", async () => {
    const response = await sessionlessProbeAnswer(
      post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response?.json()) as { id: number; error: { code: number } };
    expect(body).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it("hands initialize to the transport", async () => {
    const response = await sessionlessProbeAnswer(
      post({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    );
    expect(response).toBeNull();
  });
});
