import { describe, expect, it } from "@effect/vitest";

import { loadConfig } from "./config";
import { consentDestination, redirectAllowed, registrationGate } from "./agent-redirects";

const ALLOW = "https://claude.ai/*,https://studio.presidio.ai/*";

describe("agent redirect allow-list", () => {
  it("admits an allowed origin's paths and any loopback app", () => {
    expect(redirectAllowed("https://studio.presidio.ai/oauth/cb", ALLOW)).toBe(true);
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback", ALLOW)).toBe(true);
    expect(redirectAllowed("http://localhost:33418/callback", ALLOW)).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:5000/cb", undefined)).toBe(true);
  });

  it("refuses lookalike hosts, plain http and anything with no list", () => {
    for (const uri of [
      "https://evil.test/cb",
      "https://claude.ai.evil.test/cb",
      "https://evil.claude.ai/cb",
      "http://claude.ai/cb",
      "javascript:alert(1)",
    ]) {
      expect(redirectAllowed(uri, ALLOW)).toBe(false);
    }
    expect(redirectAllowed("https://claude.ai/cb", undefined)).toBe(false);
  });

  it("refuses to register a client whose redirect is off the list", () => {
    const gate = registrationGate(ALLOW);
    expect(gate({ redirect_uris: ["https://claude.ai/cb"] })).toBeUndefined();
    expect(gate({ redirect_uris: ["https://claude.ai/cb", "https://evil.test/cb"] })).toMatchObject(
      {
        code: "invalid_redirect_uri",
      },
    );
    expect(gate({})).toMatchObject({ code: "invalid_redirect_uri" });
  });

  it("names the host the sign-in goes to, and warns for a program on this computer", () => {
    expect(
      consentDestination({ redirectHost: "studio.presidio.ai", redirectIsLoopback: false }),
    ).toContain("studio.presidio.ai");
    const local = consentDestination({ redirectHost: "127.0.0.1", redirectIsLoopback: true });
    expect(local).toContain("127.0.0.1");
    expect(local).toContain("on this computer");
    expect(
      consentDestination({ redirectHost: "<b>x</b>", redirectIsLoopback: false }),
    ).not.toContain("<b>x</b>");
  });

  it("reads the list from OAUTH_REDIRECT_URIS", () => {
    const config = loadConfig({
      EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
      VITE_PUBLIC_SITE_URL: "https://executor.example.com",
      ENABLE_DEV_AUTH: "true",
      OAUTH_REDIRECT_URIS: ALLOW,
    } as Parameters<typeof loadConfig>[0]);
    expect(config.agentRedirectAllowList).toBe(ALLOW);
  });
});
