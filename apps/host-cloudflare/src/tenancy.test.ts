import { describe, expect, it } from "@effect/vitest";

import { ORIGINAL_PATH_HEADER, routeTenantRequest, TENANT_HEADER, tenantRewrite } from "./tenancy";

describe("tenantRewrite", () => {
  it("strips the tenant from MCP and toolkit paths", () => {
    expect(tenantRewrite("/acme/mcp")).toEqual({ tenant: "acme", pathname: "/mcp" });
    expect(tenantRewrite("/acme/mcp/toolkits/claude-desktop")).toEqual({
      tenant: "acme",
      pathname: "/mcp/toolkits/claude-desktop",
    });
    expect(tenantRewrite("/.well-known/oauth-protected-resource/acme/mcp")).toEqual({
      tenant: "acme",
      pathname: "/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("leaves other paths alone", () => {
    expect(tenantRewrite("/mcp")).toBeNull();
    expect(tenantRewrite("/api/tools")).toBeNull();
    expect(tenantRewrite("/acme/policies")).toBeNull();
  });
});

describe("routeTenantRequest", () => {
  it("drops a client-supplied tenant header", () => {
    const routed = routeTenantRequest(
      new Request("https://x.test/api/tools", { headers: { [TENANT_HEADER]: "evil" } }),
      true,
    );
    expect(routed.headers.get(TENANT_HEADER)).toBeNull();
  });

  it("carries the tenant and the dialed path", () => {
    const routed = routeTenantRequest(
      new Request("https://x.test/acme/mcp", { method: "POST" }),
      true,
    );
    expect(new URL(routed.url).pathname).toBe("/mcp");
    expect(routed.headers.get(TENANT_HEADER)).toBe("acme");
    expect(routed.headers.get(ORIGINAL_PATH_HEADER)).toBe("/acme/mcp");
    expect(routed.method).toBe("POST");
  });

  it("passes requests through in single-tenant mode", () => {
    const request = new Request("https://x.test/acme/mcp");
    expect(routeTenantRequest(request, false)).toBe(request);
  });
});
