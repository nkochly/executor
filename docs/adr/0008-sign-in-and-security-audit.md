# 0008. Sign-in through Access, OAuth clients and the security audit

Date: 2026-11-20. Status: accepted.

## Decision

Access (`apps/hosted/self-host/src/implementation/access-proxy.ts`):

- Cloudflare Access fronts the whole host and signs in every caller, MCP clients through its own
  OAuth. With `EXECUTOR_ACCESS_TEAM_DOMAIN` and `EXECUTOR_ACCESS_AUD` set, a
  `Cf-Access-Jwt-Assertion` that verifies (RS256 by a current team key, this audience, the team
  issuer, within its lifetime) is the caller's identity on `/mcp` and on the caller's own scoped
  connection URLs. An unknown key id refetches the team's keys once, for a rotated key.
- `EXECUTOR_ACCESS_SHARED_AUD` names a second Access application, one sign-in shared by several
  hosts, whose assertion another Worker forwards. It is accepted only on the person's read routes
  (`/api/me/*`), never on `/mcp` or a route that changes something.
- `EXECUTOR_ACCESS_DEPLOY_CHECK_CLIENT_ID` names one Access service token, the Trifecta deploy's
  agent check. An assertion for this audience with no email whose `common_name` is that client ID
  is the deploy check, on `/mcp` only: never on the shared sign-in, a scoped connection URL or a
  browser approval. Its first call makes the account `deploy-check@executor.invalid` ("Deploy
  check"), a member of the instance's one organization, because every tool call checks
  membership. It holds a grant of no apps, so it can open a session, list the tools and call them,
  and reach no app, account or person's data. No session or password exists for it, and single
  sign-on admits no `.invalid` address. Its grant id is not a proxy grant's, so
  nothing derives wider authority from it. Without the setting no service token is a caller. The
  check exists because a deploy could leave the product or a session serving the old version,
  which only a fresh session on the live host shows (`e2e/tests/self-host-access-proxy.spec.ts`).
- Any failure to verify is no identity; the request then needs a credential of its own.

Operator OAuth clients (`apps/hosted/server/src/implementation/fork-oauth-clients.ts`):

- The fork adds its own operator clients beside upstream's reviewed ones, each turned on by
  `EXECUTOR_OAUTH_<ID>_CLIENT_ID` and `_CLIENT_SECRET`.
- `webex` is the operator's Webex integration. Webex's MCP servers name `webexapis.com` as their
  authorization server, which neither registers clients nor reads a client metadata document, so
  without it every person would need a Webex integration of their own. A token acts as the person
  and goes only to Webex's MCP servers. It asks every scope Webex's meetings and messaging MCP
  servers list, plus `spark:kms`, which Webex adds to every grant.

OAuth error codes (`apps/hosted/server/src/contracts/oauth-errors.ts`):

- A record that names an OAuth error accepts only the codes Better Auth answers with: a sign-in's
  error redirect, RFC 6749 and RFC 8707 token errors, and RFC 7591 registration errors.

Security audit (`auth-audit.ts`, `auth-audit-vocabulary.ts`, self-host `auth-audit.ts`):

- Better Auth's own endpoints are audited: sign-in, one-time codes, sessions, API keys, members
  and invitations, OAuth client registration and consent, impersonation. Only the listed sign-in
  endpoints count as sign-ins, because others such as `/get-session` also set a session. Each host
  names its sign-in endpoints and its plugins' failure codes; self-host's are password, single
  sign-on (Better Auth's social endpoints serving the generic `sso` provider) and account creation.
- A record names only what the request's authentication and the endpoint's stored answer
  establish. The actor is the session already on the hook context; the audit never reads a session
  itself, so it adds no query and no cookie. Register it after any plugin that reads the session.
- A target's ID and organization come only from a successful endpoint's stored answer; a refused
  request names neither. A failure is recorded by Better Auth's code only when the code is one
  these endpoints answer with, else `other`. Never an email, code, token or key: from
  `/api-key/create` only the key's ID is read. Request body fields decode one by one, so one
  field's value cannot hide another's. A consent body whose `accept` is not a boolean names no
  decision and is never taken for an allow.
- A revocation is recorded where Better Auth deletes the session row, one record per session; an
  endpoint that answers success without deleting one is `unconfirmed`.
- Impersonation is its own action: actor the admin, target the impersonated user, both from stored
  session rows. A session it created carries the admin as `impersonatedBy` in every record.
- `record` must never reject.

Single sign-on (`e2e/tests/self-host-sso-emulated.spec.ts`, `self-host-access-proxy.spec.ts`):

- Self-host SSO is tested against a hosted emulated OpenID provider, the shape a managed identity
  front door gives: discovery at a fixed HTTPS URL, a confidential client, a redirect back to
  `/api/auth/callback/sso`. Admin emails the operator lists become organization admins at sign-in,
  and a change to the list takes effect at each member's next SSO sign-in. The browser reaches the
  provider through the runner's own network stack, so a runner behind a TLS-terminating proxy
  works. Access is tested with a synthetic identity provider publishing the team's keys at
  `/cdn-cgi/access/certs`, trusted through `NODE_EXTRA_CA_CERTS`.

## Consequences

- The SSO e2e scenario waits out Better Auth's sign-in rate limit with fixed 11-second sleeps
  (three attempts per address per ten seconds; one SSO sign-in is two). The limit is set in
  upstream's auth files and the client address comes from the socket, so the test can neither
  configure it nor use a fresh address. A fork setting in those upstream files would remove the
  sleeps; the scenario keeps them instead, so upstream's auth files stay unchanged (Nathan,
  2026-11-20).
