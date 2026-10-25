import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

// ---------------------------------------------------------------------------
// Multi-tenant mode end to end: the real worker on workerd with `TENANTS` set.
// Each tenant is its own catalog partition, a tenant's tools stay blocked until
// its admins approve them, and the tenant comes from the URL.
// ---------------------------------------------------------------------------

const dir = fileURLToPath(new URL(".", import.meta.url));
const runId = randomUUID().slice(0, 8);

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Test", version: "1.0.0" },
  servers: [{ url: "https://example.com" }],
  paths: {
    "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
  },
});

const ORG = "x-executor-organization";

describe("cloudflare host multi-tenant e2e", () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    const distIndex = resolve(dir, "../dist/index.html");
    if (!existsSync(distIndex)) {
      mkdirSync(resolve(dir, "../dist"), { recursive: true });
      writeFileSync(distIndex, "<!doctype html><title>executor</title>");
    }
    worker = await unstable_dev(resolve(dir, "worker.ts"), {
      config: resolve(dir, "../wrangler.jsonc"),
      ip: "127.0.0.1",
      local: true,
      persist: false,
      experimental: { disableExperimentalWarning: true },
      vars: {
        EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
        ENABLE_DEV_AUTH: "true",
        TENANTS: JSON.stringify({ acme: { name: "Acme" }, beta: {} }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("scopes the account to the named tenant and refuses unknown ones", async () => {
    const me = await worker.fetch("/api/account/me", { headers: { [ORG]: "acme" } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { organization: { id: string } };
    expect(body.organization.id).toBe("acme");

    const unknown = await worker.fetch("/api/account/me", { headers: { [ORG]: "nope" } });
    expect(unknown.status).toBe(401);

    // Two tenants exist, so a request that names none is refused.
    const unnamed = await worker.fetch("/api/account/me");
    expect(unnamed.status).toBe(401);
  }, 60_000);

  it("keeps each tenant's integrations to itself", async () => {
    const slug = `iso-${runId}`;
    const add = await worker.fetch("/api/openapi/specs", {
      method: "POST",
      headers: { "content-type": "application/json", [ORG]: "acme" },
      body: JSON.stringify({
        spec: { kind: "blob", value: SPEC },
        slug,
        baseUrl: "https://example.com",
      }),
    });
    expect(add.status).toBe(200);

    const inAcme = await worker.fetch(`/api/integrations/${slug}`, { headers: { [ORG]: "acme" } });
    expect(inAcme.status).toBe(200);
    const inBeta = await worker.fetch(`/api/integrations/${slug}`, { headers: { [ORG]: "beta" } });
    expect(inBeta.status).not.toBe(200);
  }, 60_000);

  it("blocks tools until the tenant approves them, per tenant", async () => {
    const executorTools = async (tenant: string) => {
      const res = await worker.fetch("/api/tools?integration=executor&includeBlocked=false", {
        headers: { [ORG]: tenant },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as readonly unknown[]).length;
    };
    expect(await executorTools("acme")).toBe(0);

    const approve = await worker.fetch("/api/policies", {
      method: "POST",
      headers: { "content-type": "application/json", [ORG]: "acme" },
      body: JSON.stringify({ owner: "org", pattern: "executor.*", action: "approve" }),
    });
    expect(approve.status).toBe(200);

    expect(await executorTools("acme")).toBeGreaterThan(0);
    expect(await executorTools("beta")).toBe(0);
  }, 60_000);

  it("serves MCP at /<tenant>/mcp and refuses an unknown tenant", async () => {
    const initialize = (path: string) =>
      worker.fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
    const ok = await initialize("/acme/mcp");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();

    const refused = await initialize("/nope/mcp");
    expect(refused.status).toBe(401);

    // The challenge points at metadata for the path the client dialed.
    expect(refused.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/nope/mcp",
    );
  }, 60_000);
});
