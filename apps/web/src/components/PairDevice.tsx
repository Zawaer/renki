import { encodePairing } from "@crc/client-core";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useClient } from "../lib/client.js";

/**
 * "Pair a device" — renders this browser's own working { baseUrl, token } as a
 * QR code. Another device (typically the phone) scans it to skip typing a
 * tailnet URL and a 43-char token by hand. This client is the right source: it
 * already has a URL that's proven reachable, which the daemon itself can't
 * know (LAN IP vs tailnet hostname vs custom domain is an operator choice).
 */
export function PairDevice() {
  const { config } = useClient();
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const payload = encodePairing({ baseUrl: config.baseUrl, token: config.token });
    QRCode.toDataURL(payload, { width: 280, margin: 1 })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [open, config.baseUrl, config.token]);

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
