# 0006. SQLite on Durable Object storage

Date: 2026-11-20. Status: accepted.

## Context

Upstream's hosted product runs on PostgreSQL (or PGlite). PGlite does not fit in a Durable Object's
memory, so the Cloudflare host runs the same product on the object's own SQLite storage, and tests
run the same client natively.

## Decision

One client (`packages/fumadb-effect/src/implementation/sqlite.ts`, `sqlite-native.ts`):

- Durable Objects and native hosts run Effect's Durable Object SQL client over one storage
  contract: Cloudflare's `ctx.storage`, or a native SQLite file behind the same `sql.exec` and
  `transaction` shape. Native tests therefore exercise the client a Worker runs. A transaction
  opened inside another is a savepoint, as nested `storage.transaction` calls are in an object.
- A Durable Object refuses `BEGIN`, so code outside Effect SQL that needs its own transactions uses
  `SqliteStorageService`, which shares the client's database but not its connection lock: callers
  hold a reservation of the client while they use it.
- A statement binds at most 100 values (`sqliteMaxParameters`), the Durable Object and D1 limit,
  far below SQLite's own. The native file refuses more too, so a native run cannot hide a failure
  a Worker would hit (`packages/sdk/test/tool-search-store-sqlite.test.ts` writes 30 tools of 9
  values each to prove it).
- Booleans bind as 0 or 1, dates as epoch milliseconds (FumaDB's SQLite temporal encoding),
  undefined as null.
- A Durable Object reports only a failure's message, and node:sqlite its own code; both name
  constraint failures in the message, so the result code Effect classifies by is read from it. A
  primary key conflict is a unique violation, as in PostgreSQL. A unique violation names its
  columns, so the constraint callers match is the table's unique index over exactly those columns.
  Cursors fail with classified errors too, since a cursor may step lazily.
- On a refused native COMMIT (a deferred foreign key) the transaction stays open and is rolled
  back; SQLite may already have rolled it back on a busy or full database. A native run can write
  each refused statement's text, never its values, to a trace file.

Dialect (`dialect.ts`, `sqlite-translate.ts`):

- Shared queries keep one text for both dialects where SQLite reads the PostgreSQL spelling the
  same way once removed: casts to `jsonb`, `json`, `text`, `boolean`, `integer`, `int`, `bigint`;
  `json_build_object`/`jsonb_build_object` as `json_object`; `json_agg`/`jsonb_agg` as
  `json_group_array` (SQLite 3.44 and later order inside aggregates); `gen_random_uuid()` as a
  random version 4 UUID expression; and a trailing row lock, because a SQLite transaction already
  holds the whole database for writing. String literals, quoted identifiers and comments are never
  changed. Anything else, such as `now()`, intervals or jsonb functions, is written per dialect.
- SQLite instants are epoch milliseconds, so comparisons stay numeric. Better Auth's SQLite adapter
  stores instants as ISO 8601 text instead, so its tables have their own `authNow` and
  `authMillis`, truncated as the PostgreSQL driver truncates into a `Date`.
- An advisory lock takes nothing on SQLite, since a transaction already excludes every other
  writer. JSON columns come back as text on SQLite and are parsed; unreadable text is left for the
  caller's schema to refuse.

Hosted tables (`apps/hosted/server/src/implementation/sqlite-schema.ts`, `tool-call-log-dialect.ts`):

- The hosted tables on SQLite are created by one baseline matching PostgreSQL steps 1 to 9. No
  PostgreSQL history is replayed or transferred, so the steps' backfills have nothing to do. JSON
  columns are text. Triggers keep the PostgreSQL functions' effects; a refused API key aborts its
  statement; cascade deletion must not insert an event naming a removed team.
- Upstream writes the tool call log for PostgreSQL only; the fork adds its SQLite half. Callers
  pass and read instants as epoch milliseconds. SQLite folds case for ASCII only in a match. A
  cursor's instant is microsecond text, and on SQLite its microseconds are zero.

Auth database (`packages/mcp-auth/src/implementation/sqlite-database.ts`):

- Better Auth's Kysely driver gets a promise boundary over the host's SQLite client. Each Kysely
  checkout reserves Effect's one connection for its whole transaction, so auth queries cannot join
  or commit another operation's transaction. Transactions open through storage, since an object
  refuses `BEGIN`.
- A Durable Object's own tables (`_cf_KV` and others) refuse reads of their columns. Kysely's
  introspector and Better Auth's index scan both skip them.

PGlite on self-host (`apps/hosted/self-host/src/`):

- A tool call's statements go out as one batch where the database can send them: PGlite runs them
  together under the client's lock, its reads in one snapshot. Not read-only, because a statement
  another caller handed PGlite just before the lock can still run inside the transaction. SQLite
  has no round trip to save and sets no batch. `product.ts` imports no database engine, so a host
  chooses its own.

## Consequences

- Every hosted query must stay within 100 bound values on SQLite.
