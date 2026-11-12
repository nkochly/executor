/**
 * The Cloudflare host's MCP backend wire across releases: a session object and the product can
 * run different releases for minutes after a deploy. The current release carries the execution to
 * the product and the tool call log's reference back; either side of the release before it, which
 * knows neither, still serves and is served. Run by
 * `apps/hosted/cloudflare/scripts/mcp-wire-versions.ts`.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Completed = Schema.Struct({ status: Schema.Literal("completed") });
const Report = Schema.Struct({
  current: Schema.Struct({
    execution: Schema.optional(Schema.String),
    recorded: Schema.optional(Schema.String),
    value: Completed,
  }),
  previousSession: Schema.Struct({
    execution: Schema.optional(Schema.String),
    ok: Schema.Boolean,
    value: Completed,
  }),
  previousProduct: Schema.Struct({ recorded: Schema.optional(Schema.String), value: Completed }),
});

layer(NodeServices.layer)("Cloudflare MCP backend wire", (it) => {
  it.effect(
    "Session objects and the product carry the execution and the call's log reference, and serve the release before them",
    () =>
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* processes.spawn(
          ChildProcess.make("node", ["apps/hosted/cloudflare/scripts/mcp-wire-versions.ts"], {
            extendEnv: true,
          }),
        );
        const line = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((text) => text.startsWith("{")),
          Stream.runHead,
          Effect.timeout("60 seconds"),
        );
        if (line._tag === "None") return yield* Effect.die(new Error("wire check printed nothing"));
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(line.value);
        // Both on this release: the product sees the run, the session object gets the reference.
        expect(report.current.execution).toBe("run_current");
        expect(report.current.recorded).toBe("call_current");
        // A session object of the release before: the call is served, with no execution to record.
        expect(report.previousSession.ok).toBe(true);
        expect(report.previousSession.execution).toBeUndefined();
        // A product of the release before: the call is served, and no reference is invented.
        expect(report.previousProduct.recorded).toBeUndefined();
      }).pipe(Effect.scoped),
    90_000,
  );
});
