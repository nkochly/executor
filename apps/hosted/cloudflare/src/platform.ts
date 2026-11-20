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

export interface PlatformBindings {
  readonly BLOBS?: R2BucketBinding;
  readonly ARTIFACTS?: ArtifactsBinding;
  readonly APPS?: Fetcher;
}

export const unavailableBlobs: BlobStorage = {
  get: () => Effect.succeedNone,
  exists: () => Effect.succeed(false),
  put: () => Effect.fail(new BlobStoreError({ operation: "put", status: 503 })),
  remove: () => Effect.void,
  list: () => Effect.succeed({ names: [], truncated: false }),
  stream: () => Effect.succeedNone,
};

const sourceFailure = () => Effect.fail(new SourceError({ reason: "git" }));

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
