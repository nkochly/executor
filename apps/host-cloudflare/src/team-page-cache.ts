import { Effect, Option, Schema } from "effect";

import type { TeamPage } from "./tenancy";

// Every new MCP session puts the caller's team pages in its instructions and
// waits for them before `initialize` answers: two wiki round trips, most of a
// second. Sessions start on fresh isolates, so an isolate's own memory rarely
// has them. The data center's cache does: the last good answer for this caller
// is served at once and, once it is past its window, a fresh read replaces it
// in the background. Team pages shape a session's instructions, never what it
// may do; an answer older than the stale limit is not served.
const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;
const CACHE_ORIGIN = "https://team-pages.executor.internal";

const Cached = Schema.Struct({
  at: Schema.Number,
  pages: Schema.Array(
    Schema.Struct({
      wiki: Schema.String,
      path: Schema.String,
      starter: Schema.Boolean,
      version: Schema.Number,
      body: Schema.String,
    }),
  ),
});
const decodeCached = Schema.decodeUnknownOption(Schema.fromJsonString(Cached));
const encodeCached = Schema.encodeSync(Schema.fromJsonString(Cached));

// A background refresh runs on the request that started it and can be cut off
// with it; one not settled in this long is taken as lost.
const REFRESH_LOST_MS = 15_000;
const refreshing = new Map<string, number>();

/** `caches.default` is a Workers extension the standard lib type omits. */
type WorkersCacheStorage = CacheStorage & { readonly default?: Cache };

const cacheStore = (): Cache | null =>
  typeof caches === "undefined" ? null : ((caches as WorkersCacheStorage).default ?? null);

const keyRequest = (key: string) =>
  new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`, { method: "GET" });

const store = (cache: Cache, key: string, pages: readonly TeamPage[]) =>
  pages.length === 0
    ? Effect.void
    : Effect.tryPromise(() =>
        cache.put(
          keyRequest(key),
          new Response(encodeCached({ at: Date.now(), pages }), {
            headers: {
              "content-type": "application/json",
              "cache-control": `max-age=${STALE_MS / 1000}`,
            },
          }),
        ),
      ).pipe(Effect.ignore);

/**
 * `load`'s answer for `key`, through the data center's cache. A read that
 * finds nothing (no pages, or the wiki unreachable) is never kept.
 */
export const sharedTeamPages = (
  key: string,
  load: Effect.Effect<readonly TeamPage[]>,
): Effect.Effect<readonly TeamPage[]> => {
  const cache = cacheStore();
  if (cache === null) return load;
  return Effect.gen(function* () {
    const hit = yield* Effect.tryPromise(() => cache.match(keyRequest(key))).pipe(
      Effect.flatMap((response) =>
        response ? Effect.tryPromise(() => response.text()) : Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );
    const cached = hit === null ? Option.none() : decodeCached(hit);
    const age = Option.isSome(cached) ? Date.now() - cached.value.at : Infinity;
    if (Option.isSome(cached) && age < STALE_MS) {
      const since = refreshing.get(key);
      if (age >= FRESH_MS && (since === undefined || Date.now() - since > REFRESH_LOST_MS)) {
        refreshing.set(key, Date.now());
        void Effect.runPromise(
          load.pipe(
            Effect.flatMap((pages) => store(cache, key, pages)),
            Effect.ensuring(Effect.sync(() => refreshing.delete(key))),
          ),
        );
      }
      return cached.value.pages;
    }
    const pages = yield* load;
    yield* store(cache, key, pages);
    return pages;
  });
};
