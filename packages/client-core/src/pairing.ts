/**
 * QR device-pairing payload. An already-configured client (web or phone) shows
 * a QR of its own working { baseUrl, token } — it's the one place that actually
 * knows a reachable URL (tailnet hostname, LAN IP, whatever the operator set
 * up) since the daemon itself can't guess how it's exposed. Another device
 * scans it to skip typing both fields by hand.
 */
export type PairingPayload = {
  baseUrl: string;
  token: string;
};

const MAGIC = "crcPairing";
const VERSION = 1;

export function encodePairing(payload: PairingPayload): string {
  return JSON.stringify({ [MAGIC]: VERSION, ...payload });
}

/** Returns null for anything that isn't a valid pairing payload (e.g. an unrelated QR code). */
export function decodePairing(raw: string): PairingPayload | null {
  try {
    const obj = JSON.parse(raw);
    if (
      !obj ||
      typeof obj !== "object" ||
      obj[MAGIC] !== VERSION ||
      typeof obj.baseUrl !== "string" ||
      typeof obj.token !== "string" ||
      !obj.baseUrl ||
      !obj.token
    ) {
      return null;
    }
    return { baseUrl: obj.baseUrl, token: obj.token };
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * True if this URL almost certainly only resolves on the device that's
 * currently connected to it — e.g. a client that reached the daemon via
 * `http://127.0.0.1:4517` because the browser and daemon share a machine.
 * Showing THIS as a pairing QR looks fine but fails on any other device: it
 * scans a URL that means "myself" and points right back at itself, not at the
 * daemon. Used to warn before pairing, not to block it (a same-device scan —
 * e.g. an emulator — can still legitimately want this).
 */
export function isLikelyLoopbackUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}
