function sleep(ms, signal) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
}
export class ClaudeAccounts {
    opts;
    fetchImpl;
    /**
     * Per SDK session, the cumulative usage its last result carried. In a
     * long-lived (streaming-input) session every result holds the running total
     * so far, so only the difference is new.
     */
    seen = new Map();
    constructor(opts) {
        this.opts = opts;
        this.fetchImpl = opts.fetch ?? fetch;
    }
    /** Whether a service URL is configured at all. */
    get enabled() {
        return Boolean(this.opts.url && this.opts.token);
    }
    /** Which account to run as now — or, when none can, when to ask again. */
    async pick(request = {}) {
        try {
            const body = { app: this.opts.app, ...request, ...(this.opts.accounts ? { accounts: this.opts.accounts } : {}) };
            const res = await this.call("POST", "/v1/pick", body);
            return { ...res, offline: false };
        }
        catch (err) {
            const exclude = new Set((request.exclude ?? []).map((e) => e.toLowerCase()));
            const local = [request.current, ...(this.opts.accounts ?? [])].find((e) => !!e && !exclude.has(e.toLowerCase()));
            return {
                email: local ?? null,
                reason: `Account service unavailable (${err instanceof Error ? err.message : String(err)}); using ${local ?? "the default login"}.`,
                retryAt: null,
                offline: true,
            };
        }
    }
    /** Pass on what Claude said about an account. Never throws; a lost report only means a staler picture. */
    async report(email, info) {
        const body = {
            app: this.opts.app,
            email,
            status: info.status,
            type: info.rateLimitType ?? null,
            // The SDK sends seconds; anything already in ms (≥ year 33658 in s) is left alone.
            resetsAt: info.resetsAt == null ? null : info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt,
            utilization: info.utilization ?? null,
        };
        await this.call("POST", "/v1/report", body).catch(() => { });
    }
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
    async claudeEnv(request = {}) {
        try {
            const body = {
                app: this.opts.app,
                ...request,
                credentials: "token",
                ...(this.opts.accounts ? { accounts: this.opts.accounts } : {}),
            };
            const res = await this.call("POST", "/v1/pick", body);
            if (res.email && res.credential?.token) {
                return {
                    email: res.email,
                    // Don't also set ANTHROPIC_API_KEY for the run: an API key wins over this token.
                    env: { CLAUDE_CODE_OAUTH_TOKEN: res.credential.token },
                    expiresAt: res.credential.expiresAt,
                    reason: res.reason,
                    retryAt: null,
                };
            }
            return { email: null, env: null, expiresAt: null, reason: res.reason, retryAt: res.retryAt };
        }
        catch (err) {
            return {
                email: null,
                env: null,
                expiresAt: null,
                reason: `Account service unavailable (${err instanceof Error ? err.message : String(err)}).`,
                retryAt: Date.now() + 60_000,
            };
        }
    }
    /**
     * claudeEnv(), waiting while every account is limited: sleeps until the
     * soonest reset the service names and asks again, up to `maxWaitMs`
     * (default 6 h). Returns the last answer if it gives up or `signal` aborts.
     */
    async waitForClaude(request = {}) {
        const { maxWaitMs = 6 * 3_600_000, signal, ...pick } = request;
        const deadline = Date.now() + maxWaitMs;
        for (;;) {
            const got = await this.claudeEnv(pick);
            if (got.email || !got.retryAt || got.retryAt > deadline || signal?.aborted)
                return got;
            await sleep(Math.max(1_000, got.retryAt - Date.now()), signal);
            if (signal?.aborted)
                return got;
        }
    }
    /**
     * Feed any Agent SDK message through here: rate_limit_events get reported,
     * and a run's final result message is reported as usage stats (tokens and
     * cost per model); everything else is ignored. Returns the info when Claude
     * refused the request, so the caller can pause or switch.
     */
    observe(email, message) {
        const run = runUsage(message);
        if (run) {
            const fresh = this.newUsage(run);
            if (fresh)
                void this.reportRun({ ...fresh, email });
            return null;
        }
        const info = rateLimitInfo(message);
        if (!info)
            return null;
        if (email)
            void this.report(email, info);
        return info.status === "rejected" ? info : null;
    }
    /** What a finished run used, for the service's usage stats. Never throws. */
    async reportRun(run) {
        await this.call("POST", "/v1/runs", { app: this.opts.app, ...run }).catch(() => { });
    }
    /** The part of a result's usage not reported yet (all of it, for a one-shot run). Null when nothing is new. */
    newUsage(run) {
        const before = run.sessionId ? this.seen.get(run.sessionId) : undefined;
        if (run.sessionId) {
            this.seen.set(run.sessionId, { models: new Map(run.models.map((m) => [m.model, m])), turns: run.turns, at: Date.now() });
            // Long-lived apps open many sessions; forget ones quiet for a day.
            if (this.seen.size > 200)
                for (const [k, v] of this.seen)
                    if (Date.now() - v.at > 86_400_000)
                        this.seen.delete(k);
        }
        const models = run.models
            .map((m) => {
            const prev = before?.models.get(m.model);
            // A total lower than before means the session restarted its count (e.g. /clear): it's all new.
            if (!prev || m.costUsd < prev.costUsd || m.input < prev.input)
                return m;
            return {
                model: m.model,
                input: m.input - prev.input,
                output: m.output - prev.output,
                cacheRead: m.cacheRead - prev.cacheRead,
                cacheWrite: m.cacheWrite - prev.cacheWrite,
                costUsd: Math.max(0, m.costUsd - prev.costUsd),
                webSearches: Math.max(0, m.webSearches - prev.webSearches),
            };
        })
            .filter((m) => m.input + m.output + m.cacheRead + m.cacheWrite > 0 || m.costUsd > 0);
        if (models.length === 0)
            return null;
        return { ok: run.ok, subtype: run.subtype, durationMs: run.durationMs, turns: Math.max(0, run.turns - (before && run.turns >= before.turns ? before.turns : 0)), models };
    }
    async accounts() {
        return this.call("GET", "/v1/accounts");
    }
    /** The organizations a claude.ai session key can see, with usage — to choose one before adding it. Stores nothing. */
    async listOrgs(sessionKey) {
        return this.call("POST", "/v1/usage-keys/orgs", { sessionKey }, 30_000);
    }
    /** Start tracking an account's usage with a claude.ai session key. Errors carry the service's reason. */
    async addUsageKey(sessionKey, orgId) {
        return this.call("POST", "/v1/usage-keys", { sessionKey, ...(orgId ? { orgId } : {}) }, 30_000);
    }
    async removeUsageKey(email) {
        return this.call("DELETE", `/v1/usage-keys/${encodeURIComponent(email)}`).then(() => true, () => false);
    }
    async call(method, path, body, timeoutMs) {
        if (!this.enabled)
            throw new Error("not configured");
        const res = await this.fetchImpl(`${this.opts.url.replace(/\/$/, "")}${path}`, {
            method,
            headers: { authorization: `Bearer ${this.opts.token}`, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 5_000),
        });
        if (!res.ok) {
            // The service explains a refusal ("claude.ai rejected that session key."); pass that on.
            const reason = await res
                .json()
                .then((b) => b?.error)
                .catch(() => null);
            throw new Error(reason ?? `${path} → ${res.status}`);
        }
        return (await res.json());
    }
}
/** The usage in an SDK `result` message (its per-model totals), or null for any other message. */
export function runUsage(message) {
    const m = message;
    if (m?.type !== "result" || !m.modelUsage)
        return null;
    const models = Object.entries(m.modelUsage).map(([model, u]) => ({
        model,
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadInputTokens ?? 0,
        cacheWrite: u.cacheCreationInputTokens ?? 0,
        costUsd: u.costUSD ?? 0,
        webSearches: u.webSearchRequests ?? 0,
    }));
    if (models.length === 0)
        return null;
    return {
        sessionId: m.session_id ?? null,
        ok: !m.is_error && (m.subtype ?? "success") === "success",
        subtype: m.subtype ?? "success",
        durationMs: m.duration_ms ?? 0,
        turns: m.num_turns ?? 0,
        models,
    };
}
/** The rate_limit_info of an SDK `rate_limit_event`, or null for any other message. */
export function rateLimitInfo(message) {
    const m = message;
    if (m?.type !== "rate_limit_event" || !m.rate_limit_info?.status)
        return null;
    return m.rate_limit_info;
}
/**
 * Accounts and how an app runs as each, from one env var:
 *   CLAUDE_ACCOUNTS="a@x.fi=/root/.claude-a, b@y.org=/root/.claude-b"
 * Each value is a CLAUDE_CONFIG_DIR holding that account's login. A bare email
 * (no "=") means "the default login is this account".
 */
export function parseAccountDirs(spec) {
    const out = new Map();
    for (const part of (spec ?? "").split(/[,;\n]/)) {
        const [email, dir] = part.split("=").map((s) => s.trim());
        if (email)
            out.set(email.toLowerCase(), dir || null);
    }
    return out;
}
export function createClaudeAccounts(opts) {
    return new ClaudeAccounts(opts);
}
