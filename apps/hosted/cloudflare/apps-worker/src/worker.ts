/**
 * The app host on Cloudflare: the shared workerd host, unchanged, on stock Workers. App isolates
 * run in Dynamic Workers (`LOADER`), app data in Durable Object facets (`DATA`), and workflow
 * runs on Cloudflare Workflows (`RUNS`). Only the product reaches it, through a service binding.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export {
  default,
  AppDataSupervisor,
  AppOutbound,
  AppWorkflows,
} from "@executor-js/sdk/workerd/host";

/**
 * The public network for app egress. Cloudflare's global `fetch` reaches only the public
 * internet, so it is what workerd's public-only network service is in self-host. Private
 * destinations are also refused by name before they get here unless the operator allows them.
 */
export class PublicFetch extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}
