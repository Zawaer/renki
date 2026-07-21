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

/** Compact "1.2k" style formatting for a token count. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}
