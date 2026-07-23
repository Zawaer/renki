import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateSessionIds } from "../src/db/migrateSessionIds.js";
import { events, sessions } from "../src/db/schema.js";
import type { DB } from "../src/db/index.js";
import { makeTestConfig, makeTestDb, makeTestRepo, cleanupConfig } from "./helpers.js";

// A pre-4834e2c session id: s_<uuid>. The regex the migration keys off requires
// this exact shape; today's newSessionId() produces a short base62 form instead.
const LEGACY_ID = "s_11111111-2222-3333-4444-555555555555";
const LEGACY_ID_2 = "s_66666666-7777-8888-9999-aaaaaaaaaaaa";
const SHORT_ID = "s_AbCdEfGhIj";

function insertSession(
  db: DB,
  row: {
    id: string;
    repoId?: string | null;
    repoName?: string;
    branch?: string | null;
    baseBranch?: string | null;
    worktreePath: string;
    mergeMeta?: string | null;
  },
): void {
  const now = Date.now();
  db.insert(sessions)
    .values({
      id: row.id,
      repoId: row.repoId ?? null,
      repoName: row.repoName ?? "demo",
      baseBranch: row.baseBranch ?? null,
      branch: row.branch ?? null,
      worktreePath: row.worktreePath,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      mergeMeta: row.mergeMeta ?? null,
    })
    .run();
}

function insertSessionCreatedEvent(
  db: DB,
  sessionId: string,
  payload: { repoId: string | null; repoName: string; baseBranch: string | null; branch: string | null; worktreePath: string; mergeMeta?: unknown },
): void {
  db.insert(events)
    .values({
      sessionId,
      seq: 0,
      ts: Date.now(),
      kind: "session_created",
      data: JSON.stringify({ kind: "session_created", ...payload }),
    })
    .run();
}

function readSessionCreatedData(db: DB, sessionId: string): any {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.kind, "session_created")))
    .get();
  return row ? JSON.parse(row.data) : null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).toString();
}

describe("migrateSessionIds", () => {
  it("is a no-op when no session has a legacy (UUID-form) id", async () => {
    const config = makeTestConfig();
    const db = makeTestDb();
    const worktreePath = mkdtempSync(join(tmpdir(), "crc-wt-"));
    insertSession(db, { id: SHORT_ID, worktreePath });
    insertSessionCreatedEvent(db, SHORT_ID, { repoId: null, repoName: "demo", baseBranch: null, branch: null, worktreePath });

    await migrateSessionIds(config, db);

    const row = db.select().from(sessions).where(eq(sessions.id, SHORT_ID)).get();
    expect(row?.id).toBe(SHORT_ID);
    expect(row?.worktreePath).toBe(worktreePath);
    cleanupConfig(config);
  });

  it("migrates a plain (no-repo) legacy session: new id, moved directory, updated events", async () => {
    const config = makeTestConfig();
    const db = makeTestDb();
    const parent = mkdtempSync(join(tmpdir(), "crc-scratch-"));
    const oldPath = join(parent, LEGACY_ID);
    mkdirSync(oldPath);

    insertSession(db, { id: LEGACY_ID, worktreePath: oldPath });
    insertSessionCreatedEvent(db, LEGACY_ID, { repoId: null, repoName: "demo", baseBranch: null, branch: null, worktreePath: oldPath });

    await migrateSessionIds(config, db);

    const rows = db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    const migrated = rows[0]!;
    expect(migrated.id).not.toBe(LEGACY_ID);
    expect(migrated.id).toMatch(/^s_/);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(migrated.worktreePath)).toBe(true);
    expect(migrated.worktreePath).toBe(join(parent, migrated.id));

    // events.session_id follows the row to its new id.
    const eventRows = db.select().from(events).where(eq(events.sessionId, migrated.id)).all();
    expect(eventRows).toHaveLength(1);

    // The embedded session_created payload's worktreePath was rewritten too.
    const data = readSessionCreatedData(db, migrated.id);
    expect(data.worktreePath).toBe(migrated.worktreePath);
    cleanupConfig(config);
  });

  it("migrates a repo-backed legacy session via `git worktree move`, keeping git's own admin state in sync", async () => {
    const config = makeTestConfig();
    const db = makeTestDb();
    const { repoId, repoPath } = makeTestRepo(config.reposRoot, "demo-repo");
    const worktreesParent = mkdtempSync(join(tmpdir(), "crc-worktrees-"));
    const oldPath = join(worktreesParent, LEGACY_ID);
    git(repoPath, "worktree", "add", oldPath, "-b", "crc/legacy");

    insertSession(db, { id: LEGACY_ID, repoId, repoName: repoId, branch: "crc/legacy", baseBranch: "main", worktreePath: oldPath });
    insertSessionCreatedEvent(db, LEGACY_ID, { repoId, repoName: repoId, baseBranch: "main", branch: "crc/legacy", worktreePath: oldPath });

    await migrateSessionIds(config, db);

    const migrated = db.select().from(sessions).all()[0]!;
    expect(migrated.id).not.toBe(LEGACY_ID);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(migrated.worktreePath)).toBe(true);

    // git itself knows about the new path (not just a plain fs rename that
    // would leave `.git/worktrees/<x>/gitdir` pointing at the old location).
    const list = git(repoPath, "worktree", "list");
    expect(list).toContain(migrated.worktreePath);
    expect(list).not.toContain(oldPath);
    cleanupConfig(config);
  });

  it("remaps mergeMeta.sourceSessionId when it points at another session that's also being migrated", async () => {
    const config = makeTestConfig();
    const db = makeTestDb();
    const parent = mkdtempSync(join(tmpdir(), "crc-scratch-"));
    const sourcePath = join(parent, LEGACY_ID);
    const conflictPath = join(parent, LEGACY_ID_2);
    mkdirSync(sourcePath);
    mkdirSync(conflictPath);

    insertSession(db, { id: LEGACY_ID, worktreePath: sourcePath });
    insertSessionCreatedEvent(db, LEGACY_ID, { repoId: null, repoName: "demo", baseBranch: null, branch: null, worktreePath: sourcePath });

    const mergeMeta = { sourceSessionId: LEGACY_ID, targetBranch: "main", conflictedFiles: [] };
    insertSession(db, { id: LEGACY_ID_2, worktreePath: conflictPath, mergeMeta: JSON.stringify(mergeMeta) });
    insertSessionCreatedEvent(db, LEGACY_ID_2, {
      repoId: null,
      repoName: "demo",
      baseBranch: null,
      branch: null,
      worktreePath: conflictPath,
      mergeMeta,
    });

    await migrateSessionIds(config, db);

    const rows = db.select().from(sessions).all();
    const migratedSource = rows.find((r) => r.mergeMeta === null)!;
    const migratedConflict = rows.find((r) => r.mergeMeta !== null)!;

    expect(migratedSource.id).not.toBe(LEGACY_ID);
    expect(migratedConflict.id).not.toBe(LEGACY_ID_2);

    const remapped = JSON.parse(migratedConflict.mergeMeta!);
    expect(remapped.sourceSessionId).toBe(migratedSource.id);

    const conflictEventData = readSessionCreatedData(db, migratedConflict.id);
    expect(conflictEventData.mergeMeta.sourceSessionId).toBe(migratedSource.id);
    cleanupConfig(config);
  });

  it("still migrates the DB row (with the old path) even if the worktree directory is already gone from disk", async () => {
    const config = makeTestConfig();
    const db = makeTestDb();
    const missingPath = join(mkdtempSync(join(tmpdir(), "crc-scratch-")), "already-deleted", LEGACY_ID);
    // Deliberately never created on disk.

    insertSession(db, { id: LEGACY_ID, worktreePath: missingPath });
    insertSessionCreatedEvent(db, LEGACY_ID, { repoId: null, repoName: "demo", baseBranch: null, branch: null, worktreePath: missingPath });

    await migrateSessionIds(config, db);

    const migrated = db.select().from(sessions).all()[0]!;
    expect(migrated.id).not.toBe(LEGACY_ID);
    // No directory existed to move, so the recorded path is left exactly as-is.
    expect(migrated.worktreePath).toBe(missingPath);
    cleanupConfig(config);
  });
});
