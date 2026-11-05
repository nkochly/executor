import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { Data, Effect } from "effect";

import type { Executor } from "@executor-js/sdk";

import type { CloudflareConfig } from "./config";
import { defaultPolicies, makeTenantDefaults } from "./tenant-defaults";

// A D1 stand-in over node:sqlite: the calls tenant-defaults.ts makes, nothing more.
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

const configWith = (
  webex: CloudflareConfig["webex"],
  firstParty: CloudflareConfig["firstParty"] = [],
): CloudflareConfig => ({
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: [],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  enableDevAuth: true,
  directory: null,
  operatorDirectory: null,
  agentSignIn: false,
  firstParty,
  webex,
});

class IntegrationAlreadyExistsError extends Data.TaggedError("IntegrationAlreadyExistsError")<{}> {}

// Records what the host's seeder executor was asked to do.
// `existing` maps an integration slug already present to its name.
const recordingExecutor = (existing: Readonly<Record<string, string>> | readonly string[] = []) => {
  const names: Record<string, string> = Array.isArray(existing)
    ? Object.fromEntries(existing.map((slug) => [slug, slug]))
    : { ...existing };
  const added: { slug: string; name: string }[] = [];
  const renamed: { slug: string; name: string }[] = [];
  const revised: string[] = [];
  const policies: { pattern: string; action: string }[] = [];
  const executor = {
    mcp: {
      addServer: (input: { slug: string; name: string }) =>
        input.slug in names
          ? Effect.fail(new IntegrationAlreadyExistsError())
          : Effect.sync(() => void added.push({ slug: input.slug, name: input.name })),
    },
    integrations: {
      get: (slug: string) => Effect.succeed(slug in names ? { slug, name: names[slug] } : null),
      update: (slug: string, patch: { name: string }) =>
        Effect.sync(() => void renamed.push({ slug, name: patch.name })),
      reviseTools: (slug: string) => Effect.sync(() => void revised.push(slug)),
    },
    policies: {
      create: (input: { owner: string; pattern: string; action: string }) =>
        Effect.sync(() => void policies.push({ pattern: input.pattern, action: input.action })),
    },
  };
  return {
    // oxlint-disable-next-line executor/no-double-cast -- test boundary: only the surfaces tenant defaults use
    executor: executor as unknown as Executor,
    get added() {
      return added.map((entry) => entry.slug);
    },
    addedNames: added,
    renamed,
    revised,
    policies,
  };
};

const ready = { clientId: "cid", clientSecret: "secret" };

describe("tenant defaults", () => {
  it("adds nothing until the Webex integration holds real values", async () => {
    expect(makeTenantDefaults(fakeD1(), configWith(null))).toBeUndefined();
    const run = makeTenantDefaults(
      fakeD1(),
      configWith({ clientId: "placeholder", clientSecret: "placeholder" }),
    )!;
    let built = 0;
    await Effect.runPromise(
      run("acme-unset", () => Effect.sync(() => (built++, recordingExecutor().executor))),
    );
    expect(built).toBe(0);
  });

  it("adds both Webex servers once, tools approved except deletes", async () => {
    const db = fakeD1();
    const first = recordingExecutor();
    await Effect.runPromise(
      makeTenantDefaults(db, configWith(ready))!("acme", () => Effect.succeed(first.executor)),
    );
    expect(first.added).toEqual(["webex_meetings", "webex_messaging"]);
    expect(first.policies).toEqual([
      { pattern: "webex_meetings.*", action: "approve" },
      { pattern: "webex_meetings.*.*.webex_delete_meeting", action: "block" },
      { pattern: "webex_messaging.*", action: "approve" },
      { pattern: "webex_messaging.*.*.webex_delete_message", action: "block" },
      { pattern: "webex_messaging.*.*.webex_delete_space", action: "block" },
      { pattern: "webex_messaging.*.*.webex_remove_membership", action: "block" },
    ]);

    // A later isolate reads the record and leaves the tenant's choices alone.
    const later = recordingExecutor();
    await Effect.runPromise(
      makeTenantDefaults(db, configWith(ready))!("acme", () => Effect.succeed(later.executor)),
    );
    expect(later.added).toEqual([]);
    expect(later.policies).toEqual([]);
    expect(later.renamed).toEqual([]);
  });

  it("keeps a server a tenant admin already added and still records it", async () => {
    const db = fakeD1();
    const seeded = recordingExecutor(["webex_meetings"]);
    await Effect.runPromise(
      makeTenantDefaults(db, configWith(ready))!("beta-team", () =>
        Effect.succeed(seeded.executor),
      ),
    );
    expect(seeded.added).toEqual(["webex_messaging"]);
  });

  const firstParty = [
    { slug: "wiki", name: "Wiki", endpoint: "https://wiki-connect.example.dev/mcp" },
    { slug: "muster", name: "Muster", endpoint: "https://muster-connect.example.dev/mcp" },
  ];

  it("adds the company's own servers by their names, with no Webex", async () => {
    const seeded = recordingExecutor();
    await Effect.runPromise(
      makeTenantDefaults(fakeD1(), configWith(null, firstParty))!("acme", () =>
        Effect.succeed(seeded.executor),
      ),
    );
    expect(seeded.addedNames).toEqual([
      { slug: "wiki", name: "Wiki" },
      { slug: "muster", name: "Muster" },
    ]);
    expect(seeded.policies).toEqual([
      { pattern: "wiki.*", action: "approve" },
      { pattern: "muster.*", action: "approve" },
    ]);
  });

  it("names a server added earlier by its URL, and keeps a name an admin chose", async () => {
    const seeded = recordingExecutor({
      muster: "muster-connect.example.dev",
      wiki: "Team wiki",
    });
    await Effect.runPromise(
      makeTenantDefaults(fakeD1(), configWith(null, firstParty))!("beta", () =>
        Effect.succeed(seeded.executor),
      ),
    );
    expect(seeded.added).toEqual([]);
    expect(seeded.renamed).toEqual([{ slug: "muster", name: "Muster" }]);
  });

  it("names a recorded server again when an admin re-adds it by its URL", async () => {
    const db = fakeD1();
    await Effect.runPromise(
      makeTenantDefaults(db, configWith(null, firstParty))!("acme", () =>
        Effect.succeed(recordingExecutor().executor),
      ),
    );
    const readded = recordingExecutor({ wiki: "wiki-connect.example.dev", muster: "Muster" });
    await Effect.runPromise(
      makeTenantDefaults(db, configWith(null, firstParty))!("acme", () =>
        Effect.succeed(readded.executor),
      ),
    );
    expect(readded.added).toEqual([]);
    expect(readded.policies).toEqual([]);
    expect(readded.renamed).toEqual([{ slug: "wiki", name: "Wiki" }]);
  });

  it("re-lists a server's tools in every connection when its tool-list revision changes", async () => {
    const db = fakeD1();
    const at = (muster: string) => [
      { ...firstParty[0]!, revision: "w1" },
      { ...firstParty[1]!, revision: muster },
    ];
    const run = async (muster: string) => {
      const seeded = recordingExecutor(["wiki", "muster"]);
      await Effect.runPromise(
        makeTenantDefaults(db, configWith(null, at(muster)))!("acme", () =>
          Effect.succeed(seeded.executor),
        ),
      );
      return seeded.revised;
    };
    // The first revision a tenant sees is only recorded.
    expect(await run("m1")).toEqual([]);
    // The same revision on a later isolate changes nothing.
    expect(await run("m1")).toEqual([]);
    // A deploy that changed Muster's tools revises Muster alone, once.
    expect(await run("m2")).toEqual(["muster"]);
    expect(await run("m2")).toEqual([]);
  });

  it("puts each block above the approval it narrows", () => {
    const rules = defaultPolicies({ slug: "webex-meetings", blocked: ["webex_delete_meeting"] });
    expect(rules.at(-1)).toEqual({
      pattern: "webex_meetings.*.*.webex_delete_meeting",
      action: "block",
    });
  });
});
