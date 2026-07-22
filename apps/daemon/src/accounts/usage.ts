import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Impit } from "impit";
import type { AccountUsage, AccountUsageExtra, UsageOrg } from "@crc/protocol";
import { logger } from "../logger.js";

/**
 * Reads per-account usage % straight from claude.ai's usage endpoint — the only
 * source of true 5h/7d limit percentages (the OAuth/setup-token used for coding
 * can't provide them). Uses a SEPARATE, read-only claude.ai session key per
 * account (`sk-ant-sid01-…`, the same credential the macOS Claude-Usage-Tracker
 * uses), which the user connects from any client. This never touches the coding
 * setup-tokens, and it only ever reads usage — never runs inference.
 *
 * Keys can be ADDED at runtime (`addKey`) — the web paste field, the phone
 * WebView login, and the Mac Playwright login all funnel a raw session key here.
 * We validate it against claude.ai, auto-resolve the org id and (best effort)
 * the account email, then persist to the gitignored JSON so it survives a
 * restart. The `orgId`/`email` fields are optional in the file — a bare
 * `{ "sessionKey": "…" }` is enough; we fill the rest in on first use.
 *
 * Endpoints (reverse-engineered, may change):
 *   GET /api/organizations                         → [{ uuid, name, … }]
 *   GET /api/organizations/{orgId}/usage           → { five_hour, seven_day }
 *   GET /api/bootstrap | /api/account              → account.email_address
 */
type UsageEntry = { email: string | null; sessionKey: string; orgId: string | null };

const CACHE_MS = 25_000;
const HTTP_TIMEOUT_MS = 15_000;

export type ResolvedIdentity = { email: string | null; orgId: string; usage: AccountUsage };

/** Carries the HTTP status so callers can distinguish "bad key" (401/403) from faults. */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class UsageReader {
  private entries: UsageEntry[] = [];
  private readonly cache = new Map<string, { usage: AccountUsage | null; at: number }>();
  // Impersonates a real browser's TLS/HTTP2 fingerprint. claude.ai's API is
  // fronted by Cloudflare bot management, which 403s a plain server-side fetch
  // (non-browser fingerprint) regardless of headers — this is what lets a bare
  // sessionKey work, the same way native macOS usage trackers get through.
  private readonly http = new Impit({ browser: "chrome", timeout: HTTP_TIMEOUT_MS });

  constructor(
    private readonly configPath: string,
    private readonly baseUrl: string = "https://claude.ai",
  ) {
    this.load();
  }

  /** True when at least one account has a session key configured. */
  get configured(): boolean {
    return this.entries.length > 0;
  }

  /** Emails (lowercased) we currently hold a usage key for. */
  connectedEmails(): string[] {
    return this.entries.map((e) => e.email?.toLowerCase()).filter((e): e is string => Boolean(e));
  }

  private load(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
      if (Array.isArray(raw)) {
        this.entries = raw
          .filter((e) => e?.sessionKey)
          .map((e) => ({
            email: e.email ? String(e.email) : null,
            sessionKey: String(e.sessionKey),
            orgId: e.orgId ? String(e.orgId) : null,
          }));
        logger.info("usage reader configured", { accounts: this.entries.length });
      }
    } catch (err) {
      logger.warn("could not read usage config", { path: this.configPath, err: String(err) });
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      logger.warn("could not write usage config", { path: this.configPath, err: String(err) });
    }
  }

  /**
   * Persist a session key against a USER-CHOSEN org (no auto-selection). The
   * caller lists orgs first (`listOrgs`) and passes the picked `orgId`; we read
   * that org's usage back, resolve the email (best effort, else `emailHint`),
   * upsert (by email, else by key), and persist. Returns the resolved identity.
   */
  async addKey(sessionKey: string, orgId: string, emailHint?: string): Promise<ResolvedIdentity> {
    const key = sessionKey.trim();
    // claude.ai versions the prefix (sk-ant-sid01-, sk-ant-sid02-, …); match the
    // family so a bumped version doesn't reject otherwise-valid keys.
    if (!key.startsWith("sk-ant-sid")) {
      throw new Error("that doesn't look like a claude.ai sessionKey (expected sk-ant-sid…)");
    }
    const usage = await this.fetchUsage(key, orgId);
    if (!usage) throw new Error("that organization returned no usage for this key");
    const email = (await this.fetchEmail(key)) ?? emailHint?.toLowerCase() ?? null;

    // Upsert: replace an existing entry for the same email (case-insensitive),
    // otherwise append. Keys with no resolvable email are matched by key value.
    const idx = this.entries.findIndex((e) =>
      email && e.email ? e.email.toLowerCase() === email.toLowerCase() : e.sessionKey === key,
    );
    const entry: UsageEntry = { email, sessionKey: key, orgId };
    if (idx >= 0) this.entries[idx] = entry;
    else this.entries.push(entry);
    this.persist();

    // Seed the cache so the next /accounts poll shows usage immediately.
    if (email) this.cache.set(email, { usage, at: Date.now() });
    logger.info("usage key connected", { email: email ?? "(unknown)", orgId, accounts: this.entries.length });
    return { email, orgId, usage };
  }

  /** Remove a connected usage key by email (case-insensitive). Returns whether one was found. */
  removeKey(email: string): boolean {
    const target = email.trim().toLowerCase();
    const idx = this.entries.findIndex((e) => e.email?.toLowerCase() === target);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this.cache.delete(target);
    this.persist();
    logger.info("usage key disconnected", { email: target, accounts: this.entries.length });
    return true;
  }

  /**
   * List every org this key can see, each with its current usage, for the user
   * to pick from. Does NOT persist — selection happens via `addKey(orgId)`.
   */
  async listOrgs(sessionKey: string): Promise<{ email: string | null; orgs: UsageOrg[] }> {
    const key = sessionKey.trim();
    if (!key.startsWith("sk-ant-sid")) {
      throw new Error("that doesn't look like a claude.ai sessionKey (expected sk-ant-sid…)");
    }
    const raw = await this.getJson<Array<{ uuid?: string; name?: string }>>(key, "/api/organizations").catch(
      (err: unknown) => {
        // 401/403 = the cookie itself was rejected; anything else is a real fault.
        const status = err instanceof HttpError ? err.status : 0;
        if (status === 401 || status === 403) throw new Error("session key rejected by claude.ai (expired or invalid?)");
        throw err;
      },
    );
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("session key rejected by claude.ai (expired or invalid?)");
    }
    const orgs: UsageOrg[] = [];
    for (const org of raw) {
      if (!org?.uuid) continue;
      const usage = await this.fetchUsage(key, org.uuid).catch(() => null);
      orgs.push({ orgId: org.uuid, name: org.name ?? org.uuid, usage });
    }
    const email = (await this.fetchEmail(key)) ?? null;
    return { email, orgs };
  }

  /** Usage keyed by email. Missing/failed accounts are simply absent (fail-safe). */
  async usageByEmail(): Promise<Map<string, AccountUsage>> {
    const out = new Map<string, AccountUsage>();
    await Promise.all(
      this.entries.map(async (entry) => {
        const usage = await this.fetchCached(entry);
        if (usage && entry.email) out.set(entry.email.toLowerCase(), usage);
      }),
    );
    return out;
  }

  private async fetchCached(entry: UsageEntry): Promise<AccountUsage | null> {
    const cacheKey = entry.email ?? entry.sessionKey;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.usage;
    const usage = await this.fetchEntry(entry).catch((err) => {
      logger.warn("usage fetch failed; keeping last known", { email: entry.email, err: String(err) });
      return cached?.usage ?? null; // fail-safe: last-known, else null
    });
    this.cache.set(cacheKey, { usage, at: Date.now() });
    return usage;
  }

  /** Fetch usage for an entry. Entries with no chosen org read as unavailable. */
  private async fetchEntry(entry: UsageEntry): Promise<AccountUsage | null> {
    if (!entry.orgId) return null; // org not picked yet — connect via the UI to choose one
    return this.fetchUsage(entry.sessionKey, entry.orgId);
  }

  private async fetchUsage(sessionKey: string, orgId: string): Promise<AccountUsage | null> {
    const body = await this.getJson<any>(sessionKey, `/api/organizations/${encodeURIComponent(orgId)}/usage`);
    // Current claude.ai shape: a `limits` array with an explicit percent (0–100)
    // and resets_at per window ("session" = 5-hour, "weekly" = 7-day). Fall back
    // to the older five_hour/seven_day.utilization fraction if `limits` is absent.
    const fromLimit = (group: string) => {
      const l = Array.isArray(body?.limits) ? body.limits.find((x: any) => x?.group === group) : undefined;
      return l ? { pct: Number(l.percent ?? 0), resetsAt: l.resets_at ?? null } : null;
    };
    // `utilization` is already a 0–100 percentage (not a 0–1 fraction).
    const fromWindow = (w: any) =>
      w ? { pct: Number(w.utilization ?? 0), resetsAt: w.resets_at ?? w.reset_at ?? null } : null;
    const fiveHour = fromLimit("session") ?? fromWindow(body?.five_hour);
    const sevenDay = fromLimit("weekly") ?? fromWindow(body?.seven_day);
    if (!fiveHour && !sevenDay) return null;
    return {
      fiveHour: fiveHour ?? { pct: 0, resetsAt: null },
      sevenDay: sevenDay ?? { pct: 0, resetsAt: null },
      extra: this.parseExtra(body),
    };
  }

  /**
   * Pay-as-you-go overage, once a plan has it enabled. `spend` is the newer,
   * more explicit shape (amount_minor/exponent + an `enabled` flag); older
   * responses only carry `extra_usage` (used_credits/monthly_limit scaled by
   * decimal_places). Both are undocumented/reverse-engineered, so either can
   * disappear — absence of both just means "no overage to show".
   */
  private parseExtra(body: any): AccountUsageExtra | null {
    const toDollars = (minor: unknown, exponent: unknown) => Number(minor ?? 0) / 10 ** Number(exponent ?? 2);
    const spend = body?.spend;
    if (spend?.enabled && typeof spend.percent === "number") {
      return {
        pct: Number(spend.percent),
        usedDollars: toDollars(spend.used?.amount_minor, spend.used?.exponent),
        limitDollars: spend.limit ? toDollars(spend.limit.amount_minor, spend.limit.exponent) : 0,
        currency: spend.used?.currency ?? spend.limit?.currency ?? "USD",
      };
    }
    const extraUsage = body?.extra_usage;
    if (extraUsage?.is_enabled && typeof extraUsage.utilization === "number") {
      const scale = 10 ** Number(extraUsage.decimal_places ?? 2);
      return {
        pct: Number(extraUsage.utilization),
        usedDollars: Number(extraUsage.used_credits ?? 0) / scale,
        limitDollars: Number(extraUsage.monthly_limit ?? 0) / scale,
        currency: extraUsage.currency ?? "USD",
      };
    }
    return null;
  }

  /** Best-effort account email. Never throws — a null just means "unknown". */
  private async fetchEmail(sessionKey: string): Promise<string | null> {
    for (const path of ["/api/bootstrap", "/api/account"]) {
      try {
        const body = await this.getJson<any>(sessionKey, path);
        const email =
          body?.account?.email_address ?? body?.account?.email ?? body?.email_address ?? body?.email ?? null;
        if (email) return String(email).toLowerCase();
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  private async getJson<T>(sessionKey: string, path: string): Promise<T> {
    // Browser-like Referer/Origin alongside the impersonated fingerprint; the
    // per-request timeout comes from the Impit instance config above.
    const res = await this.http.fetch(`${this.baseUrl}${path}`, {
      headers: {
        cookie: `sessionKey=${sessionKey}`,
        accept: "application/json",
        referer: `${this.baseUrl}/`,
        origin: this.baseUrl,
      },
    });
    if (!res.ok) throw new HttpError(res.status, `${path} → ${res.status}`);
    return (await res.json()) as T;
  }
}
