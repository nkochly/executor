/**
 * The product's settings come from this Worker's vars and secrets, filtered to the names the
 * self-host image passes to its product, so a binding object or an unrelated var never becomes
 * configuration. The one exception is the operator's OAuth client credentials
 * (`EXECUTOR_OAUTH_<ID>_CLIENT_ID` and `_CLIENT_SECRET`), which may be Secrets Store bindings, read
 * when the product opens, so credentials a person keeps in the store never pass through a deploy.
 * Secrets are required here because no disk exists to generate and keep them.
 */
import { Effect, Schema } from "effect";

const prefixes = ["EXECUTOR_", "OTEL_", "BETTER_AUTH_", "SSO_", "FIRST_PARTY_"];
const names = new Set(["NODE_ENV", "DO_NOT_TRACK", "CLOUDFLARE_ACCOUNT_ID"]);
/** Settings that may be Secrets Store bindings: the operator's OAuth client credentials. */
const storedCredential = /^EXECUTOR_OAUTH_[A-Z0-9_]+_CLIENT_(ID|SECRET)$/u;

/** A setting that is missing or malformed; names the setting, never its value. */
export class WorkerConfigurationInvalid extends Schema.TaggedError<WorkerConfigurationInvalid>()(
  "WorkerConfigurationInvalid",
  { message: Schema.String },
) {}

const invalid = (message: string) => Effect.fail(new WorkerConfigurationInvalid({ message }));

/** A Secrets Store binding: an object whose only read is `get()`. */
interface StoredSecret {
  readonly get: () => Promise<string>;
}

const isStoredSecret = (value: unknown): value is StoredSecret =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly get?: unknown }).get === "function";

/** The settings the product reads, from the Worker environment. */
export const workerConfiguration = (env: object) =>
  Effect.gen(function* () {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (!names.has(name) && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
      if (typeof value === "string") values[name] = value;
      else if (storedCredential.test(name) && isStoredSecret(value))
        values[name] = yield* Effect.tryPromise({
          try: () => value.get(),
          // Names the setting only; the store's error could describe the value.
          catch: () =>
            new WorkerConfigurationInvalid({
              message: `${name} is a Secrets Store binding whose secret could not be read`,
            }),
        });
    }
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
