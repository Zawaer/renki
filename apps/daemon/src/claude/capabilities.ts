import type { CapabilitiesResponse } from "@renki/protocol";

/**
 * Process-lifetime cache of what the Agent SDK reports as available (models,
 * slash commands) — static per `claude` install, so there's no need to refetch
 * every turn. Only obtainable from a live `Query` object (see runner.ts's
 * `supportedModels()`/`supportedCommands()` call), so this starts empty and is
 * populated lazily by whichever turn runs first after daemon startup.
 */
let cached: CapabilitiesResponse | null = null;

export function getCapabilities(): CapabilitiesResponse {
  return cached ?? { models: [], commands: [] };
}

export function hasCapabilities(): boolean {
  return cached !== null;
}

/**
 * Models the CLI on this host may not advertise but that a subscriber can
 * still pick — e.g. Fable 5.1 needs usage credits and only shows up in the
 * SDK's list on accounts that have them. Listing it here means the picker
 * offers it everywhere; an account that can't run it just gets the API's own
 * error on that turn, same as typing the id by hand.
 */
const EXTRA_MODELS: CapabilitiesResponse["models"] = [
  {
    value: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest and longest-running tasks · Requires usage credits",
  },
];

/** Family key for de-duplicating a model against EXTRA_MODELS regardless of exact id/date suffix. */
function family(value: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(value);
  return m ? `${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ""}` : value;
}

/** The SDK's list plus EXTRA_MODELS, each extra slotted in after "Default"/Sonnet (position 2) unless the CLI already lists that family. */
export function withExtraModels(models: CapabilitiesResponse["models"]): CapabilitiesResponse["models"] {
  const out = [...models];
  for (const extra of EXTRA_MODELS) {
    if (out.some((m) => m.value === extra.value || family(m.value) === family(extra.value))) continue;
    out.splice(Math.min(2, out.length), 0, extra);
  }
  return out;
}

export function setCapabilities(caps: CapabilitiesResponse): void {
  cached = { ...caps, models: withExtraModels(caps.models) };
}
