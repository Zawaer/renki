import type { InsightsResponse } from "@renki/protocol";
import { formatModelLabel } from "./statsFormat.js";

/** Data shaping for the Stats page's insights, shared by web and mobile so the two say the same thing. */

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "14:00–15:00" for hour 14. */
export function formatHourRange(hour: number): string {
  const pad = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  return `${pad(hour)}–${pad(hour + 1)}`;
}

/** The trailing `n` local days, oldest first, as "YYYY-MM-DD". */
export function recentLocalDays(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
}

/** Lines added/removed over the trailing `n` local days, zero-filled. */
export function recentLines(n: number, rows: InsightsResponse["linesDaily"]): InsightsResponse["linesDaily"] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return recentLocalDays(n).map((day) => byDay.get(day) ?? { day, added: 0, removed: 0 });
}

/** Output tokens a minute, or null without enough to go on. */
export function tokensPerMinute(row: { outputTokens: number; durationMs: number }): number | null {
  return row.durationMs > 0 ? Math.round(row.outputTokens / (row.durationMs / 60_000)) : null;
}

export type ModelShare = {
  /** Series in drawing order, bottom up — the biggest models first, then "Other". */
  series: { key: string; label: string }[];
  /** Per month: each series' share (0-1, summing to 1) and the month's total output tokens. */
  months: { month: string; shares: number[]; total: number }[];
};

/**
 * Model share of output tokens per month, for a stacked area. The top
 * `maxSeries` models by total get their own series (and colour); the rest
 * fold into "Other", so the chart never needs a colour past the palette.
 */
export function modelShare(rows: InsightsResponse["modelMonthly"], maxSeries = 4): ModelShare {
  const totals = new Map<string, number>();
  for (const r of rows) for (const [m, n] of Object.entries(r.byModel)) totals.set(m, (totals.get(m) ?? 0) + n);
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  const own = ranked.length > maxSeries + 1 ? ranked.slice(0, maxSeries) : ranked;
  const hasOther = own.length < ranked.length;
  const series = [...own.map((key) => ({ key, label: formatModelLabel(key) })), ...(hasOther ? [{ key: "__other", label: "Other" }] : [])];
  const months = rows.map((r) => {
    const total = Object.values(r.byModel).reduce((s, n) => s + n, 0);
    const values = own.map((m) => r.byModel[m] ?? 0);
    if (hasOther) values.push(total - values.reduce((s, n) => s + n, 0));
    return { month: r.month, total, shares: values.map((v) => (total > 0 ? v / total : 0)) };
  });
  return { series, months };
}

/** A share as a whole percent, "—" when there's no whole. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** A count with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString(undefined);
}

/** The heatmap's busiest cell, for its caption. */
export function busiestHour(heatmap: number[][]): { weekday: number; hour: number; turns: number } | null {
  let best: { weekday: number; hour: number; turns: number } | null = null;
  heatmap.forEach((row, weekday) =>
    row.forEach((turns, hour) => {
      if (turns > 0 && (!best || turns > best.turns)) best = { weekday, hour, turns };
    }),
  );
  return best;
}

/** What the plan is worth next to the API-equivalent spend: "4.2×". Null without a price or any spend. */
export function planValue(apiEquivalentUsd: number, planUsd: number | null): string | null {
  if (!planUsd || planUsd <= 0 || apiEquivalentUsd <= 0) return null;
  const x = apiEquivalentUsd / planUsd;
  return `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
}
