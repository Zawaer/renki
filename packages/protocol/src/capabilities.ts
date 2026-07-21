import { z } from "zod";

/**
 * What the Agent SDK reports as available for the currently-running `claude`
 * install — mirrors the SDK's own `ModelInfo`/`SlashCommand` shapes so the
 * daemon can pass them through verbatim. Process-lifetime, not per-session:
 * populated from whichever turn happens to run first each daemon start (see
 * apps/daemon/src/claude/capabilities.ts), empty until then.
 */
export const ModelInfo = z.object({
  /** Model identifier to use in API calls. */
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** An available skill/command, invoked via `/name` syntax in a prompt. */
export const SlashCommand = z.object({
  /** Command name, without the leading slash. */
  name: z.string(),
  description: z.string(),
  /** Hint for expected arguments, e.g. "<file>". */
  argumentHint: z.string(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const CapabilitiesResponse = z.object({
  models: z.array(ModelInfo),
  commands: z.array(SlashCommand),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponse>;
