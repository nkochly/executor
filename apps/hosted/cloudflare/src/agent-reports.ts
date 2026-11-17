/**
 * Feedback on this host goes to the Worker bound as `AGENT_REPORTS`, when one is: an entrypoint
 * whose `submit` takes the feedback with the email of the person who sent it, as this product's
 * sign-in verified it, and the MCP client it came from. The binding is the only credential; the
 * receiver answers whether it took the feedback, declined it with a reason the agent can read, or
 * takes none at all. Without the binding, feedback stays disabled, as on any instance without an
 * analytics destination.
 */
import {
  FeedbackRefused,
  FeedbackUnavailable,
  feedbackDisabled,
} from "@executor-js/telemetry/product-analytics";
import { CurrentUsage, type ProductAnalytics } from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

/** What the receiver answers for one submission. */
export const AgentReportResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals(["disabled", "refused"]),
    reason: Schema.String,
  }),
]);

/** The receiver's entrypoint, as a service binding exposes it. */
export interface AgentReportsBinding {
  submit(report: {
    readonly person: string;
    readonly message: string;
    readonly client?: string;
  }): Promise<unknown>;
}

const Email = Schema.Struct({ email: Schema.String });

/** Submits feedback to the bound receiver as the signed-in person. */
export const agentReportsFeedback =
  (
    binding: AgentReportsBinding,
    sql: SqlClient.SqlClient,
  ): (typeof ProductAnalytics.Service)["submitFeedback"] =>
  (feedback) =>
    Effect.gen(function* () {
      // Any failure to reach the receiver or read its answer is "not confirmed", never a refusal.
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
