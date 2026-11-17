/**
 * The composer's effort picker, turned into what Claude Code actually acts on.
 *
 * Clients still send the level as a `maxThinkingTokens` number (the values in
 * client-core's EFFORT_LEVELS), so phones on an older build keep working. That
 * number used to be passed straight on as a thinking budget, which on Opus
 * 4.6 and later only means on or off: every level from Medium to Max ran at
 * the model's default effort. Here each value maps to Claude Code's own effort
 * level, and Ultracode to its real switch (standing multi-agent workflow
 * orchestration), as the CLI's /effort menu does.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type Effort = { level: EffortLevel; ultracode: boolean };

/** Must match client-core's EFFORT_LEVELS. 64k is Ultracode; older clients sent 60k for it, which reads as Max. */
const BY_BUDGET: [number, Effort][] = [
  [0, { level: "low", ultracode: false }],
  [4_000, { level: "medium", ultracode: false }],
  [10_000, { level: "high", ultracode: false }],
  [32_000, { level: "xhigh", ultracode: false }],
  [60_000, { level: "max", ultracode: false }],
  [64_000, { level: "max", ultracode: true }],
];

/** null when the client asked for nothing (then the model's own default applies). An unknown number takes the nearest level at or below it. */
export function effortFromBudget(budget: number | null | undefined): Effort | null {
  if (budget == null) return null;
  let hit = BY_BUDGET[0]![1];
  for (const [b, e] of BY_BUDGET) if (budget >= b) hit = e;
  return hit;
}

export function sameEffort(a: Effort | null, b: Effort | null): boolean {
  return a?.level === b?.level && (a?.ultracode ?? false) === (b?.ultracode ?? false);
}
