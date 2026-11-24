export const mcpSkillsSourcePath = "skills.ts";

export const mcpSkillsSource = `import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { json, type AppCache, type Skill } from "apps"
import { fileSkill } from "apps/skills"

const extension = "io.modelcontextprotocol/skills"
const document = "SKILL.md"
const limits = { files: 1000, fileBytes: 2_000_000, totalBytes: 20_000_000, depth: 8, pages: 100 }

type Listed = {
  readonly uri: string
  readonly frontmatter: { readonly name: string }
  readonly resources: "dynamic" | readonly { readonly uri: string }[]
}
type Answer = Readonly<Record<string, unknown>>
type Request = (method: string, params: Readonly<Record<string, unknown>>) => Promise<Answer>

export interface ServerSkillsOptions {
  readonly url: string
  readonly cache: AppCache
  readonly account?: { readonly id: string }
  readonly headers?: Readonly<Record<string, string>>
}

const record = (value: unknown): value is Answer => typeof value === "object" && value !== null

const listed = (value: unknown): value is Listed =>
  record(value) &&
  typeof value.uri === "string" &&
  value.uri.endsWith("/" + document) &&
  record(value.frontmatter) &&
  typeof value.frontmatter.name === "string" &&
  (value.resources === "dynamic" ||
    (Array.isArray(value.resources) && value.resources.every((entry) => record(entry) && typeof entry.uri === "string")))

const pages = async (request: Request, method: string, params: Answer, field: string) => {
  const items: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < limits.pages; page++) {
    const answer = await request(method, cursor === undefined ? params : { ...params, cursor })
    const list = answer[field]
    if (!Array.isArray(list)) throw new Error(method + " answered without " + field)
    items.push(...list)
    cursor = typeof answer.nextCursor === "string" ? answer.nextCursor : undefined
    if (cursor === undefined) return items
  }
  throw new Error(method + " has too many pages")
}

const directoryFiles = async (request: Request, uri: string, depth: number): Promise<string[]> => {
  if (depth > limits.depth) throw new Error("A skill directory is too deep")
  const files: string[] = []
  for (const child of await pages(request, "resources/directory/read", { uri }, "resources")) {
    if (!record(child) || typeof child.uri !== "string") continue
    if (child.mimeType === "inode/directory") files.push(...(await directoryFiles(request, child.uri, depth + 1)))
    else files.push(child.uri)
  }
  return files
}

const readText = async (request: Request, uri: string) => {
  const { contents } = await request("resources/read", { uri })
  const entries = Array.isArray(contents) ? contents.filter(record) : []
  const content = entries.find((entry) => entry.uri === uri) ?? entries[0]
  if (typeof content?.text === "string") return content.text
  if (typeof content?.blob === "string")
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0)))
  throw new Error("The server sent no text for " + uri)
}

const load = async (request: Request, skills: readonly Listed[]) => {
  let files = 0
  let bytes = 0
  const loaded: Skill[] = []
  for (const skill of skills) {
    const base = skill.uri.slice(0, -document.length)
    const uris =
      skill.resources === "dynamic"
        ? await directoryFiles(request, base.slice(0, -1), 0)
        : skill.resources.map((resource) => resource.uri)
    const all = [skill.uri, ...uris.filter((uri) => uri !== skill.uri && uri.startsWith(base) && !uri.slice(base.length).split("/").includes(".."))]
    files += all.length
    if (files > limits.files) throw new Error("The server's skills have too many files")
    const sources = await Promise.all(
      all.map(async (uri) => {
        const content = await readText(request, uri)
        const size = new TextEncoder().encode(content).byteLength
        bytes += size
        if (size > limits.fileBytes || bytes > limits.totalBytes) throw new Error("The server's skills are too large")
        return { path: uri.slice(base.length), content }
      }),
    )
    const parsed = await fileSkill(sources).catch(() => undefined)
    if (parsed !== undefined && parsed.name === skill.frontmatter.name) loaded.push(parsed)
  }
  return loaded
}

const read = async (options: ServerSkillsOptions, fetch: typeof globalThis.fetch, signal: AbortSignal) => {
  const client = new Client(
    { name: "executor-apps", version: "0.1.0" },
    { capabilities: { extensions: { [extension]: {} } } },
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(options.url), {
      fetch,
      requestInit: { headers: { ...options.headers } },
    }),
    { signal },
  )
  try {
    const extensions: unknown = client.getServerCapabilities()?.extensions
    if (!record(extensions) || extensions[extension] === undefined) return []
    const request: Request = async (method, params) =>
      (await client.request({ method, params: { ...params } }, ResultSchema, { signal })) as Answer
    return await load(request, (await pages(request, "skills/list", {}, "skills")).filter(listed))
  } finally {
    await client.close()
  }
}

export const serverSkills = async (options: ServerSkillsOptions): Promise<readonly Skill[]> => {
  const cache = options.account === undefined ? options.cache : options.cache.forAccount(options.account)
  const skills = await cache.get({
    key: ["serverSkills", 1, options.url],
    schema: json(),
    freshFor: "5 minutes",
    load: async ({ fetch, signal }) => JSON.parse(JSON.stringify(await read(options, fetch, signal))),
  })
  return skills as unknown as readonly Skill[]
}
`;
