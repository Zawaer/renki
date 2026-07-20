import { execFile } from "node:child_process";
import type { TailscaleStatusResponse } from "@crc/protocol";
import { logger } from "./logger.js";

/**
 * Best-effort read of this host's own Tailscale MagicDNS hostname, via the
 * local `tailscale` CLI. Used only to SUGGEST a reachable pairing URL to a
 * client that's connected via a loopback address (e.g. a Mac browser on
 * `http://127.0.0.1:4517` showing a QR that would only work on itself) —
 * never required, and never throws. Any failure (binary missing, not logged
 * into a tailnet, etc.) just reports unavailable.
 */
export async function getTailscaleStatus(): Promise<TailscaleStatusResponse> {
  try {
    const raw = await run(["status", "--json"]);
    const dnsName = raw?.Self?.DNSName;
    if (typeof dnsName !== "string" || !dnsName) return { available: false, hostname: null };
    return { available: true, hostname: dnsName.replace(/\.$/, "") };
  } catch (err) {
    logger.debug("tailscale status unavailable", { err: String(err) });
    return { available: false, hostname: null };
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
