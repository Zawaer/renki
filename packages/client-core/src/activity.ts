import type { StatsBucket } from "@crc/protocol";

/**
 * Activity-shaped views of the daemon's daily turn_result buckets — what the
 * home screen's heatmap, streak tiles and fun-fact line are built from. Pure
 * functions over `StatsResponse.daily` (UTC day keys, zero-filled here where
 * needed) so web and mobile compute identical numbers.
 */

export type DayCell = {
  /** UTC day key, YYYY-MM-DD. */
  key: string;
  turnCount: number;
  costUsd: number;
  /** After today — rendered blank so the grid always ends on a full week. */
  future: boolean;
};

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * A GitHub-style grid: `weeks` columns, 7 rows (Monday first), ending with the
 * week that contains today. Days after today are marked `future`.
 */
export function activityGrid(weeks: number, buckets: StatsBucket[], now = new Date()): DayCell[][] {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const today = utcToday(now);
  // Monday-first: JS getUTCDay() is 0 for Sunday.
  const dow = (today.getUTCDay() + 6) % 7;
  const endOfWeek = new Date(today);
  endOfWeek.setUTCDate(today.getUTCDate() + (6 - dow));
  const start = new Date(endOfWeek);
  start.setUTCDate(endOfWeek.getUTCDate() - weeks * 7 + 1);

  const columns: DayCell[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const col: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const key = utcDayKey(cursor);
      const b = byKey.get(key);
      col.push({ key, turnCount: b?.turnCount ?? 0, costUsd: b?.costUsd ?? 0, future: cursor > today });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    columns.push(col);
  }
  return columns;
}

/**
 * Bucket a day's turn count into 0..4 intensity steps relative to the busiest
 * day in the set, so a light week still shows texture and a heavy one doesn't
 * saturate.
 */
export function intensity(turnCount: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (turnCount <= 0 || max <= 0) return 0;
  const r = turnCount / max;
  if (r <= 0.25) return 1;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 3;
  return 4;
}

/**
 * Consecutive active days. `current` counts back from today, or from
 * yesterday if today has nothing yet (an empty morning shouldn't read as a
 * broken streak). `longest` is the best run anywhere in the history.
 */
export function streaks(buckets: StatsBucket[], now = new Date()): { current: number; longest: number } {
  const active = new Set(buckets.filter((b) => b.turnCount > 0).map((b) => b.key));
  if (active.size === 0) return { current: 0, longest: 0 };

  const today = utcToday(now);
  const cursor = new Date(today);
  if (!active.has(utcDayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let current = 0;
  while (active.has(utcDayKey(cursor))) {
    current++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let longest = 0;
  const sorted = [...active].sort();
  let run = 0;
  let prev: Date | null = null;
  for (const key of sorted) {
    const d = new Date(`${key}T00:00:00Z`);
    run = prev && d.getTime() - prev.getTime() === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

/** Sum of the buckets that fall within the trailing `days` UTC days (inclusive of today). */
export function sumRecent(days: number, buckets: StatsBucket[], now = new Date()): StatsBucket {
  const today = utcToday(now);
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - days + 1);
  const startKey = utcDayKey(start);
  const total: StatsBucket = { key: `${days}d`, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0, okCount: 0 };
  for (const b of buckets) {
    if (b.key < startKey) continue;
    total.costUsd += b.costUsd;
    total.inputTokens += b.inputTokens;
    total.outputTokens += b.outputTokens;
    total.durationMs += b.durationMs;
    total.turnCount += b.turnCount;
    total.okCount += b.okCount;
  }
  return total;
}

/** The Lord of the Rings is ~576k words; at ~1.3 tokens a word that's roughly 750k tokens. */
const LOTR_TOKENS = 750_000;

/** One playful line putting a token total in perspective. Empty string when there's nothing to say yet. */
export function tokensInPerspective(totalTokens: number): string {
  if (totalTokens <= 0) return "";
  const ratio = totalTokens / LOTR_TOKENS;
  if (ratio >= 2) return `You've used ~${Math.round(ratio)}× more tokens than The Lord of the Rings.`;
  if (ratio >= 0.95) return "You've used about as many tokens as The Lord of the Rings.";
  return `You've used about ${Math.max(1, Math.round(ratio * 100))}% of The Lord of the Rings in tokens.`;
}
