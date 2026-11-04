import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import {
  OAUTH_POPUP_MESSAGE_TYPE,
  AuthTemplateSlug,
  OAuthState,
  type AuthMethodDescriptor,
  type Connection,
  type Integration,
  type IntegrationSlug,
  type OAuthClientSlug,
  type OAuthClientSummary,
  type OAuthProbeResult,
  type OAuthPopupResult,
  type Owner,
} from "@executor-js/sdk/shared";
import { toast } from "sonner";

import {
  cancelOAuth,
  checkConnectionHealth,
  connectionsAllAtom,
  integrationsOptimisticAtom,
  oauthClientsOptimisticAtom,
  oauthConnectionCompleted,
  probeOAuth,
  registerDynamicOAuthClient,
  startOAuth,
  updateConnection,
} from "../api/atoms";
import { listenForOAuthPopupResults, reserveOAuthPopup } from "../api/oauth-popup";
import { useOrganizationId } from "../api/organization-context";
import {
  connectionCheckKeys,
  connectionWriteKeys,
  oauthClientWriteKeys,
} from "../api/reactivity-keys";
import { defaultConnectionOwnerForHost } from "../plugins/connection-owner";
import { useCanCreateWorkspaceConnections } from "../multiplayer/use-admin-nav";
import { oauthCallbackUrl, type OAuthCompletionPayload } from "../plugins/oauth-sign-in";
import {
  isFirstPartyClient,
  optimisticDcrClientSlug,
  selectClientsForEndpoints,
  type OAuthClientOption,
} from "../plugins/use-effective-oauth-client";
import {
  chainEntries,
  joinNames,
  sharedSignInGroup,
  signInHost,
  signInKey,
  type SignInHop,
} from "../lib/shared-sign-in";
import {
  connectionNameFrom,
  oauthIdentityLabelFromHealth,
  uniqueConnectionName,
} from "./add-account-modal";
import { registrationScopes } from "./oauth-client-form";
import { Button } from "./button";

// ---------------------------------------------------------------------------
// One Connect for every integration behind the same sign-in.
//
// Shown on an integration's Accounts tab when OAuth discovery puts it behind
// the same authorization server as other integrations. One click opens one
// sign-in window that runs each member's sign-in in turn (the callback page of
// each hop goes on to the next, see `OAUTH_CHAIN_STORAGE_PREFIX`), so a person
// already signed in to that sign-in passes straight through. Each member still
// becomes its own connection, removable on its own. Nothing connects without
// the click: a member that joins the group later shows here as not connected.
// ---------------------------------------------------------------------------

const POPUP_NAME = "executor-shared-sign-in";
const PROBE_TTL_MS = 5 * 60 * 1000;
const WAIT_LIMIT_MS = 10 * 60 * 1000;

interface Member {
  readonly slug: IntegrationSlug;
  readonly name: string;
  readonly discoveryUrl: string;
  readonly method: AuthMethodDescriptor;
}

const memberOf = (integration: Integration): Member | null => {
  const method = integration.authMethods.find(
    (candidate) => candidate.kind === "oauth" && candidate.oauth?.discoveryUrl,
  );
  const discoveryUrl = method?.oauth?.discoveryUrl;
  if (!method || !discoveryUrl) return null;
  return { slug: integration.slug, name: integration.name, discoveryUrl, method };
};

// Discovery answers rarely change; one probe per server per few minutes serves
// every Accounts tab the person opens.
const probeCache = new Map<
  string,
  { readonly at: number; readonly probe: OAuthProbeResult | null }
>();

const toOption = (client: OAuthClientSummary): OAuthClientOption | null =>
  client.grant === "authorization_code" || client.grant === "client_credentials"
    ? { ...client, grant: client.grant }
    : null;

export function SharedSignInCard(props: { readonly integration: IntegrationSlug }) {
  const { integration } = props;
  const organizationId = useOrganizationId();
  const defaultOwner: Owner = defaultConnectionOwnerForHost(organizationId);
  const canCreateWorkspaceConnections = useCanCreateWorkspaceConnections();

  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const clientsResult = useAtomValue(oauthClientsOptimisticAtom);
  const doProbe = useAtomSet(probeOAuth, { mode: "promiseExit" });
  const doRegister = useAtomSet(registerDynamicOAuthClient, { mode: "promiseExit" });
  const doStart = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doCancel = useAtomSet(cancelOAuth, { mode: "promiseExit" });
  const doCompleted = useAtomSet(oauthConnectionCompleted, { mode: "promiseExit" });
  const doCheckHealth = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const doUpdate = useAtomSet(updateConnection, { mode: "promiseExit" });

  const candidates = useMemo<readonly Member[]>(
    () =>
      AsyncResult.isSuccess(integrationsResult)
        ? integrationsResult.value.flatMap((entry) => {
            const member = memberOf(entry);
            return member ? [member] : [];
          })
        : [],
    [integrationsResult],
  );
  const connections = useMemo<readonly Connection[]>(
    () => (AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : []),
    [connectionsResult],
  );
  const clients = useMemo<readonly OAuthClientSummary[]>(
    () => (AsyncResult.isSuccess(clientsResult) ? clientsResult.value : []),
    [clientsResult],
  );

  const [probes, setProbes] = useState<ReadonlyMap<string, OAuthProbeResult | null>>(
    () => new Map(),
  );
  const urlsKey = candidates.map((member) => member.discoveryUrl).join("\n");
  useEffect(() => {
    let live = true;
    const urls = urlsKey.length > 0 ? urlsKey.split("\n") : [];
    // One probe at a time: `probeOAuth` is one shared mutation atom, and a new
    // call interrupts the one in flight and hands its result to every waiter.
    void (async () => {
      const entries: (readonly [string, OAuthProbeResult | null])[] = [];
      for (const url of urls) {
        const cached = probeCache.get(url);
        if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
          entries.push([url, cached.probe]);
          continue;
        }
        const exit = await doProbe({ payload: { url }, reactivityKeys: [] });
        if (!live) return;
        const probe = Exit.isSuccess(exit) ? exit.value : null;
        probeCache.set(url, { at: Date.now(), probe });
        entries.push([url, probe]);
      }
      if (live) setProbes(new Map(entries));
    })();
    return () => {
      live = false;
    };
  }, [doProbe, urlsKey]);

  const keyOf = useCallback(
    (member: Member): string | null => {
      const probe = probes.get(member.discoveryUrl);
      return probe ? signInKey(probe) : null;
    },
    [probes],
  );
  const current = candidates.find((member) => member.slug === integration) ?? null;
  const currentKey = current ? keyOf(current) : null;
  const group = useMemo(
    () =>
      sharedSignInGroup(
        currentKey,
        candidates.map((member) => ({ key: keyOf(member), member })),
      ),
    [candidates, currentKey, keyOf],
  );
  const isConnected = useCallback(
    (member: Member) =>
      connections.some(
        // Any connection the person can use counts, Workspace or Personal: the
        // group only offers what is missing.
        (connection) => connection.integration === member.slug,
      ),
    [connections],
  );
  const pending = group.filter((member) => !isConnected(member));
  // New members join the way the group is already connected: Workspace when a
  // member already is and this person may add Workspace connections, else the
  // host's default (Personal).
  const groupOwner = connections.find((connection) =>
    group.some((member) => member.slug === connection.integration),
  )?.owner;
  const owner: Owner =
    groupOwner === "org"
      ? canCreateWorkspaceConnections
        ? "org"
        : defaultOwner
      : (groupOwner ?? defaultOwner);

  const [busy, setBusy] = useState(false);
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);

  /** The client a member signs in through: a host app that matches its sign-in
   *  first, else a dynamically registered one. Null when neither is possible;
   *  that member is then connected on its own page. */
  const clientFor = async (
    member: Member,
    probe: OAuthProbeResult,
  ): Promise<{ readonly slug: OAuthClientSlug; readonly owner: Owner } | null> => {
    const options = clients.flatMap((client) => {
      const option = toOption(client);
      return option ? [option] : [];
    });
    const firstParty = selectClientsForEndpoints(options, {
      integration: member.slug,
      tokenUrl: probe.tokenUrl,
      authorizationUrl: probe.authorizationUrl,
      scopes: member.method.oauth?.scopes,
      discoversScopes: true,
      requireEndpointMatch: true,
    }).matched.find(isFirstPartyClient);
    if (firstParty) return { slug: firstParty.slug, owner: firstParty.owner };
    if (!probe.registrationEndpoint) return null;
    const exit = await doRegister({
      payload: {
        owner,
        slug: optimisticDcrClientSlug(probe.issuer ?? probe.registrationEndpoint),
        issuer: probe.issuer ?? null,
        registrationEndpoint: probe.registrationEndpoint,
        authorizationUrl: probe.authorizationUrl,
        tokenUrl: probe.tokenUrl,
        resource: probe.resource ?? member.discoveryUrl,
        scopes: registrationScopes(member.method.oauth?.scopes ?? [], probe.scopesSupported ?? []),
        tokenEndpointAuthMethodsSupported: probe.tokenEndpointAuthMethodsSupported,
        clientName: "Executor",
        redirectUri: oauthCallbackUrl(),
        originIntegration: member.slug,
      },
      reactivityKeys: oauthClientWriteKeys,
    });
    return Exit.isSuccess(exit) ? { slug: exit.value.client, owner } : null;
  };

  /** Name a fresh connection by the account its server reports, as a
   *  connection made from the Add dialog is. */
  const nameByAccount = async (result: OAuthCompletionPayload) => {
    const check = await doCheckHealth({
      params: { owner: result.owner, integration: result.integration, name: result.name },
      query: {},
      reactivityKeys: connectionCheckKeys,
    });
    if (Exit.isFailure(check)) return;
    const identityLabel = oauthIdentityLabelFromHealth({
      result: check.value,
      typedLabel: "",
      storedIdentityLabel: result.identityLabel,
    });
    if (identityLabel === null) return;
    await doUpdate({
      params: { owner: result.owner, integration: result.integration, name: result.name },
      payload: { identityLabel },
      reactivityKeys: connectionWriteKeys,
    });
  };

  const connectAll = async () => {
    // Claimed on the click: every hop after this runs in this one window.
    const reserved = reserveOAuthPopup({ popupName: POPUP_NAME });
    if (reserved === null) {
      toast.error("The browser blocked the sign-in window. Allow pop-ups and try again.");
      return;
    }
    const popup = reserved.popup;
    setBusy(true);

    const hops: (SignInHop & { readonly member: Member })[] = [];
    const skipped: string[] = [];
    for (const member of pending) {
      const probe = probes.get(member.discoveryUrl);
      const client = probe ? await clientFor(member, probe) : null;
      if (!client) {
        skipped.push(member.name);
        continue;
      }
      const taken = new Set(
        connections
          .filter(
            (connection) => connection.integration === member.slug && connection.owner === owner,
          )
          .map((connection) => String(connection.name)),
      );
      const exit = await doStart({
        payload: {
          client: client.slug,
          clientOwner: client.owner,
          owner,
          name: uniqueConnectionName(
            connectionNameFrom("", owner, member.name, organizationId),
            taken,
          ),
          integration: member.slug,
          template: AuthTemplateSlug.make(member.method.template),
          newConnection: true,
          redirectUri: oauthCallbackUrl(),
        },
      });
      if (Exit.isFailure(exit)) {
        skipped.push(member.name);
        continue;
      }
      if (exit.value.status === "redirect") {
        hops.push({
          state: String(exit.value.state),
          authorizationUrl: exit.value.authorizationUrl,
          member,
        });
      }
    }

    if (hops.length === 0) {
      popup.close();
      setBusy(false);
      await doCompleted({ reactivityKeys: connectionWriteKeys });
      if (skipped.length > 0) {
        toast.error(
          `Couldn't start the sign-in for ${joinNames(skipped)}. Connect it on its own page.`,
        );
      }
      return;
    }

    const entries = chainEntries(hops);
    const clearChain = () => {
      for (const entry of entries) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled)
        try {
          localStorage.removeItem(entry.key);
        } catch {
          // Nothing stored, nothing to clear.
        }
      }
    };
    for (const entry of entries) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled)
      try {
        localStorage.setItem(entry.key, entry.value);
      } catch {
        // Without storage the window closes after the first sign-in; the rest
        // stay listed here as not connected.
      }
    }

    const waiting = new Set(hops.map((hop) => hop.state));
    let naming: Promise<void> = Promise.resolve();
    const connected: string[] = [];
    let stopListening = () => {};
    const finish = (failure: string | null) => {
      stopListening();
      clearTimeout(timer);
      teardownRef.current = null;
      clearChain();
      for (const state of waiting) void doCancel({ payload: { state: OAuthState.make(state) } });
      waiting.clear();
      setBusy(false);
      void doCompleted({ reactivityKeys: connectionWriteKeys });
      if (connected.length > 0) toast.success(`Connected ${joinNames(connected)}`);
      if (failure) toast.error(failure);
      else if (skipped.length > 0) {
        toast.error(
          `Connect ${joinNames(skipped)} on its own page; its sign-in couldn't start here.`,
        );
      }
    };
    const timer = setTimeout(() => {
      const left = hops.filter((hop) => waiting.has(hop.state)).map((hop) => hop.member.name);
      finish(`The sign-in for ${joinNames(left)} didn't finish. Try again.`);
    }, WAIT_LIMIT_MS);
    stopListening = listenForOAuthPopupResults<OAuthCompletionPayload>({
      channelName: OAUTH_POPUP_MESSAGE_TYPE,
      onResult: (result: OAuthPopupResult<OAuthCompletionPayload>) => {
        const state = result.sessionId;
        if (state === null || !waiting.has(state)) return;
        waiting.delete(state);
        const hop = hops.find((candidate) => candidate.state === state);
        if (!result.ok) {
          finish(`${hop?.member.name ?? "A"} sign-in failed: ${result.error}`);
          return;
        }
        if (hop) connected.push(hop.member.name);
        // One health check at a time, for the same shared-atom reason as probes.
        naming = naming.then(() => nameByAccount(result));
        void doCompleted({ reactivityKeys: connectionWriteKeys });
        if (waiting.size === 0) finish(null);
      },
    });
    teardownRef.current = () => finish(null);

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the browser may have invalidated the window handle
    try {
      popup.location.href = hops[0]!.authorizationUrl;
    } catch {
      finish("The sign-in window closed before it opened. Try again.");
    }
  };

  const cancel = () => {
    teardownRef.current?.();
  };

  if (group.length === 0 || currentKey === null) return null;
  const names = group.map((member) => member.name);

  return (
    <section className="rounded-lg border border-border/60 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">One sign-in for {joinNames(names)}</p>
          <p className="text-sm text-muted-foreground">
            {pending.length === 0
              ? `All of them are connected. They sign in through ${signInHost(currentKey)}.`
              : `They sign in through ${signInHost(currentKey)}. Connect them together in one window.`}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
            {group.map((member) => (
              <li key={String(member.slug)}>
                {member.name}: {isConnected(member) ? "connected" : "not connected"}
              </li>
            ))}
          </ul>
        </div>
        {pending.length > 0 ? (
          busy ? (
            <Button type="button" variant="outline" size="sm" onClick={cancel}>
              Stop waiting
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => void connectAll()}>
              Connect {joinNames(pending.map((member) => member.name))}
            </Button>
          )
        ) : null}
      </div>
    </section>
  );
}
