/**
 * Serve `fixture/live-stream.ts` in local workerd through Wrangler, with the compatibility date
 * and flags of this Worker's `wrangler.jsonc`, so the runtime behaves as the deployed one does.
 * Prints `listening <url>` when ready and runs until stopped.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig, unstable_startWorker } from "wrangler";

const here = dirname(fileURLToPath(import.meta.url));
const deployed = unstable_readConfig({ config: join(here, "../wrangler.jsonc") });
const scratch = await mkdtemp(join(tmpdir(), "executor-live-stream-"));
const config = join(scratch, "wrangler.json");
await writeFile(
  config,
  JSON.stringify({
    name: "live-stream",
    main: join(here, "../fixture/live-stream.ts"),
    compatibility_date: deployed.compatibility_date,
    compatibility_flags: deployed.compatibility_flags,
    durable_objects: { bindings: [{ name: "PRODUCT", class_name: "Product" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Product"] }],
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
