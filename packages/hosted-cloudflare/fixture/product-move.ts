import { DurableObject } from "cloudflare:workers";
import {
  exportStoragePage,
  isRetiredProduct,
  openPlacedProduct,
  productStub,
  type DurableObjectState,
  type RetiredProduct,
  type StorageCursor,
} from "../src/product-location.ts";

interface Served {
  fetch(request: Request): Promise<Response>;
}
interface Seeded {
  seed(bodies: ReadonlyArray<string>): Promise<void>;
}
interface Environment {
  readonly EXECUTOR_PRODUCT_LOCATION: string;
  readonly PREVIOUS_RELEASE: { getByName(name: string): Served & Seeded };
  readonly PRODUCT: {
    getByName(
      name: string,
      options?: { locationHint?: string },
    ): Served &
      Seeded &
      RetiredProduct & {
        refuseWipe(): Promise<void>;
        remaining(): Promise<ReadonlyArray<string>>;
      };
    idFromName(name: string): DurableObjectState["id"];
  };
}

const notes = (state: DurableObjectState) => {
  state.storage.sql.exec("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT)");
  return state.storage.sql
    .exec<{ body: string }>("SELECT body FROM note ORDER BY id")
    .toArray()
    .map(({ body }) => body);
};
const seed = (state: DurableObjectState, bodies: ReadonlyArray<string>) => {
  notes(state);
  const sql = state.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app (id INTEGER PRIMARY KEY, deployment TEXT REFERENCES deployment (id))",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS deployment (id TEXT NOT NULL)");
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS deployment_id ON deployment (id)");
  for (const body of bodies) {
    sql.exec("INSERT INTO note (body) VALUES (?)", body);
    sql.exec("INSERT INTO deployment (id) VALUES (?)", body);
    sql.exec("INSERT INTO app (deployment) VALUES (?)", body);
  }
};

export class PreviousRelease extends DurableObject<Environment> {
  async seed(bodies: ReadonlyArray<string>) {
    seed(this.ctx, bodies);
  }
  async fetch(): Promise<Response> {
    return Response.json({ servedBy: "previous release", notes: notes(this.ctx) });
  }
}

export class Product extends DurableObject<Environment> {
  get #state(): DurableObjectState {
    return this.ctx;
  }
  get #retired() {
    return isRetiredProduct(this.#state.id, this.env.PRODUCT, this.env);
  }
  async seed(bodies: ReadonlyArray<string>) {
    seed(this.#state, bodies);
  }
  async exportPage(cursor: StorageCursor | null) {
    return exportStoragePage(this.#state, cursor);
  }
  async wipe() {
    if (this.ctx.storage.kv.get("refuseWipe") === true) throw new Error("unreachable");
    await this.ctx.storage.deleteAll();
  }
  async refuseWipe() {
    this.ctx.storage.kv.put("refuseWipe", true);
  }
  async remaining() {
    return notes(this.#state);
  }
  async fetch(request: Request): Promise<Response> {
    if (this.#retired) return productStub(this.env.PRODUCT, this.env).fetch(request);
    const release = new URL(request.url).searchParams.get("previous");
    const previous =
      release === "previous"
        ? (this.env.PREVIOUS_RELEASE.getByName("product") as unknown as Served & RetiredProduct)
        : this.env.PRODUCT.getByName("product");
    const state = this.#state;
    const product = await openPlacedProduct({
      state,
      env: this.env,
      previous,
      previousId: "product",
      open: async () => ({
        fetch: async () => Response.json({ servedBy: "placed", notes: notes(state) }),
      }),
    });
    return (product ?? previous).fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const [, route, name = ""] = new URL(request.url).pathname.split("/");
    if (route === "seed" && request.method === "POST") {
      const bodies = (await request.json()) as ReadonlyArray<string>;
      const target =
        name === "previous"
          ? env.PREVIOUS_RELEASE.getByName("product")
          : env.PRODUCT.getByName("product");
      await target.seed(bodies);
      if (new URL(request.url).searchParams.has("refuseWipe"))
        await env.PRODUCT.getByName("product").refuseWipe();
      return new Response(null, { status: 204 });
    }
    if (route === "unnamed")
      return Response.json(await env.PRODUCT.getByName("product").remaining());
    if (route === "placed")
      return env.PRODUCT.getByName(name, { locationHint: "wnam" }).fetch(request);
    return new Response("not found", { status: 404 });
  },
};
