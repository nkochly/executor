/**
 * Self-host behind Cloudflare Access. Access signs in every caller, MCP clients through its own
 * OAuth, and passes each request a signed assertion naming the person. With the team and the
 * application's audience configured, an assertion that verifies against the team's published keys
 * is the caller's identity on `/mcp` and on the caller's own scoped connection URLs; one for another
 * application, one signed by a key the team does not publish, one naming someone outside the
 * organization, and a connection the caller does not own are not. A bundle's URL names the bundle,
 * and reaches the caller's own copy of it only while the caller is in one of its groups.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startControlledSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { selfHostSsoIdp } from "../support/sso.ts";
import { scenarios } from "../test-plan.ts";

const audience = "synthetic-access-application";
const owner = "owner@access.example.test";

layer(TestLive, { excludeTestServices: true })("Self-host behind Cloudflare Access", (it) => {
  it.effect(scenarios.selfHostAccessProxyMcp.title, (context) =>
    withCase(
      context,
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* Browser,
            target = yield* Target;
          const instance = yield* startControlledSelfHost(target);
          const origin = instance.metadata.origin;
          // The synthetic IdP stands in for the Access team: it publishes the team's keys at
          // `/cdn-cgi/access/certs` over HTTPS and signs assertions with them.
          const team = yield* selfHostSsoIdp(origin);
          yield* Effect.gen(function* () {
            yield* serverControl("stop");
            yield* serverControl("environment", 200, {
              EXECUTOR_ACCESS_TEAM_DOMAIN: new URL(team.issuer).host,
              EXECUTOR_ACCESS_AUD: audience,
              // The product trusts only the fixture's synthetic certificate.
              NODE_EXTRA_CA_CERTS: team.certificate,
            });
            yield* serverControl("start");
          }).pipe(Effect.provideService(Target, instance));
          expect(
            yield* browser.use("Set up the instance", (page) =>
              page
                .context()
                .request.post(`${origin}/api/auth/self-host/setup`, {
                  headers: { origin },
                  data: {
                    name: "Synthetic Owner",
                    email: owner,
                    password: "Synthetic-e2e-password-2026",
                    organizationName: "Synthetic Access",
                  },
                })
                .then((response) => response.status()),
            ),
          ).toBe(200);

          /** Initialize an MCP session carrying `assertion`, the way Access forwards a request. */
          const initialize = (step: string, assertion?: string, path = "/mcp") =>
            browser.use(step, (page) =>
              page
                .context()
                .request.post(`${origin}${path}`, {
                  headers: {
                    accept: "application/json, text/event-stream",
                    "content-type": "application/json",
                    ...(assertion === undefined ? {} : { "cf-access-jwt-assertion": assertion }),
                  },
                  data: {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                      protocolVersion: "2025-06-18",
                      capabilities: {},
                      clientInfo: { name: "access-proxy-e2e", version: "1.0.0" },
                    },
                  },
                })
                .then((response) => response.status()),
            );

          expect(yield* initialize("No assertion and no credential")).toBe(401);
          expect(
            yield* initialize(
              "The owner, signed in by Access",
              yield* team.accessAssertion(owner, audience),
            ),
          ).toBe(200);
          expect(
            yield* initialize(
              "An assertion for another Access application",
              yield* team.accessAssertion(owner, "another-access-application"),
            ),
          ).toBe(401);
          expect(
            yield* initialize(
              "An assertion signed by a key the team does not publish",
              yield* team.accessAssertion(owner, audience, true),
            ),
          ).toBe(401);
          expect(
            yield* initialize(
              "Someone Access signed in who is not a member",
              yield* team.accessAssertion("stranger@access.example.test", audience),
            ),
          ).toBe(403);

          // A scoped connection's URL works through Access too, as that connection's caller.
          const connection = randomUUID();
          const [organization] = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ id: Schema.String })),
          )(
            yield* browser.use("List the owner's organizations", (page) =>
              page
                .context()
                .request.get(`${origin}/api/auth/organization/list`, { headers: { origin } })
                .then((response) => response.json()),
            ),
          );
          expect(
            yield* browser.use("Create a scoped connection", (page) =>
              page
                .context()
                .request.post(`${origin}/api/organizations/${organization?.id}/mcp-connections`, {
                  headers: { origin },
                  data: { id: connection, name: "Through Access", apps: [] },
                })
                .then((response) => response.status()),
            ),
          ).toBe(200);
          expect(
            yield* initialize(
              "The owner's scoped connection, signed in by Access",
              yield* team.accessAssertion(owner, audience),
              `/mcp?connection=${connection}`,
            ),
          ).toBe(200);
          expect(
            yield* initialize(
              "A connection the owner does not have",
              yield* team.accessAssertion(owner, audience),
              `/mcp?connection=${randomUUID()}`,
            ),
          ).toBe(401);

          // A bundle's URL names the bundle; each member of its groups reaches their own copy.
          const prefix = `${origin}/api/organizations/${organization?.id}`;
          const post = (step: string, path: string, data: unknown) =>
            browser.use(step, (page) =>
              page
                .context()
                .request.post(`${prefix}${path}`, { headers: { origin }, data })
                .then((response) =>
                  response.json().then((body: unknown) => ({ status: response.status(), body })),
                ),
            );
          const { members } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              members: Schema.Array(Schema.Struct({ id: Schema.String })),
            }),
          )(
            yield* browser.use("List the organization's members", (page) =>
              page
                .context()
                .request.get(`${prefix}/groups`, { headers: { origin } })
                .then((response) => response.json()),
            ),
          );
          const group = yield* post("Make a group with the owner", "/groups", {
            name: "Sales",
            description: "",
            memberIds: members.map((member) => member.id),
          });
          expect(group.status).toBe(200);
          const { id: groupId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ id: Schema.String }),
          )(group.body);
          expect(
            (yield* post("Give the group a bundle", "/connection-bundles", {
              name: "Sales Team",
              apps: [],
              groups: [groupId],
            })).status,
          ).toBe(200);
          expect(
            (yield* post("A bundle no group holds", "/connection-bundles", {
              name: "Unassigned",
              apps: [],
              groups: [],
            })).status,
          ).toBe(200);
          expect(
            (yield* post("A name with the same URL as another bundle", "/connection-bundles", {
              name: "sales-team",
              apps: [],
              groups: [],
            })).status,
          ).toBe(409);
          expect(
            (yield* post("A name that makes no URL", "/connection-bundles", {
              name: "!!!",
              apps: [],
              groups: [],
            })).status,
          ).toBe(400);
          expect(
            yield* initialize(
              "The owner's bundle by its name, signed in by Access",
              yield* team.accessAssertion(owner, audience),
              "/mcp?connection=sales-team",
            ),
          ).toBe(200);
          expect(
            yield* initialize(
              "A bundle the owner holds no copy of",
              yield* team.accessAssertion(owner, audience),
              "/mcp?connection=unassigned",
            ),
          ).toBe(401);
        }),
      ),
    ),
  );
});
