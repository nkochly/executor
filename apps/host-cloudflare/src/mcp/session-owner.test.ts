// oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: each case reproduces a plain Error the Cloudflare runtime itself throws out of a stub RPC
import { describe, expect, it } from "@effect/vitest";

import type { CloudflareEnv } from "../config";
import { checkSessionOwner } from "./session-owner";

const RETIRED =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";

/** An MCP_SESSION namespace whose stubs answer `validateMcpSessionOwner` from a script. */
const envAnswering = (answers: ReadonlyArray<string | Error>) => {
  let calls = 0;
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the MCP_SESSION binding is read
  const env = {
    MCP_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        validateMcpSessionOwner: async () => {
          const answer = answers[Math.min(calls, answers.length - 1)]!;
          calls += 1;
          if (typeof answer !== "string") throw answer;
          return answer;
        },
      }),
    },
  } as unknown as CloudflareEnv;
  return { env, calls: () => calls };
};

const owner = { accountId: "acct", organizationId: "org" };
const resource = { kind: "toolkit", slug: "claude" } as const;

describe("checkSessionOwner", () => {
  it("keeps the session when a deploy retires the instance mid-check", async () => {
    const { env, calls } = envAnswering([new Error(RETIRED), "ok"]);
    expect(await checkSessionOwner(env, "s1", owner, resource)).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("answers a reset that outlives the retry as transient, not a 500", async () => {
    const { env, calls } = envAnswering([new Error(RETIRED)]);
    expect(await checkSessionOwner(env, "s1", owner, resource)).toEqual({
      kind: "instance_replaced",
      disposition: "transient",
    });
    expect(calls()).toBe(2);
  });

  it("does not retry a session that destroyed itself", async () => {
    const { env, calls } = envAnswering([new Error("destroyed")]);
    expect(await checkSessionOwner(env, "s1", owner, resource)).toEqual({
      kind: "destroyed",
      disposition: "session_dead",
    });
    expect(calls()).toBe(1);
  });

  it("rethrows a failure it does not recognize", async () => {
    const { env } = envAnswering([new Error("boom")]);
    await expect(checkSessionOwner(env, "s1", owner, resource)).rejects.toThrow("boom");
  });
});
