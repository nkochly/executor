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
