/**
 * Effort levels, mirroring Claude Code's own Low/Medium/High/Extra High/Max/
 * Ultracode menu. They travel to the daemon as a `maxThinkingTokens` number
 * (a field every client build already sends); the daemon turns each value
 * into Claude Code's real effort level, and Ultracode into its standing
 * multi-agent workflow orchestration (apps/daemon/src/claude/effort.ts).
 * So the numbers are codes, not budgets: keep the two tables in step.
 */
export type EffortLevel = {
  key: string;
  label: string;
  /** The code the daemon maps to an effort level; null = send none (the model's own default). */
  maxThinkingTokens: number | null;
};

export const EFFORT_LEVELS: EffortLevel[] = [
  { key: "low", label: "Low", maxThinkingTokens: 0 },
  { key: "medium", label: "Medium", maxThinkingTokens: 4_000 },
  { key: "high", label: "High", maxThinkingTokens: 10_000 },
  { key: "xhigh", label: "Extra High", maxThinkingTokens: 32_000 },
  { key: "max", label: "Max", maxThinkingTokens: 60_000 },
  { key: "ultracode", label: "Ultracode", maxThinkingTokens: 64_000 },
];

export const DEFAULT_EFFORT_KEY = "medium";

/** Validates a raw persisted string (localStorage/SecureStore/etc.) against the known effort keys, falling back to the default. */
export function resolveEffortKey(raw: string | null | undefined): string {
  return EFFORT_LEVELS.some((e) => e.key === raw) ? (raw as string) : DEFAULT_EFFORT_KEY;
}
