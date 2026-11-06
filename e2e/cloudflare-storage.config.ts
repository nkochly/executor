import { defineConfig } from "vitest/config";

/**
 * Runs the Cloudflare host's storage adapters in local workerd: R2 simulated by Miniflare and
 * Artifacts answered by real Git, since Artifacts has no local simulator.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/cloudflare-storage.spec.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
