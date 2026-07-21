import type { Account, AccountsResponse, UsageOrg } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";

/**
 * Compact multi-account usage badge, header-mounted (VS Code-style account
 * icon rather than permanent sidebar real estate). Click to open a dropdown
 * with each account's 5h/7d usage, which one is active, and a manual switch.
 * Auto-rotation happens on the daemon (this just surfaces it). When no
 * claude.ai usage key is connected yet, the dropdown also exposes a "Connect
 * usage %" panel: a guided Mac browser login, or paste a key. Renders nothing
 * when no accounts are configured, so the feature is invisible unless cswap
 * is set up.
 */
export function AccountsBar() {
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    rest.listAccounts().then(setData).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data || data.accounts.length === 0) return null;

  async function switchNow() {
    setSwitching(true);
    try {
      const res = await rest.switchAccount();
      if (!res.ok && res.message) alert(res.message);
    } finally {
      setSwitching(false);
      refresh();
    }
  }

  const active = data.accounts.find((a) => a.active);
  const worstPct = active?.usage ? Math.max(active.usage.fiveHour.pct, active.usage.sevenDay.pct) : null;
  const dotColor = worstPct == null ? "bg-(--crc-fg-muted)" : worstPct >= 90 ? "bg-(--crc-danger)" : worstPct >= 70 ? "bg-(--crc-warning)" : "bg-(--crc-success)";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Accounts & usage"
        className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-(--crc-fg-muted) hover:bg-(--crc-hover) hover:text-(--crc-fg)"
      >
        <span className="codicon codicon-account" />
        {worstPct != null && <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-50 mt-2 w-72 space-y-2 rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) p-3 text-xs shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-(--crc-fg-muted)">
                Accounts {data.rotation.enabled ? `· auto @ ${data.rotation.threshold}%` : "· auto off"}
              </span>
              <button onClick={switchNow} disabled={switching} className="text-(--crc-link) hover:underline disabled:opacity-40">
                {switching ? "…" : "Switch"}
              </button>
            </div>
            <div className="space-y-2">
              {data.accounts.map((a) => (
                <AccountRow key={a.number} account={a} />
              ))}
            </div>
            {data.rotation.lastHoldReason && (
              <div className="text-[11px] text-(--crc-fg-muted)">holding: {data.rotation.lastHoldReason}</div>
            )}
            <UsageConnect configured={data.usageConfigured ?? false} onConnected={refresh} />
          </div>
        </>
      )}
    </div>
  );
}

function AccountRow({ account }: { account: Account }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${account.active ? "bg-(--crc-success)" : "bg-(--crc-fg-muted)"}`} />
        <span className="truncate text-(--crc-fg)">{account.email}</span>
      </div>
      {account.usage ? (
        <div className="mt-1 flex gap-2 pl-3">
          <Meter label="5h" pct={account.usage.fiveHour.pct} />
          <Meter label="7d" pct={account.usage.sevenDay.pct} />
        </div>
      ) : (
        <div className="pl-3 text-[11px] text-(--crc-fg-muted)">usage n/a</div>
      )}
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? "bg-(--crc-danger)" : clamped >= 70 ? "bg-(--crc-warning)" : "bg-(--crc-success)";
  return (
    <div className="flex flex-1 items-center gap-1">
      <span className="text-[10px] text-(--crc-fg-muted)">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--crc-bg-elevated)">
        <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="w-8 text-right text-[10px] text-(--crc-fg-muted)">{Math.round(clamped)}%</span>
    </div>
  );
}

/**
 * "Connect usage %" affordance. Get a session key — guided Mac login (the daemon
 * opens a real browser on its host and reads the cookie after you sign in) or
 * paste one (a browser can't read the httpOnly cookie itself). The daemon then
 * returns the account's orgs; you pick which org's usage to track, and we
 * persist that choice. No auto-selection.
 */
function UsageConnect({ configured, onConnected }: { configured: boolean; onConnected: () => void }) {
  const { rest } = useClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<null | "login" | "paste" | "pick">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [orgs, setOrgs] = useState<UsageOrg[] | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function signInOnMac() {
    setBusy("login");
    setMsg({ ok: true, text: "Opening a browser on the daemon host — sign in there…" });
    try {
      const res = await rest.startUsageLogin();
      if (res.unavailable) {
        setMsg({ ok: false, text: "Guided login needs Playwright on the Mac. Paste a key instead, or install it (see SETUP.md)." });
      } else if (res.orgs.length > 0 && res.sessionKey) {
        setPendingKey(res.sessionKey);
        setOrgs(res.orgs);
        setMsg(null);
      } else {
        setMsg({ ok: false, text: res.message ?? "Login failed." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(null);
    }
  }

  async function resolvePasted() {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy("paste");
    setMsg(null);
    try {
      const res = await rest.connectUsageKey(trimmed);
      if (res.orgs.length > 0) {
        setPendingKey(trimmed);
        setOrgs(res.orgs);
      } else {
        setMsg({ ok: false, text: res.message ?? "That key didn't work." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(null);
    }
  }

  async function pickOrg(orgId: string) {
    if (!pendingKey) return;
    setBusy("pick");
    setMsg(null);
    try {
      const res = await rest.connectUsageKey(pendingKey, orgId);
      if (res.ok) {
        setKey("");
        setOrgs(null);
        setPendingKey(null);
        setOpen(false);
        onConnected();
      } else {
        setMsg({ ok: false, text: res.message ?? "Couldn't connect that org." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 text-[11px] text-(--crc-link) hover:underline"
      >
        {configured ? "+ Add usage account" : "Connect usage %"}
      </button>
    );
  }

  const fmt = (o: UsageOrg) =>
    o.usage ? `5h ${Math.round(o.usage.fiveHour.pct)}% · 7d ${Math.round(o.usage.sevenDay.pct)}%` : "no usage data";

  return (
    <div className="mt-2 space-y-2 rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) p-2.5">
      {orgs ? (
        <>
          <p className="text-[11px] text-(--crc-fg-muted)">Pick which organization's usage to track:</p>
          {orgs.map((o) => (
            <button
              key={o.orgId}
              onClick={() => pickOrg(o.orgId)}
              disabled={busy !== null}
              className="flex w-full items-center justify-between rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) px-2.5 py-1.5 text-left hover:border-(--crc-focus) disabled:opacity-40"
            >
              <span className="truncate text-[12px] text-(--crc-fg)">{o.name}</span>
              <span className="ml-2 shrink-0 text-[10px] text-(--crc-fg-muted)">{fmt(o)}</span>
            </button>
          ))}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setOrgs(null);
                setPendingKey(null);
              }}
              className="text-[11px] text-(--crc-fg-muted) hover:underline"
            >
              Back
            </button>
            {busy === "pick" && <span className="text-[11px] text-(--crc-fg-muted)">Connecting…</span>}
          </div>
        </>
      ) : (
        <>
          <button
            onClick={signInOnMac}
            disabled={busy !== null}
            className="w-full rounded-sm bg-(--crc-accent) py-1.5 text-[12px] font-medium text-(--crc-accent-fg) hover:bg-(--crc-accent-hover) disabled:opacity-40"
          >
            {busy === "login" ? "Waiting for sign-in…" : "Sign in to Claude.ai (on the Mac)"}
          </button>
          <div className="flex items-center gap-2 text-[10px] text-(--crc-fg-muted)">
            <div className="h-px flex-1 bg-(--crc-border)" /> or paste a key <div className="h-px flex-1 bg-(--crc-border)" />
          </div>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-sid…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) px-2 py-1 text-[12px] text-(--crc-fg) outline-none focus:border-(--crc-focus)"
          />
          <div className="flex items-center justify-between">
            <button onClick={() => setOpen(false)} className="text-[11px] text-(--crc-fg-muted) hover:underline">
              Close
            </button>
            <button
              onClick={resolvePasted}
              disabled={busy !== null || key.trim().length === 0}
              className="rounded-sm border border-(--crc-border) px-2.5 py-1 text-[11px] text-(--crc-fg) hover:bg-(--crc-hover) disabled:opacity-40"
            >
              {busy === "paste" ? "Checking…" : "Next"}
            </button>
          </div>
        </>
      )}
      {msg && <div className={`text-[11px] ${msg.ok ? "text-(--crc-success)" : "text-(--crc-danger)"}`}>{msg.text}</div>}
      <p className="text-[10px] leading-snug text-(--crc-fg-muted)">
        Read-only claude.ai session key (same one the Claude Usage app uses). Never touches your coding tokens.
      </p>
    </div>
  );
}
