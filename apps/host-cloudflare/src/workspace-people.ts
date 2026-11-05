import type { D1Database } from "@cloudflare/workers-types";

// ---------------------------------------------------------------------------
// Who a workspace is for. A platform admin can make an agent's workspace ahead
// of time and name the people it is for. When one of them connects an app,
// the sign-in page puts that workspace first and checks it, so Connect joins
// it as the admin set it up. Naming people only orders and checks the choice:
// it never hides a workspace from anyone, and never stops anyone joining one.
// Nobody has to name anyone: without names the page works as before.
// ---------------------------------------------------------------------------

const SCHEMA = `CREATE TABLE IF NOT EXISTS workspace_person (
  slug TEXT NOT NULL,
  email TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, email)
)`;

let schemaReady = false;
const ensureSchema = async (db: D1Database): Promise<void> => {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
};

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** The emails in what an admin typed, lowercase, once each; anything else dropped. */
export const parsePeople = (text: string | readonly string[]): readonly string[] => {
  const parts = typeof text === "string" ? text.split(/[\s,;]+/) : text;
  return [
    ...new Set(parts.map((part) => part.trim().toLowerCase()).filter((part) => EMAIL.test(part))),
  ].sort();
};

/** Every workspace slug with the people it is for. */
export const readWorkspacePeople = async (
  db: D1Database,
): Promise<Map<string, readonly string[]>> => {
  await ensureSchema(db);
  const rows = await db
    .prepare("SELECT slug, email FROM workspace_person ORDER BY slug, email")
    .all<{ slug: string; email: string }>();
  const people = new Map<string, string[]>();
  for (const row of rows.results ?? []) {
    const list = people.get(String(row.slug)) ?? [];
    list.push(String(row.email));
    people.set(String(row.slug), list);
  }
  return people;
};

/** The slugs of the workspaces set up for `email`. */
export const workspacesFor = async (db: D1Database, email: string): Promise<readonly string[]> => {
  await ensureSchema(db);
  const rows = await db
    .prepare("SELECT slug FROM workspace_person WHERE email = ? ORDER BY slug")
    .bind(email.toLowerCase())
    .all<{ slug: string }>();
  return (rows.results ?? []).map((row) => String(row.slug));
};

/** Replace the people a workspace is for. */
export const setWorkspacePeople = async (
  db: D1Database,
  slug: string,
  people: readonly string[],
): Promise<void> => {
  await ensureSchema(db);
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM workspace_person WHERE slug = ?").bind(slug),
    ...parsePeople(people).map((email) =>
      db
        .prepare("INSERT INTO workspace_person (slug, email, updated_at) VALUES (?, ?, ?)")
        .bind(slug, email, now),
    ),
  ]);
};

/**
 * The teams an admin may give a new workspace: each tenant named by a
 * Workspace connection to a first-party server, from the part of the
 * connection's title after " · ".
 */
export const teamsFromConnections = (
  connections: readonly {
    readonly owner: string;
    readonly integration: string;
    readonly title: string | null;
  }[],
  firstPartyIntegrations: readonly string[],
): readonly string[] =>
  [
    ...new Set(
      connections.flatMap((connection) => {
        if (connection.owner !== "org") return [];
        if (!firstPartyIntegrations.includes(connection.integration)) return [];
        if (!connection.title?.includes(" · ")) return [];
        const team = connection.title.split(" · ").at(-1)?.trim();
        return team ? [team] : [];
      }),
    ),
  ].sort((a, b) => a.localeCompare(b));

/** A personal connection a workspace picks: one each person signs in to themselves. */
export interface OwnSignIn {
  readonly integration: string;
  readonly connection: string;
}

/**
 * The personal connections a workspace picks that the person has not signed
 * in to yet. A pattern names a personal connection as
 * `<integration>.user.<connection>.*`; the person has it when one of their own
 * connections has that integration and name.
 */
export const missingOwnSignIns = (
  patterns: readonly string[],
  own: readonly { readonly integration: string; readonly name: string }[],
): readonly OwnSignIn[] => {
  const have = new Set(own.map((row) => `${row.integration}.${row.name}`));
  const missing = new Map<string, OwnSignIn>();
  for (const pattern of patterns) {
    const match = /^([^.*]+)\.user\.([^.*]+)\.\*$/.exec(pattern);
    const integration = match?.[1];
    const connection = match?.[2];
    if (!integration || !connection) continue;
    const key = `${integration}.${connection}`;
    if (!have.has(key)) missing.set(key, { integration, connection });
  }
  return [...missing.values()];
};
