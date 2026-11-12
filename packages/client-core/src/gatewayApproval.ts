/**
 * Homelab-gateway approvals (docs/homelab-gateway.md).
 *
 * When a session asks to delete something on the homelab, the *gateway* (not the
 * daemon) pushes a notification whose data carries a one-time token and the address of
 * its approval service. The phone answers that service directly. The daemon is never in
 * this path, on purpose: sessions can read everything the daemon can.
 */

/** `pad`: for a root command, the one-time pad (hex) the password is sealed with before it leaves the phone. */
export type GatewayApproval = { id: string; token: string; url: string; pad?: string };

export type GatewayOutcome = "done" | "already_answered" | "expired" | "failed";

const ID = /^[0-9a-f]{10}$/;
const PAD = /^(?:[0-9a-f]{2}){16,512}$/;

/**
 * Every call here gives up after a few seconds. A phone just woken up may not have its tailnet
 * back yet, and a fetch with no timeout then hangs for good: the approval popup spun forever while
 * its five minutes ran out (2026-11-04). Better to fail fast and try again.
 */
const TIMEOUT_MS = 8_000;
function withTimeout(fetchImpl: typeof fetch, input: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetchImpl(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** The approval inside a notification's data, or null if it isn't one (or is malformed). */
export function parseGatewayApproval(data: unknown): GatewayApproval | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== "gateway-approval") return null;
  const { id, token, url } = d;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  // Only ever talk to an https address: the token is a bearer secret.
  if (typeof url !== "string" || !/^https:\/\/[^/\s]+\/?$/.test(url)) return null;
  const pad = typeof d.pad === "string" && PAD.test(d.pad) ? d.pad : undefined;
  return { id, token, url: url.replace(/\/$/, ""), ...(pad ? { pad } : {}) };
}

/**
 * The sudo password as it leaves the phone: UTF-8, zero-padded to the pad's length, XOR the pad,
 * as hex. The pad came only in the notification, so the approval service (which stores this for a
 * moment) can't read it; only the waiting gateway, which holds the pad in memory, can.
 * Null when the password doesn't fit.
 */
export function sealPassword(password: string, padHex: string): string | null {
  const pad = new Uint8Array(padHex.length / 2);
  for (let i = 0; i < pad.length; i++) pad[i] = parseInt(padHex.slice(i * 2, i * 2 + 2), 16);
  const data = new TextEncoder().encode(password);
  if (data.length >= pad.length) return null;
  let out = "";
  for (let i = 0; i < pad.length; i++) out += ((data[i] ?? 0) ^ pad[i]!).toString(16).padStart(2, "0");
  return out;
}

export async function answerGatewayApproval(
  approval: GatewayApproval,
  decision: "approve" | "deny",
  fetchImpl: typeof fetch = fetch,
  password?: string,
): Promise<GatewayOutcome> {
  let secret: string | undefined;
  if (decision === "approve" && password !== undefined) {
    if (!approval.pad) return "failed";
    secret = sealPassword(password, approval.pad) ?? undefined;
    if (!secret) return "failed";
  }
  try {
    const res = await withTimeout(fetchImpl, `${approval.url}/v1/approvals/${approval.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: approval.token, decision, ...(secret ? { secret } : {}) }),
    });
    if (res.ok) return "done";
    if (res.status === 409) return "already_answered";
    if (res.status === 410) return "expired";
    return "failed";
  } catch {
    return "failed";
  }
}

/**
 * Ask the approval service to push every request still waiting to the phone again: a
 * notification swiped away took its token with it, and only the waiting gateway still has
 * it. Needs no token (it reveals and grants nothing); the gateway rate-limits the pushes.
 * Returns how many requests are waiting, or null when the service can't be reached.
 */
export async function requestGatewayResend(url: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  if (!/^https:\/\/[^/\s]+\/?$/.test(url)) return null;
  try {
    const res = await withTimeout(fetchImpl, `${url.replace(/\/$/, "")}/v1/approvals/resend`, { method: "POST" });
    if (!res.ok) return null;
    const body = (await res.json()) as { pending?: unknown };
    return typeof body.pending === "number" ? body.pending : null;
  } catch {
    return null;
  }
}

export type GatewayPeek = {
  /** What the gateway wrote about the request: the exact thing being approved. */
  summary: string;
  /** "pending" until someone decides or it times out. */
  state: "pending" | "approve" | "deny" | "expired";
  /** Unix seconds. */
  expires: number;
  /** A root command: approving needs the user's sudo password. */
  password: boolean;
  /** Once closed, who closed it: "phone", "mac", "timeout", "guard" (five wrong tokens); null when unknown or still open. */
  by: string | null;
};

/**
 * Ask the approval service about a request: its wording from the gateway itself (never from the
 * notification), whether it is still waiting, and when it runs out. Null when it can't be reached
 * (or answered with an error); a request it no longer knows comes back as expired.
 */
export async function peekGatewayApproval(approval: GatewayApproval, fetchImpl: typeof fetch = fetch): Promise<GatewayPeek | null> {
  try {
    const res = await withTimeout(fetchImpl, `${approval.url}/v1/approvals/${approval.id}`, { headers: { "x-approval-token": approval.token } });
    // Reached, but the homelab no longer has it (cleaned up long after it closed): closed, not unreachable.
    if (res.status === 404) return { summary: "This request is no longer on the homelab.", state: "expired", expires: 0, password: false, by: null };
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<GatewayPeek> & { by?: unknown };
    const password = body.password === true;
    if (typeof body.summary !== "string" || typeof body.expires !== "number") return null;
    const state = body.state === "approve" || body.state === "deny" || body.state === "expired" ? body.state : "pending";
    return { summary: body.summary, state, expires: body.expires, password, by: typeof body.by === "string" ? body.by : null };
  } catch {
    return null;
  }
}

/** m:ss for the time left on a request (never negative). */
export function formatTimeLeft(expiresUnixSeconds: number, nowMs: number): string {
  const left = Math.max(0, Math.ceil(expiresUnixSeconds - nowMs / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** What to show the user once they've answered. */
export function describeGatewayOutcome(outcome: GatewayOutcome, decision: "approve" | "deny"): string {
  switch (outcome) {
    case "done":
      return decision === "approve" ? "Approved" : "Denied";
    case "already_answered":
      return "Already answered";
    case "expired":
      return "Too late: this request expired";
    default:
      return "Couldn't reach the homelab. Try again";
  }
}

/**
 * The command out of a gateway summary ("Run on the homelab as zawaer:\n<command>"), on one line,
 * or the summary itself for other requests (add-app, rm-path…). What a toast or a list row shows.
 */
export function gatewaySummaryLine(summary: string, max = 80): string {
  const flat = summary
    .replace(/^Run (?:as ROOT )?on the homelab(?: as \w+)?:\s*/, "")
    .replace(/\s*Enter your sudo password to approve\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Where a request was settled, as said after "Approved" / "Denied": "on the Mac". Empty when it says nothing useful. */
function where(by: string | null): string {
  if (by === "mac") return " on the Mac";
  if (by === "phone") return " on the phone";
  return "";
}

/**
 * How a closed request ended, in a few words: "Approved on the Mac", "Expired, nothing ran",
 * "Denied after wrong tries". For the phone's approval popup, toasts and its Recent approvals list.
 */
export function describeGatewaySettled(outcome: "approve" | "deny" | "expired", by: string | null): string {
  if (outcome === "expired") return "Expired, nothing ran";
  if (outcome === "approve") return `Approved${where(by)}`;
  if (by === "guard") return "Denied after wrong tries, nothing ran";
  return `Denied${where(by)}, nothing ran`;
}

/** The fields of a closed request that deciding whether to mention it needs (protocol's GatewaySettled). */
export type SettledForNotice = { id: string; summary: string; settled: number; outcome: "approve" | "deny" | "expired"; by: string | null; pushed: boolean };

/**
 * Which closed requests the phone should mention when it opens: closed after `since` (ms), sent to
 * the phone (one approved on the Mac before it ever buzzed was never news there), and not answered
 * on the phone, which already said what happened. What's left is a notification that was swiped
 * away or ignored: it ran out of time, or the Mac settled it after the phone had buzzed.
 */
export function settledToMention<T extends SettledForNotice>(recent: T[], since: number, skip: ReadonlySet<string> = new Set()): T[] {
  return recent.filter((r) => r.settled > since && r.pushed && r.by !== "phone" && !skip.has(r.id));
}

/** One toast for those: the outcome and command for one, a count for several. */
export function describeMentions(list: SettledForNotice[]): string | null {
  if (list.length === 0) return null;
  if (list.length === 1) {
    const r = list[0]!;
    return `Homelab: ${describeGatewaySettled(r.outcome, r.by)}: ${gatewaySummaryLine(r.summary, 60)}`;
  }
  const expired = list.filter((r) => r.outcome === "expired").length;
  const parts = [expired ? `${expired} expired` : "", list.length - expired ? `${list.length - expired} answered elsewhere` : ""].filter(Boolean);
  return `Homelab: ${list.length} requests closed (${parts.join(", ")}). See Settings > Homelab approvals.`;
}
