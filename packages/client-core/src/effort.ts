/**
 * Effort levels, mirroring Claude Code's own Low/Medium/High/Extra High/Max/
 * Ultracode convention. The Agent SDK has no "effort" concept — this maps
 * each label to a `maxThinkingTokens` budget (Low disables thinking; the rest
 * roughly follow Claude Code's think / think hard / think harder tiers).
 *
 * "Ultracode" in Claude Code's own UI implies multi-agent workflow
 * orchestration, which is a harness-level capability — NOT something a
 * thinking-token budget produces on its own. It's mapped to the same budget
 * as Max here; picking it does not enable any kind of automatic sub-agent
 * orchestration.
 */
export type EffortLevel = {
  key: string;
  label: string;
  /** null = don't send maxThinkingTokens at all (the SDK's own default). */
  maxThinkingTokens: number | null;
};

export const EFFORT_LEVELS: EffortLevel[] = [
  { key: "low", label: "Low", maxThinkingTokens: 0 },
  { key: "medium", label: "Medium", maxThinkingTokens: 4_000 },
  { key: "high", label: "High", maxThinkingTokens: 10_000 },
  { key: "xhigh", label: "Extra High", maxThinkingTokens: 32_000 },
  { key: "max", label: "Max", maxThinkingTokens: 60_000 },
  { key: "ultracode", label: "Ultracode", maxThinkingTokens: 60_000 },
];

export const DEFAULT_EFFORT_KEY = "medium";

/** Validates a raw persisted string (localStorage/SecureStore/etc.) against the known effort keys, falling back to the default. */
export function resolveEffortKey(raw: string | null | undefined): string {
  return EFFORT_LEVELS.some((e) => e.key === raw) ? (raw as string) : DEFAULT_EFFORT_KEY;
}
