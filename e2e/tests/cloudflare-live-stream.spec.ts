import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class LiveStreamHost extends Context.Service<LiveStreamHost, { readonly origin: string }>()(
  "e2e/LiveStreamHost",
) {}

const liveStreamHost = Layer.effect(
  LiveStreamHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloudflare/scripts/live-stream-host.ts"], {
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
    if (line._tag === "None") return yield* Effect.die(new Error("live stream host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const runs = Effect.gen(function* () {
  const { origin } = yield* LiveStreamHost;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(HttpClientRequest.get(`${origin}/runs`));
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Number)));
}).pipe(Effect.orDie);

const risen = (from: number) =>
  runs.pipe(
    Effect.repeat({ until: (count) => count > from, schedule: Schedule.spaced("100 millis") }),
    Effect.timeout("10 seconds"),
  );

const stopped = Effect.gen(function* () {
  let last = yield* runs;
  while (true) {
    yield* Effect.sleep("500 millis");
    const next = yield* runs;
    if (next === last) return next;
    last = next;
  }
}).pipe(Effect.timeout("10 seconds"));

layer(liveStreamHost, { excludeTestServices: true })("Cloudflare live stream", (it) => {
  it.effect("an event stream stops running once its client has gone", () =>
    Effect.gen(function* () {
      const { origin } = yield* LiveStreamHost;
      const client = yield* HttpClient.HttpClient;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* client.execute(HttpClientRequest.get(`${origin}/live`));
          expect(response.headers["content-type"]).toContain("text/event-stream");
          yield* response.stream.pipe(Stream.take(1), Stream.runDrain);
          const opened = yield* runs;
          expect(
            Option.isSome(yield* risen(opened).pipe(Effect.option)),
            "the stream runs while its client holds it",
          ).toBe(true);
        }),
      ).pipe(Effect.orDie);

      expect(
        Option.isSome(yield* stopped.pipe(Effect.option)),
        "the stream stops running once its client has gone",
      ).toBe(true);
    }),
  );
});
