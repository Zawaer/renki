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
  ensureColumn(sqlite, "sessions", "purpose", "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(sqlite, "sessions", "merge_meta", "TEXT");
  ensureColumn(sqlite, "sessions", "title_source", "TEXT");
  ensureColumn(sqlite, "sessions", "title_gen_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureSessionsRepoColumnsNullable(sqlite);

  logger.info("database ready", { path: config.dbPath });
  return db;
}

function ensureColumn(sqlite: Database.Database, table: string, column: string, ddl: string): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * `repo_id`/`base_branch`/`branch` used to be NOT NULL (every session was tied
 * to a repo). Repo-less "just chat" sessions need them nullable, but SQLite
 * can't drop a NOT NULL constraint with ALTER TABLE — the whole table has to
 * be rebuilt. Only runs once per database: fresh ones already get the
 * nullable columns straight from `DDL` above.
 */
function ensureSessionsRepoColumnsNullable(sqlite: Database.Database): void {
  const cols = sqlite.prepare(`PRAGMA table_info(sessions)`).all() as { name: string; notnull: number }[];
  const repoId = cols.find((c) => c.name === "repo_id");
  if (!repoId || repoId.notnull === 0) return;

  logger.info("migrating sessions table to allow repo-less sessions");
  sqlite.exec(`
    CREATE TABLE sessions_new (
      id TEXT PRIMARY KEY,
      repo_id TEXT,
      repo_name TEXT NOT NULL,
      base_branch TEXT,
      branch TEXT,
      worktree_path TEXT NOT NULL,
      status TEXT NOT NULL,
      has_pending_permission INTEGER NOT NULL DEFAULT 0,
      controller TEXT,
      claude_session_id TEXT,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'normal',
      merge_meta TEXT
    );
    INSERT INTO sessions_new SELECT
      id, repo_id, repo_name, base_branch, branch, worktree_path, status,
      has_pending_permission, controller, claude_session_id, title,
      created_at, updated_at, last_activity_at, purpose, merge_meta
    FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_new RENAME TO sessions;
  `);
}
