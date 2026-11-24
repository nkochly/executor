import { Effect, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { NetworkRefused } from "../contracts/network.ts";
import { ProviderError } from "../contracts/provider-error.ts";
import { defaultMcpClientLimits, McpError, McpToolsOptions } from "../contracts/mcp.ts";
import {
  AppSkills,
  SkillLoadFailed,
  skillLoadLimits,
  type SkillFile,
} from "../contracts/skills.ts";
import { catalogScope } from "./catalog-cache.ts";
import type { McpSkillsOptions } from "../mcp.ts";
import { mcpClientEffect } from "./mcp.ts";
import type { McpRequest } from "./mcp-client.ts";
import { skillFromFiles } from "./skill-files.ts";
import {
  cachedCatalog,
  digest,
  failed,
  parse,
  resourcePath,
  withService,
  type Publication,
} from "./skills.ts";

const directoryMimeType = "inode/directory";
const skillDocument = "SKILL.md";
const maxDirectoryDepth = 8;

const ListedResource = Schema.Struct({ uri: Schema.String, size: Schema.optionalKey(Schema.Int) });
const ListedSkill = Schema.Struct({
  uri: Schema.String,
  frontmatter: Schema.Struct({ name: Schema.String }),
  resources: Schema.Union([Schema.Array(ListedResource), Schema.Literal("dynamic")]),
});
type ListedSkill = typeof ListedSkill.Type;
const SkillsPage = Schema.Struct({
  skills: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optionalKey(Schema.String),
});
const DirectoryPage = Schema.Struct({
  resources: Schema.Array(
    Schema.Struct({ uri: Schema.String, mimeType: Schema.optionalKey(Schema.String) }),
  ),
  nextCursor: Schema.optionalKey(Schema.String),
});
const ResourceContents = Schema.Struct({
  contents: Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      text: Schema.optionalKey(Schema.String),
      blob: Schema.optionalKey(Schema.String),
    }),
  ),
});

const requestFailure = (error: McpError | ProviderError | NetworkRefused) =>
  Schema.is(NetworkRefused)(error)
    ? error
    : new SkillLoadFailed({
        reason:
          Schema.is(ProviderError)(error) && error.reason === "rate_limited"
            ? "rate_limited"
            : "request",
        ...(error.status === undefined ? {} : { status: error.status }),
      });

const sessionFailure = (error: SkillLoadFailed | McpError | ProviderError | NetworkRefused) =>
  Schema.is(SkillLoadFailed)(error) ? error : requestFailure(error);

const pages = <A>(
  request: McpRequest,
  method: string,
  params: Readonly<Record<string, unknown>>,
  decode: (
    value: unknown,
  ) => Effect.Effect<{ items: readonly A[]; next?: string | undefined }, SkillLoadFailed>,
) =>
  Effect.gen(function* () {
    const items: A[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = yield* decode(
        yield* request(method, cursor === undefined ? params : { ...params, cursor }).pipe(
          Effect.mapError(requestFailure),
        ),
      );
      items.push(...page.items);
      cursor = page.next;
      if (cursor !== undefined) {
        if (cursors.has(cursor) || cursors.size >= defaultMcpClientLimits.maxPaginationCursors)
          return yield* failed("source");
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return items;
  });

const skillsExtension = "io.modelcontextprotocol/skills";

const listSkills = (request: McpRequest, extensions: Readonly<Record<string, unknown>>) =>
  extensions[skillsExtension] === undefined
    ? Effect.succeed<readonly ListedSkill[]>([])
    : pages(request, "skills/list", {}, (value) =>
        parse(SkillsPage, value).pipe(
          Effect.map((page) => ({
            items: page.skills.flatMap((entry) =>
              Result.match(Schema.decodeUnknownResult(ListedSkill)(entry), {
                onFailure: () => [],
                onSuccess: (skill) => (skill.uri.endsWith(`/${skillDocument}`) ? [skill] : []),
              }),
            ),
            next: page.nextCursor,
          })),
        ),
      );

const baseOf = (skill: ListedSkill) => skill.uri.slice(0, -skillDocument.length);

const directoryFiles = (request: McpRequest, base: string) =>
  Effect.gen(function* () {
    const files: string[] = [];
    const visit = (
      uri: string,
      depth: number,
    ): Effect.Effect<void, SkillLoadFailed | NetworkRefused> =>
      Effect.gen(function* () {
        if (depth > maxDirectoryDepth) return yield* failed("limit");
        const children = yield* pages(request, "resources/directory/read", { uri }, (value) =>
          parse(DirectoryPage, value).pipe(
            Effect.map((page) => ({ items: page.resources, next: page.nextCursor })),
          ),
        );
        for (const child of children) {
          if (files.length > skillLoadLimits.files) return yield* failed("limit");
          if (child.mimeType === directoryMimeType) yield* visit(child.uri, depth + 1);
          else files.push(child.uri);
        }
      });
    yield* visit(base.slice(0, -1), 0);
    return files;
  });

const decodeText = (blob: string) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.fromResult(Base64.decode(blob)).pipe(
      Effect.mapError(() => failed("encoding")),
    );
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => failed("encoding"),
    });
  });

const readFile = (request: McpRequest, uri: string) =>
  Effect.gen(function* () {
    const result = yield* parse(
      ResourceContents,
      yield* request("resources/read", { uri }).pipe(Effect.mapError(requestFailure)),
    );
    const content = result.contents.find((entry) => entry.uri === uri) ?? result.contents[0];
    if (content === undefined) return yield* failed("document");
    if (content.text !== undefined) return content.text;
    if (content.blob !== undefined) return yield* decodeText(content.blob);
    return yield* failed("document");
  });

const loadSkills = (request: McpRequest, listed: readonly ListedSkill[]) =>
  Effect.gen(function* () {
    let files = 0;
    let bytes = 0;
    const skills = yield* Effect.forEach(
      listed,
      (skill) =>
        Effect.gen(function* () {
          const base = baseOf(skill);
          const uris =
            skill.resources === "dynamic"
              ? yield* directoryFiles(request, base)
              : skill.resources.map((resource) => resource.uri);
          const all = uris.includes(skill.uri) ? uris : [skill.uri, ...uris];
          files += all.length;
          if (files > skillLoadLimits.files) return yield* failed("limit");
          const sources = yield* Effect.forEach(
            all,
            (uri) =>
              Effect.gen(function* () {
                const path = uri.startsWith(base) ? uri.slice(base.length) : "";
                if (!resourcePath(path)) return yield* failed("source");
                const content = yield* readFile(request, uri);
                const size = new TextEncoder().encode(content).byteLength;
                bytes += size;
                if (size > skillLoadLimits.fileBytes || bytes > skillLoadLimits.totalBytes)
                  return yield* failed("limit");
                return { path, content } satisfies SkillFile;
              }),
            { concurrency: skillLoadLimits.concurrency },
          );
          return yield* skillFromFiles(sources, { name: skill.frontmatter.name }).pipe(
            Effect.mapError(() => failed("document")),
          );
        }),
      { concurrency: 1 },
    );
    return yield* parse(AppSkills, skills);
  });

const publication = (
  options: McpSkillsOptions,
  signal: AbortSignal | undefined,
): Effect.Effect<Publication, SkillLoadFailed | NetworkRefused> =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(McpToolsOptions)({
      url: options.url,
      accountId: options.account?.id,
      headers: options.headers,
      signal,
      timeoutMs: options.timeoutMs,
    }).pipe(Effect.mapError(() => failed("source")));
    const client = yield* mcpClientEffect(parsed).pipe(Effect.mapError(requestFailure));
    const listed = yield* client.session(listSkills).pipe(Effect.mapError(sessionFailure));
    const id = listed.some((skill) => skill.resources === "dynamic")
      ? undefined
      : yield* digest(
          listed.map(({ uri, frontmatter, resources }) => [uri, frontmatter, resources]),
        );
    const load =
      listed.length === 0
        ? Effect.succeed<typeof AppSkills.Type>([])
        : client
            .session((request) => loadSkills(request, listed))
            .pipe(Effect.mapError(sessionFailure));
    return { id, load };
  });

export const mcpSkillsEffect = (options: McpSkillsOptions) =>
  Effect.gen(function* () {
    const cache = yield* catalogScope(options, options.headers, () => failed("source"));
    const { cache: _cache, ...rest } = options;
    return yield* cachedCatalog(
      cache === undefined ? rest : { ...rest, cache },
      ["apps/mcpSkills/catalog", 1, options.url],
      (transport) => publication(options, transport.signal),
    );
  }).pipe(withService(URL.canParse(options.url) ? new URL(options.url).hostname : undefined));
