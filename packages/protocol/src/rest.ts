import { z } from "zod";
import { Repo, Session } from "./domain.js";
import { SessionEvent } from "./events.js";

/**
 * REST management API DTOs (Step 2). REST handles the "control plane" — the
 * discrete, request/response operations (list repos, create/list/archive
 * sessions, fetch a full transcript). The live conversation itself flows over
 * WebSocket. Keeping these separate means the heavy real-time path never has to
 * carry CRUD semantics.
 */

export const ListReposResponse = z.object({
  repos: z.array(Repo),
  /** The daemon's resolved CRC_REPOS_ROOT — surfaced so clients can show where repos are (or should be) found. */
  root: z.string(),
});
export type ListReposResponse = z.infer<typeof ListReposResponse>;

/** Omit `repoId` entirely for a repo-less session — just a plain directory to chat in, no git worktree. */
export const CreateSessionRequest = z
  .object({
    repoId: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    /** New branch to create for this session's worktree. Omit to derive one. */
    newBranch: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((v) => !v.repoId || !!v.baseBranch, {
    message: "baseBranch is required when repoId is set",
    path: ["baseBranch"],
  });
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z.object({
  session: Session,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ListSessionsResponse = z.object({
  sessions: z.array(Session),
});
export type ListSessionsResponse = z.infer<typeof ListSessionsResponse>;

/** Permanently removes the session's row and event log (unlike archive, which keeps history). */
export const DeleteSessionResponse = z.object({
  ok: z.boolean(),
});
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponse>;

/** A manual rename takes title ownership away from the auto-titler for good (see SessionManager.renameSession). */
export const RenameSessionRequest = z.object({
  title: z.string().min(1).max(200),
});
export type RenameSessionRequest = z.infer<typeof RenameSessionRequest>;

export const RenameSessionResponse = z.object({
  session: Session,
});
export type RenameSessionResponse = z.infer<typeof RenameSessionResponse>;

/** Full transcript for cold-loading a session outside the WS flow. */
export const GetTranscriptResponse = z.object({
  session: Session,
  events: z.array(SessionEvent),
});
export type GetTranscriptResponse = z.infer<typeof GetTranscriptResponse>;

/**
 * Register (or refresh) a device's Expo push token so the daemon can notify it
 * about permission requests / turn completion while its app is backgrounded.
 * `platform` is informational. Sending an empty token unregisters.
 */
export const RegisterPushTokenRequest = z.object({
  deviceId: z.string().min(1),
  expoToken: z.string(),
  platform: z.enum(["android", "ios", "web"]).optional(),
});
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequest>;

/** Aggregated turn_result totals for one bucket (a day, a month, or the "lifetime" bucket). */
export const StatsBucket = z.object({
  key: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  durationMs: z.number(),
  turnCount: z.number().int(),
  /** How many of turnCount finished with ok:true (see EventPayload's turn_result). */
  okCount: z.number().int(),
});
export type StatsBucket = z.infer<typeof StatsBucket>;

/** Same totals, grouped by repo instead of by time — which repos are actually costing the most. */
export const RepoStatsBucket = z.object({
  repoId: z.string(),
  repoName: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  durationMs: z.number(),
  turnCount: z.number().int(),
  okCount: z.number().int(),
});
export type RepoStatsBucket = z.infer<typeof RepoStatsBucket>;

/**
 * Cost/token/wait-time analytics, built by scanning every stored `turn_result`
 * event. `daily`/`monthly` are sorted ascending by key ("2026-07-22" /
 * "2026-07") and only contain buckets with at least one turn. `byRepo` is
 * sorted descending by cost. `firstTurnAt` is the timestamp of the earliest
 * recorded turn, or null if none have run yet.
 */
export const StatsResponse = z.object({
  daily: z.array(StatsBucket),
  monthly: z.array(StatsBucket),
  byRepo: z.array(RepoStatsBucket),
  lifetime: StatsBucket,
  firstTurnAt: z.number().int().nullable(),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

/**
 * The daemon's own best guess at a URL other devices could reach it on, read
 * from the local `tailscale` CLI (if installed) on the daemon's host. Lets a
 * client that's connected via a loopback address (e.g. a Mac browser on
 * `http://127.0.0.1:4517`) suggest a real one instead of leaving the user to
 * go find their Tailscale hostname by hand.
 */
export const TailscaleStatusResponse = z.object({
  available: z.boolean(),
  /** MagicDNS hostname, e.g. "homelab.tailnet.ts.net" (no trailing dot). */
  hostname: z.string().nullable(),
  /**
   * The HTTPS port `tailscale serve` is actually proxying to this daemon on,
   * if any (443 for a default `tailscale serve --bg <port>` setup, something
   * else if serve was pointed at a non-default port to dodge a collision with
   * another reverse proxy already on 443). Null if serve isn't fronting this
   * daemon at all — callers shouldn't suggest a hostname-only URL in that case.
   */
  servePort: z.number().nullable(),
});
export type TailscaleStatusResponse = z.infer<typeof TailscaleStatusResponse>;
