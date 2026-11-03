import { describe, expect, it } from "@effect/vitest";

import { ATTRIBUTION_META_KEY, makeAttributionMeta } from "./attribution";

const wiki = "https://wiki.example.test/mcp";
const muster = "https://muster.example.test/mcp";

const make = (client?: { name: string; version?: string }) =>
  makeAttributionMeta({
    origins: [wiki, muster],
    client: () => client,
    person: () => "pat@example.test",
    agent: "scout",
  });

describe("write attribution", () => {
  it("stamps client, person and agent on first-party calls only", () => {
    const meta = make({ name: "Claude Code", version: "2.1.0" });
    expect(meta({ endpoint: wiki, toolName: "write_note", args: {} })).toEqual({
      [ATTRIBUTION_META_KEY]: {
        client: "Claude Code 2.1.0",
        person: "pat@example.test",
        agent: "scout",
      },
    });
    expect(
      meta({ endpoint: "https://other.example.test/mcp", toolName: "write_note", args: {} }),
    ).toBeUndefined();
  });

  it("carries the last guide the session read, across both servers", () => {
    const meta = make({ name: "Studio AI" });
    meta({ endpoint: muster, toolName: "guides", args: { name: "task-lifecycle" } });
    expect(meta({ endpoint: wiki, toolName: "write_note", args: {} })).toEqual({
      [ATTRIBUTION_META_KEY]: {
        client: "Studio AI",
        person: "pat@example.test",
        agent: "scout",
        guide: "task-lifecycle",
      },
    });
    // The index (no name) leaves the last guide in place.
    meta({ endpoint: wiki, toolName: "guides", args: {} });
    expect(meta({ endpoint: wiki, toolName: "write_note", args: {} })).toMatchObject({
      [ATTRIBUTION_META_KEY]: { guide: "task-lifecycle" },
    });
  });

  it("sends nothing when there is nothing to say", () => {
    const meta = makeAttributionMeta({
      origins: [wiki],
      client: () => undefined,
      person: () => undefined,
    });
    expect(meta({ endpoint: wiki, toolName: "write_note", args: {} })).toBeUndefined();
  });

  it("caps each field", () => {
    const meta = makeAttributionMeta({
      origins: [wiki],
      client: () => ({ name: "x".repeat(500) }),
      person: () => undefined,
    });
    const stamp = meta({ endpoint: wiki, toolName: "write_note", args: {} })?.[
      ATTRIBUTION_META_KEY
    ] as { client: string };
    expect(stamp.client).toHaveLength(200);
  });
});
