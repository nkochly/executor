import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AccountProvider } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";
import { TENANT_HEADER } from "../tenancy";
import { cloudflareAccountProvider } from "./account-provider";

const config: CloudflareConfig = {
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  adminEmails: ["admin@example.com"],
  organizationId: "default",
  organizationName: "Default",
  organizationSlug: "default",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://localhost",
  enableDevAuth: true,
  directory: { url: "https://dir.test/api/directory" },
  firstParty: [],
};

describe("cloudflareAccountProvider.me", () => {
  it.effect("names the caller's tenant as the organization slug, not the configured default", () =>
    Effect.gen(function* () {
      const provider = yield* AccountProvider;
      const me = yield* provider.me({ [TENANT_HEADER]: "beta" });
      expect(me.organization?.slug).toBe("beta");
      expect(me.organization?.id).toBe("beta");
    }).pipe(Effect.provide(cloudflareAccountProvider(config))),
  );
});
