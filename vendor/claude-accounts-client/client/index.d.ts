import type { AccountsResponse, ModelRunUsage, PickRequest, PickResponse, RunReport, UsageOrg } from "../shared/types.js";
export type * from "../shared/types.js";
/**
 * The client every app imports. No dependencies — just fetch — so it can be
 * vendored into any Node 18+ project (scripts/vendor-client.sh).
 *
 * It never gets in the app's way: when the service is down, slow or not
 * configured, `pick` falls back to the app's own choice (`current`, else its
 * first account) and `report` is dropped quietly. An app with the client
 * wired in but no service behaves exactly as it did before.
 */
export type ClaudeAccountsOptions = {
    /** e.g. http://claude-accounts:8080. Without it, every call takes the offline path. */
    url?: string | null;
    token?: string | null;
    /** Shown in reports and on the status page: "shopping-tool". */
    app: string;
    /** The accounts this app can run as. Omit to let the service consider all it knows. */
    accounts?: string[];
    timeoutMs?: number;
    /** For tests. */
    fetch?: typeof fetch;
};
/** What claudeEnv() hands back: the account and its env, or why there's none right now. */
export type ClaudeEnv = {
    email: string;
    env: Record<string, string>;
    expiresAt: number;
    reason: string;
    retryAt: null;
} | {
    email: null;
    env: null;
    expiresAt: null;
    reason: string;
    retryAt: number | null;
};
export type PickResult = PickResponse & {
    /** True when the service couldn't be asked and this is the local fallback. */
    offline: boolean;
};
/** The SDK's rate_limit_info, loosely — only the fields that matter here. */
export type RateLimitInfo = {
    status: "allowed" | "allowed_warning" | "rejected";
    /** Seconds since the epoch, as the SDK sends it. */
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
};
export declare class ClaudeAccounts {
    private readonly opts;
    private readonly fetchImpl;
    /**
     * Per SDK session, the cumulative usage its last result carried. In a
     * long-lived (streaming-input) session every result holds the running total
     * so far, so only the difference is new.
     */
    private readonly seen;
    constructor(opts: ClaudeAccountsOptions);
    /** Whether a service URL is configured at all. */
    get enabled(): boolean;
    /** Which account to run as now — or, when none can, when to ask again. */
    pick(request?: Omit<PickRequest, "app" | "accounts">): Promise<PickResult>;
    /** Pass on what Claude said about an account. Never throws; a lost report only means a staler picture. */
    report(email: string, info: RateLimitInfo): Promise<void>;
    /**
     * For a tool with no Claude login of its own: an account to run as, and the
     * env that makes Claude run as it — spread it over process.env in the Agent
     * SDK's `options.env`. Uses the setup token the service holds for that
     * account (the service only offers accounts it has one for).
     *
     * When nothing can run — every account limited, no token stored, the
     * service unreachable — `email` is null and `reason` says why; `retryAt` is
     * when to ask again, if anyone knows.
     */
    claudeEnv(request?: Omit<PickRequest, "app" | "accounts" | "credentials">): Promise<ClaudeEnv>;
    /**
     * claudeEnv(), waiting while every account is limited: sleeps until the
     * soonest reset the service names and asks again, up to `maxWaitMs`
     * (default 6 h). Returns the last answer if it gives up or `signal` aborts.
     */
    waitForClaude(request?: Omit<PickRequest, "app" | "accounts" | "credentials"> & {
        maxWaitMs?: number;
        signal?: AbortSignal;
    }): Promise<ClaudeEnv>;
    /**
     * Feed any Agent SDK message through here: rate_limit_events get reported,
     * and a run's final result message is reported as usage stats (tokens and
     * cost per model); everything else is ignored. Returns the info when Claude
     * refused the request, so the caller can pause or switch.
     */
    observe(email: string | null, message: unknown): RateLimitInfo | null;
    /** What a finished run used, for the service's usage stats. Never throws. */
    reportRun(run: Omit<RunReport, "app">): Promise<void>;
    /** The part of a result's usage not reported yet (all of it, for a one-shot run). Null when nothing is new. */
    private newUsage;
    accounts(): Promise<AccountsResponse>;
    /** The organizations a claude.ai session key can see, with usage — to choose one before adding it. Stores nothing. */
    listOrgs(sessionKey: string): Promise<{
        email: string | null;
        orgs: UsageOrg[];
    }>;
    /** Start tracking an account's usage with a claude.ai session key. Errors carry the service's reason. */
    addUsageKey(sessionKey: string, orgId?: string | null): Promise<{
        email: string;
    }>;
    removeUsageKey(email: string): Promise<boolean>;
    private call;
}
type ParsedRun = {
    sessionId: string | null;
    ok: boolean;
    subtype: string;
    durationMs: number;
    turns: number;
    models: ModelRunUsage[];
};
/** The usage in an SDK `result` message (its per-model totals), or null for any other message. */
export declare function runUsage(message: unknown): ParsedRun | null;
/** The rate_limit_info of an SDK `rate_limit_event`, or null for any other message. */
export declare function rateLimitInfo(message: unknown): RateLimitInfo | null;
/**
 * Accounts and how an app runs as each, from one env var:
 *   CLAUDE_ACCOUNTS="a@x.fi=/root/.claude-a, b@y.org=/root/.claude-b"
 * Each value is a CLAUDE_CONFIG_DIR holding that account's login. A bare email
 * (no "=") means "the default login is this account".
 */
export declare function parseAccountDirs(spec: string | undefined | null): Map<string, string | null>;
export declare function createClaudeAccounts(opts: ClaudeAccountsOptions): ClaudeAccounts;
