/**
 * A Worker that serves the Cloudflare storage adapters over HTTP, the way the Cloudflare host's
 * product Durable Object holds them: R2 for blobs, Artifacts for app source, and the object's
 * own storage for repository tokens. `scripts/storage-host.ts` runs it in local workerd.
 */
import { Cause, Effect, Option, Redacted, Schema, Stream } from "effect";
import { AppCodeId, BlobKey, GitObjectId, SourceCommit, SourceFile } from "@executor-js/sdk/core";
import { r2BlobStore, type R2BucketBinding } from "@executor-js/hosted-cloudflare/blobs";
import {
  artifactsRepositories,
  type ArtifactsBinding,
  type ArtifactsRepository,
} from "@executor-js/hosted-cloudflare/app-source";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
interface Environment {
  readonly PRODUCT: DurableObjectNamespace;
  readonly BLOBS: R2BucketBinding;
  /** The local stand-in for the Artifacts service, reached as plain HTTP. */
  readonly ARTIFACTS_HOST: Fetcher;
  readonly ENCRYPTION_KEY: string;
  readonly ACCOUNT_ID: string;
  readonly NAMESPACE: string;
}
interface DurableObjectNamespace {
  getByName(name: string): Fetcher;
}
interface DurableObjectStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/** An error the binding throws, with the code a real Artifacts binding carries. */
class ArtifactsError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ArtifactsError";
    this.code = code;
  }
}

/** The Artifacts binding methods, each one call to the stand-in service. */
const artifactsBinding = (host: Fetcher): ArtifactsBinding => {
  const call = async (operation: string, repository: string, input: unknown = null) => {
    const response = await host.fetch(
      new Request(`http://artifacts.internal/${operation}`, {
        method: "POST",
        body: JSON.stringify({ repository, input }),
      }),
    );
    const body: { readonly error?: string; readonly result?: unknown } = await response.json();
    if (body.error !== undefined) throw new ArtifactsError(body.error);
    return body.result;
  };
  const blob = (value: unknown) => {
    if (value === null) return null;
    const bytes = Uint8Array.from(atob(String(value)), (c) => c.charCodeAt(0));
    return new Blob([bytes]);
  };
  const repository = (name: string): ArtifactsRepository => ({
    createToken: async (scope, ttl) => (await call("createToken", name, { scope, ttl })) as never,
    log: async (options) => (await call("log", name, options)) as never,
    readCommit: (hash) => call("readCommit", name, { hash }),
    readTree: async (hash) => (await call("readTree", name, { hash })) as never,
    readBlob: async (hash) => blob(await call("readBlob", name, { hash })),
    readFile: async (args) => blob(await call("readFile", name, args)),
  });
  return {
    create: async (name, options) => (await call("create", name, options)) as never,
    get: async (name) => {
      await call("get", name);
      return repository(name);
    },
  };
};

const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const CommitBody = Schema.Struct({
  branch: Schema.String,
  expected: Schema.NullOr(Schema.String),
  files: Schema.Array(SourceFile),
  message: Schema.String,
});

/** Any failure is answered as a 500 that names it, so a scenario sees what went wrong. */
const failed = (cause: Cause.Cause<unknown>) =>
  Effect.succeed(json({ error: Cause.pretty(cause) }, 500));

/** The product Durable Object: the same bindings, and the storage its tokens are kept in. */
export class Product {
  readonly #storage: DurableObjectStorage;
  readonly env: Environment;
  constructor(state: { readonly storage: DurableObjectStorage }, env: Environment) {
    this.#storage = state.storage;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [area, ...rest] = url.pathname.slice(1).split("/").map(decodeURIComponent);
    const program =
      area === "blobs" ? this.#blobs(request, rest.join("/"), url) : this.#source(request, rest);
    return Effect.runPromise(program);
  }

  #blobs(request: Request, path: string, url: URL) {
    const store = r2BlobStore(this.env.BLOBS);
    const key = path as BlobKey;
    return Effect.gen(function* () {
      const view = url.searchParams.get("view");
      if (request.method === "PUT") {
        yield* store.put(key, new Uint8Array(yield* Effect.promise(() => request.arrayBuffer())));
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        yield* store.remove(key);
        return new Response(null, { status: 204 });
      }
      if (view === "exists") return json({ exists: yield* store.exists(key) });
      if (view === "list") {
        const startAfter = url.searchParams.get("startAfter");
        return json(
          yield* store.list(key, {
            limit: Number(url.searchParams.get("limit") ?? "1000"),
            ...(startAfter === null ? {} : { startAfter }),
          }),
        );
      }
      if (view === "stream") {
        const offset = url.searchParams.get("offset");
        const length = url.searchParams.get("length");
        const found = yield* store.stream(
          key,
          offset === null || length === null
            ? undefined
            : { offset: Number(offset), length: Number(length) },
        );
        if (Option.isNone(found)) return new Response(null, { status: 404 });
        const chunks = yield* Stream.runCollect(found.value.body);
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
        return new Response(bytes, { headers: { "x-object-size": String(found.value.size) } });
      }
      const found = yield* store.get(key);
      return Option.isNone(found)
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array(found.value));
    }).pipe(Effect.catchCause(failed));
  }

  #source(request: Request, [code, action, ...rest]: ReadonlyArray<string>) {
    const env = this.env;
    const storage = this.#storage;
    return Effect.gen(function* () {
      const repositories = yield* artifactsRepositories({
        artifacts: artifactsBinding(env.ARTIFACTS_HOST),
        storage,
        encryptionKey: Redacted.make(env.ENCRYPTION_KEY),
        accountId: env.ACCOUNT_ID,
        namespace: env.NAMESPACE,
      });
      const id = yield* Schema.decodeUnknownEffect(AppCodeId)(code);
      if (action === "create") {
        yield* repositories.create(id);
        return new Response(null, { status: 204 });
      }
      if (action === "commit") {
        const body = yield* Schema.decodeUnknownEffect(CommitBody)(
          yield* Effect.promise(() => request.json()),
        );
        return json(yield* repositories.commit({ id, ...body }));
      }
      if (action === "read") return json(yield* repositories.read(id, rest.join("/")));
      if (action === "head") return json({ head: yield* repositories.head(id, rest.join("/")) });
      if (action === "history") return json(yield* repositories.history(id));
      if (action === "blob")
        return new Response(
          new Uint8Array(
            yield* repositories.blob(id, yield* Schema.decodeUnknownEffect(GitObjectId)(rest[0])),
          ),
        );
      if (action === "file") {
        const [commit, ...path] = rest;
        return new Response(
          new Uint8Array(
            yield* repositories.file(
              id,
              yield* Schema.decodeUnknownEffect(SourceCommit)(commit),
              path.join("/"),
            ),
          ),
        );
      }
      if (action === "token") {
        const stored = yield* Effect.promise(() => storage.get(`artifacts-token:${id}`));
        // What the Durable Object holds for the repository, as stored, so a caller can see it is
        // sealed rather than the token itself.
        const sealed = Schema.decodeUnknownOption(
          Schema.Struct({ version: Schema.Literal(1), encrypted: Schema.Uint8Array }),
        )(stored);
        return json({
          stored: stored !== undefined,
          sealed: Option.isSome(sealed),
          text: Option.match(sealed, {
            onNone: () => JSON.stringify(stored ?? null),
            onSome: (value) => new TextDecoder().decode(value.encrypted),
          }),
          bytes: Option.match(sealed, {
            onNone: () => null,
            onSome: (value) => base64(value.encrypted),
          }),
        });
      }
      return new Response(null, { status: 404 });
    }).pipe(Effect.catchCause(failed));
  }
}

export default {
  fetch(request: Request, env: Environment) {
    return env.PRODUCT.getByName("product").fetch(request);
  },
};
