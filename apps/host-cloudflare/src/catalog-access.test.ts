import { describe, expect, it } from "@effect/vitest";

import { accessFor, COMPANY, EVERYTHING, listOf, type CatalogState } from "./catalog-access";
import { listId, peopleRows } from "./catalog-admin";

const state = (over: Partial<CatalogState> = {}): CatalogState => ({
  lists: [{ id: "sales", name: "Sales basics", integrations: ["wiki", "muster"] }],
  people: new Map([["ann@example.com", "sales"]]),
  defaultList: EVERYTHING,
  ...over,
});

describe("catalog lists", () => {
  it("leaves people with no list where they were: see all, add none", () => {
    const fresh = state({ defaultList: COMPANY, people: new Map() });
    expect(listOf(fresh, "bo@example.com")).toBe(COMPANY);
    expect(accessFor(fresh, "bo@example.com", false)).toEqual({ visible: "all", canAdd: false });
    expect(listOf(state({ defaultList: "gone" }), "bo@example.com")).toBe(COMPANY);
  });

  it("gives a person their own list, else the default", () => {
    expect(listOf(state(), "Ann@Example.com")).toBe("sales");
    expect(listOf(state(), "bo@example.com")).toBe(EVERYTHING);
    expect(listOf(state({ defaultList: "sales" }), "bo@example.com")).toBe("sales");
    expect(
      listOf(
        state({ people: new Map([["ann@example.com", "gone"]]), defaultList: "sales" }),
        "ann@example.com",
      ),
    ).toBe("sales");
  });

  it("lets Everything and admins see and add all, and a list only its own", () => {
    expect(accessFor(state(), "bo@example.com", false)).toEqual({ visible: "all", canAdd: true });
    expect(accessFor(state(), "ann@example.com", true)).toEqual({ visible: "all", canAdd: true });
    const ann = accessFor(state(), "ann@example.com", false);
    expect(ann.canAdd).toBe(false);
    expect(ann.visible).toEqual(new Set(["wiki", "muster"]));
  });

  it("names a new list from its name without taking Everything's id", () => {
    expect(listId("Sales basics!", [])).toBe("sales-basics");
    expect(listId("Sales basics", ["sales-basics"])).toBe("sales-basics-2");
    expect(listId("Everything", [])).toBe("everything-list");
    expect(listId("Company", [])).toBe("company-list");
    expect(listId("???", [])).toBe("list");
  });

  it("offers everyone seen, connected or given a list, once", () => {
    const rows = peopleRows(
      [{ email: "cy@example.com", seenAt: 5 }],
      [["Bo@example.com", "cy@example.com"]],
      state(),
    );
    expect(rows).toEqual([
      { email: "ann@example.com", list: "sales", seenAt: null },
      { email: "bo@example.com", list: null, seenAt: null },
      { email: "cy@example.com", list: null, seenAt: 5 },
    ]);
  });
});
