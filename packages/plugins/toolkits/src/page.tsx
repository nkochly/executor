import { useId, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { ArrowLeftIcon, BoxIcon, PlugIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import {
  createPluginAtomClient,
  useIntegrationPlugins,
  type IntegrationPlugin,
  type PluginPageProps,
} from "@executor-js/sdk/client";
import {
  matchPattern,
  type EffectivePolicy,
  type Integration,
  type Owner,
  type ToolAddress,
  type ToolPolicyAction,
} from "@executor-js/sdk/shared";
import {
  connectionsAllAtom,
  integrationsOptimisticAtom,
  toolsAllAtom,
} from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { useOrganizationSlug } from "@executor-js/react/api/organization-context";
import {
  getExecutorApiBaseUrl,
  getExecutorOrganizationHeaders,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { ownerLabel, useOwnerDisplay } from "@executor-js/react/api/owner-display";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@executor-js/react/components/alert-dialog";
import {
  IntegrationFavicon,
  integrationPresetIconUrl,
} from "@executor-js/react/components/integration-favicon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/react/components/dialog";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { ToolDetail, ToolDetailEmpty } from "@executor-js/react/components/tool-detail";
import { ToolTree, type ToolSummary } from "@executor-js/react/components/tool-tree";
import { cn } from "@executor-js/react/lib/utils";
import { connectionNaming, NAME_SEPARATOR } from "@executor-js/react/lib/connection-naming";

import {
  ToolkitsApi,
  type ToolkitConnectionResponse,
  type ToolkitPolicyResponse,
  type ToolkitResponse,
} from "./shared";

const ToolkitsClient = createPluginAtomClient(ToolkitsApi, {
  baseUrl: getExecutorApiBaseUrl,
  authorizationHeader: getExecutorServerAuthorizationHeader,
  headers: getExecutorOrganizationHeaders,
});

const toolkitWriteKeys = [
  ReactivityKey.connections,
  ReactivityKey.policies,
  ReactivityKey.tools,
] as const;

const toolkitsAtom = ToolkitsClient.query("toolkits", "list", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.policies],
});

const toolkitPoliciesAtom = Atom.family((toolkitId: string) =>
  ToolkitsClient.query("toolkits", "listPolicies", {
    params: { toolkitId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.policies],
  }),
);

const toolkitConnectionsAtom = Atom.family((toolkitId: string) =>
  ToolkitsClient.query("toolkits", "listConnections", {
    params: { toolkitId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.connections],
  }),
);

const createToolkit = ToolkitsClient.mutation("toolkits", "create");
const removeToolkit = ToolkitsClient.mutation("toolkits", "remove");
const createToolkitPolicy = ToolkitsClient.mutation("toolkits", "createPolicy");
const updateToolkitPolicy = ToolkitsClient.mutation("toolkits", "updatePolicy");
const removeToolkitPolicy = ToolkitsClient.mutation("toolkits", "removePolicy");
const createToolkitConnection = ToolkitsClient.mutation("toolkits", "createConnection");
const removeToolkitConnection = ToolkitsClient.mutation("toolkits", "removeConnection");

type ToolRow = {
  readonly address: ToolAddress;
  readonly integration: string;
  readonly owner?: Owner;
  readonly connection?: string;
  readonly name: string;
  readonly description?: string;
  readonly requiresApproval?: boolean;
  readonly static?: boolean;
};

const comparePolicy = (a: ToolkitPolicyResponse, b: ToolkitPolicyResponse): number => {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const pluginDefaultPolicy = (requiresApproval: boolean | undefined): EffectivePolicy =>
  requiresApproval
    ? { action: "require_approval", source: "plugin-default" }
    : { action: "approve", source: "plugin-default" };

const isLegacyConnectionPolicy = (policy: ToolkitPolicyResponse): boolean => {
  if (policy.action !== "approve") return false;
  const parts = policy.pattern.split(".");
  return parts.at(-1) === "*" && (parts.length === 3 || parts.length === 4);
};

const resolveToolkitPolicy = (
  matchId: string,
  policies: readonly ToolkitPolicyResponse[],
  requiresApproval?: boolean,
): EffectivePolicy => {
  for (const policy of [...policies].sort(comparePolicy)) {
    if (!matchPattern(policy.pattern, matchId)) continue;
    return {
      action: policy.action,
      source: "user",
      pattern: policy.pattern,
      policyId: policy.id,
    };
  }
  return pluginDefaultPolicy(requiresApproval);
};

const toolMatchId = (tool: ToolRow): string =>
  tool.static ? String(tool.address) : String(tool.address).replace(/^tools\./, "");

// A workspace toolkit picks personal connections only when the host allows it;
// each caller then runs a pick through their own sign-in of that name.
const toolCanAppearInToolkit = (
  toolkit: ToolkitResponse,
  tool: ToolRow,
  takesPersonal: boolean,
): boolean =>
  toolkit.owner === "user" || takesPersonal || tool.static === true || tool.owner !== "user";

/** Whether this host lets workspace toolkits pick personal connections. */
const useWorkspaceTakesPersonal = (): boolean => {
  const toolkits = useAtomValue(toolkitsAtom);
  return (
    AsyncResult.isSuccess(toolkits) &&
    toolkits.value.workspaceToolkitsTakePersonalConnections === true
  );
};

const toolkitUrlFor = (orgSlug: string | undefined, slug: string): string => {
  const path = orgSlug ? `/${orgSlug}/mcp/toolkits/${slug}` : `/mcp/toolkits/${slug}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
};

const identityPattern = (displayPattern: string): string => displayPattern;

const compareToolkitRows = (a: ToolkitResponse, b: ToolkitResponse): number => {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.name.localeCompare(b.name);
};

const toolkitByRouteSlug = (
  toolkits: readonly ToolkitResponse[],
  slug: string,
): ToolkitResponse | null => {
  const matches = toolkits.filter((toolkit) => toolkit.slug === slug);
  return matches.find((toolkit) => toolkit.owner === "org") ?? matches[0] ?? null;
};

const toolkitCardStyle = { minHeight: "9rem" };
const toolkitGridContainerStyle = { maxWidth: "80rem" };
const toolkitToolTreeStyle = { width: "24rem" };

const neutralToolkitIconClass = "border-border/70 bg-muted/30 text-muted-foreground";

type ToolkitConnectionGroup = {
  readonly id: string;
  readonly owner: Owner;
  readonly integration: string;
  readonly connection: string;
  /** What the connection reaches (the tenant its server names, or its account), when known. */
  readonly label?: string;
  /** Who signed in, when the label names something else (the server's tenant). */
  readonly account?: string;
  readonly patterns: readonly string[];
  readonly tools: readonly ToolRow[];
};

/** Display labels by `owner:integration:connection`, from the connections list. */
type ConnectionLabels = ReadonlyMap<string, { readonly label: string; readonly account?: string }>;

const connectionKey = (owner: string, integration: string, connection: string): string =>
  `${owner}:${integration}:${connection}`;

/**
 * Each connection's qualifier, so several connections to one server read
 * apart: the tenant its server names in its title (the health check's
 * identity), else the sign-in's account (`connectionNaming`).
 */
const useConnectionLabels = (): ConnectionLabels => {
  const connections = useAtomValue(connectionsAllAtom);
  return useMemo(() => {
    const labels = new Map<string, { label: string; account?: string }>();
    if (!AsyncResult.isSuccess(connections)) return labels;
    for (const row of connections.value) {
      const naming = connectionNaming({
        identity: row.lastHealth?.status === "healthy" ? row.lastHealth.identity : null,
        account: row.identityLabel,
      });
      if (naming.qualifier) {
        labels.set(connectionKey(String(row.owner), String(row.integration), String(row.name)), {
          label: naming.qualifier,
          ...(naming.account ? { account: naming.account } : {}),
        });
      }
    }
    return labels;
  }, [connections]);
};

type IntegrationMeta = {
  readonly name: string;
  readonly integrationId: string;
  readonly icon?: string | null;
  readonly url?: string;
};

const toolOwner = (tool: ToolRow): Owner => (tool.static ? "org" : (tool.owner ?? "org"));

const toolConnectionName = (tool: ToolRow): string => {
  if (tool.connection && tool.connection.length > 0) return tool.connection;
  return tool.static ? "built-in" : "default";
};

const policyPrefixForTool = (tool: ToolRow): string => {
  const matchId = toolMatchId(tool);
  const integration = String(tool.integration);
  if (tool.connection && tool.connection.length > 0) {
    const connection = String(tool.connection);
    if (tool.owner) {
      const ownerConnectionPrefix = `${integration}.${tool.owner}.${connection}`;
      if (matchId === ownerConnectionPrefix || matchId.startsWith(`${ownerConnectionPrefix}.`)) {
        return ownerConnectionPrefix;
      }
    }
    const connectionPrefix = `${integration}.${connection}`;
    if (matchId === connectionPrefix || matchId.startsWith(`${connectionPrefix}.`)) {
      return connectionPrefix;
    }
  }
  const name = String(tool.name);
  if (name.length > 0 && matchId.endsWith(`.${name}`)) {
    return matchId.slice(0, -name.length - 1);
  }
  const segments = matchId.split(".");
  return segments.length > 1 ? segments.slice(0, -1).join(".") : matchId;
};

const connectionPatternForTool = (tool: ToolRow): string => `${policyPrefixForTool(tool)}.*`;

const compareConnectionGroups = (a: ToolkitConnectionGroup, b: ToolkitConnectionGroup): number => {
  const ownerRank = (owner: Owner) => (owner === "org" ? 0 : 1);
  return (
    ownerRank(a.owner) - ownerRank(b.owner) ||
    a.integration.localeCompare(b.integration) ||
    a.connection.localeCompare(b.connection) ||
    a.id.localeCompare(b.id)
  );
};

const patternSubsumes = (candidate: string, covered: string): boolean => {
  if (candidate === covered) return true;
  if (!candidate.endsWith(".*")) return false;
  const prefix = candidate.slice(0, -1);
  return covered.startsWith(prefix);
};

const reducePolicyPatterns = (patterns: readonly string[]): readonly string[] => {
  const unique = [...new Set(patterns)].sort((a, b) => a.localeCompare(b));
  return unique.filter(
    (pattern) =>
      !unique.some((candidate) => candidate !== pattern && patternSubsumes(candidate, pattern)),
  );
};

const buildConnectionGroups = (
  tools: readonly ToolRow[],
  labels: ConnectionLabels = new Map(),
): readonly ToolkitConnectionGroup[] => {
  const groups = new Map<string, ToolkitConnectionGroup & { tools: ToolRow[] }>();
  for (const tool of tools) {
    const owner = toolOwner(tool);
    const key = `${owner}:${tool.integration}:${toolConnectionName(tool)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tools.push(tool);
      continue;
    }
    const named = labels.get(
      connectionKey(String(owner), String(tool.integration), toolConnectionName(tool)),
    );
    groups.set(key, {
      id: key,
      owner,
      integration: String(tool.integration),
      connection: toolConnectionName(tool),
      ...(named ? { label: named.label } : {}),
      ...(named?.account ? { account: named.account } : {}),
      patterns: [],
      tools: [tool],
    });
  }
  return [...groups.values()]
    .map((group) => {
      const sortedTools = [...group.tools].sort(compareTools);
      return {
        ...group,
        patterns: reducePolicyPatterns(sortedTools.map(connectionPatternForTool)),
        tools: sortedTools,
      };
    })
    .sort(compareConnectionGroups);
};

const compareTools = (a: ToolRow, b: ToolRow): number =>
  String(a.name).localeCompare(String(b.name)) || toolMatchId(a).localeCompare(toolMatchId(b));

/** The host's own tools: one connection every workspace may pick. */
const BUILT_IN_CONNECTION = "coreTools";

const connectionDisplayTitle = (group: ToolkitConnectionGroup, meta: IntegrationMeta): string => {
  if (group.connection === BUILT_IN_CONNECTION) return `${meta.name} built-in tools`;
  if (group.label) return `${meta.name}${NAME_SEPARATOR}${group.label}`;
  return group.connection === "built-in" || group.connection === "default"
    ? meta.name
    : `${meta.name}${NAME_SEPARATOR}${group.connection}`;
};

const toolCountLabel = (count: number): string => `${count} ${count === 1 ? "tool" : "tools"}`;

const connectionDisplaySubtitle = (group: ToolkitConnectionGroup): string =>
  [toolCountLabel(group.tools.length), group.account ? `signed in as ${group.account}` : null]
    .filter((part) => part !== null)
    .join(" · ");

const connectionDisplaySubtitleForHost = (
  group: ToolkitConnectionGroup,
  showOwnerLabels: boolean,
): string => {
  const subtitle = connectionDisplaySubtitle(group);
  return showOwnerLabels ? `${ownerLabel(group.owner)} · ${subtitle}` : subtitle;
};

const integrationMetaFor = (
  group: ToolkitConnectionGroup,
  integrations: readonly Integration[],
  integrationPlugins: readonly IntegrationPlugin[],
): IntegrationMeta => {
  const integration = integrations.find((row) => String(row.slug) === group.integration);
  const fallbackName = group.integration
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  const integrationSummary = {
    id: group.integration,
    kind: integration?.kind ?? group.integration,
    name: integration?.name ?? fallbackName,
    url: integration?.displayUrl,
  };
  return {
    name: integrationSummary.name,
    integrationId: group.integration,
    icon: integrationPresetIconUrl(integrationSummary, integrationPlugins),
    ...(integrationSummary.url ? { url: integrationSummary.url } : {}),
  };
};

type ConfiguredConnectionView = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly pattern: string;
  readonly integrationId: string;
  readonly icon?: string | null;
  readonly url?: string;
};

const configuredConnectionViews = (
  connections: readonly ToolkitConnectionResponse[],
  connectionGroups: readonly ToolkitConnectionGroup[],
  integrations: readonly Integration[],
  integrationPlugins: readonly IntegrationPlugin[],
  showOwnerLabels: boolean,
): readonly ConfiguredConnectionView[] =>
  connections.map((connection) => {
    const group = connectionGroups.find((candidate) =>
      candidate.patterns.includes(connection.pattern),
    );
    if (!group) {
      return {
        id: connection.id,
        title: connection.pattern === "*" ? "Every connection" : connection.pattern,
        subtitle:
          connection.pattern === "*"
            ? "Everything you can pick, also connections added later"
            : "Configured pattern",
        pattern: connection.pattern,
        integrationId: connection.pattern.split(".")[0] ?? "toolkit",
      };
    }
    const meta = integrationMetaFor(group, integrations, integrationPlugins);
    return {
      id: connection.id,
      title: connectionDisplayTitle(group, meta),
      subtitle: connectionDisplaySubtitleForHost(group, showOwnerLabels),
      pattern: connection.pattern,
      integrationId: meta.integrationId,
      icon: meta.icon,
      ...(meta.url ? { url: meta.url } : {}),
    };
  });

const legacyConnectionPolicyIds = (
  policies: readonly ToolkitPolicyResponse[],
  connectionGroups: readonly ToolkitConnectionGroup[],
  connections: readonly ToolkitConnectionResponse[],
): ReadonlySet<string> => {
  const persistedPatterns = new Set(connections.map((connection) => connection.pattern));
  const connectionPatterns = new Set(connectionGroups.flatMap((group) => group.patterns));
  return new Set(
    policies
      .filter(
        (policy) =>
          isLegacyConnectionPolicy(policy) &&
          connectionPatterns.has(policy.pattern) &&
          !persistedPatterns.has(policy.pattern),
      )
      .map((policy) => policy.id),
  );
};

const configuredConnectionPatterns = (
  connections: readonly ToolkitConnectionResponse[],
  policies: readonly ToolkitPolicyResponse[],
  legacyPolicyIds: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([
    ...connections.map((connection) => connection.pattern),
    ...policies.filter((policy) => legacyPolicyIds.has(policy.id)).map((policy) => policy.pattern),
  ]);

function ToolkitConnectionIconStack(props: { connections: readonly ConfiguredConnectionView[] }) {
  const visibleConnections = props.connections.slice(0, 3);
  if (visibleConnections.length === 0) {
    return (
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md border",
          neutralToolkitIconClass,
        )}
      >
        <BoxIcon className="size-4" />
      </div>
    );
  }

  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/20">
      <div className="flex -space-x-2">
        {visibleConnections.map((connection) => (
          <span
            key={connection.id}
            className="flex size-5 items-center justify-center rounded-sm border border-background bg-card shadow-xs"
          >
            <IntegrationFavicon
              icon={connection.icon}
              integrationId={connection.integrationId}
              url={connection.url}
              size={14}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

/** What a workspace tile says it is connected to: the connections by name. */
const connectionNamesLabel = (connections: readonly ConfiguredConnectionView[]): string =>
  connections.length === 0
    ? "No connections"
    : connections.map((connection) => connection.title).join(", ");

function ToolkitTile(props: { showOwnerLabels: boolean; toolkit: ToolkitResponse }) {
  const toolkit = props.toolkit;
  const tools = useAtomValue(toolsAllAtom);
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const connections = useAtomValue(toolkitConnectionsAtom(toolkit.id));
  const integrationPlugins = useIntegrationPlugins();
  const takesPersonal = useWorkspaceTakesPersonal();
  const visibleTools = useMemo(
    () =>
      AsyncResult.isSuccess(tools)
        ? (tools.value as readonly ToolRow[]).filter((tool) =>
            toolCanAppearInToolkit(toolkit, tool, takesPersonal),
          )
        : [],
    [toolkit, tools, takesPersonal],
  );
  const connectionLabels = useConnectionLabels();
  const connectionGroups = useMemo(
    () => buildConnectionGroups(visibleTools, connectionLabels),
    [visibleTools, connectionLabels],
  );
  const connectionRows = AsyncResult.isSuccess(connections) ? connections.value.connections : [];
  const integrationRows = AsyncResult.isSuccess(integrations)
    ? (integrations.value as readonly Integration[])
    : [];
  const tileDataReady =
    AsyncResult.isSuccess(connections) &&
    AsyncResult.isSuccess(tools) &&
    AsyncResult.isSuccess(integrations);
  const configuredConnections = tileDataReady
    ? configuredConnectionViews(
        connectionRows,
        connectionGroups,
        integrationRows,
        integrationPlugins,
        props.showOwnerLabels,
      )
    : [];
  return (
    <Link
      to="/{-$orgSlug}/toolkits/$toolkitSlug"
      params={{ toolkitSlug: toolkit.slug }}
      aria-label={`Open workspace ${toolkit.name}`}
      className="group flex min-h-36 min-w-0 self-start flex-col justify-between rounded-md border border-border/70 bg-card p-3.5 text-left text-card-foreground shadow-xs transition-[border-color,background-color,box-shadow] hover:border-foreground/25 hover:bg-muted/20 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      style={toolkitCardStyle}
    >
      <div className="flex min-w-0 items-start gap-3">
        {tileDataReady ? (
          <ToolkitConnectionIconStack connections={configuredConnections} />
        ) : (
          <Skeleton className="size-9 shrink-0 rounded-md" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{toolkit.name}</div>
          <div className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
            {tileDataReady ? connectionNamesLabel(configuredConnections) : "Loading"}
          </div>
        </div>
      </div>
    </Link>
  );
}

const addToolkitScopeLabel = (owner: Owner, showOwnerLabels: boolean): string =>
  showOwnerLabels ? (owner === "org" ? "team" : "personal") : "";
const addToolkitTitle = (owner: Owner, showOwnerLabels: boolean): string =>
  showOwnerLabels
    ? owner === "org"
      ? "New team workspace"
      : "New personal workspace"
    : "New workspace";

function CreateToolkitDialog(props: {
  owner: Owner;
  showOwnerLabels: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const inputId = useId();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const title = addToolkitTitle(props.owner, props.showOwnerLabels);

  const submit = async () => {
    if (!trimmed) return;
    await props.onCreate({ owner: props.owner, name: trimmed });
    setName("");
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        if (!nextOpen) setName("");
      }}
    >
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden rounded-md border-border/80 bg-card p-0 shadow-2xl"
        style={{ width: "min(24rem, calc(100vw - 2rem))" }}
      >
        <form
          className="grid"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader className="px-4 pb-1 pt-4">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">
              A workspace is one agent: it picks its connections and has its own MCP URL.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 px-4 py-3">
            <Label htmlFor={inputId} className="text-xs text-muted-foreground">
              Workspace name
            </Label>
            <Input
              id={inputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Team_Eichten agent"
              autoFocus
              className="h-9"
            />
          </div>
          <DialogFooter className="px-4 pb-4 pt-1">
            <Button
              type="submit"
              size="sm"
              disabled={!trimmed}
              aria-label="Create workspace"
              className="h-8"
            >
              Create workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddToolkitCard(props: { owner: Owner; showOwnerLabels: boolean; onClick: () => void }) {
  const scopeLabel = addToolkitScopeLabel(props.owner, props.showOwnerLabels);
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={props.onClick}
      aria-label={scopeLabel ? `Add ${scopeLabel} workspace` : "Add workspace"}
      className="group flex h-auto min-h-36 min-w-0 self-start items-center justify-center rounded-md border border-dashed border-border/75 bg-card/40 p-0 text-muted-foreground transition-[border-color,background-color,box-shadow,color] hover:border-foreground/25 hover:bg-muted/20 hover:text-foreground hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      style={toolkitCardStyle}
    >
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-md border transition-[border-color,background-color,color,transform]",
          neutralToolkitIconClass,
          "group-hover:scale-105",
        )}
      >
        <PlusIcon className="size-6" />
      </span>
    </Button>
  );
}

function ToolkitSection(props: {
  owner: Owner;
  title?: string;
  showOwnerLabels: boolean;
  toolkits: readonly ToolkitResponse[];
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const rows = [...props.toolkits].sort(compareToolkitRows);
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);
  return (
    <section className="space-y-3">
      {props.title ? (
        <div className="border-b border-border/60 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {props.title}
          </h2>
        </div>
      ) : null}

      <div className="grid content-start grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        {rows.map((toolkit) => (
          <ToolkitTile key={toolkit.id} showOwnerLabels={props.showOwnerLabels} toolkit={toolkit} />
        ))}
        <AddToolkitCard
          owner={props.owner}
          showOwnerLabels={props.showOwnerLabels}
          onClick={openCreate}
        />
      </div>

      <CreateToolkitDialog
        owner={props.owner}
        showOwnerLabels={props.showOwnerLabels}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={props.onCreate}
      />
    </section>
  );
}

function ToolkitGrid(props: {
  toolkits: readonly ToolkitResponse[];
  onCreate: (input: { owner: Owner; name: string }) => Promise<void>;
}) {
  const ownerDisplay = useOwnerDisplay();
  // Toolkit shelves are grouped by owner; the selected toolkit owns the page.
  const workspaceToolkits = props.toolkits.filter((toolkit) => toolkit.owner === "org");
  const personalToolkits = props.toolkits.filter((toolkit) => toolkit.owner === "user");
  if (!ownerDisplay.showOwnerLabels) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
          <ToolkitSection
            owner="org"
            showOwnerLabels={false}
            toolkits={props.toolkits}
            onCreate={props.onCreate}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
        <ToolkitSection
          owner="org"
          showOwnerLabels
          title="Team workspaces"
          toolkits={workspaceToolkits}
          onCreate={props.onCreate}
        />
        <ToolkitSection
          owner="user"
          showOwnerLabels
          title="Personal workspaces"
          toolkits={personalToolkits}
          onCreate={props.onCreate}
        />
      </div>
    </div>
  );
}

function ToolkitContentsEmpty(props: { onManageConnections: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
          <PlugIcon className="size-5" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-foreground">No connections added</h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          Add a connection to decide what this workspace can use.
        </p>
        <Button type="button" size="sm" onClick={props.onManageConnections} className="mt-4">
          Add a connection
        </Button>
      </div>
    </div>
  );
}

function ToolkitToolsPanel(props: {
  tools: readonly ToolSummary[];
  selectedToolId: string | null;
  policies: readonly ToolkitPolicyResponse[];
  onManageConnections: () => void;
  onSelectTool: (toolId: string) => void;
  onSetPolicy: (pattern: string, action: ToolPolicyAction) => void;
  onClearPolicy: (pattern: string) => void;
}) {
  return (
    <div
      role="region"
      aria-label="Workspace tools"
      className="flex min-h-0 shrink-0 flex-col border-r border-border/60"
      style={toolkitToolTreeStyle}
    >
      {props.tools.length === 0 ? (
        <ToolkitContentsEmpty onManageConnections={props.onManageConnections} />
      ) : (
        <ToolTree
          tools={props.tools}
          selectedToolId={props.selectedToolId}
          onSelect={props.onSelectTool}
          onSetPolicy={props.onSetPolicy}
          onClearPolicy={props.onClearPolicy}
          patternForDisplay={identityPattern}
          policies={props.policies}
          groupByConnection
        />
      )}
    </div>
  );
}

const EVERY_CONNECTION_PATTERN = "*";

function ConnectionIcon(props: { icon?: string | null; integrationId: string; url?: string }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30">
      <IntegrationFavicon
        icon={props.icon}
        integrationId={props.integrationId}
        url={props.url}
        size={18}
      />
    </span>
  );
}

function ConnectionRow(props: {
  icon?: string | null;
  integrationId: string;
  url?: string;
  title: string;
  subtitle: string;
  badge?: string;
  action: "add" | "remove";
  busy: boolean;
  onAction: () => void;
}) {
  const remove = props.action === "remove";
  return (
    <li className="flex min-w-0 items-center gap-3 border-b border-border/50 px-4 py-3 last:border-b-0">
      <ConnectionIcon icon={props.icon} integrationId={props.integrationId} url={props.url} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{props.title}</span>
          {props.badge ? (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {props.badge}
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{props.subtitle}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.busy}
        aria-label={`${remove ? "Remove" : "Add"} ${props.title}`}
        onClick={props.onAction}
        className={cn(
          "h-8 shrink-0 px-3 text-xs",
          remove
            ? "text-muted-foreground hover:border-destructive/40 hover:text-destructive"
            : "border-primary/30 text-primary hover:bg-primary/10",
        )}
      >
        {remove ? <Trash2Icon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
        {remove ? "Remove" : "Add"}
      </Button>
    </li>
  );
}

/**
 * A workspace's connections, as the page's main content: what it is connected
 * to, each with its own Remove, and every other connection it may pick, each
 * with Add.
 */
function WorkspaceConnectionsPanel(props: {
  groups: readonly ToolkitConnectionGroup[];
  configuredConnections: readonly ConfiguredConnectionView[];
  hiddenPersonalConnectionCount: number;
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  showOwnerLabels: boolean;
  onAddPatterns: (patterns: readonly string[]) => Promise<void> | void;
  onRemoveConnection: (connectionId: string) => Promise<void> | void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // The mutations resolve with an Exit, so the row frees up either way.
  const run = (key: string, action: () => Promise<void> | void) => {
    setBusy(key);
    void Promise.resolve(action()).then(
      () => setBusy(null),
      () => setBusy(null),
    );
  };

  const configuredPatterns = new Set(
    props.configuredConnections.map((connection) => connection.pattern),
  );
  const takesEverything = configuredPatterns.has(EVERY_CONNECTION_PATTERN);
  const available = props.groups.filter(
    (group) => !group.patterns.some((pattern) => configuredPatterns.has(pattern)),
  );
  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? available.filter((group) => {
        const meta = integrationMetaFor(group, props.integrations, props.integrationPlugins);
        return [connectionDisplayTitle(group, meta), meta.name, group.integration, group.connection]
          .join(" ")
          .toLowerCase()
          .includes(trimmedQuery);
      })
    : available;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6">
        <section aria-labelledby={`${searchId}-connected`}>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 id={`${searchId}-connected`} className="text-sm font-semibold text-foreground">
              Connected to
            </h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {props.configuredConnections.length}
            </span>
          </div>
          {props.configuredConnections.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              Not connected to anything yet. Add a connection below.
            </div>
          ) : (
            <ul className="overflow-hidden rounded-md border border-border/70 bg-card">
              {props.configuredConnections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  icon={connection.icon}
                  integrationId={connection.integrationId}
                  url={connection.url}
                  title={connection.title}
                  subtitle={connection.subtitle}
                  action="remove"
                  busy={busy !== null}
                  onAction={() => run(connection.id, () => props.onRemoveConnection(connection.id))}
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`${searchId}-add`}>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 id={`${searchId}-add`} className="text-sm font-semibold text-foreground">
              Add a connection
            </h3>
            <Link
              to="/{-$orgSlug}"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Connect a new account on Integrations
            </Link>
          </div>
          {takesEverything ? (
            <p className="mb-2 text-xs leading-5 text-muted-foreground">
              &ldquo;Every connection&rdquo; already includes these. Remove it above to pick
              connections one by one.
            </p>
          ) : null}
          {available.length > 6 ? (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Label htmlFor={searchId} className="sr-only">
                Search connections
              </Label>
              <Input
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search connections"
                className="h-8 min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
              />
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              {available.length === 0
                ? "Every connection you can pick is already added."
                : "No connections match."}
            </div>
          ) : (
            <ul className="overflow-hidden rounded-md border border-border/70 bg-card">
              {filtered.map((group) => {
                const meta = integrationMetaFor(
                  group,
                  props.integrations,
                  props.integrationPlugins,
                );
                return (
                  <ConnectionRow
                    key={group.id}
                    icon={meta.icon}
                    integrationId={meta.integrationId}
                    url={meta.url}
                    title={connectionDisplayTitle(group, meta)}
                    subtitle={connectionDisplaySubtitle(group)}
                    {...(props.showOwnerLabels ? { badge: ownerLabel(group.owner) } : {})}
                    action="add"
                    busy={busy !== null}
                    onAction={() => run(group.id, () => props.onAddPatterns(group.patterns))}
                  />
                );
              })}
            </ul>
          )}
          {props.hiddenPersonalConnectionCount > 0 ? (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {props.hiddenPersonalConnectionCount} of your personal{" "}
              {props.hiddenPersonalConnectionCount === 1 ? "connection is" : "connections are"} not
              shown because this is a team workspace.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ToolkitHeader(props: {
  toolkit: ToolkitResponse;
  showOwnerLabels: boolean;
  mcpUrl: string;
  onBack: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-background/95 px-5 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={props.onBack}
            className="-ml-1 h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Workspaces
          </Button>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{props.toolkit.name}</h2>
            {props.showOwnerLabels ? (
              <Badge variant="outline" className="text-[10px]">
                {props.toolkit.owner === "org" ? "Team" : "Personal"}
              </Badge>
            ) : null}
          </div>
          <div className="mt-2 flex max-w-3xl min-w-0 items-center gap-2 rounded-md bg-muted/20 px-2 py-1 text-xs text-muted-foreground ring-1 ring-border/40">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              MCP
            </span>
            <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {props.mcpUrl}
            </code>
            <CopyButton value={props.mcpUrl} className="-mr-1" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Delete workspace"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {props.toolkit.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the workspace and its MCP URL. Connections are not deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={props.onRemove}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

function ToolkitWorkspace(props: {
  toolkit: ToolkitResponse;
  showOwnerLabels: boolean;
  policies: readonly ToolkitPolicyResponse[];
  connections: readonly ToolkitConnectionResponse[];
  tools: readonly ToolRow[];
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  mcpUrl: string;
  onBack: () => void;
  onRemoveToolkit: () => void;
  onAddConnection: (pattern: string) => Promise<void> | void;
  onRemoveConnection: (connectionId: string) => Promise<void> | void;
  onSetPolicy: (pattern: string, action: ToolPolicyAction) => Promise<void> | void;
  onClearPolicy: (pattern: string) => Promise<void> | void;
}) {
  const [view, setView] = useState<"connections" | "tools">("connections");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const takesPersonal = useWorkspaceTakesPersonal();
  const visibleTools = useMemo(
    () => props.tools.filter((tool) => toolCanAppearInToolkit(props.toolkit, tool, takesPersonal)),
    [props.toolkit, props.tools, takesPersonal],
  );
  const connectionLabels = useConnectionLabels();
  const connectionGroups = useMemo(
    () => buildConnectionGroups(visibleTools, connectionLabels),
    [visibleTools, connectionLabels],
  );
  const hiddenPersonalConnectionCount = useMemo(() => {
    if (props.toolkit.owner !== "org") return 0;
    return buildConnectionGroups(props.tools.filter((tool) => toolOwner(tool) === "user")).length;
  }, [props.toolkit.owner, props.tools]);
  const configuredConnections = useMemo(
    () =>
      configuredConnectionViews(
        props.connections,
        connectionGroups,
        props.integrations,
        props.integrationPlugins,
        props.showOwnerLabels,
      ),
    [
      connectionGroups,
      props.connections,
      props.integrationPlugins,
      props.integrations,
      props.showOwnerLabels,
    ],
  );
  const legacyPolicyIds = useMemo(
    () => legacyConnectionPolicyIds(props.policies, connectionGroups, props.connections),
    [connectionGroups, props.connections, props.policies],
  );
  const accessPolicies = useMemo(
    () => props.policies.filter((policy) => !legacyPolicyIds.has(policy.id)),
    [legacyPolicyIds, props.policies],
  );
  const connectionPatterns = useMemo(
    () => configuredConnectionPatterns(props.connections, props.policies, legacyPolicyIds),
    [legacyPolicyIds, props.connections, props.policies],
  );
  const configuredToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of visibleTools) {
      const id = toolMatchId(tool);
      if ([...connectionPatterns].some((pattern) => matchPattern(pattern, id))) ids.add(id);
    }
    return ids;
  }, [connectionPatterns, visibleTools]);
  const configuredTools = useMemo(
    () =>
      visibleTools.filter((tool) => configuredToolIds.has(toolMatchId(tool))).sort(compareTools),
    [visibleTools, configuredToolIds],
  );
  const toolkitTools: ToolSummary[] = useMemo(
    () =>
      configuredTools.map((tool) => {
        const id = toolMatchId(tool);
        const group = connectionGroups.find(
          (candidate) =>
            candidate.owner === toolOwner(tool) &&
            candidate.integration === String(tool.integration) &&
            candidate.connection === toolConnectionName(tool),
        );
        const meta = group
          ? integrationMetaFor(group, props.integrations, props.integrationPlugins)
          : null;
        const connectionLabel =
          group && meta
            ? [connectionDisplayTitle(group, meta), group.account].filter(Boolean).join(" · ")
            : undefined;
        return {
          ...(meta ? { integrationLabel: meta.name } : {}),
          ...(connectionLabel ? { connectionLabel } : {}),
          id,
          name: id,
          description: tool.description,
          policy: resolveToolkitPolicy(id, accessPolicies, tool.requiresApproval),
          owner: toolOwner(tool),
          connection: toolConnectionName(tool),
          integration: String(tool.integration),
        };
      }),
    [
      accessPolicies,
      configuredTools,
      connectionGroups,
      props.integrations,
      props.integrationPlugins,
    ],
  );
  const selectedTool = selectedToolId
    ? (configuredTools.find((tool) => toolMatchId(tool) === selectedToolId) ?? null)
    : null;
  const selectedToolPolicy = selectedTool
    ? (toolkitTools.find((tool) => tool.id === selectedToolId)?.policy ?? null)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ToolkitHeader
        toolkit={props.toolkit}
        showOwnerLabels={props.showOwnerLabels}
        mcpUrl={props.mcpUrl}
        onBack={props.onBack}
        onRemove={props.onRemoveToolkit}
      />

      <div
        role="tablist"
        aria-label="Workspace sections"
        className="flex shrink-0 gap-1 border-b border-border/60 px-4"
      >
        {(
          [
            ["connections", `Connections (${configuredConnections.length})`],
            ["tools", `Tools (${toolkitTools.length})`],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            type="button"
            variant="ghost"
            size="sm"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={cn(
              "-mb-px h-auto rounded-none border-b-2 px-3 py-2 text-xs font-medium",
              view === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Button>
        ))}
      </div>

      {view === "connections" ? (
        <WorkspaceConnectionsPanel
          groups={connectionGroups}
          configuredConnections={configuredConnections}
          hiddenPersonalConnectionCount={hiddenPersonalConnectionCount}
          integrations={props.integrations}
          integrationPlugins={props.integrationPlugins}
          showOwnerLabels={props.showOwnerLabels}
          onAddPatterns={async (patterns) => {
            for (const pattern of patterns) {
              await props.onAddConnection(pattern);
            }
          }}
          onRemoveConnection={props.onRemoveConnection}
        />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ToolkitToolsPanel
            tools={toolkitTools}
            selectedToolId={selectedToolId}
            policies={accessPolicies}
            onManageConnections={() => setView("connections")}
            onSelectTool={setSelectedToolId}
            onSetPolicy={(pattern, action) => void props.onSetPolicy(pattern, action)}
            onClearPolicy={(pattern) => void props.onClearPolicy(pattern)}
          />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {selectedTool && selectedToolPolicy ? (
              <ToolDetail
                address={selectedTool.address}
                toolName={toolMatchId(selectedTool)}
                staticTool={selectedTool.static === true}
                policy={selectedToolPolicy}
                onSetPolicy={props.onSetPolicy}
                onClearPolicy={props.onClearPolicy}
                patternForDisplay={identityPattern}
              />
            ) : (
              <ToolDetailEmpty hasTools={toolkitTools.length > 0} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolkitTileSkeleton() {
  return (
    <div
      className="flex h-auto min-h-36 min-w-0 self-start items-center justify-center rounded-md border border-dashed border-border/75 bg-card/40 p-0"
      style={toolkitCardStyle}
      aria-hidden="true"
    >
      <Skeleton className="size-12 rounded-md" />
    </div>
  );
}

function ToolkitSectionSkeleton(props: { title?: string }) {
  return (
    <section className="space-y-3" aria-label="Loading workspaces">
      {props.title ? (
        <div className="border-b border-border/60 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {props.title}
          </h2>
        </div>
      ) : null}

      <div className="grid content-start grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        <ToolkitTileSkeleton />
      </div>
    </section>
  );
}

function ToolkitGridSkeleton(props: { showOwnerLabels: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-7 px-4 py-4" style={toolkitGridContainerStyle}>
        {props.showOwnerLabels ? (
          <>
            <ToolkitSectionSkeleton title="Team workspaces" />
            <ToolkitSectionSkeleton title="Personal workspaces" />
          </>
        ) : (
          <ToolkitSectionSkeleton />
        )}
      </div>
    </div>
  );
}

function ToolkitDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/60 bg-background/95 px-4 py-3">
        <Skeleton className="mb-3 h-7 w-20 rounded-md" />
        <div className="space-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton className="h-6 w-full max-w-md" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="flex min-h-0 shrink-0 flex-col border-r border-border/60"
          style={toolkitToolTreeStyle}
        >
          <div className="border-b border-border/60 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-14" />
              </div>
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          </div>
          <div className="space-y-1 p-3">
            {Array.from({ length: 9 }).map((_, index) => (
              <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <Skeleton className="size-4 shrink-0 rounded" />
                <Skeleton className="h-3.5" style={{ width: `${48 + ((index * 13) % 38)}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-hidden p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-52" />
            <Skeleton className="h-4 w-full max-w-lg" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-full rounded-md" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolkitDetailView(props: {
  toolkit: ToolkitResponse;
  showOwnerLabels: boolean;
  tools: readonly ToolRow[];
  integrations: readonly Integration[];
  integrationPlugins: readonly IntegrationPlugin[];
  orgSlug?: string;
  onBack: () => void;
  onRemoveToolkit: (toolkit: ToolkitResponse) => void;
}) {
  const policies = useAtomValue(toolkitPoliciesAtom(props.toolkit.id));
  const connections = useAtomValue(toolkitConnectionsAtom(props.toolkit.id));
  const doCreatePolicy = useAtomSet(createToolkitPolicy, { mode: "promiseExit" });
  const doUpdatePolicy = useAtomSet(updateToolkitPolicy, { mode: "promiseExit" });
  const doRemovePolicy = useAtomSet(removeToolkitPolicy, { mode: "promiseExit" });
  const doCreateConnection = useAtomSet(createToolkitConnection, { mode: "promiseExit" });
  const doRemoveConnection = useAtomSet(removeToolkitConnection, { mode: "promiseExit" });
  const policyRows = AsyncResult.isSuccess(policies) ? policies.value.policies : [];
  const connectionRows = AsyncResult.isSuccess(connections) ? connections.value.connections : [];

  const setPolicyHandler = async (pattern: string, action: ToolPolicyAction) => {
    const existing = policyRows.find((policy) => policy.pattern === pattern);
    if (existing) {
      await doUpdatePolicy({
        params: { toolkitId: props.toolkit.id, policyId: existing.id },
        payload: { action },
        reactivityKeys: toolkitWriteKeys,
      });
      return;
    }
    await doCreatePolicy({
      params: { toolkitId: props.toolkit.id },
      payload: { pattern, action },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const addConnectionHandler = async (pattern: string) => {
    await doCreateConnection({
      params: { toolkitId: props.toolkit.id },
      payload: { pattern },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const removeConnectionHandler = async (connectionId: string) => {
    await doRemoveConnection({
      params: { toolkitId: props.toolkit.id, connectionId },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const clearPolicyHandler = async (pattern: string) => {
    const existing = policyRows.find((policy) => policy.pattern === pattern);
    if (!existing) return;
    await doRemovePolicy({
      params: { toolkitId: props.toolkit.id, policyId: existing.id },
      reactivityKeys: toolkitWriteKeys,
    });
  };

  if (AsyncResult.isFailure(policies) || AsyncResult.isFailure(connections)) {
    return <div className="p-6 text-sm text-destructive">Failed to load workspace</div>;
  }
  if (!AsyncResult.isSuccess(policies) || !AsyncResult.isSuccess(connections)) {
    return <ToolkitDetailSkeleton />;
  }

  return (
    <ToolkitWorkspace
      toolkit={props.toolkit}
      showOwnerLabels={props.showOwnerLabels}
      policies={policyRows}
      connections={connectionRows}
      tools={props.tools}
      integrations={props.integrations}
      integrationPlugins={props.integrationPlugins}
      mcpUrl={toolkitUrlFor(props.orgSlug, props.toolkit.slug)}
      onBack={props.onBack}
      onRemoveToolkit={() => props.onRemoveToolkit(props.toolkit)}
      onAddConnection={addConnectionHandler}
      onRemoveConnection={removeConnectionHandler}
      onSetPolicy={setPolicyHandler}
      onClearPolicy={clearPolicyHandler}
    />
  );
}

export function ToolkitsPage(props: PluginPageProps) {
  const navigate = useNavigate();
  const organizationSlug = useOrganizationSlug();
  const ownerDisplay = useOwnerDisplay();
  const integrationPlugins = useIntegrationPlugins();
  const toolkits = useAtomValue(toolkitsAtom);
  const tools = useAtomValue(toolsAllAtom);
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const doCreateToolkit = useAtomSet(createToolkit, { mode: "promiseExit" });
  const doRemoveToolkit = useAtomSet(removeToolkit, { mode: "promiseExit" });
  const selectedToolkitSlug = props.params.toolkitSlug ?? null;

  const toolkitRows = AsyncResult.isSuccess(toolkits) ? toolkits.value.toolkits : [];
  const selectedToolkit =
    selectedToolkitSlug === null ? null : toolkitByRouteSlug(toolkitRows, selectedToolkitSlug);

  const toolRows = AsyncResult.isSuccess(tools) ? (tools.value as readonly ToolRow[]) : [];
  const integrationRows = AsyncResult.isSuccess(integrations)
    ? (integrations.value as readonly Integration[])
    : [];
  const toolkitsReady = AsyncResult.isSuccess(toolkits);
  const toolkitsFailed = AsyncResult.isFailure(toolkits);
  const toolsReady = AsyncResult.isSuccess(tools);
  const toolsFailed = AsyncResult.isFailure(tools);
  const navigateToIndex = () =>
    navigate({
      to: "/{-$orgSlug}/toolkits",
    });

  const createToolkitHandler = async (input: { owner: Owner; name: string }) => {
    await doCreateToolkit({
      payload: input,
      reactivityKeys: toolkitWriteKeys,
    });
  };

  const removeToolkitHandler = async (toolkit: ToolkitResponse) => {
    await doRemoveToolkit({
      params: { toolkitId: toolkit.id },
      reactivityKeys: toolkitWriteKeys,
    });
    await navigateToIndex();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {selectedToolkitSlug === null ? (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-sm font-semibold text-foreground">Workspaces</h1>
            {AsyncResult.isSuccess(toolkits) && (
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
                {toolkitRows.length} {toolkitRows.length === 1 ? "workspace" : "workspaces"}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {selectedToolkitSlug !== null && !toolkitsReady ? (
        toolkitsFailed ? (
          <div className="p-6 text-sm text-destructive">Failed to load workspace</div>
        ) : (
          <ToolkitDetailSkeleton />
        )
      ) : !toolkitsReady ? (
        toolkitsFailed ? (
          <div className="p-6 text-sm text-destructive">Failed to load workspaces</div>
        ) : (
          <ToolkitGridSkeleton showOwnerLabels={ownerDisplay.showOwnerLabels} />
        )
      ) : selectedToolkit ? (
        toolsFailed ? (
          <div className="p-6 text-sm text-destructive">Failed to load workspace tools</div>
        ) : !toolsReady ? (
          <ToolkitDetailSkeleton />
        ) : (
          <ToolkitDetailView
            toolkit={selectedToolkit}
            showOwnerLabels={ownerDisplay.showOwnerLabels}
            tools={toolRows}
            integrations={integrationRows}
            integrationPlugins={integrationPlugins}
            orgSlug={organizationSlug ?? undefined}
            onBack={() => void navigateToIndex()}
            onRemoveToolkit={removeToolkitHandler}
          />
        )
      ) : selectedToolkitSlug !== null ? (
        <div className="flex min-h-0 flex-1 flex-col p-6">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void navigateToIndex()}
            className="mb-4 w-fit -ml-1 text-muted-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Workspaces
          </Button>
          <div className="text-sm text-muted-foreground">Workspace not found</div>
        </div>
      ) : (
        <ToolkitGrid toolkits={toolkitRows} onCreate={createToolkitHandler} />
      )}
    </div>
  );
}
