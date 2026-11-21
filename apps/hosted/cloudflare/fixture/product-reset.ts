import { DurableObject } from "cloudflare:workers";
import type { McpBackendCall, WireExit } from "@executor-js/hosted-server";
import { sessionProductBackend } from "../src/mcp-session-product.ts";
import type { ProductNamespace } from "@executor-js/hosted-cloudflare/product-location";
import type { McpSessionEnvironment, McpSessionProduct } from "../src/mcp-session.ts";

interface ResettableProduct extends McpSessionProduct {
  reset(): Promise<void>;
}

interface Environment extends McpSessionEnvironment {
  readonly PRODUCT: ProductNamespace<ResettableProduct>;
  readonly SESSIONS: { getByName(name: string): { call(): Promise<WireExit> } };
}

export class Product extends DurableObject<Environment> {
  async mcpBackend(_request: Request, call: McpBackendCall): Promise<WireExit> {
    return { ok: true, value: call.method };
  }
  async reset(): Promise<void> {
    this.ctx.abort("reset");
  }
}

export class Session extends DurableObject<Environment> {
  #backend: ReturnType<typeof sessionProductBackend> | undefined;
  async call(): Promise<WireExit> {
    this.#backend ??= sessionProductBackend(this.env);
    return this.#backend(new Request("https://session.internal/mcp", { method: "POST" }), {
      method: "listApps",
      args: [],
    });
  }
}

const answer = async (run: () => Promise<unknown>) => {
  try {
    return Response.json({ ok: true, value: await run() });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) });
  }
};

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/reset") return answer(() => env.PRODUCT.getByName("product").reset());
    return answer(() => env.SESSIONS.getByName("session").call());
  },
};
