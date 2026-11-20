# 0004. Product location, backups and restores

Date: 2026-11-20. Status: accepted.

## Context

A Durable Object is placed near the first request that reaches it and never moves. Cloudflare
offers no export of a Durable Object's storage; its point-in-time recovery stays inside the object.

## Decision

Location (`packages/hosted-cloudflare/src/product-location.ts`):

- An install that names a location (`EXECUTOR_PRODUCT_LOCATION`, a Cloudflare location hint such
  as `wnam`) keeps its product in an object of that name created with that hint. A hint Cloudflare
  does not know is refused at first use.
- The unnamed object `product` then retires: its first successor copies its storage once, after
  which it serves nothing, and it keeps its data until `EXECUTOR_PRODUCT_WIPE_PREVIOUS` is `true`.
  The copy is already held, so a failed wipe only leaves the old copy for a later start.
- The copy is read in pages of about 4 MiB of row values (RPC refuses a message over 32 MiB) and
  written in one transaction, so the successor holds all of it or nothing. Schema and key-value
  entries come on the first page only.
- Cloudflare moves objects to new code one at a time, so the unnamed object can still run a
  release with no `exportPage`. Then the successor gets `false`, the unnamed object keeps serving,
  and the next event tries again (`fixture/product-move.ts`).
- `replaceStorage` runs inside `transactionSync`. It drops anything written before the copy, lists
  keys before deleting any (deleting while listing skips entries), then creates tables, then the
  indexes a foreign key's parent column may need, then rows. Foreign keys are checked at commit,
  because a row's parent may come later in the copy. Triggers and views come last, so no trigger
  fires for a copied row.
- This module and `backup.ts` import nothing at run time; the Worker's entry modules load them at
  startup.

Backups (`backup.ts`, `apps/hosted/cloudflare/src/worker.ts`):

- The product writes a backup of everything it stores into `BACKUPS` (R2) once a day, read with
  `exportStoragePage` and restored with `replaceStorage`, the same pages in the same order as a
  move. Without `BACKUPS`, no backups are written.
- Layout: `<key>/<stamp>/page-00000.json`, one per page, then `<key>/<stamp>/manifest.json`
  written last, so a stamp without a manifest is incomplete. A stamp is the backup's ISO time, so
  stamps sort by time. The newest complete backup is always kept; older ones go after `keepDays`,
  incomplete ones after a day.
- Values JSON cannot carry are tagged: bytes `{"$":"bytes","v":<base64>}` (`"u8":true` for a
  Uint8Array), a Date `{"$":"date","v":<iso>}`, a non-finite number `{"$":"number","v":"NaN"}`,
  and a stored object with its own `$` key `{"$":"object","v":{...}}`. Any other kind fails the
  backup and names its key rather than be copied wrong.
- All pages are read without yielding, so the copy is one moment of the object. Each page is
  encoded as soon as it is read, so the raw rows are never all held at once. A database over
  32 MiB (`MAX_BACKUP_BYTES`) fails with a `BackupError` that says so, because a backup holds the
  whole object in memory and an isolate has 128 MB.
- Every backup is proved by restoring it into the scratch object `restore-test:<product>`, which
  counts what it holds against the manifest, reports, and then deletes everything it stored.
- A restore writes only into an object that stores nothing yet, so it never writes over an object
  in use. `EXECUTOR_PRODUCT_RESTORE` (`latest` or a stamp) restores into a product object that
  stores nothing yet, before it opens; an object that stores anything ignores it.

## Consequences

- Restore is tested against product-shaped objects: a child table created before its parent, a
  foreign key whose parent column is unique only through an index, a trigger, bytes and stored
  values (`fixture/product-backup.ts`, `e2e/tests/cloudflare-product-backup.spec.ts`).
