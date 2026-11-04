import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";

import {
  COMPANY,
  EVERYTHING,
  isList,
  forgetCatalogState,
  peopleSeen,
  readCatalogState,
  type CatalogState,
} from "./catalog-access";
import type { CloudflareConfig, CloudflareEnv } from "./config";
import { withHostExecutor } from "./new-workspace";
import { agentPeople } from "./platform-admin";

// ---------------------------------------------------------------------------
// `/api/platform/admin/catalog*`: the admin page's catalog lists, who has
// which, and the default for people with none. Platform admins only; the
// caller checks that first.
// ---------------------------------------------------------------------------

const ListBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  integrations: Schema.Array(Schema.String),
});
const decodeList = Schema.decodeUnknownOption(ListBody);
const RemoveBody = Schema.Struct({ id: Schema.String });
const decodeRemove = Schema.decodeUnknownOption(RemoveBody);
const PersonBody = Schema.Struct({ email: Schema.String, list: Schema.NullOr(Schema.String) });
const decodePerson = Schema.decodeUnknownOption(PersonBody);
const DefaultBody = Schema.Struct({ list: Schema.String });
const decodeDefault = Schema.decodeUnknownOption(DefaultBody);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const readBody = (request: Request): Promise<unknown> =>
  Effect.runPromise(
    Effect.tryPromise({ try: () => request.json(), catch: () => "invalid" as const }).pipe(
      Effect.orElseSucceed(() => null),
    ),
  );

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** A short id for a new list, from its name. */
export const listId = (name: string, taken: readonly string[]): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "list";
  let id = base === EVERYTHING || base === COMPANY ? `${base}-list` : base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};

/** Everyone the page offers: seen at sign-in, connected an agent, or given a list. */
export const peopleRows = (
  seen: readonly { readonly email: string; readonly seenAt: number }[],
  connected: Iterable<readonly string[]>,
  state: CatalogState,
): readonly {
  readonly email: string;
  readonly list: string | null;
  readonly seenAt: number | null;
}[] => {
  const rows = new Map<string, number | null>();
  for (const person of seen) rows.set(person.email, person.seenAt);
  for (const emails of connected) {
    for (const email of emails)
      if (!rows.has(email.toLowerCase())) rows.set(email.toLowerCase(), null);
  }
  for (const email of state.people.keys()) if (!rows.has(email)) rows.set(email, null);
  return [...rows]
    .map(([email, seenAt]) => ({ email, list: state.people.get(email) ?? null, seenAt }))
    .sort((a, b) => a.email.localeCompare(b.email));
};

const write = async (db: D1Database, statements: D1PreparedStatement[]) => {
  await db.batch(statements);
  forgetCatalogState();
};

/** `null` when the route is not a catalog one. */
export const handleCatalogAdmin = async (
  route: string,
  request: Request,
  env: CloudflareEnv,
  config: CloudflareConfig,
): Promise<Response | null> => {
  const db = env.DB;
  if (!route.startsWith("GET /catalog") && !route.startsWith("POST /catalog")) return null;

  if (route === "GET /catalog") {
    forgetCatalogState();
    const state = await readCatalogState(db);
    const [seen, connected, integrations] = await Promise.all([
      peopleSeen(db),
      agentPeople(env.OAUTH_KV),
      Effect.runPromise(
        withHostExecutor(env, config, (host) => host.integrations.list()).pipe(
          Effect.map((rows) =>
            rows
              // Executor's own built-in groups are always shown.
              .filter((row) => row.canRemove || row.authMethods.length > 0)
              .map((row) => ({ slug: String(row.slug), name: row.name ?? String(row.slug) }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
          Effect.orElseSucceed(() => []),
        ),
      ),
    ]);
    return json({
      everything: EVERYTHING,
      company: COMPANY,
      defaultList: state.defaultList,
      lists: state.lists,
      people: peopleRows(seen, connected.values(), state),
      admins: config.adminEmails,
      integrations,
    });
  }

  const body = await readBody(request);
  const state = await readCatalogState(db);
  const now = Date.now();

  if (route === "POST /catalog/list") {
    const input = decodeList(body);
    if (Option.isNone(input) || input.value.name.trim().length === 0) {
      return json({ error: "Give the list a name." }, 400);
    }
    const { name, integrations } = input.value;
    const known = state.lists.find((list) => list.id === input.value.id);
    if (input.value.id !== undefined && !known) return json({ error: "No such list." }, 404);
    const id =
      known?.id ??
      listId(
        name,
        state.lists.map((list) => list.id),
      );
    await write(db, [
      db
        .prepare(
          "INSERT INTO catalog_list (id, name, integrations, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, integrations = excluded.integrations, updated_at = excluded.updated_at",
        )
        .bind(id, name.trim(), JSON.stringify([...new Set(integrations)].sort()), now),
    ]);
    return json({ ok: true, id });
  }

  if (route === "POST /catalog/list/remove") {
    const input = decodeRemove(body);
    if (Option.isNone(input) || !state.lists.some((list) => list.id === input.value.id)) {
      return json({ error: "No such list." }, 404);
    }
    const { id } = input.value;
    // People on the list go back to the default; a removed default is the
    // company's list.
    await write(db, [
      db.prepare("DELETE FROM catalog_list WHERE id = ?").bind(id),
      db.prepare("DELETE FROM catalog_person WHERE list_id = ?").bind(id),
      db.prepare("DELETE FROM catalog_setting WHERE key = 'default_list' AND value = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  if (route === "POST /catalog/person") {
    const input = decodePerson(body);
    const email = Option.isSome(input) ? input.value.email.trim().toLowerCase() : "";
    if (Option.isNone(input) || !EMAIL.test(email)) {
      return json({ error: "Give an email address." }, 400);
    }
    const { list } = input.value;
    if (list !== null && !isList(state, list)) return json({ error: "No such list." }, 404);
    await write(db, [
      list === null
        ? db.prepare("DELETE FROM catalog_person WHERE email = ?").bind(email)
        : db
            .prepare(
              "INSERT INTO catalog_person (email, list_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET list_id = excluded.list_id, updated_at = excluded.updated_at",
            )
            .bind(email, list, now),
    ]);
    return json({ ok: true });
  }

  if (route === "POST /catalog/default") {
    const input = decodeDefault(body);
    if (Option.isNone(input) || !isList(state, input.value.list)) {
      return json({ error: "No such list." }, 404);
    }
    await write(db, [
      db
        .prepare(
          "INSERT INTO catalog_setting (key, value) VALUES ('default_list', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .bind(input.value.list),
    ]);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
};
