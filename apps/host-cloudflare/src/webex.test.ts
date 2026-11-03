import { describe, expect, it } from "@effect/vitest";

import type { CloudflareConfig } from "./config";
import { WEBEX_SCOPES, webexOAuthClients } from "./webex";

const withWebex = (webex: CloudflareConfig["webex"]): CloudflareConfig => ({
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: [],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  enableDevAuth: true,
  directory: null,
  operatorDirectory: null,
  agentSignIn: false,
  firstParty: [],
  webex,
});

// A Secrets Store binding whose read fails.
const unreadable = (): Promise<string> =>
  // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- test boundary: a platform binding that rejects
  Promise.reject(new Error("store unavailable"));

describe("Webex integration", () => {
  it("declares the Webex app with the secret read from the store", async () => {
    const clients = await webexOAuthClients(
      withWebex({
        clientId: { get: async () => "cid" },
        clientSecret: { get: async () => " shh " },
      }),
    );
    expect(clients).toEqual([
      {
        name: "webex",
        authorizationUrl: "https://webexapis.com/v1/authorize",
        tokenUrl: "https://webexapis.com/v1/access_token",
        clientId: "cid",
        clientSecret: "shh",
        allowedScopes: WEBEX_SCOPES,
        integrations: ["webex_meetings", "webex_messaging"],
      },
    ]);
  });

  it("declares nothing while the secret is unset, a placeholder or unreadable", async () => {
    expect(await webexOAuthClients(withWebex(null))).toEqual([]);
    expect(
      await webexOAuthClients(withWebex({ clientId: "cid", clientSecret: "placeholder" })),
    ).toEqual([]);
    expect(
      await webexOAuthClients(withWebex({ clientId: "placeholder", clientSecret: "shh" })),
    ).toEqual([]);
    expect(
      await webexOAuthClients(withWebex({ clientId: "cid", clientSecret: { get: unreadable } })),
    ).toEqual([]);
  });

  it("asks for exactly the scopes the Meetings and Messaging servers require", () => {
    // From https://mcp.webexapis.com/.well-known/oauth-protected-resource/mcp/<server>.
    expect(new Set(WEBEX_SCOPES).size).toBe(15);
    expect(WEBEX_SCOPES).not.toContain("Identity:Organization");
  });
});
