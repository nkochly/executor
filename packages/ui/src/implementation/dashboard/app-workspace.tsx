import { LocalTime } from "../components/local-time.tsx";
import { EmptyState } from "./empty-state.tsx";
import { AppWorkspaceLoading, SourceHistoryLoading } from "./app-loading.tsx";
import { AppSectionHeader, AppSectionTitle } from "./app-section-header.tsx";
/** Inspect agent-authored source and manage app versions. */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import { useState, type ReactNode } from "react";
import type { App } from "@executor-js/sdk";
import type { AppSourceDisplay } from "@executor-js/app-management/contracts";
import type { VersionDisplay } from "@executor-js/app-management/contracts/source-display";
import type { AppAcknowledgement, AppManagementProps } from "../../contracts/app-management.ts";
import type { Query } from "../../contracts/dashboard.ts";
import { QueryView, useDashboard } from "./context.tsx";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Textarea } from "../components/textarea.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/dialog.tsx";
import { SourceBrowser } from "./source-browser.tsx";
import { CopyButton } from "./code.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GitBranchIcon,
  GitCommitIcon,
  ArrowLeft02Icon,
  ArrowDown01Icon,
  Clock01Icon,
} from "@hugeicons/core-free-icons";

/**
 * Products supply metadata reconciliation and navigation. People edit skill files in the Skills
 * view and any other text file here; saving commits the file and deploys that commit.
 */
export function AppWorkspace<E>({
  app,
  atoms,
  Failure,
  onApp,
  view,
  live,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly onApp: AppAcknowledgement;
  readonly view: "source" | "history";
  /** The active version, read so the toolbar can compare it with working source. */
  readonly live?: Query<VersionDisplay, E> | undefined;
}) {
  return (
    <QueryView
      query={atoms.source(app.id)}
      Failure={Failure}
      pending={<AppWorkspaceLoading view={view} />}
    >
      {(source) => (
        <WorkspaceSource
          key={app.id}
          app={app}
          atoms={atoms}
          Failure={Failure}
          source={source}
          onApp={onApp}
          view={view}
          live={live}
        />
      )}
    </QueryView>
  );
}
function WorkspaceSource<E>({
  app,
  atoms,
  Failure,
  source,
  onApp,
  view,
  live,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly source: typeof AppSourceDisplay.Type;
  readonly onApp: AppAcknowledgement;
  readonly view: "source" | "history";
  readonly live?: Query<VersionDisplay, E> | undefined;
}) {
  const deployed = useAtomValue(atoms.deploy(app.id));
  const deploy = useAtomSet(atoms.deploy(app.id), { mode: "promise" });
  const pending = deployed.waiting;
  const [editing, setEditing] = useState<string>();
  return (
    <div className="source-section flex min-h-0 flex-1 flex-col [--source-sidebar-width:16rem]">
      <div className="grid min-h-12 shrink-0 grid-cols-[var(--source-sidebar-width)_minmax(0,1fr)] border-b max-md:grid-cols-1">
        <AppSectionHeader className="min-h-0 justify-start gap-2 border-b-0 border-r text-muted-foreground max-md:border-r-0">
          <HugeiconsIcon icon={GitBranchIcon} size={15} aria-hidden />
          <span className="font-mono text-foreground">main</span>
          <code title={source.revision.commit}>{source.revision.commit.slice(0, 7)}</code>
          <AppSectionTitle className="truncate text-foreground">Working source</AppSectionTitle>
        </AppSectionHeader>
        <AppSectionHeader className="min-h-0 flex-wrap border-b-0 text-muted-foreground">
          <SourceHistoryLink app={app} atoms={atoms} Failure={Failure} />
          <div className="flex flex-wrap items-center gap-2">
            {app.activeVersion === null ? (
              <DeployStatus>Not deployed</DeployStatus>
            ) : (
              live !== undefined && (
                <LiveStatus app={app} atoms={atoms} source={source} live={live} />
              )
            )}
            <CloneRepository source={source} />
            <DeployLatest
              source={source}
              live={app.activeVersion === null ? undefined : live}
              disabled={!source.canEdit || pending}
              onDeploy={() => {
                void deploy({
                  commit: source.revision.commit,
                  onApp,
                }).catch(() => {});
              }}
            />
          </div>
        </AppSectionHeader>
      </div>
      {AsyncResult.isFailure(deployed) && (
        <div className="shrink-0 p-3">
          {AsyncResult.isFailure(deployed) && <Failure cause={deployed.cause} />}
        </div>
      )}
      {AsyncResult.isSuccess(deployed) && (
        <p role="status" className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          Deployed. New calls use this version.
        </p>
      )}
      {view === "history" ? (
        <SourceHistory app={app} atoms={atoms} Failure={Failure} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-auto max-[1100px]:flex-col">
          <SourceBrowser
            files={source.files}
            file={(path) => atoms.sourceFile({ app: app.id, commit: source.revision.commit, path })}
            Failure={Failure}
            className="h-auto min-h-80 min-w-0 flex-1 rounded-none border-0"
            {...(source.canEdit ? { onEdit: (path: string) => setEditing(path) } : {})}
          />
        </div>
      )}
      {editing !== undefined && (
        <EditWorkingFile
          key={editing}
          app={app}
          atoms={atoms}
          Failure={Failure}
          path={editing}
          onApp={onApp}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
/** The editor starts from the working source's exact bytes, which the commit compares against. */
function EditWorkingFile<E>({
  app,
  atoms,
  Failure,
  path,
  onApp,
  onClose,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly path: string;
  readonly onApp: AppAcknowledgement;
  readonly onClose: () => void;
}) {
  return (
    <QueryView query={atoms.workspace(app.id)} Failure={Failure} pending={null}>
      {(source) => {
        const file = source.files.find((item) => item.path === path);
        const content =
          file !== undefined && "content" in file && typeof file.content === "string"
            ? file.content
            : undefined;
        return content === undefined ? null : (
          <EditSourceFile
            app={app}
            atoms={atoms}
            Failure={Failure}
            path={path}
            base={content}
            onApp={onApp}
            onClose={onClose}
          />
        );
      }}
    </QueryView>
  );
}
/** Change one file of the working source, then deploy the commit so new calls use it. */
function EditSourceFile<E>({
  app,
  atoms,
  Failure,
  path,
  base,
  onApp,
  onClose,
}: AppManagementProps<E> & {
  readonly app: App;
  readonly path: string;
  readonly base: string;
  readonly onApp: AppAcknowledgement;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(base);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const [changed, setChanged] = useState(false);
  const commit = useAtomSet(atoms.commitFile(app.id), { mode: "promiseExit" });
  const deploy = useAtomSet(atoms.deploy(app.id), { mode: "promiseExit" });
  const save = async () => {
    setSaving(true);
    setError(undefined);
    setChanged(false);
    const committed = await commit({ path, base, content: draft, message: `Edit ${path}` });
    if (Exit.isFailure(committed)) {
      setSaving(false);
      setError(committed.cause);
      return;
    }
    if (committed.value._tag === "FileChanged") {
      setSaving(false);
      setChanged(true);
      return;
    }
    const deployed = await deploy({ commit: committed.value.commit, onApp });
    setSaving(false);
    if (Exit.isFailure(deployed)) setError(deployed.cause);
    else onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogTitle className="font-mono text-base">{path}</DialogTitle>
        <DialogDescription>
          Saving commits this file and deploys it. Earlier versions stay in Versions, where you can
          switch back.
        </DialogDescription>
        <Textarea
          aria-label={`Contents of ${path}`}
          value={draft}
          spellCheck={false}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-[50vh] font-mono text-xs leading-5"
        />
        {changed && (
          <p role="alert" className="text-sm text-destructive">
            This file changed since you opened it. Close, reopen it, and make your change again.
          </p>
        )}
        {error !== undefined && <Failure cause={error} />}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || draft === base} onClick={() => void save()}>
            {saving ? "Saving…" : "Save and deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
/** Undefined until the live version is known; null when it was not deployed from a commit. */
function useLiveCommit<E>(live: Query<VersionDisplay, E>) {
  return Option.getOrUndefined(
    Option.map(AsyncResult.value(useAtomValue(live)), (version) => version.sourceCommit),
  );
}
function DeployStatus({ children }: { readonly children: ReactNode }) {
  return (
    <span role="status" className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      {children}
    </span>
  );
}
function LiveStatus<E>({
  app,
  atoms,
  source,
  live,
}: Pick<AppManagementProps<E>, "atoms"> & {
  readonly app: App;
  readonly source: typeof AppSourceDisplay.Type;
  readonly live: Query<VersionDisplay, E>;
}) {
  const commit = useLiveCommit(live);
  const history = AsyncResult.value(useAtomValue(atoms.history(app.id)));
  if (commit === undefined || commit === null) return null;
  if (commit === source.revision.commit) return <DeployStatus>Live · up to date</DeployStatus>;
  // History is newest first, so the live commit's index counts the commits saved after it.
  const newer = Option.isSome(history)
    ? history.value.findIndex((entry) => entry.commit === commit)
    : -1;
  return (
    <DeployStatus>
      Live <code title={commit}>{commit.slice(0, 7)}</code> ·{" "}
      {newer > 0
        ? `${newer} newer ${newer === 1 ? "commit" : "commits"} not deployed`
        : "newer changes not deployed"}
    </DeployStatus>
  );
}
function DeployLatest<E>({
  source,
  live,
  disabled,
  onDeploy,
}: {
  readonly source: typeof AppSourceDisplay.Type;
  readonly live: Query<VersionDisplay, E> | undefined;
  readonly disabled: boolean;
  readonly onDeploy: () => void;
}) {
  return live === undefined ? (
    <Button size="sm" disabled={disabled} onClick={onDeploy}>
      Deploy latest
    </Button>
  ) : (
    <DeployLiveLatest source={source} live={live} disabled={disabled} onDeploy={onDeploy} />
  );
}
function DeployLiveLatest<E>({
  source,
  live,
  disabled,
  onDeploy,
}: {
  readonly source: typeof AppSourceDisplay.Type;
  readonly live: Query<VersionDisplay, E>;
  readonly disabled: boolean;
  readonly onDeploy: () => void;
}) {
  const current = useLiveCommit(live) === source.revision.commit;
  return (
    <Button
      size="sm"
      disabled={disabled}
      disabledReason={current ? "Your latest saved changes are already live." : undefined}
      onClick={onDeploy}
    >
      Deploy latest
    </Button>
  );
}
function CloneRepository({ source }: { readonly source: typeof AppSourceDisplay.Type }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Clone
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Clone repository">
        <CloneDetails source={source} />
      </PopoverContent>
    </Popover>
  );
}
/** The host names the clone URL; Git may be served on another origin than the dashboard. */
function CloneDetails({ source }: { readonly source: typeof AppSourceDisplay.Type }) {
  const cloneUrl = source.gitUrl;
  return (
    <>
      <h2 className="text-sm font-medium">Clone</h2>
      <div className="mt-4 border-b pb-2 text-xs font-medium">
        {cloneUrl.startsWith("https:") ? "HTTPS" : "HTTP"}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Input
          aria-label="Git clone URL"
          readOnly
          value={cloneUrl}
          onFocus={(event) => event.target.select()}
          className="min-w-0 font-mono text-xs"
        />
        <CopyButton code={cloneUrl} label="Copy clone URL" inline />
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {source.canEdit
          ? "Clone to work locally. Push your changes, then deploy when you’re ready."
          : "Clone to read the files locally. Make a copy to change this app."}
      </p>
    </>
  );
}
function SourceHistoryLink<E>({
  app,
  atoms,
}: AppManagementProps<E> & {
  readonly app: App;
}) {
  const { AppLink } = useDashboard();
  const history = AsyncResult.value(useAtomValue(atoms.history(app.id)));
  // The endpoint returns recent history, not an unbounded repository-wide count.
  const label = Option.isSome(history)
    ? `${history.value.length} recent ${history.value.length === 1 ? "commit" : "commits"}`
    : "History";
  return (
    <AppLink
      app={app.id}
      view="history"
      aria-label={Option.isSome(history) ? `History: ${label}` : "History"}
      className="inline-flex min-h-8 items-center gap-1.5 whitespace-nowrap hover:text-foreground hover:underline"
    >
      <HugeiconsIcon icon={Clock01Icon} size={14} aria-hidden />
      {label}
    </AppLink>
  );
}
function SourceHistory<E>({ app, atoms, Failure }: AppManagementProps<E> & { readonly app: App }) {
  const { AppLink } = useDashboard();
  return (
    <section
      aria-label="Source history"
      className="min-h-0 flex-1 overflow-auto p-7 max-[740px]:p-4"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">History</h2>
        <AppLink
          app={app.id}
          view="source"
          className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={14} aria-hidden />
          Back to files
        </AppLink>
      </div>
      <QueryView query={atoms.history(app.id)} Failure={Failure} pending={<SourceHistoryLoading />}>
        {(history) =>
          history.length === 0 ? (
            <EmptyState title="No saved changes yet">
              Save a source change to start this app’s history.
            </EmptyState>
          ) : (
            <ol className="divide-y overflow-hidden rounded-lg border">
              {history.map((entry) => (
                <li key={entry.commit} className="flex items-start gap-3 p-4">
                  <HugeiconsIcon
                    icon={GitCommitIcon}
                    size={18}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">{entry.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.author} · <LocalTime value={entry.timestamp * 1000} />
                    </p>
                  </div>
                  <code className="shrink-0 text-xs text-muted-foreground" title={entry.commit}>
                    {entry.commit.slice(0, 7)}
                  </code>
                </li>
              ))}
            </ol>
          )
        }
      </QueryView>
    </section>
  );
}
