/**
 * The wire format between the service and its clients. Shared by both sides
 * and deliberately plain: every app that talks to the service gets these
 * types from the vendored client, which has no dependencies of its own.
 *
 * Times are epoch milliseconds unless a field says otherwise.
 */
/** One limit window claude.ai reports for an account: the 5-hour session, the weekly cap, a per-model weekly cap. */
export type UsageLimit = {
    /** "session", "weekly_all", "weekly_scoped", or whatever new kind claude.ai adds. */
    kind: string;
    /** For display: "Session usage", "All models", "Fable". */
    label: string;
    /** Set only for a per-model cap ("weekly_scoped"): the model family it applies to. */
    model: string | null;
    /** 0–100. */
    pct: number;
    /** ISO time the window resets, or null before it has started. */
    resetsAt: string | null;
    severity: string;
};
/** Pay-as-you-go overage, when the plan has it. */
export type UsageExtra = {
    pct: number;
    usedDollars: number;
    limitDollars: number;
    currency: string;
};
export type AccountUsage = {
    limits: UsageLimit[];
    extra: UsageExtra | null;
    /** When claude.ai was last read successfully. */
    fetchedAt: number;
};
/** What an app last heard from Claude about an account, through the SDK's rate_limit_event. */
export type LimitReport = {
    app: string;
    at: number;
    status: "allowed" | "allowed_warning" | "rejected";
    /** The SDK's rateLimitType: "five_hour", "seven_day", "seven_day_opus", … */
    type: string | null;
    resetsAt: number | null;
    /** 0–1 as the SDK reports it, when it does. */
    utilization: number | null;
};
export type AccountView = {
    email: string;
    /** Whether the service holds a claude.ai usage key for this account. */
    usageTracked: boolean;
    usage: AccountUsage | null;
    /** Why usage is missing or stale, in words a person can act on. */
    usageError: string | null;
    /**
     * Until when the account can't take work, from either a rejection an app
     * reported or a limit claude.ai shows at 100%. Null when it's free.
     */
    blockedUntil: number | null;
    /** Which limit blocks it, in words: "the 5-hour limit". */
    blockedBy: string | null;
    lastReport: LimitReport | null;
    /** Which apps picked this account most recently, and when. */
    recentApps: {
        app: string;
        at: number;
    }[];
    /** When the account's stored setup token expires; null when the service holds none. */
    tokenExpiresAt: number | null;
};
export type AccountsResponse = {
    accounts: AccountView[];
    now: number;
};
export type PickRequest = {
    /** Who's asking — "shopping-tool", "talkoot". */
    app: string;
    /**
     * The accounts this app can actually run as (it has a login or token for
     * them). Omit to consider every account the service knows.
     */
    accounts?: string[];
    /** The account the app is on now. Kept while it's healthy, so runs don't flip-flop. */
    current?: string | null;
    /** Never pick these — e.g. the account a run was just rejected on. */
    exclude?: string[];
    /** Run as this account whenever it has room. */
    prefer?: string | null;
    /** The model the run will use; per-model weekly caps only block their own model. */
    model?: string | null;
    /**
     * "token": the app has no Claude login of its own and runs on the setup
     * token the service holds for the account. Only accounts with a stored
     * token are considered, and the token comes back in `credential`.
     */
    credentials?: "token";
};
export type PickResponse = {
    /** The account to run as, or null when none can take work right now. */
    email: string | null;
    /** A sentence for logs and UIs: why this account, or why waiting. */
    reason: string;
    /** With no account free: when to ask again (already includes a safety buffer). Null if unknown. */
    retryAt: number | null;
    /** With `credentials: "token"`: what to run as — pass `token` to Claude as CLAUDE_CODE_OAUTH_TOKEN. */
    credential?: {
        kind: "oauth_token";
        token: string;
        expiresAt: number;
    } | null;
};
export type UsageOrg = {
    orgId: string;
    name: string;
    usage: AccountUsage | null;
};
export type ReportRequest = {
    app: string;
    email: string;
    status: LimitReport["status"];
    type?: string | null;
    /** Epoch ms. The SDK reports seconds; the client converts. */
    resetsAt?: number | null;
    utilization?: number | null;
};
/** One model's share of a run: tokens and Claude Code's own cost estimate (API prices, not a bill). */
export type ModelRunUsage = {
    /** As Claude Code names it: "claude-opus-5-5", "claude-haiku-4-5-20251001". */
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** API-equivalent USD; on a subscription it's a measure of size, not a charge. */
    costUsd: number;
    webSearches: number;
};
/** What a finished Claude run used, reported by the client from the SDK's result message. */
export type RunReport = {
    app: string;
    /** The account it ran as; null when the app ran on a default login the service doesn't know. */
    email: string | null;
    ok: boolean;
    /** The SDK's result subtype: "success", "error_max_turns", … */
    subtype: string;
    durationMs: number;
    turns: number;
    models: ModelRunUsage[];
};
export type StoredRun = RunReport & {
    at: number;
};
/** A slice of the usage numbers, summed. */
export type UsageTotals = {
    runs: number;
    failed: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    durationMs: number;
};
/** The GET /v1/stats response. */
export type StatsResponse = {
    from: number;
    to: number;
    days: number;
    totals: UsageTotals;
    byApp: (UsageTotals & {
        app: string;
    })[];
    byAccount: (UsageTotals & {
        email: string;
    })[];
    byModel: (UsageTotals & {
        model: string;
    })[];
    /** Per day (in the service's time zone), cost per app. */
    byDay: {
        day: string;
        byApp: Record<string, number>;
        costUsd: number;
        runs: number;
    }[];
    /** Usage % over time per account, from the service's own claude.ai readings. */
    usage: {
        email: string;
        points: {
            at: number;
            session: number | null;
            weekly: number | null;
        }[];
    }[];
    /** Rejections and warnings apps reported. */
    limitHits: {
        at: number;
        app: string;
        email: string;
        status: string;
        type: string | null;
    }[];
};
