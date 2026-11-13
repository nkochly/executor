/**
 * Every request the product object serves runs as the client the Worker addressed it for: the
 * Worker sets `x-executor-client-ip` from the address Cloudflare's edge saw, and no other source of
 * a client address is read.
 */
import { Effect, Option } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";

/** `http`, served for the client the Worker addressed the request for. */
export const addressedRequest = <E, R>(
  http: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* http.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({
          remoteAddress: Option.fromUndefinedOr(request.headers["x-executor-client-ip"]),
        }),
      ),
    );
  });
