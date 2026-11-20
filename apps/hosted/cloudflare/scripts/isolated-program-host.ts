import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig, unstable_startWorker } from "wrangler";
import { bundleProgramSandbox } from "./program-sandbox.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const deployed = unstable_readConfig({ config: join(root, "wrangler.jsonc") });
const scratch = await mkdtemp(join(tmpdir(), "executor-isolated-program-"));
const sandbox = await bundleProgramSandbox(root);
if (sandbox === undefined) throw new Error("Program sandbox did not build");
const sandboxModule = join(scratch, "program-sandbox.js");
await writeFile(sandboxModule, `export default ${JSON.stringify(sandbox)};\n`);
const config = join(scratch, "wrangler.json");
await writeFile(
  config,
  JSON.stringify({
    name: "isolated-program",
    main: join(root, "fixture/isolated-program.ts"),
    compatibility_date: deployed.compatibility_date,
    compatibility_flags: deployed.compatibility_flags,
    alias: { "executor:program-sandbox": sandboxModule },
    worker_loaders: [{ binding: "LOADER" }],
  }),
);

const worker = await unstable_startWorker({
  config,
  dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: scratch },
});
const url = await worker.url;
process.stdout.write(`listening ${url.origin}\n`);

const stop = async () => {
  await worker.dispose();
  await rm(scratch, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
