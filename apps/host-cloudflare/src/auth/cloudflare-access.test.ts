import { describe, expect, it } from "@effect/vitest";

import { orgWriteAccessForPrincipal } from "@executor-js/host-mcp";

import { parseTenants, type CloudflareConfig } from "../config";
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
  tenants: null,
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
    tenants: parseTenants(
      JSON.stringify({
        acme: { name: "Acme", admins: ["lead@acme.com"], members: ["dev@acme.com", "tok.access"] },
        beta: { members: ["dev@acme.com"] },
        open: { members: ["*"] },
      }),
    ),
  };

  it("acts in the named tenant with that tenant's role", () => {
    const admin = principalFromAccessClaims({ sub: "a", email: "Lead@acme.com" }, multi, "acme")!;
    expect(admin.organizationId).toBe("acme");
    expect(admin.organizationName).toBe("Acme");
    expect(orgWriteAccessForPrincipal(admin)).toBe("allowed");

    const member = principalFromAccessClaims({ sub: "d", email: "dev@acme.com" }, multi, "acme")!;
    expect(member.orgRole).toBe("member");
    expect(orgWriteAccessForPrincipal(member)).toBe("denied");
  });

  it("refuses a tenant that does not list the caller, and unknown tenants", () => {
    expect(
      principalFromAccessClaims({ sub: "a", email: "lead@acme.com" }, multi, "beta"),
    ).toBeNull();
    expect(
      principalFromAccessClaims({ sub: "a", email: "lead@acme.com" }, multi, "nope"),
    ).toBeNull();
  });

  it("ignores the global admin list", () => {
    const p = principalFromAccessClaims({ sub: "u", email: "admin@example.com" }, multi, "open")!;
    expect(p.orgRole).toBe("member");
  });

  it("matches service tokens by client id", () => {
    const p = principalFromAccessClaims({ common_name: "tok.access" }, multi, "acme")!;
    expect(p.organizationId).toBe("acme");
  });

  it("needs a tenant named unless the caller is in exactly one", () => {
    expect(principalFromAccessClaims({ sub: "d", email: "dev@acme.com" }, multi)).toBeNull();
    const only = principalFromAccessClaims({ sub: "l", email: "lead@acme.com" }, multi);
    // lead is in acme and, through "*", in open: two tenants, so none is picked.
    expect(only).toBeNull();
  });
});
