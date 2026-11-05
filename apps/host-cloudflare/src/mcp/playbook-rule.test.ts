import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import { sessionInstructions, teamPageInstructions } from "../tenancy";
import { PLAYBOOK_RULE, PLAYBOOK_RULE_SHA256 } from "./playbook-rule";

// wiki_mcp and Muster pin the same digest. A copy that drifts in any of the
// three repositories fails its own test here.
describe("the playbook-first rule", () => {
  it("is worded exactly as the digest every repository pins", () => {
    expect(createHash("sha256").update(PLAYBOOK_RULE).digest("hex")).toBe(PLAYBOOK_RULE_SHA256);
    expect(PLAYBOOK_RULE_SHA256).toBe(
      "9fc5660d919d4b12188e0baa85f5330dc2e0b559d2279fdc9b277e0115e7b173",
    );
  });

  it("is the whole instructions when the caller has no team page", () => {
    expect(sessionInstructions([])).toBe(PLAYBOOK_RULE);
  });

  it("opens the instructions, with the team page after it", () => {
    const page = {
      wiki: "acme/root",
      path: "how-we-work.md",
      starter: false,
      version: 3,
      body: "<<<TEAM_PAGE>>>\n║ # How we work\n<<<END_TEAM_PAGE>>>",
    };
    expect(sessionInstructions([page])).toBe(`${PLAYBOOK_RULE}\n\n${teamPageInstructions(page)}`);
  });

  it("keeps one page per team, each named by its wiki, when the person is in several", () => {
    const page = (wiki: string) => ({
      wiki,
      path: "how-we-work.md",
      starter: true,
      version: 0,
      body: `<<<TEAM_PAGE>>>\n║ ${wiki}\n<<<END_TEAM_PAGE>>>`,
    });
    expect(sessionInstructions([])).toBe(PLAYBOOK_RULE);
    expect(sessionInstructions([page("acme/root")])).toBe(
      `${PLAYBOOK_RULE}\n\n${teamPageInstructions(page("acme/root"))}`,
    );
    const both = sessionInstructions([page("acme/root"), page("beta/root")]);
    expect(both.startsWith(`${PLAYBOOK_RULE}\n\nYou work with 2 teams.`)).toBe(true);
    expect(both).toContain(teamPageInstructions(page("acme/root")));
    expect(both).toContain(teamPageInstructions(page("beta/root")));
  });

  it("says nothing about shells or running code", () => {
    expect(PLAYBOOK_RULE).not.toMatch(/shell|terminal|command|script|execute|run code/i);
  });
});
