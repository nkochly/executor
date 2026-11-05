import { describe, expect, it } from "@effect/vitest";

import { isProbableMcpEndpoint, mcpEndpointFromInput } from "./probe-url";

describe("isProbableMcpEndpoint", () => {
  it("rejects the prefixes a URL passes through while it is typed", () => {
    for (const typed of [
      "",
      "  ",
      "h",
      "ht",
      "htt",
      "http",
      "http:",
      "http:/",
      "http://",
      "http://a",
      "http://example",
      "https://mcp",
      "https://mcp.",
      "https://.com",
    ]) {
      expect(isProbableMcpEndpoint(typed), typed).toBe(false);
    }
  });

  it("accepts a finished http(s) endpoint", () => {
    for (const finished of [
      "https://mcp.example.com",
      "https://mcp.example.com/mcp",
      "http://example.com:4789/mcp?codemode=false",
      "https://example.co.uk/sse",
      "  https://mcp.example.com/mcp  ",
      "HTTPS://MCP.EXAMPLE.COM/mcp",
    ]) {
      expect(isProbableMcpEndpoint(finished), finished).toBe(true);
    }
  });

  it("accepts local development hosts, which have no dot to wait for", () => {
    for (const local of [
      "http://localhost",
      "http://localhost:4789/mcp",
      "http://app.localhost:4789/mcp",
      "http://127.0.0.1:4789/mcp",
      "http://[::1]:4789/mcp",
    ]) {
      expect(isProbableMcpEndpoint(local), local).toBe(true);
    }
  });

  it("rejects schemes the MCP remote transport cannot dial", () => {
    for (const wrongScheme of [
      "ftp://mcp.example.com",
      "ws://mcp.example.com",
      "file:///tmp/mcp",
      "mailto:someone@example.com",
      "npx @example/mcp-server",
    ]) {
      expect(isProbableMcpEndpoint(wrongScheme), wrongScheme).toBe(false);
    }
  });

  it("reads an address typed without a scheme as https", () => {
    expect(mcpEndpointFromInput("  salesforce-mcp.example.dev/mcp ")).toBe(
      "https://salesforce-mcp.example.dev/mcp",
    );
    expect(mcpEndpointFromInput("localhost:4789/mcp")).toBe("https://localhost:4789/mcp");
    expect(mcpEndpointFromInput("http://mcp.example.com")).toBe("http://mcp.example.com");
    expect(mcpEndpointFromInput("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(mcpEndpointFromInput("")).toBe("");
    expect(isProbableMcpEndpoint("salesforce-mcp-server.example.workers.dev")).toBe(true);
    expect(isProbableMcpEndpoint("example")).toBe(false);
  });
});
