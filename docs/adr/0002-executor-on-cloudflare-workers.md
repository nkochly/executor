# 0002. Executor on stock Cloudflare Workers

Date: 2026-11-20. Status: accepted.

## Context

Upstream ships Executor v2's self-host product as a Docker image: workerd plus a native helper for
disk, Git and keys, with PGlite on disk. The Trifecta runs only on Cloudflare, and PGlite does not
fit in a Durable Object's memory.

## Decision

Product (`apps/hosted/cloudflare/src/worker.ts`, `product.ts`):

- One Durable Object, `ExecutorProduct`, owns the database, auth, sessions and background work, as
  the self-host image's product does, with the object's own SQLite storage as the database and no
  native helper.
- `worker.ts` and `mcp-session.ts` import nothing at run time but
  `@executor-js/hosted-cloudflare/product-location`. The product (`product.ts`) and the MCP session
  (`mcp-session-open.ts`) load only when their object first opens: evaluating them at startup
  exceeds the CPU time Cloudflare allows a Worker to start.
- Opening the store runs schema migrations and data steps, which can outlast a
  `blockConcurrencyWhile` callback on a large install. The store opens outside it, and every entry
  point waits for the open product. A failed open releases what it acquired and the next event
  retries it. The object starts opening at once on construction.
- An open failure names an invalid setting, never a value, and is reported as it is; any other
  failure keeps the whole cause and is logged, because the Worker's logs are the operator's only
  view of why the product did not open.
- The `alarm` restores the background owner after an eviction or restart even when no request
  arrives. A failed backup is retried at the next alarm and never stops the background owner. A
  retired object and the restore test object keep no background owner.
- Until `serve` is called on the session host, no MCP backend operation can run and each is
  answered with a defect.
- Outbound HTTP is the global `fetch`, behind the same URL policy the self-host product checks.

Requests and addresses (`worker.ts`, `product-request.ts`):

- Public traffic reaches only the product's authenticated route map. The client address is the one
  Cloudflare's edge saw, sent as `x-executor-client-ip`; any address header the client sent is
  replaced, and no other source of a client address is read.
- Requests to the instance's own dashboard origin, from app isolates or host egress, go through the
  `SelfOrigin` entrypoint (`SELF`). They never cross the network and carry a fixed internal source.
- App host workflow callbacks reach the product only through the `WorkflowCallbacks` entrypoint.
- The dashboard's browser files are static assets (`ASSETS`). The Worker runs first, so only the
  asset manifest is served.

Configuration (`configuration.ts`):

- Settings come from the Worker's vars and secrets, filtered to the names the self-host image
  passes to its product, so a binding object or an unrelated var never becomes configuration.
- The one exception is the operator's OAuth client credentials (`EXECUTOR_OAUTH_<ID>_CLIENT_ID`,
  `_CLIENT_SECRET`), which may be Secrets Store bindings read when the product opens, so a
  credential kept in the store never passes through a deploy.
- Secrets are required, because no disk exists to generate and keep them. A missing or malformed
  setting names the setting, never its value, and a Secrets Store failure is not passed on because
  its message could describe the value.

Platform services (`platform.ts`, `apps-worker/src/worker.ts`):

- `BLOBS` (R2) holds blobs; `ARTIFACTS` holds app repositories, with `CLOUDFLARE_ACCOUNT_ID` for
  its Git host and `EXECUTOR_ARTIFACTS_NAMESPACE` (default `executor-apps`); `APPS` is the app host
  speaking the workerd app protocol. Repository write tokens live in the product object's storage.
- Until a binding is declared its service is a stand-in that refuses every operation with that
  service's own error, so the product opens, signs people in and serves MCP while apps cannot be
  stored, built or run.
- The app host is upstream's shared workerd host, unchanged, on stock Workers: app isolates in
  Dynamic Workers (`LOADER`), app data in Durable Object facets (`DATA`), workflow runs on
  Cloudflare Workflows (`RUNS`). Only the product reaches it, through a service binding.
- The app host asks the product for a build's code on every cold start, and one program's calls
  can cold-start many app Workers at once. The product reads each build once at a time and keeps
  the linked code in memory (`packages/sdk/src/implementation/workerd-build-loader.ts`): the
  callers of a build take turns at one permit per build, the first reads it, and the rest find it
  in memory, so its decode temporaries exist once. A waiting caller polls the permit on its own
  timer rather than awaiting another request's promise, as upstream cloud's
  `runtime-build-cache.ts` does. Builds are immutable code with no credentials, held least recently
  used first within 32 MiB and 64 builds, one cache per product. A build load waits and reads for at
  most 10 s in all, then fails as unavailable; the earlier loader had no deadline. On 2026-11-21 forty-seven concurrent cold starts read
  and decoded one 2.1 MB framework at once and the product exceeded its 128 MB memory limit
  (`cloudflare-build-reads.spec.ts`).
- App egress uses Cloudflare's global `fetch` as the public network, because it reaches only the
  public internet, as workerd's public-only network service does in self-host. Private
  destinations are refused by name before they get there unless the operator allows them.

Build (`scripts/generate.ts`, `src/modules.d.ts`, `wrangler.jsonc`):

- The Worker is minified: startup must stay under Cloudflare's 1 s CPU limit, and parsing the
  unminified bundle alone takes about a third of it.
- Secrets (`BETTER_AUTH_SECRET`, `EXECUTOR_ENCRYPTION_KEY`) are set with `wrangler secret put`, or
  in `.dev.vars` for `wrangler dev`. The app host's `CREDENTIAL_SECRET` is derived from the
  product's encryption key.
- The app host Worker has no route or public URL; only the product binds it. The product
  authenticates to it with a fixed value, because the service binding itself is the credential.
  Apps calling the product's public origin go through `SELF`.

- Wrangler runs `generate.ts` before every build. It writes the build-time modules
  `executor:skills`, `executor:dashboard` and `executor:program-sandbox`. The dashboard must be
  built first. The program sandbox is one self-contained module, because a Dynamic Worker receives
  only the modules it is given.

Feedback (`agent-reports.ts`):

- Feedback goes to the Worker bound as `AGENT_REPORTS`: an entrypoint whose `submit` takes the
  feedback with the email the product's sign-in verified and the MCP client it came from. The
  binding is the only credential. Without it, feedback stays disabled.
- The receiver answers taken, declined with a reason the agent can read, or none. Any failure to
  reach it or read its answer is "not confirmed", never a refusal.

Development (`apps-worker/dev/`):

- `host.mjs` serves, on 127.0.0.1, the native services the product binds (configuration, Git, the
  build disk, dashboard files, the telemetry collector) so `wrangler dev` runs the product and the
  app host together. It mirrors self-host's native helper and workerd disk service (whole files,
  atomic PUT, directory GET lists entries). `host-bindings.ts` turns them into Worker entrypoints
  and the two egress networks into global `fetch`. `prepare.ts` writes the build-time asset modules
  as self-host's packaging makes them.

Live queries (`fixture/live-stream.ts`, `e2e/tests/cloudflare-live-stream.spec.ts`):

- A live app query holds a subscription that re-runs its query whether or not anyone reads the
  stream, and runs only while a page holds it. The product's event streams end only when the
  runtime cancels the body the object streamed, so the test serves the stream in local workerd with
  this Worker's compatibility settings and proves a client's disconnect still reaches that body.
  The test polls the fixture's run count until it rises, then until it stops rising, each with a
  deadline, instead of sleeping fixed times.

## Consequences

- Cold starts pay for opening the product on the first request, not at Worker startup.
- `prepare.ts` writes a stub for PGlite's modules, because `dev/product.jsonc` runs upstream's
  self-host `worker.ts`, which imports them even on SQLite. Removing the stub needs either an edit
  to that upstream file or running the Cloudflare product Worker in development instead of the
  stand-ins; the stub stays (Nathan, 2026-11-20).
