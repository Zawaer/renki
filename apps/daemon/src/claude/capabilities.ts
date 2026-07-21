import type { CapabilitiesResponse } from "@crc/protocol";

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

export function setCapabilities(caps: CapabilitiesResponse): void {
  cached = caps;
}
