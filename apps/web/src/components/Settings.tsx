import type { Account, AccountsResponse } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { saveConfig } from "../lib/config.js";
import { useClient, useStoreValue } from "../lib/client.js";
import { ExtraUsageMeter, Meter } from "./AccountsBar.js";
import { PairDevice } from "./PairDevice.js";
import { UsageConnect } from "./UsageConnect.js";
import { Button } from "./ui.js";

/**
 * Everything about this connection that used to be scattered across the
 * header (pairing, disconnect) and an account dropdown (add/remove accounts)
 * lives here instead — one place for "how this client is set up," separate
 * from the session workspace itself.
 */
export function Settings({ onReset, managed }: { onReset: () => void; managed: boolean }) {
  const { config, realtime } = useClient();
  const status = useStoreValue(realtime.status);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-6">
      <h1 className="mb-4 text-sm font-semibold text-(--crc-fg)">Settings</h1>
      <div className="space-y-6">
        <ThisDeviceSection />
        <ConnectionSection status={status} />
        <AccountsSection />
        {!managed && <PairSection />}
        {!managed && <DisconnectSection onReset={onReset} />}
      </div>
    </div>
  );
}

function Section({ title, description, danger, children }: { title: string; description: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <section
      className={`rounded-sm border p-4 ${danger ? "border-(--crc-danger)/40 bg-(--crc-danger)/5" : "border-(--crc-border) bg-(--crc-bg-elevated)"}`}
    >
      <h2 className="text-sm font-semibold text-(--crc-fg)">{title}</h2>
      <p className="mt-1 text-xs text-(--crc-fg-muted)">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
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
    <Section title="This device" description="How this browser identifies itself to the daemon and other clients.">
      <label className="block space-y-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-(--crc-fg-muted)">Device name</span>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) px-3 py-1.5 text-sm text-(--crc-fg) outline-none focus:border-(--crc-focus)"
          />
          {dirty && (
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          )}
        </div>
      </label>
    </Section>
  );
}

function ConnectionSection({ status }: { status: "connecting" | "open" | "closed" }) {
  const { config } = useClient();
  const [showToken, setShowToken] = useState(false);
  const badge =
    status === "open"
      ? { color: "bg-(--crc-success)", label: "Connected" }
      : status === "connecting"
        ? { color: "bg-(--crc-warning) animate-pulse", label: "Connecting" }
        : { color: "bg-(--crc-danger)", label: "Offline" };

  return (
    <Section title="Connection" description="The daemon this client is attached to.">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-(--crc-border) px-2 py-0.5 text-(--crc-fg-muted)">
          <span className={`h-1.5 w-1.5 rounded-full ${badge.color}`} />
          {badge.label}
        </span>
      </div>
      <dl className="space-y-2 text-xs">
        <div className="flex items-center justify-between gap-3 border-t border-(--crc-border) pt-2">
          <dt className="shrink-0 text-(--crc-fg-muted)">Daemon URL</dt>
          <dd className="truncate font-mono text-(--crc-fg)">{config.baseUrl}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-(--crc-border) pt-2">
          <dt className="shrink-0 text-(--crc-fg-muted)">Auth token</dt>
          <dd className="flex items-center gap-2 font-mono text-(--crc-fg)">
            <span>{showToken ? config.token : "•".repeat(12)}</span>
            <button onClick={() => setShowToken((v) => !v)} className="font-sans text-(--crc-link) hover:underline">
              {showToken ? "Hide" : "Show"}
            </button>
            {status === "open" && <span className="text-(--crc-success)">verified</span>}
          </dd>
        </div>
      </dl>
    </Section>
  );
}

function PairSection() {
  return (
    <Section title="Pair a device" description="Show a QR code so a phone can join this session without typing the URL and token by hand.">
      <PairDevice />
    </Section>
  );
}

function DisconnectSection({ onReset }: { onReset: () => void }) {
  return (
    <Section
      danger
      title="Disconnect"
      description="Detach this browser from the daemon. Running sessions keep going on the host — you can reconnect anytime."
    >
      <Button variant="danger" onClick={onReset}>
        Disconnect
      </Button>
    </Section>
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

  return (
    <Section
      title="Accounts"
      description="Coding accounts cswap rotates the claude CLI's credentials across, and the claude.ai key used to read usage %."
    >
      {!data || data.accounts.length === 0 ? (
        <p className="text-xs text-(--crc-fg-muted)">
          No coding accounts registered with cswap yet — add one below, or see SETUP.md.
        </p>
      ) : (
        <div className="space-y-3">
          {data.accounts.map((a) => (
            <AccountRow
              key={a.number}
              account={a}
              usageConnected={data.usageConnectedEmails.includes(a.email.toLowerCase())}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-(--crc-border) pt-3">
        <UsageConnect configured={data?.usageConfigured ?? false} onConnected={refresh} />
      </div>

      <AddCodingAccount onAdded={refresh} />
    </Section>
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
    if (!confirm(`Stop tracking usage % for ${account.email}?`)) return;
    setBusy("disconnect");
    try {
      await rest.disconnectUsageKey(account.email);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <div className="rounded-sm border border-(--crc-border) p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${account.active ? "bg-(--crc-success)" : "bg-(--crc-fg-muted)"}`} />
        <span className="truncate text-(--crc-fg)">{account.email}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {usageConnected && (
            <button
              onClick={disconnectUsage}
              disabled={busy !== null}
              title="Stop tracking usage % for this account"
              className="text-(--crc-fg-muted) hover:text-(--crc-danger) disabled:opacity-40"
            >
              {busy === "disconnect" ? "…" : "Stop tracking"}
            </button>
          )}
          {!account.active && (
            <button
              onClick={makeActive}
              disabled={busy !== null}
              className="text-(--crc-link) hover:underline disabled:opacity-40"
            >
              {busy === "switch" ? "…" : "Make active"}
            </button>
          )}
        </div>
      </div>
      {account.usage ? (
        <div className="mt-1.5 space-y-1 pl-3">
          <div className="flex gap-2">
            <Meter label="5h" pct={account.usage.fiveHour.pct} resetsAt={account.usage.fiveHour.resetsAt} />
            <Meter label="7d" pct={account.usage.sevenDay.pct} resetsAt={account.usage.sevenDay.resetsAt} />
          </div>
          {account.usage.extra && <ExtraUsageMeter extra={account.usage.extra} />}
        </div>
      ) : (
        <div className="pl-3 text-[11px] text-(--crc-fg-muted)">usage n/a</div>
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
      <button onClick={() => setOpen(true)} className="mt-3 block text-[11px] text-(--crc-link) hover:underline">
        + Add coding account
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) p-2.5 text-xs">
      <p className="text-[11px] text-(--crc-fg-muted)">
        Paste the output of <code className="text-(--crc-fg)">claude setup-token</code>, or a plain Anthropic Console
        API key. Runs <code className="text-(--crc-fg)">cswap add-token</code> on the daemon host.
      </p>
      <textarea
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="sk-ant-…"
        spellCheck={false}
        rows={2}
        className="w-full resize-none rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) px-2 py-1.5 font-mono text-[11px] text-(--crc-fg) outline-none focus:border-(--crc-focus)"
      />
      <div className="flex items-center justify-between">
        <button onClick={() => setOpen(false)} className="text-(--crc-fg-muted) hover:underline">
          Close
        </button>
        <button
          onClick={submit}
          disabled={busy || token.trim().length === 0}
          className="rounded-sm border border-(--crc-border) px-2.5 py-1 text-(--crc-fg) hover:bg-(--crc-hover) disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add account"}
        </button>
      </div>
      {msg && <p className={msg.ok ? "text-(--crc-success)" : "text-(--crc-danger)"}>{msg.text}</p>}
    </div>
  );
}
