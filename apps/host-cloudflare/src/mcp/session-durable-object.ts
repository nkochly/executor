import { Data, Effect, Fiber } from "effect";

import { timeoutDrillTools } from "./timeout-drill";

import {
  PAUSED_APPROVAL_TIMEOUT_MS,
  createExecutorMcpServer,
} from "@executor-js/host-mcp/tool-server";
import { buildResumeApprovalUrl } from "@executor-js/host-mcp/browser-approval";
import { artifactUrlFor } from "@executor-js/host-mcp/create-artifact";
import { makeAssetsShellHtmlLoader } from "@executor-js/mcp-apps-shell/worker";
import { smokeRenderArtifact } from "@executor-js/mcp-apps-shell/smoke-render";
import type { ExecutorDbHandle } from "@executor-js/api/server";
import {
  McpAgentSessionDOBase,
  type BuiltMcpServer,
  type McpModelResumeCaller,
  type McpSessionModelResumeResult,
  type McpSessionInit,
  type SessionMeta,
} from "@executor-js/cloudflare/mcp/agent-durable-object";
import { sessionOrgRoleMetadata } from "@executor-js/cloudflare/mcp/role-metadata";
import {
  mcpExecutionOwnerDirectoryFromNamespace,
  type McpExecutionOwnerDirectory,
  type McpExecutionOwnerRoute,
} from "@executor-js/cloudflare/mcp/execution-owner-directory";
import { mcpSessionStub } from "@executor-js/cloudflare/mcp/session-stub";
import type { ResumeResponse } from "@executor-js/execution";

import { loadConfig, type CloudflareConfig, type CloudflareEnv } from "../config";
import { createD1ExecutorDb } from "../db/d1";
import { makeCloudflareExecutionStackLayer, makeExecutionStack } from "../execution";
import { agentHasCoreTools, ensureAgentToolkit } from "../agent";
import { startWorkspace, withHostExecutor } from "../new-workspace";
import { makeAttributionMeta } from "../attribution";
import { catalogIntegrations, refreshCatalog, unservedCatalogIntegrations } from "../platform";
import { readTeamPage, readTeamPages, sessionInstructions, type TeamPage } from "../tenancy";
import { preloadQuickJs } from "../quickjs";
import { sharedTeamPages } from "../team-page-cache";

// ---------------------------------------------------------------------------
// Cloudflare (self-host) MCP Session Durable Object — the host-cloudflare
// binding of the shared `McpAgentSessionDOBase` (@executor-js/cloudflare). Identical
// base to cloud; the ONLY differences are the injected dependencies:
//   - openSessionDb     → a long-lived D1 `ExecutorDbHandle` (same FumaDB
//                         assembly the HTTP path uses), adapted to the base's
//                         `end` disposal contract.
//   - resolveSessionMeta → single-tenant: the org is fixed in config, so no
//                         lookup — just stamp the configured org name.
//   - buildMcpServer    → the QuickJS execution stack + the MCP tool server.
// host-cf has no OTel/Sentry, so it keeps the base's default no-op telemetry +
// error seams. Replacing the prior in-memory store with this DO is what fixes
// `tools/list` failing across Worker isolates (a session created on one isolate
// was invisible to the next; the DO id == session id routes them all back).
// ---------------------------------------------------------------------------

// The long-lived D1 handle, adapted to the base's `end` contract. D1 owns its
// own lifecycle (the binding is the connection), so `end` is `close` — a no-op.
type CfSessionDbHandle = ExecutorDbHandle & { readonly end: () => Promise<void> };

class McpModelResumeForwardError extends Data.TaggedError("McpModelResumeForwardError")<{
  readonly cause: unknown;
}> {}

export class McpSessionDO extends McpAgentSessionDOBase<CloudflareEnv, CfSessionDbHandle> {
  private readonly cfEnv: CloudflareEnv;
  private readonly cfConfig: CloudflareConfig;
  /**
   * The `ui://executor/shell.html` document, over the ASSETS binding: a
   * deployed Worker has no filesystem, so the shell is the stable-named asset
   * the SPA build emitted into `./dist` (`mcpAppsShellAsset`). No dev-mode
   * escape hatch here, unlike cloud: this Worker is bundled by wrangler, not
   * Vite, and `wrangler dev` serves the same built `./dist` the binding reads.
   */
  private readonly loadAppShellHtml: () => Promise<string>;
  /** When this instance started, and how long opening its db took: logged
   *  with the first `init`, beside the build's own step times. */
  private readonly constructedAt = Date.now();
  private openDbMs: number | null = null;

  constructor(
    ctx: ConstructorParameters<typeof McpAgentSessionDOBase<CloudflareEnv, CfSessionDbHandle>>[0],
    env: CloudflareEnv,
  ) {
    super(ctx, env);
    this.cfEnv = env;
    this.cfConfig = loadConfig(env);
    this.loadAppShellHtml = makeAssetsShellHtmlLoader({ assets: env.ASSETS });
  }

  protected override executionOwnerDirectory(): McpExecutionOwnerDirectory | null {
    return mcpExecutionOwnerDirectoryFromNamespace(this.cfEnv.MCP_EXECUTION_OWNER);
  }

  protected override supportsCapEviction(): boolean {
    return true;
  }

  protected override requestSelfEviction(): Promise<void> {
    // Routed through this session's OWN stub (never a direct in-process call)
    // so `requestCapEviction`'s teardown runs under an IoContext scoped to
    // this request, not whatever request happened to trigger the eviction
    // check — see the base class's `requestSelfEviction` doc comment.
    return mcpSessionStub(this.cfEnv.MCP_SESSION, this.sessionId).requestCapEviction();
  }

  protected override forwardModelResumeToOwner(
    owner: McpExecutionOwnerRoute,
    identity: McpModelResumeCaller,
    executionId: string,
    response: ResumeResponse,
  ): Effect.Effect<McpSessionModelResumeResult, unknown> {
    return Effect.tryPromise({
      try: () =>
        mcpSessionStub(this.cfEnv.MCP_SESSION, owner.sessionId).resumeExecutionForModel(
          executionId,
          identity,
          response,
        ),
      catch: (cause) => new McpModelResumeForwardError({ cause }),
    });
  }

  protected override async openSessionDb(): Promise<CfSessionDbHandle> {
    const opening = Date.now();
    const handle = await createD1ExecutorDb(this.cfEnv.DB, this.cfEnv.BLOBS);
    this.openDbMs = Date.now() - opening;
    return { ...handle, end: () => handle.close() };
  }

  // The whole session start, of which the build is one part: the time from
  // this instance starting to `init`, and `init` itself (session meta, db,
  // build). A client waits for all of it before `initialize` answers.
  override async init(): Promise<void> {
    const starting = Date.now();
    await super.init();
    if (this.openDbMs === null) return;
    console.log(
      "[executor] MCP session init ms",
      JSON.stringify({
        beforeInit: starting - this.constructedAt,
        init: Date.now() - starting,
        openDb: this.openDbMs,
      }),
    );
    this.openDbMs = null;
  }

  protected override resolveSessionMeta(
    token: McpSessionInit,
    _storedMeta: SessionMeta | null,
  ): Effect.Effect<SessionMeta> {
    // Single-tenant: every Access principal belongs to the one configured org,
    // so the configured name and slug stand. Multi-tenant: the token's
    // organization id is the tenant slug, and it names the org everywhere
    // (artifact URLs included).
    const multiTenant = this.cfConfig.directory !== null;
    return Effect.succeed({
      organizationId: token.organizationId,
      organizationName: multiTenant ? token.organizationId : this.cfConfig.organizationName,
      organizationSlug: multiTenant ? token.organizationId : this.cfConfig.organizationSlug,
      ...sessionOrgRoleMetadata(token),
      userId: token.userId,
      ...(token.email ? { email: token.email } : {}),
      ...(token.clientName ? { clientName: token.clientName } : {}),
      resource: token.resource,
      elicitationMode: token.elicitationMode,
      artifactsEnabled: token.artifactsEnabled,
      searchToolsEnabled: token.searchToolsEnabled,
      toolMode: token.toolMode,
    } satisfies SessionMeta);
  }

  protected override buildMcpServer(
    sessionMeta: SessionMeta,
    dbHandle: CfSessionDbHandle,
  ): Effect.Effect<BuiltMcpServer> {
    const config = this.cfConfig;
    const self = this;
    // Wall time of each build step, logged once per build: a client waits for
    // all of it before `initialize` answers.
    const steps: Record<string, number> = {};
    let last = Date.now();
    const mark = (step: string) =>
      Effect.sync(() => {
        const now = Date.now();
        steps[step] = now - last;
        last = now;
      });
    return Effect.gen(function* () {
      // QuickJS-WASM must be loaded before the executor layer builds it (the
      // default variant can't fetch its .wasm on Workers). Idempotent per isolate.
      yield* Effect.promise(() => preloadQuickJs());
      yield* mark("quickjs");
      const catalog = yield* Effect.promise(() => refreshCatalog(self.cfEnv.DB, config));
      yield* mark("catalog");
      // The playbook-first rule opens the instructions. The tenant's "how we
      // work" page follows it, read from the wiki as this caller may read it;
      // in one company org, the page of every tenant the person is in. No
      // page, no block. Read beside the executor build, which never needs it.
      const teamPagesStart = Date.now();
      const email = sessionMeta.email;
      const teamPagesFiber = yield* Effect.forkChild(
        (!email
          ? Effect.succeed<readonly TeamPage[]>([])
          : config.directory
            ? sharedTeamPages(
                `tenant:${sessionMeta.organizationId}:${email.toLowerCase()}`,
                readTeamPage(config.directory, sessionMeta.organizationId, email).pipe(
                  Effect.map((page): readonly TeamPage[] => (page === null ? [] : [page])),
                ),
              )
            : config.operatorDirectory
              ? sharedTeamPages(
                  `company:${email.toLowerCase()}`,
                  readTeamPages(config.operatorDirectory, email),
                )
              : Effect.succeed<readonly TeamPage[]>([])
        ).pipe(
          Effect.tap(() => Effect.sync(() => (steps.teamPages = Date.now() - teamPagesStart))),
        ),
      );
      // Calls to wiki and Muster say who is behind them (client, person,
      // agent, guide); read lazily, since `initialize` lands after this build.
      const callMeta = makeAttributionMeta({
        origins: config.firstParty.map((server) => server.endpoint),
        // The OAuth client's registered name ("AI Studio") names the app;
        // `initialize` often names only the MCP library it is built on.
        client: () =>
          sessionMeta.clientName
            ? { name: sessionMeta.clientName }
            : self.server?.server.getClientVersion(),
        person: () => sessionMeta.email,
        agent: sessionMeta.resource?.kind === "toolkit" ? sessionMeta.resource.slug : undefined,
      });
      const { engine, executor } = yield* makeExecutionStack(
        sessionMeta.userId,
        sessionMeta.organizationId,
        sessionMeta.organizationName,
        { mcpResource: sessionMeta.resource, orgWrites: "request" },
      ).pipe(
        Effect.provide(
          makeCloudflareExecutionStackLayer(config, dbHandle, self.cfEnv.DB, callMeta),
        ),
      );
      yield* mark("executor");
      // A catalog server the org has no integration for under the slug this
      // session serves would list no tools and say nothing. Logged off the
      // session's path, so a mismatch is seen without slowing `initialize`.
      yield* executor.integrations.list().pipe(
        Effect.map((found) =>
          unservedCatalogIntegrations(
            catalog,
            found.map((integration) => String(integration.slug)),
          ),
        ),
        Effect.tap((missing) =>
          Effect.sync(() => {
            if (missing.length === 0) return;
            console.warn(
              JSON.stringify({
                event: "mcp_catalog_integration_missing",
                organizationId: sessionMeta.organizationId,
                missing,
              }),
            );
          }),
        ),
        Effect.ignore,
        Effect.forkDetach,
      );
      // An agent's first connection makes its workspace toolkit, narrowed
      // from the console. Its personal picks run as whoever calls it, through
      // their own sign-ins; the tenant ceiling bounds it either way.
      if (config.agentSignIn && sessionMeta.resource?.kind === "toolkit") {
        const slug = sessionMeta.resource.slug;
        yield* ensureAgentToolkit(
          executor.toolkits,
          slug,
          withHostExecutor(self.cfEnv, config, (host) =>
            startWorkspace(host.toolkits, { slug, name: slug }),
          ),
        );
      }
      yield* mark("workspace");
      // An agent sees Executor's own tools only when its workspace picked them.
      const builtinTools =
        config.agentSignIn && sessionMeta.resource?.kind === "toolkit"
          ? yield* agentHasCoreTools(executor.toolkits, sessionMeta.resource.slug)
          : true;
      yield* mark("coreTools");
      // Browser elicitation mode (the base owns the approval store + the HTTP
      // approval RPCs): a gated execution pauses and returns an approvalUrl into
      // the console resume page. The URL origin is the create request's origin
      // (captured by the base), falling back to the configured site URL.
      const elicitationMode = sessionMeta.elicitationMode ?? "model";
      // Same origin story as the approval URL below: an artifact deep link is
      // only offered when this deployment knows its own public URL. Without one
      // the artifact is still saved, and the tool says so.
      const artifactOrigin = sessionMeta.webOrigin ?? config.webBaseUrl;
      const teamPages = yield* Fiber.join(teamPagesFiber);
      yield* mark("teamPagesWait");
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        artifacts: executor.artifacts,
        connections: executor.connections,
        tools: timeoutDrillTools(sessionMeta, executor.tools),
        integrations: executor.integrations,
        // Artifacts are on by default, opt-out per connection. A session
        // persisted without a value restores to the default, same as a fresh
        // connection whose URL says nothing about `?artifacts=`.
        artifactsEnabled: sessionMeta.artifactsEnabled ?? true,
        // Per-integration search tools are off by default, opt-in per
        // connection (`?search_tools=true`). Same restore rule as artifacts.
        searchToolsEnabled: sessionMeta.searchToolsEnabled ?? false,
        mode: sessionMeta.toolMode ?? "codemode",
        instructions: sessionInstructions(teamPages),
        directIntegrations: catalogIntegrations(catalog),
        ...(sessionMeta.servedToolNames ? { servedToolNames: sessionMeta.servedToolNames } : {}),
        onServedToolNames: (names, added) => self.persistServedToolNames(names, added),
        builtinTools,
        onStep: (step, ms) => {
          steps[`tools.${step}`] = ms;
        },
        // Cold restores rebuild this server with no `initialize` to replay, so
        // the negotiated apps support comes back from storage instead.
        restoredAppsEnabled: sessionMeta.appsEnabled ?? false,
        onAppsEnabledChange: (appsEnabled) => self.persistAppsEnabled(appsEnabled),
        loadAppShellHtml: self.loadAppShellHtml,
        smokeRenderArtifact,
        ...(artifactOrigin
          ? { artifactUrl: artifactUrlFor(artifactOrigin, sessionMeta.organizationSlug) }
          : {}),
        browserApprovalStore: self.browserApprovalStore,
        pausedExecutionHooks: self.pausedExecutionHooks,
        pausedExecutionLeaseMs: PAUSED_APPROVAL_TIMEOUT_MS,
        resumeFallback: self.modelResumeFallback,
        elicitationMode:
          elicitationMode === "browser"
            ? {
                mode: "browser" as const,
                approvalUrl: (executionId) => {
                  // webOrigin is captured per-request at session create; for a
                  // legacy session cold-restored without it, fall back to the
                  // pinned site URL. If neither exists, the link would be
                  // unreachable — fail VISIBLY (a logged, obviously-invalid host)
                  // instead of silently pointing the human at http://localhost.
                  const origin = sessionMeta.webOrigin ?? config.webBaseUrl;
                  if (!origin) {
                    console.error(
                      "[executor-cloudflare] cannot build MCP approval URL: no session web origin and VITE_PUBLIC_SITE_URL is unset. Set VITE_PUBLIC_SITE_URL so approval links are reachable.",
                    );
                  }
                  return buildResumeApprovalUrl({
                    origin: origin ?? "https://unconfigured-origin.invalid",
                    executionId,
                    sessionId: self.sessionId,
                    organizationSlug: sessionMeta.organizationSlug,
                  });
                },
              }
            : { mode: elicitationMode },
      });
      yield* mark("tools");
      console.log("[executor] MCP session build ms", JSON.stringify(steps));
      return { mcpServer, engine } satisfies BuiltMcpServer;
    }).pipe(
      Effect.withSpan("McpSessionDO.buildMcpServer"),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: a runtime-build failure surfaces as the base's tapCause/cleanup defect
      Effect.orDie,
    );
  }
}
