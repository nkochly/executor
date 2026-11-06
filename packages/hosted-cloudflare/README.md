# @executor-js/hosted-cloudflare

Storage for the self-host product when it runs on Cloudflare instead of the workerd image with
its native helper. The product Durable Object passes in the bindings it was given.

| Export                                             | Replaces                                            | Binding             |
| -------------------------------------------------- | --------------------------------------------------- | ------------------- |
| `r2BlobStore(env.BLOBS)` from `./blobs`            | `bindingBlobStore(env.BLOBS)` (disk service)        | R2 bucket           |
| `artifactsRepositories({...})` from `./app-source` | `bindingRepositories(env.NATIVE, dir)` (native Git) | Artifacts namespace |

```ts
const storage = Effect.gen(function* () {
  const blobs = r2BlobStore(env.BLOBS);
  const repositories = yield* artifactsRepositories({
    artifacts: env.ARTIFACTS,
    storage: ctx.storage, // the product Durable Object's storage
    encryptionKey: Redacted.make(env.EXECUTOR_ENCRYPTION_KEY), // 64 hex characters
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    namespace: "executor-apps", // the Artifacts namespace the binding names
  });
  return { blobs, repositories };
});
```

`artifactsRepositories` is the Cloud build's Git adapter (`@executor-js/app-source/cloudflare`):
pushes go over Git smart HTTP to `<account>.artifacts.cloudflare.net`, and reads go through the
binding. The Cloud build keeps write tokens in a separate coordinator Durable Object; here the
product is already one Durable Object, so tokens are stored in its storage, sealed with the
encryption key, and one lock serializes their refresh.

## Checks

`bun run e2e:cloudflare-storage` runs `fixture/worker.ts` in local workerd through
`scripts/storage-host.ts` and drives it over HTTP. R2 is Miniflare's local simulation.
Artifacts has no local simulator, so the host answers the binding from real Git repositories
and takes pushes through `git http-backend`. Pushing to a real Artifacts namespace needs a
Cloudflare account and is not covered here.
