import { describeConnectionError } from "@renki/client-core";
import { useState } from "react";
import { type AppConfig, getOrCreateDeviceId } from "../lib/config.js";
import { Button } from "./ui.js";

/**
 * Point a client at a daemon and enter its token — used both for first-run
 * onboarding (full screen, no way to cancel: there's nothing to go back to
 * yet) and for adding a second host to switch between (a modal, with Cancel).
 *
 * `label` is the second thing add-host mode collects beyond `AppConfig`: it's
 * what this host is called in the switcher ("Mac", "Homelab"), which is a
 * different question from `deviceName` (what THIS device calls itself to
 * THAT daemon's other clients). Onboarding doesn't ask for it — with only one
 * host there's nothing to distinguish yet — so callers in that mode can
 * ignore the second argument.
 */
export function Setup({
  onSave,
  onCancel,
  mode = "onboarding",
}: {
  onSave: (config: AppConfig, label: string) => void;
  onCancel?: () => void;
  mode?: "onboarding" | "add-host";
}) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:4517");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [deviceName, setDeviceName] = useState("Web");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [found, setFound] = useState<{ repos: number; root: string } | null>(null);
  const adding = mode === "add-host";

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
      setError(describeConnectionError(e));
    } finally {
      setTesting(false);
    }
  }

  function continueSetup() {
    onSave({ baseUrl: baseUrl.replace(/\/$/, ""), token, deviceId: getOrCreateDeviceId(), deviceName }, label.trim());
  }

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="renki-enter w-full max-w-sm space-y-5 rounded-2xl border border-(--renki-border) bg-(--renki-surface) p-7 shadow-(--renki-shadow-lg)">
        <div className="space-y-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-(--renki-accent) text-(--renki-accent-fg) shadow-(--renki-shadow-sm)">
            <span className="codicon codicon-terminal text-xl" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-(--renki-fg)">
              {adding ? "Add another host" : "Connect to your daemon"}
            </h1>
            <p className="mt-1 text-sm text-(--renki-fg-muted)">
              {adding
                ? "Another daemon this device can switch to — your Mac, a second server. Uses the same take-control identity you already have."
                : "Point this browser at the Renki daemon on your homelab and paste its token."}
            </p>
          </div>
        </div>

        {adding && (
          <Field label="Name for this host (shown in the switcher)">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Mac, Homelab" className="renki-input" />
          </Field>
        )}

        <Field label="Daemon URL">
          <input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setFound(null);
            }}
            placeholder="http://homelab.tailnet:4517"
            className="renki-input"
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
              placeholder="RENKI_AUTH_TOKEN"
              className="renki-input min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="shrink-0 text-xs text-(--renki-fg-muted) hover:text-(--renki-fg)"
            >
              {showToken ? "Hide" : "Show"}
            </button>
          </div>
        </Field>
        <Field label="This device's name">
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} className="renki-input" />
        </Field>

        {error && <p className="rounded-lg border border-(--renki-danger)/30 bg-(--renki-danger)/10 px-3 py-2 text-sm text-(--renki-danger)">{error}</p>}

        {found && (
          <p className="rounded-lg border border-(--renki-success)/30 bg-(--renki-success)/10 px-3 py-2 text-sm text-(--renki-success)">
            Connected — found {found.repos} repo{found.repos === 1 ? "" : "s"} under{" "}
            <code className="text-(--renki-success)">{found.root}</code>.
            {found.repos === 0 && " Add a git repo there (or point RENKI_REPOS_ROOT elsewhere) before creating a session."}
          </p>
        )}

        <Button
          variant="primary"
          className="w-full"
          disabled={testing || !token}
          onClick={found ? continueSetup : submit}
        >
          {testing ? "Testing…" : found ? (adding ? "Add host" : "Continue") : "Connect"}
        </Button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="block w-full text-center text-xs text-(--renki-fg-muted) hover:text-(--renki-fg)"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-(--renki-fg-muted)">{label}</span>
      {children}
    </label>
  );
}
