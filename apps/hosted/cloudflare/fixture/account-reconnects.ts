import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { SqlClient } from "effect/sql";
import { sqliteLayer } from "fumadb-effect/sqlite";
import {
  AccountId,
  OwnerId,
  ProviderId,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { markdownRefusals } from "@executor-js/sdk/markdown";
import { memoryRepositories } from "@executor-js/sdk/testing";
import { accountsToReconnect, type AccountToReconnect } from "../src/account-reconnects.ts";

interface Environment {
  readonly PRODUCT: { getByName(name: string): ProductStub };
}

interface ProductStub {
  list(): Promise<readonly AccountToReconnect[]>;
}

const secret = Redacted.make("0".repeat(64));
const organization = Schema.decodeSync(OwnerId)("organization:org_reconnects");
const provider = Schema.decodeSync(ProviderId)("prv_presidio_west");
const definition = {
  name: "Presidio West",
  auth: {
    oauth: { type: "oauth2", discover: "https://muster.test/mcp", response: {} },
    key: { type: "secrets", label: "Key", fields: { token: { type: "string" } } },
  },
};
const accounts = [
  { id: "acc_ended", method: "oauth", label: "Default", grant: "reconnect" },
  { id: "acc_missing", method: "oauth", label: "Never signed in", grant: undefined },
  { id: "acc_renewing", method: "oauth", label: "Renewing", grant: "refresh_1" },
  { id: "acc_secrets", method: "key", label: "Key", grant: undefined },
] as const;

export class Product extends DurableObject<Environment> {
  async list(): Promise<readonly AccountToReconnect[]> {
    const run = Effect.gen(function* () {
      const storage = yield* makeExecutorStorage({ provider: "sqlite" });
      yield* storage.migrate;
      const db = storage.orm("4.0.16");
      yield* db.create("providers", { id: provider, definition });
      for (const account of accounts) {
        yield* db.create("accounts", {
          id: Schema.decodeSync(AccountId)(account.id),
          owner: organization,
          provider,
          method: account.method,
          label: account.label,
          encryptedCredentials: new Uint8Array([1]),
          createdAt: new Date(0),
          credentialGeneration: 0,
        });
        if (account.grant !== undefined)
          yield* db.create("oauthGrants", {
            id: account.id,
            encrypted: new Uint8Array([1]),
            status: account.grant,
            updatedAt: new Date(0),
          });
      }
      const executor = yield* createExecutor({
        database: storage,
        git: memoryRepositories(),
        markdown: markdownRefusals,
        blobs: memoryBlobStore(),
        runtime: runtimeAdapter({} as Parameters<typeof runtimeAdapter>[0]),
        secret,
      });
      return yield* accountsToReconnect(yield* SqlClient.SqlClient, executor.accounts.signIn);
    });
    return Effect.runPromise(
      run.pipe(
        Effect.provide([
          Layer.fresh(sqliteLayer(this.ctx.storage)),
          SecureRandom.layerWebCrypto,
          Digest.layerWebCrypto,
        ]),
        Effect.orDie,
      ),
    );
  }
}

export default {
  async fetch(_request: Request, env: Environment): Promise<Response> {
    return Response.json(await env.PRODUCT.getByName(crypto.randomUUID()).list());
  },
};
