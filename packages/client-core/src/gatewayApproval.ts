/**
 * Homelab-gateway approvals (docs/homelab-gateway.md).
 *
 * When a session asks to delete something on the homelab, the *gateway* (not the
 * daemon) pushes a notification whose data carries a one-time token and the address of
 * its approval service. The phone answers that service directly. The daemon is never in
 * this path, on purpose: sessions can read everything the daemon can.
 */

export type GatewayApproval = { id: string; token: string; url: string };

export type GatewayOutcome = "done" | "already_answered" | "expired" | "failed";

const ID = /^[0-9a-f]{10}$/;

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
  return { id, token, url: url.replace(/\/$/, "") };
}

export async function answerGatewayApproval(
  approval: GatewayApproval,
  decision: "approve" | "deny",
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayOutcome> {
  try {
    const res = await fetchImpl(`${approval.url}/v1/approvals/${approval.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: approval.token, decision }),
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
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/v1/approvals/resend`, { method: "POST" });
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
};

/**
 * Ask the approval service about a request: its wording from the gateway itself (never from the
 * notification), whether it is still waiting, and when it runs out. Null when it can't be reached
 * or the service doesn't recognise the request.
 */
export async function peekGatewayApproval(approval: GatewayApproval, fetchImpl: typeof fetch = fetch): Promise<GatewayPeek | null> {
  try {
    const res = await fetchImpl(`${approval.url}/v1/approvals/${approval.id}`, { headers: { "x-approval-token": approval.token } });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<GatewayPeek>;
    if (typeof body.summary !== "string" || typeof body.expires !== "number") return null;
    const state = body.state === "approve" || body.state === "deny" || body.state === "expired" ? body.state : "pending";
    return { summary: body.summary, state, expires: body.expires };
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
