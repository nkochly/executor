import {
  FeedbackRefused,
  FeedbackUnavailable,
  feedbackDisabled,
} from "@executor-js/telemetry/product-analytics";
import { CurrentUsage, type ProductAnalytics } from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

export const AgentReportResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals(["disabled", "refused"]),
    reason: Schema.String,
  }),
]);

export interface AgentReportsBinding {
  submit(report: {
    readonly person: string;
    readonly message: string;
    readonly client?: string;
  }): Promise<unknown>;
}

const Email = Schema.Struct({ email: Schema.String });

export const agentReportsFeedback =
  (
    binding: AgentReportsBinding,
    sql: SqlClient.SqlClient,
  ): (typeof ProductAnalytics.Service)["submitFeedback"] =>
  (feedback) =>
    Effect.gen(function* () {
      const answer = yield* Effect.gen(function* () {
        const rows = yield* sql`select email from "user" where id = ${feedback.userId}`;
        const person = yield* Schema.decodeUnknownEffect(Email)(rows[0]);
        const usage = yield* CurrentUsage;
        const reply = yield* Effect.tryPromise(() =>
          binding.submit({
            person: person.email,
            message: feedback.message,
            ...(usage.client_name === undefined ? {} : { client: usage.client_name }),
          }),
        ).pipe(Effect.timeout("15 seconds"));
        return yield* Schema.decodeUnknownEffect(AgentReportResult)(reply);
      }).pipe(Effect.mapError(() => new FeedbackUnavailable()));
      if (answer.ok) return;
      if (answer.code === "disabled") return yield* Effect.fail(feedbackDisabled());
      return yield* Effect.fail(new FeedbackRefused({ message: answer.reason }));
    });
