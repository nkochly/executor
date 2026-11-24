/** HTTP MCP helpers. Requires the optional @modelcontextprotocol/sdk peer. */
import type { OperationKinds } from "./implementation/protocol-operations.ts";
import { Effect } from "effect";
import type { McpHealthOptions } from "./contracts/mcp.ts";
import type { AccountCheckContext, AuthMethods } from "./contracts/provider.ts";
import { mcpCatalog, type McpCatalogOptions } from "./implementation/mcp-catalog.ts";
import { mcpHealthEffect } from "./implementation/mcp.ts";
import { mcpSkillsEffect } from "./implementation/mcp-skills.ts";
import type { CatalogAccount } from "./implementation/catalog-cache.ts";
import type { McpToolsOptions } from "./contracts/mcp.ts";
import type { SkillCacheOptions } from "./contracts/skills.ts";

/**
 * The server whose skills to load and whose access reads them: its `url`, and for a server that
 * needs sign-in the `account` and the `headers` that send its credentials. The catalog is kept in
 * that account's scope of `cache`.
 */
export type McpSkillsOptions = Omit<McpToolsOptions, "accountId" | "headers"> &
  SkillCacheOptions &
  CatalogAccount;
export type { McpCatalogOptions } from "./implementation/mcp-catalog.ts";
export {
  McpCredentialsUnverified,
  McpError,
  type McpHealthOptions,
  type McpToolContext,
  type McpToolsOptions,
  type McpToolResult,
} from "./contracts/mcp.ts";

/**
 * A router over a server's tools for the selected account. Its title, description and
 * instructions come from the server. Kinds override uncertain upstream read-only hints.
 */
export const mcpRouter = (options: McpCatalogOptions, kinds: OperationKinds = {}) =>
  Effect.runPromise(
    mcpCatalog(options, kinds),
    options.signal === undefined ? {} : { signal: options.signal },
  );

/**
 * A provider `health` check for an MCP server. Pass the check context `health` receives, then the
 * server's `url` and the `headers` that send the account's credentials:
 * `health: (check) => mcpHealth(check, { url, headers: headers(check.account) })`.
 *
 * It connects with those headers, initializes, and reads the first page of tools, then does the
 * same without any headers. No tool runs. The check passes only when the server accepts the account
 * and refuses the attempt without credentials. A refused account throws `ProviderError`, as HTTP
 * helpers do. An unreachable or unusable server throws `McpError`, and a request Executor's network
 * refuses throws `NetworkRefused`. A server that also answers without credentials, or whose answer
 * to that attempt is not a refusal, throws `McpCredentialsUnverified`. Each of these errors means
 * the check could not verify the account, and the account form explains why. Send credentials only
 * in `headers`; the attempt without them uses the same `url`. The check context's `signal` cancels
 * both attempts, and they share one budget that ends early enough before its `deadline` to report a
 * server that did not answer in time. `timeoutMs` can only shorten that budget.
 */
export const mcpHealth = <Auth extends AuthMethods>(
  check: AccountCheckContext<Auth>,
  options: McpHealthOptions,
): Promise<void> => Effect.runPromise(mcpHealthEffect(check, options), { signal: check.signal });

/**
 * Load the skills an MCP server publishes over the MCP skills extension, as app skills. Pass the
 * same `url`, `account` and `headers` as its `mcpRouter`, and `cache: ctx.cache` to reuse the
 * catalog. Declare it with `dynamicSkills({ list: () => mcpSkills({...}) })` so only skill reads
 * call it. A server without the extension has no skills.
 */
export const mcpSkills = (options: McpSkillsOptions) =>
  Effect.runPromise(
    mcpSkillsEffect(options),
    options.signal === undefined ? {} : { signal: options.signal },
  );

export type { OperationKinds } from "./implementation/protocol-operations.ts";
