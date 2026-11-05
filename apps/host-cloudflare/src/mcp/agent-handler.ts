import { Effect, Predicate } from "effect";

import { loggedMcp } from "./usage";
import {
  authenticated,
  McpAuthProvider,
  jsonRpcErrorBody,
  orgWriteAccessForPrincipal,
  withOrgWriteAccess,
  type AuthOutcome,
  type McpResource,
  type Principal,
} from "@executor-js/host-mcp";
import {
  currentPropagationHeaders,
  readArtifactsEnabled,
  readElicitationMode,
  readSearchToolsEnabled,
  readToolMode,
  withVerifiedIdentityHeaders,
} from "@executor-js/cloudflare/mcp/do-headers";
import type { McpSessionProps } from "@executor-js/cloudflare/mcp/agent-durable-object";
import { sessionOrgRoleMetadata } from "@executor-js/cloudflare/mcp/role-metadata";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";
import {
  classifyDurableObjectError,
  durableObjectFailureResponse,
} from "@executor-js/cloudflare/mcp/durable-object-errors";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { cloudflareAccessMcpAuth } from "./auth";
import { sessionlessProbeAnswer } from "./pre-session";
import { mcpResourceFromPath } from "./resource";
import { checkSessionOwner, logPlatformFailure } from "./session-owner";
import { McpSessionDO } from "./session-durable-object";

const corsPreflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, mcp-session-id, accept, mcp-protocol-version",
      "access-control-expose-headers": "mcp-session-id, WWW-Authenticate",
    },
  });

const jsonRpcResponse = (
  status: number,
  code: number,
  message: string,
  challenge?: string,
): Response =>
  challenge === undefined
    ? jsonRpcErrorBody(status, code, message)
    : jsonRpcErrorBody(status, code, message, { challenge });

const renderAuthError = (
  auth: McpAuthProvider["Service"],
  request: Request,
  outcome: Exclude<AuthOutcome, { readonly _tag: "Authenticated" }>,
): Response => {
  if (Predicate.isTagged(outcome, "Unauthorized")) {
    return jsonRpcResponse(
      401,
      -32001,
      "Unauthorized",
      outcome.challenge ?? `Bearer resource_metadata="${auth.resourceMetadataUrl(request)}"`,
    );
  }
  if (Predicate.isTagged(outcome, "Forbidden")) {
    return jsonRpcResponse(403, outcome.code ?? -32001, outcome.message);
  }
  return jsonRpcResponse(503, -32001, outcome.message);
};

const authenticate = (request: Request, config: CloudflareConfig) =>
  Effect.gen(function* () {
    const auth = yield* McpAuthProvider;
    const outcome = yield* auth.authenticate(request);
    return { auth, outcome };
  }).pipe(Effect.provide(cloudflareAccessMcpAuth(config)));

const propsForPrincipal = (
  request: Request,
  principal: Principal,
  resource: McpResource,
  clientName: string | undefined,
): Effect.Effect<McpSessionProps> =>
  Effect.gen(function* () {
    const propagation = yield* currentPropagationHeaders(request);
    return {
      session: {
        organizationId: principal.organizationId,
        ...sessionOrgRoleMetadata(principal),
        userId: principal.accountId,
        ...(principal.email ? { email: principal.email } : {}),
        ...(clientName ? { clientName } : {}),
        elicitationMode: readElicitationMode(request),
        artifactsEnabled: readArtifactsEnabled(request),
        searchToolsEnabled: readSearchToolsEnabled(request),
        toolMode: readToolMode(request),
        resource,
        webOrigin: new URL(request.url).origin,
      },
      propagation,
    };
  });

export const makeCloudflareMcpAgentHandler = (config: CloudflareConfig) => {
  const serveOptions = {
    binding: "MCP_SESSION",
    transport: "streamable-http",
  } as const;
  const serveDefault = McpSessionDO.serve("/mcp", serveOptions);
  const serveToolkit = McpSessionDO.serve("/mcp/toolkits/:slug", serveOptions);

  // `bound` is a principal the caller already established (Executor's own
  // OAuth token); without it the request's Access assertion decides.
  // `clientName` is that token's registered OAuth client name.
  return async (
    request: Request,
    env: CloudflareEnv,
    ctx: ExecutionContext,
    bound?: Principal,
    clientName?: string,
  ): Promise<Response> => {
    if (request.method === "OPTIONS") return corsPreflightResponse();
    const sessionId = request.headers.get("mcp-session-id");

    const { auth, outcome } = bound
      ? { auth: null, outcome: authenticated(bound) as AuthOutcome }
      : await Effect.runPromise(authenticate(request, config));
    if (!Predicate.isTagged(outcome, "Authenticated")) {
      if (Predicate.isTagged(outcome, "Forbidden") && sessionId) {
        await Effect.runPromise(
          Effect.ignore(
            Effect.tryPromise(() =>
              mcpSessionStub(env.MCP_SESSION, sessionId)._cf_scheduleDestroy(),
            ),
          ),
        );
      }
      return renderAuthError(auth!, request, outcome);
    }

    const resource = mcpResourceFromPath(new URL(request.url).pathname);
    if (resource === null) {
      return jsonRpcResponse(404, -32001, "MCP route not found");
    }

    if (!sessionId && request.method === "DELETE") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
    }

    if (!sessionId) {
      const probe = await sessionlessProbeAnswer(request);
      if (probe) return probe;
    }

    if (sessionId) {
      const owner = await checkSessionOwner(
        env,
        sessionId,
        {
          accountId: outcome.principal.accountId,
          organizationId: outcome.principal.organizationId,
        },
        resource,
      );
      if (typeof owner !== "string") return durableObjectFailureResponse(owner);
      if (owner === "not_found") {
        return jsonRpcResponse(404, -32001, "Session not found");
      }
      if (owner === "terminated") {
        // DELETE-condemned but the deferred destroy alarm hasn't wiped storage
        // yet; the terminated id must read as dead immediately.
        return jsonRpcResponse(404, -32001, "Session timed out, please reconnect");
      }
      if (owner === "forbidden") {
        return jsonRpcResponse(403, -32003, "MCP session does not belong to the current bearer");
      }
    }

    const props = await Effect.runPromise(
      propsForPrincipal(request, outcome.principal, resource, clientName),
    );
    (ctx as ExecutionContext & { props?: McpSessionProps }).props = props;
    const forwarded = withOrgWriteAccess(
      withVerifiedIdentityHeaders(
        request,
        {
          accountId: outcome.principal.accountId,
          organizationId: outcome.principal.organizationId,
        },
        resource,
      ),
      orgWriteAccessForPrincipal(outcome.principal),
    );
    const target = resource.kind === "toolkit" ? serveToolkit : serveDefault;
    return loggedMcp(
      {
        tenant: outcome.principal.organizationSlug ?? outcome.principal.organizationId,
        agent: resource.kind === "toolkit" ? resource.slug : null,
        subject: outcome.principal.email || outcome.principal.accountId,
      },
      request,
      async () => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: the agents SDK throws a platform reset out of the session fetch instead of answering
        try {
          return await target.fetch(forwarded, env, ctx);
        } catch (error) {
          // Not retried: the request may already have run a tool. A reset
          // answers with the protocol envelope the client acts on (retry the
          // same session, or reconnect) instead of an unhandled 500.
          const failure = classifyDurableObjectError(error);
          if (!failure) {
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- adapter boundary: an unrecognized failure is a real defect and must reach the runtime unchanged
            throw error;
          }
          logPlatformFailure(failure, "session_fetch", 1);
          return durableObjectFailureResponse(failure);
        }
      },
    );
  };
};
