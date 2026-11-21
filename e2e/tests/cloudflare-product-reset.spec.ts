import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class ProductResetHost extends Context.Service<ProductResetHost, { readonly origin: string }>()(
  "e2e/ProductResetHost",
) {}

const productResetHost = Layer.effect(
  ProductResetHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloudflare/scripts/product-reset-host.ts"], {
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
    if (line._tag === "None") return yield* Effect.die(new Error("product reset host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const Answer = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});

const get = (path: string) =>
  Effect.gen(function* () {
    const { origin } = yield* ProductResetHost;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(`${origin}${path}`));
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Answer)));
  }).pipe(Effect.orDie);

layer(productResetHost, { excludeTestServices: true })("Cloudflare product reset", (it) => {
  it.effect("a session object reaches the product again after the product resets", () =>
    Effect.gen(function* () {
      const before = yield* get("/call");
      expect(before).toEqual({ ok: true, value: { ok: true, value: "listApps" } });
      yield* get("/reset");
      const after = yield* get("/call");
      expect(after).toEqual({ ok: true, value: { ok: true, value: "listApps" } });
    }),
  );
});
