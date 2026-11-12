/**
 * Tool search rows and their BM25 ranking in the executor's own Postgres database. The SQL client
 * stays inside this module; callers see only these operations.
 */
import { Array as Arr, Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { isSqlite, maxParameters, sqliteMaxParameters, SqlJson } from "fumadb-effect/dialect";
import type { SqlError } from "effect/sql/SqlError";
import {
  Json,
  StorageError,
  type AppId,
  type VersionId,
  type OwnerId,
  type ToolName,
} from "../contracts/shared.ts";
import { ToolRouter, ToolSearchListing, type ToolSearchScope } from "../contracts/tools.ts";
import { query, type Query } from "./database.ts";
import { StoredTool } from "./listing-json.ts";

/** One evaluated listing as search rows describe it. */
export interface SearchListingRow {
  readonly listing: ToolSearchListing;
  readonly owner: OwnerId;
  readonly app: AppId;
  readonly version: VersionId;
  /** The digest of the account set the listing was evaluated with; see `toolSearchTarget`. */
  readonly target: string;
  readonly at: number;
  readonly digest: string;
  readonly routers: ReadonlyArray<ToolRouter>;
}

/** One tool of a listing, with the words it ranks by. */
export interface SearchToolRow {
  readonly name: ToolName;
  readonly readOnly: boolean;
  readonly terms: ReadonlyArray<string>;
  readonly signature: string;
  /** The tool as the durable listing text keeps it: shared definitions are positions. */
  readonly tool: StoredTool;
  /** The positions of the definitions its schemas name. */
  readonly definitions: ReadonlyArray<number>;
}

/** A target as the ranking query reads it: its labels are already words. */
export interface RankedTarget {
  readonly listing: ToolSearchListing;
  readonly app: AppId;
  /** The digest of the target's account set; see `toolSearchTarget`. */
  readonly target: string;
  readonly labels: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<ToolSearchScope>;
  readonly below?: string | undefined;
}

const Kept = Schema.Struct({
  at: Schema.Number,
  digest: Schema.String,
  routers: SqlJson(Schema.Array(ToolRouter)),
  superseded: Schema.NullOr(Schema.Number),
});
const Listed = Schema.Struct({ listing: Schema.String });
/** A ranked page as one row: every part of it read in the same statement. */
const Ranked = Schema.Struct({
  total: Schema.Int,
  missing: Schema.Array(Schema.Int),
  items: Schema.Array(
    Schema.Struct({
      target: Schema.Int,
      /** Every target the item merges, in order; the first is `target`. */
      ordinals: Schema.Array(Schema.Int),
      listing: Schema.String,
      tool: StoredTool,
      router: Schema.NullOr(ToolRouter),
    }),
  ),
  definitions: Schema.Array(Schema.Tuple([Schema.String, Schema.Int, Json])),
});
export type RankedPage = typeof Ranked.Type;

/**
 * Rows per insert statement: nine parameters each stays well inside Postgres's bound. A batch
 * also ends once its JSON reaches `batchChars`, so writing a listing holds the JSON text of one
 * batch at a time, plus at most one row larger than the bound, never the whole listing's.
 */
const batchRows = 500;
const batchChars = 1_000_000;

/**
 * How long a listing stays after a newer one of its app and account set was written. An execution
 * searches the listings discovery named for its whole life: at most five minutes of running
 * (`defaultMcpLimits.timeoutMs`) plus the time it waits on approvals, each of which expires
 * after fifteen minutes. An hour covers the run and three approvals in a row; a search after
 * that reports the app unavailable instead of ranking a listing it cannot read.
 */
export const supersededRetentionMillis = 60 * 60_000;

const BM25 = { k1: 1.2, b: 0.75 } as const;

/** A number column read as a float; SQLite returns its stored number as is. */
const float8 = (sql: SqlClient.SqlClient, column: string) =>
  sql.literal(isSqlite(sql) ? column : `${column}::float8`);

export const makeToolSearchStore = (sql: SqlClient.SqlClient) => {
  const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => new StorageError()));
  /** A tool is in a scope when it is read-only under a read-only scope or the scope names it. */
  const inScope = (scope: ToolSearchScope) =>
    sql`(${scope.readOnly ? sql`s.read_only` : sql`false`} or ${
      scope.names.length === 0 ? sql`false` : sql`s.name in ${sql.in(scope.names)}`
    })`;
  /**
   * The targets' rows the scopes permit. Each target's listing must be a row for its app and
   * account set, so a listing named for another target finds nothing.
   */
  const targets = (input: ReadonlyArray<RankedTarget>) => ({
    values: sql.csv(
      input.map(
        (target, index) =>
          sql`(${index}::int, ${target.listing}::text, ${target.app}::text, ${target.target}::text, ${target.labels.join(" ")}::text, ${target.labels.length}::int)`,
      ),
    ),
    permitted: sql.or(
      input.map((target, index) =>
        sql.and([
          sql`t.ordinal = ${index}`,
          ...target.scopes.map(inScope),
          ...(target.below === undefined
            ? []
            : [sql`(s.name = ${target.below} or starts_with(s.name, ${`${target.below}.`}))`]),
        ]),
      ),
    ),
  });
  /**
   * Insert rows in batches bounded by count, bound parameters and JSON size. Each row is encoded only when its
   * batch is built, and a batch is dropped once inserted.
   */
  const insertBatched = <A, R extends Record<string, unknown>>(
    items: ReadonlyArray<A>,
    encode: (item: A, index: number) => { readonly row: R; readonly chars: number },
    insert: (rows: Arr.NonEmptyReadonlyArray<R>) => Effect.Effect<unknown, SqlError>,
  ) =>
    Effect.gen(function* () {
      const parameters = maxParameters(sql);
      let batch: Array<R> = [];
      let chars = 0;
      for (const [index, item] of items.entries()) {
        const encoded = encode(item, index);
        // Every column of every row is one bound parameter.
        const rows = Math.max(1, Math.floor(parameters / Object.keys(encoded.row).length));
        if (
          Arr.isArrayNonEmpty(batch) &&
          (batch.length >= Math.min(batchRows, rows) || chars + encoded.chars > batchChars)
        ) {
          yield* insert(batch);
          batch = [];
          chars = 0;
        }
        batch.push(encoded.row);
        chars += encoded.chars;
      }
      if (Arr.isArrayNonEmpty(batch)) yield* insert(batch);
    });
  /** Delete the tool and definition rows of the listings, in groups SQLite can bind. */
  const removeRows = (listings: ReadonlyArray<ToolSearchListing>) =>
    Effect.gen(function* () {
      for (let start = 0; start < listings.length; start += sqliteMaxParameters) {
        const group = listings.slice(start, start + sqliteMaxParameters);
        yield* sql`delete from executor_tool_search where listing in ${sql.in(group)}`;
        yield* sql`delete from executor_tool_search_definitions where listing in ${sql.in(group)}`;
      }
    });
  /**
   * Mark the target's other listings evaluated before this one superseded, and delete those
   * superseded for longer than an execution may still search them. Listings without a target were
   * kept per profile before 4.0.13, or by the previous server during its deploy; no target is
   * theirs, so each write of the app supersedes and then removes them like its own.
   *
   * Cleanup locks the expired listing rows first and deletes their rows and them by those ids.
   * `revive` and writers update or lock the same listing row, so each either takes it first, and
   * cleanup skips it, or waits for cleanup and finds the listing gone, and writes it again. A
   * listing row never outlives its tool rows.
   */
  const supersede = (row: SearchListingRow, now: number) =>
    Effect.gen(function* () {
      const target = sql`app = ${row.app} and (target = ${row.target} or target is null)`;
      yield* sql`update executor_tool_search_listings set superseded = ${now}
        where ${target} and listing <> ${row.listing} and superseded is null and at < ${row.at}`;
      const expired = yield* sql`select listing from executor_tool_search_listings
        where ${target} and superseded < ${now - supersededRetentionMillis}
        for update skip locked`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
      );
      if (expired.length === 0) return;
      const listings = expired.map((kept) => ToolSearchListing.make(kept.listing));
      yield* removeRows(listings);
      for (let start = 0; start < listings.length; start += sqliteMaxParameters)
        yield* sql`delete from executor_tool_search_listings
          where listing in ${sql.in(listings.slice(start, start + sqliteMaxParameters))}`;
    });
  /**
   * Insert the listing's row, or lock the one that is kept. A kept row cleanup deletes while this
   * waits for it is gone once the lock is granted; the insert is tried again.
   */
  const claim = (
    listing: Record<string, unknown> & { readonly listing: ToolSearchListing },
  ): Effect.Effect<typeof Kept.Type | undefined, SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const inserted = yield* sql`insert into executor_tool_search_listings ${sql.insert(listing)}
        on conflict (listing) do nothing returning listing`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
      );
      if (inserted.length > 0) return undefined;
      const [kept] = yield* sql`select ${float8(sql, "at")} as at, digest, routers,
          ${float8(sql, "superseded")} as superseded
        from executor_tool_search_listings where listing = ${listing.listing} for update`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Kept))),
      );
      return kept ?? (yield* claim(listing));
    });
  return {
    /** The kept rows of a listing of this target, if any. */
    listing: (listing: ToolSearchListing, target: string) =>
      sql`select ${float8(sql, "at")} as at, digest, routers, ${float8(sql, "superseded")} as superseded
        from executor_tool_search_listings where listing = ${listing} and target = ${target}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Kept))),
        Effect.map((rows) => rows[0]),
        failed,
      ),
    /**
     * Keep a superseded listing that a target resolves to again for as long as a current one,
     * so the executions that search it keep finding it.
     */
    revive: (listing: ToolSearchListing) =>
      sql`update executor_tool_search_listings set superseded = null
        where listing = ${listing} returning listing`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Listed))),
        Effect.map((rows) => rows.length > 0),
        failed,
      ),
    /**
     * Keep a listing's rows unless rows of an evaluation that started no earlier are kept. Rows
     * with the same digest only take the newer time. Writers of one listing wait for each other on
     * its row, so a concurrent writer of the same listing finds the first one's rows. Writers of
     * one target take its transaction lock first: each marks the target's other listings
     * superseded, so two writers that each held their own listing row could otherwise wait for
     * each other's. Success means the listing's row, at this evaluation's time or a later one, is
     * committed.
     */
    write: (
      row: SearchListingRow,
      content: {
        readonly tools: ReadonlyArray<SearchToolRow>;
        readonly definitions: ReadonlyArray<Json>;
      },
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const routers = JSON.stringify(row.routers);
        const listing = {
          listing: row.listing,
          owner: row.owner,
          app: row.app,
          deployment: row.version,
          target: row.target,
          at: row.at,
          digest: row.digest,
          routers,
          superseded: null,
        };
        // A SQLite transaction already excludes every other writer.
        if (!isSqlite(sql))
          yield* sql`select pg_advisory_xact_lock(
            hashtext(${row.app}::text), hashtext(${row.target}::text))`;
        const kept = yield* claim(listing);
        if (kept !== undefined) {
          if (kept.at >= row.at) {
            if (kept.superseded !== null)
              yield* sql`update executor_tool_search_listings set superseded = null
                where listing = ${row.listing}`;
            return;
          }
          if (kept.digest === row.digest) {
            yield* sql`update executor_tool_search_listings set at = ${row.at}, superseded = null
              where listing = ${row.listing}`;
            return yield* supersede(row, now);
          }
          yield* sql`update executor_tool_search_listings
            set deployment = ${row.version}, at = ${row.at}, digest = ${row.digest},
              routers = ${routers}, superseded = null
            where listing = ${row.listing}`;
          yield* removeRows([row.listing]);
        }
        yield* insertBatched(
          content.definitions,
          (definition, position) => {
            const json = JSON.stringify(definition);
            return {
              row: {
                id: `${row.listing}:${position}`,
                listing: row.listing,
                position,
                definition: json,
              },
              chars: json.length,
            };
          },
          (rows) => sql`insert into executor_tool_search_definitions ${sql.insert(rows)}`,
        );
        yield* insertBatched(
          content.tools,
          (tool, index) => {
            const json = JSON.stringify(tool.tool);
            const terms = tool.terms.join(" ");
            return {
              row: {
                id: `${row.listing}:${index}`,
                listing: row.listing,
                name: tool.name,
                read_only: tool.readOnly,
                terms,
                length: tool.terms.length,
                signature: tool.signature,
                tool: json,
                definitions: JSON.stringify(tool.definitions),
              },
              chars: json.length + terms.length,
            };
          },
          (rows) => sql`insert into executor_tool_search ${sql.insert(rows)}`,
        );
        yield* supersede(row, now);
      }).pipe(sql.withTransaction, failed),
    /**
     * One page of the targets' tools that match any term, ranked by BM25, or of every tool in
     * target and name order when there are no terms, with everything the page shows. Statistics
     * count the rows the scopes permit, each target's labels counted as words of each of its
     * tools. Tools of one app with the same name and signature merge into one item: when any of
     * their rows matches, the item is at their first permitted target, lists every other
     * permitted target with that tool, and ranks by the best matching row.
     *
     * Ranking and reading the page's tools, definitions and routers are one statement, so they
     * read one snapshot: a page never holds a row the scopes did not rank, even while another
     * evaluation replaces the listing's rows. `missing` names targets whose listing has no rows.
     */
    page: (input: {
      readonly targets: ReadonlyArray<RankedTarget>;
      readonly terms: ReadonlyArray<string>;
      readonly offset: number;
      readonly limit: number;
    }) =>
      Effect.gen(function* () {
        if (input.targets.length === 0)
          return { total: 0, missing: [], items: [], definitions: [] } satisfies RankedPage;
        if (isSqlite(sql)) return yield* sql.withTransaction(sqlitePage(sql, input));
        const { values, permitted } = targets(input.targets);
        const terms = input.terms.join(" ");
        const scored =
          input.terms.length === 0
            ? sql`scored as (select ordinal, id, name, signature, 0::float8 as score from scope)`
            : // Each aggregate is computed once: inlined, Postgres would recount the scope for
              // every matching row.
              sql`q(term) as (select distinct unnest(string_to_array(${terms}::text, ' '))),
              stats as materialized (
                select count(*)::float8 as n, coalesce(nullif(avg(length), 0), 1)::float8 as avgdl
                from scope),
              hits as materialized (
                select scope.ordinal, scope.id, scope.name, scope.signature, scope.length, w.term,
                  count(*)::float8 as tf
                from scope, unnest(scope.own || scope.labels) as w(term)
                where (scope.own && string_to_array(${terms}::text, ' ')
                    or scope.labels && string_to_array(${terms}::text, ' '))
                  and w.term in (select term from q)
                group by scope.ordinal, scope.id, scope.name, scope.signature, scope.length, w.term),
              df as materialized (select term, count(*)::float8 as df from hits group by term),
              scored as (
                select hits.ordinal, hits.id, hits.name, hits.signature,
                  sum(ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5)) * hits.tf * ${BM25.k1 + 1}::float8
                    / (hits.tf + ${BM25.k1}::float8 * (${1 - BM25.b}::float8
                      + ${BM25.b}::float8 * hits.length / stats.avgdl)))::float8 as score
                from hits join df using (term) cross join stats
                group by hits.ordinal, hits.id, hits.name, hits.signature)`;
        const [page] =
          yield* sql`with t(ordinal, listing, app, target, labels, length) as (values ${values}),
          present as (
            select t.ordinal from t
            join executor_tool_search_listings l
              on l.listing = t.listing and l.app = t.app and l.target = t.target),
          scope as materialized (
            select t.ordinal, t.app, s.id, s.name, s.signature, string_to_array(s.terms, ' ') as own,
              string_to_array(t.labels, ' ') as labels, s.length + t.length as length
            from t
            join present using (ordinal)
            join executor_tool_search s on s.listing = t.listing
            where ${permitted}),
          ${scored},
          best as (
            select scope.app, scored.name, scored.signature, max(scored.score) as score
            from scored join scope using (ordinal, id)
            group by scope.app, scored.name, scored.signature),
          merged as (
            select (array_agg(scope.id order by scope.ordinal, scope.id))[1] as id,
              min(scope.ordinal) as target, best.name, best.score,
              array_agg(scope.ordinal order by scope.ordinal, scope.id) as ordinals
            from best
            join scope
              on scope.app = best.app and scope.name = best.name
                and scope.signature = best.signature
            group by best.app, best.name, best.signature, best.score),
          page as (
            select id, target, ordinals,
              row_number() over (order by score desc, target, name collate "C") as rank
            from merged
            order by score desc, target, name collate "C"
            offset ${input.offset} limit ${input.limit}),
          shown as (
            select page.rank, page.target, page.ordinals, s.listing, s.tool, s.definitions,
              l.routers
            from page
            join executor_tool_search s on s.id = page.id
            join executor_tool_search_listings l on l.listing = s.listing)
          select (select count(*) from merged)::int as total,
            coalesce((select json_agg(t.ordinal order by t.ordinal) from t
              where not exists (select 1 from present where present.ordinal = t.ordinal)),
              '[]'::json) as missing,
            coalesce((select json_agg(json_build_object(
                'target', shown.target, 'ordinals', to_json(shown.ordinals),
                'listing', shown.listing, 'tool', shown.tool,
                'router', (select router from json_array_elements(shown.routers) as r(router)
                  where router->>'path' = shown.tool->>'router' limit 1))
              order by shown.rank) from shown), '[]'::json) as items,
            coalesce((select json_agg(json_build_array(d.listing, d.position, d.definition))
              from executor_tool_search_definitions d
              where d.id in (
                select shown.listing || ':' || p.position
                from shown, json_array_elements_text(shown.definitions) as p(position))),
              '[]'::json) as definitions`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Ranked))),
          );
        return page ?? { total: 0, missing: [], items: [], definitions: [] };
      }).pipe(failed),
  };
};
export type ToolSearchStore = ReturnType<typeof makeToolSearchStore>;

const SqliteScopeRow = Schema.Struct({
  id: Schema.String,
  listing: Schema.String,
  name: Schema.String,
  signature: Schema.String,
  terms: Schema.String,
  length: Schema.Number,
  read_only: Schema.Number,
});
const SqliteShownRow = Schema.Struct({
  id: Schema.String,
  listing: Schema.String,
  tool: Schema.String,
  definitions: Schema.String,
  routers: Schema.String,
});
const SqliteDefinitionRow = Schema.Struct({
  listing: Schema.String,
  position: Schema.Int,
  definition: Schema.String,
});

/** Bytewise order, as PostgreSQL's `collate "C"` compares names. */
const utf8 = new TextEncoder();
const bytewise = (left: string, right: string) => {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};

/**
 * Run a read once per group of values small enough to bind in one SQLite statement, and join the
 * rows. Each group's statement binds only that group's values.
 */
const inGroups = <V, A, E, R>(
  values: ReadonlyArray<V>,
  read: (group: ReadonlyArray<V>) => Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  Effect.gen(function* () {
    const rows: Array<A> = [];
    for (let start = 0; start < values.length; start += sqliteMaxParameters)
      rows.push(...(yield* read(values.slice(start, start + sqliteMaxParameters))));
    return rows;
  });

/**
 * The ranked page on SQLite. SQLite has no arrays, `unnest` or guaranteed `ln`, so the statement
 * the PostgreSQL store runs becomes reads of the targets' rows and the same ranking in code. The
 * caller runs it in one transaction, which on SQLite holds the database: every read sees one
 * state, as the single PostgreSQL statement does.
 */
const sqlitePage = (
  sql: SqlClient.SqlClient,
  input: {
    readonly targets: ReadonlyArray<RankedTarget>;
    readonly terms: ReadonlyArray<string>;
    readonly offset: number;
    readonly limit: number;
  },
) =>
  Effect.gen(function* () {
    // Targets whose listing is a row for their app and account set.
    const present = new Set<number>();
    for (const [ordinal, target] of input.targets.entries()) {
      const rows = yield* sql`select 1 as present from executor_tool_search_listings
        where listing = ${target.listing} and app = ${target.app} and target = ${target.target}`;
      if (rows.length > 0) present.add(ordinal);
    }
    const listings = [...new Set([...present].map((ordinal) => input.targets[ordinal]!.listing))];
    const rows =
      listings.length === 0
        ? []
        : yield* inGroups(listings, (group) =>
            sql`select id, listing, name, signature, terms, length, read_only
              from executor_tool_search where listing in ${sql.in(group)}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteScopeRow))),
            ),
          );
    const byListing = new Map<string, Array<typeof SqliteScopeRow.Type>>();
    for (const row of rows)
      byListing.set(row.listing, [...(byListing.get(row.listing) ?? []), row]);
    // The rows each target's scopes permit, with the target's labels as words of each tool.
    const scope = [...present]
      .toSorted((left, right) => left - right)
      .flatMap((ordinal) => {
        const target = input.targets[ordinal]!;
        return (byListing.get(target.listing) ?? [])
          .filter(
            (row) =>
              target.scopes.every(
                (permitted) =>
                  (permitted.readOnly && row.read_only !== 0) ||
                  (permitted.names as ReadonlyArray<string>).includes(row.name),
              ) &&
              (target.below === undefined ||
                row.name === target.below ||
                row.name.startsWith(`${target.below}.`)),
          )
          .map((row) => ({
            ordinal,
            app: target.app,
            id: row.id,
            name: row.name,
            signature: row.signature,
            words: [...(row.terms === "" ? [] : row.terms.split(" ")), ...target.labels],
            length: row.length + target.labels.length,
          }));
      });
    // BM25 over the scope, as the PostgreSQL statement computes it.
    const query = new Set(input.terms);
    const scored = new Map<string, number>();
    if (query.size === 0) for (const row of scope) scored.set(`${row.ordinal}:${row.id}`, 0);
    else {
      const n = scope.length;
      const average = scope.reduce((sum, row) => sum + row.length, 0) / Math.max(n, 1);
      const avgdl = average === 0 ? 1 : average;
      const hits = scope.flatMap((row) => {
        const frequencies = new Map<string, number>();
        for (const word of row.words)
          if (query.has(word)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
        return frequencies.size === 0 ? [] : [{ row, frequencies }];
      });
      const df = new Map<string, number>();
      for (const hit of hits)
        for (const term of hit.frequencies.keys()) df.set(term, (df.get(term) ?? 0) + 1);
      for (const { row, frequencies } of hits) {
        let score = 0;
        for (const [term, tf] of frequencies) {
          const documents = df.get(term)!;
          score +=
            (Math.log(1 + (n - documents + 0.5) / (documents + 0.5)) * tf * (BM25.k1 + 1)) /
            (tf + BM25.k1 * (1 - BM25.b + (BM25.b * row.length) / avgdl));
        }
        scored.set(`${row.ordinal}:${row.id}`, score);
      }
    }
    // One item per app, name and signature that any scored row has, at its first target.
    const best = new Map<string, number>();
    for (const row of scope) {
      const score = scored.get(`${row.ordinal}:${row.id}`);
      if (score === undefined) continue;
      const key = JSON.stringify([row.app, row.name, row.signature]);
      best.set(key, Math.max(best.get(key) ?? Number.NEGATIVE_INFINITY, score));
    }
    const merged = [...best].map(([key, score]) => {
      const [app, name, signature] = JSON.parse(key) as [string, string, string];
      const members = scope
        .filter((row) => row.app === app && row.name === name && row.signature === signature)
        .toSorted((left, right) =>
          left.ordinal !== right.ordinal
            ? left.ordinal - right.ordinal
            : left.id < right.id
              ? -1
              : left.id > right.id
                ? 1
                : 0,
        );
      return {
        id: members[0]!.id,
        target: members[0]!.ordinal,
        ordinals: members.map((row) => row.ordinal),
        name,
        score,
      };
    });
    const page = merged
      .toSorted(
        (left, right) =>
          right.score - left.score || left.target - right.target || bytewise(left.name, right.name),
      )
      .slice(input.offset, input.offset + input.limit);
    const shownRows =
      page.length === 0
        ? []
        : yield* inGroups(
            page.map((item) => item.id),
            (group) =>
              sql`select s.id, s.listing, s.tool, s.definitions, l.routers
                from executor_tool_search s
                join executor_tool_search_listings l on l.listing = s.listing
                where ${sql.in("s.id", group)}`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteShownRow))),
              ),
          );
    const shownById = new Map(shownRows.map((row) => [row.id, row]));
    const items = page.flatMap((item) => {
      const shown = shownById.get(item.id);
      if (shown === undefined) return [];
      const tool = JSON.parse(shown.tool) as { readonly router?: unknown };
      const routers = JSON.parse(shown.routers) as ReadonlyArray<{ readonly path?: unknown }>;
      return [
        {
          target: item.target,
          ordinals: item.ordinals,
          listing: shown.listing,
          tool,
          router: routers.find((router) => router.path === tool.router) ?? null,
          definitions: JSON.parse(shown.definitions) as ReadonlyArray<number>,
        },
      ];
    });
    const definitionIds = items.flatMap((item) =>
      item.definitions.map((position) => `${item.listing}:${position}`),
    );
    const definitions =
      definitionIds.length === 0
        ? []
        : (yield* inGroups(definitionIds, (group) =>
            sql`select listing, position, definition from executor_tool_search_definitions
              where ${sql.in("id", group)}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SqliteDefinitionRow))),
            ),
          )).map((row) => [row.listing, row.position, JSON.parse(row.definition)] as const);
    return yield* Schema.decodeUnknownEffect(Ranked)({
      total: merged.length,
      missing: input.targets.flatMap((_, ordinal) => (present.has(ordinal) ? [] : [ordinal])),
      items: items.map((item) => ({
        target: item.target,
        ordinals: item.ordinals,
        listing: item.listing,
        tool: item.tool,
        router: item.router,
      })),
      definitions,
    });
  });

/** Delete the apps' search rows with the apps, finding their tools through their listings. */
export const removeToolSearch = (tx: Query, apps: ReadonlyArray<AppId>) =>
  Effect.gen(function* () {
    if (apps.length === 0) return;
    const listings = yield* query(() =>
      tx.findMany("toolSearchListings", {
        select: ["listing"],
        where: (b) => b("app", "in", apps),
      }),
    );
    if (listings.length > 0) {
      const ids = listings.map((row) => row.listing);
      yield* query(() => tx.deleteMany("toolSearch", { where: (b) => b("listing", "in", ids) }));
      yield* query(() =>
        tx.deleteMany("toolSearchDefinitions", { where: (b) => b("listing", "in", ids) }),
      );
    }
    yield* query(() => tx.deleteMany("toolSearchListings", { where: (b) => b("app", "in", apps) }));
  });
