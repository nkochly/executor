import { Effect, Option } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";

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
