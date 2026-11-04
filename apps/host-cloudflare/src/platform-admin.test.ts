import { describe, expect, it } from "@effect/vitest";

import { connectionPattern, pickables, toolRulePattern, type ToolView } from "./platform-admin";

const tool = (over: Partial<ToolView>): ToolView => ({
  address: "tools.wiki.org.teamWiki.search",
  owner: "org",
  integration: "wiki",
  connection: "teamWiki",
  name: "search",
  description: "",
  ...over,
});

describe("platform admin page", () => {
  it("picks a tool's connection the way a workspace does", () => {
    expect(connectionPattern(tool({}))).toBe("wiki.org.teamWiki.*");
    expect(
      connectionPattern(
        tool({
          address: "tools.webex_meetings.user.main.list_meetings",
          owner: "user",
          integration: "webex_meetings",
          connection: "main",
          name: "list_meetings",
        }),
      ),
    ).toBe("webex_meetings.user.main.*");
    expect(
      connectionPattern(
        tool({
          static: true,
          address: "executor.coreTools.integrations.list",
          owner: "user",
          integration: "executor",
          connection: "coreTools",
          name: "coreTools.integrations.list",
        }),
      ),
    ).toBe("executor.coreTools.*");
  });

  it("hides a tool on every connection, or a whole server", () => {
    expect(toolRulePattern("wiki", tool({}))).toBe("wiki.*.*.search");
    expect(toolRulePattern("wiki", null)).toBe("wiki.*");
    const core = tool({
      static: true,
      address: "executor.coreTools.integrations.list",
      name: "coreTools.integrations.list",
    });
    expect(toolRulePattern("executor", core)).toBe("executor.coreTools.integrations.list");
  });

  it("names each connection once, by the server's title when it has one", () => {
    const rows = pickables(
      [
        tool({}),
        tool({ name: "read_note", address: "tools.wiki.org.teamWiki.read_note" }),
        tool({
          address: "tools.webex_meetings.user.main.list",
          owner: "user",
          integration: "webex_meetings",
          connection: "main",
          name: "list",
        }),
      ],
      new Map([["webex_meetings", "Webex Meetings"]]),
      new Map([["wiki.teamWiki", "Wiki · team-eichten"]]),
    );
    expect(rows).toEqual([
      {
        pattern: "webex_meetings.user.main.*",
        label: "Webex Meetings (each person's own)",
        personal: true,
      },
      { pattern: "wiki.org.teamWiki.*", label: "Wiki · team-eichten", personal: false },
    ]);
  });
});
