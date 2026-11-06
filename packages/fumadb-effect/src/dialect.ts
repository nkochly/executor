/** SQL expressions that differ between PostgreSQL and SQLite. */
export {
  isSqlite,
  isoText,
  json,
  jsonColumns,
  SqlJson,
  advisoryLock,
  authNow,
  authMillis,
  SqlBoolean,
  SqlDate,
  now,
  nowPlusSeconds,
  sqliteNow,
  sqliteUuid,
  uuid,
} from "./implementation/dialect.ts";
