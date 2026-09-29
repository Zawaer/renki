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
