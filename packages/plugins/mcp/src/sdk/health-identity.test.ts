// ---------------------------------------------------------------------------
// The health check names a connection after the server's initialize `title`.
//
// A server that answers one account or tenant per connection (one sign-in per
// tenant against the same URL) says which in its title, and that is the only
// thing that tells several connections to the same server apart. A server that
// sends no title leaves the identity unset, as before.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { mcpPlugin } from "./plugin";
import { extractManifestFromListToolsResult } from "./manifest";
import { serveMcpServer } from "../testing";

const titled = (title: string | undefined) => () => {
  const server = new McpServer(
    { name: "tenant-server", version: "1.0.0", ...(title === undefined ? {} : { title }) },
    { capabilities: {} },
  );
  server.registerTool("ping", { description: "Ping" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
};

const checkHealthAt = (endpoint: string) =>
  Effect.gen(function* () {
    const plugin = mcpPlugin();
    const checkHealth = (plugin as { readonly checkHealth?: unknown }).checkHealth;
    if (typeof checkHealth !== "function") {
      return yield* Effect.die("mcpPlugin no longer exposes checkHealth");
    }
    return yield* (
      checkHealth as (input: unknown) => Effect.Effect<{
        readonly status: string;
        readonly identity?: string;
      }>
    )({
      ctx: { httpClientLayer: FetchHttpClient.layer },
      credential: {
        config: {
          transport: "remote",
          endpoint,
          remoteTransport: "streamable-http",
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        },
        values: {},
        template: "none",
        connection: "main",
        integration: "tenant_mcp",
      },
    });
  });

describe("MCP health identity", () => {
  it("keeps a server's title in its manifest, and leaves it out when blank", () => {
    const named = extractManifestFromListToolsResult(
      { tools: [] },
      { serverInfo: { name: "muster", title: "Muster · acme", version: "1" } },
    );
    expect(named.server?.title).toBe("Muster · acme");
    const blank = extractManifestFromListToolsResult(
      { tools: [] },
      { serverInfo: { name: "muster", title: "  ", version: "1" } },
    );
    expect(blank.server).not.toHaveProperty("title");
  });

  it.effect("names a healthy connection after the server's title", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer(titled("Muster · acme"));
      const health = yield* checkHealthAt(server.url);
      expect(health).toMatchObject({ status: "healthy", identity: "Muster · acme" });
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the identity unset when the server sends no title", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer(titled(undefined));
      const health = yield* checkHealthAt(server.url);
      expect(health.status).toBe("healthy");
      expect(health).not.toHaveProperty("identity");
    }).pipe(Effect.scoped),
  );
});
