import { existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { simpleGit } from "simple-git";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { newSessionId } from "../ids.js";
import { findRepo } from "../repos.js";
import type { DB } from "./index.js";
import { events, sessions } from "./schema.js";

/** Session ids minted before 4834e2c ("Shorten session IDs for shorter session URLs"): `s_<uuid>`. */
const OLD_ID_RE = /^s_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * One-time backfill: rewrite every still-UUID session id to the new short
 * base62 form, so sessions created before 4834e2c get short URLs too instead
 * of keeping their long id forever (that commit only changed `newSessionId()`,
 * which affects new sessions, not any existing row/directory).
 *
 * Renames the on-disk worktree/scratch directory to match — via `git worktree
 * move` for repo sessions, so git's own admin state (`.git/worktrees/<x>/gitdir`)
 * stays in sync; a plain `mv` would leave it pointing at the now-missing old
 * path, and the next archive/delete would see an "unrecognized" worktree and
 * force-nuke it (losing any uncommitted work). Also follows every reference
 * to the old id: `events.session_id`, the `session_created` event's embedded
 * `worktreePath`/`mergeMeta`, and `sessions.merge_meta.sourceSessionId` for
 * conflict-resolution sessions.
 *
 * Must run before the SessionManager (or anything else) touches the DB — at
 * that point nothing is subscribed to the old ids' event channels and there's
 * no in-memory state that could go stale mid-rename.
 */
export async function migrateSessionIds(config: Config, db: DB): Promise<void> {
  const rows = db.select().from(sessions).all();
  const toMigrate = rows.filter((r) => OLD_ID_RE.test(r.id));
  if (toMigrate.length === 0) return;

  const usedIds = new Set(rows.map((r) => r.id));
  const oldToNew = new Map<string, string>();
  for (const row of toMigrate) {
    let id = newSessionId();
    while (usedIds.has(id)) id = newSessionId();
    usedIds.add(id);
    oldToNew.set(row.id, id);
  }

  logger.info("migrating legacy session ids to short form", { count: toMigrate.length });

  for (const row of toMigrate) {
    const oldId = row.id;
    const newId = oldToNew.get(oldId)!;
    let worktreePath = row.worktreePath;

    if (worktreePath && existsSync(worktreePath)) {
      const newPath = resolve(dirname(worktreePath), newId);
      const moved = row.repoId
        ? await moveGitWorktree(config, row.repoId, worktreePath, newPath)
        : movePlainDir(worktreePath, newPath);
      if (moved) worktreePath = newPath;
    }

    const mergeMeta = remapMergeMeta(row.mergeMeta, oldToNew);

    db.transaction((tx) => {
      tx.update(sessions).set({ id: newId, worktreePath, mergeMeta }).where(eq(sessions.id, oldId)).run();
      tx.update(events).set({ sessionId: newId }).where(eq(events.sessionId, oldId)).run();

      const created = tx
        .select()
        .from(events)
        .where(and(eq(events.sessionId, newId), eq(events.kind, "session_created")))
        .get();
      if (created) {
        const data = remapSessionCreatedPayload(created.data, worktreePath, oldToNew);
        if (data !== created.data) {
          tx.update(events)
            .set({ data })
            .where(and(eq(events.sessionId, newId), eq(events.kind, "session_created")))
            .run();
        }
      }
    });

    logger.info("migrated session id", { oldId, newId, worktreePath });
  }
}

async function moveGitWorktree(config: Config, repoId: string, oldPath: string, newPath: string): Promise<boolean> {
  const repo = await findRepo(config, repoId);
  if (!repo) {
    logger.warn("skipping worktree move during id migration: repo not found", { repoId, oldPath });
    return false;
  }
  try {
    await simpleGit(repo.path).raw(["worktree", "move", oldPath, newPath]);
    return true;
  } catch (err) {
    logger.warn("git worktree move failed during id migration; leaving directory in place", {
      oldPath,
      newPath,
      err: String(err),
    });
    return false;
  }
}

function movePlainDir(oldPath: string, newPath: string): boolean {
  try {
    renameSync(oldPath, newPath);
    return true;
  } catch (err) {
    logger.warn("directory rename failed during id migration; leaving directory in place", {
      oldPath,
      newPath,
      err: String(err),
    });
    return false;
  }
}

function remapMergeMeta(mergeMeta: string | null, oldToNew: Map<string, string>): string | null {
  if (!mergeMeta) return mergeMeta;
  const parsed = JSON.parse(mergeMeta) as { sourceSessionId?: string | null };
  if (parsed.sourceSessionId && oldToNew.has(parsed.sourceSessionId)) {
    parsed.sourceSessionId = oldToNew.get(parsed.sourceSessionId)!;
    return JSON.stringify(parsed);
  }
  return mergeMeta;
}

function remapSessionCreatedPayload(data: string, worktreePath: string, oldToNew: Map<string, string>): string {
  const payload = JSON.parse(data) as {
    worktreePath: string;
    mergeMeta?: { sourceSessionId?: string | null } | null;
  };
  let changed = false;
  if (payload.worktreePath !== worktreePath) {
    payload.worktreePath = worktreePath;
    changed = true;
  }
  if (payload.mergeMeta?.sourceSessionId && oldToNew.has(payload.mergeMeta.sourceSessionId)) {
    payload.mergeMeta.sourceSessionId = oldToNew.get(payload.mergeMeta.sourceSessionId)!;
    changed = true;
  }
  return changed ? JSON.stringify(payload) : data;
}
