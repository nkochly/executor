import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "e2e/tests/cloudflare-storage.spec.ts",
      "e2e/tests/cloudflare-product-move.spec.ts",
      "e2e/tests/cloudflare-product-backup.spec.ts",
      "e2e/tests/cloudflare-mcp-wire.spec.ts",
      "e2e/tests/cloudflare-live-stream.spec.ts",
      "e2e/tests/cloudflare-isolated-program.spec.ts",
      "e2e/tests/cloudflare-product-reset.spec.ts",
      "e2e/tests/cloudflare-build-reads.spec.ts",
      "e2e/tests/cloudflare-account-reconnects.spec.ts",
    ],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
