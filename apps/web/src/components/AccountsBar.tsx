import type { Account, AccountsResponse, AccountUsageExtra } from "@crc/protocol";
import { formatResetIn, formatUsd } from "@crc/client-core";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useClient } from "../lib/client.js";

/**
 * Compact multi-account usage badge, header-mounted (VS Code-style account
 * icon rather than permanent sidebar real estate). Click to open a dropdown
 * with each account's 5h/7d usage, which one is active, and a manual switch.
 * Auto-rotation happens on the daemon (this just surfaces it). Adding
 * accounts (usage-tracking keys or brand-new coding accounts) lives in
 * Settings — this dropdown is a quick glance + switch, not management.
 * Renders nothing when no accounts are configured, so the feature is
 * invisible unless cswap is set up.
 */
export function AccountsBar() {
  const { rest } = useClient();
  const navigate = useNavigate();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    rest.listAccounts().then(setData).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data || data.accounts.length === 0) return null;

  async function switchTo(account: Account) {
    if (account.active || switching) return;
    if (!confirm(`Switch to ${account.email}?`)) return;
    setSwitching(true);
    try {
      const res = await rest.switchAccount(account.number);
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
              {switching && <span className="text-(--crc-fg-muted)">switching…</span>}
            </div>
            <div className="space-y-2">
              {data.accounts.map((a) => (
                <AccountRow key={a.number} account={a} onSwitch={switchTo} switching={switching} />
              ))}
            </div>
            {data.rotation.enabled && data.rotation.lastHoldReason && (
              <div className="text-[11px] text-(--crc-fg-muted)">holding: {data.rotation.lastHoldReason}</div>
            )}
            <button
              onClick={() => {
                setOpen(false);
                navigate("/settings");
              }}
              className="text-[11px] text-(--crc-link) hover:underline"
            >
              Manage accounts →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AccountRow({
  account,
  onSwitch,
  switching,
}: {
  account: Account;
  onSwitch: (account: Account) => void;
  switching: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${account.active ? "bg-(--crc-success)" : "bg-(--crc-fg-muted)"}`} />
        <button
          onClick={() => onSwitch(account)}
          disabled={account.active || switching}
          title={account.active ? "Active account" : `Switch to ${account.email}`}
          className="truncate text-left text-(--crc-fg) disabled:cursor-default enabled:hover:underline enabled:hover:text-(--crc-link)"
        >
          {account.email}
        </button>
      </div>
      {account.usage ? (
        <div className="mt-1 space-y-1 pl-3">
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

export function Meter({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: string | null }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? "bg-(--crc-danger)" : clamped >= 70 ? "bg-(--crc-warning)" : "bg-(--crc-success)";
  const resetIn = formatResetIn(resetsAt, Date.now());
  return (
    <div className="flex-1">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-(--crc-fg-muted)">{label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--crc-bg-elevated)">
          <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
        </div>
        <span className="w-8 text-right text-[10px] text-(--crc-fg-muted)">{Math.round(clamped)}%</span>
      </div>
      {resetIn && <div className="pl-4 text-[9px] text-(--crc-fg-muted)">resets in {resetIn}</div>}
    </div>
  );
}

export function ExtraUsageMeter({ extra }: { extra: AccountUsageExtra }) {
  const clamped = Math.max(0, Math.min(100, extra.pct));
  const color = clamped >= 90 ? "bg-(--crc-danger)" : clamped >= 70 ? "bg-(--crc-warning)" : "bg-(--crc-success)";
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-(--crc-fg-muted)">extra</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--crc-bg-elevated)">
        <div className={`h-full ${color}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="w-24 text-right text-[10px] text-(--crc-fg-muted)">
        {formatUsd(extra.usedDollars)} / {formatUsd(extra.limitDollars)}
      </span>
    </div>
  );
}
