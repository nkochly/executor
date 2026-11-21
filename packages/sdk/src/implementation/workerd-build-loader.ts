import { Clock, Effect, Option, Semaphore } from "effect";
import { BlobStore, type BlobStorage } from "../contracts/blobs.ts";
import { RuntimeBuildUnavailable } from "../contracts/runtime.ts";
import type { BuildId } from "../contracts/shared.ts";
import type { LoadedWorkerBuild } from "../contracts/worker-build.ts";
import { loadWorkerBuild } from "./worker-build-storage.ts";

const sharedBuildBudget = { bytes: 32 * 1024 * 1024, entries: 64 };
const moduleOverhead = 256;
const readCheck = { min: 10, max: 200 };
const readTimeout = 10_000;

const textBytes = (text: string) => 2 * text.length;

const accountedBytes = (build: LoadedWorkerBuild) =>
  Object.entries(build.modules).reduce(
    (total, [name, module]) =>
      total +
      moduleOverhead +
      textBytes(name) +
      (typeof module === "string"
        ? textBytes(module)
        : "js" in module
          ? textBytes(module.js)
          : module.wasm.byteLength),
    textBytes(build.mainModule),
  );

type Flight = { readonly permit: Semaphore.Semaphore; callers: number };
type Entry = { readonly build: LoadedWorkerBuild; readonly bytes: number };

export const workerdBuildLoader = (blobs: BlobStorage) => {
  const memory = new Map<BuildId, Entry>();
  const flights = new Map<BuildId, Flight>();
  let accounted = 0;

  const recall = (build: BuildId) => {
    const entry = memory.get(build);
    if (entry === undefined) return undefined;
    memory.delete(build);
    memory.set(build, entry);
    return entry.build;
  };

  const remember = (build: BuildId, loaded: LoadedWorkerBuild) => {
    const bytes = accountedBytes(loaded);
    if (bytes > sharedBuildBudget.bytes || memory.has(build)) return;
    memory.set(build, { build: loaded, bytes });
    accounted += bytes;
    for (const [oldest, evicted] of memory) {
      if (accounted <= sharedBuildBudget.bytes && memory.size <= sharedBuildBudget.entries) break;
      memory.delete(oldest);
      accounted -= evicted.bytes;
    }
  };

  const read = (build: BuildId) =>
    loadWorkerBuild(build).pipe(
      Effect.provideService(BlobStore, blobs),
      Effect.map(({ mainModule, modules, protocol }): LoadedWorkerBuild => ({
        mainModule,
        modules,
        protocol,
      })),
    );

  return (build: BuildId): Effect.Effect<LoadedWorkerBuild, RuntimeBuildUnavailable> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const flight = flights.get(build) ?? { permit: Semaphore.makeUnsafe(1), callers: 0 };
        flight.callers += 1;
        flights.set(build, flight);
        return flight;
      }),
      (flight) =>
        Effect.gen(function* () {
          const since = yield* Clock.currentTimeMillis;
          const deadline = since + readTimeout;
          for (;;) {
            const owned = yield* flight.permit.withPermitsIfAvailable(1)(
              Effect.gen(function* () {
                const held = recall(build);
                if (held !== undefined) return held;
                const left = deadline - (yield* Clock.currentTimeMillis);
                if (left <= 0) return yield* new RuntimeBuildUnavailable();
                const loaded = yield* read(build).pipe(
                  Effect.timeoutOrElse({
                    duration: left,
                    orElse: () => Effect.fail(new RuntimeBuildUnavailable()),
                  }),
                );
                remember(build, loaded);
                return loaded;
              }),
            );
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
        }),
      (flight) =>
        Effect.sync(() => {
          flight.callers -= 1;
          if (flight.callers === 0) flights.delete(build);
        }),
    );
};
