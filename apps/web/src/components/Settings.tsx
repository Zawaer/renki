import { removeHost, updateHost, type HostsState } from "@renki/client-core";
import { PALETTES, resolvePalette, type PaletteKey } from "@renki/client-core";
import type { Account, AccountsResponse, RotationStatus } from "@renki/protocol";
import { useCallback, useEffect, useState } from "react";
import { saveConfig } from "../lib/config.js";
import { loadHosts, saveHosts } from "../lib/hosts.js";
import { isHosted } from "../lib/host.js";
import { loadPalette, savePalette } from "../lib/palette.js";
import { useClient, useStoreValue } from "../lib/client.js";
import { UsageLimits } from "./UsageLimits.js";
import { AddHostModal } from "./AddHostModal.js";
import { PairDevice } from "./PairDevice.js";
import { UsageConnect } from "./UsageConnect.js";
import { Button, Select, Skeleton } from "./ui.js";

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
        <h1 className="text-[22px] font-semibold tracking-tight text-(--renki-fg)">Settings</h1>
        <div className="mt-5 flex flex-col gap-4">
          <AppearanceSection managed={managed} />
          {!managed && <HostsSection />}
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
    <section className={`rounded-2xl bg-(--renki-surface) p-5 shadow-(--renki-shadow-sm) ${danger ? "ring-1 ring-(--renki-danger)/35" : ""}`}>
      <h2 className="text-[15px] font-semibold tracking-tight text-(--renki-fg)">{title}</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-(--renki-fg-muted)">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Label-above-control field, the one shape every form in Settings uses. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[11px] font-medium tracking-[0.12em] text-(--renki-fg-muted) uppercase">{children}</span>;
}

/** A key/value line — Connection's URL and token rows. */
function KeyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
      <span className="shrink-0 text-(--renki-fg-muted)">{label}</span>
      <span className="flex min-w-0 items-center gap-2 font-mono text-[12.5px] text-(--renki-fg)">{children}</span>
    </div>
  );
}

/**
 * The accent palette. Light/dark still follows the OS — this is the orthogonal
 * choice of what the accent is, and each palette covers both.
 *
 * Hidden inside the VS Code webview, where the host's own theme drives every
 * token (see the body.vscode-* block in index.css): offering a picker that a
 * higher-specificity rule overrules would just look broken.
 */
function AppearanceSection({ managed }: { managed: boolean }) {
  const [palette, setPalette] = useState<PaletteKey>(loadPalette);
  if (managed || isHosted()) return null;

  return (
    <Card title="Appearance" description="Light and dark follow your system. This is the accent on top of it.">
      <div className="flex flex-col gap-1.5">
        <FieldLabel>Accent</FieldLabel>
        <Select
          value={palette}
          options={PALETTES.map((p) => ({ value: p.key, label: p.label, description: p.description }))}
          onChange={(next) => {
            const key = resolvePalette(next);
            setPalette(key);
            savePalette(key);
          }}
        />
      </div>
    </Card>
  );
}

/**
 * Every daemon this browser knows about, with switch/rename/remove — the
 * management view behind the sidebar's quick switcher. Not shown when
 * managed (VS Code): that connection belongs to the workspace's own settings,
 * not a list this screen owns.
 */
function HostsSection() {
  const [state, setState] = useState(loadHosts);
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function persist(next: HostsState) {
    saveHosts(next);
    setState(next);
  }

  function switchTo(id: string) {
    if (id === state.activeId) return;
    saveHosts({ ...state, activeId: id });
    window.location.reload();
  }

  function commitRename(id: string) {
    const label = draft.trim();
    setRenamingId(null);
    if (!label) return;
    persist(updateHost(state, id, { label }));
  }

  function remove(id: string, label: string) {
    if (state.hosts.length === 1) {
      if (!confirm(`Remove ${label}? This is your only host, so you'll see the setup screen again.`)) return;
    } else if (!confirm(`Remove ${label} from your host list?`)) {
      return;
    }
    const next = removeHost(state, id);
    saveHosts(next);
    if (id === state.activeId) window.location.reload();
    else setState(next);
  }

  return (
    <Card
      title="Hosts"
      description="Every daemon this browser can switch to — a homelab box, a laptop, wherever Renki is running. Switching doesn't re-pair anything."
    >
      <div className="flex flex-col gap-2">
        {state.hosts.map((h) => (
          <div
            key={h.id}
            className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 ${h.id === state.activeId ? "bg-(--renki-bg-inset)" : ""}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${h.id === state.activeId ? "bg-(--renki-success)" : "bg-(--renki-fg-muted)/40"}`} />
            {renamingId === h.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(h.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") setRenamingId(null);
                }}
                className="renki-input min-w-0 flex-1 border-transparent bg-(--renki-surface) px-2 py-1 text-[13px]"
              />
            ) : (
              <button
                onClick={() => switchTo(h.id)}
                className="min-w-0 flex-1 truncate text-left text-[13px] text-(--renki-fg)"
                title={h.baseUrl}
              >
                {h.label}
                <span className="ml-2 truncate font-mono text-[11px] text-(--renki-fg-muted)">{h.baseUrl}</span>
              </button>
            )}
            {renamingId !== h.id && (
              <button
                onClick={() => {
                  setDraft(h.label);
                  setRenamingId(h.id);
                }}
                title="Rename"
                className="shrink-0 rounded-md p-1 text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)"
              >
                <span className="codicon codicon-edit text-[13px]" />
              </button>
            )}
            <button
              onClick={() => remove(h.id, h.label)}
              title="Remove"
              className="shrink-0 rounded-md p-1 text-(--renki-fg-muted) hover:bg-(--renki-danger)/12 hover:text-(--renki-danger)"
            >
              <span className="codicon codicon-trash text-[13px]" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => setAdding(true)}
        className="mt-2.5 flex items-center gap-1.5 text-[13px] text-(--renki-link) hover:underline"
      >
        <span className="codicon codicon-add text-[12px]" /> Add another host
      </button>
      {adding && <AddHostModal state={state} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function ThisDeviceSection() {
  const { config } = useClient();
  const [name, setName] = useState(config.deviceName);
  const dirty = name.trim().length > 0 && name.trim() !== config.deviceName;

  function save() {
    // A host-backed connection persists the rename into its host record —
    // saveConfig alone would write to a legacy key nothing reads back once a
    // host list exists. Only a VS Code-injected connection (no hostId) has no
    // host list to update, so it falls back to the old single-config key.
    if (config.hostId) saveHosts(updateHost(loadHosts(), config.hostId, { deviceName: name.trim() }));
    else saveConfig({ ...config, deviceName: name.trim() });
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
            className="renki-input min-w-0 flex-1 border-transparent bg-(--renki-bg-inset) px-3.5 py-2.5 text-[13.5px]"
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
      ? { dot: "bg-(--renki-success)", tone: "text-(--renki-success)", label: "Connected" }
      : status === "connecting"
        ? { dot: "bg-(--renki-warning) animate-pulse", tone: "text-(--renki-warning)", label: "Connecting…" }
        : { dot: "bg-(--renki-danger)", tone: "text-(--renki-danger)", label: "Offline — reconnecting" };

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
      <div className="mt-3 divide-y divide-(--renki-border)/60">
        <KeyRow label="Daemon URL">
          <span className="truncate">{config.baseUrl}</span>
          <button onClick={copyUrl} className="shrink-0 font-sans text-xs text-(--renki-link) hover:underline" title="Copy URL">
            {copied ? "Copied" : "Copy"}
          </button>
        </KeyRow>
        <KeyRow label="Auth token">
          <span className="truncate">{showToken ? config.token : "•".repeat(12)}</span>
          <button onClick={() => setShowToken((v) => !v)} className="shrink-0 font-sans text-xs text-(--renki-link) hover:underline">
            {showToken ? "Hide" : "Show"}
          </button>
          {status === "open" && (
            <span className="inline-flex shrink-0 items-center gap-1 font-sans text-xs text-(--renki-success)">
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
            <div key={i} className="rounded-xl bg-(--renki-bg-inset)/70 px-4 py-3">
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
        <div className="rounded-xl bg-(--renki-bg-inset)/70 px-4 py-4 text-[13px] text-(--renki-fg-muted)">
          No accounts yet. Add a coding account below — it runs <code className="font-mono text-(--renki-fg)">cswap add-token</code> on the daemon host.
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

      {data && accounts.length > 1 && <RotationSettings rotation={data.rotation} accounts={accounts} onChanged={refresh} />}

      <div className="mt-5 flex flex-col items-start gap-2 text-[13px]">
        <UsageConnect configured={data?.usageConfigured ?? false} onConnected={refresh} />
        <AddCodingAccount onAdded={refresh} />
      </div>
    </Card>
  );
}

/** Auto-switch accounts once the active one's usage crosses a threshold — the policy `AccountRotator` polls for. */
function RotationSettings({
  rotation,
  accounts,
  onChanged,
}: {
  rotation: RotationStatus;
  accounts: Account[];
  onChanged: () => void;
}) {
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

  async function savePreferred(email: string) {
    setBusy(true);
    try {
      await rest.updateRotation({ preferredEmail: email || null });
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
    <div className="mt-4 rounded-xl bg-(--renki-bg-inset)/70 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-(--renki-fg)">Auto-switch accounts</div>
          <div className="mt-0.5 text-xs text-(--renki-fg-muted)">
            When the active account's 5-hour or 7-day usage crosses the threshold, switch to one with headroom. Never mid-turn.
          </div>
        </div>
        <Switch checked={rotation.enabled} disabled={busy} onChange={toggleEnabled} label="Auto-switch accounts" />
      </div>
      {rotation.enabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--renki-border)/60 pt-3 text-[13px]">
          <span className="text-(--renki-fg-muted)">Switch at</span>
          <input
            type="number"
            min={1}
            max={100}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && thresholdDirty) saveThreshold();
            }}
            className="renki-input w-20 border-transparent bg-(--renki-surface) px-2.5 py-1.5 font-mono text-[12.5px]"
          />
          <span className="text-(--renki-fg-muted)">% of either window</span>
          {rotation.lastHoldReason && (
            <span className="ml-auto text-xs text-(--renki-fg-muted)">Holding: {rotation.lastHoldReason}</span>
          )}
          {thresholdDirty && (
            <Button variant="primary" size="sm" onClick={saveThreshold}>
              Save
            </Button>
          )}
        </div>
      )}
      {rotation.enabled && accounts.length > 1 && (
        <div className="mt-3 border-t border-(--renki-border)/60 pt-3">
          <div className="text-[13px] text-(--renki-fg-muted)">Prefer</div>
          <div className="mt-2">
            <Select
              value={rotation.preferredEmail ?? ""}
              onChange={savePreferred}
              options={[
                { value: "", label: "No preference", description: "Use whichever account has headroom" },
                ...accounts.map((a) => ({ value: a.email.toLowerCase(), label: a.email, description: "Run as this account whenever it has headroom" })),
              ]}
            />
          </div>
          <div className="mt-2 text-xs text-(--renki-fg-muted)">
            {rotation.preferredEmail
              ? "Sessions run as this account whenever it has headroom, borrow another only while it's over the threshold, and come back as soon as it resets — so the other account's quota stays free for use elsewhere."
              : "Any account with headroom will do."}
          </div>
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
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-(--renki-accent)" : "bg-(--renki-border)"}`}
    >
      {/*
        * left-0.5 is load-bearing: with no inset the knob takes its *static*
        * position, which is already 20px into a 40px track, so the "on"
        * translate pushed it clean outside the pill. Anchored at 2px, the
        * travel is exactly 40 - 20 - 2*2 = 16px.
        */}
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-(--renki-shadow-sm) transition-transform duration-150 ${
          checked ? "translate-x-4" : "translate-x-0"
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
  const [connecting, setConnecting] = useState(false);

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
    <div className={`rounded-xl px-4 py-3 ${account.active ? "bg-(--renki-bg-inset)/70 ring-1 ring-(--renki-accent)/30" : "bg-(--renki-bg-inset)/70"}`}>
      <div className="flex items-center gap-2.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${account.active ? "bg-(--renki-success)" : "bg-(--renki-fg-muted)/60"}`} />
        <span className="truncate text-[13px] text-(--renki-fg)">{account.email}</span>
        {account.active && <span className="text-xs font-medium text-(--renki-success)">Active</span>}
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          {!usageConnected && !connecting && (
            <button onClick={() => setConnecting(true)} className="text-[12.5px] text-(--renki-link) hover:underline">
              Connect tracking
            </button>
          )}
          {usageConnected && (
            <button
              onClick={disconnectUsage}
              disabled={busy !== null}
              title="Stop tracking usage for this account"
              className="text-(--renki-fg-muted) hover:text-(--renki-danger) disabled:opacity-40"
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
      {connecting ? (
        <div className="mt-3">
          <UsageConnect
            configured
            defaultOpen
            forEmail={account.email}
            onClose={() => setConnecting(false)}
            onConnected={() => {
              setConnecting(false);
              onChanged();
            }}
          />
        </div>
      ) : account.usage ? (
        <UsageLimits usage={account.usage} className="mt-3 pl-4" />
      ) : (
        <div className="mt-1.5 pl-4 text-xs text-(--renki-fg-muted)">
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
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-(--renki-link) hover:underline">
        <span className="codicon codicon-add text-[12px]" /> Add coding account
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl bg-(--renki-bg-inset)/70 p-3.5 text-xs">
      <p className="text-[12.5px] leading-relaxed text-(--renki-fg-muted)">
        Paste the output of <code className="font-mono text-(--renki-fg)">claude setup-token</code>, or a plain Anthropic Console API
        key. This runs <code className="font-mono text-(--renki-fg)">cswap add-token</code> on the daemon host.
      </p>
      <textarea
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="sk-ant-…"
        spellCheck={false}
        rows={2}
        className="renki-input w-full resize-none border-transparent bg-(--renki-surface) font-mono text-[12px]"
      />
      <div className="flex items-center justify-between">
        <button onClick={() => setOpen(false)} className="text-(--renki-fg-muted) hover:text-(--renki-fg)">
          Cancel
        </button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || token.trim().length === 0}>
          {busy ? "Adding…" : "Add account"}
        </Button>
      </div>
      {msg && <p className={msg.ok ? "text-(--renki-success)" : "text-(--renki-danger)"}>{msg.text}</p>}
    </div>
  );
}
