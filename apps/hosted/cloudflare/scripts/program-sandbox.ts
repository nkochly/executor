import { build } from "esbuild";
import { join } from "node:path";

export const bundleProgramSandbox = async (root: string): Promise<string | undefined> => {
  const sandbox = await build({
    entryPoints: [join(root, "src/program-sandbox.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    minify: true,
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  return sandbox.outputFiles[0]?.text;
};
