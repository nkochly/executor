// ---------------------------------------------------------------------------
// How a connection is named across the console: "<Integration> · <what it
// reaches>", the way Wiki and Muster connections read ("Wiki · acme").
//
// A server that answers one tenant per connection names the tenant in its
// title ("Wiki · acme"), which a healthy probe reports as the identity; the
// part after the last separator is the tenant. A title that names no scope
// (a product name such as "Presidio Workspace") says nothing that tells two
// connections apart, so the sign-in's account names the connection instead.
// ---------------------------------------------------------------------------

export const NAME_SEPARATOR = " · ";

/** The scope a server's title names ("Wiki · acme" gives "acme"); null when it names none. */
export const scopeFromTitle = (title: string | null | undefined): string | null => {
  const trimmed = title?.trim() ?? "";
  const at = trimmed.lastIndexOf(NAME_SEPARATOR);
  if (at <= 0) return null;
  const scope = trimmed.slice(at + NAME_SEPARATOR.length).trim();
  return scope.length > 0 ? scope : null;
};

export interface ConnectionNaming {
  /** What the connection reaches: the tenant its server names, else the account. */
  readonly qualifier: string | null;
  /** Who signed in, when the qualifier names something else. */
  readonly account: string | null;
}

export const connectionNaming = (input: {
  readonly identity?: string | null;
  readonly account?: string | null;
}): ConnectionNaming => {
  const scope = scopeFromTitle(input.identity);
  const account = input.account?.trim() || null;
  if (scope) return { qualifier: scope, account: account && account !== scope ? account : null };
  return { qualifier: account, account: null };
};
