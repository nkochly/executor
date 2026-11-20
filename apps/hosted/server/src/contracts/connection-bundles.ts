import { AppId } from "@executor-js/sdk/core";
import { EventScope, ToolScope } from "@executor-js/authorization";
import { ConnectedAgent, ConnectedAgentNotFound } from "@executor-js/mcp-auth/agents";
import {
  ConnectionId,
  ConnectionName,
  ConnectionNotFound,
  ConnectionView,
} from "@executor-js/mcp-auth/connections";
import { GrantId } from "@executor-js/mcp-auth";
import { ApiError } from "@executor-js/utils/api-error";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AuthenticationUnavailable, RequireUser } from "./auth.ts";
import { RequiredAction } from "./authorization.ts";
import { GroupId } from "./groups.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  OrganizationRole,
  RequireOrganization,
} from "./organization.ts";

export const BundleId = Schema.NonEmptyString.pipe(Schema.brand("ConnectionBundleId"));
export type BundleId = typeof BundleId.Type;
export const BundleRevision = Schema.NonEmptyString.pipe(Schema.brand("ConnectionBundleRevision"));
export type BundleRevision = typeof BundleRevision.Type;

export const BundleApp = Schema.Struct({
  app: AppId,
  tools: ToolScope,
  events: Schema.optionalKey(EventScope),
});
export type BundleApp = typeof BundleApp.Type;
const uniqueApps = (apps: readonly { readonly app: string }[]) =>
  new Set(apps.map((item) => item.app)).size === apps.length;
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

export const BundleInput = Schema.Struct({
  name: ConnectionName,
  apps: Schema.Array(BundleApp).check(
    Schema.isMaxLength(200),
    Schema.makeFilter(uniqueApps, { message: "Each app can appear once in a bundle" }),
  ),
  groups: Schema.Array(GroupId).check(
    Schema.isMaxLength(1000),
    Schema.makeFilter(uniqueIds, { message: "Each group can appear once in a bundle" }),
  ),
});
export type BundleInput = typeof BundleInput.Type;
export const Bundle = Schema.Struct({
  id: BundleId,
  revision: BundleRevision,
  ...BundleInput.fields,
});
export type Bundle = typeof Bundle.Type;

export const bundleSlug = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");

export const BundleChoice = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.String });
export type BundleChoice = typeof BundleChoice.Type;
export const BundlesView = Schema.Struct({
  bundles: Schema.Array(Bundle),
  membersCreateConnections: Schema.Boolean,
  canManage: Schema.Boolean,
  apps: Schema.Array(BundleChoice),
  groups: Schema.Array(BundleChoice),
});
export type BundlesView = typeof BundlesView.Type;

export const HostedConnectionView = Schema.Struct({
  ...ConnectionView.fields,
  bundle: Schema.optionalKey(Schema.Struct({ id: BundleId, name: ConnectionName })),
});
export type HostedConnectionView = typeof HostedConnectionView.Type;

export const MemberConnections = Schema.Struct({
  userId: Schema.NonEmptyString,
  name: Schema.String,
  email: Schema.String,
  role: OrganizationRole,
  connections: Schema.Array(HostedConnectionView),
  agents: Schema.Array(ConnectedAgent),
});
export type MemberConnections = typeof MemberConnections.Type;

const bundleConflicts = {
  changed: "The bundle changed since it was read. Read it again and reapply the edit.",
  name_taken:
    "Another bundle in this organization already uses this name, or a name with the same MCP URL.",
} as const;
export const BundleConflict = ApiError.define({
  tag: "BundleConflict",
  status: 409,
  fields: { reason: Schema.Literals(["changed", "name_taken"]) },
  message: ({ reason }) => bundleConflicts[reason],
  recorded: ({ reason }) => bundleConflicts[reason],
});
export type BundleConflict = typeof BundleConflict.Type;
export const BundleNotFound = ApiError.define({
  tag: "BundleNotFound",
  status: 404,
  message: "This connection bundle does not exist.",
});
export type BundleNotFound = typeof BundleNotFound.Type;
export const BundleInvalid = ApiError.define({
  tag: "BundleInvalid",
  status: 400,
  fields: { reason: Schema.Literals(["app", "group", "name"]), id: Schema.String },
  message: ({ reason, id }) =>
    reason === "app"
      ? `App ${id} is not an app of this organization.`
      : reason === "group"
        ? `Group ${id} is not a group of this organization.`
        : "A bundle name needs at least one letter or digit, which make its MCP URL.",
  recorded: ({ reason }) => `A bundle named a ${reason} outside its organization`,
});
export type BundleInvalid = typeof BundleInvalid.Type;
export const BundlesUnavailable = ApiError.define({
  tag: "BundlesUnavailable",
  status: 503,
  message: "Executor could not read or save connection bundles. Try again.",
});
export type BundlesUnavailable = typeof BundlesUnavailable.Type;
export const ConnectionManaged = ApiError.define({
  tag: "ConnectionManaged",
  status: 409,
  fields: { connection: ConnectionId },
  message:
    "This connection comes from a bundle your organization's admins manage. Ask an admin to change it.",
  recorded: () => "A member tried to change a connection a bundle manages",
});
export type ConnectionManaged = typeof ConnectionManaged.Type;
export const ConnectionsRestricted = ApiError.define({
  tag: "ConnectionsRestricted",
  status: 403,
  message:
    "Your organization's admins set up your connections. Use a bundle from your Connect page, or ask an admin.",
});
export type ConnectionsRestricted = typeof ConnectionsRestricted.Type;

const organization = { organization: OrganizationReference };
const bundle = { ...organization, bundle: BundleId };
const member = { ...organization, user: Schema.NonEmptyString };
const errors = [OrganizationForbidden, BundlesUnavailable, AuthenticationUnavailable] as const;
const saveErrors = [...errors, BundleConflict, BundleNotFound, BundleInvalid] as const;
const path = "/api/organizations/:organization/connection-bundles";
const oversight = "/api/organizations/:organization/member-connections";

export const HostedConnectionBundles = HttpApiGroup.make("connectionBundles")
  .add(
    HttpApiEndpoint.get("list", path, {
      params: organization,
      success: BundlesView,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", path, {
      params: organization,
      payload: BundleInput,
      success: Bundle,
      error: saveErrors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.put("update", `${path}/:bundle`, {
      params: bundle,
      payload: Schema.Struct({ ...BundleInput.fields, revision: BundleRevision }),
      success: Bundle,
      error: saveErrors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.delete("remove", `${path}/:bundle`, {
      params: bundle,
      payload: Schema.Struct({ revision: BundleRevision }),
      success: Schema.Struct({ id: BundleId }),
      error: saveErrors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.put("settings", "/api/organizations/:organization/connection-settings", {
      params: organization,
      payload: Schema.Struct({ membersCreateConnections: Schema.Boolean }),
      success: Schema.Struct({ membersCreateConnections: Schema.Boolean }),
      error: errors,
    }).annotate(RequiredAction, "manage"),
  )
  .add(
    HttpApiEndpoint.get("members", oversight, {
      params: organization,
      success: Schema.Array(MemberConnections),
      error: errors,
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.post(
      "revokeMemberConnection",
      `${oversight}/:user/connections/:connection/revoke`,
      {
        params: { ...member, connection: ConnectionId },
        success: Schema.Void,
        error: [...errors, ConnectionNotFound],
      },
    )
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .add(
    HttpApiEndpoint.post("revokeMemberAgent", `${oversight}/:user/agents/:agent/revoke`, {
      params: { ...member, agent: GrantId },
      success: Schema.Void,
      error: [...errors, ConnectedAgentNotFound],
    })
      .annotate(RequiredAction, "manage")
      .middleware(RequireUser),
  )
  .middleware(RequireOrganization);
