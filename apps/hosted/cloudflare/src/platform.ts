/**
 * The platform services the product needs beyond its database: blob storage, app repositories,
 * and the app runtime with workflows. Each comes from a binding; until its binding is declared
 * it is a stand-in that refuses every operation with the service's own error, so the product
 * opens, signs people in and serves MCP while apps cannot be stored, built or run.
 *
 * Blob storage on R2 and repositories on Artifacts replace `unavailableBlobs` and
 * `unavailableRepositories`; the app runtime and workflows replace the `APPS` stand-in.
 */
import type { Fetcher } from "@cloudflare/workers-types";
import {
  BlobStoreError,
  SourceError,
  type BlobStorage,
  type Executor,
  type RepositoryBackend,
} from "@executor-js/sdk/core";
import { bindingWorkerdApps } from "@executor-js/sdk/workerd";
import type { SelfHostPlatform } from "@executor-js/hosted-self-host/product";
import { Effect } from "effect";

/** The platform bindings this Worker may declare; each is optional until its adapter lands. */
export interface PlatformBindings {
  /** The app host: a service speaking the workerd app protocol (`@executor-js/sdk/workerd`). */
  readonly APPS?: Fetcher;
}

const blobFailure = (operation: BlobStoreError["operation"]) =>
  Effect.fail(new BlobStoreError({ operation, status: 503 }));

/** Blob storage that holds nothing: reads find no object and writes fail. */
export const unavailableBlobs: BlobStorage = {
  get: () => Effect.succeedNone,
  exists: () => Effect.succeed(false),
  put: () => blobFailure("put"),
  remove: () => Effect.void,
  list: () => Effect.succeed({ names: [], truncated: false }),
  stream: () => Effect.succeedNone,
};

const sourceFailure = () => Effect.fail(new SourceError({ reason: "git" }));

/** Repositories that hold no app source; every operation fails as a Git failure. */
export const unavailableRepositories: RepositoryBackend = {
  history: sourceFailure,
  create: sourceFailure,
  head: sourceFailure,
  read: sourceFailure,
  commit: sourceFailure,
  blob: sourceFailure,
  file: sourceFailure,
  request: sourceFailure,
};

/** An app host that is not there: every connection and request is refused with 503. */
const unavailableAppHost = {
  fetch: async () => new Response("App host unavailable", { status: 503 }),
  connect: () => {
    throw new Error("App host unavailable");
  },
} as unknown as Fetcher;

/** Acquire the platform once the database is open; `executor` resolves after creation. */
export const cloudflarePlatform =
  (env: PlatformBindings) =>
  (_executor: Effect.Effect<Executor>): Effect.Effect<SelfHostPlatform> =>
    Effect.gen(function* () {
      const blobs = unavailableBlobs;
      const host = yield* bindingWorkerdApps({
        binding: env.APPS ?? unavailableAppHost,
        authorization: "service-binding",
        blobs,
      });
      return { ...host, blobs, repositories: unavailableRepositories };
    });
