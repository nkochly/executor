import { Context, Effect, Option } from "effect";
import { McpSchema } from "effect/ai";
import { HttpServerRequest } from "effect/http";
import type { ToolAttribution } from "@executor-js/sdk/core";

export const callerLabelKey = "dev.presidio-west/attribution";
const fieldChars = 200;

export const CallerLabel = Context.Reference<ToolAttribution | undefined>(
  "executor/mcp/CallerLabel",
  { defaultValue: () => undefined },
);

const text = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, fieldChars).trim();
  return trimmed === "" ? undefined : trimmed;
};

const givenAgent = (meta: Readonly<Record<string, unknown>> | undefined) => {
  const label = meta?.[callerLabelKey];
  return typeof label === "object" && label !== null && !Array.isArray(label)
    ? text((label as Record<string, unknown>).agent)
    : undefined;
};

const sessionTag = (session: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(session))).pipe(
    Effect.map(
      (digest) =>
        `session ${Array.from(new Uint8Array(digest).slice(0, 4), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")}`,
    ),
  );

export const callerLabel: Effect.Effect<ToolAttribution | undefined> = Effect.gen(function* () {
  const client = Option.getOrUndefined(yield* Effect.serviceOption(McpSchema.McpServerClient));
  const request = Option.getOrUndefined(
    yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest),
  );
  const session = text(request?.headers["mcp-session-id"]);
  const given = givenAgent(client?.requestMetadata);
  const agent = given ?? (session === undefined ? undefined : yield* sessionTag(session));
  const name =
    client === undefined
      ? undefined
      : text(`${client.clientInfo.name} ${client.clientInfo.version}`);
  if (name === undefined && agent === undefined) return undefined;
  return {
    ...(name === undefined ? {} : { client: name }),
    ...(agent === undefined ? {} : { agent }),
  };
});
