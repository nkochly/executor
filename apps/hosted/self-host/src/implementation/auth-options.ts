/** Self-host credentials and optional operator-owned OpenID Connect configuration. */
import { authOptions, authSettings, singleResourceOrigin } from "@executor-js/hosted-server";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { organization } from "better-auth/plugins/organization";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

const httpsUrl = (message: string) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      },
      { message },
    ),
  );

const Sso = Schema.Struct({
  discoveryUrl: httpsUrl("SSO discovery must use HTTPS"),
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.Redacted(Schema.NonEmptyString),
  allowedDomains: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  adminEmails: Schema.Array(Schema.NonEmptyString),
  providerVerifiesEmail: Schema.Boolean,
  /** Sign-in goes straight to the provider instead of offering the password form beside it. */
  direct: Schema.Boolean,
});

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** SSO stays disabled unless explicitly configured; partial configuration fails startup. */
export const selfHostAuthSettings = Effect.gen(function* () {
  const settings = yield* authSettings;
  // Self-host serves its MCP and API resources and its issuer on its single browser origin.
  const base = {
    ...settings,
    resourceOrigins: singleResourceOrigin(settings.url),
    issuer: `${settings.url}/api/auth`,
  };
  const discovery = yield* Config.String("SSO_DISCOVERY_URL").pipe(Config.option);
  if (Option.isNone(discovery) || discovery.value === "") return { ...base, sso: null };
  const configured = yield* Config.all({
    clientId: Config.String("SSO_CLIENT_ID"),
    clientSecret: Config.Redacted("SSO_CLIENT_SECRET"),
    domains: Config.String("SSO_ALLOWED_DOMAINS"),
    admins: Config.String("SSO_ADMIN_EMAILS").pipe(Config.withDefault("")),
    providerVerifiesEmail: Config.Boolean("SSO_PROVIDER_VERIFIES_EMAIL").pipe(
      Config.withDefault(false),
    ),
    direct: Config.Boolean("SSO_DIRECT").pipe(Config.withDefault(false)),
  });
  const sso = yield* Schema.decodeUnknownEffect(Sso)({
    ...configured,
    discoveryUrl: discovery.value,
    allowedDomains: list(configured.domains),
    adminEmails: list(configured.admins),
  });
  return { ...base, sso };
});

const endpoint = httpsUrl("Every endpoint must be an absolute HTTPS URL");
/**
 * The provider metadata SSO signs in with. Sign-in, token exchange, signing keys, UserInfo and
 * logout all use HTTPS, so each is confidential and authenticated in transit.
 */
const SsoDiscovery = Schema.Struct({
  issuer: endpoint,
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  jwks_uri: endpoint,
  userinfo_endpoint: Schema.optionalKey(endpoint),
  end_session_endpoint: Schema.optionalKey(endpoint),
  id_token_signing_alg_values_supported: Schema.NonEmptyArray(Schema.NonEmptyString),
});

class SsoDiscoveryUnusable extends Schema.TaggedError<SsoDiscoveryUnusable>()(
  "SsoDiscoveryUnusable",
  { reason: Schema.String },
) {}

/**
 * Read the provider's discovery document once at startup, from exactly the configured URL,
 * and refuse a redirect: the metadata, including where signing keys come from, is then always
 * the configured HTTPS origin's. An unusable document leaves SSO unavailable until restart,
 * as an unreachable provider does; other sign-in keeps working.
 */
export const selfHostSsoDiscovery = (settings: Effect.Success<typeof selfHostAuthSettings>) => {
  if (settings.sso === null) return Effect.succeed(null);
  const { discoveryUrl } = settings.sso;
  return Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterOrFail(
        (response) => response.status < 300 || response.status >= 400,
        (response) =>
          new SsoDiscoveryUnusable({
            reason: `It redirected (HTTP ${response.status}). SSO does not follow redirects; set SSO_DISCOVERY_URL to the final HTTPS URL.`,
          }),
      ),
      HttpClient.filterStatusOk,
    );
    return yield* http
      .get(discoveryUrl)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(SsoDiscovery)));
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.provide(FetchHttpClient.layer),
    // Return a redirect to the filter above, which refuses it.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.catchTag(["HttpClientError", "SchemaError", "TimeoutError"], (error) =>
      Effect.fail(new SsoDiscoveryUnusable({ reason: error.message })),
    ),
    Effect.catchTag("SsoDiscoveryUnusable", (error) =>
      Effect.logError(
        `SSO is unavailable: discovery at ${discoveryUrl} is not usable. Fix it and restart.`,
        error.reason,
      ).pipe(Effect.as(null)),
    ),
  );
};

/**
 * Whether the provider vouched for the address. An explicit claim always decides, whatever its
 * spelling. Only an operator who has set `SSO_PROVIDER_VERIFIES_EMAIL` for a provider that admits
 * nobody without a verified address (Cloudflare Access sends no `email_verified`) makes an
 * absent claim a yes; otherwise absence stays a no.
 */
export const ssoEmailVerified = (claim: unknown, providerVerifiesEmail: boolean) => {
  if (claim === true || claim === "true") return true;
  if (claim === undefined || claim === null) return providerVerifiesEmail;
  return false;
};

/** Public registration is handled by the atomic setup/invitation endpoints. */
export const selfHostAuthOptions = (
  settings: Effect.Success<typeof selfHostAuthSettings>,
  ipAddressHeaders: string[],
  discovery: typeof SsoDiscovery.Type | null,
) => {
  const base = authOptions(settings, ipAddressHeaders);
  return {
    ...base,
    emailAndPassword: { enabled: true, disableSignUp: true },
    plugins: [
      organization({ disableOrganizationDeletion: true, allowUserToCreateOrganization: false }),
      ...base.plugins,
      genericOAuth({
        config:
          settings.sso === null || discovery === null
            ? []
            : [
                {
                  providerId: "sso",
                  name: "Single sign-on",
                  // The validated document only: without a URL, Better Auth never fetches
                  // discovery itself.
                  discoveryDocument: discovery,
                  clientId: settings.sso.clientId,
                  clientSecret: Redacted.value(settings.sso.clientSecret),
                  requireIdTokenVerification: true,
                  scopes: ["openid", "email", "profile"],
                  mapProfileToUser: (profile: Record<string, unknown>) => ({
                    emailVerified: ssoEmailVerified(
                      profile.email_verified,
                      settings.sso?.providerVerifiesEmail ?? false,
                    ),
                  }),
                },
              ],
      }),
    ],
  };
};
