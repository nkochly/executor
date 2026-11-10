/**
 * Executor on stock Cloudflare Workers. One Durable Object owns the database, auth, sessions and
 * background work, as in the self-host image, with the Durable Object's own SQLite storage as the
 * database and no native helper beside it:
 * - settings come from the Worker's vars and secrets (`configuration.ts`);
 * - the dashboard's browser files are the Worker's static assets (`ASSETS`);
 * - outbound HTTP is the global `fetch`, behind the same URL policy;
 * - requests to this instance's own origin go to the product through `SELF`;
 * - telemetry is logged to the console, which Workers observability collects, unless an OTLP
 *   endpoint is configured;
 * - blobs, app repositories and the app runtime come from `platform.ts`.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import type { McpBackendCall, WireExit } from "@executor-js/hosted-server";
import type { PlatformBindings } from "./platform.ts";
import {
  adoptPreviousStorage,
  exportStoragePage,
  isRetiredProduct,
  previousProduct,
  productLocation,
  productStub,
  type ProductLocationEnvironment,
  type ProductNamespace,
  type RetiredProduct,
  type StorageCursor,
  type StoragePage,
} from "./product-location.ts";

// Only the Durable Objects build the product and the MCP sessions, and each loads its module when
// it first opens: evaluating them at startup exceeds the CPU time Cloudflare allows a Worker to
// start. This module and `mcp-session.ts` import nothing else at run time but
// `product-location.ts`.
export { ExecutorMcpSession } from "./mcp-session.ts";

export interface ProductStub {
  fetch(request: Request): Promise<Response>;
  workflow(request: Request): Promise<Response>;
  mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit>;
}
/** A caller's session object, as the product reaches it. */
interface McpSessionStub {
  fetch(request: Request): Promise<Response>;
  approvalView(caller: string, address: unknown): Promise<unknown>;
  approvalAnswer(caller: string, address: unknown, response: unknown): Promise<WireExit>;
}
export interface Environment extends PlatformBindings, ProductLocationEnvironment {
  readonly PRODUCT: ProductNamespace<ProductStub & RetiredProduct>;
  /** Callers' MCP session objects; used when `EXECUTOR_MCP_SESSIONS` is true. */
  readonly MCP_SESSIONS?: {
    getByName(name: string, options?: { locationHint?: string }): McpSessionStub;
  };
  /** The dashboard's browser files; the Worker runs first, so only the asset manifest is served. */
  readonly ASSETS: Fetcher;
  /** This Worker's own `SelfOrigin` entrypoint, for requests to the dashboard origin. */
  readonly SELF: Fetcher;
}

/**
 * Opening the store runs schema migrations and data steps, which can take longer on a large
 * install than a `blockConcurrencyWhile` callback may run. So the store opens outside it, and
 * every entry point waits for the open product instead.
 */
export class ExecutorProduct
  extends DurableObject<Environment>
  implements ProductStub, RetiredProduct
{
  readonly #state: DurableObjectState;
  readonly #env: Environment;
  /** The unnamed object of an install that names a location: it serves nothing. */
  readonly #retired: boolean;
  #opening: Promise<ProductStub> | undefined;
  constructor(state: DurableObjectState, env: Environment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#retired = isRetiredProduct(state.id, env.PRODUCT, env);
    // Start at once, as after a restart; a failure is reported to the events that wait for it.
    if (!this.#retired) this.#product().catch(() => undefined);
  }
  /** The open product. A failed open releases what it acquired, and the next event retries it. */
  #product() {
    this.#opening ??= this.#open().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }
  async #open() {
    if (productLocation(this.#env) !== undefined) {
      await adoptPreviousStorage(
        this.#state,
        previousProduct(this.#env.PRODUCT),
        this.#env.PRODUCT.idFromName("product").toString(),
      );
      if (this.#env.EXECUTOR_PRODUCT_WIPE_PREVIOUS === "true")
        await previousProduct(this.#env.PRODUCT).wipe();
    }
    const { openProduct } = await import("./product.ts");
    return openProduct(this.#state, this.#env);
  }
  /** Dispatch the authenticated product routes. */
  async fetch(request: Request): Promise<Response> {
    if (this.#retired) return this.#successor().fetch(request);
    return (await this.#product()).fetch(request);
  }
  /** Private workflow callbacks are reached only through the named service entrypoint. */
  async workflow(request: Request): Promise<Response> {
    if (this.#retired) return this.#successor().workflow(request);
    return (await this.#product()).workflow(request);
  }
  /** One backend operation a caller's session object sends for the request it serves. */
  async mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit> {
    if (this.#retired) return this.#successor().mcpBackend(request, call);
    return (await this.#product()).mcpBackend(request, call);
  }
  /** One page of a retired object's storage, for the placed product that succeeds it. */
  async exportPage(cursor: StorageCursor | null): Promise<StoragePage> {
    if (!this.#retired) throw new Error("Only a retired product exports its storage");
    return exportStoragePage(this.#state, cursor);
  }
  /** Delete a retired object's storage once its successor holds a copy. */
  async wipe(): Promise<void> {
    if (!this.#retired) throw new Error("Only a retired product is wiped");
    await this.#state.storage.deleteAlarm();
    await this.#state.storage.deleteAll();
  }
  #successor() {
    return productStub(this.#env.PRODUCT, this.#env);
  }
  /** Restore the background owner after an eviction or restart even when no request arrives. */
  async alarm(): Promise<void> {
    // A retired object keeps no background owner; its alarm ends here.
    if (this.#retired) return;
    await this.#product();
    await this.#state.storage.setAlarm(Date.now() + 30_000);
  }
}

/** Service entrypoint for the app host's workflow callbacks. */
export class WorkflowCallbacks extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    return productStub(this.env.PRODUCT, this.env).workflow(request);
  }
}

/**
 * Requests this instance sends to its own dashboard origin, from app isolates or host egress.
 * They never cross the network, so they carry a fixed internal source instead of any client
 * address header the sender supplied.
 */
export class SelfOrigin extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const internal = new Request(request);
    internal.headers.set("x-executor-client-ip", "127.0.0.1");
    return productStub(this.env.PRODUCT, this.env).fetch(internal);
  }
}

/**
 * Public traffic reaches only the product's authenticated route map. The client address is the
 * one Cloudflare's edge saw; any address header the client sent is replaced.
 */
export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    const addressed = new Request(request);
    addressed.headers.delete("x-executor-client-ip");
    const client = request.headers.get("cf-connecting-ip");
    if (client !== null) addressed.headers.set("x-executor-client-ip", client);
    return productStub(env.PRODUCT, env).fetch(addressed);
  },
};
