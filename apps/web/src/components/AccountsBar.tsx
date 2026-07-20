import type { Account, AccountsResponse, UsageOrg } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";

/**
 * Compact multi-account usage strip. Shows each account's 5h/7d usage and which
 * one is active, and offers a manual switch. Auto-rotation happens on the daemon
 * (this just surfaces it). When no claude.ai usage key is connected yet, it also
 * exposes a "Connect usage %" panel: a guided Mac browser login, or paste a key.
 * Renders nothing when no accounts are configured, so the feature is invisible
 * unless cswap is set up.
 */
export function AccountsBar() {
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState(false);

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

  return (
    <div className="border-t border-neutral-800 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-neutral-400">
          Accounts {data.rotation.enabled ? `· auto @ ${data.rotation.threshold}%` : "· auto off"}
        </span>
        <button onClick={switchNow} disabled={switching} className="text-indigo-400 hover:underline disabled:opacity-40">
          {switching ? "…" : "Switch"}
        </button>
      </div>
      <div className="space-y-2">
        {data.accounts.map((a) => (
          <AccountRow key={a.number} account={a} />
        ))}
      </div>
      {data.rotation.lastHoldReason && (
        <div className="mt-2 text-[11px] text-neutral-600">holding: {data.rotation.lastHoldReason}</div>
      )}
      <UsageConnect configured={data.usageConfigured ?? false} onConnected={refresh} />
    </div>
  );
}

function AccountRow({ account }: { account: Account }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${account.active ? "bg-emerald-500" : "bg-neutral-700"}`} />
        <span className="truncate text-neutral-300">{account.email}</span>
      </div>
      {account.usage ? (
        <div className="mt-1 flex gap-2 pl-3">
          <Meter label="5h" pct={account.usage.fiveHour.pct} />
          <Meter label="7d" pct={account.usage.sevenDay.pct} />
        </div>
      ) : (
        <div className="pl-3 text-[11px] text-neutral-600">usage n/a</div>
      )}
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? "bg-red-500" : clamped >= 70 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="flex flex-1 items-center gap-1">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
        <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="w-8 text-right text-[10px] text-neutral-500">{Math.round(clamped)}%</span>
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
        className="mt-2 text-[11px] text-indigo-400 hover:underline"
      >
        {configured ? "+ Add usage account" : "Connect usage %"}
      </button>
    );
  }

  const fmt = (o: UsageOrg) =>
    o.usage ? `5h ${Math.round(o.usage.fiveHour.pct)}% · 7d ${Math.round(o.usage.sevenDay.pct)}%` : "no usage data";

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-neutral-800 bg-neutral-950 p-2.5">
      {orgs ? (
        <>
          <p className="text-[11px] text-neutral-400">Pick which organization's usage to track:</p>
          {orgs.map((o) => (
            <button
              key={o.orgId}
              onClick={() => pickOrg(o.orgId)}
              disabled={busy !== null}
              className="flex w-full items-center justify-between rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-left hover:border-indigo-500 disabled:opacity-40"
            >
              <span className="truncate text-[12px] text-neutral-200">{o.name}</span>
              <span className="ml-2 shrink-0 text-[10px] text-neutral-500">{fmt(o)}</span>
            </button>
          ))}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setOrgs(null);
                setPendingKey(null);
              }}
              className="text-[11px] text-neutral-500 hover:underline"
            >
              Back
            </button>
            {busy === "pick" && <span className="text-[11px] text-neutral-500">Connecting…</span>}
          </div>
        </>
      ) : (
        <>
          <button
            onClick={signInOnMac}
            disabled={busy !== null}
            className="w-full rounded-md bg-indigo-600 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            {busy === "login" ? "Waiting for sign-in…" : "Sign in to Claude.ai (on the Mac)"}
          </button>
          <div className="flex items-center gap-2 text-[10px] text-neutral-600">
            <div className="h-px flex-1 bg-neutral-800" /> or paste a key <div className="h-px flex-1 bg-neutral-800" />
          </div>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-sid…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200 outline-none focus:border-indigo-500"
          />
          <div className="flex items-center justify-between">
            <button onClick={() => setOpen(false)} className="text-[11px] text-neutral-500 hover:underline">
              Close
            </button>
            <button
              onClick={resolvePasted}
              disabled={busy !== null || key.trim().length === 0}
              className="rounded-md border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              {busy === "paste" ? "Checking…" : "Next"}
            </button>
          </div>
        </>
      )}
      {msg && <div className={`text-[11px] ${msg.ok ? "text-emerald-500" : "text-red-400"}`}>{msg.text}</div>}
      <p className="text-[10px] leading-snug text-neutral-600">
        Read-only claude.ai session key (same one the Claude Usage app uses). Never touches your coding tokens.
      </p>
    </div>
  );
}
