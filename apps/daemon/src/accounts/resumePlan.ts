import type { Account, AccountUsageLimit } from "@renki/protocol";
import type { RateLimitHit } from "../claude/runner.js";

/**
 * When to come back to a turn that stopped on a usage limit, and why.
 *
 * Pure so the timing rules can be tested without cswap or the usage API: the
 * rotator feeds it the accounts it already merges for the Settings page, plus
 * whatever the CLI itself said about the rejection.
 */
export type ResumePlan = {
  /** Epoch ms to try again. */
  at: number;
  /** A sentence for the transcript and the paused banner. */
  reason: string;
};

/** What the rotator says when a scheduled resume comes due. */
export type ResumeReadiness =
  | { proceed: true; /** e.g. "Switched to you@example.com." — shown before the turn restarts. */ note?: string }
  | { proceed: false; plan: ResumePlan };

/**
 * Reset times are the server's, and a request sent the second a window rolls
 * over can still be refused. A minute later is imperceptible next to the wait
 * itself, and saves a wasted attempt.
 */
export const RESET_BUFFER_MS = 60_000;

/** Never schedule sooner than this, so a stale "resets now" can't spin. */
export const MIN_WAIT_MS = 30_000;

/** Retry spacing when nothing says when the limit resets: 15 min, doubling, capped at 2 h. */
export function backoffMs(attempt: number): number {
  return Math.min(15 * 60_000 * 2 ** attempt, 2 * 60 * 60_000);
}

/** The model family a scoped weekly limit would be named after — "default" runs Sonnet. */
function modelFamily(model: string | null): string {
  const m = (model ?? "").toLowerCase();
  return m === "" || m === "default" ? "sonnet" : m;
}

/** Every limit an account reports, synthesising the two legacy windows for older usage responses. */
function limitsOf(account: Account): AccountUsageLimit[] {
  const usage = account.usage;
  if (!usage) return [];
  if (usage.limits.length > 0) return usage.limits;
  return [
    { kind: "session", label: "Session usage", model: null, pct: usage.fiveHour.pct, resetsAt: usage.fiveHour.resetsAt, severity: "normal", isActive: true },
    { kind: "weekly_all", label: "All models", model: null, pct: usage.sevenDay.pct, resetsAt: usage.sevenDay.resetsAt, severity: "normal", isActive: false },
  ];
}

/** A per-model weekly cap only blocks the model it's for; everything else blocks every model. */
function appliesTo(limit: AccountUsageLimit, model: string | null): boolean {
  if (limit.kind !== "weekly_scoped" || !limit.model) return true;
  return modelFamily(model).includes(limit.model.toLowerCase());
}

function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "the 5-hour limit", "the weekly limit", "the Fable weekly limit". */
function limitName(limit: AccountUsageLimit): string {
  if (limit.kind === "session") return "the 5-hour limit";
  if (limit.kind === "weekly_all") return "the weekly limit";
  if (limit.kind === "weekly_scoped") return `the ${limit.model ?? limit.label} weekly limit`;
  return `the ${limit.label} limit`;
}

/** Same vocabulary for the CLI's own `rateLimitType`. */
function hitName(type: string | null): string {
  switch (type) {
    case "five_hour":
      return "the 5-hour limit";
    case "seven_day":
      return "the weekly limit";
    case "seven_day_opus":
      return "the Opus weekly limit";
    case "seven_day_sonnet":
      return "the Sonnet weekly limit";
    case "overage":
      return "the extra-usage limit";
    default:
      return "the usage limit";
  }
}

/**
 * When this account can next run `model`, as far as its usage says.
 *
 *   - `now` — nothing it reports is exhausted.
 *   - a later time — the latest reset among the exhausted limits, since every
 *     one of them has to clear.
 *   - `Infinity` — exhausted, but with no reset time to wait for.
 *   - `null` — no usage to judge by.
 *
 * A limit whose reset time has already passed doesn't count however full the
 * cached numbers say it is: the usage reader caches, and at the moment a
 * resume comes due the cache is exactly the thing that's out of date.
 */
export function accountFreeAt(account: Account, model: string | null, now: number): { at: number; name: string } | null {
  if (account.usageStatus !== "ok" || !account.usage) return null;
  let at = now;
  let name = "the usage limit";
  for (const limit of limitsOf(account)) {
    if (limit.pct < 100 || !appliesTo(limit, model)) continue;
    const resetsAt = parseTime(limit.resetsAt);
    if (resetsAt !== null && resetsAt <= now) continue;
    const blockedUntil = resetsAt ?? Infinity;
    if (blockedUntil > at) {
      at = blockedUntil;
      name = limitName(limit);
    }
  }
  return { at, name };
}

export type PlanInput = {
  /** Every account cswap knows, with usage merged in. Empty when cswap isn't available. */
  accounts: Account[];
  /** With rotation off, Renki never changes account, so only the active one's reset matters. */
  rotationEnabled: boolean;
  model: string | null;
  /** What the CLI reported for the turn that failed — about the account that was active then. */
  hit: RateLimitHit | null;
  /** How many automatic attempts have already failed on a limit. */
  attempt: number;
  now: number;
};

/**
 * The earliest moment some usable account should be able to take the turn.
 *
 * For the active account the CLI's own report wins: it's what the server just
 * said, where the usage numbers may be minutes old. For the others, their
 * usage is all there is. An account that looks free right now but wasn't
 * switched to (a switch that didn't take, a session mid-turn) gets a short
 * wait, and the readiness check at that point makes the switch.
 */
export function planResume(input: PlanInput): ResumePlan {
  const { accounts, rotationEnabled, model, hit, attempt, now } = input;
  const multi = rotationEnabled && accounts.length > 1;
  const candidates = rotationEnabled ? accounts : accounts.filter((a) => a.active);

  type Choice = { at: number; name: string; email: string | null; free: boolean };
  let best: Choice | null = null;
  const consider = (at: number, name: string, email: string | null, free = false) => {
    if (!Number.isFinite(at)) return;
    if (!best || at < best.at) best = { at, name, email, free };
  };

  const activeInList = candidates.some((a) => a.active);
  for (const account of candidates) {
    const usage = accountFreeAt(account, model, now);
    if (account.active) {
      // The turn just failed here, so "free now" from usage means the usage is
      // stale, not that the account is fine — fall back to the CLI's report.
      const fromUsage = usage && usage.at > now ? usage : null;
      const fromHit = hit?.resetsAt && hit.resetsAt > now ? { at: hit.resetsAt, name: hitName(hit.type) } : null;
      const pick = fromHit && (!fromUsage || fromHit.at >= fromUsage.at) ? fromHit : fromUsage;
      if (pick) consider(pick.at + RESET_BUFFER_MS, pick.name, account.email);
    } else if (usage) {
      if (usage.at === now) consider(now + 60_000, usage.name, account.email, true);
      else consider(usage.at + RESET_BUFFER_MS, usage.name, account.email);
    }
  }
  // No cswap listing at all (single login without cswap): the CLI's report is all there is.
  if (!activeInList && hit?.resetsAt && hit.resetsAt > now) consider(hit.resetsAt + RESET_BUFFER_MS, hitName(hit.type), null);

  const chosen = best as Choice | null;
  if (!chosen) {
    const wait = backoffMs(attempt);
    return {
      at: now + wait,
      reason: `Couldn't tell when the limit resets, so trying again in ${Math.round(wait / 60_000)} minutes.`,
    };
  }
  if (chosen.free) {
    return { at: Math.max(chosen.at, now + MIN_WAIT_MS), reason: `${chosen.email ?? "Another account"} has room, so switching to it shortly.` };
  }
  const where = multi && chosen.email ? ` on ${chosen.email}` : "";
  return { at: Math.max(chosen.at, now + MIN_WAIT_MS), reason: `Waiting for ${chosen.name}${where} to reset.` };
}
