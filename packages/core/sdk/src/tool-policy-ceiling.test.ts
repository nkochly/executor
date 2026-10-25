import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import { ToolAddress } from "./ids";
import { definePlugin, type ToolPolicyProviderRule } from "./plugin";
import { makeTestExecutor } from "./testing";

// A toolkit-shaped provider: an allowlist of rules standing in for one
// connection's chosen tool set.
const toolkitPlugin = (rules: readonly ToolPolicyProviderRule[]) =>
  definePlugin(() => ({
    id: "test-toolkit" as const,
    storage: () => ({}),
    toolPolicyProvider: () => ({ list: () => Effect.succeed(rules) }),
  }))();

const TOOL = "executor.coreTools.integrations.list";
const address = ToolAddress.make(TOOL);
const coreTools = { webBaseUrl: "http://localhost:3000" };
const approveAll: ToolPolicyProviderRule = {
  id: "r-all",
  pattern: "*",
  action: "approve",
  position: "a0",
};

const isBlocked = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result) && Predicate.isTagged("ToolBlockedError")(result.failure);

describe("toolPolicyCeiling", () => {
  it.effect("without a ceiling an active toolkit replaces the org rows", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools,
        plugins: [toolkitPlugin([approveAll])] as const,
      });
      yield* executor.policies.create({ owner: "org", pattern: TOOL, action: "block" });
      const result = yield* Effect.result(executor.execute(address, {}));
      expect(isBlocked(result)).toBe(false);
    }),
  );

  it.effect("an org block bounds what the toolkit approves", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools,
        toolPolicyCeiling: { unmatched: "default" },
        plugins: [toolkitPlugin([approveAll])] as const,
      });
      yield* executor.policies.create({ owner: "org", pattern: TOOL, action: "block" });
      const result = yield* Effect.result(executor.execute(address, {}));
      expect(isBlocked(result)).toBe(true);
    }),
  );

  it.effect("unmatched block hides tools the workspace has not approved", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools,
        toolPolicyCeiling: { unmatched: "block" },
        plugins: [toolkitPlugin([approveAll])] as const,
      });
      const blocked = yield* Effect.result(executor.execute(address, {}));
      expect(isBlocked(blocked)).toBe(true);
      const listed = yield* executor.tools.list();
      expect(listed.some((tool) => String(tool.address) === TOOL)).toBe(false);

      yield* executor.policies.create({ owner: "org", pattern: "executor.*", action: "approve" });
      const allowed = yield* Effect.result(executor.execute(address, {}));
      expect(isBlocked(allowed)).toBe(false);
    }),
  );

  it.effect("a personal approve cannot lift the workspace ceiling", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools,
        toolPolicyCeiling: { unmatched: "block" },
      });
      yield* executor.policies.create({ owner: "user", pattern: TOOL, action: "approve" });
      const result = yield* Effect.result(executor.execute(address, {}));
      expect(isBlocked(result)).toBe(true);
    }),
  );

  it.effect("the toolkit still narrows inside the ceiling", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        coreTools,
        toolPolicyCeiling: { unmatched: "block" },
        plugins: [
          toolkitPlugin([{ id: "r-none", pattern: "other.*", action: "approve", position: "a0" }]),
        ] as const,
      });
      yield* executor.policies.create({ owner: "org", pattern: "*", action: "approve" });
      const result = yield* Effect.result(executor.execute(address, {}));
      expect(isBlocked(result)).toBe(true);
    }),
  );
});
