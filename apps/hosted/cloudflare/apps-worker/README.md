# Executor app host on Cloudflare

The Worker that runs deployed apps for the Cloudflare-hosted product. It is the shared workerd
app host (`@executor-js/sdk/workerd/host`), the same code self-host runs inside its own workerd
build, on stock Cloudflare Workers:

| Binding        | Cloudflare primitive            | What it does                                             |
| -------------- | ------------------------------- | -------------------------------------------------------- |
| `LOADER`       | Worker Loader (Dynamic Workers) | One isolate per app build                                |
| `DATA`         | Durable Object (SQLite), facets | Each app's data, kept across code updates                |
| `RUNS`         | Cloudflare Workflows            | Workflow runs, durable steps and sleeps                  |
| `HOST`, `SELF` | Service bindings to `executor`  | Workflow callbacks to the product, and its own origin    |
| `PUBLIC_FETCH` | This Worker's `PublicFetch`     | App egress; Cloudflare `fetch` reaches only the internet |

Schedules belong to the product: its schedule worker decides when a schedule is due and runs it,
and a run that starts a workflow starts it here on `RUNS`.

Only the product reaches this Worker, through its `APPS` service binding. It has no route and
`workers_dev` is off. Every request must carry `authorization: Bearer <AUTH>`; the binding is the
real credential, as in self-host.

## Settings

- `CREDENTIAL_SECRET` (secret): seals the credential handles apps carry. Only this Worker reads
  it. Self-host derives it from the product's encryption key, as HMAC-SHA256 of
  `executor credential handles` in hex; any stable secret works, and changing it only makes apps
  fetch new handles on their next invocation.
- `SELF_ORIGIN`: the product's public origin (its `BETTER_AUTH_URL`).
- `APPS_PRIVATE_FETCH`, `NPM_REGISTRY`, `APP_WORKERS`, `APP_WORKER_IDLE_SECONDS`: as in self-host.

## Local development

`bun run dev:product` runs the self-host product Worker, this app host and a development
stand-in for the product's native services together in one `wrangler dev`, on SQLite:

- `dev/product.jsonc`: the self-host product Worker, its native bindings pointed at
  `dev/host-bindings.ts`.
- `dev/host.mjs`: configuration, Git, the build disk and dashboard files on 127.0.0.1:4499,
  as self-host's native helper and workerd disk services serve them.

The stand-ins exist until the Cloudflare host shell (Worker vars and secrets, R2, Artifacts and
static assets) replaces them. Build the dashboard first (`bun run hosted:self-host:web:build`).
Then sign up at <http://localhost:8787>, deploy an app, and connect an MCP client to
<http://localhost:8787/mcp>.
