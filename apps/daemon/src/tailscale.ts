import { execFile } from "node:child_process";
import type { TailscaleStatusResponse } from "@crc/protocol";
import { logger } from "./logger.js";

/**
 * Best-effort read of this host's own Tailscale MagicDNS hostname, via the
 * local `tailscale` CLI. Used to SUGGEST a reachable pairing URL to a client
 * that's connected via an address unlikely to work for another device — a
 * loopback address (e.g. `http://127.0.0.1:4517`), or a private-CA'd LAN
 * hostname (e.g. Caddy's `tls internal`) that a native mobile app won't trust
 * even though a browser on the same machine does. Never required, never
 * throws — any failure (binary missing, not logged into a tailnet, etc.)
 * just reports unavailable.
 *
 * Pass this daemon's own port to also resolve `servePort`: the actual port
 * `tailscale serve` is fronting THIS daemon on, if any. Without knowing that,
 * a suggested `https://<hostname>` could point at nothing (serve not set up)
 * or at a different port than 443 (set up on an alternate port to avoid
 * colliding with another reverse proxy already on 443).
 */
export async function getTailscaleStatus(port?: number): Promise<TailscaleStatusResponse> {
  try {
    const raw = await run(["status", "--json"]);
    const dnsName = raw?.Self?.DNSName;
    if (typeof dnsName !== "string" || !dnsName) return { available: false, hostname: null, servePort: null };
    const hostname = dnsName.replace(/\.$/, "");
    const servePort = port !== undefined ? await findServePort(port) : null;
    return { available: true, hostname, servePort };
  } catch (err) {
    logger.debug("tailscale status unavailable", { err: String(err) });
    return { available: false, hostname: null, servePort: null };
  }
}

/** The external port (from a `Web` key like "host:port") whose handler proxies to this daemon's local port, if any. */
async function findServePort(localPort: number): Promise<number | null> {
  try {
    const raw = await run(["serve", "status", "--json"]);
    const web = raw?.Web;
    if (!web || typeof web !== "object") return null;

    const expected = `http://127.0.0.1:${localPort}`;
    for (const [key, hostConfig] of Object.entries(web) as [string, any][]) {
      if (hostConfig?.Handlers?.["/"]?.Proxy === expected) {
        const port = Number(key.split(":").pop());
        return Number.isFinite(port) ? port : null;
      }
    }
    return null;
  } catch (err) {
    logger.debug("tailscale serve status unavailable", { err: String(err) });
    return null;
  }
}

export type TailscaleServeConflict =
  | { conflicting: false }
  | { conflicting: true; existingProxyTarget: string };

/**
 * Checks `tailscale serve`'s OWN config for a root ("/") handler already
 * pointing somewhere other than this daemon's port, before `crc init` runs
 * `tailscale serve --bg <port>` — which would silently overwrite it. Caught
 * live: a homelab's reverse proxy (Caddy) bound to the same tailnet IP on
 * port 443 collided with `tailscale serve` claiming that address directly,
 * breaking the reverse proxy's *other* sites with no clear error. This check
 * only sees conflicts *tailscale serve itself* already knows about (a
 * different local app previously `tailscale serve`-d on this host) — it
 * can't see a separate program (like that Caddy) bound to the port outside
 * tailscale's own config, so the caller should warn generically regardless
 * of what this returns.
 */
export async function checkTailscaleServeConflict(port: number): Promise<TailscaleServeConflict> {
  try {
    const raw = await run(["serve", "status", "--json"]);
    const web = raw?.Web;
    if (!web || typeof web !== "object") return { conflicting: false };

    const expected = `http://127.0.0.1:${port}`;
    for (const hostConfig of Object.values(web) as any[]) {
      const proxy = hostConfig?.Handlers?.["/"]?.Proxy;
      if (typeof proxy === "string" && proxy !== expected) {
        return { conflicting: true, existingProxyTarget: proxy };
      }
    }
    return { conflicting: false };
  } catch (err) {
    logger.debug("tailscale serve status unavailable", { err: String(err) });
    return { conflicting: false };
  }
}

function run(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("tailscale", args, { timeout: 5_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.toString() || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}
