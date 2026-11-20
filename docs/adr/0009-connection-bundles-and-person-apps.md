# 0009. Connection bundles and the person's apps

Date: 2026-11-20. Status: accepted.

## Decision

Connection bundles (`apps/hosted/server/src/{contracts,implementation}/connection-bundles.ts`,
`connection-bundle-schema.ts`, `apps/hosted/web/src/implementation/pages/bundles.tsx`):

- An organization's admins define a bundle once (its apps, and per app the tools and events it
  exposes) and give it to groups. Every member of an assigned group holds a copy: an ordinary
  scoped connection in Better Auth's `mcpConnection` table, made by the server, listing the
  bundle's apps and tools and no accounts, so it runs as whatever accounts the member links. Only
  admins change a copy, through its bundle.
- A bundle is reached at `/mcp?connection=<slug>`. Every member of its groups uses the same URL and
  reaches their own copy. The slug is lowercase letters, digits and single hyphens, unique in the
  organization; a name with no letter or digit has none.
- One edit saves the name, the apps and the complete set of groups in one transaction, with the
  revision it was read at, so one admin never overwrites another's change; a conflict keeps the
  admin's draft and commits nothing. A bundle names only apps and groups of its own organization.
- Copies are reconciled after every change that can move them: a bundle write, a group write, and
  each member's own connection list. Reconciling is idempotent; a failure part way leaves rows the
  next reconcile finishes. A copy whose connection was revoked elsewhere is made again under a new
  ID unless its bundle no longer applies. Removing a bundle revokes every copy; a copy's row has no
  foreign key to its bundle and outlives it only until then.
- Giving a bundle to a group shares the bundle's apps with that group; separate rows record which
  shares a bundle added, so taking it away removes only those, and a share an admin made on the
  app's own page is never removed.
- One organization setting decides whether members who are not admins may make connections of
  their own; it is on unless set off. Admins and owners always may use their grants; a member may
  always use a bundle's copy, and anything else only while the setting is on.
- Reads need membership; members see only the setting. Writes and the oversight of every member's
  connections and connected agents need a current admin role. Identifiers are made by the server,
  so the same statements run on PostgreSQL and SQLite.

The person's apps (`apps/hosted/server/src/implementation/person-apps.ts`):

- `GET /api/me/apps[?organization=<id or slug>]` lists every app the caller can use, each account
  slot and whether an account fills it for them now. It names apps, slots and providers only,
  never an account's ID, label or credentials. Read-only, and only as the caller: their membership,
  app access and grant decide, exactly as MCP discovery lists the same apps. A browser page on
  another origin is refused. An app is ready when deployed and every plain slot has an account.

One sign-in serves every app (`e2e/tests/hosted-one-sign-in.spec.ts`):

- Connecting an account for one app's user requirement also links it, for the connecting member,
  to every user requirement of that provider, one() or many(), that has no link of theirs, in every
  other app they may use. A link they already made is never replaced or added to, and apps they may
  not use get nothing.
