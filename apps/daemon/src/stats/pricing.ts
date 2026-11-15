import type { EventPayload } from "@renki/protocol";

/**
 * What a turn would cost at API prices, worked out from its tokens.
 *
 * Why not the Agent SDK's own `total_cost_usd`: it's cumulative for the chat,
 * and when a chat is resumed in a new process (after a limit pause, a deploy,
 * a restart) the CLI restores the earlier total. Renki diffs it per process,
 * so the first turn after every resume used to be charged the chat's whole
 * history again — single 10k-token turns showed up at $1,200, and a week added
 * up to $47k. Tokens are per turn and don't have that problem.
 *
 * Prices per million tokens, first-party API (Nov 2026). Cache writes are
 * charged at 1.25× input (the 5-minute cache Claude Code uses); Renki stores
 * them folded into inputTokens, so all of inputTokens is priced that way —
 * slightly high for the uncached part, which is small next to the writes.
 */
type Price = { input: number; output: number; cacheRead: number };

const PRICES: { match: RegExp; price: Price }[] = [
  { match: /fable-5-2|mythos-5-2/, price: { input: 8, output: 40, cacheRead: 0.2 } },
  { match: /fable|mythos/, price: { input: 10, output: 50, cacheRead: 1 } },
  { match: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /opus/, price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: /sonnet-5-5/, price: { input: 2, output: 10, cacheRead: 0.1 } },
  { match: /sonnet/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /haiku-5-5/, price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
  { match: /haiku/, price: { input: 1, output: 5, cacheRead: 0.1 } },
];

/** Aliases Renki sends ("opus", "sonnet", "default", none) mean the current model of that family. */
const ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-2" };
const DEFAULT_MODEL = "claude-opus-5-5";
const CACHE_WRITE = 1.25;

export function priceFor(model: string | null | undefined): Price {
  const id = !model || model === "default" ? DEFAULT_MODEL : (ALIASES[model] ?? model);
  return (PRICES.find((p) => p.match.test(id)) ?? PRICES.find((p) => p.match.test(DEFAULT_MODEL))!).price;
}

type TurnTokens = Pick<Extract<EventPayload, { kind: "turn_result" }>, "inputTokens" | "cachedInputTokens" | "outputTokens" | "model" | "resolvedModel">;

/** Cost of one turn from its tokens, or null when it recorded none. */
export function turnCostUsd(t: TurnTokens): number | null {
  if (t.inputTokens == null && t.outputTokens == null && t.cachedInputTokens == null) return null;
  const p = priceFor(t.resolvedModel ?? t.model);
  return ((t.inputTokens ?? 0) * p.input * CACHE_WRITE + (t.cachedInputTokens ?? 0) * p.cacheRead + (t.outputTokens ?? 0) * p.output) / 1e6;
}

/** A stored turn_result with its cost recomputed from tokens; anything else unchanged. Old events keep their figure only when they have no tokens. */
export function withTokenCost<T extends { kind: string }>(e: T): T {
  if (e.kind !== "turn_result") return e;
  const cost = turnCostUsd(e as unknown as TurnTokens);
  return cost == null ? e : { ...e, costUsd: cost };
}
