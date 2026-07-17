import type {
  AccountsResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  GetTranscriptResponse,
  ListReposResponse,
  ListSessionsResponse,
  Session,
  SwitchAccountResponse,
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
