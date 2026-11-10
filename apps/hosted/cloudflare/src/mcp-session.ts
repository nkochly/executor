/**
 * One caller's MCP sessions and programs, in a Durable Object of their own. The product names the
 * object by the caller's session key (user, client, organization and grant), authenticates every
 * request before forwarding it, and owns every backend operation: the object holds no database
 * and sends each operation back to the product (`remoteMcpBackend`). A program's work therefore
 * uses this object's thread and memory, not the product's or another caller's.
 *
 * Each `execute` program runs in a Dynamic Worker of its own when `LOADER` is bound (see
 * `program-sandbox.ts`): its CPU and memory are that isolate's, so a heavy program cannot slow
 * another caller's, and it has no network. Without `LOADER` programs run in this object.
 *
 * Protocol state and programs live in memory. An idle object is evicted 70 to 140 seconds after
 * its last event, and a program waiting for a person holds no request, so while the object holds
 * a program it wakes itself every `holdMillis`. Each protocol session's negotiated `initialize` is
 * kept in the object's storage (`mcp-session-store.ts`), so after an eviction, deploy or crash the
 * client continues with the same session id; a program running then is lost, and its resume reads
 * as lost.
 */
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, WorkerLoader } from "@cloudflare/workers-types";
import type { McpBackendCall, WireExit } from "@executor-js/hosted-server";
import type { BrowserApprovalAddress } from "@executor-js/mcp/browser";
import type { ProductNamespace } from "@executor-js/hosted-cloudflare/product-location";

/** The header the product sets on a forwarded request: the caller's access, as encoded JSON. */
export const mcpSessionAccessHeader = "x-executor-mcp-access";

/** How often an object holding a program wakes itself. */
const holdMillis = 30_000;

/** The product operations a session object calls. */
export interface McpSessionProduct {
  mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit>;
}
export interface McpSessionEnvironment {
  readonly PRODUCT: ProductNamespace<McpSessionProduct>;
  readonly EXECUTOR_PRODUCT_LOCATION?: string;
  /** Dynamic Workers; each program runs in one of its own when this is bound. */
  readonly LOADER?: WorkerLoader;
}

/** An open session object's operations (`mcp-session-open.ts`). */
export interface McpSessionHandle {
  fetch(request: Request): Promise<Response>;
  /** How many programs the object holds. */
  programs(): number;
  approvalView(caller: string, address: BrowserApprovalAddress): Promise<unknown>;
  approvalAnswer(
    caller: string,
    address: BrowserApprovalAddress,
    response: unknown,
  ): Promise<WireExit>;
}

/** A caller's MCP protocol sessions and running programs. Reached only through the product. */
export class ExecutorMcpSession extends DurableObject<McpSessionEnvironment> {
  readonly #state: DurableObjectState;
  readonly #env: McpSessionEnvironment;
  #opening: Promise<McpSessionHandle> | undefined;
  constructor(state: DurableObjectState, env: McpSessionEnvironment) {
    super(state, env);
    this.#state = state;
    this.#env = env;
  }
  #session() {
    this.#opening ??= import("./mcp-session-open.ts")
      .then(({ openMcpSession }) => openMcpSession(this.#env, this.#state.storage))
      .catch((error: unknown) => {
        this.#opening = undefined;
        throw error;
      });
    return this.#opening;
  }
  /** While the object holds a program, an alarm is due within `holdMillis`. */
  async #hold() {
    const session = await this.#session();
    if (session.programs() === 0) return;
    const due = Date.now() + holdMillis;
    const set = await this.#state.storage.getAlarm();
    if (set === null || set > due || set < Date.now() - holdMillis)
      await this.#state.storage.setAlarm(due);
  }
  /** Serve one authenticated MCP request the product forwarded. */
  async fetch(request: Request): Promise<Response> {
    const session = await this.#session();
    try {
      return await session.fetch(request);
    } finally {
      await this.#hold();
    }
  }
  async alarm(): Promise<void> {
    await this.#hold();
  }
  /** A pending request for the browser approval page; the product checks the page's access. */
  async approvalView(caller: string, address: BrowserApprovalAddress): Promise<unknown> {
    return (await this.#session()).approvalView(caller, address);
  }
  /** The browser approval page's answer to a pending request. */
  async approvalAnswer(
    caller: string,
    address: BrowserApprovalAddress,
    response: unknown,
  ): Promise<WireExit> {
    return (await this.#session()).approvalAnswer(caller, address, response);
  }
}
