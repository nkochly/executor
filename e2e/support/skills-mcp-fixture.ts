import { createServer } from "node:http";
import { createHash } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

const Rpc = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      cursor: Schema.optional(Schema.String),
      uri: Schema.optional(Schema.String),
    }),
  ),
});

export const skillsFixtureDocument = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nRead references/guide.md first.\n`;

const files: Readonly<Record<string, string>> = {
  "skill://fixture/refunds/SKILL.md": skillsFixtureDocument("refunds", "Issue refunds"),
  "skill://fixture/refunds/references/guide.md": "Refunds above 500 need a manager.\n",
  "skill://fixture/onboarding/SKILL.md": skillsFixtureDocument("onboarding", "Onboard a customer"),
  "skill://fixture/onboarding/references/guide.md": "Send the welcome pack.\n",
};

const manifest = (uri: string) => {
  const text = files[uri] ?? "";
  return {
    uri,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    size: Buffer.byteLength(text),
  };
};

const pages = [
  {
    skills: [
      {
        uri: "skill://fixture/refunds/SKILL.md",
        frontmatter: { name: "refunds", description: "Issue refunds" },
        resources: [
          manifest("skill://fixture/refunds/SKILL.md"),
          manifest("skill://fixture/refunds/references/guide.md"),
        ],
      },
    ],
    nextCursor: "page-2",
  },
  {
    skills: [
      {
        uri: "skill://fixture/onboarding/SKILL.md",
        frontmatter: { name: "onboarding", description: "Onboard a customer" },
        resources: "dynamic",
      },
    ],
  },
];

const directories: Readonly<Record<string, ReadonlyArray<{ uri: string; mimeType: string }>>> = {
  "skill://fixture/onboarding": [
    { uri: "skill://fixture/onboarding/SKILL.md", mimeType: "text/markdown" },
    { uri: "skill://fixture/onboarding/references", mimeType: "inode/directory" },
  ],
  "skill://fixture/onboarding/references": [
    { uri: "skill://fixture/onboarding/references/guide.md", mimeType: "text/markdown" },
  ],
};

export const skillsFixtureTool = "lookup_order";

export const skillsMcpFixture = Effect.gen(function* () {
  const methods = yield* Ref.make<ReadonlyArray<string>>([]);
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rpc = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rpc)));
    if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 });
    yield* Ref.update(methods, (seen) => [...seen, rpc.method]);
    const answer = (result: object) =>
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, result });
    const refuse = (code: number, message: string) =>
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: rpc.id, error: { code, message } });
    const uri = rpc.params?.uri ?? "";
    switch (rpc.method) {
      case "initialize":
        return answer({
          protocolVersion: "2025-06-18",
          capabilities: {
            tools: {},
            resources: {},
            extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
          },
          serverInfo: { name: "fixture-skills", version: "1" },
        });
      case "tools/list":
        return answer({
          tools: [
            {
              name: skillsFixtureTool,
              description: "Look up an order",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "skills/list":
        return answer(rpc.params?.cursor === "page-2" ? pages[1]! : pages[0]!);
      case "resources/directory/read": {
        const resources = directories[uri];
        return resources === undefined
          ? refuse(-32602, "Resource not found")
          : answer({ resources: resources.map((entry) => ({ ...entry, name: entry.uri })) });
      }
      case "resources/read": {
        const text = files[uri];
        return text === undefined
          ? refuse(-32602, "Resource not found")
          : answer({ contents: [{ uri, mimeType: "text/markdown", text }] });
      }
      default:
        return refuse(-32601, "Method not found");
    }
  }).pipe(Effect.orDie);
  const services = yield* Layer.build(
    HttpRouter.serve(HttpRouter.add("POST", "/mcp", handler), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The skills MCP fixture requires a TCP listener");
  return { url: `http://127.0.0.1:${server.address.port}/mcp`, methods: Ref.get(methods) };
});
