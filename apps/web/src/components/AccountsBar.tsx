import type { Account, AccountsResponse } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { UsageLimits, worstUsagePct } from "./UsageLimits.js";
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
  // The most constraining window, whichever it is — a per-model weekly cap can
  // be the one about to block you while the headline two look healthy.
  const worst = worstUsagePct(active?.usage ?? null);
  const worstPct = worst?.pct ?? null;
  const dotColor =
    worst == null
      ? "bg-(--crc-fg-muted)"
      : worst.severity === "critical"
        ? "bg-(--crc-danger)"
        : worst.severity === "warning"
          ? "bg-(--crc-warning)"
          : "bg-(--crc-success)";

  return (
    <div className="relative">
      {/*
        * Usage headroom is the only number in this corner that changes what you
        * do next — whether to keep going or switch accounts — so it's the thing
        * on show, not an anonymous icon. Falls back to the plain icon until the
        * daemon has usage data (an account with no usage key tracked).
        */}
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Accounts & usage${active ? ` · ${active.email}` : ""}`}
        // The visible "45%" would otherwise become the accessible name.
        aria-label={`Accounts & usage${active ? ` · ${active.email}` : ""}`}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-(--crc-fg-muted) transition-colors hover:bg-(--crc-hover) hover:text-(--crc-fg)"
      >
        {worstPct == null ? (
          <span className="codicon codicon-account" />
        ) : (
          <>
            <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
            <span className="text-xs font-medium tabular-nums">{Math.round(worstPct)}%</span>
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="crc-enter absolute bottom-full left-0 z-50 mb-2 w-80 space-y-3 rounded-xl border border-(--crc-border) bg-(--crc-surface) p-3.5 text-xs shadow-(--crc-shadow-lg)"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold text-(--crc-fg)">Accounts</span>
              <span className="text-[11px] text-(--crc-fg-muted)">
                {switching
                  ? "switching…"
                  : data.rotation.enabled
                    ? `Auto-switch at ${data.rotation.threshold}%`
                    : "Auto-switch off"}
              </span>
            </div>
            <div className="space-y-2.5">
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
        <UsageLimits usage={account.usage} className="mt-2 pl-3" />
      ) : (
        <div className="pl-3 text-[11px] text-(--crc-fg-muted)">
          {account.usageError ?? "Usage not tracked for this account."}
        </div>
      )}
    </div>
  );
}

