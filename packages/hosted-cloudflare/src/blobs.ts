/**
 * Blob storage on an R2 bucket bound to the Worker. The Cloud build's store, without its
 * deployment wiring: the host passes the bucket binding it was given.
 */
import { BlobKey, BlobStoreError, type BlobRange, type BlobStorage } from "@executor-js/sdk/core";
import { Effect, Option, Schedule, Schema, Stream } from "effect";

/** The R2 bucket methods the store calls; a Worker's `R2Bucket` binding satisfies it. */
export interface R2BucketBinding {
  readonly head: (key: string) => Promise<{ readonly size: number } | null>;
  readonly get: (
    key: string,
    options?: { readonly range?: { readonly offset: number; readonly length: number } },
  ) => Promise<{
    readonly size: number;
    readonly body: ReadableStream<Uint8Array>;
    readonly arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;
  readonly put: (key: string, body: Uint8Array) => Promise<unknown>;
  readonly delete: (key: string) => Promise<void>;
  readonly list: (options: {
    readonly prefix: string;
    readonly delimiter: string;
    readonly limit: number;
    readonly startAfter?: string;
  }) => Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly truncated: boolean;
  }>;
}

/** R2 names an explicit rate-limit rejection with code 10058 in the error message. */
const rateLimited = (cause: unknown) => cause instanceof Error && cause.message.includes("10058");

const call = <A>(operation: BlobStoreError["operation"], key: string, evaluate: () => Promise<A>) =>
  Schema.decodeUnknownEffect(BlobKey)(key).pipe(
    Effect.mapError((cause) => new BlobStoreError({ operation, cause })),
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: evaluate,
        catch: (cause) => new BlobStoreError({ operation, cause }),
      }),
    ),
  );

/** One object per key. Writes of the same key and bytes retry R2's explicit rate limit twice. */
export const r2BlobStore = (bucket: R2BucketBinding): BlobStorage => ({
  get: (key) =>
    call("get", key, async () => {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    }).pipe(Effect.map(Option.fromNullishOr)),
  exists: (key) =>
    call("exists", key, () => bucket.head(key)).pipe(Effect.map((head) => head !== null)),
  put: (key, body) =>
    call("put", key, () => bucket.put(key, body)).pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.exponential("1 second"),
        while: (error) => rateLimited(error.cause),
      }),
      Effect.asVoid,
    ),
  remove: (key) => call("remove", key, () => bucket.delete(key)),
  // `delimiter` keeps nested folders out; R2 pages the names itself.
  list: (folder, options) =>
    call("list", folder, () =>
      bucket.list({
        prefix: `${folder}/`,
        delimiter: "/",
        limit: options.limit,
        ...(options.startAfter === undefined
          ? {}
          : { startAfter: `${folder}/${options.startAfter}` }),
      }),
    ).pipe(
      Effect.map((page) => ({
        names: page.objects.map((object) => object.key.slice(folder.length + 1)),
        truncated: page.truncated,
      })),
    ),
  stream: (key, range) => streamObject(bucket, key, range),
});

/** Range reads go to R2; an empty range only needs the object's size. */
const streamObject = (bucket: R2BucketBinding, key: BlobKey, range: BlobRange | undefined) =>
  range !== undefined && range.length === 0
    ? call("get", key, () => bucket.head(key)).pipe(
        Effect.map((head) =>
          head === null ? Option.none() : Option.some({ size: head.size, body: Stream.empty }),
        ),
      )
    : call("get", key, () =>
        bucket.get(
          key,
          range === undefined
            ? undefined
            : { range: { offset: range.offset, length: range.length } },
        ),
      ).pipe(
        Effect.map((object) =>
          object === null
            ? Option.none()
            : Option.some({
                size: object.size,
                body: Stream.fromReadableStream({
                  evaluate: () => object.body,
                  onError: (cause) => new BlobStoreError({ operation: "get", cause }),
                }),
              }),
        ),
      );
