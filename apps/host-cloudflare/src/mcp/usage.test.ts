import { describe, expect, it, vi } from "@effect/vitest";

import { loggedMcp, mcpCalls } from "./usage";

const post = (body: string) => new Request("https://x.test/mcp", { method: "POST", body });

describe("mcp usage log", () => {
  it("reads method and tool names from single and batched bodies", async () => {
    expect(
      await mcpCalls(
        post(JSON.stringify({ method: "tools/call", params: { name: "wiki.search" } })),
      ),
    ).toEqual([{ method: "tools/call", tool: "wiki.search" }]);
    expect(await mcpCalls(post(JSON.stringify([{ method: "initialize" }])))).toEqual([
      { method: "initialize", tool: null },
    ]);
    expect(await mcpCalls(post("nope"))).toEqual([]);
  });

  it("logs one line per call with tenant, agent and status", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = post(
      JSON.stringify({ method: "tools/call", params: { name: "muster.claim_next" } }),
    );
    const res = await loggedMcp(
      { tenant: "acme", agent: "scout", subject: "a@b.c" },
      req,
      async () => new Response(await req.text(), { status: 200 }),
    );
    expect(await res.text()).toContain("claim_next");
    const line = String(log.mock.calls.at(-1)?.[0]);
    for (const part of [
      '"event":"mcp_call"',
      '"service":"executor"',
      '"tenant":"acme"',
      '"agent":"scout"',
      '"tool":"muster.claim_next"',
      '"status":200',
    ])
      expect(line).toContain(part);
    log.mockRestore();
  });

  it("logs Executor's trace id and the caller's own trace id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = post(
      JSON.stringify({
        method: "tools/call",
        params: {
          name: "wiki.search",
          _meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01" },
        },
      }),
    );
    await loggedMcp(
      { tenant: "acme", agent: null, subject: "a@b.c" },
      req,
      async () => new Response("ok"),
    );
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toContain('"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"');
    expect(line).toContain('"client_trace_id":"0af7651916cd43dd8448eb211c80319c"');
    log.mockRestore();
  });
});
