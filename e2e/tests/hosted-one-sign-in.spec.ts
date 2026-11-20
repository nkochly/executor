import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { body, Api, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { accountLinks, connectionsPath, linkAccount } from "../support/app-accounts.ts";
import { Access, who } from "../support/hosted-app-accounts.ts";
import { scenarios } from "../test-plan.ts";

const Failure = Schema.Struct({ _tag: Schema.String });

const source = (
  requirements: string,
) => `import { defineApp, defineProvider, secrets, query, object, string, router,
  type QueryContext } from "apps";
const service = defineProvider({ name: "One sign-in fixture", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const requirements = { user: { accounts: ${requirements} } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ({
  context: { auth: false, profile: false },
  account: "service" in ctx.user.accounts ? (ctx.user.accounts as { service: { id: string } }).service.id : "",
  extra: "extra" in ctx.user.accounts ? (ctx.user.accounts as { extra: { id: string }[] }).extra.map((a) => a.id) : [],
}));
export default defineApp(requirements, async () => ({ tools: router({ who }) }));`;

layer(HostedLive, { excludeTestServices: true })("Hosted one sign-in", (it) => {
  it.effect(scenarios.hostedOneSignIn.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const accounts: { actor: Session; id: string }[] = [];
        const paths: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const path of paths) yield* api.request(actors.owner, "DELETE", path);
            for (const item of accounts)
              yield* api.request(item.actor, "DELETE", `${prefix}/accounts/${item.id}`);
          }).pipe(Effect.orDie),
        );
        const deploy = (requirements: string, options: { readonly private?: boolean } = {}) =>
          Effect.gen(function* () {
            const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `One sign-in ${randomUUID().slice(0, 8)}`,
              files: [{ path: "index.ts", content: source(requirements) }, appsManifest],
            });
            expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
            const path = `${prefix}/apps/${(yield* body(App, deployed)).id}`;
            paths.push(path);
            if (!options.private) {
              const access = yield* body(
                Access,
                yield* api.request(actors.owner, "GET", `${path}/access`),
              );
              const shared = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
                revision: access.revision,
                audience: { kind: "everyone" },
              });
              expect(shared.status, JSON.stringify(shared.body)).toBe(200);
            }
            return path;
          });
        const connect = (actor: Session, path: string, label: string) =>
          Effect.gen(function* () {
            const started = yield* api.request(
              actor,
              "POST",
              connectionsPath(path, "user", "service"),
              { destination: { kind: "personal" } },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const connection = yield* body(Resource, started);
            const saved = yield* api.request(
              actor,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = yield* body(Resource, saved);
            accounts.push({ actor, id: account.id });
            return account.id;
          });
        const call = (actor: Session, path: string) =>
          api.request(actor, "POST", `${path}/tools/call`, {
            tool: "who",
            kind: "query",
            input: {},
          });

        const first = yield* deploy("{ service }");
        const second = yield* deploy("{ service }");
        const both = yield* deploy("{ service, extra: service.many() }");
        const manyOnly = yield* deploy("{ extra: service.many() }");
        const ownerOnly = yield* deploy("{ service }", { private: true });

        const kept = yield* connect(actors.admin, second, "Bob earlier");

        const alice = yield* connect(actors.member, first, "Alice");
        expect(yield* accountLinks(actors.member, first)).toEqual([["service", alice]]);
        expect(yield* accountLinks(actors.member, second)).toEqual([["service", alice]]);
        expect(yield* accountLinks(actors.member, both)).toEqual([
          ["extra", alice],
          ["service", alice],
        ]);
        expect(yield* accountLinks(actors.member, manyOnly)).toEqual([["extra", alice]]);
        expect((yield* who(yield* call(actors.member, second))).account).toBe(alice);
        expect((yield* who(yield* call(actors.member, both))).extra).toEqual([alice]);
        const access = yield* body(
          Access,
          yield* api.request(actors.owner, "GET", `${ownerOnly}/access`),
        );
        const opened = yield* api.request(actors.owner, "PATCH", `${ownerOnly}/access`, {
          revision: access.revision,
          audience: { kind: "everyone" },
        });
        expect(opened.status, JSON.stringify(opened.body)).toBe(200);
        expect(yield* accountLinks(actors.member, ownerOnly)).toEqual([]);

        expect(yield* accountLinks(actors.admin, both)).toEqual([
          ["extra", kept],
          ["service", kept],
        ]);
        const bob = yield* connect(actors.admin, first, "Bob");
        expect(yield* accountLinks(actors.admin, first)).toEqual([["service", bob]]);
        expect(yield* accountLinks(actors.admin, second)).toEqual([["service", kept]]);
        expect(yield* accountLinks(actors.admin, both)).toEqual([
          ["extra", kept],
          ["service", kept],
        ]);
        expect(yield* accountLinks(actors.admin, manyOnly)).toEqual([["extra", kept]]);
        expect((yield* who(yield* call(actors.admin, second))).account).toBe(kept);

        const ownerCall = yield* call(actors.owner, second);
        expect(ownerCall.status, JSON.stringify(ownerCall.body)).toBe(409);
        expect((yield* body(Failure, ownerCall))._tag).toBe("AccountRequired");

        yield* linkAccount(actors.member, second, "service", alice);
        expect(yield* accountLinks(actors.member, manyOnly)).toEqual([["extra", alice]]);
      }),
    ),
  );
});
