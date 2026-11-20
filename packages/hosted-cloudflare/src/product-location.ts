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

export interface ProductNamespace<Stub> {
  getByName(name: string, options?: { locationHint?: string }): Stub;
  idFromName(name: string): DurableObjectId;
}

const unplaced = "product";
const locations = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]);

export const productLocation = (env: ProductLocationEnvironment): string | undefined => {
  const hint = env.EXECUTOR_PRODUCT_LOCATION?.trim();
  if (hint === undefined || hint === "") return undefined;
  if (!locations.has(hint)) throw new Error(`EXECUTOR_PRODUCT_LOCATION ${hint} is not a location`);
  return hint;
};

export const productName = (env: ProductLocationEnvironment): string => {
  const hint = productLocation(env);
  return hint === undefined ? unplaced : `${unplaced}-${hint}`;
};

export const productStub = <Stub>(
  namespace: ProductNamespace<Stub>,
  env: ProductLocationEnvironment,
): Stub => {
  const hint = productLocation(env);
  if (hint === undefined) return namespace.getByName(unplaced);
  return namespace.getByName(productName(env), { locationHint: hint });
};

export const previousProduct = <Stub>(namespace: ProductNamespace<Stub>): Stub =>
  namespace.getByName(unplaced);

export const isRetiredProduct = (
  id: DurableObjectId,
  namespace: ProductNamespace<unknown>,
  env: ProductLocationEnvironment,
): boolean => productLocation(env) !== undefined && id.equals(namespace.idFromName(unplaced));

type SqlValue = ArrayBuffer | string | number | null;

export interface StoragePage {
  readonly schema?: ReadonlyArray<{ readonly type: string; readonly sql: string }>;
  readonly values?: ReadonlyArray<readonly [string, unknown]>;
  readonly table?: string;
  readonly columns?: ReadonlyArray<string>;
  readonly rows?: ReadonlyArray<ReadonlyArray<SqlValue>>;
  readonly next?: StorageCursor;
}
export interface StorageCursor {
  readonly table: number;
  readonly offset: number;
}

const pageRows = 200;
const pageBytes = 4 * 1024 * 1024;
const adoptedKey = "executor:product-adopted-from";
const wipedKey = "executor:product-previous-wiped";

const userSchema = (state: DurableObjectState) =>
  state.storage.sql
    .exec<{ type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
    )
    .toArray();

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

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

export interface RetiredProduct {
  exportPage(cursor: StorageCursor | null): Promise<StoragePage>;
  wipe(): Promise<void>;
}

const previousRelease = (error: unknown) =>
  error instanceof Error && error.message.includes('does not implement the method "exportPage"');

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
  state.storage.transactionSync(() => {
    replaceStorage(state, pages);
    state.storage.kv.put(adoptedKey, previousId);
  });
  return true;
};

export const replaceStorage = (state: DurableObjectState, pages: ReadonlyArray<StoragePage>) => {
  const [first] = pages;
  for (const entry of userSchema(state).reverse())
    if (entry.type !== "table" && entry.type !== "index")
      state.storage.sql.exec(`DROP ${entry.type.toUpperCase()} IF EXISTS ${quoted(entry.name)}`);
  for (const entry of userSchema(state).reverse())
    if (entry.type === "table")
      state.storage.sql.exec(`DROP TABLE IF EXISTS ${quoted(entry.name)}`);
  const keys = Array.from(state.storage.kv.list(), ([key]) => key);
  for (const key of keys) state.storage.kv.delete(key);
  const schema = first?.schema ?? [];
  for (const entry of schema) if (entry.type === "table") state.storage.sql.exec(entry.sql);
  for (const entry of schema) if (entry.type === "index") state.storage.sql.exec(entry.sql);
  state.storage.sql.exec("PRAGMA defer_foreign_keys = ON");
  for (const page of pages) {
    if (page.table === undefined || page.columns === undefined || page.rows === undefined) continue;
    const insert = `INSERT INTO ${quoted(page.table)} (${page.columns.map(quoted).join(", ")}) VALUES (${page.columns.map(() => "?").join(", ")})`;
    for (const row of page.rows) state.storage.sql.exec(insert, ...row);
  }
  for (const entry of schema)
    if (entry.type !== "table" && entry.type !== "index") state.storage.sql.exec(entry.sql);
  for (const [key, value] of first?.values ?? []) state.storage.kv.put(key, value);
};

export const openPlacedProduct = async <Product>(options: {
  readonly state: DurableObjectState;
  readonly env: ProductLocationEnvironment;
  readonly previous: RetiredProduct;
  readonly previousId: string;
  readonly open: () => Promise<Product>;
}): Promise<Product | undefined> => {
  if (!(await adoptPreviousStorage(options.state, options.previous, options.previousId)))
    return undefined;
  if (
    options.env.EXECUTOR_PRODUCT_WIPE_PREVIOUS === "true" &&
    options.state.storage.kv.get(wipedKey) === undefined
  ) {
    await options.previous.wipe().then(
      () => options.state.storage.kv.put(wipedKey, options.previousId),
      (error: unknown) => console.error("could not delete the previous product's storage", error),
    );
  }
  return options.open();
};
