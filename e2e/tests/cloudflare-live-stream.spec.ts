/**
 * A live app query runs only while a page holds it. The Cloudflare product serves from a Durable
 * Object behind its Worker, and its event streams end only when the runtime cancels the body the
 * object streamed. If a client's disconnect stopped reaching that body, every live query a page
 * ever opened would keep re-running its query until the object was evicted (upstream's self-host
 * image, on its own workerd build, needed `enable_request_signal` for this). Served in local workerd, with the Worker's own compatibility settings, by
 * `apps/hosted/cloudflare/scripts/live-stream-host.ts`.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
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

layer(liveStreamHost, { excludeTestServices: true })("Cloudflare live stream", (it) => {
  it.effect("an event stream stops running once its client has gone", () =>
    Effect.gen(function* () {
      const { origin } = yield* LiveStreamHost;
      const client = yield* HttpClient.HttpClient;
      // The client holds the stream while this scope is open; closing it disconnects.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* client.execute(HttpClientRequest.get(`${origin}/live`));
          expect(response.headers["content-type"]).toContain("text/event-stream");
          yield* response.stream.pipe(Stream.take(1), Stream.runDrain);
          const opened = yield* runs;
          yield* Effect.sleep("1 second");
          expect(yield* runs, "runs of the stream while its client holds it").toBeGreaterThan(
            opened,
          );
        }),
      ).pipe(Effect.orDie);

      // The runtime finds the client gone on its next write; give it time.
      yield* Effect.sleep("2 seconds");
      const settled = yield* runs;
      // About twenty runs fall in this window while the stream still runs.
      yield* Effect.sleep("2 seconds");
      const later = yield* runs;
      expect(later - settled, "runs of the stream after its client went away").toBe(0);
    }),
  );
});
