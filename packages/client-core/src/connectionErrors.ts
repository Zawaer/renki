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
