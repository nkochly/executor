/**
 * The platform services the product needs beyond its database: blob storage, app repositories,
 * and the app runtime with workflows. Each comes from a binding:
 * - `BLOBS` (R2) holds blobs;
 * - `ARTIFACTS` (Artifacts) holds app repositories, with `CLOUDFLARE_ACCOUNT_ID` for its Git
 *   host and `EXECUTOR_ARTIFACTS_NAMESPACE` (default `executor-apps`) for its namespace;
 * - `APPS` is the app host speaking the workerd app protocol.
 * Until a binding is declared its service is a stand-in that refuses every operation with the
 * service's own error, so the product opens, signs people in and serves MCP while apps cannot be
 * stored, built or run.
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
import { r2BlobStore, type R2BucketBinding } from "@executor-js/hosted-cloudflare/blobs";
import {
  artifactsRepositories,
  type ArtifactsBinding,
  type CredentialStorage,
} from "@executor-js/hosted-cloudflare/app-source";
import { Config, Effect } from "effect";

/** The platform bindings this Worker may declare. */
export interface PlatformBindings {
  readonly BLOBS?: R2BucketBinding;
  readonly ARTIFACTS?: ArtifactsBinding;
  readonly APPS?: Fetcher;
}

/** Blob storage that holds nothing: reads find no object and writes fail. */
export const unavailableBlobs: BlobStorage = {
  get: () => Effect.succeedNone,
  exists: () => Effect.succeed(false),
  put: () => Effect.fail(new BlobStoreError({ operation: "put", status: 503 })),
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

/** An app host that is not there: every request is refused with 503. */
const unavailableAppHost = {
  fetch: async () => new Response("App host unavailable", { status: 503 }),
} as unknown as Fetcher;

const repositories = (artifacts: ArtifactsBinding | undefined, storage: CredentialStorage) =>
  artifacts === undefined
    ? Effect.succeed(unavailableRepositories)
    : Effect.gen(function* () {
        return yield* artifactsRepositories({
          artifacts,
          storage,
          encryptionKey: yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY"),
          accountId: yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID"),
          namespace: yield* Config.NonEmptyString("EXECUTOR_ARTIFACTS_NAMESPACE").pipe(
            Config.withDefault("executor-apps"),
          ),
        });
      });

/**
 * Acquire the platform once the database is open; `storage` is the product Durable Object's,
 * which keeps the Artifacts write tokens. `executor` resolves after creation.
 */
export const cloudflarePlatform =
  (env: PlatformBindings, storage: CredentialStorage) => (_executor: Effect.Effect<Executor>) =>
    Effect.gen(function* () {
      const blobs = env.BLOBS === undefined ? unavailableBlobs : r2BlobStore(env.BLOBS);
      const host = yield* bindingWorkerdApps({
        binding: env.APPS ?? unavailableAppHost,
        authorization: "service-binding",
        blobs,
      });
      const platform: SelfHostPlatform = {
        ...host,
        blobs,
        repositories: yield* repositories(env.ARTIFACTS, storage),
      };
      return platform;
    });
