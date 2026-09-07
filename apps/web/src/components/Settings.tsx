import type { Account, AccountsResponse, RotationStatus } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { saveConfig } from "../lib/config.js";
import { useClient, useStoreValue } from "../lib/client.js";
import { UsageLimits } from "./UsageLimits.js";
import { PairDevice } from "./PairDevice.js";
import { UsageConnect } from "./UsageConnect.js";
import { Button, Skeleton } from "./ui.js";

/**
 * Everything about this connection that used to be scattered across the
 * header (pairing, disconnect) and an account dropdown (add/remove accounts)
 * lives here instead — one place for "how this client is set up," separate
 * from the session workspace itself.
 */
export function Settings({ onReset, managed }: { onReset: () => void; managed: boolean }) {
  const { realtime } = useClient();
  const status = useStoreValue(realtime.status);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-10">
        <h1 className="text-[22px] font-semibold tracking-tight text-(--crc-fg)">Settings</h1>
        <div className="mt-5 flex flex-col gap-4">
          <ThisDeviceSection />
          <ConnectionSection status={status} />
          <AccountsSection />
          {!managed && <PairSection />}
          {!managed && <DisconnectSection onReset={onReset} />}
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  danger,
  children,
}: {
  title: string;
  description: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-2xl bg-(--crc-surface) p-5 shadow-(--crc-shadow-sm) ${danger ? "ring-1 ring-(--crc-danger)/35" : ""}`}>
      <h2 className="text-[15px] font-semibold tracking-tight text-(--crc-fg)">{title}</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-(--crc-fg-muted)">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Label-above-control field, the one shape every form in Settings uses. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[11px] font-medium tracking-[0.12em] text-(--crc-fg-muted) uppercase">{children}</span>;
}

/** A key/value line — Connection's URL and token rows. */
function KeyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
      <span className="shrink-0 text-(--crc-fg-muted)">{label}</span>
      <span className="flex min-w-0 items-center gap-2 font-mono text-[12.5px] text-(--crc-fg)">{children}</span>
    </div>
  );
}

function ThisDeviceSection() {
  const { config } = useClient();
  const [name, setName] = useState(config.deviceName);
  const dirty = name.trim().length > 0 && name.trim() !== config.deviceName;

  function save() {
    saveConfig({ ...config, deviceName: name.trim() });
    window.location.reload();
  }

  return (
    <Card title="This device" description="How this browser identifies itself to the daemon and to your other devices.">
      <label className="block">
        <FieldLabel>Device name</FieldLabel>
        <div className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) save();
            }}
            className="crc-input min-w-0 flex-1 border-transparent bg-(--crc-bg-inset) px-3.5 py-2.5 text-[13.5px]"
          />
          {dirty && (
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          )}
        </div>
      </label>
    </Card>
  );
}

function ConnectionSection({ status }: { status: "connecting" | "open" | "closed" }) {
  const { config } = useClient();
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const badge =
    status === "open"
      ? { dot: "bg-(--crc-success)", tone: "text-(--crc-success)", label: "Connected" }
      : status === "connecting"
        ? { dot: "bg-(--crc-warning) animate-pulse", tone: "text-(--crc-warning)", label: "Connecting…" }
        : { dot: "bg-(--crc-danger)", tone: "text-(--crc-danger)", label: "Offline — reconnecting" };

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(config.baseUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context) — the URL is still readable on screen.
    }
  }

  return (
    <Card title="Connection" description="The daemon this browser talks to. Sessions run there, not here — closing this tab never stops them.">
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${badge.tone}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
        {badge.label}
      </span>
      <div className="mt-3 divide-y divide-(--crc-border)/60">
        <KeyRow label="Daemon URL">
          <span className="truncate">{config.baseUrl}</span>
          <button onClick={copyUrl} className="shrink-0 font-sans text-xs text-(--crc-link) hover:underline" title="Copy URL">
            {copied ? "Copied" : "Copy"}
          </button>
        </KeyRow>
        <KeyRow label="Auth token">
          <span className="truncate">{showToken ? config.token : "•".repeat(12)}</span>
          <button onClick={() => setShowToken((v) => !v)} className="shrink-0 font-sans text-xs text-(--crc-link) hover:underline">
            {showToken ? "Hide" : "Show"}
          </button>
          {status === "open" && (
            <span className="inline-flex shrink-0 items-center gap-1 font-sans text-xs text-(--crc-success)">
              <span className="codicon codicon-verified text-[12px]" /> verified
            </span>
          )}
        </KeyRow>
      </div>
    </Card>
  );
}

function PairSection() {
  return (
    <Card title="Pair a device" description="Show a QR code so a phone can join without typing the URL and token by hand.">
      <PairDevice />
    </Card>
  );
}

function DisconnectSection({ onReset }: { onReset: () => void }) {
  return (
    <Card
      danger
      title="Disconnect"
      description="Detach this browser from the daemon. Running sessions keep going on the host — you can reconnect anytime."
    >
      <Button variant="danger" onClick={onReset}>
        Disconnect this browser
      </Button>
    </Card>
  );
}

function AccountsSection() {
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);

  const refresh = useCallback(() => {
    rest.listAccounts().then(setData).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const accounts = data?.accounts ?? [];

  return (
    <Card
      title="Claude accounts"
      description="The Claude logins the daemon can run sessions as. One is active at a time. Connect usage tracking on an account to see its 5-hour and 7-day limits, and to let auto-switch move to whichever account still has headroom."
    >
      {!data ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading accounts">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl bg-(--crc-bg-inset)/70 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-1.5 w-1.5 rounded-full" />
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="ml-auto h-7 w-24 rounded-md" />
              </div>
              <div className="mt-3 flex gap-6 pl-4">
                <Skeleton className="h-1.5 flex-1 rounded-full" />
                <Skeleton className="h-1.5 flex-1 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <div className="rounded-xl bg-(--crc-bg-inset)/70 px-4 py-4 text-[13px] text-(--crc-fg-muted)">
          No accounts yet. Add a coding account below — it runs <code className="font-mono text-(--crc-fg)">cswap add-token</code> on the daemon host.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {accounts.map((a) => (
            <AccountRow
              key={a.number}
              account={a}
              usageConnected={data.usageConnectedEmails.includes(a.email.toLowerCase())}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {data && accounts.length > 1 && <RotationSettings rotation={data.rotation} onChanged={refresh} />}

      <div className="mt-5 flex flex-col items-start gap-2 text-[13px]">
        <UsageConnect configured={data?.usageConfigured ?? false} onConnected={refresh} />
        <AddCodingAccount onAdded={refresh} />
      </div>
    </Card>
  );
}

/** Auto-switch accounts once the active one's usage crosses a threshold — the policy `AccountRotator` polls for. */
function RotationSettings({ rotation, onChanged }: { rotation: RotationStatus; onChanged: () => void }) {
  const { rest } = useClient();
  const [threshold, setThreshold] = useState(String(rotation.threshold));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setThreshold(String(rotation.threshold));
  }, [rotation.threshold]);

  async function toggleEnabled() {
    setBusy(true);
    try {
      await rest.updateRotation({ enabled: !rotation.enabled });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function saveThreshold() {
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 1 || n > 100) return;
    setBusy(true);
    try {
      await rest.updateRotation({ threshold: n });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const thresholdDirty = threshold.trim() !== "" && Number(threshold) !== rotation.threshold;

  return (
    <div className="mt-4 rounded-xl bg-(--crc-bg-inset)/70 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-(--crc-fg)">Auto-switch accounts</div>
          <div className="mt-0.5 text-xs text-(--crc-fg-muted)">
            When the active account's 5-hour or 7-day usage crosses the threshold, switch to one with headroom. Never mid-turn.
          </div>
        </div>
        <Switch checked={rotation.enabled} disabled={busy} onChange={toggleEnabled} label="Auto-switch accounts" />
      </div>
      {rotation.enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--crc-border)/60 pt-3 text-[13px]">
          <span className="text-(--crc-fg-muted)">Switch at</span>
          <input
            type="number"
            min={1}
            max={100}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && thresholdDirty) saveThreshold();
            }}
            className="crc-input w-20 border-transparent bg-(--crc-surface) px-2.5 py-1.5 font-mono text-[12.5px]"
          />
          <span className="text-(--crc-fg-muted)">% of either window</span>
          {thresholdDirty && (
            <Button variant="primary" size="sm" onClick={saveThreshold}>
              Save
            </Button>
          )}
          {rotation.lastHoldReason && (
            <span className="ml-auto text-xs text-(--crc-fg-muted)">Holding: {rotation.lastHoldReason}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-(--crc-accent)" : "bg-(--crc-border)"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-(--crc-surface) shadow-(--crc-shadow-xs) transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function AccountRow({
  account,
  usageConnected,
  onChanged,
}: {
  account: Account;
  usageConnected: boolean;
  onChanged: () => void;
}) {
  const { rest } = useClient();
  const [busy, setBusy] = useState<null | "switch" | "disconnect">(null);

  async function makeActive() {
    setBusy("switch");
    try {
      const res = await rest.switchAccount(account.number);
      if (!res.ok && res.message) alert(res.message);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function disconnectUsage() {
    if (!confirm(`Stop tracking usage for ${account.email}?`)) return;
    setBusy("disconnect");
    try {
      await rest.disconnectUsageKey(account.email);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <div className={`rounded-xl px-4 py-3 ${account.active ? "bg-(--crc-bg-inset)/70 ring-1 ring-(--crc-accent)/30" : "bg-(--crc-bg-inset)/70"}`}>
      <div className="flex items-center gap-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${account.active ? "bg-(--crc-success)" : "bg-(--crc-fg-muted)/60"}`} />
        <span className="truncate text-[13px] text-(--crc-fg)">{account.email}</span>
        {account.active && <span className="text-xs font-medium text-(--crc-success)">Active</span>}
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          {usageConnected && (
            <button
              onClick={disconnectUsage}
              disabled={busy !== null}
              title="Stop tracking usage for this account"
              className="text-(--crc-fg-muted) hover:text-(--crc-danger) disabled:opacity-40"
            >
              {busy === "disconnect" ? "…" : "Stop tracking"}
            </button>
          )}
          {!account.active && (
            <Button variant="default" size="sm" onClick={makeActive} disabled={busy !== null}>
              {busy === "switch" ? "Switching…" : "Make active"}
            </Button>
          )}
        </div>
      </div>
      {account.usage ? (
        <UsageLimits usage={account.usage} className="mt-3 pl-4" />
      ) : (
        <div className="mt-1.5 pl-4 text-xs text-(--crc-fg-muted)">
          {account.usageError ??
            (usageConnected ? "Usage not available right now." : "Usage not tracked — connect it below to see limits.")}
        </div>
      )}
    </div>
  );
}

/**
 * Register a brand-new coding account via `cswap add-token` — a value
 * printed by `claude setup-token`, or a plain Anthropic Console API key.
 * Distinct from the usage-tracking key above: this is the credential the
 * official `claude` CLI actually runs inference with.
 */
function AddCodingAccount({ onAdded }: { onAdded: () => void }) {
  const { rest } = useClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await rest.addSetupTokenAccount(trimmed);
      if (res.ok) {
        setMsg({ ok: true, text: res.email ? `Added ${res.email}.` : "Account added." });
        setToken("");
        onAdded();
      } else {
        setMsg({ ok: false, text: res.message ?? "Couldn't add that account." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-(--crc-link) hover:underline">
        <span className="codicon codicon-add text-[12px]" /> Add coding account
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl bg-(--crc-bg-inset)/70 p-3.5 text-xs">
      <p className="text-[12.5px] leading-relaxed text-(--crc-fg-muted)">
        Paste the output of <code className="font-mono text-(--crc-fg)">claude setup-token</code>, or a plain Anthropic Console API
        key. This runs <code className="font-mono text-(--crc-fg)">cswap add-token</code> on the daemon host.
      </p>
      <textarea
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="sk-ant-…"
        spellCheck={false}
        rows={2}
        className="crc-input w-full resize-none border-transparent bg-(--crc-surface) font-mono text-[12px]"
      />
      <div className="flex items-center justify-between">
        <button onClick={() => setOpen(false)} className="text-(--crc-fg-muted) hover:text-(--crc-fg)">
          Cancel
        </button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || token.trim().length === 0}>
          {busy ? "Adding…" : "Add account"}
        </Button>
      </div>
      {msg && <p className={msg.ok ? "text-(--crc-success)" : "text-(--crc-danger)"}>{msg.text}</p>}
    </div>
  );
}
