import { Cause, Clock, Effect, Exit, Fiber, Option, Result, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { ElicitationResponse } from "apps/contracts";
import type { McpBackend } from "../contracts/backend.ts";
import { McpExecutionResult, type PendingInteraction } from "../contracts/execute.ts";
import { executionResultContent } from "../contracts/media.ts";
import type { makeExecutions } from "./executions.ts";

export const tasksExtension = "io.modelcontextprotocol/tasks";

export const mcpTaskLimits = {
  answerWithinMs: 5_000,
  pollIntervalMs: 2_000,
  ttlMs: 60 * 60 * 1000,
  maxTasks: 256,
} as const;

type Executions = Effect.Success<ReturnType<typeof makeExecutions>>;
type Outcome = typeof McpExecutionResult.Type;

interface Entry {
  readonly caller: string;
  readonly backend: McpBackend<Error>;
  readonly createdAt: number;
  task: McpSchema.McpDetailedTask;
  waiting: PendingInteraction | undefined;
  fiber: Fiber.Fiber<Outcome, unknown> | undefined;
}

const isPending = (result: Outcome): result is PendingInteraction =>
  result.status === "approval-required" || result.status === "input-required";

const encodeResult = Schema.encodeEffect(Schema.toCodecJson(McpExecutionResult));

const toolResult = (result: Outcome) =>
  encodeResult(result).pipe(
    Effect.map((encoded) => ({ ...executionResultContent(encoded), isError: false })),
    Effect.orElseSucceed(() => toolError("The result could not be encoded")),
  );

const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

const failureText = (error: unknown) =>
  error instanceof Error && error.message !== ""
    ? error.message
    : typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "The call failed";

const notFound = (taskId: string, reason: "not found" | "has expired") =>
  new McpSchema.InvalidParams({
    message: `Failed to retrieve task: Task ${reason}`,
    data: { taskId },
  });

export const declaresTasks = (capabilities: McpSchema.ClientCapabilities) =>
  capabilities.extensions?.[tasksExtension] !== undefined;

export const makeMcpTasks = (executions: Executions) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const entries = new Map<string, Entry>();
    const iso = (millis: number) => new Date(millis).toISOString();

    const touch = (entry: Entry, change: Partial<McpSchema.McpDetailedTask>) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const { inputRequests: _input, result: _result, error: _error, ...base } = entry.task;
          entry.task = { ...base, ...change, lastUpdatedAt: iso(now) };
        }),
      );

    const settle = (entry: Entry, exit: Exit.Exit<Outcome, unknown>) =>
      Effect.gen(function* () {
        entry.fiber = undefined;
        if (entry.task.status === "cancelled") return;
        if (Exit.isSuccess(exit)) {
          const result = exit.value;
          if (isPending(result)) {
            entry.waiting = result;
            return yield* touch(entry, {
              status: "input_required",
              inputRequests: {
                [result.requestId]: { method: "elicitation/create", params: result.elicitation },
              },
            });
          }
          entry.waiting = undefined;
          return yield* touch(entry, { status: "completed", result: yield* toolResult(result) });
        }
        entry.waiting = undefined;
        if (Cause.hasInterruptsOnly(exit.cause))
          return yield* touch(entry, { status: "cancelled" });
        const failure = Cause.findFail(exit.cause);
        return Result.isSuccess(failure) && !Cause.hasDies(exit.cause)
          ? yield* touch(entry, {
              status: "completed",
              result: toolError(failureText(failure.success.error)),
            })
          : yield* touch(entry, {
              status: "failed",
              statusMessage: "Internal error",
              error: { code: -32603, message: "Internal error" },
            });
      });

    const follow = (entry: Entry, work: Effect.Effect<Outcome, unknown>) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(work, scope);
        entry.fiber = fiber;
        yield* Effect.forkIn(
          Fiber.await(fiber).pipe(Effect.flatMap((exit) => settle(entry, exit))),
          scope,
        );
      });

    const prune = (now: number) => {
      for (const [taskId, entry] of entries)
        if (entry.createdAt + mcpTaskLimits.ttlMs <= now && entry.fiber === undefined)
          entries.delete(taskId);
      if (entries.size < mcpTaskLimits.maxTasks) return;
      for (const [taskId, entry] of entries) {
        if (entries.size < mcpTaskLimits.maxTasks) return;
        if (entry.fiber === undefined && entry.waiting === undefined) entries.delete(taskId);
      }
    };

    const owned = (caller: string, taskId: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const entry = entries.get(taskId);
        if (entry === undefined || entry.caller !== caller)
          return yield* Effect.fail(notFound(taskId, "not found"));
        if (entry.createdAt + mcpTaskLimits.ttlMs <= now) {
          if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
          if (entry.waiting !== undefined)
            yield* executions.discard(caller, entry.waiting.requestId);
          entries.delete(taskId);
          return yield* Effect.fail(notFound(taskId, "has expired"));
        }
        return entry;
      });

    return {
      start: <E>(
        caller: string,
        backend: McpBackend<Error>,
        work: Effect.Effect<Outcome, E>,
      ): Effect.Effect<Outcome, E | McpSchema.TaskCreated> =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(work, scope);
          const early = yield* Fiber.await(fiber).pipe(
            Effect.timeoutOption(mcpTaskLimits.answerWithinMs),
            Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          );
          if (Option.isSome(early)) return yield* early.value;
          const now = yield* Clock.currentTimeMillis;
          prune(now);
          const taskId = crypto.randomUUID();
          const entry: Entry = {
            caller,
            backend,
            createdAt: now,
            task: {
              taskId,
              status: "working",
              createdAt: iso(now),
              lastUpdatedAt: iso(now),
              ttlMs: mcpTaskLimits.ttlMs,
              pollIntervalMs: mcpTaskLimits.pollIntervalMs,
            },
            waiting: undefined,
            fiber,
          };
          entries.set(taskId, entry);
          yield* Effect.forkIn(
            Fiber.await(fiber).pipe(Effect.flatMap((exit) => settle(entry, exit))),
            scope,
          );
          const { inputRequests: _input, result: _result, error: _error, ...task } = entry.task;
          return yield* Effect.fail(new McpSchema.TaskCreated({ task }));
        }),
      get: (caller: string, taskId: string) =>
        owned(caller, taskId).pipe(Effect.map((entry) => entry.task)),
      update: (
        caller: string,
        taskId: string,
        inputResponses: Readonly<Record<string, McpSchema.McpInputResponse>>,
      ) =>
        Effect.gen(function* () {
          const entry = yield* owned(caller, taskId);
          const waiting = entry.waiting;
          if (waiting === undefined || entry.task.status !== "input_required") return;
          const answer = inputResponses[waiting.requestId];
          if (answer === undefined) return;
          const response = yield* Schema.decodeUnknownEffect(ElicitationResponse)(answer).pipe(
            Effect.mapError(
              () => new McpSchema.InvalidParams({ message: "The input response is not valid" }),
            ),
          );
          entry.waiting = undefined;
          yield* touch(entry, { status: "working" });
          yield* follow(
            entry,
            executions.resume(caller, entry.backend, { requestId: waiting.requestId, response }),
          );
        }),
      cancel: (caller: string, taskId: string) =>
        Effect.gen(function* () {
          const entry = yield* owned(caller, taskId);
          const status = entry.task.status;
          if (status === "completed" || status === "failed" || status === "cancelled") return;
          yield* touch(entry, { status: "cancelled" });
          const fiber = entry.fiber;
          if (fiber !== undefined) yield* Effect.forkIn(Fiber.interrupt(fiber), scope);
          if (entry.waiting !== undefined) {
            yield* executions.discard(caller, entry.waiting.requestId);
            entry.waiting = undefined;
          }
        }),
    };
  });

export type McpTasks = Effect.Success<ReturnType<typeof makeMcpTasks>>;
