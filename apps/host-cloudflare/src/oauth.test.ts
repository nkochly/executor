import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { loadConfig } from "./config";
import { principalForGrant } from "./oauth";
import type { AgentGrant } from "./agent";

const DIRECTORY = "https://dir.test/api/directory";

const companyConfig = () =>
  loadConfig({
    EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
    VITE_PUBLIC_SITE_URL: "https://executor.example.com",
    ENABLE_DEV_AUTH: "true",
    EXECUTOR_TENANCY: "company",
    TENANT_DIRECTORY_URL: DIRECTORY,
    SELF_HOSTED_ORG_ID: "presidio",
    SELF_HOSTED_ORG_NAME: "Presidio",
  });

const grant: AgentGrant = {
  accountId: "acct-1",
  email: "dev@acme.com",
  name: "Dev",
  tenant: "presidio",
  agent: "claude",
  agentName: "Claude",
  clientId: "client-1",
};

const stub = (routes: Record<string, unknown>) =>
  vi.stubGlobal("fetch", async (input: string) => {
    const path = input.slice(DIRECTORY.length);
    return path in routes
      ? new Response(JSON.stringify(routes[path]), { status: 200 })
      : new Response("not found", { status: 404 });
  });

describe("company tenancy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is one org with no tenant partition, keeping the directory for operators", () => {
    const config = companyConfig();
    expect(config.directory).toBeNull();
    expect(config.operatorDirectory).toEqual(expect.objectContaining({ url: DIRECTORY }));
    expect(config.organizationId).toBe("presidio");
  });

  it.effect("acts as the person in the company org while any tenant lists them", () =>
    Effect.gen(function* () {
      stub({
        "/members/dev%40acme.com": [{ tenant: { slug: "beta", name: "Beta" }, role: "member" }],
      });
      const principal = yield* principalForGrant(grant, companyConfig());
      expect(principal).not.toBeNull();
      expect(principal!.organizationId).toBe("presidio");
    }),
  );

  it.effect("keeps a platform admin who is in no tenant", () =>
    Effect.gen(function* () {
      stub({
        "/members/dev%40acme.com": [],
        "/operators/dev%40acme.com": { subject: "dev@acme.com", operator: true },
      });
      expect(yield* principalForGrant(grant, companyConfig())).not.toBeNull();
    }),
  );

  it.effect("ends the agent once the directory lists the person nowhere", () =>
    Effect.gen(function* () {
      stub({ "/members/dev%40acme.com": [] });
      expect(yield* principalForGrant(grant, companyConfig())).toBeNull();
    }),
  );
});
