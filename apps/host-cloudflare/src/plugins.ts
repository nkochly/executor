import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  googleCatalog,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-openapi/providers/microsoft";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import type { McpPluginOptions } from "@executor-js/plugin-mcp";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

// ---------------------------------------------------------------------------
// The Cloudflare host's plugin list — the same protocol/provider plugins as
// self-host (no WorkOS Vault). Built as a factory because the encrypted-secrets
// master key arrives via `env` at request time (no process.env on a Worker), so
// the plugin set is constructed per app-build with the resolved key. The tuple
// SHAPE (which drives the API + table set) is independent of the key value.
//
// `dangerouslyAllowStdioMCP` is false: a multi-user instance must not let a user
// spawn arbitrary stdio MCP processes.
//
// Agents are workspace toolkits that may pick any connection, personal ones
// included: a personal pick runs as whoever calls the agent, through that
// person's own sign-in of that name, so nobody acts as someone else.
// ---------------------------------------------------------------------------

export const makeCloudflarePlugins = (
  secretKey: string,
  options: {
    readonly activeToolkitSlug?: string;
    readonly allowLocalNetwork?: boolean;
    /** Origins whose MCP connections must be each person's own. */
    readonly personalOnlyOrigins?: readonly string[];
    /** The company catalog, listed first on every tenant's add screen. */
    readonly catalog?: McpPluginOptions["catalog"];
    /** Request `_meta` added to outbound MCP calls (write attribution). */
    readonly callMeta?: McpPluginOptions["callMeta"];
  } = {},
) =>
  [
    openApiHttpPlugin({
      presets: [...googleCatalog, ...microsoftCatalog],
      specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
    }),
    mcpHttpPlugin({
      dangerouslyAllowStdioMCP: false,
      personalOnlyOrigins: options.personalOnlyOrigins,
      catalog: options.catalog,
      callMeta: options.callMeta,
    }),
    graphqlHttpPlugin(),
    toolkitsPlugin({
      activeToolkitSlug: options.activeToolkitSlug,
      workspaceToolkitsTakePersonalConnections: true,
    }),
    encryptedSecretsPlugin({ key: secretKey }),
  ] as const;

export type CloudflarePlugins = ReturnType<typeof makeCloudflarePlugins>;
