/**
 * The product composition another Worker host reuses: database schema, Executor services, the
 * route map and the bindings that turn a host's services into them. Nothing here imports a
 * database engine, so a host chooses its own.
 */
export { sqliteDatabaseSchema } from "./implementation/database-schema.ts";
export {
  selfHostExecutorServices,
  SelfHostWorkflowRequests,
  type SelfHostPlatform,
} from "./implementation/executor-services.ts";
export { selfHostRouteMap } from "./implementation/routes.ts";
export {
  bindingDashboard,
  bindingHttpClient,
  type HttpBinding,
} from "./implementation/workerd/bindings.ts";
