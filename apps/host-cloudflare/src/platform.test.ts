import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import type { D1Database } from "@cloudflare/workers-types";

import type { CloudflareConfig } from "./config";
import { catalogOrigins, catalogPresets, handlePlatform, refreshCatalog } from "./platform";

// A D1 stand-in over node:sqlite: the calls platform.ts makes, nothing more.
const fakeD1 = (): D1Database => {
  const db = new DatabaseSync(":memory:");
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) },
    }),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
  });
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: a partial D1 for the calls under test
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
};

const configFor = (adminEmails: string[]): CloudflareConfig => ({
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails,
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  enableDevAuth: true,
  directory: null,
  firstParty: [{ slug: "wiki", name: "Wiki", endpoint: "https://wiki.example/mcp" }],
});

const API = "https://executor.example/api/platform/mcp-servers";
const add = (body: unknown) =>
  new Request(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("company MCP catalog", () => {
  it("lets a platform admin add a server every tenant then sees first", async () => {
    const db = fakeD1();
    const admin = configFor(["ops@example.com"]);
    const created = await handlePlatform(
      add({ slug: "jira", name: "Jira", endpoint: "https://jira.example/mcp" }),
      db,
      admin,
    );
    expect(created?.status).toBe(201);
    const listed = await refreshCatalog(db, admin);
    expect(listed.map((s) => s.slug)).toEqual(["wiki", "jira"]);
    expect(catalogPresets(listed)[1]).toMatchObject({
      endpoint: "https://jira.example/mcp",
      featured: true,
    });
    expect(catalogOrigins(listed)).toEqual(["https://wiki.example", "https://jira.example"]);
  });

  it("refuses changes from anyone else, and stack-fixed slugs", async () => {
    const db = fakeD1();
    const member = await handlePlatform(
      add({ slug: "jira", name: "Jira", endpoint: "https://jira.example/mcp" }),
      db,
      configFor([]),
    );
    expect(member?.status).toBe(403);
    const fixed = await handlePlatform(
      add({ slug: "wiki", name: "Wiki", endpoint: "https://other.example/mcp" }),
      db,
      configFor(["ops@example.com"]),
    );
    expect(fixed?.status).toBe(409);
    const plain = await handlePlatform(
      add({ slug: "x", name: "X", endpoint: "http://x.example/mcp" }),
      db,
      configFor(["ops@example.com"]),
    );
    expect(plain?.status).toBe(400);
  });

  it("leaves other paths alone", async () => {
    expect(
      await handlePlatform(
        new Request("https://executor.example/api/tools"),
        fakeD1(),
        configFor([]),
      ),
    ).toBeNull();
  });
});
