/** Compact "3h 12m" / "45m" countdown to an ISO reset timestamp. Null once past (or missing). */
export function formatResetIn(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "$39.53" style formatting for a dollar amount. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
