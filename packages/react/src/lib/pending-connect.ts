import type { IntegrationSlug, Owner } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// A Connect clicked on one page and run on another.
//
// A workspace page offers Connect for an integration; the connection is made
// on that integration's page, which owns its auth methods. The workspace page
// leaves a request here and navigates; the integration page takes it on
// arrival, starts the sign-in as Add connection does, and hands each new
// connection back so the workspace can turn it on. A request is taken once,
// only by the integration it names, and only shortly after the click.
// ---------------------------------------------------------------------------

/** A connection the add-connection flow created. */
export interface AddedConnection {
  readonly owner: Owner;
  readonly integration: IntegrationSlug;
  readonly name: string;
}

export interface PendingConnect {
  readonly integration: string;
  readonly at: number;
  readonly onConnected: (connection: AddedConnection) => Promise<void> | void;
}

/** How long a request waits for its integration page. */
export const PENDING_CONNECT_TTL_MS = 30_000;

let pending: PendingConnect | null = null;

export const leavePendingConnect = (request: PendingConnect): void => {
  pending = request;
};

/** The waiting request for `integration`, removed as it is taken. */
export const takePendingConnect = (
  integration: string,
  now: number = Date.now(),
): PendingConnect | null => {
  const request = pending;
  if (request === null || request.integration !== integration) return null;
  pending = null;
  return now - request.at <= PENDING_CONNECT_TTL_MS ? request : null;
};

/** The pattern that turns one connection on in a workspace. */
export const connectionPattern = (connection: AddedConnection): string =>
  `${String(connection.integration)}.${connection.owner}.${connection.name}.*`;
