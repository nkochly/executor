import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { loadConfig } from "./config";
import {
  addressCheck,
  agentChoices,
  chosenAgent,
  createWorkspaceAgent,
  principalForGrant,
  registeredClientName,
} from "./oauth";
import { clearDirectoryCache, readTeamPages } from "./tenancy";
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
  afterEach(() => {
    vi.unstubAllGlobals();
    clearDirectoryCache();
  });

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

  it.effect("reads the team page of every tenant the person is in", () =>
    Effect.gen(function* () {
      const page = (wiki: string) => ({
        wiki,
        path: "how-we-work.md",
        starter: true,
        version: 0,
        body: wiki,
      });
      stub({
        "/members/dev%40acme.com": [
          { tenant: { slug: "acme", name: "Acme" }, role: "member" },
          { tenant: { slug: "beta", name: "Beta" }, role: "owner" },
          { tenant: { slug: "gone", name: "Gone" }, role: "member" },
        ],
        "/tenants/acme/members/dev%40acme.com/team-page": page("acme/root"),
        "/tenants/beta/members/dev%40acme.com/team-page": page("beta/root"),
      });
      const pages = yield* readTeamPages(companyConfig().operatorDirectory!, "dev@acme.com");
      expect(pages.map((p) => p.wiki)).toEqual(["acme/root", "beta/root"]);
    }),
  );
});

describe("agent sign-in page", () => {
  const existing = [
    { slug: "beta-agent", name: "Beta agent" },
    { slug: "eichten", name: "Team Eichten" },
  ];

  it("offers every workspace agent, then a new one, checked unless the name is listed", () => {
    const html = agentChoices(existing, "AI Studio");
    expect(html).toContain('value="beta-agent"> Beta agent');
    expect(html).toContain('value="eichten"> Team Eichten');
    expect(html).toContain('value="+new" checked');
    expect(html).toContain('value="AI Studio"');
    expect(agentChoices([], "AI Studio")).toContain('value="+new" checked');
  });

  it("checks the listed agent whose name the app suggests", () => {
    const html = agentChoices(existing, "Team-Eichten");
    expect(html).toContain('value="eichten"> Team Eichten');
    const named = agentChoices(existing, "Beta Agent");
    expect(named).toContain('value="beta-agent" checked> Beta agent');
    expect(named).not.toContain('value="+new" checked');
  });

  it("selects a new agent when a name is typed", () => {
    const html = agentChoices(existing, "AI Studio");
    expect(html).toContain(`oninput="document.getElementById('pick-new').checked=true"`);
    expect(html).toContain('id="pick-new"');
  });

  it("joins a listed agent, or makes the one typed", () => {
    expect(chosenAgent({ pick: "eichten", typed: "ignored" }, existing)).toEqual({
      slug: "eichten",
      name: "Team Eichten",
    });
    expect(chosenAgent({ pick: "+new", typed: " AI Studio " }, existing)).toEqual({
      slug: "ai-studio",
      name: "AI Studio",
    });
    expect(chosenAgent({ pick: null, typed: "Claude" }, existing)?.slug).toBe("claude");
    expect(chosenAgent({ pick: "not-listed", typed: "x" }, existing)).toBeNull();
    expect(chosenAgent({ pick: "+new", typed: "***" }, existing)).toBeNull();
  });
});

describe("agent made at Connect", () => {
  const signIn = () =>
    new Request("https://executor.example.com/authorize?client_id=c", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": "jwt",
        "content-type": "application/x-www-form-urlencoded",
      },
    });

  it("creates the workspace toolkit with no connections, as the signed-in person", async () => {
    const calls: { method: string; path: string; body: unknown; jwt: string | null }[] = [];
    const app = async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: url.pathname,
        body: await request.json(),
        jwt: request.headers.get("cf-access-jwt-assertion"),
      });
      return Response.json({ id: "tk_1" });
    };
    await createWorkspaceAgent(signIn(), app, { slug: "team-eichten", name: "Team Eichten" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/toolkits",
        body: { owner: "org", name: "Team Eichten", slug: "team-eichten" },
        jwt: "jwt",
      },
    ]);
  });

  it("leaves it to the first session when the app refuses", async () => {
    const paths: string[] = [];
    const app = async (request: Request) => {
      paths.push(new URL(request.url).pathname);
      return new Response("no", { status: 403 });
    };
    await createWorkspaceAgent(signIn(), app, { slug: "x", name: "x" });
    expect(paths).toEqual(["/api/toolkits"]);
  });
});

describe("addressCheck", () => {
  const at = (resource?: string) =>
    `https://executor.example.com/authorize?response_type=code&client_id=c${
      resource === undefined ? "" : `&resource=${encodeURIComponent(resource)}`
    }`;

  it("passes the MCP address and a workspace's MCP address", () => {
    expect(addressCheck(at("https://executor.example.com/mcp"))).toEqual({
      refuse: false,
      html: "",
    });
    expect(addressCheck(at("https://executor.example.com/mcp/toolkits/claude"))).toEqual({
      refuse: false,
      html: "",
    });
  });

  it("refuses a console page as the resource and names the MCP address", () => {
    const check = addressCheck(at("https://executor.example.com/default/toolkits"));
    expect(check.refuse).toBe(true);
    expect(check.html).toContain("https://executor.example.com/mcp");
  });

  it("warns, without refusing, when no resource is named", () => {
    const check = addressCheck(at());
    expect(check.refuse).toBe(false);
    expect(check.html).toContain("https://executor.example.com/mcp");
  });
});

describe("registered client name", () => {
  const helpersWith = (clients: Record<string, { clientName?: string } | null>) => {
    const lookupClient = vi.fn(async (id: string) => clients[id] ?? null);
    return { helpers: { lookupClient } as never, lookupClient };
  };

  it("names the app as it registered, read once per client", async () => {
    const { helpers, lookupClient } = helpersWith({ "studio-1": { clientName: " AI Studio " } });
    expect(await registeredClientName(helpers, "studio-1")).toBe("AI Studio");
    expect(await registeredClientName(helpers, "studio-1")).toBe("AI Studio");
    expect(lookupClient).toHaveBeenCalledTimes(1);
  });

  it("is absent for a client with no name or no registration", async () => {
    const { helpers } = helpersWith({ bare: {} });
    expect(await registeredClientName(helpers, "bare")).toBeUndefined();
    expect(await registeredClientName(helpers, "gone")).toBeUndefined();
  });
});
