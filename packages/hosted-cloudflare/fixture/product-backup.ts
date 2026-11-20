import { DurableObject } from "cloudflare:workers";
import {
  listBackups,
  readBackup,
  restoreInto,
  storesNothing,
  testRestore,
  writeBackup,
  type BackupBucket,
} from "../src/backup.ts";
import type { DurableObjectState } from "../src/product-location.ts";

interface Environment {
  readonly BACKUPS: BackupBucket;
  readonly PRODUCT: { getByName(name: string): Product };
}

const seed = (state: DurableObjectState, bodies: ReadonlyArray<string>) => {
  const sql = state.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS app (id INTEGER PRIMARY KEY, deployment TEXT REFERENCES deployment (id), icon BLOB)",
  );
  sql.exec("CREATE TABLE IF NOT EXISTS deployment (id TEXT NOT NULL)");
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS deployment_id ON deployment (id)");
  sql.exec("CREATE TABLE IF NOT EXISTS audit (deployment TEXT)");
  sql.exec(
    "CREATE TRIGGER IF NOT EXISTS app_audit AFTER INSERT ON app BEGIN INSERT INTO audit VALUES (NEW.deployment); END",
  );
  for (const body of bodies) {
    sql.exec("INSERT INTO deployment (id) VALUES (?)", body);
    sql.exec(
      "INSERT INTO app (deployment, icon) VALUES (?, ?)",
      body,
      new TextEncoder().encode(body).buffer,
    );
  }
  state.storage.kv.put("settings", { bodies: bodies.length, at: new Date(0), $: "own" });
  state.storage.kv.put("sealed", new Uint8Array([1, 2, 3]));
};

const contents = (state: DurableObjectState) => ({
  apps: state.storage.sql
    .exec<{ deployment: string; icon: string }>(
      "SELECT deployment, hex(icon) AS icon FROM app ORDER BY id",
    )
    .toArray(),
  audit: state.storage.sql
    .exec<{ deployment: string }>("SELECT deployment FROM audit ORDER BY rowid")
    .toArray()
    .map((r) => r.deployment),
  settings: state.storage.kv.get("settings"),
  sealed: Array.from(state.storage.kv.get("sealed") as Uint8Array),
});

export class Product extends DurableObject<Environment> {
  async seed(bodies: ReadonlyArray<string>) {
    seed(this.ctx, bodies);
  }
  async backUp(key: string) {
    return writeBackup(this.env.BACKUPS, key, this.ctx);
  }
  async restore(key: string) {
    const { pages } = await readBackup(this.env.BACKUPS, key);
    restoreInto(this.ctx, pages);
    return contents(this.ctx);
  }
  async test(key: string) {
    try {
      return await testRestore(this.ctx, this.env.BACKUPS, key);
    } finally {
      await this.ctx.storage.deleteAll();
    }
  }
  async contents() {
    return contents(this.ctx);
  }
  async storesNothing() {
    return storesNothing(this.ctx);
  }
}

const json = (value: unknown) => Response.json(value);

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const [, route, name = ""] = url.pathname.split("/");
    const object = env.PRODUCT.getByName(name);
    const from = url.searchParams.get("from") ?? "";
    try {
      if (route === "seed") {
        await object.seed((await request.json()) as string[]);
        return json({ seeded: true });
      }
      if (route === "backup") return json(await object.backUp(name));
      if (route === "restore") return json(await object.restore(from));
      if (route === "test") return json(await object.test(from));
      if (route === "contents") return json(await object.contents());
      if (route === "empty") return json(await object.storesNothing());
      if (route === "backups") return json(await listBackups(env.BACKUPS, name));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) });
    }
    return new Response("not found", { status: 404 });
  },
};
