/**
 * Where the product object lives. A Durable Object is placed near the first request that reaches
 * it and never moves, so an install that names a location (`EXECUTOR_PRODUCT_LOCATION`, a
 * Cloudflare location hint such as `wnam`) keeps its product in an object of that name created
 * with that hint. The unnamed object `product` then retires: its first successor copies its
 * storage once, after which it serves nothing and keeps its data until
 * `EXECUTOR_PRODUCT_WIPE_PREVIOUS` is `true`.
 *
 * This module imports nothing at run time; the Worker's entry modules load it at startup.
 */

/** The parts of a Durable Object's id this module compares. */
interface DurableObjectId {
  equals(other: DurableObjectId): boolean;
  toString(): string;
}
type SqlRow = Record<string, ArrayBuffer | string | number | null>;
interface SqlCursor<Row extends SqlRow> {
  toArray(): Row[];
  raw<Values extends Array<ArrayBuffer | string | number | null>>(): IterableIterator<Values>;
  readonly columnNames: string[];
}
/** The parts of a SQLite-backed Durable Object's state this module reads and writes. */
export interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: {
    readonly sql: {
      exec<Row extends SqlRow>(query: string, ...bindings: unknown[]): SqlCursor<Row>;
    };
    readonly kv: {
      get(key: string): unknown;
      put(key: string, value: unknown): void;
      delete(key: string): boolean;
      list(): Iterable<[string, unknown]>;
    };
    transactionSync<T>(closure: () => T): T;
  };
}

export interface ProductLocationEnvironment {
  readonly EXECUTOR_PRODUCT_LOCATION?: string;
  readonly EXECUTOR_PRODUCT_WIPE_PREVIOUS?: string;
}

/** A namespace of product objects, as the Worker's binding offers it. */
export interface ProductNamespace<Stub> {
  getByName(name: string, options?: { locationHint?: string }): Stub;
  idFromName(name: string): DurableObjectId;
}

const unplaced = "product";
const locations = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]);

/** The configured location hint; a value Cloudflare does not know is refused at the first use. */
export const productLocation = (env: ProductLocationEnvironment): string | undefined => {
  const hint = env.EXECUTOR_PRODUCT_LOCATION?.trim();
  if (hint === undefined || hint === "") return undefined;
  if (!locations.has(hint)) throw new Error(`EXECUTOR_PRODUCT_LOCATION ${hint} is not a location`);
  return hint;
};

/** The product object every entry point reaches. */
export const productStub = <Stub>(
  namespace: ProductNamespace<Stub>,
  env: ProductLocationEnvironment,
): Stub => {
  const hint = productLocation(env);
  if (hint === undefined) return namespace.getByName(unplaced);
  return namespace.getByName(`${unplaced}-${hint}`, { locationHint: hint });
};

/** The unnamed object, which a placed install's product copies once and then retires. */
export const previousProduct = <Stub>(namespace: ProductNamespace<Stub>): Stub =>
  namespace.getByName(unplaced);

/** Whether this object is the unnamed one while the install names a location. */
export const isRetiredProduct = (
  id: DurableObjectId,
  namespace: ProductNamespace<unknown>,
  env: ProductLocationEnvironment,
): boolean => productLocation(env) !== undefined && id.equals(namespace.idFromName(unplaced));

type SqlValue = ArrayBuffer | string | number | null;

/** One page of a retired object's storage. */
export interface StoragePage {
  /** Schema entries in creation order; only on the first page. */
  readonly schema?: ReadonlyArray<{ readonly type: string; readonly sql: string }>;
  /** Key-value entries; only on the first page. */
  readonly values?: ReadonlyArray<readonly [string, unknown]>;
  readonly table?: string;
  readonly columns?: ReadonlyArray<string>;
  readonly rows?: ReadonlyArray<ReadonlyArray<SqlValue>>;
  /** Where the next page starts; absent on the last page. */
  readonly next?: StorageCursor;
}
export interface StorageCursor {
  readonly table: number;
  readonly offset: number;
}

const pageRows = 200;
/** Roughly how many bytes of row values one page carries; RPC refuses a message over 32 MiB. */
const pageBytes = 4 * 1024 * 1024;
const adoptedKey = "executor:product-adopted-from";

/** Tables, indexes, triggers and views the application created, in creation order. */
const userSchema = (state: DurableObjectState) =>
  state.storage.sql
    .exec<{ type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
    )
    .toArray();

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** One page of this object's storage, for its successor. Nothing writes to a retired object. */
export const exportStoragePage = (
  state: DurableObjectState,
  cursor: StorageCursor | null,
): StoragePage => {
  const schema = userSchema(state);
  const tables = schema.filter((entry) => entry.type === "table").map((entry) => entry.name);
  const first = cursor === null;
  const at = cursor ?? { table: 0, offset: 0 };
  const head = first
    ? {
        schema: schema.map(({ type, sql }) => ({ type, sql })),
        values: [...state.storage.kv.list()],
      }
    : {};
  const table = tables[at.table];
  if (table === undefined) return head;
  const read = state.storage.sql.exec(
    `SELECT * FROM ${quoted(table)} LIMIT ? OFFSET ?`,
    pageRows,
    at.offset,
  );
  const rows: SqlValue[][] = [];
  let bytes = 0;
  for (const row of read.raw<SqlValue[]>()) {
    if (rows.length > 0 && bytes >= pageBytes) break;
    rows.push(row);
    for (const value of row)
      bytes +=
        typeof value === "string"
          ? value.length * 3
          : value instanceof ArrayBuffer
            ? value.byteLength
            : 8;
  }
  const full = rows.length === pageRows || bytes >= pageBytes;
  const next = full
    ? { table: at.table, offset: at.offset + rows.length }
    : at.table + 1 < tables.length
      ? { table: at.table + 1, offset: 0 }
      : undefined;
  return { ...head, table, columns: read.columnNames, rows, ...(next ? { next } : {}) };
};

/** A retired object's operations its successor calls. */
export interface RetiredProduct {
  exportPage(cursor: StorageCursor | null): Promise<StoragePage>;
  wipe(): Promise<void>;
}

/** The error Workers RPC gives for a method the receiving object's release does not have. */
const previousRelease = (error: unknown) =>
  error instanceof Error && error.message.includes('does not implement the method "exportPage"');

/**
 * Copy the retired object's storage into this one, once. The copy is read in pages and written
 * in one transaction, so this object holds either nothing of it or all of it. `false` when the
 * retired object still runs a release that cannot hand its storage over.
 */
export const adoptPreviousStorage = async (
  state: DurableObjectState,
  previous: RetiredProduct,
  previousId: string,
): Promise<boolean> => {
  if (state.storage.kv.get(adoptedKey) !== undefined) return true;
  const pages: StoragePage[] = [];
  let cursor: StorageCursor | null = null;
  do {
    const page: StoragePage | undefined = await previous.exportPage(cursor).catch((error) => {
      if (cursor === null && previousRelease(error)) return undefined;
      throw error;
    });
    if (page === undefined) return false;
    pages.push(page);
    cursor = page.next ?? null;
  } while (cursor !== null);
  const [first] = pages;
  state.storage.transactionSync(() => {
    // Anything here was written before the copy, by nothing that has finished; start clean.
    for (const entry of userSchema(state).reverse())
      if (entry.type !== "table" && entry.type !== "index")
        state.storage.sql.exec(`DROP ${entry.type.toUpperCase()} IF EXISTS ${quoted(entry.name)}`);
    for (const entry of userSchema(state).reverse())
      if (entry.type === "table")
        state.storage.sql.exec(`DROP TABLE IF EXISTS ${quoted(entry.name)}`);
    // Keys are listed before any is deleted; deleting while listing would skip entries.
    const keys = Array.from(state.storage.kv.list(), ([key]) => key);
    for (const key of keys) state.storage.kv.delete(key);
    const schema = first?.schema ?? [];
    // Tables, then the indexes a foreign key's parent column may need, then rows; a row's parent
    // may come later in the copy, so foreign keys are checked when the transaction commits.
    // Triggers and views come last, so no trigger fires for a copied row.
    for (const entry of schema) if (entry.type === "table") state.storage.sql.exec(entry.sql);
    for (const entry of schema) if (entry.type === "index") state.storage.sql.exec(entry.sql);
    state.storage.sql.exec("PRAGMA defer_foreign_keys = ON");
    for (const page of pages) {
      if (page.table === undefined || page.columns === undefined || page.rows === undefined)
        continue;
      const insert = `INSERT INTO ${quoted(page.table)} (${page.columns.map(quoted).join(", ")}) VALUES (${page.columns.map(() => "?").join(", ")})`;
      for (const row of page.rows) state.storage.sql.exec(insert, ...row);
    }
    for (const entry of schema)
      if (entry.type !== "table" && entry.type !== "index") state.storage.sql.exec(entry.sql);
    for (const [key, value] of first?.values ?? []) state.storage.kv.put(key, value);
    state.storage.kv.put(adoptedKey, previousId);
  });
  return true;
};

/**
 * Open the product of an install that names a location: copy the unnamed object's storage once,
 * delete it when the install says so, then open. `undefined` means the unnamed object cannot hand
 * over its storage yet, so it keeps serving.
 */
export const openPlacedProduct = async <Product>(options: {
  readonly state: DurableObjectState;
  readonly env: ProductLocationEnvironment;
  readonly previous: RetiredProduct;
  readonly previousId: string;
  readonly open: () => Promise<Product>;
}): Promise<Product | undefined> => {
  if (!(await adoptPreviousStorage(options.state, options.previous, options.previousId)))
    return undefined;
  if (options.env.EXECUTOR_PRODUCT_WIPE_PREVIOUS === "true") await options.previous.wipe();
  return options.open();
};
