import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AGENT_SLUG, agentRequest, agentSlug, ensureAgentToolkit } from "./agent";

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

  it.effect("makes an agent's toolkit once, open to what the tenant approved", () =>
    Effect.gen(function* () {
      const made: { slug: string; pattern?: string }[] = [];
      const toolkits = {
        list: () => Effect.succeed(made.map((t, i) => ({ id: `tk${i}`, slug: t.slug }))),
        create: (input: { slug: string }) => {
          made.push({ slug: input.slug });
          return Effect.succeed({ id: `tk${made.length - 1}` });
        },
        createConnection: (id: string, input: { pattern: string }) => {
          made[Number(id.slice(2))]!.pattern = input.pattern;
          return Effect.void;
        },
      };
      yield* ensureAgentToolkit(toolkits, "ai-studio");
      yield* ensureAgentToolkit(toolkits, "ai-studio");
      expect(made).toEqual([{ slug: "ai-studio", pattern: "*" }]);
    }),
  );
});
