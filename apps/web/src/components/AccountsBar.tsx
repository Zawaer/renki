import type { Account, AccountsResponse } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";

/**
 * Compact multi-account usage strip. Shows each account's 5h/7d usage and which
 * one is active, and offers a manual switch. Auto-rotation happens on the daemon
 * (this just surfaces it). Renders nothing when no accounts are configured, so
 * the feature is invisible unless cswap is set up.
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
