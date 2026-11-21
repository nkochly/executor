import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { scenarios } from "../test-plan.ts";

const labelKey = "dev.presidio-west/attribution";
const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const Token = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean }),
});

const labelUpstream = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 })),
    HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Message)),
        );
        if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "labels", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "note",
                      description: "Keep a note",
                      inputSchema: {
                        type: "object",
                        properties: { text: { type: "string" } },
                        required: ["text"],
                      },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                }
              : yield* Ref.update(calls, (previous) => [...previous, message.params ?? {}]).pipe(
                  Effect.as({ content: [{ type: "text", text: "kept" }] }),
                );
        return yield* HttpServerResponse.json({ jsonrpc: "2.0", id: message.id, result });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return { url: `http://127.0.0.1:${server.address.port}/mcp`, calls: Ref.get(calls) };
});

const labelOf = (params: Readonly<Record<string, unknown>> | undefined) => {
  const meta = params?._meta;
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)[labelKey]
    : undefined;
};

layer(HostedLive, { excludeTestServices: true })("MCP caller label", (it) => {
  it.effect(scenarios.mcpCallerLabel.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          mcp = yield* McpClient,
          upstream = yield* labelUpstream;
        const organization = actors.organization.id,
          prefix = `/api/organizations/${organization}`;
        const imported = yield* api.request(actors.owner, "POST", `${prefix}/apps/import`, {
          source: { kind: "mcp", name: `Labels ${randomUUID().slice(0, 8)}`, url: upstream.url },
        });
        expect(imported.status, JSON.stringify(imported.body)).toBe(200);
        const app = yield* body(App, imported);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const token = yield* body(
          Token,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Caller label",
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: token.id })
            .pipe(Effect.orDie),
        );
        const path = `tools[${JSON.stringify(app.slug)}].note`;
        const session = (label: string) => mcp.connect(token.key, label, { organization });
        const note = (
          client: Effect.Success<ReturnType<typeof session>>,
          text: string,
          meta?: Record<string, unknown>,
        ) =>
          client
            .use(`Note ${text}`, (client, signal) =>
              client.callTool(
                {
                  name: "call",
                  arguments: { calls: [{ path, input: { text } }] },
                  ...(meta === undefined ? {} : { _meta: meta }),
                },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Completed)(result.structuredContent),
              ),
              Effect.tap((result) =>
                Effect.sync(() => expect(result.execution.ok, text).toBe(true)),
              ),
            );
        const program = (client: Effect.Success<ReturnType<typeof session>>, text: string) =>
          client
            .use(`Program ${text}`, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: { code: `return await ${path}({ text: ${JSON.stringify(text)} });` },
                },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Completed)(result.structuredContent),
              ),
              Effect.tap((result) =>
                Effect.sync(() => expect(result.execution.ok, text).toBe(true)),
              ),
            );

        const first = yield* session("caller-label-first");
        const second = yield* session("caller-label-second");
        yield* note(first, "first one");
        yield* note(second, "second one");
        yield* program(first, "first two");
        yield* note(second, "second two", { [labelKey]: { agent: "Thread B" } });
        const direct = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          {
            tool: "note",
            kind: "query",
            input: { text: "dashboard" },
          },
        );
        expect(direct.status, JSON.stringify(direct.body)).toBe(200);

        const calls = yield* upstream.calls;
        const byText = new Map(
          calls.map((params) => [
            (params.arguments as { text?: string } | undefined)?.text,
            params,
          ]),
        );
        expect([...byText.keys()].sort()).toEqual(
          ["dashboard", "first one", "first two", "second one", "second two"].sort(),
        );
        const label = (text: string) => labelOf(byText.get(text));
        const firstLabel = label("first one") as { client?: string; agent?: string };
        const secondLabel = label("second one") as { client?: string; agent?: string };
        expect(firstLabel).toEqual({ client: "executor-e2e 1", agent: expect.any(String) });
        expect(secondLabel).toEqual({ client: "executor-e2e 1", agent: expect.any(String) });
        expect(firstLabel.agent).toMatch(/^session [0-9a-f]{8}$/u);
        expect(secondLabel.agent).not.toEqual(firstLabel.agent);
        expect(label("first two")).toEqual(firstLabel);
        expect(label("second two")).toEqual({ client: "executor-e2e 1", agent: "Thread B" });
        expect(label("dashboard")).toBeUndefined();
        for (const params of calls) {
          expect(params.name).toBe("note");
          expect(Object.keys(params.arguments as object)).toEqual(["text"]);
          const meta = params._meta as Record<string, unknown> | undefined;
          expect(Object.keys(meta ?? {}).filter((key) => key !== "progressToken")).toEqual(
            labelOf(params) === undefined ? [] : [labelKey],
          );
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
