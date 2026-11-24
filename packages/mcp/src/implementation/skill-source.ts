import { Effect, Option, Schema } from "effect";
import type { McpServer } from "effect/ai";
import type { McpBackend } from "../contracts/backend.ts";
import { SkillsInput, SkillSummary } from "../contracts/skills.ts";
import { skills } from "./skills.ts";

const skillUri = /^skill:\/\/([^/]+)\/([^/]+)(?:\/(.+))?$/u;
const directoryMimeType = "inode/directory";

const parse = (uri: string) => {
  const match = skillUri.exec(uri);
  return match === null
    ? Option.none()
    : Option.some({ app: match[1]!, name: match[2]!, path: match[3] });
};

const read = <E extends Error>(backend: McpBackend<E>, input: unknown) =>
  Schema.decodeUnknownEffect(SkillsInput)(input).pipe(
    Effect.flatMap((decoded) => skills(decoded, backend)),
    Effect.option,
  );

const mimeTypeFor = (path: string) =>
  path.endsWith(".md")
    ? "text/markdown"
    : path.endsWith(".json")
      ? "application/json"
      : "text/plain";

const entry = (summary: typeof SkillSummary.Type) => {
  const { app, version: _version, revision: _revision, ...frontmatter } = summary;
  return {
    uri: `skill://${app.slug}/${summary.name}/SKILL.md`,
    frontmatter,
    resources: "dynamic" as const,
  };
};

const listed = <E extends Error>(backend: McpBackend<E>, app?: string) =>
  read(backend, app === undefined ? {} : { app }).pipe(
    Effect.map((result) =>
      Option.match(result, {
        onNone: () => [],
        onSome: (value) => ("skills" in value ? value.skills.map(entry) : []),
      }),
    ),
  );

const document = <E extends Error>(
  backend: McpBackend<E>,
  app: string,
  name: string,
  file?: string,
) =>
  read(backend, file === undefined ? { app, name } : { app, name, file }).pipe(
    Effect.map(
      Option.flatMap((value) => ("content" in value ? Option.some(value) : Option.none())),
    ),
  );

export const appSkillSource = <E extends Error>(
  backend: McpBackend<E>,
): McpServer.SkillSourceOptions<never> => ({
  list: listed(backend),
  get: (uri) =>
    Option.match(parse(uri), {
      onNone: () => Effect.succeed(undefined),
      onSome: ({ app, path }) =>
        path === "SKILL.md"
          ? listed(backend, app).pipe(
              Effect.map((entries) => entries.find((skill) => skill.uri === uri)),
            )
          : Effect.succeed(undefined),
    }),
  read: (uri) =>
    Option.match(parse(uri), {
      onNone: () => Effect.succeed(undefined),
      onSome: ({ app, name, path }) =>
        path === undefined
          ? Effect.succeed(undefined)
          : document(backend, app, name, path === "SKILL.md" ? undefined : path).pipe(
              Effect.map(
                Option.match({
                  onNone: () => undefined,
                  onSome: (found) => ({
                    contents: [{ uri, mimeType: mimeTypeFor(path), text: found.content }],
                  }),
                }),
              ),
            ),
    }),
  directory: (uri) =>
    Option.match(parse(uri), {
      onNone: () => Effect.succeed(undefined),
      onSome: ({ app, name, path }) =>
        document(backend, app, name).pipe(
          Effect.map(
            Option.match({
              onNone: () => undefined,
              onSome: (found) => {
                const prefix = path === undefined ? "" : `${path}/`;
                const children = new Map<string, { uri: string; name: string; mimeType: string }>();
                for (const file of ["SKILL.md", ...found.files]) {
                  if (!file.startsWith(prefix)) continue;
                  const [head, ...rest] = file.slice(prefix.length).split("/");
                  if (head === undefined || head === "") continue;
                  const child = `skill://${app}/${name}/${prefix}${head}`;
                  children.set(child, {
                    uri: child,
                    name: head,
                    mimeType: rest.length > 0 ? directoryMimeType : mimeTypeFor(head),
                  });
                }
                return children.size === 0 && path !== undefined
                  ? undefined
                  : [...children.values()];
              },
            }),
          ),
        ),
    }),
});
