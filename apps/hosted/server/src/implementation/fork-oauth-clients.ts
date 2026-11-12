/**
 * This fork's own operator OAuth clients, added to the reviewed ones in `first-party-oauth.ts`.
 * Each is turned on, like those, by its credentials: `EXECUTOR_OAUTH_<ID>_CLIENT_ID` and
 * `EXECUTOR_OAUTH_<ID>_CLIENT_SECRET`.
 *
 * - `webex` is the operator's Webex integration (developer.webex.com), registered once with this
 *   host's OAuth callback and the scopes below. Webex's MCP servers (`mcp.webexapis.com`) name
 *   `webexapis.com` as their authorization server, which neither registers clients nor reads a
 *   client metadata document, so without this client every person would have to create a Webex
 *   integration of their own. A Webex token acts as the person who signed in. Its tokens go only
 *   to Webex's MCP servers.
 */
import type { FirstPartyOAuthClientDefinition } from "./first-party-oauth.ts";

/**
 * Every scope Webex's hosted MCP servers for meetings (`/mcp/webex-meeting`) and messaging
 * (`/mcp/webex-messaging`) require, as their protected-resource metadata lists them, and
 * `spark:kms`, which Webex adds to every grant of an integration and may report granting.
 */
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
