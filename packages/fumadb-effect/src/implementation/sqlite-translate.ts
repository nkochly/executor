/**
 * The PostgreSQL spellings SQLite reads the same way once removed. Shared queries keep one text
 * for both dialects where the only difference is one of these:
 *
 * - Casts to `jsonb`, `json`, `text`, `boolean`, `integer`, `int` and `bigint`. SQLite's `->` and
 *   `->>` read JSON text, `->>` already returns SQL values, and its columns are dynamically typed.
 * - JSON functions SQLite names differently but computes the same: `json_build_object` and
 *   `jsonb_build_object` are `json_object`, `json_agg` and `jsonb_agg` are `json_group_array`
 *   (SQLite 3.44 and later order inside aggregates as PostgreSQL does).
 * - `gen_random_uuid()`, which becomes an expression for a random version 4 UUID.
 * - A trailing row lock (`for update`, `for share`, `for no key update`, `for key share`, with
 *   `of` tables and `skip locked` or `nowait`). A SQLite transaction holds the whole database for
 *   writing, in a Durable Object and in a native file alike, so it already excludes every other
 *   writer that such a lock would.
 *
 * String literals, quoted identifiers and comments are never changed. Anything else that differs,
 * such as `now()`, intervals or jsonb functions, is written per dialect where it is used.
 */
import { sqliteUuid } from "./dialect.ts";

const renamed: Record<string, string> = {
  json_build_object: "json_object",
  jsonb_build_object: "json_object",
  json_agg: "json_group_array",
  jsonb_agg: "json_group_array",
};
const word = /^[A-Za-z_][A-Za-z0-9_]*/u;
const castTypes = /^::(jsonb|json|text|boolean|integer|int|bigint)\b/iu;
const rowLock =
  /\s+for\s+(?:update|share|no\s+key\s+update|key\s+share)(?:\s+of\s+(?:"[^"]+"|\w+)(?:\s*,\s*(?:"[^"]+"|\w+))*)?(?:\s+(?:skip\s+locked|nowait))?\s*;?\s*$/iu;

export const translateForSqlite = (query: string): string => {
  let out = "";
  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    // Copy quoted text (strings, identifiers) whole; '' and "" escape their quote.
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < query.length) {
        if (query[end] === char) {
          if (query[end + 1] === char) end += 2;
          else break;
        } else end++;
      }
      out += query.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "-" && query[index + 1] === "-") {
      const end = query.indexOf("\n", index);
      const stop = end === -1 ? query.length : end;
      out += query.slice(index, stop);
      index = stop;
      continue;
    }
    if (/[A-Za-z_]/u.test(char) && !/[A-Za-z0-9_$.]/u.test(query[index - 1] ?? " ")) {
      const name = word.exec(query.slice(index))![0];
      if (name.toLowerCase() === "gen_random_uuid" && query.startsWith("()", index + name.length)) {
        out += sqliteUuid;
        index += name.length + 2;
        continue;
      }
      const replacement = renamed[name.toLowerCase()];
      out += replacement !== undefined && query[index + name.length] === "(" ? replacement : name;
      index += name.length;
      continue;
    }
    if (char === ":" && query[index + 1] === ":") {
      const cast = castTypes.exec(query.slice(index, index + 12));
      if (cast !== null) {
        index += cast[0].length;
        continue;
      }
    }
    out += char;
    index++;
  }
  return out.replace(rowLock, "");
};
