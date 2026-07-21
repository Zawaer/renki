import type {
  AccountsResponse,
  CapabilitiesResponse,
  ConnectUsageKeyResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  GetTranscriptResponse,
  ListReposResponse,
  ListSessionsResponse,
  RtkGainResponse,
  Session,
  StatsResponse,
  SwitchAccountResponse,
  TailscaleStatusResponse,
  UsageLoginResponse,
} from "@crc/protocol";

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

  async listSessions(): Promise<Session[]> {
    return (await this.get<ListSessionsResponse>("/sessions")).sessions;
  }

  async createSession(body: CreateSessionRequest): Promise<Session> {
    return (await this.post<CreateSessionResponse>("/sessions", body)).session;
  }

  async getTranscript(sessionId: string): Promise<GetTranscriptResponse> {
    return this.get<GetTranscriptResponse>(`/sessions/${encodeURIComponent(sessionId)}/transcript`);
  }

  async archiveSession(sessionId: string): Promise<Session> {
    const res = await this.post<{ session: Session }>(`/sessions/${encodeURIComponent(sessionId)}/archive`, {});
    return res.session;
  }

  async listAccounts(): Promise<AccountsResponse> {
    return this.get<AccountsResponse>("/accounts");
  }

  /** Manually rotate accounts. Omit `to` to jump to the account with most headroom. */
  async switchAccount(to?: number | string): Promise<SwitchAccountResponse> {
    return this.post<SwitchAccountResponse>("/accounts/switch", to === undefined ? {} : { to });
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
   * Mac guided login: ask the daemon to open a browser, wait for sign-in, and
   * extract the key. Only meaningful when the daemon host has a display + Chrome.
   */
  async startUsageLogin(): Promise<UsageLoginResponse> {
    return this.post<UsageLoginResponse>("/accounts/usage-key/login", {});
  }

  /** The daemon host's own Tailscale hostname, if it can detect one — used to suggest a pairing URL. */
  async getTailscaleStatus(): Promise<TailscaleStatusResponse> {
    return this.get<TailscaleStatusResponse>("/tailscale-status");
  }

  /** Cost/token/wait-time analytics across every session, for the Stats page. */
  async getStats(): Promise<StatsResponse> {
    return this.get<StatsResponse>("/stats");
  }

  /**
   * Available models + slash commands, as reported by the Agent SDK. Empty
   * until the first turn has run this daemon process's lifetime — it's only
   * obtainable from a live SDK query, so there's a cold-start gap.
   */
  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.get<CapabilitiesResponse>("/capabilities");
  }

  /** RTK (rtk-ai/rtk) token-savings stats — `enabled:false` when CRC_ENABLE_RTK is off for this daemon. */
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
