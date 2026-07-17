import { useState } from "react";
import { type AppConfig, getOrCreateDeviceId } from "../lib/config.js";
import { Button } from "./ui.js";

/** First-run screen: point the client at your daemon and enter the token. */
export function Setup({ onSave }: { onSave: (config: AppConfig) => void }) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:4517");
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState("Web");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function submit() {
    setError(null);
    setTesting(true);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/repos`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Error("Token rejected (401).");
      if (!res.ok) throw new Error(`Daemon responded ${res.status}.`);
      onSave({ baseUrl: baseUrl.replace(/\/$/, ""), token, deviceId: getOrCreateDeviceId(), deviceName });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the daemon.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
        <div>
          <h1 className="text-lg font-semibold">Connect to your daemon</h1>
          <p className="mt-1 text-sm text-neutral-400">Enter the address and token of your homelab daemon.</p>
        </div>

        <Field label="Daemon URL">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://homelab.tailnet:4517"
            className="input"
          />
        </Field>
        <Field label="Auth token">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="CRC_AUTH_TOKEN"
            className="input"
          />
        </Field>
        <Field label="This device's name">
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} className="input" />
        </Field>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <Button variant="primary" className="w-full" disabled={testing || !token} onClick={submit}>
          {testing ? "Testing…" : "Connect"}
        </Button>

        <style>{`.input{width:100%;border-radius:0.5rem;border:1px solid #262626;background:#0b0d10;padding:0.5rem 0.75rem;font-size:0.875rem;color:#e5e7eb;outline:none}.input:focus{border-color:#4f46e5}`}</style>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      {children}
    </label>
  );
}
