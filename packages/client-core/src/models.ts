import type { CapabilitiesResponse } from "@renki/protocol";

type Model = CapabilitiesResponse["models"][number];

/** The SDK's descriptions lead with the versioned name — "Opus 5.5 · Best for everyday, complex tasks". */
const VERSIONED_NAME = /^([A-Z][a-z]+ \d+(?:\.\d+)*) · (.*)$/;

/**
 * Picker-button label with the version, e.g. "Opus 5.5" rather than the SDK's
 * bare displayName "Opus". Falls back to displayName when the description
 * doesn't lead with a versioned name (custom ids, older CLIs).
 */
export function modelFullName(m: Model): string {
  return VERSIONED_NAME.exec(m.description)?.[1] ?? m.displayName;
}

/**
 * Menu-row title + subtitle. An alias row ("Opus") gets its versioned name as
 * the title and the rest as the subtitle, so the version isn't said twice;
 * "Default (recommended)" keeps its title and the full description, since
 * which model it resolves to is the useful part there.
 */
export function modelMenuLabel(m: Model): { title: string; subtitle: string } {
  const match = VERSIONED_NAME.exec(m.description);
  if (!match || !match[1]!.startsWith(m.displayName)) return { title: m.displayName, subtitle: m.description };
  return { title: match[1]!, subtitle: match[2]! };
}
