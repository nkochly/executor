/**
 * The Cloudflare host's storage: blobs on R2 and app source on Artifacts, served from a product
 * Durable Object in local workerd by `packages/hosted-cloudflare/scripts/storage-host.ts`. R2 is
 * Miniflare's local simulation. Artifacts has no local simulator, so the host answers its binding
 * from real Git repositories and takes pushes through `git http-backend`; the adapter's pushes are
 * real Git smart-HTTP pushes. Every write is read back and compared byte for byte.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

class StorageHost extends Context.Service<StorageHost, { readonly origin: string }>()(
  "e2e/StorageHost",
) {}

/** Start the host and wait for the origin it prints; the process stops with the scope. */
const storageHost = Layer.effect(
  StorageHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["packages/hosted-cloudflare/scripts/storage-host.ts"], {
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
    if (line._tag === "None") return yield* Effect.die(new Error("storage host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const request = (
  path: string,
  init: {
    readonly method?: "GET" | "PUT" | "POST" | "DELETE";
    readonly body?: Uint8Array | string;
  } = {},
) =>
  Effect.gen(function* () {
    const { origin } = yield* StorageHost;
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.make(init.method ?? "GET")(`${origin}${path}`);
    return yield* client.execute(
      init.body === undefined
        ? base
        : typeof init.body === "string"
          ? HttpClientRequest.bodyText(base, init.body)
          : HttpClientRequest.bodyUint8Array(base, init.body),
    );
  }).pipe(Effect.orDie);
const bytesOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.orDie,
  );
const jsonOf =
  <S extends Schema.Top>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.orDie);

/** Random bytes, so a byte that is lost, reordered or re-encoded cannot go unnoticed. */
const random = (length: number) => {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 65_536)
    crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65_536, length)));
  return bytes;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const Listing = Schema.Struct({ names: Schema.Array(Schema.String), truncated: Schema.Boolean });
const Saved = Schema.Struct({
  commit: Schema.String,
  removed: Schema.Struct({ count: Schema.Number, paths: Schema.Array(Schema.String) }),
});
const ReadFile = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    encoding: Schema.Literal("base64"),
  }),
  Schema.Struct({ path: Schema.String, object: Schema.String, size: Schema.Number }),
  Schema.Struct({ path: Schema.String, content: Schema.String }),
]);
const Snapshot = Schema.Struct({ commit: Schema.String, files: Schema.Array(ReadFile) });
const History = Schema.Array(
  Schema.Struct({ commit: Schema.String, message: Schema.String, author: Schema.String }),
);
const Token = Schema.Struct({
  stored: Schema.Boolean,
  sealed: Schema.Boolean,
  text: Schema.String,
});

layer(storageHost, { excludeTestServices: true })("Cloudflare host storage", (it) => {
  it.effect("a blob written to R2 reads back byte for byte, whole and by range", () =>
    Effect.gen(function* () {
      const body = random(3 * 1024 * 1024 + 17);
      const put = yield* request("/blobs/builds/run-1/bundle.bin", { method: "PUT", body });
      expect(put.status).toBe(204);

      const whole = yield* request("/blobs/builds/run-1/bundle.bin").pipe(Effect.flatMap(bytesOf));
      expect(whole.length).toBe(body.length);
      expect(Buffer.compare(whole, body)).toBe(0);

      const ranged = yield* request(
        "/blobs/builds/run-1/bundle.bin?view=stream&offset=1048570&length=4096",
      );
      expect(ranged.headers["x-object-size"]).toBe(String(body.length));
      expect(
        Buffer.compare(yield* bytesOf(ranged), body.subarray(1_048_570, 1_048_570 + 4096)),
      ).toBe(0);

      const streamed = yield* request("/blobs/builds/run-1/bundle.bin?view=stream").pipe(
        Effect.flatMap(bytesOf),
      );
      expect(Buffer.compare(streamed, body)).toBe(0);

      const empty = yield* request("/blobs/builds/run-1/bundle.bin?view=stream&offset=0&length=0");
      expect(empty.headers["x-object-size"]).toBe(String(body.length));
      expect((yield* bytesOf(empty)).length).toBe(0);
    }),
  );

  it.effect("R2 lists one folder's own objects in pages, and removed objects are gone", () =>
    Effect.gen(function* () {
      for (const name of ["c", "a", "b", "nested/d"])
        yield* request(`/blobs/icons/set-1/${name}`, { method: "PUT", body: name });
      const first = yield* request("/blobs/icons/set-1?view=list&limit=2").pipe(
        Effect.flatMap(jsonOf(Listing)),
      );
      expect(first).toEqual({ names: ["a", "b"], truncated: true });
      const second = yield* request("/blobs/icons/set-1?view=list&limit=2&startAfter=b").pipe(
        Effect.flatMap(jsonOf(Listing)),
      );
      expect(second).toEqual({ names: ["c"], truncated: false });

      const exists = yield* request("/blobs/icons/set-1/a?view=exists").pipe(
        Effect.flatMap(jsonOf(Schema.Struct({ exists: Schema.Boolean }))),
      );
      expect(exists.exists).toBe(true);
      expect((yield* request("/blobs/icons/set-1/a", { method: "DELETE" })).status).toBe(204);
      expect((yield* request("/blobs/icons/set-1/a")).status).toBe(404);
      const gone = yield* request("/blobs/icons/set-1/a?view=exists").pipe(
        Effect.flatMap(jsonOf(Schema.Struct({ exists: Schema.Boolean }))),
      );
      expect(gone.exists).toBe(false);
    }),
  );

  it.effect("app source committed to Artifacts reads back byte for byte", () =>
    Effect.gen(function* () {
      const code = "code_bytes1";
      expect((yield* request(`/source/${code}/create`, { method: "POST" })).status).toBe(204);
      // Creating it again reuses the repository Artifacts already holds.
      expect((yield* request(`/source/${code}/create`, { method: "POST" })).status).toBe(204);

      const text = {
        "index.ts": 'import { tools } from "./tools/index.ts";\nexport default tools;\n',
        "tools/index.ts": 'export const tools = { naïve: "café ☕ 𝄞" };\r\n',
        "README.md": "",
      };
      const logo = random(4096);
      const font = random(200 * 1024);
      const files = [
        ...Object.entries(text).map(([path, content]) => ({ path, content })),
        { path: "ui/public/logo.png", content: base64(logo), encoding: "base64" },
        { path: "ui/public/fonts/body.woff2", content: base64(font), encoding: "base64" },
      ];
      const first = yield* request(`/source/${code}/commit`, {
        method: "POST",
        body: JSON.stringify({ branch: "main", expected: null, message: "First save", files }),
      }).pipe(Effect.flatMap(jsonOf(Saved)));
      expect(first.commit).toMatch(/^[a-f0-9]{40}$/u);

      const snapshot = yield* request(`/source/${code}/read/main`).pipe(
        Effect.flatMap(jsonOf(Snapshot)),
      );
      expect(snapshot.commit).toBe(first.commit);
      expect(snapshot.files.map((file) => file.path).sort()).toEqual(
        files.map((file) => file.path).sort(),
      );
      for (const file of snapshot.files) {
        if (file.path in text && "content" in file)
          expect(file.content).toBe(text[file.path as keyof typeof text]);
      }
      // Binary public files are listed by blob; each blob reads back as the bytes written.
      for (const [path, bytes] of [
        ["ui/public/logo.png", logo],
        ["ui/public/fonts/body.woff2", font],
      ] as const) {
        const listed = snapshot.files.find((file) => file.path === path);
        expect(listed !== undefined && "object" in listed).toBe(true);
        if (listed === undefined || !("object" in listed)) continue;
        expect(listed.size).toBe(bytes.length);
        const blob = yield* request(`/source/${code}/blob/${listed.object}`).pipe(
          Effect.flatMap(bytesOf),
        );
        expect(Buffer.compare(blob, bytes)).toBe(0);
      }
      // Every file of the commit, by path, is the exact bytes that were saved.
      const expected: ReadonlyArray<readonly [string, Uint8Array]> = [
        ...Object.entries(text).map(
          ([path, content]) => [path, new TextEncoder().encode(content)] as const,
        ),
        ["ui/public/logo.png", logo],
        ["ui/public/fonts/body.woff2", font],
      ];
      for (const [path, bytes] of expected) {
        const read = yield* request(`/source/${code}/file/${first.commit}/${path}`).pipe(
          Effect.flatMap(bytesOf),
        );
        expect(Buffer.compare(read, bytes), path).toBe(0);
      }

      // A second save against the first replaces one file and leaves one out.
      const second = yield* request(`/source/${code}/commit`, {
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          expected: first.commit,
          message: "Second save",
          files: [
            { path: "index.ts", content: "export default {};\n" },
            { path: "tools/index.ts", content: text["tools/index.ts"] },
            snapshot.files.find((file) => file.path === "ui/public/logo.png"),
            { path: "ui/public/fonts/body.woff2", content: base64(font), encoding: "base64" },
          ],
        }),
      }).pipe(Effect.flatMap(jsonOf(Saved)));
      expect(second.removed).toEqual({ count: 1, paths: ["README.md"] });
      const head = yield* request(`/source/${code}/head/main`).pipe(
        Effect.flatMap(jsonOf(Schema.Struct({ head: Schema.NullOr(Schema.String) }))),
      );
      expect(head.head).toBe(second.commit);
      const logoAgain = yield* request(
        `/source/${code}/file/${second.commit}/ui/public/logo.png`,
      ).pipe(Effect.flatMap(bytesOf));
      expect(Buffer.compare(logoAgain, logo)).toBe(0);

      const history = yield* request(`/source/${code}/history`).pipe(
        Effect.flatMap(jsonOf(History)),
      );
      expect(history.map((entry) => [entry.commit, entry.message])).toEqual([
        [second.commit, "Second save"],
        [first.commit, "First save"],
      ]);

      // A save against a commit that is no longer the head is refused.
      const stale = yield* request(`/source/${code}/commit`, {
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          expected: first.commit,
          message: "Stale save",
          files: [{ path: "index.ts", content: "export default 2;\n" }],
        }),
      });
      expect(stale.status).toBe(500);
      const after = yield* request(`/source/${code}/head/main`).pipe(
        Effect.flatMap(jsonOf(Schema.Struct({ head: Schema.NullOr(Schema.String) }))),
      );
      expect(after.head).toBe(second.commit);
    }),
  );

  it.effect("a repository's write token is kept sealed in the product's storage", () =>
    Effect.gen(function* () {
      const code = "code_tokens1";
      yield* request(`/source/${code}/create`, { method: "POST" });
      yield* request(`/source/${code}/commit`, {
        method: "POST",
        body: JSON.stringify({
          branch: "main",
          expected: null,
          message: "Save",
          files: [{ path: "index.ts", content: "export default 1;\n" }],
        }),
      });
      const token = yield* request(`/source/${code}/token`).pipe(Effect.flatMap(jsonOf(Token)));
      expect(token.stored).toBe(true);
      expect(token.sealed).toBe(true);
      expect(token.text).not.toContain("art_tok_");
      expect(token.text).not.toContain(code);
    }),
  );
});
