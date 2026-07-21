import { encodePairing, isLikelyLoopbackUrl } from "@crc/client-core";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { saveConfig } from "../lib/config.js";
import { useClient } from "../lib/client.js";

/**
 * "Pair a device" — renders this browser's own working { baseUrl, token } as a
 * QR code. Another device (typically the phone) scans it to skip typing a
 * tailnet URL and a 43-char token by hand. This client is the right source: it
 * already has a URL that's proven reachable, which the daemon itself can't
 * know (LAN IP vs tailnet hostname vs custom domain is an operator choice).
 *
 * Two cases where this browser's own address isn't a good fit for the QR:
 *  - Loopback (e.g. http://127.0.0.1:4517) — means "this computer," so
 *    another device scanning it would just try to reach itself.
 *  - A private-CA'd LAN hostname (e.g. Caddy's `tls internal`) — this
 *    browser trusts it because someone manually installed the CA, but a
 *    native mobile app has its own separate trust store that doesn't
 *    automatically include manually-installed CAs (notably Android, since
 *    API 24) even though the phone's own browser would trust it fine.
 * Rather than just fail silently on the other device, ask the daemon (same
 * host, so it can check its own `tailscale status`) for a real, publicly
 * certified address and offer to use it instead.
 */
export function PairDevice() {
  const { config, rest } = useClient();
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const loopback = isLikelyLoopbackUrl(config.baseUrl);
  const [suggestion, setSuggestion] = useState<"loading" | "none" | string>("loading");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // What the QR actually encodes, if different from this browser's own address —
  // set by "Use this for the QR" below, without touching this browser's own connection.
  const [qrOverride, setQrOverride] = useState<string | null>(null);

  const qrBaseUrl = qrOverride ?? config.baseUrl;
  const normalize = (u: string) => u.replace(/\/$/, "");
  const suggestionUsable = suggestion !== "loading" && suggestion !== "none";
  const suggestionDiffers = suggestionUsable && normalize(suggestion) !== normalize(config.baseUrl);

  useEffect(() => {
    if (!open) return;
    const payload = encodePairing({ baseUrl: qrBaseUrl, token: config.token });
    QRCode.toDataURL(payload, { width: 280, margin: 1 })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [open, qrBaseUrl, config.token]);

  useEffect(() => {
    if (!open) return;
    setSuggestion("loading");
    setQrOverride(null);
    rest
      .getTailscaleStatus()
      .then((s) => {
        if (!s.available || !s.hostname || !s.servePort) return setSuggestion("none");
        setSuggestion(`https://${s.hostname}${s.servePort === 443 ? "" : `:${s.servePort}`}`);
      })
      .catch(() => setSuggestion("none"));
  }, [open, rest]);

  async function reconnectUsing(url: string) {
    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch(`${url}/repos`, { headers: { authorization: `Bearer ${config.token}` } });
      if (!res.ok) throw new Error(`Daemon responded ${res.status} at ${url}.`);
      saveConfig({ ...config, baseUrl: url });
      window.location.reload();
    } catch {
      setSwitchError(
        `Could not reach ${url}. Make sure "tailscale serve --bg <port>" is running on the daemon host.`,
      );
      setSwitching(false);
    }
  }

  return (
    <>
      <button className="hover:text-neutral-300" onClick={() => setOpen(true)}>
        Pair a device
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-sm font-medium text-neutral-200">Scan with the CRC phone app</span>
            {loopback && (
              <div className="max-w-70 space-y-2 rounded-md border border-amber-800 bg-amber-950/40 px-2.5 py-2 text-[11px] leading-snug text-amber-300">
                <p>
                  This browser is connected via <code>{config.baseUrl}</code> — a loopback address that
                  only means "this computer." A phone scanning this QR would try to reach itself and fail.
                </p>
                {suggestion === "loading" && <p className="text-amber-400/70">Checking Tailscale…</p>}
                {suggestion === "none" && (
                  <p>
                    Couldn't detect a Tailscale address on the daemon host. Reconnect this browser using
                    its tailnet URL manually (Disconnect, then enter{" "}
                    <code>https://your-machine.tailnet.ts.net</code>), then show the QR again.
                  </p>
                )}
                {suggestionUsable && (
                  <>
                    <p>
                      Detected: <code>{suggestion}</code>
                    </p>
                    <button
                      onClick={() => reconnectUsing(suggestion)}
                      disabled={switching}
                      className="w-full rounded-md bg-amber-800/60 py-1 text-amber-100 hover:bg-amber-800 disabled:opacity-50"
                    >
                      {switching ? "Reconnecting…" : "Reconnect using this address"}
                    </button>
                    {switchError && <p className="text-red-400">{switchError}</p>}
                  </>
                )}
              </div>
            )}
            {!loopback && suggestionDiffers && (
              <div className="max-w-70 space-y-2 rounded-md border border-neutral-700 bg-neutral-800/50 px-2.5 py-2 text-[11px] leading-snug text-neutral-300">
                {qrOverride ? (
                  <>
                    <p>
                      This QR now points at <code>{qrOverride}</code> instead of{" "}
                      <code>{config.baseUrl}</code> — this browser's own connection is unaffected.
                    </p>
                    <button
                      onClick={() => setQrOverride(null)}
                      className="w-full rounded-md border border-neutral-600 py-1 text-neutral-200 hover:bg-neutral-700"
                    >
                      Use {config.baseUrl} instead
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      Pairing a phone that won't trust <code>{config.baseUrl}</code>'s certificate (common on
                      Android, if that address goes through a reverse proxy's own private CA)? Use the
                      Tailscale address instead — no certificate to install:
                    </p>
                    <p>
                      <code>{suggestion}</code>
                    </p>
                    <button
                      onClick={() => setQrOverride(suggestion)}
                      className="w-full rounded-md border border-neutral-600 py-1 text-neutral-200 hover:bg-neutral-700"
                    >
                      Use this for the QR
                    </button>
                  </>
                )}
              </div>
            )}
            {dataUrl ? (
              <img src={dataUrl} alt="Pairing QR code" width={280} height={280} className="rounded-lg" />
            ) : (
              <div className="flex h-[280px] w-[280px] items-center justify-center text-xs text-neutral-600">
                Generating…
              </div>
            )}
            <span className="text-[11px] text-neutral-600">
              Setup → Scan QR. Grants the same access this browser has.
            </span>
            <button
              className="mt-1 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
