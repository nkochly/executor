import { Clock, Effect, Option, Semaphore } from "effect";
import { BlobStore, type BlobStorage } from "../contracts/blobs.ts";
import { RuntimeBuildUnavailable } from "../contracts/runtime.ts";
import type { BuildId } from "../contracts/shared.ts";
import type {
  FrameworkIdentity,
  LoadedWorkerBuild,
  RetainedFramework,
  StoredWorkerBuild,
} from "../contracts/worker-build.ts";
import {
  linkWorkerBuild,
  loadStoredWorkerBuild,
  loadWorkerFramework,
} from "./worker-build-storage.ts";

const sharedBuildBudget = { bytes: 32 * 1024 * 1024, entries: 64 };
const concurrentReads = 4;
const moduleOverhead = 256;
const entryOverhead = 1024;
const readCheck = { min: 10, max: 200 };
const readTimeout = 10_000;

const textBytes = (...texts: ReadonlyArray<string>) =>
  texts.reduce((total, text) => total + 2 * text.length, 0);

const modulesBytes = (modules: StoredWorkerBuild["modules"]) =>
  Object.entries(modules).reduce(
    (total, [name, module]) =>
      total +
      moduleOverhead +
      textBytes(name) +
      (typeof module === "string"
        ? textBytes(module)
        : "js" in module
          ? textBytes(module.js)
          : module.wasm.byteLength),
    entryOverhead,
  );

type ExecutableBuild =
  | Pick<
      Extract<StoredWorkerBuild, { format: 1 }>,
      "format" | "mainModule" | "modules" | "database" | "protocol"
    >
  | Pick<
      Extract<StoredWorkerBuild, { format: 2 }>,
      "format" | "mainModule" | "modules" | "framework" | "database" | "protocol"
    >;

const executable = (stored: StoredWorkerBuild): ExecutableBuild =>
  stored.format === 1
    ? {
        format: 1,
        mainModule: stored.mainModule,
        modules: stored.modules,
        database: stored.database,
        protocol: stored.protocol,
      }
    : {
        format: 2,
        mainModule: stored.mainModule,
        modules: stored.modules,
        framework: stored.framework,
        database: stored.database,
        protocol: stored.protocol,
      };

type Entry =
  | { readonly record: ExecutableBuild; readonly bytes: number }
  | { readonly framework: RetainedFramework; readonly bytes: number };

type Part<A> = {
  readonly value: (entry: Entry) => A | undefined;
  readonly entry: (value: A) => Entry;
};

const recordPart: Part<ExecutableBuild> = {
  value: (entry) => ("record" in entry ? entry.record : undefined),
  entry: (record) => ({
    record,
    bytes:
      modulesBytes(record.modules) +
      textBytes(record.mainModule) +
      (record.format === 2 ? textBytes(record.framework.version, record.framework.sha256) : 0),
  }),
};

const frameworkPart: Part<RetainedFramework> = {
  value: (entry) => ("framework" in entry ? entry.framework : undefined),
  entry: (framework) => ({
    framework,
    bytes: modulesBytes(framework.modules) + textBytes(framework.version, framework.sha256),
  }),
};

const recordKey = (build: BuildId) => `build:${build}`;
const frameworkKey = (identity: FrameworkIdentity) => `framework:${identity.sha256}`;

type Flight = { readonly permit: Semaphore.Semaphore; callers: number };

const holding = <A, E, R>(
  permit: Semaphore.Semaphore,
  since: number,
  deadline: number,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RuntimeBuildUnavailable, R> =>
  Effect.gen(function* () {
    for (;;) {
      const owned = yield* permit.withPermitsIfAvailable(1)(use);
      if (Option.isSome(owned)) return owned.value;
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) return yield* new RuntimeBuildUnavailable();
      yield* Effect.sleep(
        Math.min(
          deadline - now,
          Math.max(readCheck.min, Math.min(readCheck.max, (now - since) / 4)),
        ),
      );
    }
  });

export const workerdBuildLoader = (blobs: BlobStorage) => {
  const memory = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  const reads = Semaphore.makeUnsafe(concurrentReads);
  let accounted = 0;

  const recall = (key: string) => {
    const entry = memory.get(key);
    if (entry === undefined) return undefined;
    memory.delete(key);
    memory.set(key, entry);
    return entry;
  };

  const remember = (key: string, entry: Entry) => {
    if (entry.bytes > sharedBuildBudget.bytes || memory.has(key)) return;
    memory.set(key, entry);
    accounted += entry.bytes;
    for (const [oldest, evicted] of memory) {
      if (accounted <= sharedBuildBudget.bytes && memory.size <= sharedBuildBudget.entries) break;
      memory.delete(oldest);
      accounted -= evicted.bytes;
    }
  };

  const readOnce = <A>(
    key: string,
    part: Part<A>,
    read: Effect.Effect<A, RuntimeBuildUnavailable, BlobStore>,
    deadline: number,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const flight = flights.get(key) ?? { permit: Semaphore.makeUnsafe(1), callers: 0 };
        flight.callers += 1;
        flights.set(key, flight);
        return flight;
      }),
      (flight) =>
        Effect.gen(function* () {
          const since = yield* Clock.currentTimeMillis;
          return yield* holding(
            flight.permit,
            since,
            deadline,
            Effect.gen(function* () {
              const memorized = recall(key);
              const held = memorized === undefined ? undefined : part.value(memorized);
              if (held !== undefined) return held;
              const value = yield* holding(
                reads,
                yield* Clock.currentTimeMillis,
                deadline,
                Effect.gen(function* () {
                  const left = deadline - (yield* Clock.currentTimeMillis);
                  if (left <= 0) return yield* new RuntimeBuildUnavailable();
                  return yield* read.pipe(
                    Effect.provideService(BlobStore, blobs),
                    Effect.timeoutOrElse({
                      duration: left,
                      orElse: () => Effect.fail(new RuntimeBuildUnavailable()),
                    }),
                  );
                }),
              );
              remember(key, part.entry(value));
              return value;
            }),
          );
        }),
      (flight) =>
        Effect.sync(() => {
          flight.callers -= 1;
          if (flight.callers === 0) flights.delete(key);
        }),
    );

  return (build: BuildId): Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable> =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + readTimeout;
      const record = yield* readOnce(
        recordKey(build),
        recordPart,
        loadStoredWorkerBuild(build).pipe(Effect.map(executable)),
        deadline,
      );
      return yield* linkWorkerBuild(record, (identity) =>
        readOnce(frameworkKey(identity), frameworkPart, loadWorkerFramework(identity), deadline),
      );
    });
};
