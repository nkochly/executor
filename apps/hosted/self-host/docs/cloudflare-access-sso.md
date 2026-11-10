# Sign-in through Cloudflare Access

Self-host signs people in with OpenID Connect (`SSO_*` settings). Cloudflare Access for SaaS is an
OpenID provider, so Access can be the only way in: Access policies decide who may sign in, and the
product admits whoever Access vouches for into its one organization.

## The Access application

Create one **SaaS application** in Zero Trust, protocol **OIDC**.

| Setting            | Value                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Redirect URL       | `https://<executor host>/api/auth/callback/sso`                                                 |
| Scopes             | `openid`, `email`, `profile`                                                                    |
| PKCE               | Off is fine (the product is a confidential client); on also works                               |
| OIDC flows         | No additional flows (authorization code only)                                                   |
| Refresh tokens     | Not needed; the product keeps its own session                                                   |
| Policies           | Allow the people who may use Executor (for example, the company's email domain or an IdP group) |
| Identity providers | The company IdP; turn on instant authentication if it is the only one                           |

Access then shows a client ID, a client secret and the configuration endpoint
`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>/.well-known/openid-configuration`.

## Product settings

| Variable                      | Value                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SSO_DISCOVERY_URL`           | The configuration endpoint above, exactly (the product does not follow redirects)                                               |
| `SSO_CLIENT_ID`               | The application's client ID                                                                                                     |
| `SSO_CLIENT_SECRET`           | The application's client secret (a secret, never a plain variable)                                                              |
| `SSO_ALLOWED_DOMAINS`         | The email domains Access admits, comma-separated                                                                                |
| `SSO_ADMIN_EMAILS`            | The platform admins, comma-separated; keep it equal to the operator list the other services use                                 |
| `SSO_PROVIDER_VERIFIES_EMAIL` | `true` if Access's ID token carries no `email_verified` claim (check the first sign-in); leave unset otherwise                  |
| `SSO_DIRECT`                  | `true` to make SSO the sign-in: a signed-out visit goes straight to Access, and `/login?password` still shows the password form |

The product reads discovery once at startup, so a change to the Access application's endpoints needs
a restart.

## Admins

When `SSO_ADMIN_EMAILS` is set, every SSO sign-in sets the person's role from it: a listed person is
an admin and an unlisted admin becomes a member. Removing someone from the list therefore takes
effect at their next sign-in, with nobody acting in the product. The owner (the account created at
setup) is never changed. When the list is empty, SSO sign-in leaves roles alone and new people join
as members.

## What must not sit behind Access

Do not put a self-hosted Access application in front of the Executor host. The product checks its
own sessions and bearer tokens, and these paths must reach it without an Access login:

- `/api/auth/callback/sso`, where Access sends the browser back with the sign-in code
- `/mcp` and `/.well-known/*`, which MCP clients call with tokens the product issues
- `/api/*`, which the CLI and API keys call

If a self-hosted Access application is ever added for defence in depth, these paths need a Bypass
policy, and the dashboard paths must still accept the product's own session.

## Tests

`e2e/tests/self-host-sso-emulated.spec.ts` signs in through a hosted emulated OpenID provider
(emulators.dev) on the SQLite product, with the same settings an Access application gives, and
checks that the admin list is applied and that a change to it takes effect.
