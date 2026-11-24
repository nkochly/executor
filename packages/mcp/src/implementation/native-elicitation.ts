/** Native approval delivery holds only the active MCP request; codemode remains parked while the user decides. */
import { Clock, Effect, Option, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { ElicitationResponse } from "apps/contracts";
import { NativeElicitationFailed } from "../contracts/elicitation.ts";
import type { McpBackend } from "../contracts/backend.ts";
import type { ApprovalMode, makeExecutions } from "./executions.ts";
import type { Program } from "./execute.ts";
import {
  ElicitationResponseInvalid,
  InteractionId,
  type McpExecutionResult,
  type PendingInteraction,
} from "../contracts/execute.ts";

/** Drive the shared continuation manager using the requesting client's elicitation responses. */
export const executeNative = (
  executions: Effect.Success<ReturnType<typeof makeExecutions>>,
  caller: string,
  backend: McpBackend<Error>,
  work: Program,
  approval: ApprovalMode = "ask",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      if (Option.isNone(client))
        return yield* executeNativeByInput(executions, caller, backend, work, approval);
      const { clientCapabilities } = yield* McpSchema.McpRequestContext;
      const capability = clientCapabilities.elicitation;
      // Older elicitation capabilities used an empty object to advertise form support.
      if (
        capability === undefined ||
        (capability.form === undefined && capability.url !== undefined)
      ) {
        return yield* new NativeElicitationFailed({ reason: "unsupported" });
      }
      const reverse = yield* client.value.getClient;
      let result = yield* executions.execute(caller, backend, work, "prompt", approval);
      while (result.status === "approval-required" || result.status === "input-required") {
        const request = result;
        result = yield* Effect.gen(function* () {
          const remaining = request.expiresAt - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return yield* new NativeElicitationFailed({ reason: "expired" });
          const prompt = yield* Schema.decodeUnknownEffect(McpSchema.ElicitRequestFormParams)(
            request.elicitation,
          ).pipe(Effect.mapError(() => new NativeElicitationFailed({ reason: "transport" })));
          const response = yield* reverse.elicit(prompt).pipe(
            Effect.catchTags({
              McpReverseOperationUnsupported: () =>
                Effect.fail(new NativeElicitationFailed({ reason: "unsupported" })),
              McpReverseOperationError: () =>
                Effect.fail(new NativeElicitationFailed({ reason: "transport" })),
            }),
            // The client's `_meta` may hold any value; a resume keeps only JSON.
            Effect.flatMap((answer) =>
              Schema.decodeUnknownEffect(ElicitationResponse)(answer).pipe(
                Effect.mapError(() => new NativeElicitationFailed({ reason: "transport" })),
              ),
            ),
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () => Effect.fail(new NativeElicitationFailed({ reason: "expired" })),
            }),
          );
          return yield* executions.resume(caller, backend, {
            requestId: request.requestId,
            response,
          });
        }).pipe(Effect.ensuring(executions.discard(caller, request.requestId)));
      }
      return result;
    }),
  );

const isPending = (result: McpExecutionResult): result is PendingInteraction =>
  result.status === "approval-required" || result.status === "input-required";

const inputRequired = (pending: PendingInteraction) =>
  new McpSchema.InputRequired({
    inputRequests: {
      [pending.requestId]: { method: "elicitation/create", params: pending.elicitation },
    },
    requestState: pending.requestId,
  });

const answer = (
  executions: Effect.Success<ReturnType<typeof makeExecutions>>,
  caller: string,
  backend: McpBackend<Error>,
  requestId: InteractionId,
  response: unknown,
) =>
  response === undefined
    ? executions
        .pendingInteraction(caller, requestId)
        .pipe(
          Effect.flatMap((pending) =>
            pending === undefined
              ? executions.unavailable(caller, requestId)
              : Effect.succeed<McpExecutionResult>(pending),
          ),
        )
    : Schema.decodeUnknownEffect(ElicitationResponse)(response).pipe(
        Effect.mapError(() => new ElicitationResponseInvalid()),
        Effect.flatMap((decoded) =>
          executions.resume(caller, backend, { requestId, response: decoded }),
        ),
      );

export const executeNativeByInput = (
  executions: Effect.Success<ReturnType<typeof makeExecutions>>,
  caller: string,
  backend: McpBackend<Error>,
  work: Program,
  approval: ApprovalMode = "ask",
) =>
  Effect.gen(function* () {
    const { clientCapabilities, inputResponses, requestState } = yield* McpSchema.McpRequestContext;
    const capability = clientCapabilities.elicitation;
    if (capability === undefined || (capability.form === undefined && capability.url !== undefined))
      return yield* new NativeElicitationFailed({ reason: "unsupported" });
    const result =
      requestState === undefined
        ? yield* executions.execute(caller, backend, work, "prompt", approval)
        : yield* Schema.decodeUnknownEffect(InteractionId)(requestState).pipe(
            Effect.mapError(() => new ElicitationResponseInvalid()),
            Effect.flatMap((requestId) =>
              answer(executions, caller, backend, requestId, inputResponses?.[requestId]),
            ),
          );
    return isPending(result) ? yield* Effect.fail(inputRequired(result)) : result;
  });
