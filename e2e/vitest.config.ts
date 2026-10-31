import { defineConfig } from "vitest/config";

// One project per target. Same scenario files, different running instance:
// `vitest run --project cloud` (the default) / `--project cloudflare`.
// Each project's globalsetup boots that app's OWN dev server (or attaches to
// E2E_<TARGET>_URL). Scenarios are isolated by fresh identities, not resets.
const project = (name: string, overrides: Record<string, unknown> = {}) => ({
  test: {
    name,
    include: ["scenarios/**/*.test.ts", `${name}/**/*.test.ts`],
    env: { E2E_TARGET: name },
    globalSetup: [`./setup/${name}.globalsetup.ts`],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    ...overrides,
  },
});

export default defineConfig({
  test: {
    projects: [
      // PGlite's socket server is effectively single-connection; parallel test
      // files (each fanning out per-request postgres sockets) crash it. Run
      // files serially — swap PGlite for real Postgres if wall-clock matters.
      project("cloud", { fileParallelism: false }),
      // The Cloudflare self-host worker (workerd via wrangler dev, dev-auth).
      // Scoped to the cross-target scenarios wired for this host; the rest of
      // scenarios/** is not yet validated against the worker. The full-graph
      // scenario is included on purpose: workerd's 128MB isolate is the exact
      // limit the streaming compile + content-addressed serve path defends, so
      // it is the one host where that regression must be proven. Shares
      // self-host's single-admin model.
      project("cloudflare", {
        include: [
          "scenarios/browser-approval.test.ts",
          "scenarios/mcp-approval-persistence.test.ts",
          "scenarios/microsoft-graph-full.test.ts",
          "scenarios/toolkits-mcp.test.ts",
          "cloudflare/**/*.test.ts",
        ],
        fileParallelism: false,
      }),
      // The single-user local app. Each scenario launches its OWN `executor
      // web` via the CLI on a throwaway data dir + an OS-assigned port, so
      // there is no shared instance and scenarios are independent. Files run
      // SERIALLY (like every other server-booting project): a cold `executor
      // web` boot runs vite's optimizeDeps, and several booting at once on a
      // CI runner thrash hard enough to blow the token-URL wait. Serial lets
      // the first boot warm the shared vite cache so the rest come up fast. No
      // globalSetup (nothing shared to boot). Only local/** scenarios. Not part
      // of the default `npm run test` chain; run with `vitest run --project local`.
      project("local", {
        include: ["local/**/*.test.ts"],
        globalSetup: [],
        fileParallelism: false,
        testTimeout: 300_000,
      }),
      // The supervised CLI daemon inside a guest VM, one project per OS. The
      // globalsetup provisions a VM, `executor service install`s the daemon, and
      // tunnels it; restart() reboots the guest for REAL, so restart-persistence
      // proves the boot-time auto-start path. Needs tart (macOS/Linux) or an EC2
      // credential (Windows); not part of the default `npm run test` chain — run
      // with `vitest run --project cli-macos` (etc.) on the Mini.
      ...(["macos", "linux", "windows"] as const).map((os) =>
        project(`cli-${os}`, {
          include: ["scenarios/restart-persistence.test.ts", "cli/**/*.test.ts"],
          env: { E2E_TARGET: `cli-${os}`, E2E_VM_OS: os },
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 900_000,
        }),
      ),
    ],
  },
});
