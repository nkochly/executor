/**
 * Development only: the native services the product Worker binds (configuration, Git, the build
 * disk, dashboard files and the telemetry collector), served on 127.0.0.1 so `wrangler dev` can
 * run the product and this app host together. It mirrors self-host's native helper and workerd
 * disk services. The Cloudflare host shell replaces each of these with Worker vars, R2,
 * Artifacts and static assets.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";

const port = Number(process.env.EXECUTOR_DEV_HOST_PORT ?? 4499);
const data = path.resolve(process.env.EXECUTOR_DEV_DATA ?? ".dev-data");
const web = path.resolve(import.meta.dirname, "../../../self-host/web/dist/client");
const repositories = path.join(data, "repositories");
const builds = path.join(data, "builds");
const temporary = await mkdtemp(path.join(os.tmpdir(), "executor-dev-"));
await mkdir(repositories, { recursive: true });
await mkdir(builds, { recursive: true });

const configuration = {
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  BETTER_AUTH_SECRET: "dev-only-auth-secret-000000000000000000000000",
  EXECUTOR_ENCRYPTION_KEY: "0".repeat(64),
  EXECUTOR_INSTALL_ID: "00000000-0000-4000-8000-000000000000",
  EXECUTOR_ANALYTICS_SECRET: "0".repeat(64),
  EXECUTOR_DATABASE: "sqlite",
  EXECUTOR_REPOSITORIES_DIR: repositories,
  EXECUTOR_HOST_OS: process.platform,
  EXECUTOR_HOST_ARCH: process.arch,
  DO_NOT_TRACK: "1",
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(EXECUTOR_|BETTER_AUTH_|OTEL_)/.test(name)),
  ),
};

const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const allowed = (name) =>
  name.startsWith("GIT_") ||
  name.startsWith("CONTENT_") ||
  name.startsWith("REQUEST_") ||
  ["PATH_INFO", "QUERY_STRING", "REMOTE_USER", "SERVER_PROTOCOL", "HTTP_CONTENT_ENCODING"].includes(
    name,
  );
const gitEnvironment = (extra) => {
  if (!Object.keys(extra).every(allowed)) return undefined;
  return {
    PATH: process.env.PATH,
    HOME: temporary,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
};
const indexes = new Map();

const native = async (request, response, route) => {
  if (route === "/configuration" && request.method === "GET") return json(response, configuration);
  if (request.method !== "POST") return json(response, null, 404);
  if (route === "/git") {
    const input = JSON.parse((await body(request)).toString());
    const env = gitEnvironment(input.environment ?? {});
    if (env === undefined) return json(response, null, 400);
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...input.args], { env });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.resume();
    child.stdin.end(Buffer.from(input.input ?? "", "base64"));
    const code = await new Promise((resolve) => child.on("close", resolve));
    return json(response, { code, output: Buffer.concat(output).toString("base64") });
  }
  if (route === "/git/http-backend") {
    const env = gitEnvironment(JSON.parse(request.headers["executor-git-environment"] ?? "{}"));
    if (env === undefined) return json(response, null, 400);
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "http-backend"], { env });
    child.stderr.resume();
    request.pipe(child.stdin);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    child.stdout.pipe(response);
    return;
  }
  if (route === "/git/directory") {
    const input = JSON.parse((await body(request)).toString());
    if (
      path.dirname(input.path) !== repositories ||
      !/^[a-zA-Z0-9_-]+\.git$/.test(path.basename(input.path))
    )
      return json(response, null, 400);
    await mkdir(input.path, { recursive: true });
    return json(response, {});
  }
  if (route === "/git/index") {
    await body(request);
    const directory = await mkdtemp(path.join(temporary, "index-"));
    const index = path.join(directory, "index");
    indexes.set(index, directory);
    return json(response, { index });
  }
  if (route === "/git/index/remove") {
    const input = JSON.parse((await body(request)).toString());
    const directory = indexes.get(input.index);
    if (directory === undefined) return json(response, null, 400);
    indexes.delete(input.index);
    await rm(directory, { recursive: true, force: true });
    return json(response, {});
  }
  return json(response, null, 404);
};

/** workerd's writable disk service: whole files, atomic PUT, directory GET lists entries. */
const disk = async (root, request, response, route) => {
  const file = path.join(root, ...route.split("/").filter(Boolean).map(decodeURIComponent));
  if (!file.startsWith(root)) return json(response, null, 400);
  const info = await stat(file).catch(() => undefined);
  if (request.method === "PUT") {
    await mkdir(path.dirname(file), { recursive: true });
    const pending = `${file}.${process.pid}.tmp`;
    await writeFile(pending, await body(request));
    await rename(pending, file);
    response.writeHead(204).end();
    return;
  }
  if (request.method === "DELETE") {
    if (info === undefined) return json(response, null, 404);
    await rm(file, { recursive: true, force: true });
    response.writeHead(204).end();
    return;
  }
  if (info === undefined) return json(response, null, 404);
  if (info.isDirectory()) {
    const entries = await readdir(file, { withFileTypes: true });
    return json(
      response,
      entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      })),
    );
  }
  response.writeHead(200, { "content-length": info.size });
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://host.internal");
    const [, service, ...rest] = url.pathname.split("/");
    const route = `/${rest.join("/")}`;
    if (service === "native") return await native(request, response, route);
    if (service === "blobs") return await disk(builds, request, response, route);
    if (service === "dashboard") return await disk(web, request, response, route);
    if (service === "motel") {
      await body(request);
      return json(response, {});
    }
    json(response, null, 404);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, null, 503);
    else response.destroy();
  }
}).listen(port, "127.0.0.1", () => console.log(`dev host services on 127.0.0.1:${port}`));
