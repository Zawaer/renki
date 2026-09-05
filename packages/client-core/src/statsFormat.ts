import type { StatsBucket } from "@crc/protocol";

/** Shared formatting/data-shaping helpers for the web and mobile Stats screens — kept identical so the two never drift. */

export function formatSuccessRate(bucket: { turnCount: number; okCount: number }): string {
  if (bucket.turnCount === 0) return "—";
  return `${Math.round((bucket.okCount / bucket.turnCount) * 100)}%`;
}

/**
 * Money, to the cent. Four decimals were precise but unreadable — nobody
 * budgets in hundredths of a cent. Anything above zero but below a cent shows
 * as "<$0.01" rather than "$0.00", so a real (tiny) charge never reads as free.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.005) return "<$0.01";
  return "$" + usd.toFixed(2);
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return "0s";
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatMonthLabel(key: string): string {
  const d = new Date(`${key}-01T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Trailing N UTC days ending today, zero-filled for days with no turns. */
export function lastNDays(n: number, buckets: StatsBucket[]): StatsBucket[] {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const now = new Date();
  const out: StatsBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byKey.get(key) ?? { key, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0, okCount: 0 });
  }
  return out;
}

/** Turns a `byModel` bucket key (a raw model id, or "default" for no per-turn override) into a display label. */
export function formatModelLabel(key: string): string {
  return key === "default" ? "Default" : key;
}

/** Turns a `byClientType` bucket key (a device-id prefix, or "unknown" for pre-feature turns) into a display label. */
export function formatClientTypeLabel(key: string): string {
  switch (key) {
    case "web":
      return "Web";
    case "phone":
      return "Mobile";
    case "vscode":
      return "VS Code";
    case "unknown":
      return "Unknown";
    default:
      return key.charAt(0).toUpperCase() + key.slice(1);
  }
}

/**
 * Sparse x-axis label indices (first, last, and evenly spaced in between) so
 * labels don't collide. `maxTicks` has no default on purpose — web's wider
 * charts and mobile's narrower ones want different tick counts, so each
 * caller passes its own tuned value explicitly.
 */
export function tickIndices(count: number, maxTicks: number): Set<number> {
  if (count <= maxTicks) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = (count - 1) / (maxTicks - 1);
  return new Set(Array.from({ length: maxTicks }, (_, i) => Math.round(i * step)));
}
