import { existsSync, readFileSync } from "node:fs";
import type { AccountUsage } from "@crc/protocol";
import { logger } from "../logger.js";

/**
 * Reads per-account usage % straight from claude.ai's usage endpoint — the only
 * source of true 5h/7d limit percentages (the OAuth/setup-token used for coding
 * can't provide them). Uses a SEPARATE, read-only claude.ai session key per
 * account (`sk-ant-sid01-…`, the same credential the macOS Claude-Usage-Tracker
 * uses), which the user drops into a gitignored JSON config. This never touches
 * the coding setup-tokens, and it only ever reads usage — never runs inference.
 *
 * Endpoint (reverse-engineered, may change):
 *   GET https://claude.ai/api/organizations/{orgId}/usage
 *   Cookie: sessionKey=…
 *   → { five_hour:{utilization_pct,reset_at}, seven_day:{utilization_pct,reset_at} }
 */
type UsageEntry = { email: string; sessionKey: string; orgId: string };

const CACHE_MS = 25_000;

export class UsageReader {
  private entries: UsageEntry[] = [];
  private readonly cache = new Map<string, { usage: AccountUsage | null; at: number }>();

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

  private load(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
      if (Array.isArray(raw)) {
        this.entries = raw
          .filter((e) => e?.email && e?.sessionKey && e?.orgId)
          .map((e) => ({ email: String(e.email), sessionKey: String(e.sessionKey), orgId: String(e.orgId) }));
        logger.info("usage reader configured", { accounts: this.entries.length });
      }
    } catch (err) {
      logger.warn("could not read usage config", { path: this.configPath, err: String(err) });
    }
  }

  /** Usage keyed by email. Missing/failed accounts are simply absent (fail-safe). */
  async usageByEmail(): Promise<Map<string, AccountUsage>> {
    const out = new Map<string, AccountUsage>();
    await Promise.all(
      this.entries.map(async (entry) => {
        const usage = await this.fetchCached(entry);
        if (usage) out.set(entry.email.toLowerCase(), usage);
      }),
    );
    return out;
  }

  private async fetchCached(entry: UsageEntry): Promise<AccountUsage | null> {
    const cached = this.cache.get(entry.email);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.usage;
    const usage = await this.fetchOne(entry).catch((err) => {
      logger.warn("usage fetch failed; keeping last known", { email: entry.email, err: String(err) });
      return cached?.usage ?? null; // fail-safe: last-known, else null
    });
    this.cache.set(entry.email, { usage, at: Date.now() });
    return usage;
  }

  private async fetchOne(entry: UsageEntry): Promise<AccountUsage | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/organizations/${encodeURIComponent(entry.orgId)}/usage`, {
        headers: { cookie: `sessionKey=${entry.sessionKey}`, "user-agent": "crc-daemon" },
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn("usage endpoint non-ok", { email: entry.email, status: res.status });
        return null;
      }
      const body = (await res.json()) as any;
      const win = (w: any) => ({ pct: Number(w?.utilization_pct ?? 0), resetsAt: w?.reset_at ?? null });
      if (!body?.five_hour && !body?.seven_day) return null;
      return { fiveHour: win(body.five_hour), sevenDay: win(body.seven_day) };
    } finally {
      clearTimeout(t);
    }
  }
}
