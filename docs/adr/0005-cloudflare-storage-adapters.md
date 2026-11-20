# 0005. R2 blobs and Artifacts app source

Date: 2026-11-20. Status: accepted.

## Context

Upstream's Cloud build stores blobs on R2 and app source on Artifacts inside its own deployment
wiring. The Cloudflare host needs the same stores against the bindings its product object is given.

## Decision

Blobs (`packages/hosted-cloudflare/src/blobs.ts`):

- Cloud's R2 store without its deployment wiring: the host passes the bucket binding. One object
  per key. Writes of the same key and bytes retry R2's explicit rate limit twice. Listing uses
  `delimiter` to keep nested folders out, and R2 pages the names. A range read goes to R2; an empty
  range only needs the object's size.

App source (`app-source.ts`):

- Git reads and pushes are upstream's shared `@executor-js/app-source/cloudflare` adapter. This
  module supplies the host side: repository creation, write tokens, and the binding reads Git
  cannot do without fetching whole packs.
- Tokens are stored encrypted, with the host's 256-bit key, in the product object's storage. A
  token lives for Artifacts' longest lifetime (one year) and is replaced five minutes before it
  expires. One lock serializes refreshes; the product runs in one object, so it is the only writer.
- Creation is keyed by the repository ID, so creating again reuses the repository.
- A new repository is briefly unavailable while Artifacts finishes creating it, so its first read
  is retried twice, five seconds apart.
- RPC properties are read while the handle is alive, and an RPC stub is disposed after use. The
  token plaintext is never logged.
- A commit is read as given; a branch resolves to its head. A tree is walked depth first, siblings
  read together, each level in order. File bytes are kept while the running total stays within
  budget.

Local tests (`scripts/storage-host.ts`, `fixture/worker.ts`):

- Artifacts has no local simulator, so real Git stands in: each repository is a bare repository in
  a temporary directory, pushes reach `git http-backend` through the Worker's outbound fetch to
  `<account>.artifacts.cloudflare.net`, and the binding's read methods are answered with Git
  plumbing. Write tokens are checked on every Git request, as Artifacts checks them. R2 is
  Miniflare's local simulation. Every write is read back and compared byte for byte.

## Consequences

- The R2 binding throws a plain `Error` with no `code` property; its message ends with the code in
  parentheses (`put: <reason> (10020)`). `r2ErrorCode` reads that code, and the rate limit is
  code 10058. `e2e/tests/cloudflare-storage.spec.ts` holds the message's shape against Miniflare's
  R2, so a change in it fails a test instead of silently stopping the retry.
