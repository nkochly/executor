import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import {
  ORIGINAL_PATH_HEADER,
  resolveTenant,
  isOperator,
  routeTenantRequest,
  TENANT_HEADER,
  tenantRewrite,
} from "./tenancy";

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

describe("resolveTenant", () => {
  const directory = {
    url: "https://dir.test/api/directory",
    clientId: "id",
    clientSecret: "secret",
  };
  const acme = { tenant: { slug: "acme", name: "Acme" }, role: "owner" };
  const calls: { url: string; headers: Headers }[] = [];

  const stub = (routes: Record<string, unknown>) => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      calls.push({ url: input, headers: new Headers(init?.headers) });
      const path = input.slice(directory.url.length);
      return path in routes
        ? new Response(JSON.stringify(routes[path]), { status: 200 })
        : new Response("not found", { status: 404 });
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it.effect("reads the named tenant with the service token, mapping owner to admin", () =>
    Effect.gen(function* () {
      stub({ "/tenants/acme/members/lead%40acme.com": { ...acme, subject: "lead@acme.com" } });
      const member = yield* resolveTenant(directory, "Lead@acme.com", "acme");
      expect(member).toEqual({ tenant: { slug: "acme", name: "Acme" }, role: "admin" });
      expect(calls[0]!.headers.get("cf-access-client-id")).toBe("id");
    }),
  );

  it.effect("refuses a tenant the directory does not list the caller in", () =>
    Effect.gen(function* () {
      stub({});
      expect(yield* resolveTenant(directory, "lead@acme.com", "beta")).toBeNull();
    }),
  );

  it.effect("picks the only tenant when none is named, and none when there are two", () =>
    Effect.gen(function* () {
      stub({ "/members/dev%40acme.com": [{ ...acme, role: "member" }] });
      expect((yield* resolveTenant(directory, "dev@acme.com", null))?.role).toBe("member");
      stub({
        "/members/dev%40acme.com": [acme, { tenant: { slug: "b", name: "B" }, role: "member" }],
      });
      expect(yield* resolveTenant(directory, "dev@acme.com", null)).toBeNull();
    }),
  );

  it.effect("reads the operator list, and lists nobody when it cannot be read", () =>
    Effect.gen(function* () {
      stub({ "/operators/ops%40acme.com": { subject: "ops@acme.com", operator: true } });
      expect(yield* isOperator(directory, "Ops@acme.com")).toBe(true);
      expect(yield* isOperator(directory, "lead@acme.com")).toBe(false);
      vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
      expect(yield* isOperator(directory, "ops@acme.com")).toBe(false);
    }),
  );

  it.effect("admits nobody when the directory cannot be read", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
      expect(yield* resolveTenant(directory, "lead@acme.com", "acme")).toBeNull();
    }),
  );
});
