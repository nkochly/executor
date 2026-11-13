/**
 * A product object that serves one event stream the way the product serves a live app query, for
 * `scripts/live-stream-host.ts`. While the stream runs it counts runs, as a live query re-runs its
 * query, so the host can see whether the stream still runs after its client went away. The Worker
 * forwards to the object as the product's Worker does.
 */
import { DurableObject } from "cloudflare:workers";
import { Effect, Schedule, Stream } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { addressedRequest } from "../src/product-request.ts";

interface Environment {
  readonly PRODUCT: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

export class Product extends DurableObject<Environment> {
  #runs = 0;
  // A live query holds a subscription that re-runs its query on its own schedule, whether or not
  // anyone reads the stream; only the stream's end releases it.
  readonly #live = HttpEffect.toWebHandler(
    addressedRequest(
      Effect.sync(() =>
        HttpServerResponse.stream(
          Stream.unwrap(
            Effect.forkScoped(
              Effect.sync(() => {
                this.#runs++;
              }).pipe(Effect.repeat(Schedule.spaced("100 millis"))),
            ).pipe(
              Effect.as(
                Stream.tick("1 second").pipe(
                  Stream.map(() => `data: ${this.#runs}\n\n`),
                  Stream.encodeText,
                ),
              ),
            ),
          ),
          { contentType: "text/event-stream" },
        ),
      ),
    ),
  );
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/runs") return Response.json(this.#runs);
    return this.#live(request);
  }
}

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    return env.PRODUCT.getByName("product").fetch(new Request(request));
  },
};
