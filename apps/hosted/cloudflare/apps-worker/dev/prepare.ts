/** Development only: the product's build-time asset modules, as self-host's packaging makes them. */
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dirname;
const generated = path.join(here, ".generated");
const web = path.resolve(here, "../../../self-host/web/dist/client");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};
const files = (await readdir(web, { recursive: true })).filter((name) => path.extname(name) !== "");
const dashboard = Object.fromEntries(
  files.map((name) => [
    name.split(path.sep).join("/"),
    types[path.extname(name)] ?? "application/octet-stream",
  ]),
);
const skills = Object.fromEntries(
  (await Effect.runPromise(readExecutorSkills.pipe(Effect.provide(NodeServices.layer)))).map(
    (file) => [file.path, file.content],
  ),
);
await mkdir(generated, { recursive: true });
await writeFile(path.join(generated, "skills.js"), `export default ${JSON.stringify(skills)};\n`);
await writeFile(
  path.join(generated, "dashboard.js"),
  `export default ${JSON.stringify(dashboard)};\n`,
);
// The product imports PGlite's modules; with EXECUTOR_DATABASE=sqlite nothing reads them.
await writeFile(path.join(generated, "unused.js"), "export default undefined;\n");
console.log(`skills ${Object.keys(skills).length}, dashboard files ${files.length}`);
