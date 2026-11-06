/**
 * App source on Cloudflare Artifacts, for a host whose product runs in one Durable Object.
 * Git reads and pushes are the shared `@executor-js/app-source/cloudflare` adapter. This module
 * supplies the host side it needs: repository creation, write tokens, and the binding reads Git
 * cannot do without fetching whole packs. Tokens are stored encrypted in the host's storage.
 */
import {
  AppCodeId,
  GitCommit,
  SourceError,
  SourceFilePath,
  aesGcmCredentials,
  type RepositoryBackend,
} from "@executor-js/sdk/core";
import { cloudflareRepositories, type ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { Clock, Effect, Redacted, Schedule, Schema, Semaphore } from "effect";

/** The Artifacts repository methods the source calls; the binding's `ArtifactsRepo` satisfies it. */
export interface ArtifactsRepository {
  readonly createToken: (
    scope: "write",
    ttl: number,
  ) => Promise<{ id: string; plaintext: string; scope: string; expiresAt: string }>;
  readonly log: (options: { ref: string; limit: number }) => Promise<ReadonlyArray<unknown>>;
  readonly readCommit: (hash: string) => Promise<unknown>;
  readonly readTree: (hash: string) => Promise<ReadonlyArray<unknown> | null>;
  readonly readBlob: (
    hash: string,
  ) => Promise<{ readonly size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  readonly readFile: (args: {
    ref: string;
    path: string;
  }) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** The namespace methods the source calls; a Worker's `Artifacts` binding satisfies it. */
export interface ArtifactsBinding {
  readonly create: (
    name: string,
    options: { readonly setDefaultBranch: string },
  ) => Promise<{ readonly token: string }>;
  readonly get: (name: string) => Promise<ArtifactsRepository>;
}

/** Key-value storage that survives restarts; a Durable Object's `ctx.storage` satisfies it. */
export interface CredentialStorage {
  readonly get: (key: string) => Promise<unknown>;
  readonly put: (key: string, value: unknown) => Promise<void>;
}

export interface ArtifactsSourceSettings {
  readonly artifacts: ArtifactsBinding;
  readonly storage: CredentialStorage;
  /** 64 hex characters: the host's 256-bit credential key. */
  readonly encryptionKey: Redacted.Redacted<string>;
  readonly accountId: string;
  readonly namespace: string;
}

/** Artifacts' longest token lifetime. A token is replaced five minutes before it expires. */
const tokenLifetimeSeconds = 31_536_000;
const refreshBeforeExpiryMs = 5 * 60_000;
const blobReads = 4;
const treeReads = 4;

const objectId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const issued = Schema.Struct({
  id: Schema.NonEmptyString,
  plaintext: Schema.RedactedFromValue(Schema.NonEmptyString),
  expiresAt: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
});
const saved = Schema.Struct({
  repository: AppCodeId,
  namespace: Schema.NonEmptyString,
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
  generation: Schema.NonEmptyString,
  expiresAt: Schema.Number.check(Schema.isFinite()),
});
const envelope = Schema.Struct({ version: Schema.Literal(1), encrypted: Schema.Uint8Array });
const listedCommit = Schema.Struct({
  hash: Schema.String,
  treeHash: Schema.String,
  message: Schema.String,
  author: Schema.Struct({ name: Schema.String }),
  authoredAt: Schema.Number,
});
const treeEntry = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  hash: Schema.String,
  type: Schema.String,
});

const alreadyExists = Schema.Struct({ code: Schema.Literal("ALREADY_EXISTS") });

const unavailable = () => new SourceError({ reason: "git" });
const attempt = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: unavailable });
const storageKey = (repository: AppCodeId) => `artifacts-token:${repository}`;

/** A Worker RPC stub holds resources until disposed; plain objects have nothing to release. */
const dispose = (value: unknown) =>
  Effect.sync(() => {
    if (value !== null && typeof value === "object" && Symbol.dispose in value) {
      const release = (value as { [Symbol.dispose]?: unknown })[Symbol.dispose];
      if (typeof release === "function") release.call(value);
    }
  });

/**
 * Host-owned credentials and binding reads for the Git adapter. One lock serializes token
 * refreshes: the product runs in one Durable Object, so this lock is the only writer.
 */
export const artifactsTokens = (settings: ArtifactsSourceSettings) =>
  Effect.gen(function* () {
    const encryption = yield* aesGcmCredentials(settings.encryptionKey, crypto);
    const lock = yield* Semaphore.make(1);
    const open = (repository: AppCodeId) =>
      Effect.acquireRelease(
        attempt(() => settings.artifacts.get(repository)).pipe(
          // A repository is briefly unavailable while Artifacts finishes creating it.
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 2 }),
        ),
        dispose,
      );
    const read = <A>(
      id: AppCodeId,
      use: (repo: ArtifactsRepository) => Effect.Effect<A, SourceError>,
    ) => Effect.scoped(Effect.flatMap(open(id), use)).pipe(Effect.mapError(unavailable));

    const acquire = (repository: AppCodeId, rejectedGeneration: string | null) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const stored = yield* attempt(() => settings.storage.get(storageKey(repository)));
          if (stored !== undefined) {
            const sealed = yield* Schema.decodeUnknownEffect(envelope)(stored);
            const plain = yield* encryption.decrypt(repository, Redacted.make(sealed.encrypted));
            const token = yield* Schema.decodeUnknownEffect(saved)(Redacted.value(plain));
            if (token.repository !== repository || token.namespace !== settings.namespace)
              return yield* unavailable();
            if (
              token.expiresAt > now + refreshBeforeExpiryMs &&
              token.generation !== rejectedGeneration
            )
              return { token: token.token, generation: token.generation };
          }
          const minted = yield* Effect.scoped(
            Effect.gen(function* () {
              const repo = yield* open(repository);
              const result = yield* Effect.acquireRelease(
                attempt(() => repo.createToken("write", tokenLifetimeSeconds)),
                dispose,
              );
              // RPC properties are read while the handle is alive; the plaintext is never logged.
              return yield* attempt(async () => ({
                id: await result.id,
                plaintext: await result.plaintext,
                expiresAt: await result.expiresAt,
              })).pipe(Effect.flatMap(Schema.decodeUnknownEffect(issued)));
            }),
          );
          const expiresAt = Date.parse(minted.expiresAt);
          if (expiresAt <= now + refreshBeforeExpiryMs) return yield* unavailable();
          const payload = yield* Schema.encodeEffect(saved)({
            repository,
            namespace: settings.namespace,
            token: minted.plaintext,
            generation: minted.id,
            expiresAt,
          });
          const encrypted = yield* encryption.encrypt(repository, Redacted.make(payload));
          yield* attempt(() =>
            settings.storage.put(storageKey(repository), { version: 1, encrypted }),
          );
          return { token: minted.plaintext, generation: minted.id };
        }),
      );

    return {
      create: (repository) =>
        Effect.scoped(
          Effect.acquireRelease(
            // Creation is keyed by the repository ID, so an existing repository is reused.
            attempt(async (): Promise<{ readonly token: string } | null> => {
              try {
                return await settings.artifacts.create(repository, { setDefaultBranch: "main" });
              } catch (cause) {
                if (Schema.is(alreadyExists)(cause)) return null;
                throw cause;
              }
            }),
            dispose,
          ).pipe(
            Effect.flatMap((created) =>
              created === null
                ? Effect.succeed(null)
                : attempt(async () => created.token).pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(Schema.RedactedFromValue(Schema.NonEmptyString)),
                    ),
                  ),
            ),
          ),
        ).pipe(Effect.mapError(unavailable)),
      acquire: (repository, rejectedGeneration) =>
        acquire(repository, rejectedGeneration).pipe(Effect.mapError(unavailable)),
      history: (repository, limit) =>
        read(repository, (repo) =>
          attempt(() => repo.log({ ref: "main", limit })).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(listedCommit))),
            Effect.map((commits) =>
              commits.map((entry) => ({
                commit: entry.hash,
                author: entry.author.name,
                message: entry.message.trim(),
                timestamp: entry.authoredAt,
              })),
            ),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(GitCommit))),
            Effect.mapError(unavailable),
          ),
        ),
      resolve: (repository, ref) =>
        read(repository, (repo) =>
          // A commit is read as given; a branch resolves to its head.
          (Schema.is(objectId)(ref)
            ? attempt(() => repo.readCommit(ref)).pipe(
                Effect.map((commit) => (commit === null ? [] : [commit])),
              )
            : attempt(() => repo.log({ ref, limit: 1 }))
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(listedCommit))),
            Effect.map(([head]) =>
              head === undefined ? null : { commit: head.hash, tree: head.treeHash },
            ),
            Effect.mapError(unavailable),
          ),
        ),
      tree: (repository, root) =>
        read(repository, (repo) =>
          Effect.gen(function* () {
            const reads = yield* Semaphore.make(treeReads);
            // Siblings are read together; each level keeps its order, so the list is depth-first.
            const walk = (
              hash: string,
              prefix: string,
            ): Effect.Effect<
              ReadonlyArray<{ path: string; mode: string; type: string; object: string }>,
              SourceError
            > =>
              Effect.gen(function* () {
                const entries = yield* attempt(() => repo.readTree(hash)).pipe(
                  reads.withPermits(1),
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.NullOr(Schema.Array(treeEntry))),
                  ),
                  Effect.mapError(unavailable),
                );
                if (entries === null) return yield* unavailable();
                const listed = yield* Effect.forEach(
                  entries,
                  (entry) =>
                    entry.type === "tree"
                      ? walk(entry.hash, `${prefix}${entry.name}/`)
                      : Effect.succeed([
                          {
                            path: `${prefix}${entry.name}`,
                            mode: entry.mode,
                            type: entry.type,
                            object: entry.hash,
                          },
                        ]),
                  { concurrency: "unbounded" },
                );
                return listed.flat();
              });
            return yield* walk(
              yield* Schema.decodeUnknownEffect(objectId)(root).pipe(Effect.mapError(unavailable)),
              "",
            );
          }),
        ),
      blobs: (repository, objects, mode, budget) =>
        read(repository, (repo) =>
          Effect.gen(function* () {
            const ids = yield* Schema.decodeUnknownEffect(Schema.Array(objectId))(objects).pipe(
              Effect.mapError(unavailable),
            );
            // Bytes are kept while the running total of sizes stays within budget.
            let total = 0;
            return yield* Effect.forEach(
              ids,
              (object) =>
                attempt(async () => {
                  const blob = await repo.readBlob(object);
                  if (blob === null) return null;
                  total += blob.size;
                  if (mode === "sizes" || total > budget)
                    return { object, size: blob.size, bytes: null };
                  return {
                    object,
                    size: blob.size,
                    bytes: new Uint8Array(await blob.arrayBuffer()),
                  };
                }).pipe(
                  Effect.flatMap((entry) =>
                    entry === null ? Effect.fail(unavailable()) : Effect.succeed(entry),
                  ),
                ),
              { concurrency: blobReads },
            );
          }),
        ),
      file: (repository, commit, path) =>
        read(repository, (repo) =>
          Effect.gen(function* () {
            const ref = yield* Schema.decodeUnknownEffect(objectId)(commit);
            const name = yield* Schema.decodeUnknownEffect(SourceFilePath)(path);
            return yield* attempt(async () => {
              const blob = await repo.readFile({ ref, path: name });
              return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
            });
          }).pipe(Effect.mapError(unavailable)),
        ),
    } satisfies ArtifactsTokens;
  });

/** The product's app repositories on Artifacts, in the shape the self-host product consumes. */
export const artifactsRepositories = (
  settings: ArtifactsSourceSettings,
): Effect.Effect<RepositoryBackend, SourceError> =>
  artifactsTokens(settings).pipe(
    Effect.mapError(unavailable),
    Effect.map((tokens) =>
      cloudflareRepositories(tokens, {
        accountId: settings.accountId,
        namespace: settings.namespace,
      }),
    ),
  );
