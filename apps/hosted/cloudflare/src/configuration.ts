/**
 * The product's settings come from this Worker's vars and secrets, filtered to the names the
 * self-host image passes to its product, so a binding object or an unrelated var never becomes
 * configuration. Secrets are required here because no disk exists to generate and keep them.
 */
import { Effect, Schema } from "effect";

const prefixes = ["EXECUTOR_", "OTEL_", "BETTER_AUTH_", "SSO_", "FIRST_PARTY_"];
const names = new Set(["NODE_ENV", "DO_NOT_TRACK", "CLOUDFLARE_ACCOUNT_ID"]);

/** A setting that is missing or malformed; names the setting, never its value. */
export class WorkerConfigurationInvalid extends Schema.TaggedError<WorkerConfigurationInvalid>()(
  "WorkerConfigurationInvalid",
  { message: Schema.String },
) {}

const invalid = (message: string) => Effect.fail(new WorkerConfigurationInvalid({ message }));

/** The settings the product reads, from the Worker environment. */
export const workerConfiguration = (env: object) =>
  Effect.gen(function* () {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(env))
      if (
        typeof value === "string" &&
        (names.has(name) || prefixes.some((prefix) => name.startsWith(prefix)))
      )
        values[name] = value;
    const engine = values["EXECUTOR_DATABASE"] ?? "sqlite";
    if (engine !== "sqlite")
      return yield* invalid("EXECUTOR_DATABASE must be sqlite on Cloudflare");
    values["EXECUTOR_DATABASE"] = "sqlite";
    const origin = URL.parse(values["BETTER_AUTH_URL"] ?? "");
    if (
      origin === null ||
      (origin.protocol !== "https:" && origin.protocol !== "http:") ||
      origin.origin !== values["BETTER_AUTH_URL"]
    )
      return yield* invalid("BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash");
    if ((values["BETTER_AUTH_SECRET"] ?? "").length < 32)
      return yield* invalid("BETTER_AUTH_SECRET must be a secret of at least 32 characters");
    if (!/^[0-9a-fA-F]{64}$/.test(values["EXECUTOR_ENCRYPTION_KEY"] ?? ""))
      return yield* invalid(
        "EXECUTOR_ENCRYPTION_KEY must be a secret of 64 hexadecimal characters",
      );
    return values;
  });
