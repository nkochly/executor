import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AGENT_SLUG,
  agentHasCoreTools,
  agentRequest,
  agentSlug,
  ensureAgentToolkit,
} from "./agent";

describe("agent sign-in", () => {
  it("turns a typed agent name into a toolkit slug", () => {
    expect(agentSlug("  AI Studio (work) ")).toBe("ai-studio-work");
    expect(AGENT_SLUG.test(agentSlug("***"))).toBe(false);
  });

  it("serves every call as the token's agent, whatever path the client used", () => {
    const request = agentRequest(
      new Request("https://executor.example/mcp/toolkits/other?x=1", { method: "POST" }),
      "ai-studio",
    );
    const url = new URL(request.url);
    expect(url.pathname).toBe("/mcp/toolkits/ai-studio");
    expect(request.method).toBe("POST");
  });

  const fakeToolkits = (
    seed: { slug: string; owner: "user" | "org"; patterns: string[]; policies: string[] }[] = [],
  ) => {
    const rows = new Map(seed.map((row, i) => [`seed${i}`, { ...row }]));
    let next = 0;
    return {
      rows,
      api: {
        list: () =>
          Effect.succeed([...rows].map(([id, row]) => ({ id, slug: row.slug, owner: row.owner }))),
        create: (input: { slug: string; owner: "user" | "org" }) => {
          const id = `tk${next++}`;
          rows.set(id, { slug: input.slug, owner: input.owner, patterns: [], policies: [] });
          return Effect.succeed({ id });
        },
        remove: (id: string) => Effect.sync(() => rows.delete(id)),
        listConnections: (id: string) =>
          Effect.succeed(rows.get(id)!.patterns.map((pattern) => ({ pattern, position: "a0" }))),
        createConnection: (id: string, input: { pattern: string }) =>
          Effect.sync(() => rows.get(id)!.patterns.push(input.pattern)),
        listPolicies: (id: string) =>
          Effect.succeed(
            rows
              .get(id)!
              .policies.map((pattern) => ({ pattern, action: "block" as const, position: "a0" })),
          ),
        createPolicy: (id: string, input: { pattern: string }) =>
          Effect.sync(() => rows.get(id)!.policies.push(input.pattern)),
      },
    };
  };

  it.effect("gives an agent Executor's own tools only when its workspace picked them", () =>
    Effect.gen(function* () {
      const { api } = fakeToolkits([
        { slug: "wiki-only", owner: "org", patterns: ["wiki.org.team.*"], policies: [] },
        { slug: "with-core", owner: "org", patterns: ["executor.coreTools.*"], policies: [] },
        { slug: "everything", owner: "org", patterns: ["*"], policies: [] },
      ]);
      expect(yield* agentHasCoreTools(api, "wiki-only")).toBe(false);
      expect(yield* agentHasCoreTools(api, "with-core")).toBe(true);
      expect(yield* agentHasCoreTools(api, "everything")).toBe(true);
    }),
  );

  it.effect("makes every agent a workspace toolkit, once", () =>
    Effect.gen(function* () {
      const { rows, api } = fakeToolkits();
      yield* ensureAgentToolkit(api, "ai-studio");
      yield* ensureAgentToolkit(api, "ai-studio");
      expect([...rows.values()]).toEqual([
        { slug: "ai-studio", owner: "org", patterns: [], policies: [] },
      ]);
    }),
  );

  it.effect("moves an earlier personal agent to the workspace with its picks", () =>
    Effect.gen(function* () {
      const { rows, api } = fakeToolkits([
        {
          slug: "beta-agent",
          owner: "user",
          patterns: ["muster.user.muster-beta.*"],
          policies: ["muster.user.muster-beta.delete_task"],
        },
      ]);
      yield* ensureAgentToolkit(api, "beta-agent");
      expect([...rows.values()]).toEqual([
        {
          slug: "beta-agent",
          owner: "org",
          patterns: ["muster.user.muster-beta.*"],
          policies: ["muster.user.muster-beta.delete_task"],
        },
      ]);
    }),
  );
});
