import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKS = [
  { file: "GLOSSARY.md", what: "shared core", start: "<!-- glossary-core:start -->", end: "<!-- glossary-core:end -->", sha256: "c5e8fd9bd3e7a736f47ae02b1954f92a4dc20fb0981a9876c9779c12f8fa2474" },
  { file: "CLAUDE.md", what: "shared rules", start: "<!-- shared-rules:start -->", end: "<!-- shared-rules:end -->", sha256: "0af76b183907c40417ee3e07193d0e2a1d701ed1162cbdf699aa0a44f9df0a54" },
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
