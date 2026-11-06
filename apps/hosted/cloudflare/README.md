# Executor on Cloudflare Workers

The self-host product on stock Cloudflare Workers: one Worker named `executor` and its
`ExecutorProduct` Durable Object, which keeps the whole database in its own SQLite storage
(`EXECUTOR_DATABASE=sqlite`). No native helper, PGlite engine or custom workerd build.

| Self-host image                 | Here                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| `NATIVE /configuration`         | Worker vars and secrets (`src/configuration.ts`)             |
| `DASHBOARD` disk service        | Static assets (`ASSETS`) from `../self-host/web/dist/client` |
| `PUBLIC_FETCH`, `PRIVATE_FETCH` | Global `fetch`, behind the same URL policy                   |
| `SELF`                          | Service binding to this Worker's `SelfOrigin` entrypoint     |
| `MOTEL` collector               | Console logs (Workers observability) or `OTEL_*` endpoints   |
| `BLOBS` disk service            | R2 bucket `BLOBS` (`@executor-js/hosted-cloudflare/blobs`)   |
| `NATIVE` Git helper             | Artifacts binding `ARTIFACTS` (`.../app-source`), optional   |
| `APPS` app host                 | Service binding to the `executor-apps` Worker                |

A platform binding that is not declared is replaced by a stand-in that refuses the operation
(`src/platform.ts`), so sign-in and MCP work while apps cannot be stored or run.

## Settings

Secrets, with `wrangler secret put` (or `.dev.vars` for `wrangler dev`):

- `BETTER_AUTH_SECRET`: at least 32 characters.
- `EXECUTOR_ENCRYPTION_KEY`: 64 hexadecimal characters. Keep it: stored credentials and app
  repository tokens are sealed with it.

Vars: `BETTER_AUTH_URL` (the public origin, no trailing slash) and any other self-host setting
(`EXECUTOR_*`, `BETTER_AUTH_*`, `SSO_*`, `FIRST_PARTY_*`, `OTEL_*`). Analytics are off
(`DO_NOT_TRACK=1`). For app repositories, declare an Artifacts binding named `ARTIFACTS` and set
`CLOUDFLARE_ACCOUNT_ID` and, if not `executor-apps`, `EXECUTOR_ARTIFACTS_NAMESPACE`.

## MCP sessions in their own objects

With `EXECUTOR_MCP_SESSIONS=true` and the `MCP_SESSIONS` Durable Object binding
(`ExecutorMcpSession`), each caller's MCP sessions and programs run in an object of their own,
named by the caller's user, client, organization and grant. The product still authenticates every
request and runs every backend operation the object sends back, so one caller's busy program
neither blocks nor shares memory with another's. Sessions live in memory: after a deploy, clients
initialize again. Unset, the product runs MCP sessions itself.

## Run locally

```sh
bun run hosted:self-host:web:build
cd apps/hosted/cloudflare
printf 'BETTER_AUTH_URL=http://localhost:8787\nBETTER_AUTH_SECRET=%s\nEXECUTOR_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .dev.vars
bunx wrangler dev
```

Wrangler runs `scripts/generate.ts` before each build: it writes the skill files and the
dashboard file manifest that the Worker imports as `executor:skills` and `executor:dashboard`.
Open http://localhost:8787 to create the administrator account. MCP is served at
`/org/<organization>/mcp`.
