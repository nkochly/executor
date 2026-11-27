import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

class AccountReconnectsHost extends Context.Service<
  AccountReconnectsHost,
  { readonly origin: string }
>()("e2e/AccountReconnectsHost") {}

const accountReconnectsHost = Layer.effect(
  AccountReconnectsHost,
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["apps/hosted/cloudflare/scripts/account-reconnects-host.ts"], {
        extendEnv: true,
      }),
    );
    const line = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((text) => text.startsWith("listening ")),
      Stream.runHead,
      Effect.timeout("60 seconds"),
    );
    if (line._tag === "None") return yield* Effect.die(new Error("account reconnects host exited"));
    return { origin: line.value.slice("listening ".length) };
  }),
).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));

const Reconnects = Schema.Array(
  Schema.Struct({
    account: Schema.String,
    label: Schema.String,
    owner: Schema.String,
    provider: Schema.String,
  }),
);

layer(accountReconnectsHost, { excludeTestServices: true })(
  "Cloudflare product accounts to reconnect",
  (it) => {
    it.effect(
      "lists only the accounts whose grant the service ended, with the provider's name",
      () =>
        Effect.gen(function* () {
          const { origin } = yield* AccountReconnectsHost;
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.execute(HttpClientRequest.get(`${origin}/`));
          const listed = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Reconnects)),
          );
          expect(listed).toEqual([
            {
              account: "acc_ended",
              label: "Default",
              owner: "organization:org_reconnects",
              provider: "Presidio West",
            },
          ]);
        }).pipe(Effect.orDie),
    );
  },
);
