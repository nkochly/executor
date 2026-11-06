/**
 * An `execute` program run in an isolate of its own. The object that admitted the program keeps
 * its execution: the brokered backend, approvals, the deadline and the progress its driver
 * reports from. The isolate runs only the interpreter, and reaches the object through a
 * `ProgramHost` it is handed: each backend operation, each change to its progress, and the
 * deadline cross as RPC calls. A program's CPU and memory are then the isolate's alone, so one
 * program cannot slow or crash another caller's.
 */
import { Effect } from "effect";
import {
  executeProgram,
  executionProgress,
  programFailure,
  type ExecuteResult,
  type ExecutionProgress,
  type McpBackend,
  type McpLimits,
  type Program,
} from "@executor-js/mcp";
import {
  fromWire,
  remoteMcpBackend,
  serveMcpBackendCall,
  toWire,
  type McpBackendCall,
  type WireExit,
} from "./mcp-remote.ts";

/** A backend operation from the isolate, with the program's call it serves, if it serves one. */
export interface ProgramBackendCall extends McpBackendCall {
  readonly index?: number;
}

/** What the isolate reports of its progress: everything the driver reads, as it crosses. */
export interface ProgramProgress {
  readonly calls: ExecutionProgress["calls"];
  readonly phase: ExecutionProgress["phase"];
  readonly unavailableApps: unknown;
  /** Failures recorded since the last report. */
  readonly failures: ReadonlyArray<unknown>;
}

/** What the object that admitted a program offers the isolate that runs it. */
export interface ProgramHost {
  /** Run one backend operation with the execution's brokered backend. */
  backend(call: ProgramBackendCall): Promise<WireExit>;
  /** Mirror the isolate's progress where the execution's driver reads it. */
  progress(report: ProgramProgress): void;
  /** Settles when the execution's budget is spent, or when the execution ends early. */
  deadline(): Promise<void>;
}

/** Start one program in an isolate; answers with its result as it crosses (`toWire`). */
export type StartIsolatedProgram = (
  code: string,
  limits: McpLimits,
  host: ProgramHost,
) => Promise<unknown>;

/** Apply a report to the driver's progress. A wait the driver marked stays marked. */
const mirror = (progress: ExecutionProgress, report: ProgramProgress) => {
  report.calls.forEach((call, index) => {
    const local = progress.calls[index];
    progress.calls[index] =
      local?.outcome === "awaiting-approval" && call.outcome === "running"
        ? { ...call, outcome: local.outcome }
        : { ...call };
  });
  progress.phase = report.phase;
  progress.unavailableApps = fromWire(
    report.unavailableApps,
  ) as ExecutionProgress["unavailableApps"];
  for (const failure of report.failures) progress.failures.push(fromWire(failure) as Error);
};

/**
 * The `program` option of an MCP host whose programs run in isolates. `start` loads a fresh
 * isolate for each program; when it cannot give a result, the execution fails with the calls the
 * program made, and nothing it started keeps running.
 */
export const isolatedProgram =
  (start: StartIsolatedProgram) =>
  (code: string): Program =>
  (backend, limits, deadline, progress) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const ended = new AbortController();
      const run = <A>(effect: Effect.Effect<A>) =>
        Effect.runPromiseWith(context)(effect, { signal: ended.signal });
      const host: ProgramHost = {
        backend: (call) =>
          run(
            Effect.gen(function* () {
              // The broker finds the call a backend operation serves by the fiber that runs it.
              const fiber = yield* Effect.fiberId;
              if (call.index !== undefined) progress.callFibers.set(fiber, call.index);
              return yield* serveMcpBackendCall(backend, call).pipe(
                Effect.ensuring(Effect.sync(() => progress.callFibers.delete(fiber))),
              );
            }),
          ),
        progress: (report) => mirror(progress, report),
        // Once the execution ends the isolate no longer waits; settle quietly rather than reject.
        deadline: () => run(deadline).catch(() => undefined),
      };
      return yield* Effect.tryPromise(() => start(code, limits, host)).pipe(
        Effect.map((result) => fromWire(result) as typeof ExecuteResult.Type),
        Effect.catch(() =>
          Effect.succeed(
            programFailure(
              progress,
              "ExecutionFailure",
              "The program stopped before it finished: it used more CPU or memory than one program may, or its isolate failed. Calls listed here ran; nothing else did.",
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => ended.abort())),
      );
    });

/**
 * Run a program inside its isolate. The interpreter is the one an in-process program uses; its
 * backend, deadline and progress are the host's, reached through `host`.
 */
export const runIsolatedProgram = (
  code: string,
  limits: McpLimits,
  host: ProgramHost,
): Promise<unknown> => {
  const progress = executionProgress(undefined);
  let reported = 0;
  progress.changed = () => {
    const failures = progress.failures.slice(reported).map(toWire);
    reported = progress.failures.length;
    // Reports are told, not awaited: a lost one is corrected by the next.
    Promise.resolve(
      host.progress({
        calls: progress.calls.map((call) => ({ ...call })),
        phase: progress.phase,
        unavailableApps: toWire(progress.unavailableApps),
        failures,
      }),
    ).catch(() => undefined);
  };
  const remote = (index: number | undefined) =>
    remoteMcpBackend((call) => host.backend(index === undefined ? call : { ...call, index }));
  const shared = remote(undefined);
  // A tool call names the program's call it serves, so the host can mark its approval wait.
  const backend: McpBackend<Error> = {
    ...shared,
    callTool: (input, options) =>
      Effect.flatMap(Effect.fiberId, (fiber) =>
        remote(progress.callFibers.get(fiber)).callTool(input, options),
      ),
  };
  // The deadline settles when the budget is spent or the host ends the execution; either way the
  // program stops and returns what it did.
  const deadline = Effect.promise(() => host.deadline().catch(() => undefined));
  return Effect.runPromise(
    executeProgram(code)(backend, limits, deadline, progress).pipe(
      Effect.map((result) => {
        progress.changed?.();
        return toWire(result);
      }),
    ),
  );
};
