import { describe, expect, it } from "@effect/vitest";

import { connectionNaming, scopeFromTitle } from "./connection-naming";

describe("connectionNaming", () => {
  it("names a connection by the tenant its server's title names", () => {
    expect(connectionNaming({ identity: "Wiki · acme", account: "a@example.com" })).toEqual({
      qualifier: "acme",
      account: "a@example.com",
    });
  });

  it("names a connection by its account when the title names no tenant", () => {
    expect(connectionNaming({ identity: "Presidio Workspace", account: "a@example.com" })).toEqual({
      qualifier: "a@example.com",
      account: null,
    });
    expect(connectionNaming({ identity: null, account: " a@example.com " })).toEqual({
      qualifier: "a@example.com",
      account: null,
    });
  });

  it("names nothing when neither names the connection", () => {
    expect(connectionNaming({ identity: "Presidio Workspace", account: "" })).toEqual({
      qualifier: null,
      account: null,
    });
  });

  it("reads the scope after the last separator", () => {
    expect(scopeFromTitle("Muster · beta")).toBe("beta");
    expect(scopeFromTitle("A · B · c")).toBe("c");
    expect(scopeFromTitle(" · ")).toBeNull();
    expect(scopeFromTitle("Wiki")).toBeNull();
  });
});
