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
