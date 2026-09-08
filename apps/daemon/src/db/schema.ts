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
  repoId: text("repo_id"),
  repoName: text("repo_name").notNull(),
  baseBranch: text("base_branch"),
  branch: text("branch"),
  worktreePath: text("worktree_path").notNull(),
  status: text("status").notNull(),
  hasPendingPermission: integer("has_pending_permission", { mode: "boolean" }).notNull().default(false),
  controller: text("controller"),
  claudeSessionId: text("claude_session_id"),
  title: text("title"),
  /**
   * How `title` got its value — internal bookkeeping for the auto-titler, not
   * exposed on the protocol's `Session` type: "manual" (user set it at
   * creation, never touched again), "placeholder" (the raw first prompt,
   * set instantly, still eligible for an LLM upgrade), "generated" (an LLM
   * title accepted — terminal, we stop trying), or null (no title yet).
   */
  titleSource: text("title_source"),
  /** How many times we've tried upgrading a placeholder title; capped so a session that never gives the model "enough" just keeps its placeholder forever. */
  titleGenAttempts: integer("title_gen_attempts").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
  /**
   * The model the session's last turn actually ran under (null = the SDK's own
   * default, or no turn yet). Kept so a model switch is detected across process
   * recycles and daemon restarts, not just within one live process.
   */
  lastModel: text("last_model"),
  /** When the session was moved to the trash; null unless status = "trashed". */
  trashedAt: integer("trashed_at"),
  /**
   * The status it held before being trashed, so restore is faithful rather
   * than a guess — an archived session that gets trashed and restored must
   * come back archived, not idle with a worktree that no longer exists.
   */
  trashedFrom: text("trashed_from"),
  /** "normal" or "merge_conflict" — see MergeConflictMeta in @renki/protocol. */
  purpose: text("purpose").notNull().default("normal"),
  /** JSON-encoded MergeConflictMeta, only set when purpose = "merge_conflict". */
  mergeMeta: text("merge_meta"),
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
    title_source TEXT,
    title_gen_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'normal',
    merge_meta TEXT,
    trashed_at INTEGER,
    trashed_from TEXT,
    last_model TEXT
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
