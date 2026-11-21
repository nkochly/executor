import type { McpBackendCall, WireExit } from "@executor-js/hosted-server";
import { productStub } from "@executor-js/hosted-cloudflare/product-location";
import type { McpSessionEnvironment } from "./mcp-session.ts";

export const sessionProductBackend = (
  env: McpSessionEnvironment,
): ((request: Request, call: McpBackendCall) => Promise<WireExit>) => {
  const product = productStub(env.PRODUCT, env);
  return (request, call) => product.mcpBackend(request, call);
};
