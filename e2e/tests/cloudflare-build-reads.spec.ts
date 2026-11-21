import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class BuildReadsHost extends Context.Service<BuildReadsHost, { readonly origin: string }>()(
  "e2e/BuildReadsHost",
) {}

const buildReadsHost = Layer.effect(
  BuildReadsHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloudflare/scripts/build-reads-host.ts"], {
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
    if (line._tag === "None") return yield* Effect.die(new Error("build reads host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const Burst = Schema.Struct({
  loaded: Schema.Array(Schema.Number),
  reads: Schema.Number,
  peak: Schema.Number,
});

const burst = (callers: number, builds = 1) =>
  Effect.gen(function* () {
    const { origin } = yield* BuildReadsHost;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/?callers=${callers}&builds=${builds}`),
    );
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Burst)));
  }).pipe(Effect.orDie);

layer(buildReadsHost, { excludeTestServices: true })("Cloudflare product build reads", (it) => {
  it.effect("forty app cold starts at once read one build's record and framework once", () =>
    Effect.gen(function* () {
      const { loaded, reads } = yield* burst(40);
      expect(loaded).toEqual(Array.from({ length: 40 }, () => 2));
      expect(reads).toBe(2);
    }),
  );

  it.effect(
    "twenty different builds at once read their framework once, four objects at a time",
    () =>
      Effect.gen(function* () {
        const { loaded, reads, peak } = yield* burst(1, 20);
        expect(loaded).toEqual(Array.from({ length: 20 }, () => 2));
        expect(reads).toBe(21);
        expect(peak).toBeLessThanOrEqual(4);
      }),
  );
});
