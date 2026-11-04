import { describe, expect, it } from "@effect/vitest";
import { OAUTH_CHAIN_STORAGE_PREFIX } from "@executor-js/sdk/shared";

import {
  chainEntries,
  joinNames,
  sharedSignInGroup,
  signInHost,
  signInKey,
} from "./shared-sign-in";

describe("signInKey", () => {
  it("keys by the authorization server's issuer, ignoring a trailing slash", () => {
    const a = signInKey({
      issuer: "https://team.cloudflareaccess.com",
      authorizationUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
    });
    const b = signInKey({
      issuer: "https://team.cloudflareaccess.com/",
      authorizationUrl: "https://team.cloudflareaccess.com/other",
    });
    expect(a).toBe("https://team.cloudflareaccess.com");
    expect(b).toBe(a);
  });

  it("falls back to the authorization endpoint when no issuer is known", () => {
    expect(
      signInKey({ issuer: null, authorizationUrl: "https://webexapis.com/v1/authorize?x=1" }),
    ).toBe("https://webexapis.com/v1/authorize");
  });

  it("is null when nothing parses", () => {
    expect(signInKey({ issuer: "", authorizationUrl: "not a url" })).toBeNull();
  });
});

describe("sharedSignInGroup", () => {
  const members = [
    { key: "https://access.example", member: "artifacts" },
    { key: "https://wiki.example", member: "wiki" },
    { key: "https://access.example", member: "microsite" },
    { key: null, member: "unknown" },
  ];

  it("lists every member behind the same sign-in, in order", () => {
    expect(sharedSignInGroup("https://access.example", members)).toEqual([
      "artifacts",
      "microsite",
    ]);
  });

  it("is empty for a sign-in nobody else uses", () => {
    expect(sharedSignInGroup("https://wiki.example", members)).toEqual([]);
  });

  it("is empty when the current sign-in is unknown", () => {
    expect(sharedSignInGroup(null, members)).toEqual([]);
  });
});

describe("chainEntries", () => {
  it("points each hop's callback at the next hop and leaves the last to close", () => {
    expect(
      chainEntries([
        { state: "s1", authorizationUrl: "https://a.example/1" },
        { state: "s2", authorizationUrl: "https://a.example/2" },
        { state: "s3", authorizationUrl: "https://a.example/3" },
      ]),
    ).toEqual([
      { key: `${OAUTH_CHAIN_STORAGE_PREFIX}s1`, value: "https://a.example/2" },
      { key: `${OAUTH_CHAIN_STORAGE_PREFIX}s2`, value: "https://a.example/3" },
    ]);
  });

  it("writes nothing for a single sign-in", () => {
    expect(chainEntries([{ state: "s1", authorizationUrl: "https://a.example/1" }])).toEqual([]);
  });
});

describe("names", () => {
  it("joins names the way a sentence reads", () => {
    expect(joinNames(["Artifacts"])).toBe("Artifacts");
    expect(joinNames(["Artifacts", "Microsite"])).toBe("Artifacts and Microsite");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("shows the sign-in by its host", () => {
    expect(signInHost("https://team.cloudflareaccess.com")).toBe("team.cloudflareaccess.com");
  });
});
