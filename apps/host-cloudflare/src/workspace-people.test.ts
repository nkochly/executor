import { describe, expect, it } from "@effect/vitest";

import { agentChoices, ownSignInsNote } from "./oauth";
import { missingOwnSignIns, parsePeople, teamsFromConnections } from "./workspace-people";

describe("workspaces set up for people", () => {
  it("keeps only emails, lowercase, once each", () => {
    expect(parsePeople("Ann@Example.com, bo@example.com;ann@example.com  not-an-email")).toEqual([
      "ann@example.com",
      "bo@example.com",
    ]);
    expect(parsePeople(["", " Cy@Example.com "])).toEqual(["cy@example.com"]);
  });

  it("offers the teams named by Workspace connections to first-party servers", () => {
    const teams = teamsFromConnections(
      [
        { owner: "org", integration: "muster", title: "Muster · team-eichten" },
        { owner: "org", integration: "wiki", title: "Wiki · team-eichten" },
        { owner: "org", integration: "wiki", title: "Wiki · team-bryan" },
        { owner: "user", integration: "muster", title: "Muster · nkochly" },
        { owner: "org", integration: "github", title: "GitHub · acme" },
        { owner: "org", integration: "muster", title: null },
      ],
      ["muster", "wiki"],
    );
    expect(teams).toEqual(["team-bryan", "team-eichten"]);
  });

  it("names the personal sign-ins a workspace picks that the person has not made", () => {
    const patterns = [
      "muster.org.team-eichten.*",
      "webex.user.default.*",
      "salesforce.user.main.*",
      "executor.coreTools.*",
      "*",
    ];
    expect(missingOwnSignIns(patterns, [{ integration: "webex", name: "default" }])).toEqual([
      { integration: "salesforce", connection: "main" },
    ]);
    expect(missingOwnSignIns(patterns, [])).toHaveLength(2);
  });

  it("puts the workspace set up for the person first and picks it", () => {
    const existing = [
      { slug: "beta-agent", name: "Beta agent" },
      { slug: "eichten", name: "Team Eichten" },
    ];
    const html = agentChoices(existing, "Beta Agent", ["eichten"]);
    expect(html.indexOf("Team Eichten")).toBeLessThan(html.indexOf("Beta agent"));
    expect(html).toContain(
      'value="eichten" checked> Team Eichten <span class="hint">set up for you',
    );
    expect(html).not.toContain('value="beta-agent" checked');
    expect(html).not.toContain('value="+new" checked');
    // A workspace that is gone is not offered, and the page works as before.
    expect(agentChoices(existing, "AI Studio", ["gone"])).toContain('value="+new" checked');
  });

  it("tells the person which sign-ins are theirs to make", () => {
    const note = ownSignInsNote(
      [
        { workspace: "Team Eichten", integrations: ["Webex"] },
        { workspace: "Other", integrations: [] },
      ],
      "https://executor.example.com/presidio/toolkits",
    );
    expect(note).toContain("Team Eichten also uses Webex");
    expect(note).not.toContain("Other");
    expect(ownSignInsNote([], "https://x")).toBe("");
  });
});
