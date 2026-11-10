/**
 * The Cloudflare product's move into an object placed at a location, across a release. Cloudflare
 * moves Durable Objects to new code one at a time, so the placed product can start while the
 * unnamed object it succeeds still runs the release before the move, which cannot hand over its
 * storage. Served in local workerd by `packages/hosted-cloudflare/scripts/product-move-host.ts`.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class MoveHost extends Context.Service<MoveHost, { readonly origin: string }>()(
  "e2e/ProductMoveHost",
) {}

const moveHost = Layer.effect(
  MoveHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["packages/hosted-cloudflare/scripts/product-move-host.ts"], {
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
    if (line._tag === "None") return yield* Effect.die(new Error("product move host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const Served = Schema.Struct({ servedBy: Schema.String, notes: Schema.Array(Schema.String) });

const seed = (release: "previous" | "current", notes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { origin } = yield* MoveHost;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.bodyText(
        HttpClientRequest.post(`${origin}/seed/${release}`),
        JSON.stringify(notes),
      ),
    );
    expect(response.status).toBe(204);
  }).pipe(Effect.orDie);

const ask = (placed: string, previous: "previous" | "current") =>
  Effect.gen(function* () {
    const { origin } = yield* MoveHost;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/placed/${placed}?previous=${previous}`),
    );
    expect(response.status).toBe(200);
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Served)));
  }).pipe(Effect.orDie);

layer(moveHost, { excludeTestServices: true })("Cloudflare product move", (it) => {
  it.effect(
    "while the unnamed object runs the release before the move, it keeps serving its data",
    () =>
      Effect.gen(function* () {
        yield* seed("previous", ["first", "second"]);
        const served = yield* ask("product-wnam-a", "previous");
        expect(served).toEqual({ servedBy: "previous release", notes: ["first", "second"] });
        // Every request asks again, and none fails while the release has not moved.
        const again = yield* ask("product-wnam-a", "previous");
        expect(again.servedBy).toBe("previous release");
      }),
  );

  it.effect("once the unnamed object runs this release, the placed one copies it and serves", () =>
    Effect.gen(function* () {
      yield* seed("current", ["kept", "also kept"]);
      const served = yield* ask("product-wnam-b", "current");
      expect(served).toEqual({ servedBy: "placed", notes: ["kept", "also kept"] });
    }),
  );
});
