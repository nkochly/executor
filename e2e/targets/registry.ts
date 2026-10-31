// Target resolution: the vitest project sets E2E_TARGET; scenarios resolve it
// once per worker. Adding a target = one factory entry here + a project in
// vitest.config.ts + a globalsetup that boots (or attaches to) the instance.
import type { Target } from "../src/target";
import { cliTarget } from "./cli";
import { cloudTarget } from "./cloud";
import { cloudflareTarget } from "./cloudflare";
import { localTarget } from "./local";

const factories: Record<string, () => Target> = {
  cloud: cloudTarget,
  cloudflare: cloudflareTarget,
  local: localTarget,
  // The supervised CLI daemon inside a VM, one project per guest OS — restart()
  // is a real reboot. See setup/cli.globalsetup.ts.
  "cli-macos": cliTarget,
  "cli-linux": cliTarget,
  "cli-windows": cliTarget,
};

let current: Target | undefined;

export const resolveTarget = (): Target => {
  if (current) return current;
  const name = process.env.E2E_TARGET;
  const factory = name ? factories[name] : undefined;
  if (!factory) {
    throw new Error(
      `E2E_TARGET=${JSON.stringify(name)} — expected one of: ${Object.keys(factories).join(", ")}. ` +
        `Run via the vitest projects (e.g. \`vitest run --project cloud\`).`,
    );
  }
  current = factory();
  return current;
};
