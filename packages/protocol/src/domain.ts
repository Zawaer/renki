import { z } from "zod";

/**
 * Core domain entities. These describe *what things are* — repos we can start
 * sessions against, and the sessions themselves. They are deliberately free of
 * any transport concern (no WS/REST detail here) so every client and the daemon
 * can agree on the same nouns.
 */

/** A stable identifier for a client device (Mac, phone, a given browser). */
export const DeviceId = z.string().min(1);
export type DeviceId = z.infer<typeof DeviceId>;

/** Human-readable device label, e.g. "Toivo's Pixel". Optional cosmetic field. */
export const DeviceName = z.string().min(1).max(120);
export type DeviceName = z.infer<typeof DeviceName>;

/**
 * A git repository discovered under the daemon's configured root directory.
 * `id` is a slug derived from the folder name (stable across restarts); `path`
 * is the absolute path to the repo's main working tree on the homelab.
 */
export const Repo = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().min(1),
});
export type Repo = z.infer<typeof Repo>;

/**
 * Session lifecycle:
 *   idle     — exists, no query currently running; can accept a prompt
 *   busy     — a Claude turn is streaming right now; new prompts are rejected
 *   error    — last turn failed; still resumable
 *   archived — worktree cleaned up; kept for transcript history only
 */
export const SessionStatus = z.enum(["idle", "busy", "error", "archived"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Distinguishes an ordinary session from one the daemon spawned itself to resolve a merge conflict. */
export const SessionPurpose = z.enum(["normal", "merge_conflict"]);
export type SessionPurpose = z.infer<typeof SessionPurpose>;

/** Attached to a `merge_conflict` session: which branches it's reconciling and which files git left unresolved. */
export const MergeConflictMeta = z.object({
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  /** The session whose branch was being merged, if the merge was triggered from one (null for ad-hoc branch names). */
  sourceSessionId: z.string().min(1).nullable(),
  conflictedFiles: z.array(z.string()),
});
export type MergeConflictMeta = z.infer<typeof MergeConflictMeta>;

/**
 * A single Claude Code session, pinned to a dedicated git worktree so parallel
 * sessions on the same repo never collide on file state. A session can also
 * be created with no repo at all (`repoId`/`baseBranch`/`branch` all null) —
 * just a plain scratch directory for chatting, with no git involved.
 *
 * `claudeSessionId` is the id the Agent SDK gives us; we persist it so we can
 * `resume` the conversation on the next prompt even after a daemon restart.
 * `controller` is the single device currently allowed to send prompts (or null
 * when the session is idle/unlocked) — the heart of the take-control model.
 */
export const Session = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1).nullable(),
  repoName: z.string().min(1),
  baseBranch: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
  worktreePath: z.string().min(1),
  status: SessionStatus,
  /**
   * True while a `permission_request` is awaiting a decision (see events.ts).
   * Orthogonal to `status` — a session waiting on a permission is still
   * "busy", but this flag is what a session-list UI needs to tell "actively
   * generating" apart from "stalled on you".
   */
  hasPendingPermission: z.boolean(),
  controller: DeviceId.nullable(),
  claudeSessionId: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastActivityAt: z.number().int(),
  /** Optional/absent means "normal" — kept optional so older events/fixtures without it still parse. */
  purpose: SessionPurpose.optional(),
  mergeMeta: MergeConflictMeta.nullable().optional(),
});
export type Session = z.infer<typeof Session>;

export const PermissionDecision = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;
