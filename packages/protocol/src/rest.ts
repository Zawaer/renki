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

export const CreateSessionRequest = z.object({
  repoId: z.string().min(1),
  baseBranch: z.string().min(1),
  /** New branch to create for this session's worktree. Omit to derive one. */
  newBranch: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
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
