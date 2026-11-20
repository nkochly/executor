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
        expect(report.current.execution).toBe("run_current");
        expect(report.current.recorded).toBe("call_current");
        expect(report.previousSession.ok).toBe(true);
        expect(report.previousSession.execution).toBeUndefined();
        expect(report.previousProduct.recorded).toBeUndefined();
      }).pipe(Effect.scoped),
    90_000,
  );
});
