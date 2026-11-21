import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { BlobStore, memoryBlobStore, type BlobStorage } from "@executor-js/sdk/blobs";
import { retainWorkerBuild, workerdBuildLoader } from "@executor-js/sdk/workerd";

type BuildId = Parameters<ReturnType<typeof workerdBuildLoader>>[0];

interface Environment {
  readonly PRODUCT: { getByName(name: string): ProductStub };
}

interface ProductStub {
  prepare(build: string): Promise<void>;
  load(build: string): Promise<number>;
  reads(): Promise<number>;
}

const frameworkModule = "x".repeat(512 * 1024);

export class Product extends DurableObject<Environment> {
  readonly #stored = memoryBlobStore();
  #reads = 0;
  readonly #counted: BlobStorage = {
    ...this.#stored,
    get: (key) =>
      Effect.sync(() => {
        this.#reads += 1;
      }).pipe(Effect.andThen(Effect.sleep("30 millis")), Effect.andThen(this.#stored.get(key))),
  };
  readonly #load = workerdBuildLoader(this.#counted);

  async prepare(build: string): Promise<void> {
    await Effect.runPromise(
      retainWorkerBuild(
        build as BuildId,
        {
          mainModule: "app.js",
          modules: { "app.js": "export default {};" },
          database: false,
          protocol: 1,
        },
        { version: "0.0.1-test", modules: { "framework.js": frameworkModule } },
        undefined,
      ).pipe(Effect.provideService(BlobStore, this.#stored)),
    );
  }
  async load(build: string): Promise<number> {
    const loaded = await Effect.runPromise(this.#load(build as BuildId));
    return Object.keys(loaded.modules).length;
  }
  async reads(): Promise<number> {
    return this.#reads;
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const callers = Number(new URL(request.url).searchParams.get("callers") ?? "1");
    const build = `bld_${crypto.randomUUID()}`;
    const product = env.PRODUCT.getByName(build);
    await product.prepare(build);
    const loaded = await Promise.all(
      Array.from({ length: callers }, () => env.PRODUCT.getByName(build).load(build)),
    );
    return Response.json({ loaded, reads: await product.reads() });
  },
};
