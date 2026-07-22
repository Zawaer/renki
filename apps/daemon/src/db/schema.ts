import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema. Two tables:
 *
 *  sessions — one row per session (the current, mutable snapshot: status,
 *             controller, resumable claudeSessionId, etc.).
 *
 *  events   — the append-only, per-session event log. This is the source of
 *             truth for the conversation; the sessions row is just a convenient
 *             materialized view of "where things stand right now".
 *
 * Events are keyed by (session_id, seq) so replaying "everything after seq N"
 * for one session is a single indexed range scan.
 */

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  repoId: text("repo_id").notNull(),
  repoName: text("repo_name").notNull(),
  baseBranch: text("base_branch").notNull(),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  status: text("status").notNull(),
  hasPendingPermission: integer("has_pending_permission", { mode: "boolean" }).notNull().default(false),
  controller: text("controller"),
  claudeSessionId: text("claude_session_id"),
  title: text("title"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
});

export const pushTokens = sqliteTable("push_tokens", {
  deviceId: text("device_id").primaryKey(),
  expoToken: text("expo_token").notNull(),
  platform: text("platform"),
  updatedAt: integer("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull(),
    kind: text("kind").notNull(),
    /** JSON-encoded EventPayload (includes its own `kind` discriminator). */
    data: text("data").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.seq] }),
  }),
);

/** Hand-written DDL run at startup so the daemon bootstraps its own storage. */
export const DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL,
    has_pending_permission INTEGER NOT NULL DEFAULT 0,
    controller TEXT,
    claude_session_id TEXT,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS push_tokens (
    device_id TEXT PRIMARY KEY,
    expo_token TEXT NOT NULL,
    platform TEXT,
    updated_at INTEGER NOT NULL
  );
` as const;
