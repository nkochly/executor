/**
 * Tool search rows on SQLite under the Durable Object SQL limits: a statement binds at most 100
 * parameters there, where a native file allows thousands.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { nativeSqliteStorage } from "fumadb-effect/sqlite-native";
import { sqliteLayer } from "fumadb-effect/sqlite";
import { describe, expect, it } from "vitest";
import { makeToolSearchStore } from "../src/implementation/tool-search-store.ts";
import { ToolSearchListing } from "../src/contracts/tools.ts";

const tables = [
  `create table executor_tool_search_listings (listing text primary key, owner text, app text,
    deployment text, profile text, at integer, digest text, routers text, superseded integer,
    target text)`,
  `create table executor_tool_search (id text primary key, listing text, name text,
    read_only integer, terms text, length integer, signature text, tool text, definitions text)`,
  `create table executor_tool_search_definitions (id text primary key, listing text,
    position integer, definition text)`,
];

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => {
  const storage = nativeSqliteStorage(":memory:");
  for (const statement of tables) storage.sql.exec(statement);
  return Effect.runPromise(effect.pipe(Effect.provide(sqliteLayer(storage))));
};

describe("native SQLite storage", () => {
  it("refuses a statement with more than 100 bound parameters, as a Durable Object does", () => {
    const storage = nativeSqliteStorage(":memory:");
    const values = Array.from({ length: 101 }, (_, index) => index);
    expect(() => storage.sql.exec(`select ${values.map(() => "?").join(", ")}`, ...values)).toThrow(
      /too many SQL variables/,
    );
  });
});

describe("tool search store on SQLite", () => {
  it("writes a listing whose rows bind more than 100 parameters in all", async () => {
    // The wiki app lists about 25 tools; each tool row binds 9 parameters.
    const tools = Array.from({ length: 30 }, (_, index) => ({
      name: `tool_${index}`,
      readOnly: index % 2 === 0,
      terms: ["tool", `name${index}`],
      signature: `sig${index}`,
      tool: { name: `tool_${index}` },
      definitions: [0],
    }));
    const definitions = Array.from({ length: 30 }, (_, index) => ({ position: index }));
    const listing = ToolSearchListing.make("listing-1");
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeToolSearchStore(sql);
        yield* store.write(
          {
            listing,
            owner: "owner-1",
            app: "app-1",
            version: "version-1",
            target: "target-1",
            at: 1,
            digest: "digest-1",
            routers: [],
          } as never,
          { tools, definitions } as never,
        );
        const [counted] = yield* sql<{ n: number }>`select count(*) as n from executor_tool_search`;
        const [defined] = yield* sql<{
          n: number;
        }>`select count(*) as n from executor_tool_search_definitions`;
        expect(counted?.n).toBe(30);
        expect(defined?.n).toBe(30);
      }),
    );
  });

  it("reads a page whose tools name more than 100 definitions in all", async () => {
    const tools = Array.from({ length: 30 }, (_, index) => ({
      name: `tool_${index}`,
      readOnly: true,
      terms: ["tool"],
      signature: `sig${index}`,
      tool: {
        app: "app_1",
        version: "dpl_1",
        name: `tool_${index}`,
        description: "",
        inputSchema: {},
      },
      definitions: Array.from({ length: 10 }, (_, position) => (index + position) % 30),
    }));
    const definitions = Array.from({ length: 30 }, (_, index) => ({ position: index }));
    const listing = ToolSearchListing.make("listing-1");
    await run(
      Effect.gen(function* () {
        const store = makeToolSearchStore(yield* SqlClient.SqlClient);
        yield* store.write(
          {
            listing,
            owner: "owner-1",
            app: "app-1",
            version: "version-1",
            target: "target-1",
            at: 1,
            digest: "digest-1",
            routers: [],
          } as never,
          { tools, definitions } as never,
        );
        const page = yield* store.page({
          targets: [
            {
              listing,
              app: "app-1",
              target: "target-1",
              labels: [],
              scopes: [{ readOnly: true, names: [] }],
            } as never,
          ],
          terms: [],
          offset: 0,
          limit: 30,
        });
        expect(page.items).toHaveLength(30);
        expect(page.definitions.length).toBeGreaterThan(0);
      }),
    );
  });
});
