/**
 * Run `fixture/mcp-wire-versions.ts` and print its report as one JSON line. The fixture is bundled
 * first, as the session object and product Workers are.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = await mkdtemp(join(tmpdir(), "executor-mcp-wire-"));
try {
  const bundle = await build({
    entryPoints: [join(here, "../fixture/mcp-wire-versions.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    conditions: ["workerd", "worker"],
    write: false,
    logLevel: "error",
  });
  const file = join(out, "fixture.mjs");
  await writeFile(file, bundle.outputFiles[0]!.text);
  const { run } = (await import(pathToFileURL(file).href)) as {
    run: () => Promise<unknown>;
  };
  console.log(JSON.stringify(await run()));
} finally {
  await rm(out, { recursive: true, force: true });
}
