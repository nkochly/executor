/**
 * Development only: the product's native bindings as Worker entrypoints that forward to
 * `host.mjs` on 127.0.0.1, and its two egress networks as global `fetch`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

const origin = "http://127.0.0.1:4499";
const forward = (service: string, request: Request) => {
  const url = new URL(request.url);
  return fetch(new Request(`${origin}/${service}${url.pathname}${url.search}`, request));
};

export class Native extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request) {
    return forward("native", request);
  }
}
export class Blobs extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request) {
    return forward("blobs", request);
  }
}
export class Dashboard extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request) {
    return forward("dashboard", request);
  }
}
export class Motel extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request) {
    return forward("motel", request);
  }
}
export class Network extends WorkerEntrypoint<Record<string, never>> {
  fetch(request: Request) {
    return fetch(request);
  }
}
export default {
  fetch: () => new Response(null, { status: 404 }),
};
