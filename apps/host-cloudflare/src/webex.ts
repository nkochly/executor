import { Effect } from "effect";

import { IntegrationSlug, type FirstPartyOAuthClientConfig } from "@executor-js/sdk";

import type { CloudflareConfig, SecretBinding } from "./config";

// ---------------------------------------------------------------------------
// Cisco's hosted Webex MCP servers, offered through the company's own Webex
// integration. Webex publishes OAuth metadata but no registration endpoint, so
// a connect uses this host-declared app (`first-party:webex`) instead of
// dynamic client registration. Each server's scopes are discovered from its
// protected-resource metadata at connect; the app may request only the union
// below, which is what the integration on developer.webex.com is registered
// with.
//
// A Webex token acts as the person who signed in, and the servers take no
// other kind, so Webex connections are personal only: a workspace connection
// would let every member read and send as whoever authorized it.
// ---------------------------------------------------------------------------

export const WEBEX_MCP_ORIGIN = "https://mcp.webexapis.com";

export const WEBEX_SERVERS = [
  {
    slug: "webex-meetings",
    name: "Webex Meetings",
    summary:
      "Webex meetings, AI summaries, action items, recordings and transcripts, as the person who connects. For calendar questions prefer Outlook.",
    endpoint: `${WEBEX_MCP_ORIGIN}/mcp/webex-meeting`,
  },
  {
    slug: "webex-messaging",
    name: "Webex Messaging",
    summary:
      "Webex messages, spaces and memberships, as the person who connects. For Teams chats use the Microsoft tools.",
    endpoint: `${WEBEX_MCP_ORIGIN}/mcp/webex-messaging`,
  },
] as const;

/** Every scope the Meetings and Messaging servers require. */
export const WEBEX_SCOPES = [
  "spark:mcp",
  "meeting:schedules_read",
  "meeting:schedules_write",
  "meeting:participants_read",
  "meeting:summaries_read",
  "meeting:recordings_read",
  "meeting:transcripts_read",
  "spark:messages_read",
  "spark:messages_write",
  "spark:rooms_read",
  "spark:rooms_write",
  "spark:memberships_read",
  "spark:memberships_write",
  "spark:webhooks_read",
  "spark:webhooks_write",
] as const;

const PLACEHOLDER = "placeholder";

/** The value, or "" while it is unset, the store's placeholder or unreadable. */
const readSecret = (secret: string | SecretBinding): Promise<string> =>
  Effect.runPromise(
    (typeof secret === "string"
      ? Effect.succeed(secret)
      : Effect.tryPromise({ try: () => secret.get(), catch: () => "unreadable" as const })
    ).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((value) => value.trim()),
      Effect.map((value) => (value === PLACEHOLDER ? "" : value)),
    ),
  );

/** The Webex app as a first-party OAuth client, or none while either value is unset. */
export const webexOAuthClients = async (
  config: CloudflareConfig,
): Promise<readonly FirstPartyOAuthClientConfig[]> => {
  if (!config.webex) return [];
  const [clientId, clientSecret] = await Promise.all([
    readSecret(config.webex.clientId),
    readSecret(config.webex.clientSecret),
  ]);
  if (!clientId || !clientSecret) return [];
  return [
    {
      name: "webex",
      authorizationUrl: "https://webexapis.com/v1/authorize",
      tokenUrl: "https://webexapis.com/v1/access_token",
      clientId,
      clientSecret,
      allowedScopes: WEBEX_SCOPES,
      // The console names an integration added from a catalog card after its
      // slug, so the picker offers this app for them by name as well as by host.
      integrations: WEBEX_SERVERS.map((server) =>
        IntegrationSlug.make(server.slug.replaceAll("-", "_")),
      ),
    },
  ];
};
