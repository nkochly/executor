/**
 * Backups of the product object: a copy of everything it stores in an R2 bucket, written by the
 * object itself, and the restore of one into an object that stores nothing yet.
 *
 * Cloudflare offers no export of a Durable Object's storage (its point-in-time recovery stays
 * inside the object), so a backup is read with `exportStoragePage` and restored with
 * `replaceStorage`: the same pages, in the same order, as the product's move to a location.
 *
 * Layout in the bucket, for a backup key `<key>`:
 *   <key>/<stamp>/page-00000.json ... one page each
 *   <key>/<stamp>/manifest.json       written last: a stamp without one is incomplete
 * `<stamp>` is the backup's ISO time, so stamps sort by time. The newest complete backup of a key
 * is always kept; older ones go after `keepDays`, and incomplete ones after a day.
 *
 * Values JSON cannot carry are tagged: bytes as `{"$":"bytes","v":<base64>}` (`"u8":true` for a
 * Uint8Array), a Date as `{"$":"date","v":<iso>}`, a non-finite number as `{"$":"number","v":"NaN"}`,
 * and a stored object that has a `$` key of its own as `{"$":"object","v":{...}}`. A stored value of
 * any other kind fails the backup and names its key rather than be copied wrong.
 *
 * This module imports nothing at run time; the Worker's entry modules load it at startup.
 */
import {
  exportStoragePage,
  replaceStorage,
  type DurableObjectState,
  type StorageCursor,
  type StoragePage,
} from "./product-location.ts";

/** What a complete backup holds, as its manifest says. */
export interface BackupManifest {
  readonly format: 1;
  readonly key: string;
  readonly stamp: string;
  readonly pages: number;
  /** Rows per table that has any. */
  readonly tables: Readonly<Record<string, number>>;
  /** How many stored values. */
  readonly values: number;
}

/** The part of an R2 bucket a backup uses. */
export interface BackupBucket {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { prefix: string; delimiter?: string; cursor?: string }): Promise<{
    readonly objects: ReadonlyArray<{ readonly key: string }>;
    readonly delimitedPrefixes: ReadonlyArray<string>;
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

/** A backup or restore that cannot be done; the message says why. */
export class BackupError extends Error {
  override readonly name = "BackupError";
}

const format = 1;
const manifestName = "manifest.json";
const day = 24 * 60 * 60 * 1000;
const keyShape = /^[A-Za-z0-9._:-]{1,200}$/;
/**
 * The largest database a backup copies. A backup holds the whole object in memory while it writes,
 * and an isolate has 128 MB; a larger object fails with a BackupError that says so instead.
 */
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** Every page of the object's storage, read without yielding, so the copy is one moment of it. */
export const readStorage = (state: DurableObjectState): StoragePage[] => {
  const pages: StoragePage[] = [];
  let cursor: StorageCursor | null = null;
  do {
    const page: StoragePage = exportStoragePage(state, cursor);
    pages.push(page);
    cursor = page.next ?? null;
  } while (cursor !== null);
  return pages;
};

/** Whether the object stores nothing at all: no table of its own and no value. */
export const storesNothing = (state: DurableObjectState): boolean => {
  const first = exportStoragePage(state, null);
  return (first?.schema?.length ?? 0) === 0 && (first?.values?.length ?? 0) === 0;
};

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const kindOf = (value: unknown) =>
  value === null || value === undefined
    ? String(value)
    : typeof value === "object"
      ? (value.constructor?.name ?? "object")
      : typeof value;

/** A value as JSON can carry it; `where` names it when it cannot. */
export const encodeValue = (value: unknown, where: string): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : { $: "number", v: String(value) };
  if (value instanceof ArrayBuffer) return { $: "bytes", v: toBase64(new Uint8Array(value)) };
  if (value instanceof Uint8Array) return { $: "bytes", v: toBase64(value), u8: true };
  if (value instanceof Date) return { $: "date", v: value.toISOString() };
  if (Array.isArray(value)) return value.map((item, i) => encodeValue(item, `${where}[${i}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = encodeValue(v, `${where}.${k}`);
    }
    return "$" in out ? { $: "object", v: out } : out;
  }
  throw new BackupError(
    `The stored value ${where} is a ${kindOf(value)}, which a backup cannot carry.`,
  );
};

/** The value `encodeValue` was given. */
export const decodeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;
  const tagged = value as { $?: unknown; v?: unknown; u8?: unknown };
  if (tagged.$ === "bytes") {
    const bytes = fromBase64(String(tagged.v));
    return tagged.u8 === true ? bytes : bytes.buffer;
  }
  if (tagged.$ === "date") return new Date(String(tagged.v));
  if (tagged.$ === "number") return Number(tagged.v);
  if (tagged.$ === "object") return decodeObject(tagged.v as Record<string, unknown>);
  return decodeObject(value as Record<string, unknown>);
};
const decodeObject = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v)]));

const encodePage = ({ next: _next, ...page }: StoragePage): string =>
  JSON.stringify({
    ...page,
    ...(page.values ? { values: page.values.map(([k, v]) => [k, encodeValue(v, k)]) } : {}),
    ...(page.rows
      ? {
          rows: page.rows.map((row) =>
            row.map((v) => (v instanceof ArrayBuffer ? encodeValue(v, page.table ?? "") : v)),
          ),
        }
      : {}),
  });

const decodePage = (text: string): StoragePage => {
  const page = JSON.parse(text) as StoragePage;
  return {
    ...page,
    ...(page.values ? { values: page.values.map(([k, v]) => [k, decodeValue(v)] as const) } : {}),
    ...(page.rows
      ? {
          rows: page.rows.map((row) =>
            row.map((v) =>
              v !== null && typeof v === "object" ? (decodeValue(v) as ArrayBuffer) : v,
            ),
          ),
        }
      : {}),
  };
};

const checkKey = (key: string) => {
  if (!keyShape.test(key))
    throw new BackupError(`"${key}" is not a backup key: letters, digits and . _ : - only.`);
};

const pageName = (key: string, stamp: string, n: number) =>
  `${key}/${stamp}/page-${String(n).padStart(5, "0")}.json`;

const stampsOf = async (bucket: BackupBucket, key: string): Promise<string[]> => {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix: `${key}/`,
      delimiter: "/",
      ...(cursor ? { cursor } : {}),
    });
    for (const prefix of listed.delimitedPrefixes) found.push(prefix.slice(key.length + 1, -1));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return found.sort();
};

const objectsUnder = async (bucket: BackupBucket, prefix: string): Promise<string[]> => {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of listed.objects) found.push(object.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return found;
};

const deleteAll = async (bucket: BackupBucket, keys: ReadonlyArray<string>) => {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
};

const manifestOf = async (
  bucket: BackupBucket,
  key: string,
  stamp: string,
): Promise<BackupManifest | null> => {
  const object = await bucket.get(`${key}/${stamp}/${manifestName}`);
  return object ? (JSON.parse(await object.text()) as BackupManifest) : null;
};

/**
 * Write a backup of the object's storage under `key`, then delete this key's complete backups
 * older than `keepDays` (never the newest) and incomplete ones older than a day.
 */
export const writeBackup = async (
  bucket: BackupBucket,
  key: string,
  state: DurableObjectState,
  options: { readonly now?: number; readonly keepDays?: number; readonly maxBytes?: number } = {},
): Promise<BackupManifest> => {
  checkKey(key);
  const now = options.now ?? Date.now();
  const stamp = new Date(now).toISOString();
  const maxBytes = options.maxBytes ?? MAX_BACKUP_BYTES;
  const size = (state.storage.sql as { readonly databaseSize?: number }).databaseSize ?? 0;
  if (size > maxBytes)
    throw new BackupError(
      `${key} holds ${mib(size)} MiB; a backup copies at most ${mib(maxBytes)} MiB, so none was written.`,
    );
  // Each page is encoded as soon as it is read, so the raw rows are never all held at once.
  const encoded: string[] = [];
  const tables: Record<string, number> = {};
  let values = 0;
  let cursor: StorageCursor | null = null;
  do {
    const page: StoragePage = exportStoragePage(state, cursor);
    if (page.values) values = page.values.length;
    if (page.table !== undefined)
      tables[page.table] = (tables[page.table] ?? 0) + (page.rows?.length ?? 0);
    encoded.push(encodePage(page));
    cursor = page.next ?? null;
  } while (cursor !== null);
  for (let n = 0; n < encoded.length; n++) {
    await bucket.put(pageName(key, stamp, n), encoded[n]!);
    encoded[n] = "";
  }
  const manifest: BackupManifest = { format, key, stamp, pages: encoded.length, tables, values };
  await bucket.put(`${key}/${stamp}/${manifestName}`, JSON.stringify(manifest));
  const cutoff = new Date(now - (options.keepDays ?? 30) * day).toISOString();
  const incompleteCutoff = new Date(now - day).toISOString();
  for (const older of await stampsOf(bucket, key)) {
    if (older === stamp) continue;
    const complete = (await manifestOf(bucket, key, older)) !== null;
    if ((complete && older < cutoff) || (!complete && older < incompleteCutoff))
      await deleteAll(bucket, await objectsUnder(bucket, `${key}/${older}/`));
  }
  return manifest;
};

/** The complete backups of a key, newest first. */
export const listBackups = async (bucket: BackupBucket, key: string): Promise<BackupManifest[]> => {
  checkKey(key);
  const out: BackupManifest[] = [];
  for (const stamp of (await stampsOf(bucket, key)).reverse()) {
    const manifest = await manifestOf(bucket, key, stamp);
    if (manifest) out.push(manifest);
  }
  return out;
};

/** The pages of one complete backup: the newest, or the one at `stamp`. */
export const readBackup = async (
  bucket: BackupBucket,
  key: string,
  stamp?: string,
): Promise<{ manifest: BackupManifest; pages: StoragePage[] }> => {
  checkKey(key);
  const chosen = stamp ?? (await listBackups(bucket, key))[0]?.stamp;
  const manifest = chosen === undefined ? null : await manifestOf(bucket, key, chosen);
  if (!manifest)
    throw new BackupError(
      stamp ? `No complete backup of ${key} at ${stamp}.` : `${key} has no backup.`,
    );
  if (manifest.format !== format)
    throw new BackupError(
      `The backup of ${key} at ${manifest.stamp} has format ${manifest.format}; this code reads ${format}.`,
    );
  const pages: StoragePage[] = [];
  for (let n = 0; n < manifest.pages; n++) {
    const object = await bucket.get(pageName(key, manifest.stamp, n));
    if (!object)
      throw new BackupError(`The backup of ${key} at ${manifest.stamp} is missing page ${n}.`);
    pages.push(decodePage(await object.text()));
  }
  return { manifest, pages };
};

/**
 * Write a backup's pages into this object in one transaction, only if it stores nothing yet: a
 * restore never writes over an object in use.
 */
export const restoreInto = (state: DurableObjectState, pages: ReadonlyArray<StoragePage>) => {
  state.storage.transactionSync(() => {
    if (!storesNothing(state))
      throw new BackupError(
        "A restore writes only into an object that stores nothing; this one stores data.",
      );
    replaceStorage(state, pages);
  });
};

/** A restore test: what the backup's manifest says, and what the restored copy holds. */
export interface RestoreTest {
  readonly key: string;
  readonly stamp: string;
  readonly tables: Readonly<Record<string, { backup: number; restored: number }>>;
  readonly values: { backup: number; restored: number };
  readonly ok: boolean;
}

/**
 * Restore a backup into this scratch object, count what it holds against the manifest, and
 * report. The caller deletes the scratch object's storage afterwards.
 */
export const testRestore = async (
  state: DurableObjectState,
  bucket: BackupBucket,
  key: string,
  stamp?: string,
): Promise<RestoreTest> => {
  const { manifest, pages } = await readBackup(bucket, key, stamp);
  state.storage.transactionSync(() => replaceStorage(state, pages));
  const tables: Record<string, { backup: number; restored: number }> = {};
  for (const [table, rows] of Object.entries(manifest.tables)) {
    const [count] = state.storage.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`)
      .toArray();
    tables[table] = { backup: rows, restored: count?.n ?? 0 };
  }
  const restoredValues = Array.from(state.storage.kv.list()).length;
  return {
    key,
    stamp: manifest.stamp,
    tables,
    values: { backup: manifest.values, restored: restoredValues },
    ok:
      Object.values(tables).every((t) => t.backup === t.restored) &&
      restoredValues === manifest.values,
  };
};
