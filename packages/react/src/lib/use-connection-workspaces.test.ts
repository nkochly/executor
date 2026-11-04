import { describe, expect, it } from "@effect/vitest";
import type { Connection } from "@executor-js/sdk/shared";

import { workspacesUsing } from "./use-connection-workspaces";

// oxlint-disable-next-line executor/no-double-cast -- test fixture: only the address fields matter
const wiki = {
  owner: "org",
  integration: "wiki",
  name: "nkochlyPresidioCom",
} as unknown as Connection;

describe("workspacesUsing", () => {
  it("names the workspaces whose picks reach the connection", () => {
    expect(
      workspacesUsing(wiki, [
        { name: "ai-studio-nkochly", patterns: ["wiki.org.nkochlyPresidioCom.*"] },
        { name: "claude", patterns: ["*"] },
        { name: "muster-only", patterns: ["muster.org.nkochlyPresidioCom.*"] },
        { name: "other-wiki", patterns: ["wiki.org.nkochlyPresidioCom2.*"] },
        { name: "empty", patterns: [] },
      ]),
    ).toEqual(["ai-studio-nkochly", "claude"]);
  });
});
