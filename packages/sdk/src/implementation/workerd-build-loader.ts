import { Effect } from "effect";
import { BlobStore, type BlobStorage } from "../contracts/blobs.ts";
import type { BuildId } from "../contracts/shared.ts";
import { loadWorkerBuild } from "./worker-build-storage.ts";

export const workerdBuildLoader = (blobs: BlobStorage) => (build: BuildId) =>
  loadWorkerBuild(build).pipe(
    Effect.provideService(BlobStore, blobs),
    Effect.map(({ mainModule, modules, protocol }) => ({ mainModule, modules, protocol })),
  );
