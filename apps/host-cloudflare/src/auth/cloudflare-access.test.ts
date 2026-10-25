import { describe, expect, it } from "@effect/vitest";

import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";

import type { CloudflareConfig } from "../config";
import { principalFromAccessClaims } from "./cloudflare-access";

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
  enableDevAuth: false,
  directory: null,
};

describe("principalFromAccessClaims", () => {
  it("maps a human identity (email + sub + groups)", () => {
    const p = principalFromAccessClaims(
      { sub: "user-123", email: "person@example.com", name: "Person", groups: ["eng"] },
      config,
    )!;
    expect(p.accountId).toBe("user-123");
    expect(p.email).toBe("person@example.com");
    expect(p.name).toBe("Person");
    expect(p.roles).toEqual(["eng"]);
    expect(p.organizationId).toBe("default");
  });

  it("grants admin when the email is in the allowlist", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "ADMIN@example.com" }, config)!;
    expect(p.roles).toContain("admin");
    expect(p.orgRoleModel).toBe("organization");
    expect(p.orgRole).toBe("admin");
    expect(orgWriteAccessForPrincipal(p)).toBe("allowed");
  });

  it("gives a SERVICE TOKEN (common_name, no email/sub) a stable identity", () => {
    // Cloudflare Access service-token JWT: common_name set, email/sub absent.
    const p = principalFromAccessClaims({ common_name: "df8a20db.access", type: "app" }, config)!;
    expect(p.accountId).toBe("df8a20db.access"); // not empty — stable per token
    expect(p.name).toBe("df8a20db.access");
    expect(p.email).toBe("");
    expect(p.roles).toEqual(["member"]); // a token is a member, not an admin
    expect(p.organizationId).toBe("default");
  });

  it("defaults to member when there are no groups and no admin match", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "nobody@other.com" }, config)!;
    expect(p.roles).toEqual(["member"]);
    expect(p.orgRoleModel).toBe("organization");
    expect(p.orgRole).toBe("member");
    expect(orgWriteAccessForPrincipal(p)).toBe("denied");
  });
});

describe("principalFromAccessClaims in multi-tenant mode", () => {
  const multi: CloudflareConfig = {
    ...config,
    directory: { url: "https://dir.test/api/directory" },
  };
  const acme = { slug: "acme", name: "Acme" };

  it("acts in the directory's tenant with that tenant's role", () => {
    const admin = principalFromAccessClaims({ sub: "a", email: "lead@acme.com" }, multi, {
      tenant: acme,
      role: "admin",
    })!;
    expect(admin.organizationId).toBe("acme");
    expect(admin.organizationName).toBe("Acme");
    expect(orgWriteAccessForPrincipal(admin)).toBe("allowed");

    const member = principalFromAccessClaims({ sub: "d", email: "dev@acme.com" }, multi, {
      tenant: acme,
      role: "member",
    })!;
    expect(orgWriteAccessForPrincipal(member)).toBe("denied");
  });

  it("refuses a caller with no membership, and ignores the global admin list", () => {
    expect(
      principalFromAccessClaims({ sub: "u", email: "admin@example.com" }, multi, null),
    ).toBeNull();
  });
});
