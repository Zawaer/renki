/**
 * A fetch that never even reaches the network layer (DNS failure, connection
 * refused, no route) throws a generic, unhelpful message that differs per
 * engine — none of them say why. In practice the daemon here is almost always
 * only reachable over Tailscale (or another VPN), so an off VPN is the most
 * common real cause; surface that guess instead of a bare "network request
 * failed".
 */
const GENERIC_NETWORK_ERROR_PATTERNS = [
  /network request failed/i, // React Native
  /failed to fetch/i, // Chrome/Edge
  /networkerror when attempting to fetch/i, // Firefox
  /load failed/i, // Safari
];

function isGenericNetworkError(message: string): boolean {
  return GENERIC_NETWORK_ERROR_PATTERNS.some((re) => re.test(message));
}

/** Turns a caught connection error into a message worth showing a user, appending a VPN hint for the generic case. */
export function describeConnectionError(e: unknown, fallback = "Could not reach the daemon."): string {
  const message = e instanceof Error ? e.message : fallback;
  return isGenericNetworkError(message) ? `${message} Is Tailscale (or your VPN) turned on?` : message;
}

/** Tailscale's own address space (100.64.0.0/10) and MagicDNS names. */
function isTailscaleHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  if (/\.ts\.net$/i.test(host)) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/**
 * What to say when the daemon can't be reached for a while — chats won't load
 * or update until it can. The app can't tell a VPN that's off from a daemon
 * that's down, so it names the likely one first: Tailscale, when the host is
 * a Tailscale address.
 */
export function describeUnreachable(baseUrl: string): { title: string; body: string; viaTailscale: boolean } {
  const viaTailscale = isTailscaleHost(baseUrl);
  return {
    title: "Can't reach your Renki host",
    body: viaTailscale
      ? "Chats won't load or update until it's back. Is Tailscale connected on this device? If it is, the daemon on your host may be down."
      : "Chats won't load or update until it's back. Check this device's connection, and that the daemon on your host is running.",
    viaTailscale,
  };
}

/** How long the connection must be down before saying so — long enough to ride out a network switch. */
export const UNREACHABLE_AFTER_MS = 8_000;
