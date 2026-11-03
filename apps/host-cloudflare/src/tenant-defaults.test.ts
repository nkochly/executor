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

const configWith = (webex: CloudflareConfig["webex"]): CloudflareConfig => ({
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
  firstParty: [],
  webex,
});

class IntegrationAlreadyExistsError extends Data.TaggedError("IntegrationAlreadyExistsError")<{}> {}

// Records what the host's seeder executor was asked to do.
const recordingExecutor = (existing: readonly string[] = []) => {
  const added: string[] = [];
  const policies: { pattern: string; action: string }[] = [];
  const executor = {
    mcp: {
      addServer: (input: { slug: string }) =>
        existing.includes(input.slug)
          ? Effect.fail(new IntegrationAlreadyExistsError())
          : Effect.sync(() => void added.push(input.slug)),
    },
    policies: {
      create: (input: { owner: string; pattern: string; action: string }) =>
        Effect.sync(() => void policies.push({ pattern: input.pattern, action: input.action })),
    },
  };
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: only the surfaces tenant defaults use
  return { executor: executor as unknown as Executor, added, policies };
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
    let built = 0;
    const { executor } = recordingExecutor();
    await Effect.runPromise(
      makeTenantDefaults(db, configWith(ready))!("acme", () =>
        Effect.sync(() => (built++, executor)),
      ),
    );
    expect(built).toBe(0);
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

  it("puts each block above the approval it narrows", () => {
    const rules = defaultPolicies({ slug: "webex-meetings", blocked: ["webex_delete_meeting"] });
    expect(rules.at(-1)).toEqual({
      pattern: "webex_meetings.*.*.webex_delete_meeting",
      action: "block",
    });
  });
});
