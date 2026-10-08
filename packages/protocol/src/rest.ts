import { z } from "zod";
import { Repo, Session, SessionComposerPatch } from "./domain.js";
import { SessionEvent } from "./events.js";

/**
 * REST management API DTOs (Step 2). REST handles the "control plane" — the
 * discrete, request/response operations (list repos, create/list/archive
 * sessions, fetch a full transcript). The live conversation itself flows over
 * WebSocket. Keeping these separate means the heavy real-time path never has to
 * carry CRUD semantics.
 */

/**
 * How far a repo's local branch has diverged from `origin/<branch>`, as of a
 * fresh `git fetch` run right before the comparison. `hasRemote:false` means
 * the branch doesn't exist on origin (local-only branch, or no such remote) —
 * `ahead`/`behind` are meaningless in that case.
 */
export const BranchStatusResponse = z.object({
  ahead: z.number().int(),
  behind: z.number().int(),
  hasRemote: z.boolean(),
});
export type BranchStatusResponse = z.infer<typeof BranchStatusResponse>;

/** Result of fast-forwarding a repo's branch to match `origin/<branch>`. */
export const PullBranchResponse = z.object({
  ok: z.boolean(),
  behind: z.number().int(),
});
export type PullBranchResponse = z.infer<typeof PullBranchResponse>;

export const ListReposResponse = z.object({
  repos: z.array(Repo),
  /** The daemon's resolved RENKI_REPOS_ROOT — surfaced so clients can show where repos are (or should be) found. */
  root: z.string(),
});
export type ListReposResponse = z.infer<typeof ListReposResponse>;

/** One repository the daemon's GitHub login can see — the list behind "clone a repo you haven't checked out yet". */
export const GithubRepo = z.object({
  /** owner/name — what you'd type, and what the clone endpoint takes. */
  fullName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  isFork: z.boolean(),
  /** ISO timestamp of the last push, or null; the list is ordered by it. */
  pushedAt: z.string().nullable(),
  defaultBranch: z.string().nullable(),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

export const GithubReposResponse = z.object({
  /** False when the daemon has no usable GitHub CLI login; clients then hide the flow and show `reason`. */
  available: z.boolean(),
  login: z.string().nullable(),
  reason: z.string().nullable(),
  repos: z.array(GithubRepo),
});
export type GithubReposResponse = z.infer<typeof GithubReposResponse>;

export const CloneRepoRequest = z.object({
  /** owner/name, or any github.com URL for it. */
  repo: z.string().min(1),
});
export type CloneRepoRequest = z.infer<typeof CloneRepoRequest>;

export const CloneRepoResponse = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  /** The cloned (or already-present) repo, ready to start a session on. */
  repo: Repo.nullable(),
  /** True when the directory was already there, so nothing was fetched. */
  alreadyPresent: z.boolean(),
});
export type CloneRepoResponse = z.infer<typeof CloneRepoResponse>;

/** Omit `repoId` entirely for a repo-less session — just a plain directory to chat in, no git worktree. */
export const CreateSessionRequest = z
  .object({
    repoId: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    /** New branch to create for this session's worktree. Omit to derive one. */
    newBranch: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    /**
     * The creating device's own composer defaults, copied onto the new session.
     * This is the ONLY point at which a device default is read: from here on
     * the session carries its own settings, so changing the default on this
     * device (or opening the session on another) leaves it untouched.
     */
    composer: SessionComposerPatch.optional(),
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

/**
 * Response to DELETE /sessions/:id, which soft-deletes by default: the session
 * moves to the trash and comes back in `session` with status "trashed" and a
 * `purgeAt` deadline. With `?purge=true` it really is gone and `session` is
 * null.
 *
 * `ok` is kept so older clients that only checked it still work — they now get
 * a recycle bin without knowing it exists.
 */
export const DeleteSessionResponse = z.object({
  ok: z.boolean(),
  /** The trashed session, or null when the delete was permanent. */
  session: Session.nullable().optional(),
});
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponse>;

/** Puts a trashed session back, at whatever status it held before it was trashed. */
export const RestoreSessionResponse = z.object({
  session: Session,
});
export type RestoreSessionResponse = z.infer<typeof RestoreSessionResponse>;

/** Purges every trashed session at once, ahead of its deadline. */
export const EmptyTrashResponse = z.object({
  purged: z.number().int(),
});
export type EmptyTrashResponse = z.infer<typeof EmptyTrashResponse>;

/** A manual rename takes title ownership away from the auto-titler for good (see SessionManager.renameSession). */
export const RenameSessionRequest = z.object({
  title: z.string().min(1).max(200),
});
export type RenameSessionRequest = z.infer<typeof RenameSessionRequest>;

export const RenameSessionResponse = z.object({
  session: Session,
});
export type RenameSessionResponse = z.infer<typeof RenameSessionResponse>;

/**
 * Repins one or more of a session's composer settings. Omitted fields keep
 * their current value, so a client that only changed the effort picker sends
 * only `effortKey` and can't clobber a model someone picked on another device.
 */
export const UpdateSessionComposerRequest = SessionComposerPatch;
export type UpdateSessionComposerRequest = z.infer<typeof UpdateSessionComposerRequest>;

export const UpdateSessionComposerResponse = z.object({
  session: Session,
});
export type UpdateSessionComposerResponse = z.infer<typeof UpdateSessionComposerResponse>;

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
  /**
   * Prompt-cache reads, kept apart from inputTokens: a turn with several tool
   * round-trips re-reads the same context each time, so this dwarfs the rest.
   * Optional so clients still read stats from a daemon that predates it.
   */
  cachedInputTokens: z.number().optional(),
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
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number(),
  durationMs: z.number(),
  turnCount: z.number().int(),
  okCount: z.number().int(),
});
export type RepoStatsBucket = z.infer<typeof RepoStatsBucket>;

/**
 * What a chat export contains (GET /sessions/:id/export). Timestamps are
 * always in; the rest is what the export dialog's checkboxes choose.
 * Markdown comes back as a .md, or a .zip holding the .md and a media/ folder
 * when media is included and the chat has any.
 */
export const ExportFormat = z.enum(["markdown", "pdf"]);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportOptions = z.object({
  format: ExportFormat.default("markdown"),
  /** Images and files you attached, and screenshots Claude saw. */
  media: z.boolean().default(true),
  /** Commands Claude ran, files it edited, and their output. */
  tools: z.boolean().default(true),
  /** Claude's thinking, where it was shown. */
  thinking: z.boolean().default(false),
  /** Each reply's duration, tokens and cost. */
  stats: z.boolean().default(false),
  /** IANA zone for the timestamps — the exporting device's. */
  timeZone: z.string().optional(),
});
export type ExportOptions = z.infer<typeof ExportOptions>;

/**
 * One message that matched a chat search: a prompt you sent, or a block of
 * Claude's reply. Where it sits in the transcript is given the way the
 * transcript itself names things — `promptId` for a prompt, `turnId` plus
 * `blockIndex` for a reply block — so a client can scroll straight to it.
 * `snippet` is a short window of the message around the first match, with
 * `matchStart`/`matchLength` marking the match inside it.
 */
export const SearchHit = z.object({
  sessionId: z.string(),
  sessionTitle: z.string().nullable(),
  repoName: z.string(),
  /** Null for a repo-less chat. */
  repoId: z.string().nullable(),
  seq: z.number().int(),
  ts: z.number().int(),
  role: z.enum(["you", "claude"]),
  promptId: z.string().nullable(),
  turnId: z.string().nullable(),
  blockIndex: z.number().int().nullable(),
  snippet: z.string(),
  matchStart: z.number().int(),
  matchLength: z.number().int(),
});
export type SearchHit = z.infer<typeof SearchHit>;

/**
 * Newest hits first, across every chat that isn't trashed or deleted.
 * `truncated` means there were more matches than the daemon returns.
 */
export const SearchResponse = z.object({
  query: z.string(),
  hits: z.array(SearchHit),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

/**
 * Cost/token/wait-time analytics, built by scanning every stored `turn_result`
 * event. `daily`/`monthly` are sorted ascending by key ("2026-07-22" /
 * "2026-07") and only contain buckets with at least one turn. `byRepo`,
 * `byModel`, and `byClientType` are sorted descending by cost — `byModel`'s
 * key is the model string a turn ran with, or "default" when no per-turn
 * override was sent; `byClientType`'s key is the submitting device's kind
 * ("web"/"phone"/"vscode"), or "unknown" for turns recorded before this
 * field existed. `firstTurnAt` is the timestamp of the earliest recorded
 * turn, or null if none have run yet.
 */
export const StatsResponse = z.object({
  daily: z.array(StatsBucket),
  monthly: z.array(StatsBucket),
  byRepo: z.array(RepoStatsBucket),
  byModel: z.array(StatsBucket),
  byClientType: z.array(StatsBucket),
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

// ── A session's workspace: its changes and its files ─────────────────────────

/**
 * One file that differs between the session's base and its working tree.
 * `status`: A added, M modified, D deleted, T type change, "?" untracked.
 * Line counts are null for a binary file.
 */
export const WorkspaceFileChange = z.object({
  path: z.string(),
  status: z.enum(["A", "M", "D", "T", "?"]),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
});
export type WorkspaceFileChange = z.infer<typeof WorkspaceFileChange>;

/**
 * Everything the session has changed relative to where it branched from —
 * commits on its branch plus uncommitted and untracked work, as one diff.
 * `available:false` for a session with no git working tree (a plain chat).
 */
export const WorkspaceChangesResponse = z.object({
  available: z.boolean(),
  /** The branch it's compared against, e.g. "main". */
  base: z.string().nullable(),
  /** The session's own branch. */
  branch: z.string().nullable(),
  /** Commits on the branch since it left the base. */
  ahead: z.number().int(),
  files: z.array(WorkspaceFileChange),
});
export type WorkspaceChangesResponse = z.infer<typeof WorkspaceChangesResponse>;

/** One file's unified diff against the base. `truncated` when it was cut to keep the response small. */
export const WorkspaceFileDiffResponse = z.object({
  path: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
});
export type WorkspaceFileDiffResponse = z.infer<typeof WorkspaceFileDiffResponse>;

export const WorkspaceEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  /** Bytes, for files. */
  size: z.number().int().nullable(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

/** A directory of the session's working tree, directories first. `path` is relative to the tree's root ("" for the root). */
export const WorkspaceDirResponse = z.object({
  path: z.string(),
  entries: z.array(WorkspaceEntry),
});
export type WorkspaceDirResponse = z.infer<typeof WorkspaceDirResponse>;

/** A file from the working tree. `content` is null for a binary file; `truncated` when it was cut at the size cap. */
export const WorkspaceFileResponse = z.object({
  path: z.string(),
  size: z.number().int(),
  content: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceFileResponse = z.infer<typeof WorkspaceFileResponse>;

// ── Insights: the Stats page beyond cost and tokens ──────────────────────────

/** A session a stat points at, so the page can link to it. `title` is null for an untitled or deleted one. */
export const StatsSessionRef = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  repoName: z.string(),
  /** False once the session is hard-deleted: shown, but not linkable. */
  exists: z.boolean(),
});
export type StatsSessionRef = z.infer<typeof StatsSessionRef>;

/** A record: its value, when it happened, and where. */
export const StatsRecord = z.object({
  value: z.number(),
  ts: z.number().int(),
  session: StatsSessionRef,
});
export type StatsRecord = z.infer<typeof StatsRecord>;

/** A count with a label, for ranked lists. */
export const StatsCount = z.object({ key: z.string(), count: z.number().int() });
export type StatsCount = z.infer<typeof StatsCount>;

export const StatsAchievement = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  achieved: z.boolean(),
  /** 0-1 toward it, for one not reached yet; null when it isn't a count. */
  progress: z.number().nullable(),
});
export type StatsAchievement = z.infer<typeof StatsAchievement>;

/**
 * Everything the Stats page shows beyond StatsResponse's cost and tokens,
 * computed from the whole event log. Days and hours are in the `tz` the
 * client asked for (an IANA name; UTC when it's missing or unknown), so the
 * heatmap's "9am" is the viewer's 9am.
 */
export const InsightsResponse = z.object({
  tz: z.string(),
  computedAt: z.number().int(),

  // Your work
  /** [weekday 0=Monday..6][hour 0..23] → turns started then. */
  heatmap: z.array(z.array(z.number().int())),
  longestTurn: StatsRecord.nullable(),
  /** By total turn time. */
  longestSession: StatsRecord.nullable(),
  /** Lines Claude's edits added and removed, per local day, ascending. Only days with edits. */
  linesDaily: z.array(z.object({ day: z.string(), added: z.number().int(), removed: z.number().int() })),
  topFiles: z.array(z.object({ repoName: z.string(), path: z.string(), edits: z.number().int(), added: z.number().int(), removed: z.number().int() })),
  /** Distinct files Claude has edited, across every repo. */
  filesTouched: z.number().int(),
  /** Consecutive local days with at least one turn. `current` is 0 unless today or yesterday had one. */
  streak: z.object({ current: z.number().int(), longest: z.number().int(), activeDays: z.number().int() }),
  repoStreaks: z.array(z.object({ repoName: z.string(), current: z.number().int(), longest: z.number().int(), activeDays: z.number().int() })),
  prompts: z.object({
    count: z.number().int(),
    medianChars: z.number().int(),
    /** Typed into a turn that was already running. */
    steered: z.number().int(),
    queued: z.number().int(),
  }),

  // Claude's work
  tools: z.array(z.object({ name: z.string(), count: z.number().int(), failed: z.number().int() })),
  /** First word of each shell command (two for git, npm and friends: "git commit"). */
  shellCommands: z.array(StatsCount),
  agents: z.object({
    count: z.number().int(),
    background: z.number().int(),
    medianDurationMs: z.number().int().nullable(),
    byType: z.array(StatsCount),
  }),
  /**
   * Turn time while no device was connected: Claude working with nobody
   * watching. Only measurable from `since` (when the daemon started keeping
   * track), so `turnMs` is the turn time over the same period.
   */
  handsOff: z.object({ since: z.number().int().nullable(), handsOffMs: z.number().int(), turnMs: z.number().int() }),
  /** Output tokens and the time they took, per model, for tokens a minute. */
  speed: z.array(z.object({ model: z.string(), outputTokens: z.number().int(), durationMs: z.number().int() })),
  outcomes: z.object({
    ok: z.number().int(),
    stopped: z.number().int(),
    limited: z.number().int(),
    restarted: z.number().int(),
    errored: z.number().int(),
  }),

  // Together
  approvals: z.object({
    count: z.number().int(),
    allowed: z.number().int(),
    denied: z.number().int(),
    /** Answered by nobody: timed out or cancelled. */
    unanswered: z.number().int(),
    medianResponseMs: z.number().int().nullable(),
    byDevice: z.array(z.object({ key: z.string(), count: z.number().int(), medianResponseMs: z.number().int().nullable() })),
    byTool: z.array(z.object({ tool: z.string(), allowed: z.number().int(), denied: z.number().int() })),
  }),

  // Money and limits
  limits: z.object({
    hits: z.number().int(),
    pauses: z.number().int(),
    pausedMs: z.number().int(),
    switches: z.number().int(),
    /** Which account each switch moved to ("#2"). */
    switchesTo: z.array(StatsCount),
  }),
  cache: z.object({ inputTokens: z.number().int(), cachedInputTokens: z.number().int() }),

  // Fun
  records: z.object({
    mostExpensiveTurn: StatsRecord.nullable(),
    mostToolsInTurn: StatsRecord.nullable(),
    mostFilesInSession: StatsRecord.nullable(),
    busiestDay: z.object({ day: z.string(), turns: z.number().int() }).nullable(),
    /** Most turns running at the same moment, across sessions. */
    mostAtOnce: z.object({ count: z.number().int(), ts: z.number().int() }).nullable(),
  }),
  rememberWhen: z
    .object({
      session: StatsSessionRef,
      createdAt: z.number().int(),
      /** How long ago, as the page says it: "a year ago", "6 months ago", "a month ago". */
      ago: z.string(),
      firstPrompt: z.string().nullable(),
    })
    .nullable(),
  words: z.object({ yours: z.number().int(), claudes: z.number().int() }),
  achievements: z.array(StatsAchievement),
  /** Output tokens per model per local month, ascending: model share over time. */
  modelMonthly: z.array(z.object({ month: z.string(), byModel: z.record(z.string(), z.number()) })),

  // Git and context
  git: z.object({ commits: z.number().int(), merges: z.number().int(), pushes: z.number().int(), byRepo: z.array(z.object({ repoName: z.string(), commits: z.number().int() })) }),
  compactions: z.object({ count: z.number().int(), auto: z.number().int(), avgPreTokens: z.number().int().nullable() }),
});
export type InsightsResponse = z.infer<typeof InsightsResponse>;
