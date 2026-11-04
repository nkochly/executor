import { OAUTH_CHAIN_STORAGE_PREFIX } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Integrations that share one sign-in.
//
// Two servers whose OAuth discovery names the same authorization server sign
// the person in through the same place (one company sign-in in front of
// several MCP servers, or one provider serving two MCP endpoints). They are
// one group: the console offers one Connect for every member, and the sign-in
// runs member after member in one window. Membership comes from discovery
// alone, so a new server behind the same sign-in joins the group with nobody
// keeping a list. Joining a group never connects anything by itself: each
// member still waits for the person's click.
// ---------------------------------------------------------------------------

/** What a probe of the server's OAuth discovery says about where it signs in. */
export interface SignInDiscovery {
  readonly issuer?: string | null;
  readonly authorizationUrl: string;
}

/** The sign-in a server uses: its authorization server's issuer, else the
 *  origin and path of its authorization endpoint. Null when neither parses. */
export const signInKey = (discovery: SignInDiscovery): string | null => {
  const issuer = discovery.issuer?.trim();
  if (issuer && URL.canParse(issuer)) {
    const url = new URL(issuer);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  if (!URL.canParse(discovery.authorizationUrl)) return null;
  const url = new URL(discovery.authorizationUrl);
  return `${url.origin}${url.pathname}`;
};

/** The host a person recognises the sign-in by. */
export const signInHost = (key: string): string => (URL.canParse(key) ? new URL(key).host : key);

export interface SignInMember<T> {
  readonly key: string | null;
  readonly member: T;
}

/** The members that share `currentKey`'s sign-in, in the given order. Empty
 *  when the current integration has no known sign-in or shares it with nobody. */
export const sharedSignInGroup = <T>(
  currentKey: string | null,
  members: readonly SignInMember<T>[],
): readonly T[] => {
  if (currentKey === null) return [];
  const group = members.filter((entry) => entry.key === currentKey).map((entry) => entry.member);
  return group.length > 1 ? group : [];
};

export interface SignInHop {
  readonly state: string;
  readonly authorizationUrl: string;
}

/** The localStorage entries that carry one sign-in window from each hop to
 *  the next: the callback page for hop i reads hop i+1's authorization URL. */
export const chainEntries = (
  hops: readonly SignInHop[],
): readonly { readonly key: string; readonly value: string }[] =>
  hops.slice(0, -1).map((hop, index) => ({
    key: `${OAUTH_CHAIN_STORAGE_PREFIX}${hop.state}`,
    value: hops[index + 1]!.authorizationUrl,
  }));

/** "Artifacts", "Artifacts and Microsite", "Artifacts, Microsite and Wiki". */
export const joinNames = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};
