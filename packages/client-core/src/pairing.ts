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
