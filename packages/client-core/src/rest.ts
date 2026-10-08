import type {
  AccountsResponse,
  AddSetupTokenResponse,
  BranchStatusResponse,
  CapabilitiesResponse,
  ConnectUsageKeyResponse,
  CloneRepoResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  DisconnectUsageKeyResponse,
  EmptyTrashResponse,
  GetTranscriptResponse,
  WorkspaceChangesResponse,
  WorkspaceDirResponse,
  WorkspaceFileDiffResponse,
  WorkspaceFileResponse,
  GithubReposResponse,
  ListReposResponse,
  ListSessionsResponse,
  PullBranchResponse,
  RenameSessionResponse,
  UpdateSessionComposerRequest,
  UpdateSessionComposerResponse,
  RestoreSessionResponse,
  RtkGainResponse,
  Session,
  InsightsResponse,
  SearchResponse,
  StatsResponse,
  SwitchAccountResponse,
  TailscaleStatusResponse,
  UpdateRotationRequest,
  UpdateRotationResponse,
  UsageLoginResponse,
} from "@renki/protocol";

/**
 * Typed wrapper over the daemon's REST control plane. Framework-agnostic (uses
 * global fetch, present in browsers and React Native). All calls carry the
 * bearer token; a non-2xx response throws a RestError the UI can display.
 */
export class RestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RestError";
  }
}

export type ClientAuth = {
  /** e.g. http://homelab.tailnet:4517 */
  baseUrl: string;
  token: string;
};

export class RestClient {
  constructor(private readonly auth: ClientAuth) {}

  async listRepos(): Promise<ListReposResponse["repos"]> {
    return (await this.get<ListReposResponse>("/repos")).repos;
  }

  /** Repos on GitHub the daemon's login can see. `available: false` means it has no usable GitHub login. */
  async listGithubRepos(): Promise<GithubReposResponse> {
    return this.get<GithubReposResponse>("/github/repos");
  }

  /** Clone `owner/name` (or any github.com URL for it) into the daemon's repos root. */
  async cloneGithubRepo(repo: string): Promise<CloneRepoResponse> {
    return this.post<CloneRepoResponse>("/github/clone", { repo });
  }

  async listSessions(): Promise<Session[]> {
    return (await this.get<ListSessionsResponse>("/sessions")).sessions;
  }

  async createSession(body: CreateSessionRequest): Promise<Session> {
    return (await this.post<CreateSessionResponse>("/sessions", body)).session;
  }

  /** How far `branch` has diverged from `origin/<branch>` — check before basing a new session's worktree on it. */
  async getBranchStatus(repoId: string, branch: string): Promise<BranchStatusResponse> {
    return this.get<BranchStatusResponse>(
      `/repos/${encodeURIComponent(repoId)}/branch-status?branch=${encodeURIComponent(branch)}`,
    );
  }

  /** Fast-forward `branch` to match `origin/<branch>` (fails, rather than merge-commits, if that's not a clean fast-forward). */
  async pullBranch(repoId: string, branch: string): Promise<PullBranchResponse> {
    return this.post<PullBranchResponse>(`/repos/${encodeURIComponent(repoId)}/pull`, { branch });
  }

  async getTranscript(sessionId: string): Promise<GetTranscriptResponse> {
    return this.get<GetTranscriptResponse>(`/sessions/${encodeURIComponent(sessionId)}/transcript`);
  }

  /** What the session changed relative to its base branch — commits plus uncommitted work. */
  async getWorkspaceChanges(sessionId: string): Promise<WorkspaceChangesResponse> {
    return this.get<WorkspaceChangesResponse>(`/sessions/${encodeURIComponent(sessionId)}/changes`);
  }

  /** One changed file's unified diff against the base. */
  async getWorkspaceFileDiff(sessionId: string, path: string): Promise<WorkspaceFileDiffResponse> {
    return this.get<WorkspaceFileDiffResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/changes/file?path=${encodeURIComponent(path)}`,
    );
  }

  /** A directory of the session's working tree ("" for its root). */
  async listWorkspaceDir(sessionId: string, path = ""): Promise<WorkspaceDirResponse> {
    return this.get<WorkspaceDirResponse>(`/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`);
  }

  /** One file from the session's working tree. */
  async readWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceFileResponse> {
    return this.get<WorkspaceFileResponse>(`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`);
  }

  async archiveSession(sessionId: string): Promise<Session> {
    const res = await this.post<{ session: Session }>(`/sessions/${encodeURIComponent(sessionId)}/archive`, {});
    return res.session;
  }

  /** Manual rename — permanently takes title ownership away from the auto-titler, even if it hasn't upgraded the placeholder yet. */
  async renameSession(sessionId: string, title: string): Promise<Session> {
    const res = await this.post<RenameSessionResponse>(`/sessions/${encodeURIComponent(sessionId)}/rename`, { title });
    return res.session;
  }

  /**
   * Repin part of a session's composer (model / thinking effort / permission
   * mode). Send only what changed: omitted fields keep their current value, so
   * this can't clobber a pick someone just made on another device.
   *
   * The daemon broadcasts the updated session to every connected client, so
   * callers don't need to merge the response into their own state — though it
   * is returned for the optimistic-update case.
   */
  async updateSessionComposer(sessionId: string, composer: UpdateSessionComposerRequest): Promise<Session> {
    const res = await this.post<UpdateSessionComposerResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/composer`,
      composer,
    );
    return res.session;
  }

  /**
   * Moves the session to the trash: recoverable until its `purgeAt` deadline,
   * with transcript, worktree and branch all still intact until then.
   *
   * Returns the trashed session, or null if the daemon has its recycle bin
   * switched off (RENKI_TRASH_RETENTION_DAYS=0), in which case this really did
   * delete it.
   */
  /** Bring an archived session back to work: its worktree is rebuilt and it takes prompts again. */
  async unarchiveSession(sessionId: string): Promise<Session> {
    return (await this.post<{ session: Session }>(`/sessions/${encodeURIComponent(sessionId)}/unarchive`, {})).session;
  }

  async trashSession(sessionId: string): Promise<Session | null> {
    const res = await this.request<DeleteSessionResponse>("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
    return res.session ?? null;
  }

  /** Takes a session back out of the trash, at whatever status it held before. */
  async restoreSession(sessionId: string): Promise<Session> {
    const res = await this.post<RestoreSessionResponse>(`/sessions/${encodeURIComponent(sessionId)}/restore`, {});
    return res.session;
  }

  /** Destroys the session, its transcript, its worktree and its branch immediately. No undo. */
  async purgeSession(sessionId: string): Promise<void> {
    await this.request<DeleteSessionResponse>("DELETE", `/sessions/${encodeURIComponent(sessionId)}?purge=true`);
  }

  /** Purges everything in the trash now, without waiting for the deadlines. */
  async emptyTrash(): Promise<number> {
    const res = await this.request<EmptyTrashResponse>("DELETE", "/sessions/trash");
    return res.purged;
  }

  async listAccounts(): Promise<AccountsResponse> {
    return this.get<AccountsResponse>("/accounts");
  }

  /** Manually rotate accounts. Omit `to` to jump to the account with most headroom. */
  async switchAccount(to?: number | string): Promise<SwitchAccountResponse> {
    return this.post<SwitchAccountResponse>("/accounts/switch", to === undefined ? {} : { to });
  }

  /** Toggle auto-rotation on/off and/or change its usage threshold. Send only what changed. */
  async updateRotation(patch: UpdateRotationRequest): Promise<UpdateRotationResponse> {
    return this.post<UpdateRotationResponse>("/accounts/rotation", patch);
  }

  /**
   * Connect a claude.ai usage session key (`sk-ant-sid…`) for the % display.
   * Two-step: call WITHOUT `orgId` first to get the orgs to pick from (`ok:false`,
   * `orgs` populated, nothing persisted), then call again WITH the chosen `orgId`
   * to persist it (`ok:true`).
   */
  async connectUsageKey(sessionKey: string, orgId?: string): Promise<ConnectUsageKeyResponse> {
    return this.post<ConnectUsageKeyResponse>("/accounts/usage-key", orgId ? { sessionKey, orgId } : { sessionKey });
  }

  /**
   * Guided browser login: ask the daemon to open a browser, wait for sign-in, and
   * extract the key. Only meaningful when the daemon host has a display + Chrome.
   */
  async startUsageLogin(): Promise<UsageLoginResponse> {
    return this.post<UsageLoginResponse>("/accounts/usage-key/login", {});
  }

  /** Remove a connected usage key (e.g. the wrong org got picked) — stops tracking that account's usage %. */
  async disconnectUsageKey(email: string): Promise<DisconnectUsageKeyResponse> {
    return this.request<DisconnectUsageKeyResponse>("DELETE", `/accounts/usage-key/${encodeURIComponent(email)}`);
  }

  /**
   * Register a new coding account — the credential `cswap` rotates the
   * official `claude` CLI across — from a `claude setup-token` value or a
   * plain Anthropic Console API key. Runs `cswap add-token` on the daemon
   * host. Distinct from `connectUsageKey`, which only connects a read-only
   * usage session key.
   */
  async addSetupTokenAccount(token: string): Promise<AddSetupTokenResponse> {
    return this.post<AddSetupTokenResponse>("/accounts/setup-token", { token });
  }

  /** The daemon host's own Tailscale hostname, if it can detect one — used to suggest a pairing URL. */
  async getTailscaleStatus(): Promise<TailscaleStatusResponse> {
    return this.get<TailscaleStatusResponse>("/tailscale-status");
  }

  /** Cost/token/wait-time analytics across every session, for the Stats page. */
  /** Messages in any chat (prompts and Claude's replies) containing `query`, newest first. */
  async search(query: string): Promise<SearchResponse> {
    return this.get<SearchResponse>(`/search?q=${encodeURIComponent(query)}`);
  }

  async getStats(): Promise<StatsResponse> {
    return this.get<StatsResponse>("/stats");
  }

  /** The rest of the Stats page (habits, tools, approvals, records), with days and hours in `tz` — the viewer's zone by default. */
  async getInsights(tz: string = localTimeZone()): Promise<InsightsResponse> {
    return this.get<InsightsResponse>(`/stats/insights?tz=${encodeURIComponent(tz)}`);
  }

  /**
   * Available models + slash commands, as reported by the Agent SDK. Empty
   * until the first turn has run this daemon process's lifetime — it's only
   * obtainable from a live SDK query, so there's a cold-start gap.
   */
  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.get<CapabilitiesResponse>("/capabilities");
  }

  /** RTK (rtk-ai/rtk) token-savings stats — `enabled:false` when RENKI_ENABLE_RTK is off for this daemon. */
  async getRtkGain(): Promise<RtkGainResponse> {
    return this.get<RtkGainResponse>("/rtk/gain");
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.auth.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.auth.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new RestError(res.status, String(detail.error ?? "http_error"), String(detail.message ?? res.statusText));
    }
    return (await res.json()) as T;
  }
}

/** This device's IANA time zone, or UTC where the runtime can't say. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
