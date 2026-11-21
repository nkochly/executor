# 0010. Localhost subdomains resolve to loopback in the e2e runner and in app fetch

Date: 2026-11-21. Status: accepted.

## Context

Self-host serves each app page on its own subdomain of the dashboard's localhost origin, such as
`private-ui-<id>.executor.localhost`. RFC 6761 reserves every `*.localhost` name for loopback.
Chromium and Bun follow it themselves. Node asks the operating system, and only some systems
answer: a GitHub-hosted runner does, through systemd's resolver, but a cloud container whose
`/etc/nsswitch.conf` reads `hosts: files dns` answers `ENOTFOUND`. In those containers 12
self-host scenarios failed on every branch, wherever the runner itself (an Effect HTTP client, or
Playwright's request context, which calls `dns.promises.lookup`) fetched an app page or a named
loopback host.

## Decision

- `e2e/support/localhost-names.ts` wraps `dns.lookup` and `dns.promises.lookup` in each runner
  worker so a `*.localhost` name is looked up as `localhost`. Every other name goes to the
  operating system unchanged. `e2e/setup.ts` installs it before any scenario runs.
- The products are left alone: self-host runs on Bun, which already resolves these names, and the
  scenarios assert what the products do, not how the runner's host resolves names.
- `e2e/check-boundary.ts` allows `node:dns` in that one file.
- Rejected: a fork list of known failures read by the runner, shaped like upstream's `notRunInCi`.
  It would hide the scenarios in exactly the environments agents run them in.

## Consequences

- The app page scenarios run the same in a cloud container as on a GitHub-hosted runner.
- A Node process the runner starts, other than its own workers, still uses the operating system's
  resolver.

## App fetch (2026-11-21)

An app's own `fetch` with private fetch allowed goes through workerd's network, which asks the
operating system too, so on the same hosts, and in most Docker images, a `*.localhost` name failed
to connect (the underscore host scenario in `credential-hosts.spec.ts`).

- `AppOutbound` in `packages/sdk/src/implementation/workerd-entry.ts` sends a request for a
  `*.localhost` name to `127.0.0.1` on the same port, after the credential checks have read the
  name. Bare `localhost` is left to the operating system, whose hosts file always names it.
- The service sees `Host: 127.0.0.1:<port>`: workerd sets the Host header from the URL and drops
  one set by the caller. A loopback service that answers only on `::1` is not reached through a
  `*.localhost` name.
- Public-only fetch is unchanged: it refuses these names before any lookup.
