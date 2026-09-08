import { z } from "zod";

/**
 * Read-only view over RTK's (rtk-ai/rtk) own token-savings stats. The daemon
 * shells out to the same `rtk` binary the RENKI_ENABLE_RTK PreToolUse hook uses
 * (see apps/daemon/src/claude/rtk.ts) and reports back whatever `rtk gain`
 * already tracks locally on the daemon host — Renki doesn't compute any of
 * these numbers itself.
 */

export const RtkGainSummary = z.object({
  totalCommands: z.number().int(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  totalSavedTokens: z.number().int(),
  avgSavingsPct: z.number(),
  totalTimeMs: z.number().int(),
  avgTimeMs: z.number().int(),
});
export type RtkGainSummary = z.infer<typeof RtkGainSummary>;

export const RtkGainDay = z.object({
  /** ISO date, e.g. "2026-07-21". */
  date: z.string(),
  commands: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  savedTokens: z.number().int(),
  savingsPct: z.number(),
  totalTimeMs: z.number().int(),
  avgTimeMs: z.number().int(),
});
export type RtkGainDay = z.infer<typeof RtkGainDay>;

export const RtkGainResponse = z.object({
  /** Whether RENKI_ENABLE_RTK is on for this daemon. */
  enabled: z.boolean(),
  /** Whether `rtk gain` actually responded (false if rtk is missing/misconfigured on the daemon host). */
  available: z.boolean(),
  error: z.string().nullable().default(null),
  summary: RtkGainSummary.nullable(),
  /** Trailing days with recorded activity, oldest first (capped server-side). */
  daily: z.array(RtkGainDay).default([]),
});
export type RtkGainResponse = z.infer<typeof RtkGainResponse>;
