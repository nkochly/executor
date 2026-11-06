/**
 * An MCP backend served across a Durable Object RPC boundary. The session object that runs a
 * caller's MCP protocol and programs holds no database; each backend operation is one call to the
 * product, which authenticates the request's headers again and runs the operation with the same
 * authorized backend an in-process request uses. No transaction spans two calls.
 *
 * Values cross as structured clones. Product errors and other Schema classes do not survive a
 * clone, so they cross as their encoded form under their identifier and are rebuilt on the other
 * side; a class this side does not know arrives as `RemoteFailure`, which presents nothing.
 * Functions in an operation's options (an elicitation handler) cross as RPC stubs.
 */
import { Cause, Effect, Exit, Option, Schema } from "effect";
import * as SdkCore from "@executor-js/sdk/core";
import * as Mcp from "@executor-js/mcp";
import * as McpAuth from "@executor-js/mcp-auth";
import * as AppContracts from "apps/contracts";
import {
  ElicitationFailed,
  ElicitationReply,
  type ElicitationHandler,
  type FormElicitation,
} from "apps/contracts";
import type { McpBackend } from "@executor-js/mcp";
import * as McpContracts from "../contracts/mcp.ts";
import * as OrganizationContracts from "../contracts/organization.ts";

/** An error whose class this side does not know. It keeps the tag and nothing it could present. */
export class RemoteFailure extends Schema.TaggedError<RemoteFailure>()("RemoteFailure", {
  tag: Schema.String,
}) {}

type SchemaClass = Schema.Top &
  (abstract new (...args: never) => unknown) & {
    readonly identifier?: string;
  };

const isSchemaClass = (value: unknown): value is SchemaClass =>
  typeof value === "function" && Schema.isSchema(value) && typeof value.prototype === "object";

/** Every Schema class the product's operations can return or fail with, by identifier. */
const registry: ReadonlyMap<string, SchemaClass> = new Map(
  [SdkCore, Mcp, McpAuth, AppContracts, McpContracts, OrganizationContracts]
    .flatMap((module) => Object.values(module))
    .filter(isSchemaClass)
    .flatMap((value) =>
      typeof value.identifier === "string" ? [[value.identifier, value] as const] : [],
    ),
);

const plain = (value: object) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A value as it crosses: Schema class instances and Options become tagged plain data. */
export const toWire = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toWire);
  if (Option.isOption(value)) return { $option: Option.isSome(value) ? [toWire(value.value)] : [] };
  if (plain(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toWire(entry);
    return out;
  }
  const schema = (value as { constructor?: unknown }).constructor;
  if (isSchemaClass(schema) && typeof schema.identifier === "string") {
    const encoded = Schema.encodeUnknownOption(schema as never)(value);
    if (Option.isSome(encoded)) return { $class: schema.identifier, value: encoded.value };
  }
  if (value instanceof Error)
    return {
      $error: (value as { _tag?: unknown })._tag ?? value.name,
      message: value.message,
    };
  // Dates, maps, sets and bytes are structured-cloneable as they are.
  return value;
};

/** The value `toWire` sent, with its classes rebuilt. */
export const fromWire = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(fromWire);
  if (!plain(value)) return value;
  const record = value as Record<string, unknown>;
  if ("$option" in record && Array.isArray(record.$option))
    return record.$option.length === 0 ? Option.none() : Option.some(fromWire(record.$option[0]));
  if (typeof record.$class === "string") {
    const schema = registry.get(record.$class);
    const decoded =
      schema === undefined
        ? Option.none()
        : Schema.decodeUnknownOption(schema as never)(record.value);
    return Option.getOrElse(decoded, () => new RemoteFailure({ tag: String(record.$class) }));
  }
  if (typeof record.$error === "string") return new RemoteFailure({ tag: record.$error });
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = fromWire(entry);
  return out;
};

/** An operation's outcome as it crosses: its value, its expected error, or that it died. */
export type WireExit =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }
  | { readonly ok: false; readonly defect: string };

export type McpBackendMethod = keyof McpBackend<Error>;

/** One operation's request: its method and its arguments, options last. */
export interface McpBackendCall {
  readonly method: McpBackendMethod;
  readonly args: ReadonlyArray<unknown>;
}

/** An elicitation handler as it crosses: a plain async function answering with a reply. */
type RemoteElicitation = (request: FormElicitation) => Promise<unknown>;

/** The argument that carries an operation's options, for the operations whose options hold a handler. */
const optionsIndex: Partial<Record<McpBackendMethod, number>> = {
  callTool: 1,
  resumeInvocation: 2,
};
const isOptions = (method: McpBackendMethod, index: number) => optionsIndex[method] === index;

/** Replace an options object's Effect handler with a function the other side can call. */
const sendOptions = (options: unknown): unknown => {
  if (options === null || typeof options !== "object") return toWire(options);
  const { elicitation, ...rest } = options as { elicitation?: ElicitationHandler };
  const wire = toWire(rest) as Record<string, unknown>;
  if (elicitation === undefined) return wire;
  const remote: RemoteElicitation = (request) =>
    Effect.runPromise(
      elicitation(request, new AbortController().signal).pipe(
        Effect.map((response) => ({ ok: true as const, response })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        Effect.flatMap(Schema.encodeUnknownEffect(ElicitationReply)),
        Effect.orDie,
      ),
    );
  return { ...wire, elicitation: remote };
};

/** The options the product passes to its backend: a remote handler becomes an Effect again. */
const receiveOptions = (options: unknown): unknown => {
  if (options === null || typeof options !== "object") return fromWire(options);
  const { elicitation, ...rest } = options as { elicitation?: RemoteElicitation };
  const decoded = fromWire(rest) as Record<string, unknown>;
  if (typeof elicitation !== "function") return decoded;
  const handler: ElicitationHandler = (request) =>
    Effect.tryPromise({
      try: () => elicitation(request),
      catch: () => new ElicitationFailed({ reason: "transport" }),
    }).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(ElicitationReply)(reply).pipe(
          Effect.mapError(() => new ElicitationFailed({ reason: "invalid-response" })),
        ),
      ),
      Effect.flatMap((reply) =>
        reply.ok ? Effect.succeed(reply.response) : Effect.fail(reply.error),
      ),
    );
  return { ...decoded, elicitation: handler };
};

/** Run one operation the session object sent with the product's own backend for its request. */
export const serveMcpBackendCall = <E extends Error>(
  backend: McpBackend<E>,
  call: McpBackendCall,
): Effect.Effect<WireExit> =>
  Effect.suspend(() => {
    const operation = backend[call.method] as (
      ...args: ReadonlyArray<unknown>
    ) => Effect.Effect<unknown, unknown>;
    const args = call.args.map((arg, index) =>
      isOptions(call.method, index) ? receiveOptions(arg) : fromWire(arg),
    );
    return operation(...args);
  }).pipe(
    Effect.exit,
    Effect.map((exit): WireExit => {
      if (Exit.isSuccess(exit)) return { ok: true, value: toWire(exit.value) };
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error)) return { ok: false, error: toWire(error.value) };
      return { ok: false, defect: Cause.pretty(exit.cause) };
    }),
  );

/** A product operation could not be reached or died there; the agent sees an unavailable backend. */
export class RemoteBackendUnavailable extends Schema.TaggedError<RemoteBackendUnavailable>()(
  "RemoteBackendUnavailable",
  {},
) {}

/**
 * The backend a session object runs its requests with. `send` delivers one operation to the
 * product for the request being served and answers with its outcome.
 */
export const remoteMcpBackend = (
  send: (call: McpBackendCall) => Promise<WireExit>,
): McpBackend<Error> => {
  const run =
    (method: McpBackendMethod) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () =>
          send({
            method,
            args: args.map((arg, index) =>
              isOptions(method, index) ? sendOptions(arg) : toWire(arg),
            ),
          }),
        catch: () => new RemoteBackendUnavailable(),
      }).pipe(
        Effect.flatMap((exit) =>
          exit.ok
            ? Effect.succeed(fromWire(exit.value))
            : "error" in exit
              ? Effect.fail(fromWire(exit.error) as Error)
              : Effect.die(new RemoteBackendUnavailable()),
        ),
      );
  return {
    listSkills: run("listSkills"),
    readSkill: run("readSkill"),
    authorizeElicitation: run("authorizeElicitation"),
    listApps: run("listApps"),
    listAccounts: run("listAccounts"),
    listTools: run("listTools"),
    searchableTools: run("searchableTools"),
    searchTools: run("searchTools"),
    callTool: run("callTool"),
    eventDefinitions: run("eventDefinitions"),
    findEventSubscription: run("findEventSubscription"),
    subscribeEvent: run("subscribeEvent"),
    unsubscribeEvent: run("unsubscribeEvent"),
    resumeInvocation: run("resumeInvocation"),
  } as McpBackend<Error>;
};
