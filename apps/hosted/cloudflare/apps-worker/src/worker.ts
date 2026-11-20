import { WorkerEntrypoint } from "cloudflare:workers";

export {
  default,
  AppDataSupervisor,
  AppOutbound,
  AppWorkflows,
} from "@executor-js/sdk/workerd/host";

export class PublicFetch extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request): Promise<Response> {
    return fetch(request);
  }
}
