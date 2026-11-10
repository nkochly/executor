// ---------------------------------------------------------------------------
// Where an agent's sign-in may be sent. `/register` is public, so anyone can
// register a client under any name; the redirect URI is the one part of a
// client a person cannot be fooled about. Registration and `/authorize` both
// hold it to this list, and the consent page names its host.
//
// A loopback redirect (localhost, 127.0.0.0/8, ::1) is always admitted, as the
// Access apps admit it for local MCP clients; the consent page warns about it.
// Every other redirect must be https and match an entry of
// OAUTH_REDIRECT_URIS (comma-separated): an entry ending in `/*` admits every
// path under it on the same origin, any other entry only itself. Unset admits
// no remote redirect.
// ---------------------------------------------------------------------------

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The URI parsed, or null unless it is plain http(s) with no fragment or credentials. */
const parse = (uri: string): URL | null => {
  if (!URL.canParse(uri)) return null;
  const url = new URL(uri);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hash || url.username || url.password) return null;
  return url;
};

const entryAdmits = (entry: string, url: URL): boolean => {
  if (entry.endsWith("/*")) {
    const base = parse(entry.slice(0, -1));
    return !!base && base.origin === url.origin && url.pathname.startsWith(base.pathname);
  }
  const exact = parse(entry);
  return !!exact && exact.href === url.href;
};

export const redirectAllowed = (uri: string, allowList: string | undefined): boolean => {
  const url = parse(uri);
  if (!url) return false;
  if (LOOPBACK.test(url.hostname)) return true;
  if (url.protocol !== "https:") return false;
  return (allowList ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .some((entry) => entryAdmits(entry, url));
};

/** The provider's registration callback: nothing to allow, a refusal otherwise (RFC 7591 §3.2.2). */
export const registrationGate =
  (allowList: string | undefined) =>
  (clientMetadata: Record<string, unknown>): { code: string; description: string } | undefined => {
    const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
    const ok =
      uris.length > 0 && uris.every((u) => typeof u === "string" && redirectAllowed(u, allowList));
    return ok
      ? undefined
      : {
          code: "invalid_redirect_uri",
          description: "Redirect URI is not on this server's allow-list.",
        };
  };

/** The consent page's line naming where the sign-in goes; the client's own name is self-chosen. */
export const consentDestination = (client: {
  readonly redirectHost: string;
  readonly redirectIsLoopback: boolean;
}): string =>
  client.redirectIsLoopback
    ? `<p><strong>This sign-in goes to a program on this computer</strong> (${escapeHtml(client.redirectHost)}). Connect only if you just started it from an app you trust.</p>`
    : `<p>After you connect, the sign-in is sent to <strong>${escapeHtml(client.redirectHost)}</strong>. If you don't recognise that address, close this page.</p>`;

export const REFUSED_REDIRECT =
  "<p>This app sends sign-ins to an address this server does not allow, so it cannot connect.</p>";
