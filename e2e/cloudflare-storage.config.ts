import { defineConfig } from "vitest/config";

/**
 * Runs the Cloudflare host's storage adapters in local workerd: R2 simulated by Miniflare and
 * Artifacts answered by real Git, since Artifacts has no local simulator; and the product's move
 * into a placed object and the MCP backend wire, across a release.
 */
export default defineConfig({
  test: {
    include: [
      "e2e/tests/cloudflare-storage.spec.ts",
      "e2e/tests/cloudflare-product-move.spec.ts",
      "e2e/tests/cloudflare-mcp-wire.spec.ts",
      "e2e/tests/cloudflare-live-stream.spec.ts",
    ],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
