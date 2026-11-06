/**
 * Every program a self-host process runs shares its one thread. Past `EXECUTOR_MCP_MAX_PROGRAMS`
 * programs doing work, a new `execute` is refused at once with a message the agent can act on,
 * and nothing from it runs; once a program ends, the next one is admitted. With
 * `EXECUTOR_MCP_MAX_OUTPUT_BYTES` set, a program's value is cut to that budget and marked.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { startControlledSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { selfHostSsoIdp } from "../support/sso.ts";
import { scenarios } from "../test-plan.ts";

const audience = "synthetic-access-application";
const owner = "owner@program-cap.example.test";

/** A tool result as the protocol carries it. */
const ToolResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
    structuredContent: Schema.optional(Schema.Unknown),
  }),
});

/** The JSON-RPC message in a response that may be SSE or plain JSON. */
const message = (text: string): unknown => {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  return JSON.parse(data.at(-1) ?? text);
};

layer(TestLive, { excludeTestServices: true })("Self-host program cap", (it) => {
  it.effect(scenarios.selfHostProgramCap.title, (context) =>
    withCase(
      context,
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* Browser,
            target = yield* Target,
            evidence = yield* Evidence;
          const instance = yield* startControlledSelfHost(target);
          const origin = instance.metadata.origin;
          // Access signs the caller in, as on Cloudflare, so each request names the owner.
          const team = yield* selfHostSsoIdp(origin);
          yield* Effect.gen(function* () {
            yield* serverControl("stop");
            yield* serverControl("environment", 200, {
              EXECUTOR_ACCESS_TEAM_DOMAIN: new URL(team.issuer).host,
              EXECUTOR_ACCESS_AUD: audience,
              NODE_EXTRA_CA_CERTS: team.certificate,
              EXECUTOR_MCP_MAX_PROGRAMS: "1",
              EXECUTOR_MCP_MAX_OUTPUT_BYTES: "1000",
            });
            yield* serverControl("start");
          }).pipe(Effect.provideService(Target, instance));
          expect(
            yield* browser.use("Set up the instance", (page) =>
              page
                .context()
                .request.post(`${origin}/api/auth/self-host/setup`, {
                  headers: { origin },
                  data: {
                    name: "Synthetic Owner",
                    email: owner,
                    password: "Synthetic-e2e-password-2026",
                    organizationName: "Synthetic Cap",
                  },
                })
                .then((response) => response.status()),
            ),
          ).toBe(200);

          const headers = (session?: string) =>
            Effect.map(team.accessAssertion(owner, audience), (assertion) => ({
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "cf-access-jwt-assertion": assertion,
              "mcp-protocol-version": "2025-06-18",
              ...(session === undefined ? {} : { "mcp-session-id": session }),
            }));
          /** POST one JSON-RPC message as Access forwards it, and read the response's text. */
          const post = (step: string, data: unknown, session?: string) =>
            Effect.gen(function* () {
              const sent = yield* headers(session);
              return yield* browser.use(step, (page) =>
                page
                  .context()
                  .request.post(`${origin}/mcp`, { headers: sent, data, timeout: 60_000 })
                  .then((response) =>
                    response.text().then((text) => ({
                      status: response.status(),
                      session: response.headers()["mcp-session-id"],
                      text,
                    })),
                  ),
              );
            });
          const initialized = yield* post("Initialize an MCP session", {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "program-cap-e2e", version: "1.0.0" },
            },
          });
          expect(initialized.status).toBe(200);
          const session = initialized.session;
          yield* post(
            "Confirm initialization",
            { jsonrpc: "2.0", method: "notifications/initialized" },
            session,
          );
          const execute = (step: string, id: number, code: string) =>
            post(
              step,
              {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name: "execute", arguments: { code } },
              },
              session,
            ).pipe(
              Effect.map(({ text }) => message(text)),
              Effect.flatMap(Schema.decodeUnknownEffect(ToolResult)),
            );

          // One program keeps the only slot busy for a few seconds.
          const busy = yield* Effect.forkChild(
            execute(
              "Run a program that works for five seconds",
              2,
              "const end = Date.now() + 5000; let n = 0; while (Date.now() < end) n++; return 'done';",
            ),
          );
          yield* Effect.sleep("1500 millis");
          const refused = yield* execute(
            "Start a second program while the first works",
            3,
            "return 'second';",
          );
          yield* evidence.json("refused.json", refused);
          expect(refused.result.isError).toBe(true);
          expect(refused.result.content[0]?.text).toContain(
            "Executor is already running 1 programs. Retry in a minute",
          );

          const first = yield* Fiber.join(busy);
          expect(first.result.isError ?? false).toBe(false);
          expect(JSON.stringify(first.result.structuredContent)).toContain("done");

          // The slot is free again, and a value over the output budget comes back cut and marked.
          const admitted = yield* execute(
            "Run a program once the first has ended",
            4,
            "return 'x'.repeat(5000);",
          );
          yield* evidence.json("admitted.json", admitted);
          expect(admitted.result.isError ?? false).toBe(false);
          const text = admitted.result.content[0]?.text ?? "";
          expect(text).toContain("xxxx");
          expect(text).not.toContain("x".repeat(5000));
        }),
      ),
    ),
  );
});
