/**
 * Serve `fixture/worker.ts` in local workerd through Miniflare, with the bindings the Cloudflare
 * host gives its product: a locally simulated R2 bucket, a SQLite-backed Durable Object, and an
 * Artifacts namespace.
 *
 * Artifacts has no local simulator, so real Git stands in for it: each repository is a bare
 * repository in a temporary directory. Pushes reach `git http-backend` through the Worker's
 * outbound fetch to `<account>.artifacts.cloudflare.net`, and the binding's read methods
 * (`log`, `readCommit`, `readTree`, `readBlob`, `readFile`) are answered with `git` plumbing.
 * Write tokens are checked on every Git request, so an unknown token is refused as Artifacts
 * refuses it.
 *
 * Prints `listening <url>` when ready and runs until stopped.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Miniflare,
  Response as MiniflareResponse,
  type Request as MiniflareRequest,
} from "miniflare";

const here = dirname(fileURLToPath(import.meta.url));
const accountId = "0123456789abcdef0123456789abcdef";
const namespace = "executor-local-apps";
const root = await mkdtemp(join(tmpdir(), "executor-artifacts-"));
const persist = await mkdtemp(join(tmpdir(), "executor-r2-"));
const tokens = new Set<string>();

const run = (
  args: ReadonlyArray<string>,
  options: { input?: Uint8Array; env?: Record<string, string>; cwd?: string } = {},
) =>
  new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }),
    );
    child.stdin.end(options.input === undefined ? undefined : Buffer.from(options.input));
  });

const repositoryName = /^[A-Za-z0-9._-]+$/u;
const directory = (name: string) => {
  if (!repositoryName.test(name)) throw new Error("INVALID_REPO_NAME");
  return join(root, `${name}.git`);
};
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const objectId = /^[a-f0-9]{40}$/u;

/** Commit metadata as the binding decodes it. */
const commits = async (cwd: string, args: ReadonlyArray<string>) => {
  const result = await run(
    [
      "log",
      "--first-parent",
      "--format=%H%x00%T%x00%an%x00%ae%x00%cn%x00%ce%x00%P%x00%at%x00%ct%x00%B%x1e",
      ...args,
    ],
    { cwd },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .toString()
    .split("\x1e")
    .map((record) => record.replace(/^\n/u, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [
        hash,
        treeHash,
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        parents,
        authoredAt,
        committedAt,
        message,
      ] = record.split("\x00");
      return {
        hash,
        treeHash,
        message: (message ?? "").replace(/\n$/u, ""),
        author: { name: authorName, email: authorEmail },
        committer: { name: committerName, email: committerEmail },
        parents: parents === undefined || parents === "" ? [] : parents.split(" "),
        authoredAt: Number(authoredAt),
        committedAt: Number(committedAt),
      };
    });
};

const entryType = (mode: string, type: string) =>
  type === "tree"
    ? "tree"
    : type === "commit"
      ? "gitlink"
      : mode === "100755"
        ? "exec"
        : mode === "120000"
          ? "symlink"
          : "blob";

/** One binding call: `{ repository, input }` in, `{ result }` or `{ error: <ArtifactsErrorCode> }` out. */
/** Every argument any binding method takes; each method reads its own. */
interface BindingInput {
  readonly setDefaultBranch?: string;
  readonly scope?: string;
  readonly ttl?: number;
  readonly ref?: string;
  readonly limit?: number;
  readonly hash?: string;
  readonly path?: string;
}

const binding = async (
  operation: string,
  repository: string,
  input: BindingInput | null,
): Promise<unknown> => {
  const cwd = directory(repository);
  if (operation === "create") {
    if (await exists(cwd)) throw new Error("ALREADY_EXISTS");
    const init = await run([
      "init",
      "--bare",
      "--quiet",
      "-b",
      input?.setDefaultBranch ?? "main",
      cwd,
    ]);
    if (init.code !== 0) throw new Error("INTERNAL_ERROR");
    const token = `art_tok_${randomUUID()}`;
    tokens.add(token);
    return {
      id: repository,
      name: repository,
      remote: `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repository}.git`,
      token,
    };
  }
  if (!(await exists(cwd))) throw new Error("NOT_FOUND");
  const hash = input?.hash ?? "";
  switch (operation) {
    case "get":
      return null;
    case "createToken": {
      const id = randomUUID();
      const plaintext = `art_tok_${randomUUID()}`;
      tokens.add(plaintext);
      return {
        id,
        plaintext,
        scope: input?.scope,
        expiresAt: new Date(Date.now() + Number(input?.ttl) * 1000).toISOString(),
      };
    }
    case "log":
      return commits(cwd, [
        `-n${Math.min(Number(input?.limit ?? 50), 1000)}`,
        String(input?.ref ?? "HEAD"),
        "--",
      ]);
    case "readCommit": {
      if (!objectId.test(hash)) throw new Error("INVALID_INPUT");
      const kind = await run(["cat-file", "-t", hash], { cwd });
      if (kind.code !== 0 || kind.stdout.toString().trim() !== "commit") return null;
      const [commit] = await commits(cwd, ["-n1", "--no-walk", hash, "--"]);
      return commit ?? null;
    }
    case "readTree": {
      if (!objectId.test(hash)) throw new Error("INVALID_INPUT");
      const listed = await run(["ls-tree", "-z", hash], { cwd });
      if (listed.code !== 0) return null;
      return listed.stdout
        .toString()
        .split("\0")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [meta = "", name = ""] = line.split("\t");
          const [mode = "", type = "", hash = ""] = meta.split(" ");
          return {
            name,
            mode: mode === "040000" ? "40000" : mode,
            hash,
            type: entryType(mode, type),
          };
        });
    }
    case "readBlob": {
      if (!objectId.test(hash)) throw new Error("INVALID_INPUT");
      const blob = await run(["cat-file", "blob", hash], { cwd });
      return blob.code === 0 ? blob.stdout.toString("base64") : null;
    }
    case "readFile": {
      const blob = await run(["cat-file", "blob", `${input?.ref ?? ""}:${input?.path ?? ""}`], {
        cwd,
      });
      return blob.code === 0 ? blob.stdout.toString("base64") : null;
    }
    default:
      throw new Error("INVALID_INPUT");
  }
};

/** Git smart HTTP for `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git/...`. */
const gitHttp = async (request: MiniflareRequest) => {
  const url = new URL(request.url);
  const prefix = `/git/${namespace}/`;
  if (url.hostname !== `${accountId}.artifacts.cloudflare.net` || !url.pathname.startsWith(prefix))
    return new MiniflareResponse("not found", { status: 404 });
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!tokens.has(token)) return new MiniflareResponse("unauthorized", { status: 401 });
  const rest = url.pathname.slice(prefix.length);
  const [repository] = rest.split(".git");
  if (
    repository === undefined ||
    !repositoryName.test(repository) ||
    !(await exists(directory(repository)))
  )
    return new MiniflareResponse("not found", { status: 404 });
  const body = new Uint8Array(await request.arrayBuffer());
  const result = await run(["http-backend"], {
    input: body,
    env: {
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${rest}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: "executor",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  const split = result.stdout.indexOf("\r\n\r\n");
  const head = result.stdout.subarray(0, split).toString();
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
    else headers[name] = value;
  }
  return new MiniflareResponse(result.stdout.subarray(split + 4), { status, headers });
};

const bundle = await build({
  entryPoints: [join(here, "../fixture/worker.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:workers", "node:*"],
  write: false,
  logLevel: "error",
});

const miniflare = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0]!.text,
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat"],
  host: "127.0.0.1",
  port: 0,
  r2Buckets: ["BLOBS"],
  r2Persist: persist,
  durableObjects: { PRODUCT: { className: "Product", useSQLite: true } },
  durableObjectsPersist: persist,
  bindings: {
    // A fixed local test key; the real host reads its key from a Worker secret.
    ENCRYPTION_KEY: "11".repeat(32),
    ACCOUNT_ID: accountId,
    NAMESPACE: namespace,
  },
  serviceBindings: {
    ARTIFACTS_HOST: async (request: MiniflareRequest) => {
      const operation = new URL(request.url).pathname.slice(1);
      const { repository, input } = (await request.json()) as {
        repository: string;
        input: BindingInput | null;
      };
      try {
        return MiniflareResponse.json({ result: await binding(operation, repository, input) });
      } catch (error) {
        return MiniflareResponse.json({
          error: error instanceof Error ? error.message : "INTERNAL_ERROR",
        });
      }
    },
  },
  outboundService: gitHttp,
});

const url = await miniflare.ready;
process.stdout.write(`listening ${url.origin}\n`);

const stop = async () => {
  await miniflare.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(persist, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
