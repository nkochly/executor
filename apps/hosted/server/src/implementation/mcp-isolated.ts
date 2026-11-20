import { Cause, Effect, Exit } from "effect";
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

export interface ProgramBackendCall extends McpBackendCall {
  readonly index?: number;
}

export interface ProgramProgress {
  readonly calls: ExecutionProgress["calls"];
  readonly phase: ExecutionProgress["phase"];
  readonly unavailableApps: unknown;
  readonly failures: ReadonlyArray<unknown>;
}

export interface ProgramHost {
  backend(call: ProgramBackendCall): Promise<WireExit>;
  progress(report: ProgramProgress): void;
  deadline(): Promise<void>;
}

export type StartIsolatedProgram = (
  code: string,
  limits: McpLimits,
  host: ProgramHost,
) => Promise<unknown>;

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

export const isolatedProgram =
  (start: StartIsolatedProgram) =>
  (code: string): Program =>
  (backend, limits, deadline, progress) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const ended = new AbortController();
      const run = <A>(effect: Effect.Effect<A>) =>
        Effect.runPromiseWith(context)(effect, { signal: ended.signal });
      const settle = (effect: Effect.Effect<void>) =>
        Effect.runPromiseExitWith(context)(effect, { signal: ended.signal }).then((exit) =>
          Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? Promise.reject(Cause.squash(exit.cause))
            : undefined,
        );
      const host: ProgramHost = {
        backend: (call) =>
          run(
            Effect.gen(function* () {
              const fiber = yield* Effect.fiberId;
              if (call.index !== undefined) progress.callFibers.set(fiber, call.index);
              return yield* serveMcpBackendCall(backend, call).pipe(
                Effect.ensuring(Effect.sync(() => progress.callFibers.delete(fiber))),
              );
            }),
          ),
        progress: (report) => mirror(progress, report),
        deadline: () => settle(deadline),
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
  const backend: McpBackend<Error> = {
    ...shared,
    callTool: (input, options) =>
      Effect.flatMap(Effect.fiberId, (fiber) =>
        remote(progress.callFibers.get(fiber)).callTool(input, options),
      ),
  };
  const deadline = Effect.promise(() => host.deadline());
  return Effect.runPromise(
    executeProgram(code)(backend, limits, deadline, progress).pipe(
      Effect.map((result) => {
        progress.changed?.();
        return toWire(result);
      }),
    ),
  );
};
