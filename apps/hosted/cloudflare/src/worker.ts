import * as workers from "cloudflare:workers";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import type { McpBackendCall, WireExit } from "@executor-js/hosted-server";
import type { PlatformBindings } from "./platform.ts";
import type { AgentReportsBinding } from "./agent-reports.ts";
import type { AccountToReconnect } from "./account-reconnects.ts";
import {
  exportStoragePage,
  isRetiredProduct,
  openPlacedProduct,
  previousProduct,
  productLocation,
  productName,
  productStub,
  type ProductLocationEnvironment,
  type ProductNamespace,
  type RetiredProduct,
  type StorageCursor,
  type StoragePage,
} from "@executor-js/hosted-cloudflare/product-location";
import {
  readBackup,
  restoreInto,
  storesNothing,
  testRestore,
  writeBackup,
  type BackupBucket,
  type RestoreTest,
} from "@executor-js/hosted-cloudflare/backup";
import { traced, type WorkersTracing } from "./trace.ts";

export { ExecutorMcpSession } from "./mcp-session.ts";

export interface ProductStub {
  fetch(request: Request): Promise<Response>;
  workflow(request: Request): Promise<Response>;
  mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit>;
  accountsToReconnect(): Promise<readonly AccountToReconnect[]>;
}
interface RestoreTestStub {
  testRestore(stamp: string): Promise<RestoreTest>;
}
interface McpSessionStub {
  fetch(request: Request): Promise<Response>;
  approvalView(caller: string, address: unknown): Promise<unknown>;
  approvalAnswer(caller: string, address: unknown, response: unknown): Promise<WireExit>;
}
export interface Environment extends PlatformBindings, ProductLocationEnvironment {
  readonly PRODUCT: ProductNamespace<ProductStub & RetiredProduct & RestoreTestStub>;
  readonly BACKUPS?: BackupBucket;
  readonly EXECUTOR_PRODUCT_RESTORE?: string;
  readonly MCP_SESSIONS?: {
    getByName(name: string, options?: { locationHint?: string }): McpSessionStub;
  };
  readonly ASSETS: Fetcher;
  readonly SELF: Fetcher;
  readonly AGENT_REPORTS?: AgentReportsBinding;
}

export class ExecutorProduct
  extends DurableObject<Environment>
  implements ProductStub, RetiredProduct
{
  readonly #state: DurableObjectState;
  readonly #env: Environment;
  readonly #retired: boolean;
  readonly #restoreTest: boolean;
  #opening: Promise<ProductStub | undefined> | undefined;
  constructor(state: DurableObjectState, env: Environment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#retired = isRetiredProduct(state.id, env.PRODUCT, env);
    this.#restoreTest = state.id.equals(env.PRODUCT.idFromName(restoreTestName(env)));
    if (!this.#retired && !this.#restoreTest) this.#product().catch(() => undefined);
  }
  async #product(): Promise<ProductStub> {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    const opened = await this.#opening;
    if (opened !== undefined) return opened;
    this.#opening = undefined;
    return previousProduct(this.#env.PRODUCT);
  }
  async #open(): Promise<ProductStub | undefined> {
    await this.#restoreIfAsked();
    const open = async () => {
      const { openProduct } = await import("./product.ts");
      return openProduct(this.#state, this.#env);
    };
    if (productLocation(this.#env) === undefined) return open();
    return openPlacedProduct({
      state: this.#state,
      env: this.#env,
      previous: previousProduct(this.#env.PRODUCT),
      previousId: this.#env.PRODUCT.idFromName("product").toString(),
      open,
    });
  }
  async fetch(request: Request): Promise<Response> {
    if (this.#retired || this.#restoreTest) return this.#successor().fetch(request);
    return (await this.#product()).fetch(request);
  }
  async workflow(request: Request): Promise<Response> {
    if (this.#retired || this.#restoreTest) return this.#successor().workflow(request);
    return (await this.#product()).workflow(request);
  }
  async mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit> {
    if (this.#retired || this.#restoreTest) return this.#successor().mcpBackend(request, call);
    return (await this.#product()).mcpBackend(request, call);
  }
  async accountsToReconnect(): Promise<readonly AccountToReconnect[]> {
    if (this.#retired || this.#restoreTest) return this.#successor().accountsToReconnect();
    return (await this.#product()).accountsToReconnect();
  }
  async exportPage(cursor: StorageCursor | null): Promise<StoragePage> {
    if (!this.#retired) throw new Error("Only a retired product exports its storage");
    return exportStoragePage(this.#state, cursor);
  }
  async wipe(): Promise<void> {
    if (!this.#retired) throw new Error("Only a retired product is wiped");
    await this.#state.storage.deleteAlarm();
    await this.#state.storage.deleteAll();
  }
  #successor() {
    return productStub(this.#env.PRODUCT, this.#env);
  }
  async alarm(): Promise<void> {
    if (this.#retired || this.#restoreTest) return;
    await this.#product();
    await this.#state.storage.setAlarm(Date.now() + 30_000);
    await this.#backUpIfDue().catch((error: unknown) =>
      console.error(JSON.stringify({ event: "product_backup_failed", error: String(error) })),
    );
  }
  async #backUpIfDue(now = Date.now()): Promise<void> {
    const bucket = this.#env.BACKUPS;
    if (bucket === undefined) return;
    const last = this.#state.storage.kv.get(backupAtKey);
    if (typeof last === "number" && now - last < backupInterval) return;
    const manifest = await writeBackup(bucket, productName(this.#env), this.#state, { now });
    this.#state.storage.kv.put(backupAtKey, now);
    const hint = productLocation(this.#env);
    const test = await this.#env.PRODUCT.getByName(
      restoreTestName(this.#env),
      hint === undefined ? {} : { locationHint: hint },
    ).testRestore(manifest.stamp);
    console.log(JSON.stringify({ event: "product_backup", ...test }));
  }
  async testRestore(stamp: string): Promise<RestoreTest> {
    if (!this.#restoreTest) throw new Error("Only the restore test object restores a test copy");
    const bucket = this.#env.BACKUPS;
    if (bucket === undefined) throw new Error("No BACKUPS bucket is bound");
    try {
      return await testRestore(this.#state, bucket, productName(this.#env), stamp);
    } finally {
      await this.#state.storage.deleteAlarm();
      await this.#state.storage.deleteAll();
    }
  }
  async #restoreIfAsked(): Promise<void> {
    const asked = this.#env.EXECUTOR_PRODUCT_RESTORE?.trim();
    const bucket = this.#env.BACKUPS;
    if (!asked || bucket === undefined || !storesNothing(this.#state)) return;
    const { manifest, pages } = await readBackup(
      bucket,
      productName(this.#env),
      asked === "latest" ? undefined : asked,
    );
    restoreInto(this.#state, pages);
    console.log(JSON.stringify({ event: "product_restored", stamp: manifest.stamp }));
  }
}

const backupAtKey = "executor:backup-at";
const backupInterval = 24 * 60 * 60 * 1000;
const restoreTestName = (env: ProductLocationEnvironment) => `restore-test:${productName(env)}`;

export class WorkflowCallbacks extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    return productStub(this.env.PRODUCT, this.env).workflow(request);
  }
}

export class SelfOrigin extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const internal = new Request(request);
    internal.headers.set("x-executor-client-ip", "127.0.0.1");
    return productStub(this.env.PRODUCT, this.env).fetch(internal);
  }
}

export class AccountReconnects extends WorkerEntrypoint<Environment> {
  async list(): Promise<readonly AccountToReconnect[]> {
    return productStub(this.env.PRODUCT, this.env).accountsToReconnect();
  }
}

const tracing = (workers as { tracing?: WorkersTracing }).tracing;

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    const addressed = new Request(request);
    addressed.headers.delete("x-executor-client-ip");
    const client = request.headers.get("cf-connecting-ip");
    if (client !== null) addressed.headers.set("x-executor-client-ip", client);
    return traced(tracing, addressed, (forwarded) =>
      productStub(env.PRODUCT, env).fetch(forwarded),
    );
  },
};
