import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { timeoutDrillTools } from "./timeout-drill";

const tools = { list: () => Effect.succeed(["a"]), schema: () => Effect.succeed(null) };

describe("timeoutDrillTools", () => {
  it("leaves every other agent's tools as they are", () => {
    const kept = timeoutDrillTools({ resource: { kind: "toolkit", slug: "team-francis" } }, tools);
    expect(kept).toBe(tools);
  });

  it("makes a drill agent's tool lists never answer", () => {
    const drill = timeoutDrillTools({ resource: { kind: "toolkit", slug: "test-timeout" } }, tools);
    expect(drill).not.toBe(tools);
    expect(drill.schema).toBe(tools.schema);
  });
});
