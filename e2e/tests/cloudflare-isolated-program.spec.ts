import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class IsolatedProgramHost extends Context.Service<
  IsolatedProgramHost,
  { readonly origin: string }
>()("e2e/IsolatedProgramHost") {}

const isolatedProgramHost = Layer.effect(
  IsolatedProgramHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloudflare/scripts/isolated-program-host.ts"], {
        extendEnv: true,
      }),
    );
    const line = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((text) => text.startsWith("listening ")),
      Stream.runHead,
      Effect.timeout("60 seconds"),
    );
    if (line._tag === "None") return yield* Effect.die(new Error("isolated program host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const Execution = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ kind: Schema.String, message: Schema.String })),
    toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String })),
  }),
});

const execute = (code: string, options: { timeoutMs?: number; deadline?: "fails" } = {}) =>
  Effect.gen(function* () {
    const { origin } = yield* IsolatedProgramHost;
    const client = yield* HttpClient.HttpClient;
    const url = new URL(origin);
    url.searchParams.set("code", code);
    url.searchParams.set("timeoutMs", String(options.timeoutMs ?? 5000));
    if (options.deadline !== undefined) url.searchParams.set("deadline", options.deadline);
    const response = yield* client.execute(HttpClientRequest.get(url.toString()));
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Execution)));
  }).pipe(
    Effect.map(({ execution }) => execution),
    Effect.orDie,
  );

layer(isolatedProgramHost, { excludeTestServices: true })("Cloudflare isolated program", (it) => {
  it.effect("a program that returns with work left waiting gives its value", () =>
    Effect.gen(function* () {
      const execution = yield* execute('tools.search({ query: "x" }); return 1');
      expect(execution.ok).toBe(true);
      expect(execution.value).toBe(1);
      expect(execution.toolCalls).toEqual([{ name: "search", outcome: "interrupted" }]);
    }),
  );

  it.effect("a program still waiting at its deadline times out", () =>
    Effect.gen(function* () {
      const execution = yield* execute("await new Promise(() => {})", { timeoutMs: 1000 });
      expect(execution.ok).toBe(false);
      expect(execution.error?.kind).toBe("TimeoutExceeded");
    }),
  );

  it.effect("a deadline that fails fails the execution instead of timing it out", () =>
    Effect.gen(function* () {
      const execution = yield* execute("await new Promise(() => {})", {
        timeoutMs: 60_000,
        deadline: "fails",
      });
      expect(execution.ok).toBe(false);
      expect(execution.error?.kind).toBe("ExecutionFailure");
    }),
  );
});
