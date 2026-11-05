import type { McpResource } from "@executor-js/host-mcp";
import {
  classifyDurableObjectError,
  type DurableObjectFailure,
} from "@executor-js/cloudflare/mcp/durable-object-errors";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";

import type { CloudflareEnv } from "../config";

type OwnerCheck = "ok" | "not_found" | "forbidden" | "terminated";

/** Attempts at checking a session's owner before a platform reset is answered. */
const OWNER_CHECK_ATTEMPTS = 2;

export const logPlatformFailure = (failure: DurableObjectFailure, step: string, attempt: number) =>
  console.log(
    JSON.stringify({
      event: "mcp_session_platform_failure",
      step,
      kind: failure.kind,
      disposition: failure.disposition,
      attempt,
    }),
  );

/**
 * Check who owns a session, restoring its runtime if it was idle. The check
 * only reads, so a transient platform reset (a deploy retiring the instance,
 * a storage blip) is retried once on a fresh stub, which reaches the
 * replacement instance; the session the client holds carries on.
 * Returns a platform failure that outlived the retry, or rethrows anything
 * the classifier does not recognize.
 */
export const checkSessionOwner = async (
  env: CloudflareEnv,
  sessionId: string,
  owner: { readonly accountId: string; readonly organizationId: string },
  resource: McpResource,
): Promise<OwnerCheck | DurableObjectFailure> => {
  for (let attempt = 1; ; attempt++) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: a Durable Object stub RPC rejects with a plain platform Error, never a typed failure
    try {
      return await mcpSessionStub(env.MCP_SESSION, sessionId).validateMcpSessionOwner(
        owner,
        resource,
      );
    } catch (error) {
      const failure = classifyDurableObjectError(error);
      if (!failure) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: an unrecognized failure is a real defect and must reach the runtime unchanged
        throw error;
      }
      logPlatformFailure(failure, "validate_session_owner", attempt);
      if (failure.disposition !== "transient" || attempt >= OWNER_CHECK_ATTEMPTS) return failure;
    }
  }
};
