import type { D1Database } from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";

import { TENANT_DEFAULTS_SUBJECT } from "@executor-js/api/server";
import type { IntegrationAccess } from "@executor-js/sdk";

import type { CloudflareConfig } from "./config";
import { isOperator } from "./tenancy";

// ---------------------------------------------------------------------------
// Who sees which integrations. Platform admins keep named catalog lists, each
// a set of the company's integrations, and give each person one. The built-in
// "Everything" list sees every integration and may add new ones from the open
// catalog; any other list sees only its integrations and adds none. A person
// with no list gets the default list, which is Everything until an admin
// picks another. Admins always have Everything.
//
// A list hides an integration from the person's console and refuses their own
// connections to it. A workspace's connections are the workspace's to pick.
// ---------------------------------------------------------------------------

/** The built-in list: every integration, and adding new ones. */
export const EVERYTHING = "everything";

export interface CatalogList {
  readonly id: string;
  readonly name: string;
  readonly integrations: readonly string[];
}

export interface CatalogState {
  readonly lists: readonly CatalogList[];
  /** Person email (lowercase) to list id. */
  readonly people: ReadonlyMap<string, string>;
  /** The list a person with none gets. */
  readonly defaultList: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS catalog_list (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  integrations TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS catalog_person (
  email TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS catalog_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS person_seen (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  seen_at INTEGER NOT NULL
)`,
];

let schemaReady = false;
const ensureSchema = async (db: D1Database): Promise<void> => {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
};

const decodeSlugs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const parseSlugs = (text: string): readonly string[] =>
  Option.getOrElse(decodeSlugs(text), () => []);

// A person's console may show the old list up to this long after a change.
const TTL_MS = 30_000;
let cachedState: { readonly at: number; readonly state: CatalogState } | null = null;

/** Forget this isolate's copy, after an admin change. */
export const forgetCatalogState = (): void => {
  cachedState = null;
};

export const readCatalogState = async (db: D1Database): Promise<CatalogState> => {
  if (cachedState && Date.now() - cachedState.at < TTL_MS) return cachedState.state;
  await ensureSchema(db);
  const [lists, people, setting] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, name, integrations FROM catalog_list ORDER BY name"),
    db.prepare("SELECT email, list_id FROM catalog_person"),
    db.prepare("SELECT value FROM catalog_setting WHERE key = 'default_list'"),
  ]);
  const state: CatalogState = {
    lists: (lists?.results ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      integrations: parseSlugs(String(row.integrations)),
    })),
    people: new Map(
      (people?.results ?? []).map((row) => [String(row.email), String(row.list_id)] as const),
    ),
    defaultList: setting?.results[0] ? String(setting.results[0].value) : EVERYTHING,
  };
  cachedState = { at: Date.now(), state };
  return state;
};

/** The list a person has: their own, else the default, else Everything. */
export const listOf = (state: CatalogState, email: string | null): string => {
  const known = (id: string | undefined) =>
    id !== undefined && (id === EVERYTHING || state.lists.some((list) => list.id === id));
  const own = email ? state.people.get(email.toLowerCase()) : undefined;
  if (known(own)) return own!;
  return known(state.defaultList) ? state.defaultList : EVERYTHING;
};

const EVERYTHING_ACCESS: IntegrationAccess = { visible: "all", canAdd: true };

/** What a person may see and add, given whether they are an admin. */
export const accessFor = (
  state: CatalogState,
  email: string | null,
  admin: boolean,
): IntegrationAccess => {
  if (admin) return EVERYTHING_ACCESS;
  const id = listOf(state, email);
  if (id === EVERYTHING) return EVERYTHING_ACCESS;
  const list = state.lists.find((l) => l.id === id);
  return { visible: new Set(list?.integrations ?? []), canAdd: false };
};

// ---------------------------------------------------------------------------
// The account id an executor acts as is Access's `sub`, not an email, so the
// host keeps the pairing it sees at every sign-in.
// ---------------------------------------------------------------------------

const RECORD_EVERY_MS = 60 * 60_000;
const recorded = new Map<string, number>();

/** Remember which email an account id belongs to. Never fails. */
export const recordPerson = (
  db: D1Database,
  accountId: string,
  email: string,
): Effect.Effect<void> => {
  const lower = email.trim().toLowerCase();
  if (!accountId || !lower.includes("@")) return Effect.void;
  const key = `${accountId} ${lower}`;
  const last = recorded.get(key);
  if (last !== undefined && Date.now() - last < RECORD_EVERY_MS) return Effect.void;
  return Effect.tryPromise(async () => {
    await ensureSchema(db);
    await db
      .prepare(
        "INSERT INTO person_seen (account_id, email, seen_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at",
      )
      .bind(accountId, lower, Date.now())
      .run();
    recorded.set(key, Date.now());
  }).pipe(Effect.ignore);
};

const emails = new Map<string, { readonly at: number; readonly email: string | null }>();

const emailOf = async (db: D1Database, subject: string): Promise<string | null> => {
  if (subject.includes("@")) return subject.toLowerCase();
  const known = emails.get(subject);
  if (known && Date.now() - known.at < TTL_MS) return known.email;
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT email FROM person_seen WHERE account_id = ?")
    .bind(subject)
    .first<{ email: string }>();
  emails.set(subject, { at: Date.now(), email: row?.email ?? null });
  return row?.email ?? null;
};

/** Everyone the host has seen sign in, newest first. */
export const peopleSeen = async (
  db: D1Database,
): Promise<readonly { readonly email: string; readonly seenAt: number }[]> => {
  await ensureSchema(db);
  const rows = await db
    .prepare("SELECT email, MAX(seen_at) AS seen_at FROM person_seen GROUP BY email")
    .all<{ email: string; seen_at: number }>();
  return rows.results.map((row) => ({ email: row.email, seenAt: Number(row.seen_at) }));
};

/** Whether `email` is a platform admin or a console admin. */
export const isCatalogAdmin = (config: CloudflareConfig, email: string): Effect.Effect<boolean> =>
  config.adminEmails.includes(email)
    ? Effect.succeed(true)
    : config.operatorDirectory
      ? isOperator(config.operatorDirectory, email)
      : Effect.succeed(false);

/**
 * `ExecutorConfig.integrationAccess` for this host. A person whose lists
 * cannot be read sees nothing until they can; admins are unaffected.
 */
export const makeIntegrationAccess =
  (db: D1Database, config: CloudflareConfig) =>
  (subject: string | null): Effect.Effect<IntegrationAccess> => {
    // The host itself (starting sets, tenant defaults) and subjectless
    // executors are not people.
    if (subject === null || subject === TENANT_DEFAULTS_SUBJECT) {
      return Effect.succeed(EVERYTHING_ACCESS);
    }
    return Effect.gen(function* () {
      const email = yield* Effect.tryPromise(() => emailOf(db, subject)).pipe(
        Effect.orElseSucceed(() => null),
      );
      const admin = email ? yield* isCatalogAdmin(config, email) : false;
      if (admin) return EVERYTHING_ACCESS;
      return yield* Effect.tryPromise(() => readCatalogState(db)).pipe(
        Effect.map((state) => accessFor(state, email, false)),
        Effect.orElseSucceed((): IntegrationAccess => ({ visible: new Set(), canAdd: false })),
      );
    });
  };
