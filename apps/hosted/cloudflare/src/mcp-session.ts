import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, WorkerLoader } from "@cloudflare/workers-types";
import type { McpBackendCall, WireExit } from "@executor-js/hosted-server";
import type { BrowserApprovalAddress } from "@executor-js/mcp/browser";
import type { ProductNamespace } from "@executor-js/hosted-cloudflare/product-location";

export const mcpSessionAccessHeader = "x-executor-mcp-access";

const holdMillis = 30_000;

export interface McpSessionProduct {
  mcpBackend(request: Request, call: McpBackendCall): Promise<WireExit>;
}
export interface McpSessionEnvironment {
  readonly PRODUCT: ProductNamespace<McpSessionProduct>;
  readonly EXECUTOR_PRODUCT_LOCATION?: string;
  readonly LOADER?: WorkerLoader;
}

export interface McpSessionHandle {
  fetch(request: Request): Promise<Response>;
  programs(): number;
  approvalView(caller: string, address: BrowserApprovalAddress): Promise<unknown>;
  approvalAnswer(
    caller: string,
    address: BrowserApprovalAddress,
    response: unknown,
  ): Promise<WireExit>;
}

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
  async #hold() {
    const session = await this.#session();
    if (session.programs() === 0) return;
    const due = Date.now() + holdMillis;
    const set = await this.#state.storage.getAlarm();
    if (set === null || set > due || set < Date.now() - holdMillis)
      await this.#state.storage.setAlarm(due);
  }
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
  async approvalView(caller: string, address: BrowserApprovalAddress): Promise<unknown> {
    return (await this.#session()).approvalView(caller, address);
  }
  async approvalAnswer(
    caller: string,
    address: BrowserApprovalAddress,
    response: unknown,
  ): Promise<WireExit> {
    return (await this.#session()).approvalAnswer(caller, address, response);
  }
}
