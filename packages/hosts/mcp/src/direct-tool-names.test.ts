import { describe, expect, it } from "@effect/vitest";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  ToolName,
  type Tool,
} from "@executor-js/sdk";

import { connectionToolLabels, directToolNames } from "./tool-server";

const tool = (integration: string, connection: string, name: string): Tool => ({
  address: ToolAddress.make(`${integration}.org.${connection}.${name}`),
  owner: "org",
  integration: IntegrationSlug.make(integration),
  connection: ConnectionName.make(connection),
  name: ToolName.make(name),
  pluginId: "mcp",
  description: name,
});

const conn = (integration: string, name: string, identity: string | null) => ({
  integration,
  owner: "org" as const,
  name,
  identityLabel: "nkochly@presidio.com",
  lastHealth: identity === null ? null : { status: "healthy" as const, checkedAt: 0, identity },
});

describe("directToolNames", () => {
  it("names a single connection's tools by integration alone", () => {
    const names = [
      ...directToolNames([tool("muster", "nkochlyPresidioCom2", "find_tasks")]).keys(),
    ];
    expect(names).toEqual(["muster_find_tasks"]);
  });

  it("names several connections' tools by each connection's tenant", () => {
    const tools = [
      tool("muster", "nkochlyPresidioCom2", "find_tasks"),
      tool("muster", "nkochlyPresidioCom3", "find_tasks"),
      tool("wiki", "nkochlyPresidioCom", "ask"),
    ];
    const labels = connectionToolLabels([
      conn("muster", "nkochlyPresidioCom2", "Muster · beta"),
      conn("muster", "nkochlyPresidioCom3", "Muster · team-eichten"),
      conn("wiki", "nkochlyPresidioCom", "Wiki · team-eichten"),
    ]);
    expect([...directToolNames(tools, labels).keys()]).toEqual([
      "muster_beta_find_tasks",
      "muster_team-eichten_find_tasks",
      "wiki_ask",
    ]);
  });

  it("falls back to the connection name without a tenant, or when two share one", () => {
    const labels = connectionToolLabels([
      conn("muster", "a", "Muster · beta"),
      conn("muster", "b", "Muster · beta"),
      conn("muster", "c", null),
    ]);
    expect(labels.size).toBe(0);
    const tools = [tool("muster", "a", "note"), tool("muster", "c", "note")];
    expect([...directToolNames(tools, labels).keys()]).toEqual(["muster_a_note", "muster_c_note"]);
  });
});
