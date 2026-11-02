import { describe, expect, it } from "@effect/vitest";

import { loadCatalogPresets } from "./integration-plugin";

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe("loadCatalogPresets", () => {
  it("turns the host catalog into add-screen presets", async () => {
    const presets = await loadCatalogPresets(
      "/api/platform/mcp-servers",
      respond(200, {
        servers: [
          { slug: "muster", name: "Muster", summary: "", endpoint: "https://m.test/mcp" },
          { slug: 1, name: "bad" },
        ],
      }),
    );
    expect(presets).toEqual([
      {
        id: "catalog-muster",
        name: "Muster",
        summary: "",
        url: "https://m.test/mcp",
        endpoint: "https://m.test/mcp",
        featured: true,
        family: "Company",
        defaultSlug: "muster",
      },
    ]);
  });

  it("lists nothing when the catalog cannot be read", async () => {
    expect(await loadCatalogPresets("/x", respond(401, {}))).toEqual([]);
  });
});
