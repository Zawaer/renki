import type { EventPayload } from "@renki/protocol";

/**
 * What a turn would cost at API prices, worked out from its tokens.
 *
 * Why not the Agent SDK's own `total_cost_usd`: it's cumulative for the chat,
 * and when a chat is resumed in a new process (after a limit pause, a deploy,
 * a restart) the CLI restores the earlier total. Renki diffed it per process,
 * so the first turn after every resume was charged the chat's whole history
 * again: single 10k-token turns showed up at $1,200. Tokens are per turn.
 *
 * Prices: platform.claude.com/docs/en/about-claude/pricing, read 15 Nov 2026,
 * first-party API, standard speed, per million tokens. Every current model
 * except Haiku 5.5 bills the full 1M context at the same rate. Haiku 5.5 is
 * dearer for a prompt over 100k tokens; a turn here sums many requests, so
 * it can't tell which ones crossed that line and uses the lower rate.
 */
export type Price = { input: number; write5m: number; write1h: number; cacheRead: number; output: number };

const p = (input: number, write5m: number, write1h: number, cacheRead: number, output: number): Price => ({ input, write5m, write1h, cacheRead, output });

/** Most specific first: "opus-5-5" must win over "opus-5". */
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-2/, p(8, 10, 16, 0.2, 40)],
  [/(fable|mythos)-5-1/, p(10, 12.5, 20, 0.25, 50)],
  [/(fable|mythos)-5/, p(10, 12.5, 20, 1, 50)],
  [/opus-5-5/, p(4, 5, 8, 0.2, 20)],
  [/opus-5/, p(5, 6.25, 10, 0.5, 25)],
  [/opus-4-(5|6|7|8)/, p(5, 6.25, 10, 0.5, 25)],
  [/opus-4/, p(15, 18.75, 30, 1.5, 75)],
  [/sonnet-5-5/, p(2, 2.5, 4, 0.1, 10)],
  [/sonnet-5/, p(2, 2.5, 4, 0.2, 10)],
  [/sonnet-4/, p(3, 3.75, 6, 0.3, 15)],
  [/haiku-5-5/, p(0.1, 0.125, 0.2, 0.01, 0.5)],
  [/haiku-4/, p(1, 1.25, 2, 0.1, 5)],
];

/** What Renki's model picker sends, mapped to the model it means today. No override runs Claude Code's default, Opus. */
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
  default: "claude-opus-5-5",
};
const FALLBACK = "claude-opus-5-5";

export function priceFor(model: string | null | undefined): Price {
  const id = (model ? (ALIASES[model] ?? model) : FALLBACK).toLowerCase();
  const hit = PRICES.find(([re]) => re.test(id)) ?? PRICES.find(([re]) => re.test(FALLBACK))!;
  return hit[1];
}

/** One model's tokens. `inputTokens` includes the cache writes, as Renki has always stored it. */
export type UsagePart = {
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /**
   * Of inputTokens, written to the 5-minute / 1-hour cache. Both null on old
   * events: then all of inputTokens is priced as 1-hour writes, which is what
   * Claude Code's main thread uses (measured Nov 2026: 56.6M of 56.6M written
   * tokens were 1-hour writes, 13k fresh input).
   */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
};

export function partCostUsd(u: UsagePart): number {
  const price = priceFor(u.model);
  let input: number;
  if (u.cacheWrite5mTokens == null && u.cacheWrite1hTokens == null) {
    input = u.inputTokens * price.write1h;
  } else {
    const w5 = u.cacheWrite5mTokens ?? 0;
    const w1 = u.cacheWrite1hTokens ?? 0;
    input = Math.max(0, u.inputTokens - w5 - w1) * price.input + w5 * price.write5m + w1 * price.write1h;
  }
  return (input + u.cachedInputTokens * price.cacheRead + u.outputTokens * price.output) / 1e6;
}

type TurnResult = Extract<EventPayload, { kind: "turn_result" }>;
type TurnUsage = Pick<TurnResult, "inputTokens" | "cachedInputTokens" | "outputTokens" | "model" | "resolvedModel" | "cacheWrite5mTokens" | "cacheWrite1hTokens" | "subagentUsage">;

/**
 * A turn's usage split by model: the main thread, then each model its
 * subagents ran on. Empty when the turn recorded no tokens at all.
 */
export function usageParts(t: TurnUsage): UsagePart[] {
  const parts: UsagePart[] = [];
  if (t.inputTokens != null || t.outputTokens != null || t.cachedInputTokens != null) {
    parts.push({
      model: t.resolvedModel ?? t.model ?? null,
      inputTokens: t.inputTokens ?? 0,
      cachedInputTokens: t.cachedInputTokens ?? 0,
      outputTokens: t.outputTokens ?? 0,
      cacheWrite5mTokens: t.cacheWrite5mTokens ?? null,
      cacheWrite1hTokens: t.cacheWrite1hTokens ?? null,
    });
  }
  for (const s of t.subagentUsage ?? []) parts.push({ ...s });
  return parts;
}

/** Cost of one turn (main thread and subagents) from its tokens, or null when it recorded none. */
export function turnCostUsd(t: TurnUsage): number | null {
  const parts = usageParts(t);
  return parts.length ? parts.reduce((sum, u) => sum + partCostUsd(u), 0) : null;
}

/** A stored turn_result with its cost recomputed from tokens; anything else unchanged. A turn with no tokens keeps its stored figure. */
export function withTokenCost<T extends { kind: string }>(e: T): T {
  if (e.kind !== "turn_result") return e;
  const cost = turnCostUsd(e as unknown as TurnUsage);
  return cost == null ? e : { ...e, costUsd: cost };
}
