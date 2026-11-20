import { RpcTarget } from "cloudflare:workers";
import type { WorkerLoader } from "@cloudflare/workers-types";
import type { ProgramHost, StartIsolatedProgram } from "@executor-js/hosted-server";

const maxProgramCpuMs = 300_000;

class ProgramHostTarget extends RpcTarget implements ProgramHost {
  readonly #host: ProgramHost;
  constructor(host: ProgramHost) {
    super();
    this.#host = host;
  }
  backend(call: Parameters<ProgramHost["backend"]>[0]) {
    return this.#host.backend(call);
  }
  progress(report: Parameters<ProgramHost["progress"]>[0]) {
    this.#host.progress(report);
  }
  deadline() {
    return this.#host.deadline();
  }
}

interface ProgramEntrypoint {
  run(code: string, limits: unknown, host: ProgramHostTarget): Promise<unknown>;
}

export const startInIsolate =
  (loader: WorkerLoader, sandbox: string): StartIsolatedProgram =>
  (code, limits, host) => {
    const worker = loader.load({
      compatibilityDate: "2026-09-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "program.js",
      modules: { "program.js": sandbox },
      globalOutbound: null,
      limits: { cpuMs: Math.min(limits.timeoutMs, maxProgramCpuMs) },
    });
    const program = worker.getEntrypoint("Program") as unknown as ProgramEntrypoint;
    return program.run(code, limits, new ProgramHostTarget(host));
  };
