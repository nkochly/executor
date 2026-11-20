import { Config, Effect, Option } from "effect";

export interface AccessProxy {
  readonly verify: (headers: Headers) => Effect.Effect<Option.Option<string>>;
}

interface Jwk extends JsonWebKey {
  readonly kid?: string;
}

const base64UrlBytes = (part: string) => {
  const padded = part
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const base64UrlJson = (part: string): unknown =>
  JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));

const certsLifetimeMs = 60 * 60 * 1000;

export const makeAccessProxy = (
  teamDomain: string,
  accepted: readonly string[],
  fetchCerts: () => Promise<readonly Jwk[]> = async () => {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`Access certs answered ${response.status}`);
    const body = (await response.json()) as { keys?: Jwk[] };
    return body.keys ?? [];
  },
  now: () => number = Date.now,
): AccessProxy => {
  let cached: { readonly at: number; readonly keys: Map<string, Promise<CryptoKey>> } | undefined;
  const keys = async (refresh: boolean) => {
    if (cached === undefined || refresh || now() - cached.at > certsLifetimeMs) {
      const list = await fetchCerts();
      cached = {
        at: now(),
        keys: new Map(
          list
            .filter((key): key is Jwk & { kid: string } => typeof key.kid === "string")
            .map((key) => [
              key.kid,
              crypto.subtle.importKey(
                "jwk",
                key,
                { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
                false,
                ["verify"],
              ),
            ]),
        ),
      };
    }
    return cached.keys;
  };
  const verifyToken = async (token: string): Promise<string | undefined> => {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [head, body, signature] = parts as [string, string, string];
    const header = base64UrlJson(head) as { alg?: unknown; kid?: unknown };
    if (header.alg !== "RS256" || typeof header.kid !== "string") return undefined;
    let key = (await keys(false)).get(header.kid);
    if (key === undefined) key = (await keys(true)).get(header.kid);
    if (key === undefined) return undefined;
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await key,
      base64UrlBytes(signature),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!valid) return undefined;
    const claims = base64UrlJson(body) as {
      aud?: unknown;
      iss?: unknown;
      exp?: unknown;
      nbf?: unknown;
      email?: unknown;
    };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.some((audience) => accepted.includes(audience))) return undefined;
    if (claims.iss !== `https://${teamDomain}`) return undefined;
    const seconds = now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return undefined;
    if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return undefined;
    if (typeof claims.email !== "string" || !claims.email.includes("@")) return undefined;
    return claims.email;
  };
  return {
    verify: (headers) => {
      const token = headers.get("cf-access-jwt-assertion");
      if (token === null) return Effect.succeed(Option.none());
      return Effect.promise(() => verifyToken(token).catch(() => undefined)).pipe(
        Effect.map(Option.fromNullishOr),
      );
    },
  };
};

const noProxy: AccessProxy = { verify: () => Effect.succeed(Option.none()) };

const setting = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value !== "")));

export const accessProxies = Effect.gen(function* () {
  const team = yield* setting("EXECUTOR_ACCESS_TEAM_DOMAIN");
  const audience = yield* setting("EXECUTOR_ACCESS_AUD");
  const shared = yield* setting("EXECUTOR_ACCESS_SHARED_AUD");
  if (Option.isNone(team) || Option.isNone(audience)) return { mcp: noProxy, reader: noProxy };
  const mcp = makeAccessProxy(team.value, [audience.value]);
  return {
    mcp,
    reader: Option.isSome(shared)
      ? makeAccessProxy(team.value, [audience.value, shared.value])
      : mcp,
  };
});
