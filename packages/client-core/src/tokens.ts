/**
 * Rough chars-per-token for English prose (~4 is the commonly cited average
 * for Claude/GPT-style tokenizers). Used ONLY for the live estimate shown
 * while a thinking block is still streaming — the real per-turn count from
 * the SDK's usage field always supersedes it once the turn finishes, since
 * the API has no per-content-block token breakdown to estimate against.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN));
}

/**
 * Compact token count: "812", "1.2k", "36k", "35.8M", "1.2B".
 *
 * Steps up a unit rather than letting one run away — a lifetime total read
 * "35752k", which is nobody's idea of a number. One decimal only below 10 of
 * a unit, where it carries information ("1.2k"), and none above it, where it
 * is noise ("36k" not "35.8k").
 */
export function formatTokenCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  for (const [limit, divisor, unit] of [
    [1_000_000, 1_000, "k"],
    [1_000_000_000, 1_000_000, "M"],
    [Number.POSITIVE_INFINITY, 1_000_000_000, "B"],
  ] as const) {
    if (abs >= limit) continue;
    const scaled = abs / divisor;
    return `${sign}${scaled.toFixed(scaled < 10 ? 1 : 0)}${unit}`;
  }
  return `${sign}${abs}`;
}
