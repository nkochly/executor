import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class BackupHost extends Context.Service<BackupHost, { readonly origin: string }>()(
  "e2e/ProductBackupHost",
) {}

const backupHost = Layer.effect(
  BackupHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["packages/hosted-cloudflare/scripts/product-backup-host.ts"], {
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
    if (line._tag === "None") return yield* Effect.die(new Error("product backup host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const call = (method: "GET" | "POST", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { origin } = yield* BackupHost;
    const client = yield* HttpClient.HttpClient;
    const request =
      method === "GET"
        ? HttpClientRequest.get(`${origin}${path}`)
        : HttpClientRequest.bodyText(
            HttpClientRequest.post(`${origin}${path}`),
            JSON.stringify(body ?? null),
          );
    const response = yield* client.execute(request);
    expect(response.status).toBe(200);
    return yield* response.json;
  }).pipe(Effect.orDie);

const Contents = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ deployment: Schema.String, icon: Schema.String })),
  audit: Schema.Array(Schema.String),
  settings: Schema.Unknown,
  sealed: Schema.Array(Schema.Number),
});
const decode =
  <S extends Schema.Top>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie);

layer(backupHost, { excludeTestServices: true })("Cloudflare product backups", (it) => {
  it.effect("a backup restores into an object that stores nothing, exactly", () =>
    Effect.gen(function* () {
      yield* call("POST", "/seed/product-a", ["first", "second"]);
      const before = yield* call("GET", "/contents/product-a").pipe(
        Effect.flatMap(decode(Contents)),
      );
      const manifest = yield* call("POST", "/backup/product-a");
      expect(manifest).toMatchObject({ tables: { app: 2, deployment: 2, audit: 2 }, values: 2 });
      expect(yield* call("GET", "/empty/fresh-a")).toBe(true);
      const restored = yield* call("POST", "/restore/fresh-a?from=product-a").pipe(
        Effect.flatMap(decode(Contents)),
      );
      expect(restored).toEqual(before);
      expect(restored.sealed).toEqual([1, 2, 3]);
    }),
  );

  it.effect("a restore never writes over an object that stores data", () =>
    Effect.gen(function* () {
      yield* call("POST", "/seed/product-b", ["live"]);
      yield* call("POST", "/backup/product-b");
      yield* call("POST", "/seed/busy-b", ["other"]);
      const refused = yield* call("POST", "/restore/busy-b?from=product-b");
      expect(refused).toMatchObject({ error: expect.stringContaining("stores nothing") });
      const kept = yield* call("GET", "/contents/busy-b").pipe(Effect.flatMap(decode(Contents)));
      expect(kept.apps.map((a) => a.deployment)).toEqual(["other"]);
    }),
  );

  it.effect("a restore test matches the backup and leaves the scratch object storing nothing", () =>
    Effect.gen(function* () {
      yield* call("POST", "/seed/product-c", ["one", "two", "three"]);
      yield* call("POST", "/backup/product-c");
      const test = yield* call("POST", "/test/restore-test-c?from=product-c");
      expect(test).toMatchObject({ ok: true, tables: { app: { backup: 3, restored: 3 } } });
      expect(yield* call("GET", "/empty/restore-test-c")).toBe(true);
      expect(yield* call("GET", "/backups/product-c")).toHaveLength(1);
    }),
  );

  it.effect("an object with no backup says so", () =>
    Effect.gen(function* () {
      const missing = yield* call("POST", "/restore/fresh-d?from=product-d");
      expect(missing).toMatchObject({ error: "product-d has no backup." });
    }),
  );
});
