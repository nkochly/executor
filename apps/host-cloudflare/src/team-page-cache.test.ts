import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { sharedTeamPages } from "./team-page-cache";
import type { TeamPage } from "./tenancy";

const page = (body: string): TeamPage => ({
  wiki: "acme/root",
  path: "how-we-work.md",
  starter: false,
  version: 1,
  body,
});

const memoryCache = () => {
  const entries = new Map<string, string>();
  return {
    entries,
    match: async (request: Request) => {
      const body = entries.get(request.url);
      return body === undefined ? undefined : new Response(body);
    },
    put: async (request: Request, response: Response) => {
      entries.set(request.url, await response.text());
    },
  };
};

const settle = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("sharedTeamPages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.effect("reads through without a cache", () =>
    Effect.gen(function* () {
      vi.stubGlobal("caches", undefined);
      expect(yield* sharedTeamPages("k", Effect.succeed([page("a")]))).toEqual([page("a")]);
    }),
  );

  it.effect(
    "serves the kept answer, refreshes it once past its window, drops it when too old",
    () =>
      Effect.gen(function* () {
        vi.stubGlobal("caches", { default: memoryCache() });
        const start = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(start);
        let loads = 0;
        const load = (body: string) =>
          Effect.sync(() => {
            loads += 1;
            return [page(body)];
          });

        expect(yield* sharedTeamPages("k", load("one"))).toEqual([page("one")]);
        expect(yield* sharedTeamPages("k", load("two"))).toEqual([page("one")]);
        expect(loads).toBe(1);

        now.mockReturnValue(start + 60_000);
        expect(yield* sharedTeamPages("k", load("three"))).toEqual([page("one")]);
        yield* settle();
        expect(loads).toBe(2);
        expect(yield* sharedTeamPages("k", load("four"))).toEqual([page("three")]);

        now.mockReturnValue(start + 60 * 60_000);
        expect(yield* sharedTeamPages("k", load("five"))).toEqual([page("five")]);
      }),
  );

  it.effect("never keeps an empty answer", () =>
    Effect.gen(function* () {
      const cache = memoryCache();
      vi.stubGlobal("caches", { default: cache });
      expect(yield* sharedTeamPages("k", Effect.succeed([]))).toEqual([]);
      expect(cache.entries.size).toBe(0);
    }),
  );
});
