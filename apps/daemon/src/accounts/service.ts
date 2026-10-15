import type { AccountUsage, AccountUsageLimit, UsageOrg } from "@renki/protocol";
import {
  type AccountView,
  type ClaudeAccounts,
  type UsageLimit,
  createClaudeAccounts,
} from "claude-accounts-client";
import { logger } from "../logger.js";
import type { RateLimitHit } from "../claude/runner.js";
import type { ResolvedIdentity, UsageSource } from "./usage.js";

/**
 * Usage from the homelab's shared claude-accounts service instead of Renki's
 * own claude.ai polling (github.com/Zawaer/claude-accounts).
 *
 * The service reads every account's usage once for all the apps, and also
 * knows what the other apps were refused: when talkoot or the shopping tool
 * hits a limit on an account, Renki sees that account as blocked before its
 * own next turn runs into the same wall. And every limit Renki hits goes back
 * to the service the same way.
 *
 * It plugs in where the local UsageReader did, so the rotator, the resume
 * planner and the Settings page work unchanged; the usage-key screens add and
 * remove keys on the service. cswap still does the switching.
 */
const CACHE_MS = 15_000;

export class ServiceUsage implements UsageSource {
  private readonly client: ClaudeAccounts;
  private views: AccountView[] = [];
  private fetchedAt = 0;
  private lastError: string | null = null;

  constructor(url: string, token: string, client?: ClaudeAccounts) {
    this.client = client ?? createClaudeAccounts({ url, token, app: "renki" });
  }

  /**
   * Always true: the service is where usage comes from, even before the first
   * read. (Gating on what it tracks would never read it at all, since the
   * rotator only asks for usage when this is true.) Accounts it has no key for
   * show as not connected, through connectedEmails().
   */
  get configured(): boolean {
    return true;
  }

  connectedEmails(): string[] {
    return this.views.filter((v) => v.usageTracked).map((v) => v.email);
  }

  errorFor(email: string): string | null {
    if (this.lastError) return this.lastError;
    return this.views.find((v) => v.email === email.toLowerCase())?.usageError ?? null;
  }

  async usageByEmail(): Promise<Map<string, AccountUsage>> {
    await this.refresh();
    const out = new Map<string, AccountUsage>();
    for (const v of this.views) {
      const usage = toAccountUsage(v);
      if (usage) out.set(v.email, usage);
    }
    return out;
  }

  /** Read the service at most every CACHE_MS; on failure keep the last view and say why. */
  private async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.fetchedAt < CACHE_MS) return;
    try {
      this.views = (await this.client.accounts()).accounts;
      this.lastError = null;
    } catch (err) {
      logger.warn("account service unreachable; keeping the last usage", { err: String(err) });
      this.lastError = "The account service didn't answer; showing the last reading.";
    }
    this.fetchedAt = Date.now();
  }

  async addKey(sessionKey: string, orgId: string): Promise<ResolvedIdentity> {
    const { email } = await this.client.addUsageKey(sessionKey, orgId);
    await this.refresh(true);
    const view = this.views.find((v) => v.email === email);
    const usage = view ? toAccountUsage(view) : null;
    if (!usage) throw new Error("that organization returned no usage for this key");
    return { email, orgId, usage };
  }

  async removeKey(email: string): Promise<boolean> {
    const ok = await this.client.removeUsageKey(email);
    await this.refresh(true);
    return ok;
  }

  async listOrgs(sessionKey: string): Promise<{ email: string | null; orgs: UsageOrg[] }> {
    const { email, orgs } = await this.client.listOrgs(sessionKey);
    return {
      email,
      orgs: orgs.map((o) => ({ orgId: o.orgId, name: o.name, usage: o.usage ? fromLimits(o.usage.limits, o.usage.extra) : null })),
    };
  }

  /** A turn on `email` was refused: tell the service, so every app stops picking it until the reset. */
  reportLimit(email: string, hit: RateLimitHit | null): void {
    void this.client.report(email, { status: "rejected", resetsAt: hit?.resetsAt ?? undefined, rateLimitType: hit?.type ?? undefined });
    this.fetchedAt = 0; // pick the block up on the next read
  }
}

function fromLimits(limits: UsageLimit[], extra: { pct: number; usedDollars: number; limitDollars: number; currency: string } | null): AccountUsage {
  const mapped: AccountUsageLimit[] = limits.map((l) => ({ ...l, isActive: l.kind === "session" }));
  const window = (kind: string) => {
    const l = limits.find((x) => x.kind === kind);
    return { pct: l?.pct ?? 0, resetsAt: l?.resetsAt ?? null };
  };
  return {
    fiveHour: window("session"),
    sevenDay: window("weekly_all"),
    limits: mapped,
    extra: extra ? { ...extra, severity: "normal" } : null,
  };
}

/**
 * An account's usage as Renki models it, with what other apps reported folded
 * in: a block from a rejection shows as that window at 100% until the reset,
 * which is exactly what makes the rotator skip it and the resume planner wait
 * for it. An account the service only knows from reports (no usage key) still
 * gets that block.
 */
export function toAccountUsage(view: AccountView, now = Date.now()): AccountUsage | null {
  const base = view.usage ? fromLimits(view.usage.limits, view.usage.extra) : null;
  const blocked = view.blockedBy != null && (view.blockedUntil == null || view.blockedUntil > now);
  if (!blocked) return base;

  const usage = base ?? { fiveHour: { pct: 0, resetsAt: null }, sevenDay: { pct: 0, resetsAt: null }, limits: [], extra: null };
  const resetsAt = view.blockedUntil ? new Date(view.blockedUntil).toISOString() : null;
  const alreadyFull = usage.limits.some((l) => l.pct >= 100);
  if (alreadyFull) return usage;
  const session = /5-hour/.test(view.blockedBy ?? "");
  const full = { pct: 100, resetsAt };
  return {
    ...usage,
    fiveHour: session ? full : usage.fiveHour,
    sevenDay: session ? usage.sevenDay : full,
    limits: [
      ...usage.limits,
      { kind: "reported", label: `Reported: ${view.blockedBy}`, model: null, pct: 100, resetsAt, severity: "critical", isActive: true },
    ],
  };
}
