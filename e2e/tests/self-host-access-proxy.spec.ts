/**
 * Self-host behind Cloudflare Access. Access signs in every caller, MCP clients through its own
 * OAuth, and passes each request a signed assertion naming the person. With the team and the
 * application's audience configured, an assertion that verifies against the team's published keys
 * is the caller's identity on `/mcp`; one for another application, one signed by a key the team
 * does not publish, and one naming someone outside the organization are not.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
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
          const initialize = (step: string, assertion?: string) =>
            browser.use(step, (page) =>
              page
                .context()
                .request.post(`${origin}/mcp`, {
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
        }),
      ),
    ),
  );
});
