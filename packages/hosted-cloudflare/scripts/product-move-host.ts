/**
 * Serve `fixture/product-move.ts` in local workerd through Miniflare: this release's product
 * objects beside an object of the release before the move. Prints `listening <url>` when ready and
 * runs until stopped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));
const persist = await mkdtemp(join(tmpdir(), "executor-product-move-"));

const bundle = await build({
  entryPoints: [join(here, "../fixture/product-move.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:workers", "node:*"],
  write: false,
  logLevel: "error",
});

const miniflare = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0]!.text,
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  host: "127.0.0.1",
  port: 0,
  durableObjects: {
    PRODUCT: { className: "Product", useSQLite: true },
    PREVIOUS_RELEASE: { className: "PreviousRelease", useSQLite: true },
  },
  durableObjectsPersist: persist,
  bindings: { EXECUTOR_PRODUCT_LOCATION: "wnam" },
});

const url = await miniflare.ready;
process.stdout.write(`listening ${url.origin}\n`);

const stop = async () => {
  await miniflare.dispose();
  await rm(persist, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
