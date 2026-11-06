/**
 * Writes the build-time modules the Worker imports as `executor:skills` and `executor:dashboard`:
 * the Executor skill files, and the dashboard's browser files with their content types. Wrangler
 * runs this before every build (`build.command`); the dashboard must be built first.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { readExecutorSkills } from "@executor-js/app-templates/executor";
import { Effect, FileSystem, Path } from "effect";

const types: Readonly<Record<string, string>> = {
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

const generate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const web = path.resolve(root, "../self-host/web/dist/client");
  if (!(yield* fs.exists(web)))
    return yield* Effect.die(
      new Error(`${web} is missing; run \`bun run hosted:self-host:web:build\` first`),
    );
  const dashboard = Object.fromEntries(
    (yield* fs.readDirectory(web, { recursive: true }))
      .filter((name) => path.extname(name) !== "")
      .sort()
      .map((name) => [
        name.split(path.sep).join("/"),
        types[path.extname(name)] ?? "application/octet-stream",
      ]),
  );
  const skills = Object.fromEntries(
    (yield* readExecutorSkills).map((file) => [file.path, file.content]),
  );
  const output = path.join(root, "generated");
  yield* fs.makeDirectory(output, { recursive: true });
  yield* fs.writeFileString(
    path.join(output, "dashboard.js"),
    `export default ${JSON.stringify(dashboard)};\n`,
  );
  yield* fs.writeFileString(
    path.join(output, "skills.js"),
    `export default ${JSON.stringify(skills)};\n`,
  );
  yield* Effect.logInfo(
    `Generated ${Object.keys(dashboard).length} dashboard files and ${Object.keys(skills).length} skill files`,
  );
});

NodeRuntime.runMain(generate.pipe(Effect.provide(NodeServices.layer)));
