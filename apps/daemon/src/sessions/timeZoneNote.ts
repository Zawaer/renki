/**
 * The daemon's clock is the host's, so `date` on a box in Helsinki reads an
 * hour ahead for someone prompting from Stockholm. Clients send their zone
 * with every prompt; this decides when Claude needs telling about it. Only on
 * a change — a note that rides every message wastes tokens and churns the
 * prompt cache.
 */

/** This machine's IANA zone. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "GMT+2" for a zone at `now`, or null if the name isn't a zone this runtime knows. */
function offsetLabel(tz: string, now: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? null;
  } catch {
    return null;
  }
}

/** A clock note at most this often per chat: every message would churn the prompt cache for nothing. */
export const CLOCK_NOTE_EVERY_MS = 5 * 60_000;

/**
 * The current time in the user's zone, for a chat to read instead of
 * guessing: one told "it's 03:10" in an overnight session was ten minutes off,
 * since nothing in its context carried the time. `lastToldAt` is when this
 * chat last got one. Null when the zone is unknown or one went out recently.
 */
export function clockNote(userTz: string | undefined, lastToldAt: number | undefined, now: Date = new Date()): { note: string | null; toldAt: number | undefined } {
  if (!userTz || (lastToldAt !== undefined && now.getTime() - lastToldAt < CLOCK_NOTE_EVERY_MS)) return { note: null, toldAt: lastToldAt };
  let when: string;
  try {
    when = new Intl.DateTimeFormat("en-GB", { timeZone: userTz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  } catch {
    return { note: null, toldAt: lastToldAt };
  }
  return { note: `<renki-context>The time now is ${when} in the user's zone (${userTz}).</renki-context>\n\n`, toldAt: now.getTime() };
}

/**
 * What to tell Claude, if anything, for a prompt sent from `userTz`.
 * `lastTold` is the zone Claude last heard about (undefined: none yet, so it
 * assumes the host's). A zone with the host's offset right now counts as the
 * host's — Stockholm and Paris read the same clock, so there's nothing to say.
 * `told` is what to remember for next time.
 */
export function timeZoneNote(
  userTz: string | undefined,
  hostTz: string,
  lastTold: string | undefined,
  now: Date = new Date(),
): { note: string | null; told: string | undefined } {
  const userOffset = userTz ? offsetLabel(userTz, now) : null;
  const hostOffset = offsetLabel(hostTz, now);
  if (!userTz || !userOffset || !hostOffset) return { note: null, told: lastTold };

  const effective = userOffset === hostOffset ? hostTz : userTz;
  if (effective === (lastTold ?? hostTz)) return { note: null, told: lastTold };

  const note =
    effective === hostTz
      ? `The user is now in the same time zone as this machine (${hostTz}, ${hostOffset}).`
      : `The user's local time zone is ${userTz} (${userOffset}); this machine's clock is on ${hostTz} (${hostOffset}). When you tell the user a time, give it in their zone.`;
  return { note: `<renki-context>${note}</renki-context>\n\n`, told: effective };
}
