import type { RtkGainResponse } from "@crc/protocol";
import { formatTokenCount } from "@crc/client-core";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";

const DAY_WINDOW = 7;

/**
 * Compact header-mounted badge for RTK's (rtk-ai/rtk) own token-savings
 * stats — mirrors AccountsBar's shape (icon button -> dropdown, invisible
 * unless the feature is actually in use). Renders nothing when
 * CRC_ENABLE_RTK is off, or when it's on but `rtk` isn't reachable on the
 * daemon host — in that failure case there's a daemon-side log line already
 * (see claude/rtkStats.ts), so this stays silent rather than nagging.
 */
export function RtkGainBadge() {
  const { rest } = useClient();
  const [data, setData] = useState<RtkGainResponse | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    rest.getRtkGain().then(setData).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data || !data.enabled || !data.available || !data.summary) return null;

  const { summary } = data;
  const days = [...data.daily].slice(-DAY_WINDOW).reverse();

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="RTK token savings"
        title="RTK token savings"
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-(--crc-fg-muted) transition-colors hover:bg-(--crc-hover) hover:text-(--crc-fg)"
      >
        <span className="codicon codicon-rocket" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="crc-enter absolute bottom-full left-0 z-50 mb-2 w-72 space-y-2 rounded-xl border border-(--crc-border) bg-(--crc-surface) p-3 text-xs shadow-(--crc-shadow-lg)"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-medium text-(--crc-fg-muted)">RTK savings (daemon host)</div>

            <div className="grid grid-cols-2 gap-2">
              <Tile label="Commands" value={String(summary.totalCommands)} />
              <Tile label="Saved" value={formatTokenCount(summary.totalSavedTokens)} />
              <Tile label="Avg savings" value={`${Math.round(summary.avgSavingsPct)}%`} />
              <Tile label="Exec time" value={formatDuration(summary.totalTimeMs)} />
            </div>

            {days.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] text-(--crc-fg-muted)">Last {DAY_WINDOW} days</div>
                {days.map((d) => (
                  <div key={d.date} className="flex items-center justify-between text-[11px]">
                    <span className="text-(--crc-fg-muted)">{formatDayLabel(d.date)}</span>
                    <span className="text-(--crc-fg)">
                      {d.commands} cmd{d.commands === 1 ? "" : "s"} · {formatTokenCount(d.savedTokens)} saved
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10px] leading-snug text-(--crc-fg-muted)">
              From <code>rtk gain</code> on the daemon host — not computed by CRC.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) px-2 py-1.5">
      <div className="text-[10px] text-(--crc-fg-muted)">{label}</div>
      <div className="text-[13px] font-medium text-(--crc-fg)">{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return "0s";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
