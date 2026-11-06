/**
 * Connection bundles: admins choose apps and tools once and give them to groups. Each member of an
 * assigned group gets the bundle as a locked connection that runs as their own linked accounts.
 * Admins also decide whether members may make connections of their own, and see and revoke every
 * member's connections and connected agents.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { useId, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { AppId, ToolName } from "@executor-js/sdk";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { QueryView, usePreload } from "@executor-js/ui/dashboard/context";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import {
  type Bundle,
  type BundleApp,
  BundleConflict,
  type BundlesView,
  bundleSlug,
} from "@executor-js/hosted-server/connection-bundles";
import { GroupId } from "@executor-js/hosted-server/groups";
import { type OrganizationPageReads, useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import {
  bundlesAtom,
  connectionSettingsAtom,
  memberConnectionsAtom,
  removeBundleAtom,
  revokeMemberAgentAtom,
  revokeMemberConnectionAtom,
  saveBundleAtom,
} from "../../contracts/connection-bundles.ts";
import { appError, type HostedError } from "../../contracts/errors.ts";

export const bundlesTitle = "Bundles";

/** The one MCP URL every member of a bundle's groups connects at; each reaches their own copy. */
const bundleUrl = (name: string) => `${window.location.origin}/mcp?connection=${bundleSlug(name)}`;

/** Admins read bundles, the apps and groups to choose from, and every member's connections. */
export const bundlesPageReads: OrganizationPageReads = (organization) => [
  bundlesAtom(organization),
];

export function BundlesPage() {
  const { organization, role } = useOrganizationRoute();
  usePreload(...bundlesPageReads(organization, {}));
  useDocumentTitle(productTitle(bundlesTitle));
  const admin = role === "admin" || role === "owner";
  return (
    <PageFrame>
      <PageHeader
        title={bundlesTitle}
        description="Give groups ready-made connections. Members can use them but not change them."
      />
      <QueryView query={bundlesAtom(organization)} Failure={HostedFailure}>
        {(data) =>
          data.canManage && admin ? (
            <>
              <MembersSetting allowed={data.membersCreateConnections} />
              <Bundles data={data} />
              <MemberOversight />
            </>
          ) : (
            <EmptyState title="Only admins manage bundles">
              Your connections are on the Connections page. Ask an organization admin to change a
              bundle.
            </EmptyState>
          )
        }
      </QueryView>
    </PageFrame>
  );
}

function MembersSetting({ allowed }: { readonly allowed: boolean }) {
  const { organization } = useOrganizationRoute();
  const save = useAtomSet(connectionSettingsAtom(organization), { mode: "promiseExit" });
  const saving = useAtomValue(connectionSettingsAtom(organization));
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  const id = useId();
  return (
    <section className="mb-8 rounded-lg border p-5">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-foreground"
          checked={allowed}
          disabled={saving.waiting}
          onChange={async (event) => {
            setError(undefined);
            const result = await save(event.target.checked);
            if (Exit.isFailure(result)) setError(result.cause);
          }}
        />
        <span>
          <span className="block text-sm font-medium">Members can make their own connections</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            When this is off, members use only the bundles given to their groups. Their own
            connections and the full-access URL stop working; admins are not affected.
          </span>
        </span>
      </label>
      {error && (
        <div className="mt-3">
          <HostedFailure cause={error} />
        </div>
      )}
    </section>
  );
}

const toolsLabel = (tools: BundleApp["tools"]) =>
  tools.kind === "all"
    ? "All tools"
    : tools.kind === "readOnly"
      ? "Read-only tools"
      : `${tools.names.length} ${tools.names.length === 1 ? "tool" : "tools"}`;

function Bundles({ data }: { readonly data: typeof BundlesView.Type }) {
  const { organization } = useOrganizationRoute();
  const [edit, setEdit] = useState<Bundle | "new" | null>(null);
  const [removing, setRemoving] = useState<Bundle | null>(null);
  const [removeError, setRemoveError] = useState<Cause.Cause<HostedError>>();
  const remove = useAtomSet(removeBundleAtom(organization), { mode: "promiseExit" });
  const deletion = useAtomValue(removeBundleAtom(organization));
  const appNames = new Map(data.apps.map((app) => [app.id, app.name]));
  const groupNames = new Map(data.groups.map((group) => [group.id, group.name]));
  const bundles = data.bundles.toSorted((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Bundles · {bundles.length}</h2>
        <Button onClick={() => setEdit("new")}>
          <HugeiconsIcon icon={Add01Icon} size={16} />
          Create bundle
        </Button>
      </div>
      {bundles.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bundles.map((bundle) => (
            <div
              key={bundle.id}
              role="listitem"
              aria-label={bundle.name}
              className="flex flex-col rounded-lg border p-5"
            >
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <HugeiconsIcon icon={SquareLock02Icon} size={15} aria-hidden />
                {bundle.name}
              </h3>
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {bundleUrl(bundle.name)}
              </p>
              <ul className="mt-3 space-y-1 text-xs">
                {bundle.apps.map((item) => (
                  <li key={item.app} className="flex justify-between gap-3">
                    <span className="truncate">{appNames.get(item.app) ?? "Unavailable app"}</span>
                    <span className="shrink-0 text-muted-foreground">{toolsLabel(item.tools)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                {bundle.groups.length
                  ? `Groups: ${bundle.groups.map((id) => groupNames.get(id) ?? "Unavailable group").join(", ")}`
                  : "Not given to any group yet"}
              </p>
              <div className="mt-auto flex gap-2 pt-4">
                <Button size="sm" variant="outline" onClick={() => setEdit(bundle)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    setRemoveError(undefined);
                    setRemoving(bundle);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          size="compact"
          title="No bundles yet"
          action={
            <Button onClick={() => setEdit("new")}>
              <HugeiconsIcon icon={Add01Icon} size={16} />
              Create bundle
            </Button>
          }
        >
          A bundle picks apps and tools once and gives them to whole groups.
        </EmptyState>
      )}
      {edit && (
        <BundleEditor
          key={edit === "new" ? "new" : edit.id}
          bundle={edit === "new" ? null : edit}
          data={data}
          close={() => setEdit(null)}
        />
      )}
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !deletion.waiting) setRemoving(null);
          }}
        >
          <DialogContent>
            <DialogTitle>Delete {removing.name}?</DialogTitle>
            <DialogDescription>
              Every member's copy of this bundle is revoked, and agents using it lose access.
            </DialogDescription>
            {removeError && <HostedFailure cause={removeError} />}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={deletion.waiting}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={deletion.waiting}
                onClick={async () => {
                  const result = await remove(removing);
                  if (Exit.isFailure(result)) setRemoveError(result.cause);
                  else setRemoving(null);
                }}
              >
                Delete bundle
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

type ToolChoice = "all" | "readOnly" | "selected";
interface AppDraft {
  readonly tools: ToolChoice;
  readonly names: string;
}
const draftOf = (item: BundleApp): AppDraft => ({
  tools: item.tools.kind,
  names: item.tools.kind === "selected" ? item.tools.names.join(", ") : "",
});
const toolsOf = (draft: AppDraft): BundleApp["tools"] =>
  draft.tools === "selected"
    ? {
        kind: "selected",
        names: draft.names
          .split(/[\s,]+/u)
          .filter((name) => name.length > 0)
          .map((name) => ToolName.make(name)),
      }
    : { kind: draft.tools };

function BundleEditor({
  bundle,
  data,
  close,
}: {
  readonly bundle: Bundle | null;
  readonly data: typeof BundlesView.Type;
  readonly close: () => void;
}) {
  const { organization } = useOrganizationRoute();
  const save = useAtomSet(saveBundleAtom(organization), { mode: "promiseExit" });
  const saving = useAtomValue(saveBundleAtom(organization));
  const [name, setName] = useState(bundle?.name ?? "");
  const [apps, setApps] = useState<ReadonlyMap<string, AppDraft>>(
    () => new Map((bundle?.apps ?? []).map((item) => [item.app, draftOf(item)])),
  );
  const [groups, setGroups] = useState<ReadonlySet<string>>(() => new Set(bundle?.groups ?? []));
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();
  const trimmed = name.trim();
  const selectedEmpty = [...apps.values()].some(
    (draft) => draft.tools === "selected" && draft.names.trim() === "",
  );
  const valid = trimmed.length > 0 && trimmed.length <= 80 && apps.size > 0 && !selectedEmpty;
  const shownApps = data.apps.filter((app) =>
    app.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const setApp = (app: string, draft: AppDraft | undefined) =>
    setApps((previous) => {
      const next = new Map(previous);
      if (draft === undefined) next.delete(app);
      else next.set(app, draft);
      return next;
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving.waiting) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>{bundle ? "Edit bundle" : "Create bundle"}</DialogTitle>
        <DialogDescription>
          Members of the chosen groups get this as a connection they cannot change. Each app runs as
          the accounts the member links to it.
        </DialogDescription>
        <form
          noValidate
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid || saving.waiting) return;
            setError(undefined);
            const result = await save({
              existing: bundle,
              input: {
                name: trimmed,
                apps: [...apps].map(([app, draft]) => ({
                  app: AppId.make(app),
                  tools: toolsOf(draft),
                })),
                groups: [...groups].map((group) => GroupId.make(group)),
              },
            });
            if (Exit.isSuccess(result)) {
              close();
              return;
            }
            const failure = Cause.findErrorOption(result.cause);
            setError(
              Option.isSome(failure) &&
                failure.value instanceof BundleConflict &&
                failure.value.reason === "name_taken"
                ? "Another bundle already uses this name, or one with the same MCP URL. Choose another name."
                : appError(result.cause),
            );
          }}
        >
          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
          <div>
            <label htmlFor={`${id}-name`} className="block text-xs font-medium">
              Bundle name
            </label>
            <Input
              id={`${id}-name`}
              className="mt-2"
              maxLength={80}
              placeholder="Sales team"
              value={name}
              disabled={saving.waiting}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {bundleSlug(trimmed) === ""
                ? "The name makes the bundle's MCP URL, so it needs a letter or number."
                : `Members connect at ${bundleUrl(trimmed)}. Renaming the bundle changes this URL.`}
            </p>
          </div>
          <fieldset disabled={saving.waiting} className="space-y-2">
            <legend className="mb-2 text-xs font-medium">Apps · {apps.size} selected</legend>
            <Input
              aria-label="Search apps"
              placeholder="Search apps…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="max-h-72 overflow-y-auto rounded-lg border">
              {shownApps.map((app) => {
                const draft = apps.get(app.id);
                return (
                  <div key={app.id} className="border-b px-3 py-2.5 last:border-0">
                    <label className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-foreground"
                        checked={draft !== undefined}
                        onChange={(event) =>
                          setApp(
                            app.id,
                            event.target.checked ? { tools: "all", names: "" } : undefined,
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{app.name}</span>
                      {draft && (
                        <select
                          aria-label={`Tools for ${app.name}`}
                          className="rounded-md border bg-background px-2 py-1 text-xs"
                          value={draft.tools}
                          onChange={(event) =>
                            setApp(app.id, {
                              ...draft,
                              tools: event.target.value as ToolChoice,
                            })
                          }
                        >
                          <option value="all">All tools</option>
                          <option value="readOnly">Read-only tools</option>
                          <option value="selected">Selected tools</option>
                        </select>
                      )}
                    </label>
                    {draft?.tools === "selected" && (
                      <Input
                        aria-label={`Tool names for ${app.name}`}
                        className="mt-2"
                        placeholder="Tool names, separated by commas"
                        value={draft.names}
                        onChange={(event) =>
                          setApp(app.id, { ...draft, names: event.target.value })
                        }
                      />
                    )}
                  </div>
                );
              })}
              {!shownApps.length && (
                <EmptyState size="compact" icon={null} title="No matching apps">
                  Add apps on the Apps page first.
                </EmptyState>
              )}
            </div>
          </fieldset>
          <fieldset disabled={saving.waiting} className="space-y-2">
            <legend className="mb-2 text-xs font-medium">Groups · {groups.size} selected</legend>
            <div className="max-h-56 overflow-y-auto rounded-lg border">
              {data.groups.map((group) => (
                <label
                  key={group.id}
                  className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-0"
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-foreground"
                    checked={groups.has(group.id)}
                    onChange={(event) =>
                      setGroups((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(group.id);
                        else next.delete(group.id);
                        return next;
                      })
                    }
                  />
                  <span className="text-sm">{group.name}</span>
                </label>
              ))}
              {!data.groups.length && (
                <EmptyState size="compact" icon={null} title="No groups yet">
                  Create groups on the Groups page first.
                </EmptyState>
              )}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving.waiting} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving.waiting}
              disabledReason={valid ? undefined : "Name the bundle and include at least one app."}
            >
              {bundle ? "Save bundle" : "Create bundle"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberOversight() {
  const { organization } = useOrganizationRoute();
  const revokeConnection = useAtomSet(revokeMemberConnectionAtom(organization), {
    mode: "promiseExit",
  });
  const revokeAgent = useAtomSet(revokeMemberAgentAtom(organization), { mode: "promiseExit" });
  const connectionRevoking = useAtomValue(revokeMemberConnectionAtom(organization));
  const agentRevoking = useAtomValue(revokeMemberAgentAtom(organization));
  const [error, setError] = useState<Cause.Cause<HostedError>>();
  const busy = connectionRevoking.waiting || agentRevoking.waiting;
  return (
    <section>
      <h2 className="mb-1 text-sm font-medium">Members' connections</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Every member's connections and connected agents. A revoked bundle copy is made again while
        its member is in an assigned group.
      </p>
      {error && (
        <div className="mb-3">
          <HostedFailure cause={error} />
        </div>
      )}
      <QueryView query={memberConnectionsAtom(organization)} Failure={HostedFailure}>
        {(members) => (
          <div className="divide-y rounded-lg border">
            {members.map((member) => (
              <div key={member.userId} className="p-4">
                <p className="text-sm font-medium">
                  {member.name || member.email}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {member.email} · {member.role}
                  </span>
                </p>
                {member.connections.length === 0 && member.agents.length === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">No connections or agents.</p>
                )}
                <ul className="mt-2 space-y-1.5">
                  {member.connections.map((connection) => (
                    <li key={connection.id} className="flex items-center gap-3 text-xs">
                      <span className="min-w-0 flex-1 truncate">
                        {connection.name}
                        {connection.bundle && (
                          <span className="ml-2 text-muted-foreground">
                            bundle “{connection.bundle.name}”
                          </span>
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-destructive"
                        disabled={busy}
                        onClick={async () => {
                          setError(undefined);
                          const done = await revokeConnection({
                            user: member.userId,
                            connection: connection.id,
                          });
                          if (Exit.isFailure(done)) setError(done.cause);
                        }}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                  {member.agents.map((agent) => (
                    <li key={agent.id} className="flex items-center gap-3 text-xs">
                      <span className="min-w-0 flex-1 truncate">
                        Agent: {agent.name ?? "Unnamed agent"}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-destructive"
                        disabled={busy}
                        onClick={async () => {
                          setError(undefined);
                          const done = await revokeAgent({ user: member.userId, agent: agent.id });
                          if (Exit.isFailure(done)) setError(done.cause);
                        }}
                      >
                        Disconnect
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </QueryView>
    </section>
  );
}
