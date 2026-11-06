/**
 * Connection bundles: admins give groups locked connections, decide whether members may make their
 * own, and oversee every member's connections. The switch changes what every member of the
 * organization may do, so the scenario turns it back on when it ends.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Evidence } from "../support/evidence.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { readWriteAppFiles } from "../support/mcp-connections.ts";

const SessionIdentity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
});
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const GroupsView = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, userId: Schema.String })),
});
const Bundle = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  name: Schema.String,
  apps: Schema.Array(Schema.Struct({ app: Schema.String })),
  groups: Schema.Array(Schema.String),
});
const BundlesView = Schema.Struct({
  bundles: Schema.Array(Bundle),
  membersCreateConnections: Schema.Boolean,
  canManage: Schema.Boolean,
  apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  groups: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const Connection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  policy: Schema.Struct({
    apps: Schema.Array(
      Schema.Struct({
        app: Schema.String,
        tools: Schema.Unknown,
        runsAs: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  }),
  bundle: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const Connections = Schema.Array(Connection);
const MemberConnections = Schema.Array(
  Schema.Struct({
    userId: Schema.String,
    role: Schema.String,
    connections: Connections,
  }),
);
const Tagged = Schema.Struct({ _tag: Schema.String });
const AppAccess = Schema.Struct({
  audience: Schema.Struct({
    kind: Schema.String,
    groups: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  canUse: Schema.Boolean,
});

layer(HostedLive, { excludeTestServices: true })("Connection bundles", (it) => {
  it.effect(scenarios.connectionBundles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const anonymous = yield* api.session();
        const suffix = randomUUID().slice(0, 8);
        const organization = actors.organization;
        const prefix = `/api/organizations/${organization.id}`;
        const keys: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const key of keys)
              yield* api.request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: key });
            yield* api.request(actors.owner, "PUT", `${prefix}/connection-settings`, {
              membersCreateConnections: true,
            });
          }).pipe(Effect.orDie),
        );
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.member, "GET", "/api/auth/get-session"),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Bundled ${suffix}`,
          files: readWriteAppFiles(randomUUID()),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const members = yield* body(
          GroupsView,
          yield* api.request(actors.owner, "GET", `${prefix}/groups`),
        );
        const membership = members.members.find((item) => item.userId === user.id);
        if (!membership) throw new Error("Expected the member in the bundle organization");
        const group = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/groups`, {
            name: `Sales ${suffix}`,
            description: "",
            memberIds: [membership.id],
          }),
        );
        const appAccess = (actor: typeof actors.owner) =>
          Effect.gen(function* () {
            const response = yield* api.request(actor, "GET", `${prefix}/apps/${app.id}/access`);
            return response.status === 200
              ? yield* body(AppAccess, response)
              : { audience: { kind: "none" }, canUse: false };
          });
        const memberConnections = Effect.gen(function* () {
          const response = yield* api.request(actors.member, "GET", `${prefix}/mcp-connections`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return yield* body(Connections, response);
        });

        const bundle = yield* evidence.step(
          "An admin's bundle shares its apps with its groups and becomes a locked connection for each member",
          Effect.gen(function* () {
            const refused = yield* api.request(
              actors.member,
              "POST",
              `${prefix}/connection-bundles`,
              {
                name: "Member bundle",
                apps: [],
                groups: [],
              },
            );
            expect(refused.status).toBe(403);
            const created = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connection-bundles`,
              {
                name: `Sales bundle ${suffix}`,
                apps: [{ app: app.id, tools: { kind: "readOnly" } }],
                groups: [group.id],
              },
            );
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const bundle = yield* body(Bundle, created);
            const view = yield* body(
              BundlesView,
              yield* api.request(actors.owner, "GET", `${prefix}/connection-bundles`),
            );
            expect(view.canManage).toBe(true);
            expect(view.apps.map((item) => item.id)).toContain(app.id);
            expect(view.groups.map((item) => item.id)).toContain(group.id);
            const duplicate = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connection-bundles`,
              { name: bundle.name.toUpperCase(), apps: [], groups: [] },
            );
            expect(duplicate.status).toBe(409);
            const foreign = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connection-bundles`,
              {
                name: `Foreign ${suffix}`,
                apps: [],
                groups: ["not-a-group"],
              },
            );
            expect(foreign.status).toBe(400);

            // Giving the bundle to the group shares its apps with the group.
            expect((yield* appAccess(actors.owner)).audience).toEqual({
              kind: "groups",
              groups: [group.id],
            });
            expect((yield* appAccess(actors.member)).canUse).toBe(true);
            const copies = (yield* memberConnections).filter(
              (item) => item.bundle?.id === bundle.id,
            );
            expect(copies).toHaveLength(1);
            const copy = copies[0]!;
            // Every member of the bundle's groups shares one URL, named for the bundle.
            expect(copy.url).toMatch(new RegExp(`/mcp\\?connection=sales-bundle-${suffix}$`, "u"));
            expect(copy.policy.apps).toEqual([
              expect.objectContaining({ app: app.id, tools: { kind: "readOnly" } }),
            ]);
            // Runs as whatever accounts the member links, never a fixed list.
            expect(copy.policy.apps[0]?.runsAs).toBeUndefined();
            const edited = yield* api.request(
              actors.member,
              "PUT",
              `${prefix}/mcp-connections/${copy.id}`,
              { name: "Mine now", apps: [] },
            );
            expect(edited.status).toBe(409);
            expect(yield* body(Tagged, edited)).toEqual({ _tag: "ConnectionManaged" });
            const revoked = yield* api.request(
              actors.member,
              "POST",
              `${prefix}/mcp-connections/${copy.id}/revoke`,
            );
            expect(revoked.status).toBe(409);
            return { bundle, copy };
          }),
        );

        yield* evidence.step(
          "With the switch off, members use only their bundles; admins are unaffected",
          Effect.gen(function* () {
            const off = yield* api.request(actors.owner, "PUT", `${prefix}/connection-settings`, {
              membersCreateConnections: false,
            });
            expect(off.status, JSON.stringify(off.body)).toBe(200);
            const view = yield* body(
              BundlesView,
              yield* api.request(actors.member, "GET", `${prefix}/connection-bundles`),
            );
            expect(view).toMatchObject({
              bundles: [],
              apps: [],
              groups: [],
              membersCreateConnections: false,
              canManage: false,
            });
            const own = yield* api.request(actors.member, "POST", `${prefix}/mcp-connections`, {
              id: randomUUID(),
              name: "My own",
              apps: [],
            });
            expect(own.status).toBe(403);
            expect(yield* body(Tagged, own)).toEqual({ _tag: "ConnectionsRestricted" });
            const settings = yield* api.request(
              actors.member,
              "PUT",
              `${prefix}/connection-settings`,
              { membersCreateConnections: true },
            );
            expect(settings.status).toBe(403);
            const ownerConnection = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/mcp-connections`,
              { id: randomUUID(), name: "Owner's own", apps: [] },
            );
            expect(ownerConnection.status, JSON.stringify(ownerConnection.body)).toBe(200);

            const key = yield* body(
              Token,
              yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
                name: "Bundles only",
              }),
            );
            keys.push(key.id);
            const refused = yield* api.request(anonymous, "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(key.key)}`,
              "x-executor-organization": organization.id,
            });
            expect(refused.status).toBe(403);
            expect(JSON.stringify(refused.body)).toContain("connection bundles");
          }),
        );

        yield* evidence.step(
          "Admins see every member's connections; a revoked copy returns while it is assigned",
          Effect.gen(function* () {
            const refused = yield* api.request(
              actors.member,
              "GET",
              `${prefix}/member-connections`,
            );
            expect(refused.status).toBe(403);
            const listed = yield* body(
              MemberConnections,
              yield* api.request(actors.owner, "GET", `${prefix}/member-connections`),
            );
            const entry = listed.find((item) => item.userId === user.id);
            expect(entry?.role).toBe("member");
            expect(entry?.connections.map((item) => item.id)).toContain(bundle.copy.id);
            const revoked = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/member-connections/${user.id}/connections/${bundle.copy.id}/revoke`,
            );
            expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
            const again = (yield* memberConnections).filter(
              (item) => item.bundle?.id === bundle.bundle.id,
            );
            expect(again).toHaveLength(1);
            expect(again[0]?.id).not.toBe(bundle.copy.id);
          }),
        );

        yield* evidence.step(
          "Deleting a bundle revokes every copy of it and the app shares it made",
          Effect.gen(function* () {
            const stale = yield* api.request(
              actors.owner,
              "DELETE",
              `${prefix}/connection-bundles/${bundle.bundle.id}`,
              { revision: "stale" },
            );
            expect(stale.status).toBe(409);
            const removed = yield* api.request(
              actors.owner,
              "DELETE",
              `${prefix}/connection-bundles/${bundle.bundle.id}`,
              { revision: bundle.bundle.revision },
            );
            expect(removed.status, JSON.stringify(removed.body)).toBe(200);
            expect(
              (yield* memberConnections).filter((item) => item.bundle !== undefined),
            ).toHaveLength(0);
            // The share the bundle made goes with it.
            expect((yield* appAccess(actors.member)).canUse).toBe(false);
          }),
        );
      }),
    ),
  );
});
