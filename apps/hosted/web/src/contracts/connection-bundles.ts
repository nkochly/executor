/** Admin-managed connection bundles, the members-create switch, and oversight of every member's connections. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { Bundle, BundleId, BundleInput } from "@executor-js/hosted-server/connection-bundles";
import type { ConnectionId } from "@executor-js/mcp-auth/connections";
import type { GrantId } from "@executor-js/mcp-auth/grants";
import { acknowledge, acknowledgedQuery, upsert } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";
import { mcpConnectionsAtom } from "./mcp-connections.ts";

/** The organization's bundles and setting; members read only the setting. */
export const bundlesAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("connectionBundles", "list", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
/** Every member's connections and agents, for admins. */
export const memberConnectionsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("connectionBundles", "members", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);

type Save = {
  readonly input: BundleInput;
  readonly existing: Pick<Bundle, "id" | "revision"> | null;
};
/** An edit submits the revision it was read at; members' copies follow on the server. */
export const saveBundleAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((input: Save, get) =>
    Effect.flatMap(HostedClient, (client) =>
      input.existing === null
        ? client.connectionBundles.create({ params: { organization }, payload: input.input })
        : client.connectionBundles.update({
            params: { organization, bundle: input.existing.id },
            payload: { ...input.input, revision: input.existing.revision },
          }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() => {
          acknowledge(get, bundlesAtom(organization), (current) => ({
            ...current,
            bundles: upsert(current.bundles, saved),
          }));
          get.refresh(memberConnectionsAtom(organization));
          get.refresh(mcpConnectionsAtom(organization));
        }),
      ),
    ),
  ),
);
/** Removing a bundle revokes every member's copy of it. */
export const removeBundleAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((bundle: Pick<Bundle, "id" | "revision">, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.connectionBundles.remove({
        params: { organization, bundle: bundle.id },
        payload: { revision: bundle.revision },
      }),
    ).pipe(
      Effect.tap((removed: { readonly id: BundleId }) =>
        Effect.sync(() => {
          acknowledge(get, bundlesAtom(organization), (current) => ({
            ...current,
            bundles: current.bundles.filter((item) => item.id !== removed.id),
          }));
          get.refresh(memberConnectionsAtom(organization));
          get.refresh(mcpConnectionsAtom(organization));
        }),
      ),
    ),
  ),
);
/** Turns members' own connections on or off for the whole organization. */
export const connectionSettingsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((membersCreateConnections: boolean, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.connectionBundles.settings({
        params: { organization },
        payload: { membersCreateConnections },
      }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() =>
          acknowledge(get, bundlesAtom(organization), (current) => ({
            ...current,
            membersCreateConnections: saved.membersCreateConnections,
          })),
        ),
      ),
    ),
  ),
);
/** An admin revokes one member's connection; a bundle's copy comes back on the next read. */
export const revokeMemberConnectionAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn(
    (input: { readonly user: string; readonly connection: ConnectionId }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.connectionBundles.revokeMemberConnection({
          params: { organization, user: input.user, connection: input.connection },
        }),
      ).pipe(Effect.tap(() => Effect.sync(() => get.refresh(memberConnectionsAtom(organization))))),
  ),
);
/** An admin disconnects one of a member's agents. */
export const revokeMemberAgentAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((input: { readonly user: string; readonly agent: GrantId }, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.connectionBundles.revokeMemberAgent({
        params: { organization, user: input.user, agent: input.agent },
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => get.refresh(memberConnectionsAtom(organization))))),
  ),
);
