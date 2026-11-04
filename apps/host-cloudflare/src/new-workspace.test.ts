import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ensureAgentToolkit } from "./agent";
import {
  ensureStartingSet,
  STARTING_SET_SLUG,
  startWorkspace,
  teamConnectionPatterns,
} from "./new-workspace";
import { chosenAgent, teamChoices } from "./oauth";

type Row = {
  slug: string;
  owner: "user" | "org";
  patterns: string[];
  policies: { pattern: string; action: "approve" | "require_approval" | "block" }[];
};

const fakeToolkits = (seed: Row[] = []) => {
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
        Effect.succeed(rows.get(id)!.policies.map((policy) => ({ ...policy, position: "a0" }))),
      createPolicy: (
        id: string,
        input: { pattern: string; action: "approve" | "require_approval" | "block" },
      ) =>
        Effect.sync(() =>
          rows.get(id)!.policies.push({ pattern: input.pattern, action: input.action }),
        ),
    },
  };
};

const template: Row = {
  slug: STARTING_SET_SLUG,
  owner: "org",
  patterns: ["executor.coreTools.*", "webex_meetings.user.*"],
  policies: [{ pattern: "webex_meetings.*.*.webex_delete_meeting", action: "block" }],
};

const byslug = (rows: Map<string, Row>, slug: string) =>
  [...rows.values()].find((row) => row.slug === slug);

describe("new agent workspaces", () => {
  it.effect("start with a copy of the starting set's connections and rules", () =>
    Effect.gen(function* () {
      const { rows, api } = fakeToolkits([template]);
      yield* startWorkspace(api, { slug: "ai-studio", name: "AI Studio" }, [
        "muster.org.museTeam.*",
      ]);
      expect(byslug(rows, "ai-studio")).toEqual({
        slug: "ai-studio",
        owner: "org",
        patterns: ["executor.coreTools.*", "webex_meetings.user.*", "muster.org.museTeam.*"],
        policies: template.policies,
      });
    }),
  );

  it.effect("leave an existing workspace and the starting set itself alone", () =>
    Effect.gen(function* () {
      const { rows, api } = fakeToolkits([
        template,
        { slug: "ai-studio", owner: "org", patterns: ["wiki.org.x.*"], policies: [] },
      ]);
      yield* startWorkspace(api, { slug: "ai-studio", name: "AI Studio" });
      yield* startWorkspace(api, { slug: STARTING_SET_SLUG, name: "x" });
      expect(rows.size).toBe(2);
      expect(byslug(rows, "ai-studio")!.patterns).toEqual(["wiki.org.x.*"]);
    }),
  );

  it.effect("start empty when no admin has made a starting set", () =>
    Effect.gen(function* () {
      const { rows, api } = fakeToolkits();
      yield* startWorkspace(api, { slug: "ai-studio", name: "AI Studio" });
      expect(byslug(rows, "ai-studio")!.patterns).toEqual([]);
      yield* ensureStartingSet(api);
      yield* ensureStartingSet(api);
      expect([...rows.values()].filter((row) => row.slug === STARTING_SET_SLUG)).toHaveLength(1);
    }),
  );

  it.effect("are made through the starting set when the first session makes them", () =>
    Effect.gen(function* () {
      const { rows, api } = fakeToolkits([template]);
      yield* ensureAgentToolkit(
        api,
        "ai-studio",
        startWorkspace(api, { slug: "ai-studio", name: "ai-studio" }),
      );
      expect(byslug(rows, "ai-studio")!.patterns).toEqual(template.patterns);
    }),
  );

  it("take a team's Workspace Wiki and Muster connections, by the server's title", () => {
    const connections = [
      { owner: "org", integration: "muster", name: "a", title: "Muster · Team_Eichten" },
      { owner: "org", integration: "wiki", name: "b", title: "Wiki · team-eichten" },
      { owner: "org", integration: "wiki", name: "c", title: "Wiki · beta" },
      { owner: "user", integration: "wiki", name: "d", title: "Wiki · team-eichten" },
      { owner: "org", integration: "github", name: "e", title: "GitHub · team-eichten" },
      { owner: "org", integration: "muster", name: "f", title: null },
    ];
    expect(
      teamConnectionPatterns(connections, ["wiki", "muster"], {
        slug: "team-eichten",
        name: "Team_Eichten",
      }),
    ).toEqual(["muster.org.a.*", "wiki.org.b.*"]);
  });

  it("never treat the starting set as an agent at sign-in", () => {
    const existing = [{ slug: STARTING_SET_SLUG, name: "New workspaces start with" }];
    expect(chosenAgent({ pick: STARTING_SET_SLUG, typed: "" }, existing)).toBeNull();
    expect(chosenAgent({ pick: null, typed: "New Workspaces" }, existing)).toBeNull();
    expect(chosenAgent({ pick: null, typed: "Claude" }, existing)).toEqual({
      slug: "claude",
      name: "Claude",
    });
  });

  it("offer the person's teams with no team checked", () => {
    const html = teamChoices([
      { tenant: { slug: "team-eichten", name: "Team_Eichten" }, role: "member" },
    ]);
    expect(html).toContain('value="" checked> No team');
    expect(html).toContain('value="team-eichten"> Team_Eichten');
    expect(teamChoices([])).toBe("");
  });
});
