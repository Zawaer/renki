import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import * as schema from "./schema.js";

export type DB = ReturnType<typeof openDb>;

/**
 * Open (creating if needed) the SQLite database and ensure the schema exists.
 *
 * better-sqlite3 is *synchronous*, which is exactly what we want in a single
 * process: an event append is a plain function call with no await in the middle,
 * so assigning a sequence number and inserting the row can never interleave with
 * another append. That property is what lets the event log stay correct without
 * locks. WAL mode keeps concurrent reads (transcript fetches) from blocking it.
 */
export function openDb(config: Config) {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const sqlite = new Database(config.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  // Bootstrap tables. The DDL is a multi-statement string; exec runs it whole.
  sqlite.exec(schema.DDL);

  // `CREATE TABLE IF NOT EXISTS` above only helps fresh databases — a table
  // that already exists keeps its old columns. Patch new ones in by hand.
  ensureColumn(sqlite, "sessions", "has_pending_permission", "INTEGER NOT NULL DEFAULT 0");

  logger.info("database ready", { path: config.dbPath });
  return db;
}

function ensureColumn(sqlite: Database.Database, table: string, column: string, ddl: string): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
