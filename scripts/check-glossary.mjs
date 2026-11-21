import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKS = [
  { file: "GLOSSARY.md", what: "shared core", start: "<!-- glossary-core:start -->", end: "<!-- glossary-core:end -->", sha256: "8a0be34a7f739f135cc0a42b6de4b822382f41b09e8659ce3de230dc0d48e805" },
  { file: "CLAUDE.md", what: "shared rules", start: "<!-- shared-rules:start -->", end: "<!-- shared-rules:end -->", sha256: "4b4a998d89f75f298eee1d1b7028179218e660ae0918b267cd7ba1f706f9440a" },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
for (const { file, what, start, end, sha256 } of BLOCKS) {
  const text = readFileSync(resolve(root, file), "utf8");
  const a = start ? text.indexOf(start) : 0;
  const b = end ? text.indexOf(end) : text.length;
  if (a < 0 || b < a) {
    console.error(`${file} has no ${what} between ${start} and ${end}.`);
    failed = true;
    continue;
  }
  const got = createHash("sha256").update(text.slice(a, b + (end?.length ?? 0)), "utf8").digest("hex");
  if (got !== sha256) {
    console.error(
      `${file}'s ${what} differs from the Trifecta master (sha256 ${got}, expected ${sha256}). ` +
        `Change it in wiki_mcp/${file} and run \`npm run glossary:sync\` there; never edit it in a copy.`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
