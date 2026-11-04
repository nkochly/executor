// ---------------------------------------------------------------------------
// Which workspaces (toolkits) use a connection, for the connection's own row.
//
// The toolkits plugin owns workspaces; this reads its HTTP API with the
// console's own auth, so the accounts list can name the workspaces that pick
// each connection without importing the plugin. A host without the plugin
// answers nothing, and the rows then name no workspaces.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { matchPattern, type Connection } from "@executor-js/sdk/shared";

import {
  getExecutorApiBaseUrl,
  getExecutorOrganizationHeaders,
  getExecutorServerAuthorizationHeader,
} from "../api/server-connection";

export interface WorkspaceUse {
  readonly name: string;
  readonly patterns: readonly string[];
}

const ToolkitList = Schema.Struct({
  toolkits: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
const ToolkitConnections = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ pattern: Schema.String })),
});
const decodeList = Schema.decodeUnknownOption(ToolkitList);
const decodeConnections = Schema.decodeUnknownOption(ToolkitConnections);

const getJson = (path: string): Effect.Effect<unknown, unknown> =>
  Effect.tryPromise(async () => {
    const authorization = getExecutorServerAuthorizationHeader();
    const response = await fetch(`${getExecutorApiBaseUrl()}${path}`, {
      headers: {
        ...getExecutorOrganizationHeaders(),
        ...(authorization === null ? {} : { authorization }),
      },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body;
  });

const loadWorkspaceUses = (): Promise<readonly WorkspaceUse[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const list = Option.getOrNull(decodeList(yield* getJson("/toolkits")));
      if (list === null) return [];
      return yield* Effect.forEach(
        list.toolkits,
        (toolkit) =>
          getJson(`/toolkits/${encodeURIComponent(toolkit.id)}/connections`).pipe(
            Effect.map((body) => ({
              name: toolkit.name,
              patterns: Option.match(decodeConnections(body), {
                onNone: () => [],
                onSome: (value) => value.connections.map((row) => row.pattern),
              }),
            })),
          ),
        { concurrency: 4 },
      );
    }).pipe(Effect.orElseSucceed((): readonly WorkspaceUse[] => [])),
  );

/** Every workspace with the connection patterns it picks; empty until loaded. */
export function useWorkspaceUses(): readonly WorkspaceUse[] {
  const [uses, setUses] = useState<readonly WorkspaceUse[]>([]);
  useEffect(() => {
    let live = true;
    void loadWorkspaceUses().then((value) => {
      if (live) setUses(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return uses;
}

/** A tool id under this connection, in both shapes a workspace pattern names it by. */
const connectionToolIds = (connection: Connection): readonly string[] => [
  `${connection.integration}.${connection.owner}.${connection.name}.tool`,
  `${connection.integration}.${connection.name}.tool`,
];

/** The workspaces whose picks reach this connection, by name. */
export const workspacesUsing = (
  connection: Connection,
  uses: readonly WorkspaceUse[],
): readonly string[] => {
  const ids = connectionToolIds(connection);
  return uses
    .filter((use) => use.patterns.some((pattern) => ids.some((id) => matchPattern(pattern, id))))
    .map((use) => use.name);
};
