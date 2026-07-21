import { useState } from "react";
import { type AppConfig, getOrCreateDeviceId } from "../lib/config.js";
import { Button } from "./ui.js";

/** First-run screen: point the client at your daemon and enter the token. */
export function Setup({ onSave }: { onSave: (config: AppConfig) => void }) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:4517");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [deviceName, setDeviceName] = useState("Web");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [found, setFound] = useState<{ repos: number; root: string } | null>(null);

  async function submit() {
    setError(null);
    setTesting(true);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/repos`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Error("Token rejected (401).");
      if (!res.ok) throw new Error(`Daemon responded ${res.status}.`);
      const body = (await res.json()) as { repos: unknown[]; root: string };
      setFound({ repos: body.repos.length, root: body.root });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the daemon.");
    } finally {
      setTesting(false);
    }
  }

  function continueSetup() {
    onSave({ baseUrl: baseUrl.replace(/\/$/, ""), token, deviceId: getOrCreateDeviceId(), deviceName });
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
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setFound(null);
            }}
            placeholder="http://homelab.tailnet:4517"
            className="input"
          />
        </Field>
        <Field label="Auth token">
          <div className="flex items-center gap-2">
            <input
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setFound(null);
              }}
              type={showToken ? "text" : "password"}
              placeholder="CRC_AUTH_TOKEN"
              className="input min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="shrink-0 text-xs text-neutral-500 hover:text-neutral-300"
            >
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
        </Field>
        <Field label="This device's name">
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} className="input" />
        </Field>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {found && (
          <p className="text-sm text-emerald-400">
            Connected — found {found.repos} repo{found.repos === 1 ? "" : "s"} under{" "}
            <code className="text-emerald-300">{found.root}</code>.
            {found.repos === 0 && " Add a git repo there (or point CRC_REPOS_ROOT elsewhere) before creating a session."}
          </p>
        )}

        <Button
          variant="primary"
          className="w-full"
          disabled={testing || !token}
          onClick={found ? continueSetup : submit}
        >
          {testing ? "Testing…" : found ? "Continue" : "Connect"}
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
