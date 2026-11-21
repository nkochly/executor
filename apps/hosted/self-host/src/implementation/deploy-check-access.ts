import type { AuthContext } from "@better-auth/core";
import {
  AuthenticationUnavailable,
  McpAccess,
  OrganizationId,
  organizationOwner,
  recordCaller,
} from "@executor-js/hosted-server";
import { GrantId, type ApprovalMode } from "@executor-js/mcp-auth";
import { Effect, Schema } from "effect";

export const deployCheckEmail = "deploy-check@executor.invalid";
export const deployCheckClient = "proxy:cloudflare-access-deploy-check";

type Adapter = Pick<AuthContext["adapter"], "findOne" | "findMany" | "create">;

const Row = Schema.Struct({ id: Schema.String });
const Organizations = Schema.Array(Schema.Struct({ id: OrganizationId }));

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new AuthenticationUnavailable() });

const decoded = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new AuthenticationUnavailable()),
  );

const ensure = (find: () => Promise<unknown>, create: () => Promise<unknown>) =>
  Effect.gen(function* () {
    const found = yield* attempt(find);
    if (found !== null) return yield* decoded(Row, found);
    const made = yield* attempt(create).pipe(Effect.catch(() => attempt(find)));
    return yield* decoded(Row, made);
  });

export const deployCheckMcpAccess = (adapter: Adapter, mode: ApprovalMode | undefined) =>
  Effect.gen(function* () {
    const organizations = yield* decoded(
      Organizations,
      yield* attempt(() => adapter.findMany({ model: "organization", limit: 2 })),
    );
    const [only] = organizations;
    if (only === undefined || organizations.length !== 1)
      return yield* new AuthenticationUnavailable();
    const organization = only.id;
    const user = yield* ensure(
      () =>
        adapter.findOne({ model: "user", where: [{ field: "email", value: deployCheckEmail }] }),
      () =>
        adapter.create({
          model: "user",
          data: {
            name: "Deploy check",
            email: deployCheckEmail,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
    );
    yield* ensure(
      () =>
        adapter.findOne({
          model: "member",
          where: [
            { field: "userId", value: user.id },
            { field: "organizationId", value: organization },
          ],
        }),
      () =>
        adapter.create({
          model: "member",
          data: {
            organizationId: organization,
            userId: user.id,
            role: "member",
            createdAt: new Date(),
          },
        }),
    );
    const approval = mode ?? "model";
    yield* recordCaller(organization, user.id);
    return McpAccess.make({
      userId: user.id,
      clientId: deployCheckClient,
      grant: {
        id: GrantId.make(`deploy-check:${organization}:${approval}`),
        policy: { kind: "tools", apps: [], approval: "client" },
        target: { kind: "mcp", mode: approval },
      },
      access: { organization, owner: organizationOwner(organization), role: "member" },
    });
  });
