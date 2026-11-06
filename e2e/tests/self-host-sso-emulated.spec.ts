/**
 * Self-host SSO against a hosted emulated OpenID provider (emulators.dev's Okta emulator), the
 * shape an operator gets from a managed identity front door such as Cloudflare Access for SaaS:
 * discovery at a fixed HTTPS URL, a confidential client, and a redirect back to
 * `/api/auth/callback/sso`. Admin emails the operator lists become organization admins at sign-in,
 * and a change to the list takes effect at each member's next SSO sign-in.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { BaseUrl, emulatorRequest } from "../support/emulators.ts";
import { startControlledSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const domain = "access.example.test";
const admin = `operator@${domain}`;
const member = `member@${domain}`;

const Session = Schema.NullOr(
  Schema.Struct({ user: Schema.Struct({ email: Schema.String, emailVerified: Schema.Boolean }) }),
);
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String }));
const Members = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({ role: Schema.String, user: Schema.Struct({ email: Schema.String }) }),
  ),
});
const Client = Schema.Struct({
  credential: Schema.Struct({
    client_id: Schema.NonEmptyString,
    client_secret: Schema.NonEmptyString,
  }),
});

/** One private provider instance with the operator and a member, and a client for `origin`. */
const emulatedProvider = (origin: string) =>
  Effect.gen(function* () {
    const { providerBaseUrl } = yield* emulatorRequest(
      "https://okta.emulators.dev",
      "/_emulate/instances",
      { instance: `executor-self-host-sso-${randomUUID()}` },
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ providerBaseUrl: BaseUrl }))));
    yield* Effect.addFinalizer(() =>
      emulatorRequest(providerBaseUrl, "/_emulate/reset", {}).pipe(Effect.ignore),
    );
    yield* emulatorRequest(providerBaseUrl, "/_emulate/seed", {
      users: [admin, member].map((email) => ({
        login: email,
        email,
        first_name: "Synthetic",
        last_name: email === admin ? "Operator" : "Member",
      })),
    });
    const client = yield* emulatorRequest(providerBaseUrl, "/_emulate/credentials", {
      type: "oauth-authorization-code",
      name: "Executor self-host SSO E2E",
      redirect_uris: [`${origin}/api/auth/callback/sso`],
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Client)));
    return {
      discoveryUrl: `${providerBaseUrl}/.well-known/openid-configuration`,
      clientId: client.credential.client_id,
      clientSecret: client.credential.client_secret,
    };
  });

const restartWithAdmins = (adminEmails: string) =>
  Effect.gen(function* () {
    yield* serverControl("stop");
    yield* serverControl("environment", 200, { SSO_ADMIN_EMAILS: adminEmails });
    yield* serverControl("start");
  });

/** Sign out, continue with SSO, pick `email` on the provider's page and land in the org. */
const signInAs = (origin: string, email: string, wait = true) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    // Better Auth allows three sign-in attempts per address in ten seconds, and one SSO sign-in
    // makes two (start and callback), so each after the first waits out the previous window.
    if (wait) yield* Effect.sleep("11 seconds");
    yield* browser.use(`${email}: sign out`, (page) => page.context().clearCookies());
    yield* browser.use(`${email}: open sign-in`, (page) => page.goto(`${origin}/login`));
    yield* browser.use(`${email}: continue with SSO`, (page) =>
      page.getByRole("button", { name: "Continue with SSO", exact: true }).click(),
    );
    yield* browser.use(`${email}: choose the identity at the provider`, (page) =>
      page.locator("form.user-form", { hasText: email }).getByRole("button").click(),
    );
    yield* browser.use(`${email}: opens the organization`, (page) =>
      page.waitForURL(`${origin}/org/*/**`),
    );
    const session = yield* browser
      .use(`${email}: read the session`, (page) =>
        page
          .context()
          .request.get(`${origin}/api/auth/get-session`)
          .then((response) => response.json()),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Session)));
    expect(session).toEqual({ user: expect.objectContaining({ email, emailVerified: true }) });
    const request = (path: string) =>
      browser.use(`${email}: GET ${path.split("?")[0]}`, (page) =>
        page
          .context()
          .request.get(`${origin}/api/auth${path}`)
          .then((response) => response.json()),
      );
    const [organization] = yield* request("/organization/list").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Organizations)),
    );
    if (organization === undefined) return yield* Effect.die(new Error("No organization"));
    const { members } = yield* request(
      `/organization/list-members?organizationId=${organization.id}&limit=100`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Members)));
    return members.find((entry) => entry.user.email === email)?.role;
  });

layer(TestLive, { excludeTestServices: true })("Self-host SSO with an emulated provider", (it) => {
  it.effect(
    scenarios.selfHostSsoEmulatedProviderAdmins.title,
    (context) =>
      withCase(
        context,
        Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* Browser,
              target = yield* Target;
            const instance = yield* startControlledSelfHost(target);
            const origin = instance.metadata.origin;
            const provider = yield* emulatedProvider(origin);
            // The browser reaches the provider's pages through the runner's own network stack, which
            // trusts the CAs the runner trusts, so a runner behind a TLS-terminating proxy works too.
            const providerOrigin = new URL(provider.discoveryUrl).origin;
            yield* browser.use("Reach the provider through the runner", (page) =>
              page.context().route(
                (url) => url.origin === providerOrigin,
                (route) =>
                  route.fetch({ maxRedirects: 0 }).then((response) => route.fulfill({ response })),
              ),
            );

            yield* Effect.gen(function* () {
              yield* serverControl("stop");
              yield* serverControl("environment", 200, {
                SSO_DISCOVERY_URL: provider.discoveryUrl,
                SSO_CLIENT_ID: provider.clientId,
                SSO_CLIENT_SECRET: provider.clientSecret,
                SSO_ALLOWED_DOMAINS: domain,
                SSO_ADMIN_EMAILS: admin,
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
                      email: `owner@${domain}`,
                      password: "Synthetic-e2e-password-2026",
                      organizationName: "Synthetic SSO",
                    },
                  })
                  .then((response) => response.status()),
              ),
            ).toBe(200);

            // Each person joins on first SSO sign-in; the listed operator joins as an admin.
            expect(yield* signInAs(origin, admin, false)).toBe("admin");
            yield* browser.checkpoint("Listed operator joined as an admin");
            expect(yield* signInAs(origin, member)).toBe("member");
            yield* browser.checkpoint("Unlisted person joined as a member");

            // The operator moves the admin role; it follows at each person's next sign-in.
            yield* restartWithAdmins(member).pipe(Effect.provideService(Target, instance));
            expect(yield* signInAs(origin, admin)).toBe("member");
            expect(yield* signInAs(origin, member)).toBe("admin");
            yield* browser.checkpoint("Admin role follows the operator's list");
          }),
        ),
      ),
    { timeout: 120_000 },
  );
});
