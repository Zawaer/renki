/**
 * When a usage window resets, phrased the way a person would say it:
 * "Resets Today 15:30", "Resets Tomorrow 18:00", "Resets Mon 15:00". A bare
 * countdown ("resets in 76h 28m") is fine for a 5-hour window and useless for
 * a weekly one, which is what these mostly are.
 */
export function formatResetTime(resetsAt: string | null | undefined, now = new Date()): string | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  const when = formatWhen(at, now);
  return when === null ? "Reset" : `Resets ${when}`;
}

/**
 * A future moment as "today 15:30", "tomorrow 18:00", "Mon 15:00" or
 * "Sep 20 15:00" — null once it's in the past. The shared half of
 * formatResetTime, also used for "Continues today 15:31".
 */
export function formatWhen(at: Date, now = new Date()): string | null {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);

  if (days < 0) return null;
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  // Inside the coming week a weekday is unambiguous; past that, give a date.
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/**
 * The paused banner's headline for a session waiting on a usage limit:
 * "Continues today 15:31", or "Continuing shortly…" once the moment has come
 * (the daemon may be waiting a minute on a busy session or a switch).
 */
export function formatResumeAt(at: number, now = new Date()): string {
  if (at <= now.getTime()) return "Continuing shortly…";
  const when = formatWhen(new Date(at), now);
  return when === null ? "Continuing shortly…" : `Continues ${when}`;
}

/** Tone for a limit, from claude.ai's own severity, falling back to the percentage. */
export function usageSeverity(severity: string | undefined, pct: number): "normal" | "warning" | "critical" {
  if (severity === "critical" || severity === "warning" || severity === "normal") return severity;
  return pct >= 90 ? "critical" : pct >= 70 ? "warning" : "normal";
}

/** A free limit reset as the clients list it: a title, and when it expires. */
export type ResetLine = { title: string; left: number; expires: string | null; usableNow: boolean };

type ResetLike = { type: string; label: string; left: number; expiresAt: string | null; usableNow: boolean; clears?: string[] };

/**
 * One line per free limit reset claude.ai has granted ("Full reset", "Fable
 * reset"), soonest-expiring first, so an account's unused resets are never
 * something you only find by luck on claude.ai's Usage page.
 */
export function resetLines(resets: ResetLike[] | undefined, now = new Date()): ResetLine[] {
  return (resets ?? [])
    .filter((r) => r.left > 0 && (!r.expiresAt || new Date(r.expiresAt).getTime() > now.getTime()))
    .map((r) => {
      const at = r.expiresAt ? new Date(r.expiresAt) : null;
      const day = at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
      return {
        title: r.type === "fable" ? "Fable reset" : "Full reset",
        left: r.left,
        expires: day ? `expires ${day}` : null,
        usableNow: r.usableNow,
        at: at?.getTime() ?? Infinity,
      };
    })
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...line }) => line);
}

/** "3 resets" for badges; null when there are none. */
export function resetCountLabel(resets: ResetLike[] | undefined, now = new Date()): string | null {
  const n = resetLines(resets, now).reduce((sum, l) => sum + l.left, 0);
  return n > 0 ? `${n} reset${n === 1 ? "" : "s"}` : null;
}

export type ResetAdviceKind = "expiring" | "use_now" | "wait" | "later";
export type ResetAdvice = { kind: ResetAdviceKind; text: string };

type AdviceUsage = {
  sevenDay: { pct: number; resetsAt: string | null };
  limits?: { kind: string; pct: number; resetsAt: string | null }[];
  resets?: ResetLike[];
};

const HOUR = 3_600_000;
/** A reset this close to expiring is used or lost. */
export const EXPIRY_WARN_MS = 48 * HOUR;
/** At or past this share of the weekly limit, you're effectively out. */
export const AT_LIMIT_PCT = 95;
/** A reset refills what you've used, so it only pays when the natural weekly refill is still far off. */
export const WORTH_IT_MS = 2 * 24 * HOUR;

/**
 * When to spend one of an account's free limit resets, or null without any.
 *
 * A reset gives back what you've used, so it's worth most when you hit the
 * weekly limit early in the week, and worth nothing right before the weekly
 * refill, which brings the same quota back anyway. The one hard deadline is
 * expiry: unused resets are lost. So the rule is (1) use it before it
 * expires, (2) otherwise use it when you're at the limit with at least two
 * days to go, (3) otherwise wait. Advice only: Renki never uses a reset.
 */
export function resetAdvice(usage: AdviceUsage | null | undefined, now = new Date()): ResetAdvice | null {
  const lines = (usage?.resets ?? []).filter((r) => r.left > 0 && r.expiresAt && new Date(r.expiresAt).getTime() > now.getTime());
  if (!usage || lines.length === 0) return null;
  const soonest = Math.min(...lines.map((r) => new Date(r.expiresAt as string).getTime()));
  const untilExpiry = soonest - now.getTime();
  const weekly = usage.limits?.find((l) => l.kind === "weekly_all") ?? { pct: usage.sevenDay.pct, resetsAt: usage.sevenDay.resetsAt };
  const untilWeekly = weekly.resetsAt ? new Date(weekly.resetsAt).getTime() - now.getTime() : null;
  const hours = (ms: number) => (ms < 48 * HOUR ? `${Math.max(1, Math.round(ms / HOUR))} hours` : `${Math.round(ms / (24 * HOUR))} days`);

  if (untilExpiry <= EXPIRY_WARN_MS) {
    return { kind: "expiring", text: `One expires in ${hours(untilExpiry)}. Use it before then or it's lost.` };
  }
  if (weekly.pct >= AT_LIMIT_PCT) {
    if (untilWeekly === null || untilWeekly >= WORTH_IT_MS) {
      return { kind: "use_now", text: `At the weekly limit${untilWeekly === null ? "" : ` with ${hours(untilWeekly)} to go`}: a reset now gives back the most.` };
    }
    return { kind: "wait", text: `At the limit, but the weekly reset is only ${hours(untilWeekly)} away. Probably wait.` };
  }
  return { kind: "later", text: `Best used when you hit the weekly limit with 2+ days left. Use by ${new Date(soonest).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` };
}
