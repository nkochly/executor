import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolName,
} from "./ids";
import { createExecutor, type IntegrationAccess } from "./executor";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// `ExecutorConfig.integrationAccess` — a host's per-subject catalog list.
// A curated subject sees and personally connects only the listed integrations;
// a subject the host lets add may add one without workspace writes.
// ---------------------------------------------------------------------------

const memoryProvider = (): CredentialProvider => {
  const store = new Map<string, string>();
  return {
    key: ProviderKey.make("memory"),
    writable: true,
    get: (id) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id, value) => Effect.sync(() => void store.set(String(id), value)),
    delete: (id) => Effect.sync(() => void store.delete(String(id))),
    has: (id) => Effect.sync(() => store.has(String(id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => ({ id: ProviderItemId.make(key), name: key })),
      ),
  };
};

const SHOWN = IntegrationSlug.make("shown");
const HIDDEN = IntegrationSlug.make("hidden");
const TEMPLATE = AuthTemplateSlug.make("apiKey");

const demoPlugin = definePlugin(() => ({
  id: "demo" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({ tools: [{ name: ToolName.make("run"), description: "run" }] }),
  invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
  extension: (ctx) => ({
    add: (slug: IntegrationSlug) =>
      ctx.core.integrations.register({ slug, description: String(slug), config: {} }),
  }),
}))();

const curated: IntegrationAccess = { visible: new Set([String(SHOWN)]), canAdd: false };

const setup = (access: IntegrationAccess) =>
  Effect.gen(function* () {
    const config = makeTestConfig({ plugins: [demoPlugin] as const });
    const admin = yield* createExecutor(config);
    const member = yield* createExecutor({
      ...config,
      orgWrites: "denied",
      integrationAccess: () => Effect.succeed(access),
    });
    yield* Effect.addFinalizer(() =>
      admin.close().pipe(Effect.andThen(member.close()), Effect.ignore),
    );
    yield* admin.demo.add(SHOWN);
    yield* admin.demo.add(HIDDEN);
    return { admin, member };
  });

const slugs = (rows: readonly { readonly slug: unknown }[]) => rows.map((row) => String(row.slug));

describe("integrationAccess", () => {
  it.effect("a curated subject sees and connects only its list", () =>
    Effect.gen(function* () {
      const { admin, member } = yield* setup(curated);
      const seen = slugs(yield* member.integrations.list());
      expect(seen).toContain("shown");
      expect(seen).not.toContain("hidden");
      expect(slugs(yield* admin.integrations.list())).toContain("hidden");
      expect(yield* member.integrations.get(HIDDEN)).toBeNull();
      expect(yield* member.integrations.access()).toEqual({ curated: true, canAdd: false });

      yield* member.connections.create({
        owner: "user",
        name: ConnectionName.make("mine"),
        integration: SHOWN,
        template: TEMPLATE,
        value: "token",
      });
      const refused = yield* member.connections
        .create({
          owner: "user",
          name: ConnectionName.make("mine"),
          integration: HIDDEN,
          template: TEMPLATE,
          value: "token",
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "IntegrationNotFoundError" });

      const adding = yield* member.demo.add(IntegrationSlug.make("new")).pipe(Effect.flip);
      expect(adding).toMatchObject({ _tag: "OrgWriteDeniedError" });
    }),
  );

  it.effect("a subject allowed to add adds without workspace writes", () =>
    Effect.gen(function* () {
      const { member } = yield* setup({ visible: "all", canAdd: true });
      expect(yield* member.integrations.access()).toEqual({ curated: false, canAdd: true });
      yield* member.demo.add(IntegrationSlug.make("new"));
      expect(slugs(yield* member.integrations.list())).toContain("new");
    }),
  );
});
