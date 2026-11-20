import type { FirstPartyOAuthClientDefinition } from "./first-party-oauth.ts";

const webexMcpScopes = [
  "spark:mcp",
  "spark:kms",
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
];

export const forkOAuthClientDefinitions: readonly FirstPartyOAuthClientDefinition[] = [
  {
    id: "webex",
    label: "Executor for Webex",
    server: {
      authorizationUrl: "https://webexapis.com/v1/authorize",
      tokenUrl: "https://webexapis.com/v1/access_token",
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: ["spark:mcp"],
    allowedScopes: webexMcpScopes,
    placement: { hosts: ["mcp.webexapis.com"] },
  },
];
